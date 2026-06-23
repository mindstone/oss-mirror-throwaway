import { describe, expect, it } from 'vitest';
import type { StreamEvent } from '../types';
import { parseSSEChunk, toStreamEvent, type SSEFrame } from '../sse';

function legacyParseSSEChunk(buffer: string): {
  events: Array<{ event: string; data: string }>;
  remaining: string;
} {
  const normalised = buffer.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const boundary = '\n\n';
  const events: Array<{ event: string; data: string }> = [];
  let rest = normalised;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const idx = rest.indexOf(boundary);
    if (idx === -1) break;
    const block = rest.slice(0, idx);
    rest = rest.slice(idx + boundary.length);

    let eventName = 'message';
    const dataLines: string[] = [];
    for (const line of block.split('\n')) {
      if (line.length === 0) continue;
      if (line.startsWith(':')) continue; // comment / keepalive
      const colonIdx = line.indexOf(':');
      const field = colonIdx === -1 ? line : line.slice(0, colonIdx);
      let value = colonIdx === -1 ? '' : line.slice(colonIdx + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'event') {
        eventName = value;
      } else if (field === 'data') {
        dataLines.push(value);
      }
    }
    if (dataLines.length === 0) {
      continue;
    }
    events.push({ event: eventName, data: dataLines.join('\n') });
  }
  return { events, remaining: rest };
}

function legacyToStreamEvent(event: string, data: string): StreamEvent | null {
  let parsed: unknown;
  try {
    parsed = data.length === 0 ? {} : JSON.parse(data);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const p = parsed as Record<string, unknown>;

  switch (event) {
    case 'connected': {
      if (typeof p.conversationId !== 'string' || typeof p.turnStatus !== 'string') {
        return null;
      }
      return {
        type: 'connected',
        conversationId: p.conversationId,
        turnStatus: p.turnStatus,
      };
    }
    case 'assistant_delta': {
      if (typeof p.turnId !== 'string' || typeof p.text !== 'string') return null;
      return { type: 'assistant_delta', turnId: p.turnId, text: p.text };
    }
    case 'tool_activity': {
      if (
        typeof p.turnId !== 'string' ||
        typeof p.name !== 'string' ||
        typeof p.phase !== 'string'
      ) {
        return null;
      }
      return {
        type: 'tool_activity',
        turnId: p.turnId,
        name: p.name,
        phase: p.phase,
      };
    }
    case 'assistant_done': {
      if (typeof p.turnId !== 'string') return null;
      return { type: 'assistant_done', turnId: p.turnId };
    }
    case 'turn_error': {
      if (typeof p.turnId !== 'string' || typeof p.error !== 'string') return null;
      return { type: 'turn_error', turnId: p.turnId, error: p.error };
    }
    case 'turn_started': {
      if (typeof p.turnId !== 'string') return null;
      return { type: 'turn_started', turnId: p.turnId };
    }
    case 'message_added': {
      const m = p.message as
        | { id?: unknown; role?: unknown; text?: unknown; createdAt?: unknown; turnId?: unknown }
        | undefined;
      if (
        !m ||
        typeof m.id !== 'string' ||
        (m.role !== 'user' && m.role !== 'assistant') ||
        typeof m.text !== 'string' ||
        typeof m.createdAt !== 'number'
      ) {
        return null;
      }
      return {
        type: 'message_added',
        message: {
          id: m.id,
          role: m.role,
          text: m.text,
          createdAt: m.createdAt,
          ...(typeof m.turnId === 'string' ? { turnId: m.turnId } : {}),
        },
      };
    }
    case 'revoked': {
      return { type: 'revoked' };
    }
    default:
      return null;
  }
}

function mapFrames(frames: SSEFrame[]): Array<StreamEvent | null> {
  return frames.map((frame) => toStreamEvent(frame));
}

describe('parseSSEChunk', () => {
  it('drops keepalive comment blocks', () => {
    const parsed = parseSSEChunk(':keepalive\n\n');
    expect(parsed).toEqual({ events: [], remainder: '' });
  });

  it('normalizes CRLF newlines before parsing', () => {
    const parsed = parseSSEChunk(
      'event: connected\r\ndata: {"conversationId":"conv-1","turnStatus":"idle"}\r\n\r\n',
    );
    expect(parsed).toEqual({
      events: [
        {
          event: 'connected',
          data: '{"conversationId":"conv-1","turnStatus":"idle"}',
        },
      ],
      remainder: '',
    });
  });

  it('parses multiple events from one buffer', () => {
    const parsed = parseSSEChunk(
      'event: turn_started\ndata: {"turnId":"turn-1"}\n\n' +
        'event: assistant_done\ndata: {"turnId":"turn-1"}\n\n',
    );
    expect(parsed.events).toHaveLength(2);
    expect(parsed.remainder).toBe('');
    expect(mapFrames(parsed.events)).toEqual([
      { type: 'turn_started', turnId: 'turn-1' },
      { type: 'assistant_done', turnId: 'turn-1' },
    ]);
  });

  it('preserves trailing partial bytes in remainder', () => {
    const parsed = parseSSEChunk(
      'event: turn_started\ndata: {"turnId":"turn-1"}\n\n' +
        'event: assistant_delta\ndata: {"turnId":"turn-1","text":"hel',
    );
    expect(parsed.events).toEqual([
      { event: 'turn_started', data: '{"turnId":"turn-1"}' },
    ]);
    expect(parsed.remainder).toBe(
      'event: assistant_delta\ndata: {"turnId":"turn-1","text":"hel',
    );
  });

  it('handles split SSE frames across two reader chunks (F16)', () => {
    const fullBuffer =
      'event: turn_started\ndata: {"turnId":"turn-2"}\n\n' +
      'event: assistant_done\ndata: {"turnId":"turn-2"}\n\n';

    const firstBoundary = fullBuffer.indexOf('\n\n');
    const splitIndex = Math.max(1, firstBoundary - 2);
    const firstHalf = fullBuffer.slice(0, splitIndex);
    const secondHalf = fullBuffer.slice(splitIndex);

    const firstParsed = parseSSEChunk(firstHalf);
    expect(firstParsed.events).toEqual([]);

    const secondParsed = parseSSEChunk(firstParsed.remainder + secondHalf);
    expect(mapFrames(secondParsed.events)).toEqual([
      { type: 'turn_started', turnId: 'turn-2' },
      { type: 'assistant_done', turnId: 'turn-2' },
    ]);
  });

  it('matches legacy parser output byte-for-byte on a fixture corpus', () => {
    const fixtures = [
      ':ping\n\n',
      'event: connected\ndata: {"conversationId":"conv-2","turnStatus":"running"}\n\n',
      'event: assistant_delta\ndata: {"turnId":"t1","text":"hel"}\n\ndata: {"ignored":true}\n\n',
      'event: turn_error\ndata: {"turnId":"t1","error":"boom"}\n\n',
      'event: message_added\ndata: {"message":{"id":"m1","role":"assistant","text":"hi","createdAt":123,"turnId":"t1"}}\n\n',
      'event: revoked\ndata: {}\n\n',
      'event: connected\r\ndata: {"conversationId":"c","turnStatus":"idle"}\r\n\r\n',
      'event: assistant_delta\ndata: {"turnId":"t2","text":"partial"',
      'event: unknown\ndata: {"foo":"bar"}\n\n',
      'event: connected\ndata: not-json\n\n',
      'event: tool_activity\ndata: {"turnId":"t3","name":"search","phase":"start"}\n\n',
    ];

    for (const fixture of fixtures) {
      const nextParsed = parseSSEChunk(fixture);
      const legacyParsed = legacyParseSSEChunk(fixture);
      expect(nextParsed.events).toEqual(legacyParsed.events);
      expect(nextParsed.remainder).toEqual(legacyParsed.remaining);

      const nextMapped = nextParsed.events.map((frame) => toStreamEvent(frame));
      const legacyMapped = legacyParsed.events.map((frame) =>
        legacyToStreamEvent(frame.event, frame.data),
      );
      expect(nextMapped).toEqual(legacyMapped);
    }
  });
});

describe('toStreamEvent', () => {
  it('drops unknown event names', () => {
    expect(toStreamEvent({ event: 'future_event', data: '{}' })).toBeNull();
  });

  it('drops malformed non-JSON data payloads', () => {
    expect(toStreamEvent({ event: 'connected', data: 'not-json' })).toBeNull();
  });

  it('propagates revoked frames (F16)', () => {
    const parsed = parseSSEChunk('event: revoked\ndata: {"reason":"test"}\n\n');
    expect(parsed.events).toEqual([{ event: 'revoked', data: '{"reason":"test"}' }]);
    expect(toStreamEvent(parsed.events[0]!)).toEqual({ type: 'revoked' });
  });
});
