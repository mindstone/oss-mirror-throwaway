import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentTurnMessage } from '@shared/types';

const loggerMock = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

 
vi.mock('@core/logger', () => ({
  createScopedLogger: vi.fn(() => loggerMock),
}));

import { runRecoveryPipeline } from '../recoveryPipeline';
import type { RecoveryContext } from '../recoveryStateMachine';
import { createStubRecoveryAdapter, makeMessage } from './fixtures/stubAdapter';
import type { AgentLoopOptions } from '../recoveryAdapter';

const ctx = (overrides: Partial<RecoveryContext> = {}): RecoveryContext => ({
  phase: 'post_activity',
  depth: 0,
  attempt: 0,
  longContextFallbackAttempted: false,
  skeletonAttempted: false,
  isRecoveryModelAttempt: false,
  enableRecovery: true,
  sessionId: 'session-1',
  turnId: 'turn-1',
  originalSessionId: 'session-1',
  originalPrompt: 'Do the work',
  abortSignal: new AbortController().signal,
  messages: [makeMessage('user', 'Do the work')],
  ...overrides,
});

const run = (adapter: ReturnType<typeof createStubRecoveryAdapter>, context = ctx(), revealDurationMs = 0) =>
  runRecoveryPipeline({
    phase: context.phase,
    prompt: context.originalPrompt,
    agentLoopOptions: { sessionId: context.sessionId },
    enableRecovery: context.enableRecovery,
    ctx: context,
    adapter,
    abortSignal: context.abortSignal,
    revealDurationMs,
  });

const eventTypes = (adapter: ReturnType<typeof createStubRecoveryAdapter>): string[] =>
  adapter.dispatchedEvents.map((event) => event.type);

const makeBlockMessage = (
  role: AgentTurnMessage['role'],
  content: unknown,
): AgentTurnMessage => ({
  id: `${role}-blocks`,
  turnId: 'turn-test',
  role,
  text: '',
  createdAt: 1,
  content,
} as AgentTurnMessage);

describe('recoveryPipeline fault injection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('F1 treats invokeAgentLoop exceptions after recovery starts as dispatched terminal recovery failure', async () => {
    const adapter = createStubRecoveryAdapter();
    adapter.invokeAgentLoop = vi.fn()
      .mockResolvedValueOnce({ kind: 'overflow', messages: [makeMessage('user', 'task')] })
      .mockResolvedValueOnce({ kind: 'error_non_overflow', error: new Error('boom') });

    const outcome = await run(adapter);

    // REBEL-5BM: a post-recovery agent-loop error is now `agent_loop_error_after_recovery`.
    expect(outcome).toMatchObject({ kind: 'failure_terminal', exhaustedReason: 'agent_loop_error_after_recovery' });
    expect(eventTypes(adapter)).toContain('recovery:failed');
    expect(adapter.dispatchedEvents.find((event) => event.type === 'recovery:failed')).toMatchObject({
      exhaustedReason: 'agent_loop_error_after_recovery',
    });
  });

  it('F2 falls back to legacy summary when intelligent summary rejects', async () => {
    const adapter = createStubRecoveryAdapter({
      intelligentSummary: new Error('bts failed'),
      legacySummary: 'legacy survived',
      outcomes: [
        { kind: 'overflow', messages: [makeMessage('user', 'task')] },
        { kind: 'success', result: 'ok' },
      ],
    });

    const outcome = await run(adapter);

    expect(outcome.kind).toBe('success');
    expect(adapter.calls.map((call) => call.name)).toContain('generateLegacyCompactionSummary');
  });

  it('F3 routes to skeleton when both summary methods fail', async () => {
    const adapter = createStubRecoveryAdapter({
      intelligentSummary: new Error('bts failed'),
      legacySummary: null,
      outcomes: [
        { kind: 'overflow', messages: [makeMessage('user', 'task')] },
        { kind: 'success', result: 'ok' },
      ],
    });

    const outcome = await run(adapter);

    expect(outcome.kind).toBe('success');
    expect(adapter.calls.map((call) => call.name)).toContain('buildSkeletonMessages');
    expect(eventTypes(adapter)).toContain('recovery:skeleton_attempting');
  });

  it('F3b passes stripped skeleton messages to the retry invoke', async () => {
    const overflowMessages = [
      makeBlockMessage('user', [
        { type: 'text', text: '[COMPACTION_DEPTH:2]\n=== CONTINUE WITH REQUEST ===\nactual ask' },
        { type: 'tool_result', tool_use_id: 'tool-1', content: [{ type: 'image', data: 'abc', mimeType: 'image/png' }] },
      ]),
      makeBlockMessage('assistant', [
        { type: 'text', text: 'assistant text' },
        { type: 'tool_use', id: 'tool-2', name: 'Read', input: {} },
        { type: 'thinking', thinking: 'private' },
        { type: 'image', data: 'inline', mimeType: 'image/png' },
      ]),
    ];
    const adapter = createStubRecoveryAdapter({
      intelligentSummary: new Error('bts failed'),
      legacySummary: null,
      outcomes: [
        { kind: 'overflow', messages: overflowMessages },
        { kind: 'success', result: 'ok' },
      ],
    });

    const outcome = await run(adapter);

    expect(outcome.kind).toBe('success');
    const secondInvokeOptions = adapter.calls
      .filter((call) => call.name === 'invokeAgentLoop')[1]
      .args[1] as AgentLoopOptions;
    expect(secondInvokeOptions.recoveryMessages?.map((message) => ({
      role: message.role,
      text: message.text,
      hasContent: 'content' in message,
    }))).toEqual([
      { role: 'user', text: 'actual ask', hasContent: false },
      { role: 'assistant', text: 'assistant text', hasContent: false },
    ]);
  });

  it('F3c treats empty skeleton output as summary_generation_failed without retrying', async () => {
    const adapter = createStubRecoveryAdapter({
      intelligentSummary: new Error('bts failed'),
      legacySummary: null,
      skeletonMessages: [],
      outcomes: [
        { kind: 'overflow', messages: [makeMessage('user', 'task')] },
        { kind: 'success', result: 'should not run' },
      ],
    });

    const outcome = await run(adapter);

    expect(outcome).toMatchObject({
      kind: 'failure_terminal',
      exhaustedReason: 'summary_generation_failed',
    });
    expect(eventTypes(adapter)).toContain('recovery:failed');
    expect(adapter.calls.filter((call) => call.name === 'invokeAgentLoop')).toHaveLength(1);
  });

  it('F4 abort during reveal sleep emits no retry and starts no second invoke', async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const adapter = createStubRecoveryAdapter({
        outcomes: [
          { kind: 'overflow', messages: [makeMessage('user', 'task')] },
          { kind: 'success', result: 'ok' },
        ],
      });

      const promise = run(adapter, ctx({ abortSignal: controller.signal }), 3000);
      await vi.waitFor(() => {
        expect(eventTypes(adapter)).toContain('recovery:summary_ready');
      });
      controller.abort();
      await vi.runAllTimersAsync();

      const outcome = await promise;
      expect(outcome.exhaustedReason).toBe('aborted');
      expect(eventTypes(adapter)).not.toContain('recovery:retrying');
      expect(adapter.calls.filter((call) => call.name === 'invokeAgentLoop')).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('F5 abort after summary generation resolves terminates before retry dispatch', async () => {
    const controller = new AbortController();
    const adapter = createStubRecoveryAdapter({
      outcomes: [{ kind: 'overflow', messages: [makeMessage('user', 'task')] }],
    });
    adapter.generateIntelligentSummary = vi.fn(async () => {
      controller.abort();
      return { olderSummary: 'summary', recentMessages: [] };
    });

    const outcome = await run(adapter, ctx({ abortSignal: controller.signal }));

    expect(outcome.exhaustedReason).toBe('aborted');
    expect(eventTypes(adapter)).not.toContain('recovery:retrying');
  });

  it('F6 safe-dispatch keeps recovery alive when broadcaster throws', async () => {
    const adapter = createStubRecoveryAdapter({
      dispatchThrows: true,
      outcomes: [
        { kind: 'overflow', messages: [makeMessage('user', 'task')] },
        { kind: 'success', result: 'ok' },
      ],
    });

    const outcome = await run(adapter);

    expect(outcome.kind).toBe('success');
  });

  it('F7 documents no persisted recovery state between non-terminal and terminal events', async () => {
    const adapter = createStubRecoveryAdapter({
      outcomes: [
        { kind: 'overflow', messages: [makeMessage('user', 'task')] },
        { kind: 'success', result: 'ok' },
      ],
    });

    await run(adapter);

    expect(adapter.calls.map((call) => call.name)).not.toContain('persistRecoveryState');
  });

  it('F8 enableRecovery=false forwards the original context_overflow and emits no recovery events', async () => {
    const adapter = createStubRecoveryAdapter({
      outcomes: [{ kind: 'overflow', originalPrompt: 'memory update prompt', messages: [makeMessage('user', 'memory')] }],
    });

    const outcome = await run(adapter, ctx({ enableRecovery: false }));

    expect(outcome.exhaustedReason).toBe('recovery_disabled');
    expect(adapter.dispatchedEvents).toHaveLength(0);
    expect(adapter.calls.filter((call) => call.name === 'forwardOriginalEvent')).toHaveLength(1);
  });

  it('logs when a configured recovery profile is missing before auto-picking another profile', async () => {
    const adapter = createStubRecoveryAdapter({
      outcomes: [
        { kind: 'overflow', messages: [makeMessage('user', 'task')] },
        { kind: 'success', result: 'ok' },
      ],
      fallbackTarget: null,
      recoveryProfilePreference: { configuredId: 'deleted-profile', profileId: null },
      profiles: [
        {
          id: 'auto-profile',
          name: 'Auto profile',
          model: 'claude-opus-4-7',
          supportsLargeContext: true,
        },
      ],
    });

    const outcome = await run(adapter, ctx({
      phase: 'pre_activity',
      longContextFallbackAttempted: true,
      skeletonAttempted: true,
    }));

    expect(outcome.kind).toBe('success');
    expect(loggerMock.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        configuredProfileId: 'deleted-profile',
        selectedProfileId: 'auto-profile',
      }),
      'Configured recovery profile is unavailable; auto-picked recovery profile',
    );
  });
});
