import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '@shared/types';
import { deriveToolDurations } from '../deriveToolDurations';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const createToolEvent = (
  stage: 'start' | 'end',
  timestamp: number,
  toolName = 'Read',
  overrides: Partial<Extract<AgentEvent, { type: 'tool' }>> = {}
): AgentEvent => ({
  type: 'tool',
  toolName,
  toolUseId: 'tool-1',
  stage,
  detail: stage === 'start' ? '{"path":"/foo.ts"}' : '{"content":"hello"}',
  timestamp,
  ...overrides,
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('deriveToolDurations', () => {
  it('returns empty array for empty events', () => {
    expect(deriveToolDurations([])).toEqual([]);
  });

  it('returns empty array when there are no tool events', () => {
    const events: AgentEvent[] = [
      { type: 'status', message: 'Starting', timestamp: 1000 },
      { type: 'result', text: 'Done', timestamp: 5000 },
    ];
    expect(deriveToolDurations(events)).toEqual([]);
  });

  it('pairs normal tool call start/end events', () => {
    const events: AgentEvent[] = [
      createToolEvent('start', 1000, 'Read', { toolUseId: 'tool-1' }),
      createToolEvent('end', 3500, 'Read', { toolUseId: 'tool-1' }),
    ];

    const result = deriveToolDurations(events);

    expect(result).toHaveLength(1);
    expect(result[0].toolName).toBe('Read');
    expect(result[0].toolUseId).toBe('tool-1');
    expect(result[0].startTimestamp).toBe(1000);
    expect(result[0].endTimestamp).toBe(3500);
    expect(result[0].durationMs).toBe(2500);
    expect(result[0].isError).toBe(false);
    expect(result[0].isCompacted).toBe(false);
    expect(result[0].hasImageContent).toBe(false);
  });

  it('handles orphaned start (no matching end)', () => {
    const events: AgentEvent[] = [
      createToolEvent('start', 1000, 'Edit', { toolUseId: 'orphan-start' }),
    ];

    const result = deriveToolDurations(events);

    expect(result).toHaveLength(1);
    expect(result[0].toolName).toBe('Edit');
    expect(result[0].toolUseId).toBe('orphan-start');
    expect(result[0].startTimestamp).toBe(1000);
    expect(result[0].endTimestamp).toBeNull();
    expect(result[0].durationMs).toBeNull();
    expect(result[0].isError).toBe(false);
    expect(result[0].inputDetail).toBe('{"path":"/foo.ts"}');
    expect(result[0].outputDetail).toBe('');
  });

  it('handles orphaned end (no matching start)', () => {
    const events: AgentEvent[] = [
      createToolEvent('end', 5000, 'Grep', {
        toolUseId: 'orphan-end',
        isError: true,
        detail: '{"error":"not found"}',
      }),
    ];

    const result = deriveToolDurations(events);

    expect(result).toHaveLength(1);
    expect(result[0].toolName).toBe('Grep');
    expect(result[0].toolUseId).toBe('orphan-end');
    expect(result[0].startTimestamp).toBe(5000);
    expect(result[0].endTimestamp).toBe(5000);
    expect(result[0].durationMs).toBeNull();
    expect(result[0].isError).toBe(true);
    expect(result[0].inputDetail).toBe('');
    expect(result[0].outputDetail).toBe('{"error":"not found"}');
  });

  it('handles multiple concurrent tools', () => {
    const events: AgentEvent[] = [
      createToolEvent('start', 1000, 'Read', { toolUseId: 'a' }),
      createToolEvent('start', 1200, 'Grep', { toolUseId: 'b' }),
      createToolEvent('end', 2000, 'Read', { toolUseId: 'a' }),
      createToolEvent('start', 2100, 'Edit', { toolUseId: 'c' }),
      createToolEvent('end', 2500, 'Grep', { toolUseId: 'b' }),
      createToolEvent('end', 4000, 'Edit', { toolUseId: 'c' }),
    ];

    const result = deriveToolDurations(events);

    expect(result).toHaveLength(3);

    // Sorted by startTimestamp
    expect(result[0].toolName).toBe('Read');
    expect(result[0].durationMs).toBe(1000);

    expect(result[1].toolName).toBe('Grep');
    expect(result[1].durationMs).toBe(1300);

    expect(result[2].toolName).toBe('Edit');
    expect(result[2].durationMs).toBe(1900);
  });

  it('detects tool errors from isError flag', () => {
    const events: AgentEvent[] = [
      createToolEvent('start', 1000, 'Edit', { toolUseId: 'err-1' }),
      createToolEvent('end', 2000, 'Edit', {
        toolUseId: 'err-1',
        isError: true,
        detail: '{"error":"permission denied"}',
      }),
    ];

    const result = deriveToolDurations(events);

    expect(result).toHaveLength(1);
    expect(result[0].isError).toBe(true);
  });

  it('detects compacted events (empty detail on end)', () => {
    const events: AgentEvent[] = [
      createToolEvent('start', 1000, 'Read', { toolUseId: 'compact-1', detail: '/path/to/file' }),
      createToolEvent('end', 2000, 'Read', { toolUseId: 'compact-1', detail: '' }),
    ];

    const result = deriveToolDurations(events);

    expect(result).toHaveLength(1);
    expect(result[0].isCompacted).toBe(true);
    expect(result[0].inputDetail).toBe('/path/to/file');
    expect(result[0].outputDetail).toBe('');
  });

  it('handles tool events without toolUseId (synthetic IDs)', () => {
    const events: AgentEvent[] = [
      createToolEvent('start', 1000, 'Read', { toolUseId: undefined }),
      createToolEvent('end', 2000, 'Edit', { toolUseId: undefined }),
    ];

    const result = deriveToolDurations(events);

    // Each gets a unique synthetic ID so they don't pair
    expect(result).toHaveLength(2);
    expect(result[0].durationMs).toBeNull(); // orphaned start
    expect(result[1].durationMs).toBeNull(); // orphaned end
  });

  it('detects image content on end events', () => {
    const events: AgentEvent[] = [
      createToolEvent('start', 1000, 'Screenshot', { toolUseId: 'img-1' }),
      createToolEvent('end', 3000, 'Screenshot', {
        toolUseId: 'img-1',
        imageContent: [{ type: 'image', data: 'base64...', mimeType: 'image/png' }],
      }),
    ];

    const result = deriveToolDurations(events);

    expect(result).toHaveLength(1);
    expect(result[0].hasImageContent).toBe(true);
    expect(result[0].durationMs).toBe(2000);
  });

  it('detects ref-only image events as hasImageContent=true', () => {
    const events: AgentEvent[] = [
      createToolEvent('start', 1000, 'Screenshot', { toolUseId: 'ref-only' }),
      createToolEvent('end', 3000, 'Screenshot', {
        toolUseId: 'ref-only',
        imageRef: [
          { assetId: 'a', mimeType: 'image/png', byteSize: 1024 },
        ],
      }),
    ];

    const result = deriveToolDurations(events);

    expect(result).toHaveLength(1);
    expect(result[0].hasImageContent).toBe(true);
  });

  it('treats events with only null ref slots as no image content', () => {
    const events: AgentEvent[] = [
      createToolEvent('start', 1000, 'Screenshot', { toolUseId: 'null-only' }),
      createToolEvent('end', 3000, 'Screenshot', {
        toolUseId: 'null-only',
        imageContent: undefined,
        imageRef: [null],
      }),
    ];

    const result = deriveToolDurations(events);

    expect(result).toHaveLength(1);
    expect(result[0].hasImageContent).toBe(false);
  });

  it('captures parentToolUseId for sub-agent tool calls', () => {
    const events: AgentEvent[] = [
      createToolEvent('start', 1000, 'Read', {
        toolUseId: 'sub-1',
        parentToolUseId: 'parent-0',
      }),
      createToolEvent('end', 2000, 'Read', {
        toolUseId: 'sub-1',
        parentToolUseId: 'parent-0',
      }),
    ];

    const result = deriveToolDurations(events);

    expect(result).toHaveLength(1);
    expect(result[0].parentToolUseId).toBe('parent-0');
  });

  it('sorts results by startTimestamp', () => {
    const events: AgentEvent[] = [
      createToolEvent('start', 5000, 'Edit', { toolUseId: 'late' }),
      createToolEvent('end', 6000, 'Edit', { toolUseId: 'late' }),
      createToolEvent('start', 1000, 'Read', { toolUseId: 'early' }),
      createToolEvent('end', 2000, 'Read', { toolUseId: 'early' }),
    ];

    const result = deriveToolDurations(events);

    expect(result).toHaveLength(2);
    expect(result[0].toolUseId).toBe('early');
    expect(result[1].toolUseId).toBe('late');
  });

  it('handles zero-duration tool calls', () => {
    const events: AgentEvent[] = [
      createToolEvent('start', 1000, 'Read', { toolUseId: 'zero' }),
      createToolEvent('end', 1000, 'Read', { toolUseId: 'zero' }),
    ];

    const result = deriveToolDurations(events);

    expect(result).toHaveLength(1);
    expect(result[0].durationMs).toBe(0);
  });

  it('ignores non-tool events', () => {
    const events: AgentEvent[] = [
      { type: 'status', message: 'Starting', timestamp: 500 },
      createToolEvent('start', 1000, 'Read', { toolUseId: 'only' }),
      { type: 'assistant', text: 'Thinking...', timestamp: 1200 },
      createToolEvent('end', 2000, 'Read', { toolUseId: 'only' }),
      { type: 'result', text: 'Done', timestamp: 3000 },
    ];

    const result = deriveToolDurations(events);

    expect(result).toHaveLength(1);
    expect(result[0].toolName).toBe('Read');
    expect(result[0].durationMs).toBe(1000);
  });
});
