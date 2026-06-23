/**
 * Tests for the streaming tool-input byte cap introduced in Stage 1 of
 * docs/plans/260423_agent_to_tool_file_ref_sentinel.md. Covers the pure
 * helper `recordToolInputDelta` — the stream-loop integration is
 * exercised indirectly via the client integration tests when they run.
 */

import { describe, expect, it } from 'vitest';
import {
  modelSupportsAnthropicCompact,
  recordToolInputDelta,
  resolveStreamCapBytes,
  type ToolInputCapState,
} from '../anthropicClient';

const newState = (): ToolInputCapState => ({
  name: 'Linear__create_attachment',
  id: 'toolu_abc123',
  bytes: 0,
  nearCapFired: false,
});

describe('recordToolInputDelta', () => {
  it('returns continue for small increments well below cap', () => {
    const s = newState();
    const d = recordToolInputDelta(s, 100, 128 * 1024, 0);
    expect(d.action).toBe('continue');
    expect(s.bytes).toBe(100);
  });

  it('mutates state.bytes cumulatively across calls', () => {
    const s = newState();
    recordToolInputDelta(s, 1000, 128 * 1024, 0);
    recordToolInputDelta(s, 2000, 128 * 1024, 0);
    expect(s.bytes).toBe(3000);
  });

  it('fires near_cap exactly once at the 50% threshold', () => {
    const s = newState();
    const cap = 1000;
    // Just under threshold → continue
    const d1 = recordToolInputDelta(s, 499, cap, 0);
    expect(d1.action).toBe('continue');
    // Crossing threshold → near_cap
    const d2 = recordToolInputDelta(s, 2, cap, 0);
    expect(d2.action).toBe('near_cap');
    if (d2.action === 'near_cap') {
      expect(d2.bytesAccumulated).toBe(501);
      expect(d2.toolName).toBe('Linear__create_attachment');
    }
    // Already fired → continue
    const d3 = recordToolInputDelta(s, 100, cap, 0);
    expect(d3.action).toBe('continue');
  });

  it('fires exceeded when total exceeds cap', () => {
    const s = newState();
    const cap = 1000;
    recordToolInputDelta(s, 900, cap, 0); // near_cap
    const d = recordToolInputDelta(s, 200, cap, 0);
    expect(d.action).toBe('exceeded');
    if (d.action === 'exceeded') {
      expect(d.details.toolName).toBe('Linear__create_attachment');
      expect(d.details.toolUseId).toBe('toolu_abc123');
      expect(d.details.bytesAccumulated).toBe(1100);
      expect(d.details.capBytes).toBe(1000);
      expect(d.details.blockIndex).toBe(0);
    }
  });

  it('fires exceeded immediately when a single delta blows past cap', () => {
    const s = newState();
    const cap = 1000;
    const d = recordToolInputDelta(s, 2000, cap, 3);
    expect(d.action).toBe('exceeded');
    if (d.action === 'exceeded') {
      expect(d.details.bytesAccumulated).toBe(2000);
      expect(d.details.blockIndex).toBe(3);
    }
  });

  it('treats exactly-at-cap as not exceeded', () => {
    const s = newState();
    const cap = 1000;
    const d = recordToolInputDelta(s, 1000, cap, 0);
    // Cap is `bytes > cap`, so exactly-at-cap should not exceed
    expect(d.action).not.toBe('exceeded');
  });

  it('disables enforcement when capBytes is 0', () => {
    const s = newState();
    const d = recordToolInputDelta(s, 10_000_000, 0, 0);
    expect(d.action).toBe('continue');
    // With capBytes=0, state should not be mutated either
    expect(s.bytes).toBe(0);
  });

  it('is a no-op for zero-length deltas', () => {
    const s = newState();
    const d = recordToolInputDelta(s, 0, 128 * 1024, 0);
    expect(d.action).toBe('continue');
    expect(s.bytes).toBe(0);
  });

  it('respects custom near-cap fraction', () => {
    const s = newState();
    const cap = 1000;
    // 80% threshold
    const d1 = recordToolInputDelta(s, 700, cap, 0, 0.8);
    expect(d1.action).toBe('continue');
    const d2 = recordToolInputDelta(s, 200, cap, 0, 0.8);
    expect(d2.action).toBe('near_cap');
  });
});

describe('modelSupportsAnthropicCompact', () => {
  it('allows compact_20260112 only for compact-capable Claude models', () => {
    expect(modelSupportsAnthropicCompact('claude-opus-4-7')).toBe(true);
    expect(modelSupportsAnthropicCompact('anthropic/claude-sonnet-4.6')).toBe(true);
    expect(modelSupportsAnthropicCompact('claude-haiku-4-5-20251001')).toBe(false);
    expect(modelSupportsAnthropicCompact('claude-sonnet-4-5')).toBe(false);
  });
});

describe('resolveStreamCapBytes', () => {
  it('returns the 256 KiB default (large tool inputs can legitimately exceed the old 96 KiB cap)', () => {
    const original = process.env.REBEL_STREAM_CAP_BYTES;
    delete process.env.REBEL_STREAM_CAP_BYTES;
    try {
      const cap = resolveStreamCapBytes();
      expect(cap).toBe(256 * 1024);
    } finally {
      if (original !== undefined) process.env.REBEL_STREAM_CAP_BYTES = original;
    }
  });

  it('honours env override when set to a positive integer', () => {
    const original = process.env.REBEL_STREAM_CAP_BYTES;
    process.env.REBEL_STREAM_CAP_BYTES = '65536';
    try {
      expect(resolveStreamCapBytes()).toBe(65536);
    } finally {
      if (original === undefined) delete process.env.REBEL_STREAM_CAP_BYTES;
      else process.env.REBEL_STREAM_CAP_BYTES = original;
    }
  });

  it('honours env override of 0 (disables enforcement)', () => {
    const original = process.env.REBEL_STREAM_CAP_BYTES;
    process.env.REBEL_STREAM_CAP_BYTES = '0';
    try {
      expect(resolveStreamCapBytes()).toBe(0);
    } finally {
      if (original === undefined) delete process.env.REBEL_STREAM_CAP_BYTES;
      else process.env.REBEL_STREAM_CAP_BYTES = original;
    }
  });

  it('falls back to default when env is non-numeric', () => {
    const original = process.env.REBEL_STREAM_CAP_BYTES;
    process.env.REBEL_STREAM_CAP_BYTES = 'not a number';
    try {
      expect(resolveStreamCapBytes()).toBe(256 * 1024);
    } finally {
      if (original === undefined) delete process.env.REBEL_STREAM_CAP_BYTES;
      else process.env.REBEL_STREAM_CAP_BYTES = original;
    }
  });

  it('falls back to default when env is negative', () => {
    const original = process.env.REBEL_STREAM_CAP_BYTES;
    process.env.REBEL_STREAM_CAP_BYTES = '-1';
    try {
      expect(resolveStreamCapBytes()).toBe(256 * 1024);
    } finally {
      if (original === undefined) delete process.env.REBEL_STREAM_CAP_BYTES;
      else process.env.REBEL_STREAM_CAP_BYTES = original;
    }
  });
});

describe('byte-counting contract (Stage 1 hardening)', () => {
  // The stream loop in anthropicClient.ts MUST count UTF-8 bytes via
  // `Buffer.byteLength(partial, 'utf8')`, not `partial.length` (UTF-16
  // code units). For ASCII/base64 the two coincide; for multi-byte UTF-8
  // they don't, and `partial.length` would silently under-count and let
  // an oversized payload slip past the cap. These tests document the
  // contract and would fail-loud if a refactor reintroduced char-counting.

  it('Buffer.byteLength counts multi-byte UTF-8 correctly (sanity)', () => {
    // Each CJK glyph is 3 bytes in UTF-8 but 1 UTF-16 code unit
    expect('日本語'.length).toBe(3);
    expect(Buffer.byteLength('日本語', 'utf8')).toBe(9);
    // Emoji is 4 bytes in UTF-8 (and 2 UTF-16 code units via surrogate pair)
    expect('🚀'.length).toBe(2);
    expect(Buffer.byteLength('🚀', 'utf8')).toBe(4);
  });

  it('passing a UTF-8 byte count exceeds cap that the equivalent char count would not', () => {
    // 30_000 CJK chars = 30_000 UTF-16 units, but 90_000 UTF-8 bytes.
    // A 64 KiB cap should be tripped by the byte count and untouched by
    // the char count — proving why the call site must use byte semantics.
    const cap = 64 * 1024;
    const cjkPayloadChars = 30_000;
    const cjkPayloadBytes = cjkPayloadChars * 3;

    const sChars = newState();
    const dChars = recordToolInputDelta(sChars, cjkPayloadChars, cap, 0);
    expect(dChars.action).not.toBe('exceeded'); // 30_000 < 65_536

    const sBytes = newState();
    const dBytes = recordToolInputDelta(sBytes, cjkPayloadBytes, cap, 0);
    expect(dBytes.action).toBe('exceeded'); // 90_000 > 65_536
  });
});
