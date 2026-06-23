import { describe, expect, it } from 'vitest';
import type { LibrarySearchOutcome } from '../engine';
import { deriveTruncationSignal } from '../useTruncationSignal';

function makeOutcome(overrides: Partial<LibrarySearchOutcome> = {}): LibrarySearchOutcome {
  return {
    results: [],
    truncated: false,
    truncationReason: null,
    entriesTotal: 0,
    entriesIndexed: 0,
    ...overrides,
  };
}

describe('deriveTruncationSignal', () => {
  it('returns both when engine cap and tree truncation are both true', () => {
    const signal = deriveTruncationSignal(
      makeOutcome({ truncated: true, entriesTotal: 120_000, entriesIndexed: 100_000 }),
      true,
    );

    expect(signal).toEqual({
      kind: 'both',
      entriesTotal: 120_000,
      entriesIndexed: 100_000,
    });
  });

  it('returns engine-cap when only engine truncation is true', () => {
    const signal = deriveTruncationSignal(
      makeOutcome({ truncated: true, entriesTotal: 100_001, entriesIndexed: 100_000 }),
      false,
    );

    expect(signal).toEqual({
      kind: 'engine-cap',
      entriesTotal: 100_001,
      entriesIndexed: 100_000,
    });
  });

  it('returns tree when the tree is partial (even with no engine cap)', () => {
    const signal = deriveTruncationSignal(makeOutcome({ truncated: false }), true);
    expect(signal).toEqual({ kind: 'tree' });
  });

  // Regression guard for the Stage-3 re-point: the tree signal must come from the
  // buildFileTree completeness metadata, NOT from the separate stats walk. A
  // complete-stats but partial-tree state must still fire the tree notice.
  it('fires the tree signal from tree completeness independently of search outcome', () => {
    const signal = deriveTruncationSignal(makeOutcome({ truncated: false }), true);
    expect(signal.kind).toBe('tree');
  });

  it('returns none when both sources are non-truncated', () => {
    const signal = deriveTruncationSignal(makeOutcome({ truncated: false }), false);
    expect(signal).toEqual({ kind: 'none' });
  });

  it('returns unknown while tree completeness is unknown and engine cap is not hit', () => {
    const signal = deriveTruncationSignal(makeOutcome({ truncated: false }), 'unknown');
    expect(signal).toEqual({ kind: 'unknown' });
  });

  it('returns engine-cap when tree completeness is unknown and engine cap is hit', () => {
    const signal = deriveTruncationSignal(
      makeOutcome({ truncated: true, entriesTotal: 150_000, entriesIndexed: 100_000 }),
      'unknown',
    );

    expect(signal).toEqual({
      kind: 'engine-cap',
      entriesTotal: 150_000,
      entriesIndexed: 100_000,
    });
  });

  it('treats malformed truncated=undefined as no engine cap', () => {
    const signal = deriveTruncationSignal(
      makeOutcome({ truncated: undefined as unknown as boolean }),
      false,
    );

    expect(signal).toEqual({ kind: 'none' });
  });

  // Stage 8 — cloud-degraded variant.
  it('returns cloud-degraded when a reconnecting space is in scope', () => {
    const signal = deriveTruncationSignal(makeOutcome({ truncated: false }), false, 1);
    expect(signal).toEqual({ kind: 'cloud-degraded', reconnectingSpaceCount: 1 });
  });

  it('cloud-degraded takes priority over engine-cap and tree signals', () => {
    const signal = deriveTruncationSignal(
      makeOutcome({ truncated: true, entriesTotal: 120_000, entriesIndexed: 100_000 }),
      true,
      2,
    );
    expect(signal).toEqual({ kind: 'cloud-degraded', reconnectingSpaceCount: 2 });
  });

  it('is inert (no cloud-degraded) when reconnectingSpaceCount is 0 / omitted', () => {
    expect(deriveTruncationSignal(makeOutcome({ truncated: false }), false, 0).kind).toBe('none');
    expect(deriveTruncationSignal(makeOutcome({ truncated: false }), false).kind).toBe('none');
  });
});
