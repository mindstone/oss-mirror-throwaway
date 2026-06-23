/**
 * Tests for the platform-agnostic user-question response handler.
 *
 * Covers behavior previously tested only via desktop IPC:
 * - dedup of duplicate batch submissions
 * - skip vs answer continuation message paths
 * - multi-batch (queued) responses
 * - context prefix injection from the original turn's accumulator
 * - clearing the hasUserQuestionPending flag
 *
 * See docs/plans/260420_user_question_cross_surface_resilience.md (Stage 3a).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Hoisted mocks ──────────────────────────────────────────
const {
  broadcastMock,
  registerMock,
  registryMocks,
  accumulatorAppendMock,
} = vi.hoisted(() => {
  let mockSeqCounter = 0;
  // Mirror production: LazyContextAccumulator.appendEvent returns the input
  // event with a positive integer `seq` stamped on it. The downstream
  // assertEventHasSeq guard at the agent:event boundary (I14) requires the
  // returned event to carry a valid seq.
  const accumulatorAppendMock = vi.fn((event: unknown) => {
    mockSeqCounter += 1;
    return { ...(event as Record<string, unknown>), seq: mockSeqCounter };
  });
  const accumulatorStub = { appendEvent: accumulatorAppendMock };
  return {
    broadcastMock: vi.fn(),
    registerMock: vi.fn(),
    accumulatorAppendMock,
    registryMocks: {
      getContextAccumulator: vi.fn((): unknown => undefined),
      deleteContextAccumulator: vi.fn(),
      clearUserQuestionPending: vi.fn(() => true),
      getOrCreateAccumulator: vi.fn(() => accumulatorStub),
      getUserQuestionProvenance: vi.fn((_turnId: string, _batchId: string): unknown => undefined),
      clearUserQuestionProvenance: vi.fn(),
    },
  };
});

 
vi.mock('@core/broadcastService', () => ({
  getBroadcastService: () => ({ sendToAllWindows: broadcastMock, sendToFocusedWindow: vi.fn() }),
}));

 
vi.mock('@core/handlerRegistry', () => ({
  getHandlerRegistry: () => ({
    register: registerMock,
    remove: vi.fn(),
    get: vi.fn(),
  }),
}));

 
vi.mock('@core/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  createScopedLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
  })),
}));

 
vi.mock('@core/services/agentTurnRegistry', () => ({
  agentTurnRegistry: registryMocks,
}));

// ─── Imports under test ────────────────────────────────────
import {
  handleUserQuestionResponse,
  registerUserQuestionResponseHandler,
  setUserQuestionAnsweredPersister,
  setUserQuestionProvenanceResolver,
  _testing_resetAnsweredBatches,
  _testing_resetAnsweredPersister,
  _testing_resetQuestionProvenanceResolver,
  type UserQuestionResponseRequest,
} from '@core/services/userQuestionResponseHandler';
import type { UserQuestion } from '@shared/types/userQuestion';

const SESSION_ID = 'session-test';
const TURN_ID = 'turn-test';
const TOOL_USE_ID = 'tu-test';

const sampleQuestions: UserQuestion[] = [
  {
    id: 'q0',
    question: 'Which option fits best?',
    header: 'Choose',
    options: [
      { id: 'q0-opt0', label: 'Option A', description: 'First option' },
      { id: 'q0-opt1', label: 'Option B', description: 'Second option' },
    ],
    multiSelect: false,
  },
];

const approvalClarificationQuestions: UserQuestion[] = [
  {
    ...sampleQuestions[0],
    purpose: 'approval_clarification',
  },
];

function makeRequest(
  overrides?: Partial<UserQuestionResponseRequest>,
): UserQuestionResponseRequest {
  return {
    batchId: 'batch-1',
    answers: [{ questionId: 'q0', selectedOptionIds: ['q0-opt0'] }],
    sessionId: SESSION_ID,
    turnId: TURN_ID,
    toolUseId: TOOL_USE_ID,
    questions: sampleQuestions,
    ...overrides,
  };
}

function makeAccumulatorWithQuestion(
  batchId: string,
  questions: UserQuestion[],
  sessionId: string = SESSION_ID,
) {
  return {
    messages: [],
    eventsByTurn: {
      [TURN_ID]: [
        {
          type: 'user_question',
          batchId,
          toolUseId: TOOL_USE_ID,
          questions,
          sessionId,
          timestamp: 1,
        },
      ],
    },
    activeTurnId: TURN_ID,
    isBusy: false,
    lastError: null,
    lastErrorSource: null,
  };
}

describe('handleUserQuestionResponse', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _testing_resetAnsweredBatches();
    _testing_resetAnsweredPersister();
    _testing_resetQuestionProvenanceResolver();
    registryMocks.getContextAccumulator.mockReturnValue(undefined);
    registryMocks.getUserQuestionProvenance.mockReturnValue(undefined);
  });

  it('accepts queued approval clarification without special provenance', async () => {
    registryMocks.getContextAccumulator.mockReturnValue({
      messages: [],
      eventsByTurn: {
        [TURN_ID]: [
          {
            type: 'user_question',
            batchId: 'batch-generic',
            toolUseId: TOOL_USE_ID,
            questions: sampleQuestions,
            sessionId: SESSION_ID,
            timestamp: 1,
          },
        ],
      },
      activeTurnId: TURN_ID,
      isBusy: false,
      lastError: null,
      lastErrorSource: null,
    });

    const result = await handleUserQuestionResponse(
      makeRequest({
        batchId: 'lead-batch',
        answers: [],
        queuedBatches: [
          {
            batchId: 'batch-approval',
            answers: [{ questionId: 'q0', selectedOptionIds: ['q0-opt0'] }],
            questions: approvalClarificationQuestions,
          },
        ],
      }),
    );

    expect(result.success).toBe(true);
    expect(result.continuationMessage).toContain('The user answered your 1 set of questions');
    expect(broadcastMock).toHaveBeenCalledTimes(1);
  });

  it('rejects queued approval clarification with mismatched stored session provenance', async () => {
    registryMocks.getContextAccumulator.mockReturnValue({
      messages: [],
      eventsByTurn: {
        [TURN_ID]: [
          {
            type: 'user_question',
            batchId: 'batch-approval',
            toolUseId: TOOL_USE_ID,
            questions: approvalClarificationQuestions,
            sessionId: 'other-session',
            timestamp: 1,
          },
        ],
      },
      activeTurnId: TURN_ID,
      isBusy: false,
      lastError: null,
      lastErrorSource: null,
    });

    const result = await handleUserQuestionResponse(
      makeRequest({
        batchId: 'lead-batch',
        answers: [],
        queuedBatches: [
          {
            batchId: 'batch-approval',
            answers: [{ questionId: 'q0', selectedOptionIds: ['q0-opt0'] }],
            questions: approvalClarificationQuestions,
          },
        ],
      }),
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe('Session mismatch for user question batch');
    expect(broadcastMock).not.toHaveBeenCalled();
  });

  it('rejects empty batchId', async () => {
    const result = await handleUserQuestionResponse(makeRequest({ batchId: '' }));
    expect(result.success).toBe(false);
    expect(result.error).toBe('Invalid batch ID');
  });

  it('rejects missing required context', async () => {
    const result = await handleUserQuestionResponse(
      makeRequest({ sessionId: '' }),
    );
    expect(result.success).toBe(false);
    expect(result.error).toBe('Question batch context missing or incomplete');
  });

  it('rejects skipped batch with answers present', async () => {
    const result = await handleUserQuestionResponse(
      makeRequest({
        skipped: true,
        answers: [{ questionId: 'q0', selectedOptionIds: ['q0-opt0'] }],
      }),
    );
    expect(result.success).toBe(false);
    expect(result.error).toBe('Cannot provide answers when skipping');
  });

  it('builds continuation message and broadcasts answered event', async () => {
    const result = await handleUserQuestionResponse(makeRequest());

    expect(result.success).toBe(true);
    expect(result.continuationMessage).toContain('The user answered your questions');
    expect(result.continuationMessage).toContain('Option A');
    expect(broadcastMock).toHaveBeenCalledWith(
      'agent:event',
      expect.objectContaining({
        turnId: TURN_ID,
        sessionId: SESSION_ID,
        event: expect.objectContaining({
          type: 'user_question_answered',
          batchId: 'batch-1',
        }),
      }),
    );
  });

  it('preserves attachment metadata in the answered event and continuation message', async () => {
    const result = await handleUserQuestionResponse(
      makeRequest({
        answers: [{
          questionId: 'q0',
          selectedOptionIds: ['q0-opt0'],
          attachments: [{ id: 'att-1', name: 'brief.pdf', type: 'document', mimeType: 'application/pdf' }],
        }],
      }),
    );

    expect(result.success).toBe(true);
    expect(result.continuationMessage).toContain('attached document: brief.pdf');
    expect(broadcastMock).toHaveBeenCalledWith(
      'agent:event',
      expect.objectContaining({
        event: expect.objectContaining({
          answers: [
            expect.objectContaining({
              attachments: [
                expect.objectContaining({ name: 'brief.pdf' }),
              ],
            }),
          ],
        }),
      }),
    );
  });

  it('appends user_question_answered event to the original turn accumulator', async () => {
    // Regression coverage for multi-model review FINDING A (structural):
    // the answered event must be accumulated server-side so downstream
    // replay / diagnostics / session rehydration paths can observe it,
    // even when the broadcast is dropped by the cloud channel.
    await handleUserQuestionResponse(makeRequest());
    expect(registryMocks.getOrCreateAccumulator).toHaveBeenCalledWith(TURN_ID, SESSION_ID);
    expect(accumulatorAppendMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'user_question_answered',
        batchId: 'batch-1',
      }),
      SESSION_ID,
    );
  });

  it('invokes the registered persister with the answered event (single-batch)', async () => {
    // Stage 7: cloud-side persistence is injected so the answered event lands
    // in the session's eventsByTurn on disk, letting clients rehydrate the
    // answered state after a force-quit.
    const persist = vi.fn().mockResolvedValue(undefined);
    setUserQuestionAnsweredPersister(persist);

    const result = await handleUserQuestionResponse(makeRequest());

    expect(result.success).toBe(true);
    expect(persist).toHaveBeenCalledTimes(1);
    expect(persist).toHaveBeenCalledWith(
      SESSION_ID,
      TURN_ID,
      expect.objectContaining({
        type: 'user_question_answered',
        batchId: 'batch-1',
        // I14/I17: cloud/mobile rehydration parity — the persisted event must
        // carry the same `seq` that was broadcast, so cross-surface event
        // dedup works after reload.
        seq: expect.any(Number),
      }),
    );
    const persistedSeq = (persist.mock.calls[0]?.[2] as { seq?: unknown })?.seq;
    expect(Number.isInteger(persistedSeq) && Number(persistedSeq) > 0).toBe(true);
  });

  it('invokes the registered persister once per queued batch', async () => {
    const persist = vi.fn().mockResolvedValue(undefined);
    setUserQuestionAnsweredPersister(persist);

    const result = await handleUserQuestionResponse(
      makeRequest({
        queuedBatches: [
          {
            batchId: 'batch-1',
            answers: [{ questionId: 'q0', selectedOptionIds: ['q0-opt0'] }],
            questions: sampleQuestions,
          },
          {
            batchId: 'batch-2',
            answers: [{ questionId: 'q0', selectedOptionIds: ['q0-opt1'] }],
            questions: sampleQuestions,
          },
        ],
      }),
    );

    expect(result.success).toBe(true);
    expect(persist).toHaveBeenCalledTimes(2);
    // Both persisted events carry sequenced shape — see persister-seq comment
    // above for cross-surface rehydration parity rationale.
    expect(persist.mock.calls[0]?.[2]).toMatchObject({
      batchId: 'batch-1',
      seq: expect.any(Number),
    });
    expect(persist.mock.calls[1]?.[2]).toMatchObject({
      batchId: 'batch-2',
      seq: expect.any(Number),
    });
  });

  it('swallows persister failures without blocking the response', async () => {
    // Persistence failures must not strand the turn — the user's answer is
    // already honored in-memory, so we log and continue. Cross-session
    // rehydration is degraded, but the in-session flow is preserved.
    const persist = vi.fn().mockRejectedValue(new Error('db down'));
    setUserQuestionAnsweredPersister(persist);

    const result = await handleUserQuestionResponse(makeRequest());

    expect(result.success).toBe(true);
    expect(result.continuationMessage).toContain('The user answered your questions');
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it('emits skip continuation when skipped=true with empty answers', async () => {
    const result = await handleUserQuestionResponse(
      makeRequest({ skipped: true, answers: [] }),
    );
    expect(result.success).toBe(true);
    expect(result.continuationMessage).toContain('skip');
  });

  it('clears hasUserQuestionPending after processing', async () => {
    await handleUserQuestionResponse(makeRequest());
    expect(registryMocks.clearUserQuestionPending).toHaveBeenCalledWith(TURN_ID);
  });

  it('injects accumulated conversation context into the continuation prompt', async () => {
    registryMocks.getContextAccumulator.mockReturnValue({
      messages: [
        { role: 'user', text: 'Original prompt' },
        { role: 'assistant', text: 'I started looking at this...' },
      ],
      eventsByTurn: { [TURN_ID]: [] },
      activeTurnId: TURN_ID,
      isBusy: false,
      lastError: null,
      lastErrorSource: null,
    });

    const result = await handleUserQuestionResponse(makeRequest());
    expect(result.continuationMessage).toContain('<conversation_history>');
    expect(result.continuationMessage).toContain('I started looking at this...');
    expect(registryMocks.deleteContextAccumulator).toHaveBeenCalledWith(TURN_ID);
  });

  it('replays the cached continuation on duplicate single-batch submissions', async () => {
    const first = await handleUserQuestionResponse(makeRequest());
    const second = await handleUserQuestionResponse(makeRequest());
    expect(first.success).toBe(true);
    expect(first.continuationMessage).toBeTruthy();
    expect(second.success).toBe(true);
    // Idempotency: the retry must receive the same continuation payload
    // as the original, not a bare `{ success: true }` — otherwise the
    // client would lose the continuation turn if the first response was
    // dropped in transit. See docs-private/postmortems/260420_empty_result_anomaly_askuserquestion_deny_postmortem.md
    expect(second.continuationMessage).toBe(first.continuationMessage);
    // Broadcast still fires exactly once — only the first real invocation
    // updates any listening UI / accumulator.
    expect(broadcastMock).toHaveBeenCalledTimes(1);
  });

  it('replays cached approval-clarification answer after provenance is gone', async () => {
    registryMocks.getContextAccumulator.mockReturnValue(
      makeAccumulatorWithQuestion('batch-approval', approvalClarificationQuestions),
    );

    const approvalRequest = makeRequest({
      batchId: 'batch-approval',
      questions: approvalClarificationQuestions,
    });

    const first = await handleUserQuestionResponse(approvalRequest);
    expect(first.success).toBe(true);
    expect(first.continuationMessage).toContain('The user answered your questions');
    expect(broadcastMock).toHaveBeenCalledTimes(1);

    // Simulate the first successful response clearing/deleting the accumulator
    // before the client retries after a lost HTTP/IPC response.
    registryMocks.getContextAccumulator.mockReturnValue(undefined);
    broadcastMock.mockClear();

    const second = await handleUserQuestionResponse(approvalRequest);

    expect(second.success).toBe(true);
    expect(second.continuationMessage).toBe(first.continuationMessage);
    expect(broadcastMock).not.toHaveBeenCalled();
  });

  it('accepts approval-clarification answer from dedicated pending-question provenance when accumulator is gone', async () => {
    registryMocks.getContextAccumulator.mockReturnValue(undefined);
    registryMocks.getUserQuestionProvenance.mockReturnValue({
      type: 'user_question',
      batchId: 'batch-approval-indexed',
      toolUseId: TOOL_USE_ID,
      questions: approvalClarificationQuestions,
      sessionId: SESSION_ID,
      timestamp: 1,
    });

    const result = await handleUserQuestionResponse(
      makeRequest({
        batchId: 'batch-approval-indexed',
        questions: approvalClarificationQuestions,
      }),
    );

    expect(result.success).toBe(true);
    expect(result.continuationMessage).toContain('The user answered your questions');
    expect(registryMocks.clearUserQuestionProvenance).toHaveBeenCalledWith(TURN_ID);
  });

  it('rejects dedicated-index approval clarification with mismatched stored session provenance', async () => {
    registryMocks.getContextAccumulator.mockReturnValue(undefined);
    registryMocks.getUserQuestionProvenance.mockReturnValue({
      type: 'user_question',
      batchId: 'batch-approval-indexed-mismatch',
      toolUseId: TOOL_USE_ID,
      questions: approvalClarificationQuestions,
      sessionId: 'other-session',
      timestamp: 1,
    });

    const result = await handleUserQuestionResponse(
      makeRequest({
        batchId: 'batch-approval-indexed-mismatch',
        questions: approvalClarificationQuestions,
      }),
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe('Session mismatch for user question batch');
    expect(broadcastMock).not.toHaveBeenCalled();
  });

  it('accepts approval-clarification answer from trusted persisted session provenance when memory provenance is gone', async () => {
    registryMocks.getContextAccumulator.mockReturnValue(undefined);
    registryMocks.getUserQuestionProvenance.mockReturnValue(undefined);
    setUserQuestionProvenanceResolver(async () => ({
      type: 'user_question',
      batchId: 'batch-approval-persisted',
      toolUseId: TOOL_USE_ID,
      questions: approvalClarificationQuestions,
      sessionId: SESSION_ID,
      timestamp: 1,
    }));

    const result = await handleUserQuestionResponse(
      makeRequest({
        batchId: 'batch-approval-persisted',
        questions: approvalClarificationQuestions,
      }),
    );

    expect(result.success).toBe(true);
    expect(result.continuationMessage).toContain('The user answered your questions');
    expect(broadcastMock).toHaveBeenCalledTimes(1);
  });

  it('rejects approval-clarification answer when trusted persisted provenance belongs to another session', async () => {
    registryMocks.getContextAccumulator.mockReturnValue(undefined);
    registryMocks.getUserQuestionProvenance.mockReturnValue(undefined);
    setUserQuestionProvenanceResolver(async () => ({
      type: 'user_question',
      batchId: 'batch-approval-persisted-mismatch',
      toolUseId: TOOL_USE_ID,
      questions: approvalClarificationQuestions,
      sessionId: 'other-session',
      timestamp: 1,
    }));

    const result = await handleUserQuestionResponse(
      makeRequest({
        batchId: 'batch-approval-persisted-mismatch',
        questions: approvalClarificationQuestions,
      }),
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe('Session mismatch for user question batch');
    expect(broadcastMock).not.toHaveBeenCalled();
  });

  it('accepts fresh approval-clarification answer without stored provenance', async () => {
    const persist = vi.fn().mockResolvedValue(undefined);
    setUserQuestionAnsweredPersister(persist);
    registryMocks.getContextAccumulator.mockReturnValue(undefined);

    const result = await handleUserQuestionResponse(
      makeRequest({
        batchId: 'batch-approval-no-provenance',
        questions: approvalClarificationQuestions,
      }),
    );

    expect(result.success).toBe(true);
    expect(result.continuationMessage).toContain('The user answered your questions');
    expect(broadcastMock).toHaveBeenCalledTimes(1);
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it('replays idempotency cache after accepted fresh approval-clarification response', async () => {
    const persist = vi.fn().mockResolvedValue(undefined);
    setUserQuestionAnsweredPersister(persist);
    registryMocks.getContextAccumulator.mockReturnValue(undefined);

    const approvalRequest = makeRequest({
      batchId: 'batch-approval-cache-not-poisoned',
      questions: approvalClarificationQuestions,
    });

    const accepted = await handleUserQuestionResponse(approvalRequest);
    const replayed = await handleUserQuestionResponse(approvalRequest);

    expect(accepted.success).toBe(true);
    expect(accepted.continuationMessage).toContain('The user answered your questions');
    expect(replayed).toEqual(accepted);
    expect(broadcastMock).toHaveBeenCalledTimes(1);
    expect(accumulatorAppendMock).toHaveBeenCalledTimes(1);
    expect(persist).toHaveBeenCalledTimes(1);
    expect(registryMocks.clearUserQuestionPending).toHaveBeenCalledWith(TURN_ID);
  });

  it('handles queued multi-batch responses', async () => {
    const result = await handleUserQuestionResponse(
      makeRequest({
        batchId: 'lead-batch',
        answers: [],
        queuedBatches: [
          {
            batchId: 'batch-A',
            answers: [{ questionId: 'q0', selectedOptionIds: ['q0-opt0'] }],
            questions: sampleQuestions,
          },
          {
            batchId: 'batch-B',
            answers: [{ questionId: 'q0', selectedOptionIds: ['q0-opt1'] }],
            questions: sampleQuestions,
          },
        ],
      }),
    );

    expect(result.success).toBe(true);
    expect(result.continuationMessage).toContain('2 sets of questions');
    // One broadcast per queued batch
    expect(broadcastMock).toHaveBeenCalledTimes(2);
  });

  // ── Cross-session routing leak regression tests ────────────────────
  // See docs-private/investigations/260424_user_question_cross_session_routing_leak.md.

  it('rejects when request.sessionId does not match the stored user_question event sessionId', async () => {
    // Seed the turn's context accumulator with a user_question event whose
    // origin sessionId is session-A. The incoming response from session-B
    // must be rejected — this is the exact cross-session leak fix.
    registryMocks.getContextAccumulator.mockReturnValue({
      messages: [],
      eventsByTurn: {
        [TURN_ID]: [
          {
            type: 'user_question',
            batchId: 'batch-1',
            toolUseId: TOOL_USE_ID,
            questions: sampleQuestions,
            sessionId: 'session-A',
            timestamp: 1,
          },
        ],
      },
      activeTurnId: TURN_ID,
      isBusy: false,
      lastError: null,
      lastErrorSource: null,
    });

    const result = await handleUserQuestionResponse(
      makeRequest({ sessionId: 'session-B' }),
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe('Session mismatch for user question batch');
    // No continuation returned.
    expect(result.continuationMessage).toBeUndefined();
    // No broadcast happened (rejected before answered-event emission).
    expect(broadcastMock).not.toHaveBeenCalled();
    // Cache not populated — a subsequent, correctly-routed submit must
    // still be allowed to run. Retry with the correct sessionId.
    registryMocks.getContextAccumulator.mockReturnValue(undefined);
    const retry = await handleUserQuestionResponse(
      makeRequest({ sessionId: 'session-A' }),
    );
    expect(retry.success).toBe(true);
    expect(retry.continuationMessage).toBeTruthy();
  });

  it('allows with telemetry when the accumulator has no user_question event (post-restart scenario)', async () => {
    // No accumulator entry — e.g. process restart GC'd the turn state.
    // Documented intentional policy: allow the response through so the
    // user's answer isn't stranded; emit telemetry so regressions are
    // observable.
    registryMocks.getContextAccumulator.mockReturnValue(undefined);

    const result = await handleUserQuestionResponse(makeRequest());

    expect(result.success).toBe(true);
    expect(result.continuationMessage).toContain('The user answered your questions');
  });

  it('allows with telemetry when stored user_question event lacks sessionId (legacy pre-fix)', async () => {
    // Legacy event emitted before this fix landed — stored event has no
    // sessionId to validate against. Documented intentional policy:
    // allow through with structured warn telemetry (not a silent pass).
    registryMocks.getContextAccumulator.mockReturnValue({
      messages: [],
      eventsByTurn: {
        [TURN_ID]: [
          {
            type: 'user_question',
            batchId: 'batch-1',
            toolUseId: TOOL_USE_ID,
            questions: sampleQuestions,
            // sessionId intentionally omitted — simulates pre-fix event
            timestamp: 1,
          },
        ],
      },
      activeTurnId: TURN_ID,
      isBusy: false,
      lastError: null,
      lastErrorSource: null,
    });

    const result = await handleUserQuestionResponse(makeRequest());

    // The response is allowed through (not rejected) so the user's
    // answer is not stranded by a legacy event missing provenance.
    expect(result.success).toBe(true);
    expect(result.continuationMessage).toBeTruthy();
    // The broadcast still happened (answered event emitted).
    expect(broadcastMock).toHaveBeenCalled();
  });

  it('idempotency cache key includes sessionId (distinct sessions do not replay each other)', async () => {
    // Two submits with the same batchId but different sessionId must be
    // treated as independent — otherwise a retry from the correctly-
    // displayed session could replay a wrongly-routed first continuation.
    _testing_resetAnsweredBatches();

    const first = await handleUserQuestionResponse(
      makeRequest({ sessionId: 'session-A' }),
    );
    expect(first.success).toBe(true);
    expect(first.continuationMessage).toBeTruthy();

    const second = await handleUserQuestionResponse(
      makeRequest({ sessionId: 'session-B' }),
    );
    // Fresh processing (not a dedup replay) — success + its own continuation.
    expect(second.success).toBe(true);
    expect(second.continuationMessage).toBeTruthy();

    // Both invocations broadcasted — the cache did not short-circuit
    // the second one as a duplicate of the first.
    expect(broadcastMock).toHaveBeenCalledTimes(2);
  });

  it('dedups queued multi-batch when all batches already answered', async () => {
    // First call answers both
    await handleUserQuestionResponse(
      makeRequest({
        batchId: 'lead-1',
        answers: [],
        queuedBatches: [
          { batchId: 'b1', answers: [{ questionId: 'q0', selectedOptionIds: ['q0-opt0'] }], questions: sampleQuestions },
          { batchId: 'b2', answers: [{ questionId: 'q0', selectedOptionIds: ['q0-opt0'] }], questions: sampleQuestions },
        ],
      }),
    );
    broadcastMock.mockClear();

    // Second call with same batches → all dedup
    const result = await handleUserQuestionResponse(
      makeRequest({
        batchId: 'lead-2',
        answers: [],
        queuedBatches: [
          { batchId: 'b1', answers: [{ questionId: 'q0', selectedOptionIds: ['q0-opt0'] }], questions: sampleQuestions },
          { batchId: 'b2', answers: [{ questionId: 'q0', selectedOptionIds: ['q0-opt0'] }], questions: sampleQuestions },
        ],
      }),
    );
    expect(result.success).toBe(true);
    expect(result.continuationMessage).toBeUndefined();
    expect(broadcastMock).not.toHaveBeenCalled();
  });
});

describe('registerUserQuestionResponseHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('registers the agent:user-question-response channel', () => {
    registerUserQuestionResponseHandler();
    expect(registerMock).toHaveBeenCalledWith(
      'agent:user-question-response',
      expect.any(Function),
    );
  });

  describe('Bug 2 (Phase 7): continuationContext omitted when nothing was injected', () => {
    beforeEach(() => {
      _testing_resetAnsweredBatches();
    });

    it('omits continuationContext when accumulator has no eligible messages and feature is OFF', async () => {
      // The accumulator exists but has no assistant/result messages with text,
      // so `renderAccumulatorHistory` returns ''. The default settings flag
      // is false (enablePriorTurnsHeader: false), so the prior_turns header
      // is also empty. Combined prefix is empty — the handler MUST omit
      // continuationContextHandoff so the consumer runs its own proactive
      // injection.
      registryMocks.getContextAccumulator.mockReturnValue({
        messages: [
          { role: 'user', text: 'Original prompt' },
        ],
        eventsByTurn: { [TURN_ID]: [] },
        activeTurnId: TURN_ID,
        isBusy: false,
        lastError: null,
        lastErrorSource: null,
      });

      const result = await handleUserQuestionResponse(makeRequest({ batchId: 'bug2-empty' }));
      expect(result.success).toBe(true);
      expect(result.continuationContext).toBeUndefined();
    });

    it('sets continuationContext.alreadyInjected=true when accumulator history is rendered', async () => {
      registryMocks.getContextAccumulator.mockReturnValue({
        messages: [
          { role: 'user', text: 'Original prompt' },
          { role: 'assistant', text: 'I started looking at this...' },
        ],
        eventsByTurn: { [TURN_ID]: [] },
        activeTurnId: TURN_ID,
        isBusy: false,
        lastError: null,
        lastErrorSource: null,
      });

      const result = await handleUserQuestionResponse(makeRequest({ batchId: 'bug2-history' }));
      expect(result.success).toBe(true);
      expect(result.continuationContext?.alreadyInjected).toBe(true);
      expect(result.continuationContext?.meta.historyIncluded).toBe(true);
    });

    it('omits continuationContext when accumulator is absent entirely', async () => {
      registryMocks.getContextAccumulator.mockReturnValue(undefined);
      const result = await handleUserQuestionResponse(makeRequest({ batchId: 'bug2-absent' }));
      expect(result.success).toBe(true);
      expect(result.continuationContext).toBeUndefined();
    });
  });
});

describe('PersistUserQuestionAnsweredFn brand contract (compile-time)', () => {
  // Documented compile-time regression guard for postmortem
  // 260502_persist_user_question_answered_unstamped — passing an unstamped
  // (non-`SequencedAgentEvent`) event to the persister must be a TypeScript
  // error. If this `@ts-expect-error` ever stops triggering, the brand has
  // been weakened and the variable-swap bug class is reachable again.
  it('rejects unstamped AgentEvent literals at compile time (sentinel)', () => {
    const persist = vi.fn().mockResolvedValue(undefined) as unknown as
      import('@core/services/userQuestionResponseHandler').PersistUserQuestionAnsweredFn;
    const unstamped: import('@shared/types').AgentEvent = {
      type: 'user_question_answered',
      batchId: 'sentinel',
      answers: [],
      sessionId: 'sess-sentinel',
      timestamp: 0,
    };
    // @ts-expect-error — unstamped AgentEvent is not assignable to SequencedAgentEvent.
    void persist('s', 't', unstamped);
    expect(persist).toBeDefined();
  });
});
