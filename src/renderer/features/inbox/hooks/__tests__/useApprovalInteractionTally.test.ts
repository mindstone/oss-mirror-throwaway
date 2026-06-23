import { describe, it, expect, beforeEach } from 'vitest';
import {
  recordFirstSeen,
  markExpandedWhy,
  markViewedConversation,
  markPreviewed,
  markUsedRedirect,
  getSecondsSinceFirstSeen,
  consumeAndClear,
  peekRecord,
  _resetForTests,
} from '../useApprovalInteractionTally';

describe('useApprovalInteractionTally', () => {
  beforeEach(() => _resetForTests());

  it('records first-seen exactly once per approvalId', () => {
    expect(recordFirstSeen('tool:abc')).toBe(true);
    expect(recordFirstSeen('tool:abc')).toBe(false);
    expect(recordFirstSeen('tool:abc')).toBe(false);
  });

  it('no-ops when approvalId is empty', () => {
    expect(recordFirstSeen('')).toBe(false);
    expect(peekRecord('')).toBeUndefined();
    expect(getSecondsSinceFirstSeen('')).toBeUndefined();
  });

  it('peekRecord preserves the record; consumeAndClear removes it', () => {
    recordFirstSeen('memory:xyz');
    expect(peekRecord('memory:xyz')).toBeDefined();

    const consumed = consumeAndClear('memory:xyz');
    expect(consumed).toBeDefined();
    expect(peekRecord('memory:xyz')).toBeUndefined();
  });

  it('returns defined flags for subsequent marks', () => {
    recordFirstSeen('tool:xx');

    markExpandedWhy('tool:xx');
    markViewedConversation('tool:xx');
    markPreviewed('tool:xx');
    markUsedRedirect('tool:xx');

    const rec = peekRecord('tool:xx');
    expect(rec).toEqual(
      expect.objectContaining({
        expandedWhy: true,
        viewedConversation: true,
        previewed: true,
        usedRedirect: true,
      }),
    );
  });

  it('markExpandedWhy returns true only on first expansion per approvalId', () => {
    recordFirstSeen('tool:once');

    expect(markExpandedWhy('tool:once')).toBe(true);
    expect(markExpandedWhy('tool:once')).toBe(false);
    expect(markExpandedWhy('tool:once')).toBe(false);
  });

  it('markExpandedWhy returns false for unknown approvalIds without throwing', () => {
    expect(markExpandedWhy('unknown')).toBe(false);
  });

  it('silently ignores marks on unknown approvalIds', () => {
    expect(() => markExpandedWhy('unknown')).not.toThrow();
    expect(() => markViewedConversation('unknown')).not.toThrow();
    expect(peekRecord('unknown')).toBeUndefined();
  });

  it('getSecondsSinceFirstSeen returns a non-negative integer', () => {
    recordFirstSeen('tool:aa');
    const sec = getSecondsSinceFirstSeen('tool:aa');
    expect(sec).toBeDefined();
    expect(sec).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(sec)).toBe(true);
  });

  it('different approvalIds are isolated', () => {
    recordFirstSeen('tool:1');
    recordFirstSeen('tool:2');

    markExpandedWhy('tool:1');
    expect(peekRecord('tool:1')?.expandedWhy).toBe(true);
    expect(peekRecord('tool:2')?.expandedWhy).toBe(false);
  });

  it('consumeAndClear returns undefined for unknown ids without throwing', () => {
    expect(consumeAndClear('nope')).toBeUndefined();
  });
});
