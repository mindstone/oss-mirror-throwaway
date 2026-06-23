/**
 * Tests for single-use session approvals + execution-expectation tracking
 * (FOX-2771/2601 Stage 2 — post-approval execution guard).
 *
 * The "stored before turn start" boundary is a monotonic store SEQUENCE
 * (`currentApprovalSequence()`), not wall-clock time, so same-millisecond
 * approve-then-turn-start ordering is exact (GPT review F3).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@core/logger', () => ({
  createScopedLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
  }),
}));

import {
  storeSingleUseApproval,
  consumeSingleUseApproval,
  clearSessionSingleUseApprovals,
  listUnconsumedExecutionExpectations,
  hasActionableExecutionExpectations,
  markExecutionExpectationForced,
  markExecutionExpectationSurfaced,
  currentApprovalSequence,
  _testing_resetSingleUseApprovals,
} from '../sessionApprovals';

const SESSION = 'sess-1';

/** Snapshot taken AFTER stores — everything stored so far is "before the turn". */
const seqNow = () => currentApprovalSequence();

beforeEach(() => {
  _testing_resetSingleUseApprovals();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('single-use approvals (existing behavior preserved)', () => {
  it('store then consume returns true exactly once', () => {
    storeSingleUseApproval('tool', SESSION, 'mcp__gmail__send_email');
    expect(consumeSingleUseApproval('tool', SESSION, 'mcp__gmail__send_email')).toBe(true);
    expect(consumeSingleUseApproval('tool', SESSION, 'mcp__gmail__send_email')).toBe(false);
  });

  it('consume without store returns false', () => {
    expect(consumeSingleUseApproval('tool', SESSION, 'anything')).toBe(false);
  });

  it('memory-domain identifiers are case-insensitive (path normalization)', () => {
    storeSingleUseApproval('memory', SESSION, '/Users/Greg/Mindstone/File.md');
    expect(consumeSingleUseApproval('memory', SESSION, '/users/greg/mindstone/file.md')).toBe(true);
  });

  it('tool-domain identifiers remain case-sensitive', () => {
    storeSingleUseApproval('tool', SESSION, 'ToolName');
    expect(consumeSingleUseApproval('tool', SESSION, 'toolname')).toBe(false);
    expect(consumeSingleUseApproval('tool', SESSION, 'ToolName')).toBe(true);
  });

  it('clearSessionSingleUseApprovals removes approvals across domains', () => {
    storeSingleUseApproval('tool', SESSION, 'a');
    storeSingleUseApproval('memory', SESSION, '/b.md');
    clearSessionSingleUseApprovals(SESSION);
    expect(consumeSingleUseApproval('tool', SESSION, 'a')).toBe(false);
    expect(consumeSingleUseApproval('memory', SESSION, '/b.md')).toBe(false);
  });
});

describe('execution-expectation tracking', () => {
  it('only expectExecution approvals are listed', () => {
    storeSingleUseApproval('tool', SESSION, 'expected', { expectExecution: true });
    storeSingleUseApproval('tool', SESSION, 'staged-or-legacy-default');
    const pending = listUnconsumedExecutionExpectations(SESSION, seqNow());
    expect(pending.map((p) => p.identifier)).toEqual(['expected']);
  });

  it('consumed approvals disappear from the unconsumed list', () => {
    storeSingleUseApproval('tool', SESSION, 'op', { expectExecution: true });
    consumeSingleUseApproval('tool', SESSION, 'op');
    expect(listUnconsumedExecutionExpectations(SESSION, seqNow())).toEqual([]);
  });

  it('sequence boundary excludes approvals stored after the turn-start snapshot', () => {
    // Snapshot BEFORE the approval is stored → mid-turn approval, not this turn's job.
    const snapshotBefore = currentApprovalSequence();
    storeSingleUseApproval('tool', SESSION, 'mid-turn', { expectExecution: true });
    expect(listUnconsumedExecutionExpectations(SESSION, snapshotBefore)).toEqual([]);
    // Snapshot AFTER the approval is stored → listed.
    expect(
      listUnconsumedExecutionExpectations(SESSION, seqNow()).map((p) => p.identifier),
    ).toEqual(['mid-turn']);
  });

  it('same-millisecond approve-then-turn-start is NOT misclassified as mid-turn (GPT F3)', () => {
    // Freeze the clock so storedAt and the turn start share the same ms —
    // the sequence boundary must still order them correctly.
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    storeSingleUseApproval('tool', SESSION, 'fast-approve', { expectExecution: true });
    const snapshotAtTurnStart = currentApprovalSequence(); // same ms as the store
    expect(
      listUnconsumedExecutionExpectations(SESSION, snapshotAtTurnStart).map((p) => p.identifier),
    ).toEqual(['fast-approve']);
    // And the inverse in the same frozen ms: store AFTER the snapshot → excluded.
    storeSingleUseApproval('tool', SESSION, 'mid-turn-same-ms', { expectExecution: true });
    expect(
      listUnconsumedExecutionExpectations(SESSION, snapshotAtTurnStart).map((p) => p.identifier),
    ).toEqual(['fast-approve']);
  });

  it('lists across domains with original (un-normalized) identifier', () => {
    storeSingleUseApproval('memory', SESSION, '/Users/Greg/Notes.md', { expectExecution: true });
    const pending = listUnconsumedExecutionExpectations(SESSION, seqNow());
    expect(pending).toHaveLength(1);
    expect(pending[0].domain).toBe('memory');
    expect(pending[0].identifier).toBe('/Users/Greg/Notes.md');
  });

  it('markExecutionExpectationForced is reflected and idempotent', () => {
    storeSingleUseApproval('tool', SESSION, 'op', { expectExecution: true });
    markExecutionExpectationForced('tool', SESSION, 'op');
    const [first] = listUnconsumedExecutionExpectations(SESSION, seqNow());
    expect(first.forcedContinuationAt).toBeTypeOf('number');
    const stamped = first.forcedContinuationAt;
    markExecutionExpectationForced('tool', SESSION, 'op');
    const [second] = listUnconsumedExecutionExpectations(SESSION, seqNow());
    expect(second.forcedContinuationAt).toBe(stamped);
  });

  it('markExecutionExpectationSurfaced is reflected; approval itself remains consumable', () => {
    storeSingleUseApproval('memory', SESSION, '/a.md', { expectExecution: true });
    markExecutionExpectationForced('memory', SESSION, '/a.md');
    markExecutionExpectationSurfaced('memory', SESSION, '/a.md');
    const [item] = listUnconsumedExecutionExpectations(SESSION, seqNow());
    expect(item.surfacedAt).toBeTypeOf('number');
    // The stored approval is NOT removed — a later manual retry still works.
    expect(consumeSingleUseApproval('memory', SESSION, '/a.md')).toBe(true);
  });

  it('marking a missing record is a no-op (consumed in a race)', () => {
    expect(() => markExecutionExpectationForced('tool', SESSION, 'gone')).not.toThrow();
    expect(() => markExecutionExpectationSurfaced('tool', SESSION, 'gone')).not.toThrow();
  });

  it('sessions are isolated', () => {
    storeSingleUseApproval('tool', 'sess-A', 'op', { expectExecution: true });
    expect(listUnconsumedExecutionExpectations('sess-B', seqNow())).toEqual([]);
  });
});

describe('hasActionableExecutionExpectations (task-board surrender predicate)', () => {
  it('true for an unconsumed, unforced expectation stored before the snapshot', () => {
    storeSingleUseApproval('tool', SESSION, 'op', { expectExecution: true });
    expect(hasActionableExecutionExpectations(SESSION, seqNow())).toBe(true);
  });

  it('STAYS true after the forced budget is spent — the guard still needs its surfacing pass (confirm-round F1)', () => {
    storeSingleUseApproval('tool', SESSION, 'op', { expectExecution: true });
    markExecutionExpectationForced('tool', SESSION, 'op');
    expect(hasActionableExecutionExpectations(SESSION, seqNow())).toBe(true);
  });

  it('false once SURFACED (task-board resumes; starvation bounded at two yields per approval)', () => {
    storeSingleUseApproval('tool', SESSION, 'op', { expectExecution: true });
    markExecutionExpectationForced('tool', SESSION, 'op');
    markExecutionExpectationSurfaced('tool', SESSION, 'op');
    expect(hasActionableExecutionExpectations(SESSION, seqNow())).toBe(false);
  });

  it('false when consumed, when stored after the snapshot, and when not expectExecution', () => {
    // consumed
    storeSingleUseApproval('tool', SESSION, 'consumed', { expectExecution: true });
    consumeSingleUseApproval('tool', SESSION, 'consumed');
    expect(hasActionableExecutionExpectations(SESSION, seqNow())).toBe(false);
    // stored after the snapshot
    const snapshot = currentApprovalSequence();
    storeSingleUseApproval('tool', SESSION, 'later', { expectExecution: true });
    expect(hasActionableExecutionExpectations(SESSION, snapshot)).toBe(false);
    // no expectExecution
    clearSessionSingleUseApprovals(SESSION);
    storeSingleUseApproval('tool', SESSION, 'staged');
    expect(hasActionableExecutionExpectations(SESSION, seqNow())).toBe(false);
  });
});

describe('staleness sweep (GPT F4)', () => {
  it('drops surfaced records older than 24h on the next query (record AND approval)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    storeSingleUseApproval('memory', SESSION, '/stale.md', { expectExecution: true });
    markExecutionExpectationForced('memory', SESSION, '/stale.md');
    markExecutionExpectationSurfaced('memory', SESSION, '/stale.md');

    // Within TTL: still listed and still consumable.
    vi.setSystemTime(1_700_000_000_000 + 23 * 60 * 60 * 1000);
    expect(listUnconsumedExecutionExpectations(SESSION, seqNow())).toHaveLength(1);

    // Past TTL: pruned on access — gone from the list AND the approval store.
    vi.setSystemTime(1_700_000_000_000 + 25 * 60 * 60 * 1000);
    expect(listUnconsumedExecutionExpectations(SESSION, seqNow())).toEqual([]);
    expect(consumeSingleUseApproval('memory', SESSION, '/stale.md')).toBe(false);
  });

  it('does NOT drop unsurfaced records regardless of age', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    storeSingleUseApproval('tool', SESSION, 'old-but-unsurfaced', { expectExecution: true });
    vi.setSystemTime(1_700_000_000_000 + 48 * 60 * 60 * 1000);
    expect(
      listUnconsumedExecutionExpectations(SESSION, seqNow()).map((p) => p.identifier),
    ).toEqual(['old-but-unsurfaced']);
  });
});
