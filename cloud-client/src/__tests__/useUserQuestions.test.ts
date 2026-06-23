/**
 * Stage 4 smoke tests for the lifted, platform-agnostic `useUserQuestions` hook.
 *
 * The desktop hook's full behavior is covered by
 * src/renderer/features/agent-session/hooks/__tests__/useUserQuestions.test.ts,
 * which exercises the wrapper (and therefore this hook) end-to-end.
 *
 * These tests cover the new platform-agnostic paths that the desktop wrapper
 * doesn't hit directly:
 *  - `submitAnswer` injection (no `window.agentApi` dependency)
 *  - `startContinuationTurn` injection (replaces desktop's fallback dance)
 *  - `PersistenceAdapter` injection (AsyncStorage-shape, not localStorage)
 *  - Tracking callbacks dispatched for shown/answered/skipped/dismissed
 *
 * See docs/plans/260420_user_question_cross_surface_resilience.md Stage 4.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import React from 'react';
import type {
  AgentEvent,
  UserQuestion,
  UserQuestionAnswer,
} from '@shared/types';
import {
  useUserQuestions,
  type UserQuestionSubmitRequest,
  type UserQuestionSubmitResponse,
  type UseUserQuestionsOptions,
} from '../hooks/useUserQuestions';
import type { PersistenceAdapter } from '../persistence';

function makeQuestion(id: string): UserQuestion {
  return {
    id,
    question: `Question ${id}`,
    header: `Header ${id}`,
    options: [
      { id: `${id}-opt1`, label: 'A', description: '' },
      { id: `${id}-opt2`, label: 'B', description: '' },
    ],
    multiSelect: false,
  };
}

function makeApprovalClarificationQuestion(id: string): UserQuestion {
  return {
    ...makeQuestion(id),
    purpose: 'approval_clarification',
  };
}

function makeChatApprovalQuestion(id: string): UserQuestion {
  return {
    id,
    question: 'Send this Slack DM to Jane?',
    header: 'Approve',
    context: 'Recipient resolved as Jane Smith. Message: “doing a test”.',
    options: [
      { id: `${id}-opt1`, label: 'Send', description: 'Send exactly: “doing a test”' },
      {
        id: `${id}-opt2`,
        label: 'Edit',
        description: 'Change the message before sending',
        requiresInput: true,
        inputPlaceholder: 'Type the revised Slack DM here',
      },
      { id: `${id}-opt3`, label: 'Cancel', description: 'Do not send anything' },
    ],
    multiSelect: false,
  };
}

function makeEvent(overrides: {
  type: 'user_question' | 'user_question_answered';
  batchId: string;
  toolUseId?: string;
  questions?: UserQuestion[];
  answers?: UserQuestionAnswer[];
  skipped?: boolean;
  sessionId?: string;
  timestamp?: number;
}): AgentEvent {
  const timestamp = overrides.timestamp ?? Date.now();
  if (overrides.type === 'user_question') {
    return {
      type: 'user_question',
      batchId: overrides.batchId,
      toolUseId: overrides.toolUseId ?? 'tu-1',
      questions: overrides.questions ?? [makeQuestion('q1')],
      ...(overrides.sessionId !== undefined ? { sessionId: overrides.sessionId } : {}),
      timestamp,
    } as AgentEvent;
  }
  return {
    type: 'user_question_answered',
    batchId: overrides.batchId,
    answers: overrides.answers ?? [],
    skipped: overrides.skipped,
    ...(overrides.sessionId !== undefined ? { sessionId: overrides.sessionId } : {}),
    timestamp,
  } as AgentEvent;
}

function makeAdapter(): PersistenceAdapter & {
  _store: Map<string, string>;
} {
  const store = new Map<string, string>();
  return {
    _store: store,
    getItem: async (key) => store.get(key) ?? null,
    setItem: async (key, value) => {
      store.set(key, value);
    },
    removeItem: async (key) => {
      store.delete(key);
    },
  };
}

function makeOptions(
  overrides: Partial<UseUserQuestionsOptions> = {},
): UseUserQuestionsOptions & {
  _submitAnswer: ReturnType<typeof vi.fn>;
  _startContinuationTurn: ReturnType<typeof vi.fn>;
} {
  const submitAnswer = vi.fn<
    (req: UserQuestionSubmitRequest) => Promise<UserQuestionSubmitResponse>
  >().mockResolvedValue({ success: true });
  const startContinuationTurn = vi.fn<
    (sessionId: string, message: string, attachments?: import('@shared/types').AnyAttachmentPayload[]) => Promise<void>
  >().mockResolvedValue(undefined);
  return {
    submitAnswer,
    startContinuationTurn,
    ...overrides,
    _submitAnswer: submitAnswer,
    _startContinuationTurn: startContinuationTurn,
  };
}

const SESSION_ID = 'session-cc';
const TURN_ID = 'turn-cc';

describe('cloud-client useUserQuestions (platform-agnostic)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('calls the injected submitAnswer instead of window.agentApi', async () => {
    const options = makeOptions();
    const batch = makeEvent({ type: 'user_question', batchId: 'b-1' });
    const events = { [TURN_ID]: [batch] };

    const { result } = renderHook(() =>
      useUserQuestions(SESSION_ID, events, options),
    );

    await act(async () => {
      await result.current.submitAnswers('b-1', [
        { questionId: 'q1', selectedOptionIds: ['q1-opt1'] },
      ]);
    });

    expect(options._submitAnswer).toHaveBeenCalledTimes(1);
    const request = options._submitAnswer.mock.calls[0]![0];
    expect(request.batchId).toBe('b-1');
    expect(request.sessionId).toBe(SESSION_ID);
  });

  it('invokes startContinuationTurn with the returned continuationMessage', async () => {
    const options = makeOptions({
      submitAnswer: vi.fn<
        (req: UserQuestionSubmitRequest) => Promise<UserQuestionSubmitResponse>
      >().mockResolvedValue({
        success: true,
        continuationMessage: 'cm-hello',
      }),
    });
    const batch = makeEvent({ type: 'user_question', batchId: 'b-1' });
    const events = { [TURN_ID]: [batch] };

    const { result } = renderHook(() =>
      useUserQuestions(SESSION_ID, events, options),
    );

    await act(async () => {
      await result.current.submitAnswers('b-1', [
        { questionId: 'q1', selectedOptionIds: ['q1-opt1'] },
      ]);
    });

    expect(options._startContinuationTurn).toHaveBeenCalledWith(
      SESSION_ID,
      'cm-hello',
      undefined,
      undefined,
    );
  });

  it('forwards continuation attachments alongside the continuation message', async () => {
    const options = makeOptions({
      submitAnswer: vi.fn<
        (req: UserQuestionSubmitRequest) => Promise<UserQuestionSubmitResponse>
      >().mockResolvedValue({
        success: true,
        continuationMessage: 'cm-with-attachment',
      }),
    });
    const batch = makeEvent({ type: 'user_question', batchId: 'b-1' });
    const events = { [TURN_ID]: [batch] };
    const attachment = {
      id: 'att-1',
      name: 'brief.pdf',
      type: 'binary' as const,
      mimeType: 'application/pdf',
      sizeBytes: 1234,
      originalPath: '/tmp/brief.pdf',
    };

    const { result } = renderHook(() =>
      useUserQuestions(SESSION_ID, events, options),
    );

    await act(async () => {
      await result.current.submitAnswers(
        'b-1',
        [
          {
            questionId: 'q1',
            selectedOptionIds: [],
            attachments: [{ id: 'att-1', name: 'brief.pdf', type: 'binary', mimeType: 'application/pdf' }],
          },
        ],
        [attachment],
      );
    });

    expect(options._startContinuationTurn).toHaveBeenCalledWith(
      SESSION_ID,
      'cm-with-attachment',
      [attachment],
      undefined,
    );
  });

  it('surfaces a friendly error when startContinuationTurn rejects', async () => {
    const options = makeOptions({
      submitAnswer: vi.fn<
        (req: UserQuestionSubmitRequest) => Promise<UserQuestionSubmitResponse>
      >().mockResolvedValue({
        success: true,
        continuationMessage: 'cm-x',
      }),
      startContinuationTurn: vi.fn<
        (sessionId: string, message: string, attachments?: import('@shared/types').AnyAttachmentPayload[]) => Promise<void>
      >().mockRejectedValue(new Error('network down')),
    });
    const batch = makeEvent({ type: 'user_question', batchId: 'b-1' });
    const events = { [TURN_ID]: [batch] };

    const { result } = renderHook(() =>
      useUserQuestions(SESSION_ID, events, options),
    );

    await act(async () => {
      await result.current.submitAnswers('b-1', [
        { questionId: 'q1', selectedOptionIds: ['q1-opt1'] },
      ]);
    });

    expect(result.current.submissionError).toMatch(/network down/);
  });

  it('persists dismissed batch IDs via the injected PersistenceAdapter', async () => {
    const adapter = makeAdapter();
    const options = makeOptions({ persistence: adapter });
    const batch = makeEvent({ type: 'user_question', batchId: 'b-1' });
    const events = { [TURN_ID]: [batch] };

    const { result } = renderHook(() =>
      useUserQuestions(SESSION_ID, events, options),
    );

    act(() => {
      result.current.dismissBatch('b-1');
    });

    await waitFor(() => {
      const stored = adapter._store.get(`dismissed-questions:${SESSION_ID}`);
      expect(stored).toBeTruthy();
      expect(JSON.parse(stored!)).toEqual(['b-1']);
    });
  });

  it('restores dismissed batch IDs on mount from the PersistenceAdapter', async () => {
    const adapter = makeAdapter();
    adapter._store.set(
      `dismissed-questions:${SESSION_ID}`,
      JSON.stringify(['b-1']),
    );
    const options = makeOptions({ persistence: adapter });
    const batch = makeEvent({ type: 'user_question', batchId: 'b-1' });
    const events = { [TURN_ID]: [batch] };

    const { result } = renderHook(() =>
      useUserQuestions(SESSION_ID, events, options),
    );

    await waitFor(() => {
      expect(result.current.dismissedBatchIds.has('b-1')).toBe(true);
    });
  });

  it('fires tracking callbacks for shown and answered', async () => {
    const onShown = vi.fn();
    const onAnswered = vi.fn();
    const options = makeOptions({
      tracking: { onShown, onAnswered },
    });
    const batch = makeEvent({ type: 'user_question', batchId: 'b-1' });
    const events = { [TURN_ID]: [batch] };

    const { result } = renderHook(() =>
      useUserQuestions(SESSION_ID, events, options),
    );

    await waitFor(() => {
      // Stage 2 of docs/plans/260518_reduce_approval_clarification_branch_scope.md
      // added an optional `purpose` argument; for generic batches it is
      // undefined.
      expect(onShown).toHaveBeenCalledWith('b-1', 1, SESSION_ID, undefined);
    });

    await act(async () => {
      await result.current.submitAnswers('b-1', [
        { questionId: 'q1', selectedOptionIds: ['q1-opt1'] },
      ]);
    });

    expect(onAnswered).toHaveBeenCalledWith('b-1', 1, SESSION_ID, undefined);
  });

  it('exposes skipBatch that submits skipped: true', async () => {
    const options = makeOptions();
    const batch = makeEvent({ type: 'user_question', batchId: 'b-1' });
    const events = { [TURN_ID]: [batch] };

    const { result } = renderHook(() =>
      useUserQuestions(SESSION_ID, events, options),
    );

    const skipBatch = result.current.skipBatch;
    if (!skipBatch) {
      throw new Error('Expected skipBatch to be available');
    }

    await act(async () => {
      await skipBatch('b-1');
    });

    expect(options._submitAnswer).toHaveBeenCalledTimes(1);
    const request = options._submitAnswer.mock.calls[0]![0];
    expect(request.skipped).toBe(true);
    expect(request.answers).toEqual([]);
  });

  // Closes the test gap identified in the multi-model review (Finding C):
  // the original cloud-client suite only verified _submitAnswer was called,
  // never that the card flipped to "answered" afterwards. That gap let the
  // mobile "card stays pending forever" regression slip past review.
  // See docs/plans/260420_user_question_cross_surface_resilience.md Stage 6.
  it('flips questionBatches[0].isAnswered to true after a successful single-batch submit', async () => {
    const options = makeOptions({
      submitAnswer: vi.fn<
        (req: UserQuestionSubmitRequest) => Promise<UserQuestionSubmitResponse>
      >().mockResolvedValue({
        success: true,
        continuationMessage: 'ok',
      }),
    });
    const batch = makeEvent({ type: 'user_question', batchId: 'b-single' });
    const events = { [TURN_ID]: [batch] };

    const { result } = renderHook(() =>
      useUserQuestions(SESSION_ID, events, options),
    );

    // Before submission: pending.
    expect(result.current.questionBatches[0]?.isAnswered).toBe(false);

    await act(async () => {
      await result.current.submitAnswers('b-single', [
        { questionId: 'q1', selectedOptionIds: ['q1-opt1'] },
      ]);
    });

    // After successful submission: answered, even though no authoritative
    // `user_question_answered` agent event ever arrived through the cloud
    // event pipeline (CloudEventBroadcaster excludes the `agent:event`
    // channel; mobile never receives it). Optimistic localAnswers fills in.
    await waitFor(() => {
      const state = result.current.questionBatches[0];
      expect(state?.isAnswered).toBe(true);
      expect(state?.answers).toEqual([
        { questionId: 'q1', selectedOptionIds: ['q1-opt1'] },
      ]);
    });
  });

  it('flips isAnswered to true with skipped: true after a successful skipBatch', async () => {
    const options = makeOptions({
      submitAnswer: vi.fn<
        (req: UserQuestionSubmitRequest) => Promise<UserQuestionSubmitResponse>
      >().mockResolvedValue({
        success: true,
        continuationMessage: 'skip-ack',
      }),
    });
    const batch = makeEvent({ type: 'user_question', batchId: 'b-skip' });
    const events = { [TURN_ID]: [batch] };

    const { result } = renderHook(() =>
      useUserQuestions(SESSION_ID, events, options),
    );

    const skipBatch = result.current.skipBatch;
    if (!skipBatch) {
      throw new Error('Expected skipBatch to be available');
    }

    await act(async () => {
      await skipBatch('b-skip');
    });

    await waitFor(() => {
      const state = result.current.questionBatches[0];
      expect(state?.isAnswered).toBe(true);
      expect(state?.skipped).toBe(true);
    });
  });

  it('does NOT optimistically mark as answered when the server returns success: false', async () => {
    const options = makeOptions({
      submitAnswer: vi.fn<
        (req: UserQuestionSubmitRequest) => Promise<UserQuestionSubmitResponse>
      >().mockResolvedValue({
        success: false,
        error: 'Invalid batch',
      }),
    });
    const batch = makeEvent({ type: 'user_question', batchId: 'b-fail' });
    const events = { [TURN_ID]: [batch] };

    const { result } = renderHook(() =>
      useUserQuestions(SESSION_ID, events, options),
    );

    await act(async () => {
      await result.current.submitAnswers('b-fail', [
        { questionId: 'q1', selectedOptionIds: ['q1-opt1'] },
      ]);
    });

    await waitFor(() => {
      expect(result.current.submissionError).toBe('Invalid batch');
    });
    // Card must stay pending — success:false means the server rejected it.
    expect(result.current.questionBatches[0]?.isAnswered).toBe(false);
  });

  // Ensure React is referenced so the bundler keeps the import in the test file.
  it('React import sanity check', () => {
    expect(React.version).toBeTruthy();
  });
});

// ── Stage 2: approval-context purpose ─────────────────────────────────────
// See docs/plans/260518_reduce_approval_clarification_branch_scope.md.
describe('useUserQuestions — approval_clarification purpose', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('preserves questions[].purpose=approval_clarification on the question batch state', () => {
    const options = makeOptions();
    const batch = makeEvent({
      type: 'user_question',
      batchId: 'b-ac',
      questions: [makeApprovalClarificationQuestion('q1')],
    });
    const events = { [TURN_ID]: [batch] };

    const { result } = renderHook(() =>
      useUserQuestions(SESSION_ID, events, options),
    );

    const state = result.current.questionBatches[0];
    expect(state?.batch.questions[0]?.purpose).toBe('approval_clarification');
    expect(state?.isApprovalClarification).toBe(true);
  });

  it('drops approval-like question events so approvals do not render in the footer', () => {
    const options = makeOptions();
    const batch = makeEvent({
      type: 'user_question',
      batchId: 'b-chat-approval',
      questions: [makeChatApprovalQuestion('q-approval')],
    });
    const events = { [TURN_ID]: [batch] };

    const { result } = renderHook(() =>
      useUserQuestions(SESSION_ID, events, options),
    );

    expect(result.current.questionBatches).toEqual([]);
  });

  it('drops mixed question batches when any question is approval-like', () => {
    const options = makeOptions();
    const batch = makeEvent({
      type: 'user_question',
      batchId: 'b-mixed-chat-approval',
      questions: [
        makeQuestion('q-generic'),
        makeChatApprovalQuestion('q-approval'),
      ],
    });
    const events = { [TURN_ID]: [batch] };

    const { result } = renderHook(() =>
      useUserQuestions(SESSION_ID, events, options),
    );

    expect(result.current.questionBatches).toEqual([]);
  });

  it('does not bundle mixed generic and approval-clarification siblings in queuedBatches', async () => {
    const options = makeOptions();
    const genericBatch = makeEvent({
      type: 'user_question',
      batchId: 'b-generic',
      questions: [makeQuestion('q-generic')],
      sessionId: SESSION_ID,
      timestamp: 1,
    });
    const approvalBatch = makeEvent({
      type: 'user_question',
      batchId: 'b-approval',
      questions: [makeApprovalClarificationQuestion('q-approval')],
      sessionId: SESSION_ID,
      timestamp: 2,
    });
    const events = { [TURN_ID]: [genericBatch, approvalBatch] };

    const { result } = renderHook(() =>
      useUserQuestions(SESSION_ID, events, options),
    );

    await act(async () => {
      await result.current.submitAnswers('b-generic', [
        { questionId: 'q-generic', selectedOptionIds: ['q-generic-opt1'] },
      ]);
    });

    expect(options._submitAnswer).toHaveBeenCalledTimes(1);
    const genericRequest = options._submitAnswer.mock.calls[0]![0];
    expect(genericRequest.batchId).toBe('b-generic');
    expect(genericRequest.queuedBatches).toBeUndefined();
    expect(genericRequest.questions[0]?.purpose).toBeUndefined();

    await act(async () => {
      await result.current.submitAnswers('b-approval', [
        { questionId: 'q-approval', selectedOptionIds: ['q-approval-opt1'] },
      ]);
    });

    expect(options._submitAnswer).toHaveBeenCalledTimes(2);
    const approvalRequest = options._submitAnswer.mock.calls[1]![0];
    expect(approvalRequest.batchId).toBe('b-approval');
    expect(approvalRequest.queuedBatches).toBeUndefined();
    expect(approvalRequest.questions[0]?.purpose).toBe('approval_clarification');
  });

  it('continues batching same-purpose approval-clarification siblings', async () => {
    const options = makeOptions();
    const firstBatch = makeEvent({
      type: 'user_question',
      batchId: 'b-approval-1',
      questions: [makeApprovalClarificationQuestion('q-approval-1')],
      sessionId: SESSION_ID,
      timestamp: 1,
    });
    const secondBatch = makeEvent({
      type: 'user_question',
      batchId: 'b-approval-2',
      questions: [makeApprovalClarificationQuestion('q-approval-2')],
      sessionId: SESSION_ID,
      timestamp: 2,
    });
    const events = { [TURN_ID]: [firstBatch, secondBatch] };

    const { result } = renderHook(() =>
      useUserQuestions(SESSION_ID, events, options),
    );

    await act(async () => {
      await result.current.submitAnswers('b-approval-1', [
        { questionId: 'q-approval-1', selectedOptionIds: ['q-approval-1-opt1'] },
      ]);
    });

    expect(options._submitAnswer).not.toHaveBeenCalled();

    await act(async () => {
      await result.current.submitAnswers('b-approval-2', [
        { questionId: 'q-approval-2', selectedOptionIds: ['q-approval-2-opt1'] },
      ]);
    });

    expect(options._submitAnswer).toHaveBeenCalledTimes(1);
    const request = options._submitAnswer.mock.calls[0]![0];
    expect(request.batchId).toBe('b-approval-1');
    expect(request.answers).toEqual([
      { questionId: 'q-approval-1', selectedOptionIds: ['q-approval-1-opt1'] },
    ]);
    expect(request.questions[0]?.purpose).toBe('approval_clarification');
    expect(request.queuedBatches).toEqual([
      {
        batchId: 'b-approval-1',
        answers: [
          { questionId: 'q-approval-1', selectedOptionIds: ['q-approval-1-opt1'] },
        ],
        questions: [makeApprovalClarificationQuestion('q-approval-1')],
      },
      {
        batchId: 'b-approval-2',
        answers: [
          { questionId: 'q-approval-2', selectedOptionIds: ['q-approval-2-opt1'] },
        ],
        questions: [makeApprovalClarificationQuestion('q-approval-2')],
      },
    ]);
  });

  it('shown tracking carries purpose=approval_clarification when set', async () => {
    const onShown = vi.fn();
    const options = makeOptions({
      tracking: { onShown },
    });
    const batch = makeEvent({
      type: 'user_question',
      batchId: 'b-ac',
      questions: [makeApprovalClarificationQuestion('q1')],
    });
    const events = { [TURN_ID]: [batch] };

    renderHook(() => useUserQuestions(SESSION_ID, events, options));

    await waitFor(() => {
      expect(onShown).toHaveBeenCalledWith(
        'b-ac',
        1,
        SESSION_ID,
        'approval_clarification',
      );
    });
  });

});

// ── Stage 7: cross-session rehydration merge helper ───────────────────────
import { mergeUserQuestionEvents } from '../hooks/useUserQuestions';

describe('mergeUserQuestionEvents', () => {
  it('returns the live map unchanged when no persisted events are provided', () => {
    const live = {
      'turn-1': [makeEvent({ type: 'user_question', batchId: 'b-1' })],
    };
    expect(mergeUserQuestionEvents(live, undefined)).toBe(live);
    expect(mergeUserQuestionEvents(live, {})).toBe(live);
  });

  it('seeds persisted events into an empty live map (rehydration after force-quit)', () => {
    const persisted = {
      'turn-1': [
        makeEvent({ type: 'user_question', batchId: 'b-1' }),
        makeEvent({
          type: 'user_question_answered',
          batchId: 'b-1',
          answers: [{ questionId: 'q1', selectedOptionIds: ['q1-opt1'] }],
        }),
      ],
    };
    const merged = mergeUserQuestionEvents({}, persisted);
    expect(merged['turn-1']).toHaveLength(2);
    expect(merged['turn-1']?.[0]).toMatchObject({ type: 'user_question', batchId: 'b-1' });
    expect(merged['turn-1']?.[1]).toMatchObject({
      type: 'user_question_answered',
      batchId: 'b-1',
    });
  });

  it('prefers live events over persisted when they share (turnId, type, batchId)', () => {
    // Live event has a newer answered state (user just submitted again);
    // persisted reflects an older snapshot. Live must win.
    const live = {
      'turn-1': [
        makeEvent({
          type: 'user_question_answered',
          batchId: 'b-1',
          answers: [{ questionId: 'q1', selectedOptionIds: ['q1-opt2'] }],
        }),
      ],
    };
    const persisted = {
      'turn-1': [
        makeEvent({ type: 'user_question', batchId: 'b-1' }),
        makeEvent({
          type: 'user_question_answered',
          batchId: 'b-1',
          answers: [{ questionId: 'q1', selectedOptionIds: ['q1-opt1'] }],
        }),
      ],
    };
    const merged = mergeUserQuestionEvents(live, persisted);
    // Should include the persisted user_question (filled from snapshot)
    // plus the live user_question_answered (live wins over persisted).
    expect(merged['turn-1']).toHaveLength(2);
    const answered = merged['turn-1']?.find((e) => e.type === 'user_question_answered');
    expect(answered).toMatchObject({
      type: 'user_question_answered',
      batchId: 'b-1',
      answers: [{ questionId: 'q1', selectedOptionIds: ['q1-opt2'] }],
    });
  });

  it('does not cross-contaminate turn ids', () => {
    const live = {
      'turn-A': [makeEvent({ type: 'user_question', batchId: 'b-A' })],
    };
    const persisted = {
      'turn-B': [makeEvent({ type: 'user_question', batchId: 'b-B' })],
    };
    const merged = mergeUserQuestionEvents(live, persisted);
    expect(Object.keys(merged).sort()).toEqual(['turn-A', 'turn-B']);
    expect(merged['turn-A']).toHaveLength(1);
    expect(merged['turn-B']).toHaveLength(1);
  });

  it('ignores events with no batchId (defensive — shouldn\'t be on this channel)', () => {
    // AgentEvent is a union; make a synthetic malformed entry (cast through unknown).
    const live: Record<string, AgentEvent[]> = {
      'turn-1': [
        { type: 'user_question', batchId: '', toolUseId: 'tu', questions: [], timestamp: 1 } as AgentEvent,
      ],
    };
    const persisted: Record<string, AgentEvent[]> = {
      'turn-1': [makeEvent({ type: 'user_question', batchId: 'b-1' })],
    };
    const merged = mergeUserQuestionEvents(live, persisted);
    // The empty-batchId live event is skipped by pushUnique; the persisted
    // event lands through.
    expect(merged['turn-1']).toHaveLength(1);
    expect(merged['turn-1']?.[0]).toMatchObject({ batchId: 'b-1' });
  });
});

// ── Cross-session routing leak regression tests ──────────────────────────
// Regression coverage for the observed bug where a user's answer to an
// AskUserQuestion in conversation B was routed as a fresh
// system-continuation turn into unrelated conversation A. The fix
// stamps an authoritative origin `sessionId` on the emitted
// `user_question` / `user_question_answered` events and makes the
// extractors *filter* mismatched events rather than blindly stamping
// them with the caller's `sessionId`.
// See docs-private/investigations/260424_user_question_cross_session_routing_leak.md.
import { extractQuestionBatches, extractAnsweredBatches } from '../hooks/useUserQuestions';

describe('extractQuestionBatches cross-session filtering', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // Re-establish spy in each beforeEach because the other describe
    // block's `vi.restoreAllMocks()` would otherwise reset a
    // module-level spy before these tests run.
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('drops events whose event.sessionId mismatches the caller currentSessionId', () => {
    const events = {
      'turn-1': [
        makeEvent({ type: 'user_question', batchId: 'b-stale', sessionId: 'session-B' }),
      ],
    };
    const batches = extractQuestionBatches(events, 'session-A');
    expect(batches).toHaveLength(0);
    // Observability: structured warning emitted — not a silent drop.
    expect(warnSpy).toHaveBeenCalledWith(
      '[extractQuestionBatches] dropped cross-session user_question event',
      expect.objectContaining({
        eventSessionId: 'session-B',
        currentSessionId: 'session-A',
        batchId: 'b-stale',
      }),
    );
  });

  it('accepts events when event.sessionId matches the caller currentSessionId', () => {
    const events = {
      'turn-1': [
        makeEvent({ type: 'user_question', batchId: 'b-match', sessionId: 'session-A' }),
      ],
    };
    const batches = extractQuestionBatches(events, 'session-A');
    expect(batches).toHaveLength(1);
    expect(batches[0]).toMatchObject({
      batchId: 'b-match',
      sessionId: 'session-A',
      turnId: 'turn-1',
    });
  });

  it('accepts legacy events without event.sessionId and uses the caller sessionId (with telemetry)', () => {
    const events = {
      'turn-1': [
        makeEvent({ type: 'user_question', batchId: 'b-legacy-q' }),
      ],
    };
    const batches = extractQuestionBatches(events, 'session-A');
    expect(batches).toHaveLength(1);
    expect(batches[0]?.sessionId).toBe('session-A');
    // Legacy telemetry — load-bearing per "Silent failure is a bug".
    expect(warnSpy).toHaveBeenCalledWith(
      '[extractQuestionBatches] legacy user_question event without sessionId — using caller sessionId',
      expect.objectContaining({ batchId: 'b-legacy-q', callerSessionId: 'session-A' }),
    );
  });

  it('accepts empty-string sessionId as legacy to align with desktop classifier semantics', () => {
    const events = {
      'turn-1': [
        makeEvent({ type: 'user_question', batchId: 'b-empty-session-q', sessionId: '' }),
      ],
    };
    const batches = extractQuestionBatches(events, 'session-A');
    expect(batches).toHaveLength(1);
    // Accepted-legacy events use the CALLER sessionId, not the malformed
    // empty-string provenance ('' is not nullish, so `?? sessionId` would have
    // leaked it). The batch must carry the caller session.
    expect(batches[0]?.sessionId).toBe('session-A');
    expect(warnSpy).toHaveBeenCalledWith(
      '[extractQuestionBatches] legacy user_question event without sessionId — using caller sessionId',
      expect.objectContaining({ batchId: 'b-empty-session-q', callerSessionId: 'session-A' }),
    );
  });

  it('accepts malformed non-string sessionId as legacy and stamps the caller sessionId', () => {
    const events = {
      'turn-1': [
        // Runtime-malformed provenance (non-string) — defensively treated as
        // missing/legacy by the shared classifier; batch must use caller session.
        makeEvent({ type: 'user_question', batchId: 'b-malformed-q', sessionId: 123 as unknown as string }),
      ],
    };
    const batches = extractQuestionBatches(events, 'session-A');
    expect(batches).toHaveLength(1);
    expect(batches[0]?.sessionId).toBe('session-A');
  });

  it('given eventsByTurn from session X and currentSessionId=Y returns empty (exact observed bug)', () => {
    // Reproduces the observed race: useDeferredValue(eventsByTurn) held
    // a stale snapshot from conv B while currentSessionId had already
    // flipped to conv A. Pre-fix: this returned a batch stamped with
    // sessionId=A, which routed the continuation turn into conv A.
    const events = {
      'turn-B': [
        makeEvent({ type: 'user_question', batchId: 'b-leaked', sessionId: 'session-B' }),
      ],
    };
    const batches = extractQuestionBatches(events, 'session-A');
    expect(batches).toEqual([]);
  });
});

describe('extractAnsweredBatches cross-session filtering', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('drops events whose event.sessionId mismatches the caller currentSessionId', () => {
    const events = {
      'turn-1': [
        makeEvent({
          type: 'user_question_answered',
          batchId: 'b-stale',
          answers: [{ questionId: 'q1', selectedOptionIds: ['q1-opt1'] }],
          sessionId: 'session-B',
        }),
      ],
    };
    const answered = extractAnsweredBatches(events, 'session-A');
    expect(answered.size).toBe(0);
    expect(warnSpy).toHaveBeenCalledWith(
      '[extractAnsweredBatches] dropped cross-session user_question_answered event',
      expect.objectContaining({
        eventSessionId: 'session-B',
        currentSessionId: 'session-A',
        batchId: 'b-stale',
      }),
    );
  });

  it('accepts events when event.sessionId matches the caller currentSessionId', () => {
    const events = {
      'turn-1': [
        makeEvent({
          type: 'user_question_answered',
          batchId: 'b-match',
          answers: [{ questionId: 'q1', selectedOptionIds: ['q1-opt1'] }],
          sessionId: 'session-A',
        }),
      ],
    };
    const answered = extractAnsweredBatches(events, 'session-A');
    expect(answered.size).toBe(1);
    expect(answered.get('b-match')).toMatchObject({
      answers: [{ questionId: 'q1', selectedOptionIds: ['q1-opt1'] }],
    });
  });

  it('accepts legacy events without event.sessionId and uses the caller sessionId (with telemetry)', () => {
    const events = {
      'turn-1': [
        makeEvent({
          type: 'user_question_answered',
          batchId: 'b-legacy-a',
          answers: [{ questionId: 'q1', selectedOptionIds: ['q1-opt1'] }],
        }),
      ],
    };
    const answered = extractAnsweredBatches(events, 'session-A');
    expect(answered.size).toBe(1);
    expect(warnSpy).toHaveBeenCalledWith(
      '[extractAnsweredBatches] legacy user_question_answered event without sessionId — using caller sessionId',
      expect.objectContaining({ batchId: 'b-legacy-a', callerSessionId: 'session-A' }),
    );
  });

  it('accepts empty-string sessionId as legacy to align with desktop classifier semantics', () => {
    const events = {
      'turn-1': [
        makeEvent({
          type: 'user_question_answered',
          batchId: 'b-empty-session-a',
          answers: [{ questionId: 'q1', selectedOptionIds: ['q1-opt1'] }],
          sessionId: '',
        }),
      ],
    };
    const answered = extractAnsweredBatches(events, 'session-A');
    expect(answered.size).toBe(1);
    expect(answered.get('b-empty-session-a')).toMatchObject({
      answers: [{ questionId: 'q1', selectedOptionIds: ['q1-opt1'] }],
    });
    expect(warnSpy).toHaveBeenCalledWith(
      '[extractAnsweredBatches] legacy user_question_answered event without sessionId — using caller sessionId',
      expect.objectContaining({ batchId: 'b-empty-session-a', callerSessionId: 'session-A' }),
    );
  });

  it('given eventsByTurn from session X and currentSessionId=Y returns empty', () => {
    const events = {
      'turn-B': [
        makeEvent({
          type: 'user_question_answered',
          batchId: 'b-leaked',
          answers: [{ questionId: 'q1', selectedOptionIds: ['q1-opt1'] }],
          sessionId: 'session-B',
        }),
      ],
    };
    const answered = extractAnsweredBatches(events, 'session-A');
    expect(answered.size).toBe(0);
  });
});

// ── Cross-session drop-warning dedup regression tests ────────────────────
// Surfaced by Sentry REBEL-5D5: the Layer-4 drop branch emitted ~96
// `[extractQuestionBatches] dropped cross-session …` warnings in a
// single 15-minute production session because foreign-stamped events
// sat in `eventsByTurn` for the duration of a long tool-running turn
// and the extractor was re-invoked on every render. The drop itself is
// correct; only the per-render re-warn was wrong. Dedup is keyed per
// `(eventType, batchId, eventSessionId, currentSessionId)`.
//
// Test isolation discipline: `crossSessionDropWarningEmittedFor` is a
// module-level Set that persists across `it()` blocks within this file
// (Vitest's default isolation is per-file, not per-test). Every test
// below MUST use a unique `batchId` (or unique sessionId-pair) so its
// dedup tuple has not been seen by any earlier test. Reusing a batchId
// will silently make the warning suppressed and make the test pass for
// the wrong reason. If you need to reset state, prefer adding a unique
// suffix to your batchId rather than reaching for `vi.resetModules()`.

describe('extractQuestionBatches cross-session warning dedup', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('emits at most one warning per (batchId, sessionId-pair) across repeated calls', () => {
    // Use a unique batchId guaranteed not to collide with prior tests'
    // module-level dedup state. The outer cloud-client describe block
    // mounts hooks that internally call extractQuestionBatches via
    // useMemo, which can re-evaluate during async test teardown — so we
    // filter by exact batchId rather than just message string to isolate
    // this test's calls from background ones.
    const myBatchId = 'b-dedup-q-isolated-1';
    const events = {
      'turn-1': [
        makeEvent({ type: 'user_question', batchId: myBatchId, sessionId: 'session-B' }),
      ],
    };
    extractQuestionBatches(events, 'session-A');
    extractQuestionBatches(events, 'session-A');
    extractQuestionBatches(events, 'session-A');
    extractQuestionBatches(events, 'session-A');
    extractQuestionBatches(events, 'session-A');

    const dropWarnCount = warnSpy.mock.calls.filter(
      (args: unknown[]) =>
        args[0] === '[extractQuestionBatches] dropped cross-session user_question event' &&
        (args[1] as { batchId?: string } | undefined)?.batchId === myBatchId,
    ).length;
    expect(dropWarnCount).toBe(1);
  });

  it('emits separately for distinct (batchId, eventSessionId, currentSessionId) tuples', () => {
    const events1 = {
      'turn-x': [
        makeEvent({ type: 'user_question', batchId: 'b-dedup-q-distinct-iso-1', sessionId: 'session-B' }),
      ],
    };
    const events2 = {
      'turn-x': [
        makeEvent({ type: 'user_question', batchId: 'b-dedup-q-distinct-iso-2', sessionId: 'session-B' }),
      ],
    };
    const events3 = {
      'turn-x': [
        makeEvent({ type: 'user_question', batchId: 'b-dedup-q-distinct-iso-1', sessionId: 'session-C' }),
      ],
    };
    extractQuestionBatches(events1, 'session-A');
    extractQuestionBatches(events1, 'session-A');
    extractQuestionBatches(events2, 'session-A');
    extractQuestionBatches(events3, 'session-A');

    const dropWarnCount = warnSpy.mock.calls.filter((args: unknown[]) => {
      if (args[0] !== '[extractQuestionBatches] dropped cross-session user_question event') return false;
      const batchId = (args[1] as { batchId?: string } | undefined)?.batchId;
      return typeof batchId === 'string' && batchId.startsWith('b-dedup-q-distinct-iso-');
    }).length;
    expect(dropWarnCount).toBe(3);
  });

  it('includes turnId in the warning payload for forensic correlation', () => {
    const events = {
      'turn-forensic-q': [
        makeEvent({ type: 'user_question', batchId: 'b-dedup-q-turnid', sessionId: 'session-B' }),
      ],
    };
    extractQuestionBatches(events, 'session-A');
    expect(warnSpy).toHaveBeenCalledWith(
      '[extractQuestionBatches] dropped cross-session user_question event',
      expect.objectContaining({ turnId: 'turn-forensic-q' }),
    );
  });
});

describe('extractAnsweredBatches cross-session warning dedup', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('emits at most one warning per (batchId, sessionId-pair) across repeated calls', () => {
    const myBatchId = 'b-dedup-a-isolated-1';
    const events = {
      'turn-1': [
        makeEvent({
          type: 'user_question_answered',
          batchId: myBatchId,
          answers: [{ questionId: 'q1', selectedOptionIds: ['q1-opt1'] }],
          sessionId: 'session-B',
        }),
      ],
    };
    extractAnsweredBatches(events, 'session-A');
    extractAnsweredBatches(events, 'session-A');
    extractAnsweredBatches(events, 'session-A');
    extractAnsweredBatches(events, 'session-A');
    extractAnsweredBatches(events, 'session-A');

    const dropWarnCount = warnSpy.mock.calls.filter(
      (args: unknown[]) =>
        args[0] === '[extractAnsweredBatches] dropped cross-session user_question_answered event' &&
        (args[1] as { batchId?: string } | undefined)?.batchId === myBatchId,
    ).length;
    expect(dropWarnCount).toBe(1);
  });

  it('emits separately for distinct (batchId, eventSessionId, currentSessionId) tuples', () => {
    const events1 = {
      'turn-x': [
        makeEvent({
          type: 'user_question_answered',
          batchId: 'b-dedup-a-distinct-iso-1',
          answers: [{ questionId: 'q1', selectedOptionIds: ['q1-opt1'] }],
          sessionId: 'session-B',
        }),
      ],
    };
    const events2 = {
      'turn-x': [
        makeEvent({
          type: 'user_question_answered',
          batchId: 'b-dedup-a-distinct-iso-2',
          answers: [{ questionId: 'q1', selectedOptionIds: ['q1-opt1'] }],
          sessionId: 'session-B',
        }),
      ],
    };
    const events3 = {
      'turn-x': [
        makeEvent({
          type: 'user_question_answered',
          batchId: 'b-dedup-a-distinct-iso-1',
          answers: [{ questionId: 'q1', selectedOptionIds: ['q1-opt1'] }],
          sessionId: 'session-C',
        }),
      ],
    };
    extractAnsweredBatches(events1, 'session-A');
    extractAnsweredBatches(events1, 'session-A');
    extractAnsweredBatches(events2, 'session-A');
    extractAnsweredBatches(events3, 'session-A');

    const dropWarnCount = warnSpy.mock.calls.filter((args: unknown[]) => {
      if (args[0] !== '[extractAnsweredBatches] dropped cross-session user_question_answered event') return false;
      const batchId = (args[1] as { batchId?: string } | undefined)?.batchId;
      return typeof batchId === 'string' && batchId.startsWith('b-dedup-a-distinct-iso-');
    }).length;
    expect(dropWarnCount).toBe(3);
  });

  it('includes turnId in the warning payload for forensic correlation', () => {
    const events = {
      'turn-forensic-a': [
        makeEvent({
          type: 'user_question_answered',
          batchId: 'b-dedup-a-turnid',
          answers: [{ questionId: 'q1', selectedOptionIds: ['q1-opt1'] }],
          sessionId: 'session-B',
        }),
      ],
    };
    extractAnsweredBatches(events, 'session-A');
    expect(warnSpy).toHaveBeenCalledWith(
      '[extractAnsweredBatches] dropped cross-session user_question_answered event',
      expect.objectContaining({ turnId: 'turn-forensic-a' }),
    );
  });
});
