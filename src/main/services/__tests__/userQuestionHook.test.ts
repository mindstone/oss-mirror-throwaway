import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockSendToAllWindows = vi.fn();
vi.mock('@core/broadcastService', () => ({
  getBroadcastService: () => ({ sendToAllWindows: mockSendToAllWindows, sendToFocusedWindow: vi.fn() }),
}));

import { createUserQuestionHook } from '../userQuestionHook';
import { agentTurnRegistry } from '@core/services/agentTurnRegistry';
import type { SyncHookJSONOutput } from '@core/agentRuntimeTypes';

function makePreToolUseInput(toolName: string, toolInput: unknown): any {
  return {
    hook_event_name: 'PreToolUse' as const,
    tool_name: toolName,
    tool_input: toolInput,
    tool_use_id: 'tool-use-123',
  };
}

function makeValidQuestionInput() {
  return {
    questions: [
      {
        question: 'What format do you prefer?',
        header: 'Format',
        options: [
          { label: 'Bullet points', description: 'Quick, scannable overview' },
          { label: 'Paragraphs', description: 'Thorough, narrative format' },
        ],
        multiSelect: false,
      },
    ],
  };
}

function makeFreeTextQuestionInput() {
  return {
    questions: [
      {
        question: 'Paste the value you want me to use.',
        header: 'Paste value',
        options: [],
        multiSelect: false,
      },
    ],
  };
}

function makeApprovalClarificationWithoutPurposeInput() {
  return {
    questions: [
      {
        question: 'What should I send Jane?',
        header: 'Note',
        context:
          'I need the exact note content before drafting it. Choosing a channel or providing text here is not approval to send — I’ll show the draft before any send.',
        options: [
          {
            label: 'Type note',
            description: 'Paste or type the message you want Jane to receive.',
            requiresInput: true,
            inputPlaceholder: 'Write the note to Jane here…',
          },
          {
            label: 'Slack DM',
            description: 'Send by Slack DM after draft approval.',
            requiresInput: true,
            inputPlaceholder: 'What should the Slack message say?',
          },
        ],
        multiSelect: false,
      },
    ],
  };
}

function makeChatApprovalQuestionInput() {
  return {
    questions: [
      {
        question: 'Send this Slack DM to Jane?',
        header: 'Approve',
        context: 'Recipient resolved as Jane Smith. Message: “doing a test”.',
        options: [
          { label: 'Send', description: 'Send exactly: “doing a test”' },
          {
            label: 'Edit',
            description: 'Change the message before sending',
            requiresInput: true,
            inputPlaceholder: 'Type the revised Slack DM here',
          },
          { label: 'Cancel', description: 'Do not send anything' },
        ],
        multiSelect: false,
      },
    ],
  };
}

function makeMixedChatApprovalQuestionInput() {
  return {
    questions: [
      {
        question: 'Which tone should I use?',
        header: 'Tone',
        options: [
          { label: 'Brief', description: 'Keep it concise.' },
          { label: 'Warm', description: 'Make it friendlier.' },
        ],
        multiSelect: false,
      },
      makeChatApprovalQuestionInput().questions[0],
    ],
  };
}

describe('userQuestionHook', () => {
  beforeEach(() => {
    mockSendToAllWindows.mockClear();
  });

  it('ignores non-AskUserQuestion tools', async () => {
    const hook = createUserQuestionHook('session-1', 'turn-1');
    const result = await hook(
      makePreToolUseInput('FileRead', { path: '/tmp/test.txt' }),
      'tool-use-123',
      { signal: new AbortController().signal },
    );
    expect(result).toEqual({});
    expect(mockSendToAllWindows).not.toHaveBeenCalled();
  });

  it('intercepts AskUserQuestion and returns deny', async () => {
    const hook = createUserQuestionHook('session-1', 'turn-1');
    const input = makePreToolUseInput('AskUserQuestion', makeValidQuestionInput());

    const result = await hook(input, 'tool-use-123', { signal: new AbortController().signal });

    // Should deny and stop the turn
    expect(result).toHaveProperty('continue', false);
    expect(result).toHaveProperty('hookSpecificOutput');
    const hookOutput = (result as Record<string, unknown>).hookSpecificOutput as Record<string, unknown>;
    expect(hookOutput.hookEventName).toBe('PreToolUse');
    expect(hookOutput.permissionDecision).toBe('deny');
  });

  it('dispatches user_question event via broadcast', async () => {
    const hook = createUserQuestionHook('session-1', 'turn-1');
    const input = makePreToolUseInput('AskUserQuestion', makeValidQuestionInput());

    await hook(input, 'tool-use-123', { signal: new AbortController().signal });

    expect(mockSendToAllWindows).toHaveBeenCalledTimes(1);
    const [channel, payload] = mockSendToAllWindows.mock.calls[0];
    expect(channel).toBe('agent:event');
    expect(payload.turnId).toBe('turn-1');
    expect(payload.sessionId).toBe('session-1');
    expect(payload.event.type).toBe('user_question');
    expect(payload.event.questions).toHaveLength(1);
    expect(payload.event.questions[0].question).toBe('What format do you prefer?');
  });

  it('generates stable option IDs from indices in the event payload', async () => {
    const hook = createUserQuestionHook('session-1', 'turn-1');
    const input = makePreToolUseInput('AskUserQuestion', makeValidQuestionInput());

    await hook(input, 'tool-use-123', { signal: new AbortController().signal });

    const payload = mockSendToAllWindows.mock.calls[0][1];
    const options = payload.event.questions[0].options;
    expect(options[0].id).toBe('q0-opt0');
    expect(options[1].id).toBe('q0-opt1');
  });

  it('infers approval clarification purpose for pre-send clarification questions', async () => {
    const hook = createUserQuestionHook('session-clarification', 'turn-clarification');
    const input = makePreToolUseInput(
      'AskUserQuestion',
      makeApprovalClarificationWithoutPurposeInput(),
    );

    await hook(input, 'tool-use-clarification', { signal: new AbortController().signal });

    const payload = mockSendToAllWindows.mock.calls[0][1];
    expect(payload.event.questions[0].purpose).toBe('approval_clarification');
  });

  it('does not infer approval clarification purpose for generic questions', async () => {
    const hook = createUserQuestionHook('session-generic', 'turn-generic');
    const input = makePreToolUseInput('AskUserQuestion', makeValidQuestionInput());

    await hook(input, 'tool-use-generic', { signal: new AbortController().signal });

    const payload = mockSendToAllWindows.mock.calls[0][1];
    expect(payload.event.questions[0].purpose).toBeUndefined();
  });

  it('blocks chat-approval AskUserQuestion payloads before they reach the footer UI', async () => {
    const hook = createUserQuestionHook('session-approval', 'turn-approval');
    const input = makePreToolUseInput('AskUserQuestion', makeChatApprovalQuestionInput());

    const result = (await hook(input, 'tool-use-approval', { signal: new AbortController().signal })) as SyncHookJSONOutput;

    expect(mockSendToAllWindows).not.toHaveBeenCalled();
    expect(result.hookSpecificOutput?.permissionDecision).toBe('deny');
    expect(result.hookSpecificOutput?.permissionDecisionReason).toContain('normal action tool');
  });

  it('blocks mixed AskUserQuestion batches when any question is approval-like', async () => {
    const hook = createUserQuestionHook('session-mixed-approval', 'turn-mixed-approval');
    const input = makePreToolUseInput('AskUserQuestion', makeMixedChatApprovalQuestionInput());

    const result = (await hook(input, 'tool-use-mixed-approval', { signal: new AbortController().signal })) as SyncHookJSONOutput;

    expect(mockSendToAllWindows).not.toHaveBeenCalled();
    expect(result.hookSpecificOutput?.permissionDecision).toBe('deny');
    expect(result.hookSpecificOutput?.permissionDecisionReason).toContain('normal action tool');
  });

  it('passes through when payload is invalid', async () => {
    const hook = createUserQuestionHook('session-1', 'turn-1');
    const input = makePreToolUseInput('AskUserQuestion', { questions: [] });

    const result = await hook(input, 'tool-use-123', { signal: new AbortController().signal });

    expect(result).toEqual({});
    expect(mockSendToAllWindows).not.toHaveBeenCalled();
  });

  it('passes through when payload is null', async () => {
    const hook = createUserQuestionHook('session-1', 'turn-1');
    const input = makePreToolUseInput('AskUserQuestion', null);

    const result = await hook(input, 'tool-use-123', { signal: new AbortController().signal });

    expect(result).toEqual({});
  });

  it('handles multiple questions in a batch', async () => {
    const hook = createUserQuestionHook('session-1', 'turn-1');
    const input = makePreToolUseInput('AskUserQuestion', {
      questions: [
        {
          question: 'Q1?',
          header: 'Q1',
          options: [
            { label: 'A', description: 'Option A' },
            { label: 'B', description: 'Option B' },
          ],
          multiSelect: false,
        },
        {
          question: 'Q2?',
          header: 'Q2',
          options: [
            { label: 'X', description: 'Option X' },
            { label: 'Y', description: 'Option Y' },
            { label: 'Z', description: 'Option Z' },
          ],
          multiSelect: true,
        },
      ],
    });

    await hook(input, 'tool-use-456', { signal: new AbortController().signal });

    const payload = mockSendToAllWindows.mock.calls[0][1];
    const questions = payload.event.questions;
    expect(questions).toHaveLength(2);
    expect(questions[0].id).toBe('q0');
    expect(questions[1].id).toBe('q1');
    expect(questions[1].multiSelect).toBe(true);
    expect(questions[1].options).toHaveLength(3);
  });

  it('accepts free-text-only questions with no options', async () => {
    const hook = createUserQuestionHook('session-1', 'turn-1');
    const input = makePreToolUseInput('AskUserQuestion', makeFreeTextQuestionInput());

    const result = await hook(input, 'tool-use-free-text', { signal: new AbortController().signal });

    expect(result).toHaveProperty('continue', false);
    expect(mockSendToAllWindows).toHaveBeenCalledTimes(1);
    const payload = mockSendToAllWindows.mock.calls[0][1];
    expect(payload.event.type).toBe('user_question');
    expect(payload.event.questions[0].question).toBe('Paste the value you want me to use.');
    expect(payload.event.questions[0].options).toEqual([]);
  });

  it('falls back to batchId when toolUseId is undefined', async () => {
    const hook = createUserQuestionHook('session-1', 'turn-1');
    const input = makePreToolUseInput('AskUserQuestion', makeValidQuestionInput());

    await hook(input, undefined, { signal: new AbortController().signal });

    const payload = mockSendToAllWindows.mock.calls[0][1];
    expect(payload.event.toolUseId).toBe(payload.event.batchId);
  });

  // Regression coverage for docs-private/investigations/260424_user_question_cross_session_routing_leak.md.
  // The emitted user_question event must carry the authoritative origin
  // sessionId so downstream consumers (server-side validation in
  // userQuestionResponseHandler, extractQuestionBatches in cloud-client)
  // can defend against stale-snapshot / session-switch races.
  it('emitted user_question event carries the origin sessionId', async () => {
    const hook = createUserQuestionHook('session-origin', 'turn-origin');
    const input = makePreToolUseInput('AskUserQuestion', makeValidQuestionInput());

    await hook(input, 'tool-use-origin', { signal: new AbortController().signal });

    expect(mockSendToAllWindows).toHaveBeenCalledTimes(1);
    const payload = mockSendToAllWindows.mock.calls[0][1];
    expect(payload.event.type).toBe('user_question');
    expect(payload.event.sessionId).toBe('session-origin');
    // The envelope's sessionId matches the event's — they must agree.
    expect(payload.sessionId).toBe('session-origin');
  });

  // I14: every agent:event broadcast must carry a positive integer seq.
  // The hook calls `accumulator.appendEvent` to stamp the event and then
  // asserts via `assertEventHasSeq` before broadcasting (matches the
  // automation/dispatcher pattern). This pins down test-side coverage
  // so a regression that drops seq stamping at this site fails visibly.
  it('broadcast user_question event carries a positive integer seq (I14)', async () => {
    const hook = createUserQuestionHook('session-seq', 'turn-seq');
    const input = makePreToolUseInput('AskUserQuestion', makeValidQuestionInput());

    await hook(input, 'tool-use-seq', { signal: new AbortController().signal });

    expect(mockSendToAllWindows).toHaveBeenCalledTimes(1);
    const payload = mockSendToAllWindows.mock.calls[0][1];
    expect(Number.isInteger(payload.event.seq) && payload.event.seq > 0).toBe(true);
  });

  // REBEL-1GE: user_question event must be appended to the turn accumulator
  // so downstream consumers (empty-result anomaly classification in
  // agentMessageHandler.ts) can detect the pause via eventsByTurn and
  // classify as `user_question` rather than `ambiguous`.
  it('appends user_question event to turn accumulator (REBEL-1GE)', async () => {
    const turnId = 'turn-accumulator-test';
    const hook = createUserQuestionHook('session-1', turnId);
    const input = makePreToolUseInput('AskUserQuestion', makeValidQuestionInput());

    await hook(input, 'tool-use-xyz', { signal: new AbortController().signal });

    const accumulator = agentTurnRegistry.getOrCreateAccumulator(turnId);
    const events = accumulator.getConversationShape().eventsByTurn[turnId] ?? [];
    const userQuestionEvent = events.find((e) => e.type === 'user_question');
    expect(userQuestionEvent).toBeDefined();
    expect(userQuestionEvent).toMatchObject({
      type: 'user_question',
      questions: expect.any(Array),
    });
  });

  it('records dedicated user_question provenance for response validation', async () => {
    const turnId = 'turn-provenance-test';
    const hook = createUserQuestionHook('session-provenance', turnId);
    const input = makePreToolUseInput('AskUserQuestion', makeValidQuestionInput());

    await hook(input, 'tool-use-provenance', { signal: new AbortController().signal });

    const payload = mockSendToAllWindows.mock.calls[0][1];
    const stored = agentTurnRegistry.getUserQuestionProvenance(
      turnId,
      payload.event.batchId,
    );
    expect(stored).toMatchObject({
      type: 'user_question',
      batchId: payload.event.batchId,
      sessionId: 'session-provenance',
      questions: expect.any(Array),
    });
    expect(stored).toEqual(payload.event);
    expect(Number.isInteger(stored?.seq) && Number(stored?.seq) > 0).toBe(true);

    agentTurnRegistry.cleanupTurn(turnId);
  });

  it('marks the user question pending before broadcasting to renderer windows', async () => {
    const turnId = 'turn-order-test';
    const markPendingSpy = vi.spyOn(agentTurnRegistry, 'markUserQuestionPending');
    const hook = createUserQuestionHook('session-order', turnId);
    const input = makePreToolUseInput('AskUserQuestion', makeValidQuestionInput());

    await hook(input, 'tool-use-order', { signal: new AbortController().signal });

    expect(markPendingSpy).toHaveBeenCalledWith(turnId);
    expect(mockSendToAllWindows).toHaveBeenCalledWith(
      'agent:event',
      expect.objectContaining({ turnId, sessionId: 'session-order' }),
    );
    expect(markPendingSpy.mock.invocationCallOrder[0]).toBeLessThan(
      mockSendToAllWindows.mock.invocationCallOrder[0],
    );

    markPendingSpy.mockRestore();
    agentTurnRegistry.cleanupTurn(turnId);
  });
});
