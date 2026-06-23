// @vitest-environment happy-dom
/// <reference types="vitest/globals" />

/**
 * Regression tests for the scroll-to-answer effect.
 *
 * Bug: After the user submits an AskUserQuestion answer, the answered card is
 * anchored to the asking turn and can either (A) sit above the viewport after
 * the continuation turn scrolls in, or (B) be unmounted entirely by the
 * virtualizer overscan.
 *
 * See docs-private/investigations/260416_answered_question_card_not_visible.md.
 *
 * Phase 6 iteration 1 review (Gemini 3.1 Pro) identified a timer-cancel race
 * (M1): the continuation turn's `turn_started` event fires ~30-90ms after
 * `user_question_answered`, re-triggering `questionBatches` identity. Naive
 * cleanup would cancel the pending scroll and never reschedule. The tests
 * below pin the expected behaviour.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@renderer/test-utils';
import {
  useScrollToAnswer,
  computeScrollToAnswerIndex,
  type ScrollToIndexFn,
} from '../useScrollToAnswer';
import type { QuestionBatchState } from '../useUserQuestions';

const SESSION_ID = 'session-xyz456';

function makeBatchState(batchId: string, turnId: string, isAnswered: boolean): QuestionBatchState {
  return {
    batch: {
      batchId,
      turnId,
      toolUseId: `tool-${batchId}`,
      questions: [],
      timestamp: 1,
      sessionId: SESSION_ID,
    },
    isAnswered,
    answers: isAnswered ? [] : undefined,
    skipped: false,
    dismissed: false,
  } as unknown as QuestionBatchState;
}

describe('computeScrollToAnswerIndex (pure helper)', () => {
  it('returns -1 when no batch transitioned from unanswered to answered', () => {
    const prev = new Set<string>(['b1']);
    const current = new Set<string>(['b1']);
    const map = new Map<number, QuestionBatchState[]>([
      [3, [makeBatchState('b1', 't1', true)]],
    ]);
    expect(computeScrollToAnswerIndex(prev, current, map)).toBe(-1);
  });

  it('returns -1 when the current answered set is empty', () => {
    expect(
      computeScrollToAnswerIndex(new Set(), new Set(), new Map()),
    ).toBe(-1);
  });

  it('returns the anchored message index when a batch transitions to answered', () => {
    const prev = new Set<string>();
    const current = new Set<string>(['b1']);
    const map = new Map<number, QuestionBatchState[]>([
      [1, [makeBatchState('b1', 't1', true)]],
    ]);
    expect(computeScrollToAnswerIndex(prev, current, map)).toBe(1);
  });

  it('returns -1 when the newly-answered batch has no matching message anchor', () => {
    const prev = new Set<string>();
    const current = new Set<string>(['b1']);
    const map = new Map<number, QuestionBatchState[]>();
    expect(computeScrollToAnswerIndex(prev, current, map)).toBe(-1);
  });

  it('prefers the highest index when multiple batches are newly answered', () => {
    const prev = new Set<string>();
    const current = new Set<string>(['b1', 'b2']);
    const map = new Map<number, QuestionBatchState[]>([
      [2, [makeBatchState('b1', 't1', true)]],
      [7, [makeBatchState('b2', 't2', true)]],
    ]);
    expect(computeScrollToAnswerIndex(prev, current, map)).toBe(7);
  });

  it('ignores already-answered batches and only targets the newly-answered one', () => {
    const prev = new Set<string>(['b-old']);
    const current = new Set<string>(['b-old', 'b-new']);
    const map = new Map<number, QuestionBatchState[]>([
      [2, [makeBatchState('b-old', 't-old', true)]],
      [5, [makeBatchState('b-new', 't-new', true)]],
    ]);
    expect(computeScrollToAnswerIndex(prev, current, map)).toBe(5);
  });
});

describe('useScrollToAnswer effect', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  interface HarnessProps {
    questionBatches: QuestionBatchState[];
    questionCardByMessageIndex: Map<number, QuestionBatchState[]>;
    currentSessionId: string;
  }

  const setup = (initial: HarnessProps) => {
    const scrollToIndex: ScrollToIndexFn = vi.fn();
    const onBegin = vi.fn();
    const onEnd = vi.fn();
    const { rerender, unmount } = renderHook(
      (p: HarnessProps) =>
        useScrollToAnswer({
          questionBatches: p.questionBatches,
          questionCardByMessageIndex: p.questionCardByMessageIndex,
          currentSessionId: p.currentSessionId,
          scrollToIndex,
          onBeginProgrammaticScroll: onBegin,
          onEndProgrammaticScroll: onEnd,
        }),
      { initialProps: initial },
    );
    return { scrollToIndex, onBegin, onEnd, rerender, unmount };
  };

  it('does NOT scroll on first mount even if batches are already answered (session baseline)', () => {
    const answered = makeBatchState('b1', 't1', true);
    const { scrollToIndex } = setup({
      questionBatches: [answered],
      questionCardByMessageIndex: new Map([[2, [answered]]]),
      currentSessionId: 'session-1',
    });

    vi.advanceTimersByTime(500);
    expect(scrollToIndex).not.toHaveBeenCalled();
  });

  it('scrolls to the anchored index when a batch transitions to answered', () => {
    const pending = makeBatchState('b1', 't1', false);
    const { scrollToIndex, onBegin, onEnd, rerender } = setup({
      questionBatches: [pending],
      questionCardByMessageIndex: new Map([[2, [pending]]]),
      currentSessionId: 'session-1',
    });

    const answered = makeBatchState('b1', 't1', true);
    rerender({
      questionBatches: [answered],
      questionCardByMessageIndex: new Map([[2, [answered]]]),
      currentSessionId: 'session-1',
    });

    // Before the settle delay expires: no scroll yet.
    vi.advanceTimersByTime(50);
    expect(scrollToIndex).not.toHaveBeenCalled();

    // After 100ms settle delay: scroll fires once.
    vi.advanceTimersByTime(60);
    expect(scrollToIndex).toHaveBeenCalledTimes(1);
    expect(scrollToIndex).toHaveBeenCalledWith(
      2,
      expect.objectContaining({ align: 'start', behavior: 'smooth' }),
    );
    expect(onBegin).toHaveBeenCalledTimes(1);

    // The end callback fires ~400ms after the scroll to clear the flag.
    expect(onEnd).not.toHaveBeenCalled();
    vi.advanceTimersByTime(500);
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  it('M1 regression: scroll still fires when questionBatches identity changes mid-delay with the same target', () => {
    // Scenario from the Phase 6 review trace:
    // 1. user_question_answered arrives → effect schedules 100ms timer targeting index 2.
    // 2. ~50ms later, continuation turn's `turn_started` event changes eventsByTurn →
    //    questionBatches gets a new identity (same content) → effect re-runs.
    // 3. Previously: cleanup cancelled the pending scroll; re-run saw prev===current
    //    and scheduled no new timer → scroll never fired.
    // Now: prev is committed only inside the timer; re-runs with the same target
    //      reuse the pending timer.
    const pending = makeBatchState('b1', 't1', false);
    const { scrollToIndex, rerender } = setup({
      questionBatches: [pending],
      questionCardByMessageIndex: new Map([[2, [pending]]]),
      currentSessionId: 'session-1',
    });

    const answered = makeBatchState('b1', 't1', true);
    rerender({
      questionBatches: [answered],
      questionCardByMessageIndex: new Map([[2, [answered]]]),
      currentSessionId: 'session-1',
    });

    // Mid-delay: questionBatches identity changes (same content, new reference)
    vi.advanceTimersByTime(50);
    const answeredAgain = makeBatchState('b1', 't1', true);
    rerender({
      questionBatches: [answeredAgain],
      questionCardByMessageIndex: new Map([[2, [answeredAgain]]]),
      currentSessionId: 'session-1',
    });

    // Scroll must still fire exactly once, at the original 100ms mark.
    vi.advanceTimersByTime(60);
    expect(scrollToIndex).toHaveBeenCalledTimes(1);
    expect(scrollToIndex).toHaveBeenCalledWith(
      2,
      expect.objectContaining({ align: 'start', behavior: 'smooth' }),
    );
  });

  it('reschedules to the newer target when a different batch becomes answered mid-delay', () => {
    const b1Pending = makeBatchState('b1', 't1', false);
    const b2Pending = makeBatchState('b2', 't2', false);
    const { scrollToIndex, rerender } = setup({
      questionBatches: [b1Pending, b2Pending],
      questionCardByMessageIndex: new Map([
        [2, [b1Pending]],
        [5, [b2Pending]],
      ]),
      currentSessionId: 'session-1',
    });

    // b1 becomes answered first → schedules scroll to index 2.
    const b1Answered = makeBatchState('b1', 't1', true);
    rerender({
      questionBatches: [b1Answered, b2Pending],
      questionCardByMessageIndex: new Map([
        [2, [b1Answered]],
        [5, [b2Pending]],
      ]),
      currentSessionId: 'session-1',
    });

    // Before first timer fires, b2 also becomes answered → target becomes 5 (higher).
    vi.advanceTimersByTime(40);
    const b2Answered = makeBatchState('b2', 't2', true);
    rerender({
      questionBatches: [b1Answered, b2Answered],
      questionCardByMessageIndex: new Map([
        [2, [b1Answered]],
        [5, [b2Answered]],
      ]),
      currentSessionId: 'session-1',
    });

    vi.advanceTimersByTime(150);
    expect(scrollToIndex).toHaveBeenCalledTimes(1);
    expect(scrollToIndex).toHaveBeenCalledWith(
      5,
      expect.objectContaining({ align: 'start' }),
    );
  });

  it('does not scroll on session switch — establishes a fresh baseline', () => {
    const answered = makeBatchState('b1', 't1', true);
    const { scrollToIndex, rerender } = setup({
      questionBatches: [],
      questionCardByMessageIndex: new Map(),
      currentSessionId: 'session-1',
    });

    // Session switch with pre-existing answered batches: should NOT scroll.
    rerender({
      questionBatches: [answered],
      questionCardByMessageIndex: new Map([[2, [answered]]]),
      currentSessionId: 'session-2',
    });

    vi.advanceTimersByTime(500);
    expect(scrollToIndex).not.toHaveBeenCalled();
  });

  it('cancels any pending scroll when session switches', () => {
    const pending = makeBatchState('b1', 't1', false);
    const { scrollToIndex, rerender } = setup({
      questionBatches: [pending],
      questionCardByMessageIndex: new Map([[2, [pending]]]),
      currentSessionId: 'session-1',
    });

    const answered = makeBatchState('b1', 't1', true);
    rerender({
      questionBatches: [answered],
      questionCardByMessageIndex: new Map([[2, [answered]]]),
      currentSessionId: 'session-1',
    });

    // Before settle delay completes, user switches sessions.
    vi.advanceTimersByTime(50);
    rerender({
      questionBatches: [answered],
      questionCardByMessageIndex: new Map([[2, [answered]]]),
      currentSessionId: 'session-2',
    });

    vi.advanceTimersByTime(500);
    expect(scrollToIndex).not.toHaveBeenCalled();
  });

  it('cancels pending scroll on unmount', () => {
    const pending = makeBatchState('b1', 't1', false);
    const { scrollToIndex, rerender, unmount } = setup({
      questionBatches: [pending],
      questionCardByMessageIndex: new Map([[2, [pending]]]),
      currentSessionId: 'session-1',
    });

    const answered = makeBatchState('b1', 't1', true);
    rerender({
      questionBatches: [answered],
      questionCardByMessageIndex: new Map([[2, [answered]]]),
      currentSessionId: 'session-1',
    });

    vi.advanceTimersByTime(50);
    unmount();
    vi.advanceTimersByTime(500);
    expect(scrollToIndex).not.toHaveBeenCalled();
  });

  it('does not scroll when the newly-answered batch has no anchor (map miss)', () => {
    const pending = makeBatchState('b1', 't1', false);
    const { scrollToIndex, rerender } = setup({
      questionBatches: [pending],
      questionCardByMessageIndex: new Map(),
      currentSessionId: 'session-1',
    });

    const answered = makeBatchState('b1', 't1', true);
    rerender({
      questionBatches: [answered],
      questionCardByMessageIndex: new Map(),
      currentSessionId: 'session-1',
    });

    vi.advanceTimersByTime(500);
    expect(scrollToIndex).not.toHaveBeenCalled();
  });
});
