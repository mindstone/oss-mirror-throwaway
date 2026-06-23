import { afterEach, describe, expect, it, vi, beforeEach } from 'vitest';
import type { AgentEvent, AgentTurnMessage, AppSettings } from '@shared/types';
import { SKELETON_FALLBACK_USER_TEXT } from '@core/rebelCore/skeletonStripping';
import { setTracker, type Tracker } from '@core/tracking';

import { createDesktopRecoveryAdapter, type DesktopRecoveryAdapterDeps } from '../desktopRecoveryAdapter';
import { agentTurnRegistry } from '../../agentTurnRegistry';
import { dispatchAgentErrorEvent } from '../../agentEventDispatcher';

 
vi.mock('../../agentEventDispatcher', () => ({
  dispatchAgentEvent: vi.fn(),
  dispatchAgentErrorEvent: vi.fn(() => ({ ok: true })),
  clearAnswerPhaseStartedSentinel: vi.fn(),
}));

 
vi.mock('../../../tracking', () => ({
  getTurnAggregator: vi.fn(() => ({
    getToolLimitSuggestions: vi.fn(() => [{ toolName: 'tool/read', currentSize: 20000, suggestedLimit: 10000 }]),
  })),
}));

 
vi.mock('@core/errorReporter', () => ({
  getErrorReporter: () => ({ captureException: vi.fn(), captureMessage: vi.fn() }),
}));

 
vi.mock('@core/sentry/captureKnownCondition', () => ({
  captureKnownCondition: vi.fn(),
}));

import { captureKnownCondition } from '@core/sentry/captureKnownCondition';

const settings = (): AppSettings => ({
  models: {
    model: 'claude-sonnet-4-6',
    thinkingModel: undefined,
    permissionMode: 'bypassPermissions',
    executablePath: null,
    planMode: false,
    extendedContext: true,
    longContextFallbackModel: 'claude-opus-4-7',
    thinkingEffort: 'medium',
    apiKey: 'test',
    oauthToken: null,
    authMethod: 'api-key',
  },
  localModel: {
    activeProfileId: null,
    profiles: [{
      id: 'profile-1',
      name: 'Recovery Opus',
      serverUrl: 'https://example.test',
      model: 'claude-opus-4-7',
      contextWindow: 1_000_000,
      createdAt: 1,
    }],
  },
} as AppSettings);

const makeTurnMessage = (
  role: AgentTurnMessage['role'],
  text: string,
  content?: unknown,
): AgentTurnMessage => ({
  id: `${role}-${text || 'blocks'}`,
  turnId: 'turn-skeleton',
  role,
  text,
  createdAt: 1,
  ...(content === undefined ? {} : { content }),
} as AgentTurnMessage);

const trackerTrack = vi.fn();
const noopTracker: Tracker = {
  track: () => undefined,
  identify: () => undefined,
  getAnonymousId: () => '',
  isAvailable: () => false,
};

describe('desktopRecoveryAdapter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setTracker({
      track: trackerTrack,
      identify: vi.fn(),
      getAnonymousId: vi.fn(() => 'anon-test'),
      isAvailable: vi.fn(() => true),
    });
  });

  afterEach(() => {
    setTracker(noopTracker);
  });

  it('forwards enableRecovery=false original events to the caller listener', () => {
    const onEvent = vi.fn();
    const adapter = createDesktopRecoveryAdapter({
      win: null,
      executeAgentTurn: vi.fn(),
      getSettings: settings,
      onEvent,
    });
    const event: AgentEvent = { type: 'context_overflow', originalPrompt: 'prompt', timestamp: 1 };

    adapter.forwardOriginalEvent('turn-1', event);

    expect(onEvent).toHaveBeenCalledWith(event);
  });

  it('Stage 1 — routes a recovery-disabled throw through the funnel so the error still surfaces (no fail-open)', async () => {
    // The turn engine rejects WITHOUT having funnel-dispatched a terminal
    // error (an error escaped handleTurnError). The seam used to hand-build a
    // raw classification-blind {type:'error'} and push it through
    // forwardOriginalEvent → onEvent (the F3-class bypass). It must now route
    // through dispatchAgentErrorEvent so the error surfaces *classified*.
    const thrown = new Error('fetch failed');
    const executeAgentTurn = vi.fn<DesktopRecoveryAdapterDeps['executeAgentTurn']>(async () => {
      throw thrown;
    });
    const onEvent = vi.fn();
    const adapter = createDesktopRecoveryAdapter({
      win: null,
      executeAgentTurn,
      getSettings: settings,
      onEvent,
    });

    const outcome = await adapter.invokeAgentLoop(
      'prompt',
      { sessionId: 'session-1', metadata: { turnId: 'turn-throw' } },
      vi.fn(),
    );

    // I1 — the escaped error still surfaces, now via the classifying funnel.
    expect(dispatchAgentErrorEvent).toHaveBeenCalledTimes(1);
    expect(dispatchAgentErrorEvent).toHaveBeenCalledWith(null, 'turn-throw', thrown);
    // The recovery outcome still carries the ORIGINAL error object so the
    // pipeline's Sentry/telemetry classification is unchanged.
    expect(outcome).toEqual({ kind: 'error_non_overflow', error: thrown });
    // The seam no longer hand-builds a raw {type:'error'} for the onEvent sink;
    // surfacing is the funnel's responsibility (notifyTurnEventSubscribers/win).
    expect(onEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error' }),
    );
  });

  it('Stage 2 (Runtime-Safety F2) — the .catch funnel dispatch relays the classified error to onEvent exactly once', async () => {
    // F2 fold-in: the prior no-fail-open test mocks dispatchAgentErrorEvent as a
    // no-op, so it can only assert the ABSENCE of an onEvent error relay — which
    // is true only because the mock doesn't drive the listener. In production the
    // real funnel (dispatchAgentEventInternal → getEventListener → wrappingListener)
    // DOES relay the classified error to deps.onEvent (the automation failure
    // sink). This test drives that relay surface by assertion: the mock funnel
    // synchronously invokes the still-registered listener, exactly as the real
    // funnel does, and we assert deps.onEvent receives EXACTLY ONE classified
    // error event (proves I1 for the onEvent wrappers + I9 once-per-turn).
    const thrown = new Error('fetch failed');
    const classifiedEvent: AgentEvent = {
      type: 'error',
      error: 'The AI service had a moment.',
      errorKind: 'server_error',
      isTransient: true,
      errorSource: 'main',
      timestamp: 1,
    } as AgentEvent;

    const executeAgentTurn = vi.fn<DesktopRecoveryAdapterDeps['executeAgentTurn']>(async () => {
      throw thrown;
    });

    // Make the mocked funnel behave like the real one: when dispatched, it
    // synchronously drives the turn's registered listener with the classified
    // error event (the path that exercises wrappingListener's error relay).
    vi.mocked(dispatchAgentErrorEvent).mockImplementationOnce(((_win: unknown, turnId: string) => {
      agentTurnRegistry.getEventListener(turnId)?.(classifiedEvent);
      return { ok: true } as const;
    }) as unknown as typeof dispatchAgentErrorEvent);

    const onEvent = vi.fn();
    const adapter = createDesktopRecoveryAdapter({
      win: null,
      executeAgentTurn,
      getSettings: settings,
      onEvent,
    });

    const outcome = await adapter.invokeAgentLoop(
      'prompt',
      { sessionId: 'session-1', metadata: { turnId: 'turn-relay' } },
      vi.fn(),
    );

    // The funnel was the single emit for the escaped error...
    expect(dispatchAgentErrorEvent).toHaveBeenCalledTimes(1);
    // ...and its synchronous listener-drive relayed the CLASSIFIED event to the
    // onEvent sink (I1: the error surfaces to automation wrappers, classified).
    const errorRelays = onEvent.mock.calls.filter(
      ([e]) => (e as AgentEvent)?.type === 'error',
    );
    expect(errorRelays).toHaveLength(1);
    expect(errorRelays[0][0]).toEqual(classifiedEvent);
    // The recovery outcome still carries the ORIGINAL error object (resolved
    // BEFORE the funnel dispatch — the duplicate-resolve guard kept it).
    expect(outcome).toEqual({ kind: 'error_non_overflow', error: thrown });
  });

  it('Stage 1 — relays an in-band (already-classified) error event to the onEvent sink without re-dispatching', async () => {
    // An in-band error event arriving on the listener was already classified +
    // surfaced by the funnel; the adapter must relay it to deps.onEvent (e.g.
    // the automation failure-status sink) WITHOUT a second funnel dispatch
    // (preserves I9: recovery emits once per turn).
    const inBandError: AgentEvent = {
      type: 'error',
      error: 'classified upstream',
      errorKind: 'server_error',
      isTransient: true,
      errorSource: 'main',
      timestamp: 1,
    } as AgentEvent;
    const executeAgentTurn = vi.fn<DesktopRecoveryAdapterDeps['executeAgentTurn']>(async (_win, turnId) => {
      agentTurnRegistry.getEventListener(turnId)?.(inBandError);
    });
    const onEvent = vi.fn();
    const adapter = createDesktopRecoveryAdapter({
      win: null,
      executeAgentTurn,
      getSettings: settings,
      onEvent,
    });

    const outcome = await adapter.invokeAgentLoop(
      'prompt',
      { sessionId: 'session-1', metadata: { turnId: 'turn-inband' } },
      vi.fn(),
    );

    expect(onEvent).toHaveBeenCalledWith(inBandError);
    // No re-classification — the funnel is NOT invoked for an already-classified
    // in-band error.
    expect(dispatchAgentErrorEvent).not.toHaveBeenCalled();
    // REBEL-5BM: the in-band error's classification fields are now threaded onto
    // the outcome so the downstream known-condition capture carries them.
    expect(outcome).toEqual({
      kind: 'error_non_overflow',
      error: 'classified upstream',
      errorKind: 'server_error',
    });
  });

  it('deletes the listener immediately when context_overflow is intercepted', async () => {
    const executeAgentTurn = vi.fn<DesktopRecoveryAdapterDeps['executeAgentTurn']>(async (_win, turnId) => {
      agentTurnRegistry.getEventListener(turnId)?.({
        type: 'context_overflow',
        originalPrompt: 'prompt',
        timestamp: Date.now(),
      });
      agentTurnRegistry.getEventListener(turnId)?.({
        type: 'result',
        text: 'late result',
        timestamp: Date.now(),
      });
    });
    const adapter = createDesktopRecoveryAdapter({
      win: null,
      executeAgentTurn,
      getSettings: settings,
    });
    const deleteSpy = vi.spyOn(agentTurnRegistry, 'deleteEventListener');

    const outcome = await adapter.invokeAgentLoop(
      'prompt',
      { sessionId: 'session-1', metadata: { turnId: 'turn-race' } },
      vi.fn(),
    );

    expect(outcome.kind).toBe('overflow');
    expect(deleteSpy).toHaveBeenCalledWith('turn-race');
  });

  it('passes every AgentLoopOptions field through to executeAgentTurn', async () => {
    const executeAgentTurn = vi.fn<DesktopRecoveryAdapterDeps['executeAgentTurn']>(async (_win, turnId) => {
      agentTurnRegistry.getEventListener(turnId)?.({
        type: 'result',
        text: 'ok',
        timestamp: Date.now(),
      });
    });
    const adapter = createDesktopRecoveryAdapter({
      win: null,
      executeAgentTurn,
      getSettings: settings,
    });
    const controller = new AbortController();
    const options = {
      sessionId: 'session-1',
      resetConversation: true,
      modelOverride: 'model-a',
      thinkingModelOverride: 'thinking-a',
      workingProfileOverrideId: 'profile-a',
      thinkingProfileOverrideId: 'profile-b',
      thinkingEffortOverride: 'high' as const,
      privateMode: true,
      unleashedMode: true,
      councilMode: true,
      attachments: [],
      loadSessions: () => [],
      getMeetingCompanionContext: async () => null,
      setLastInjectedCoachPath: () => undefined,
      getFocusContext: async () => null,
      bypassToolSafety: true,
      memoryWriteHook: async () => ({}),
      mcpDenyHook: async () => ({}),
      inboundSafetyHook: async () => undefined,
      sessionType: 'automation',
      existingAbortController: controller,
      origin: 'focus',
      inputSource: 'text' as const,
      metadata: { turnId: 'turn-pass' },
    };

    await adapter.invokeAgentLoop('prompt', options, vi.fn());

    expect(executeAgentTurn.mock.calls[0][3]).toMatchObject({
      ...options,
      memoryWriteHook: options.memoryWriteHook,
      mcpDenyHook: options.mcpDenyHook,
      inboundSafetyHook: options.inboundSafetyHook,
    });
  });

  it('builds skeleton messages by stripping tool, thinking, and image blocks', () => {
    const adapter = createDesktopRecoveryAdapter({
      win: null,
      executeAgentTurn: vi.fn(),
      getSettings: settings,
    });

    const result = adapter.buildSkeletonMessages([
      makeTurnMessage('user', '', [
        { type: 'text', text: '[COMPACTION_DEPTH:1]\n=== CONTINUE WITH REQUEST ===\nactual ask' },
        { type: 'tool_result', tool_use_id: 'tool-1', content: [{ type: 'image', data: 'abc', mimeType: 'image/png' }] },
      ]),
      makeTurnMessage('assistant', '', [
        { type: 'text', text: 'assistant text' },
        { type: 'tool_use', id: 'tool-2', name: 'Read', input: {} },
        { type: 'thinking', thinking: 'private' },
        { type: 'image', data: 'inline', mimeType: 'image/png' },
      ]),
    ], { originalPrompt: 'actual ask', depth: 2 });

    expect(result.map((message) => ({ role: message.role, text: message.text }))).toEqual([
      { role: 'user', text: 'actual ask' },
      { role: 'assistant', text: 'assistant text' },
    ]);
    expect(result.every((message) => !('content' in message))).toBe(true);
  });

  it('builds a non-empty user sentinel when all user text is stripped', () => {
    const adapter = createDesktopRecoveryAdapter({
      win: null,
      executeAgentTurn: vi.fn(),
      getSettings: settings,
    });

    const result = adapter.buildSkeletonMessages([
      makeTurnMessage('user', '', [
        { type: 'tool_result', tool_use_id: 'tool-1', content: 'tool output' },
      ]),
    ], { originalPrompt: 'actual ask', depth: 2 });

    expect(result[0]).toMatchObject({
      role: 'user',
      text: SKELETON_FALLBACK_USER_TEXT,
    });
    expect(result[0].text.trim().length).toBeGreaterThan(0);
  });

  it('exposes the long-context fallback profile as the recovery profile preference', () => {
    const adapter = createDesktopRecoveryAdapter({
      win: null,
      executeAgentTurn: vi.fn(),
      getSettings: () => ({
        ...settings(),
        models: {
          ...settings().models!,
          longContextFallbackProfileId: 'profile-1',
        },
      }),
    });

    expect(adapter.getRecoveryProfilePreference()).toEqual({ profileId: 'profile-1', configuredId: 'profile-1' });
  });

  it('reports a configured-but-missing recovery profile preference for observability', () => {
    const adapter = createDesktopRecoveryAdapter({
      win: null,
      executeAgentTurn: vi.fn(),
      getSettings: () => ({
        ...settings(),
        models: {
          ...settings().models!,
          longContextFallbackProfileId: 'deleted-profile',
        },
      }),
    });

    expect(adapter.getRecoveryProfilePreference()).toEqual({
      profileId: null,
      configuredId: 'deleted-profile',
    });
  });

  it('back-fills known context windows and fails closed for unknown context windows', () => {
    const adapter = createDesktopRecoveryAdapter({
      win: null,
      executeAgentTurn: vi.fn(),
      getSettings: () => ({
        ...settings(),
        localModel: {
          activeProfileId: null,
          profiles: [
            {
              id: 'known-claude',
              name: 'Known Claude',
              serverUrl: 'https://example.test',
              model: 'claude-opus-4-7',
              createdAt: 1,
            },
            {
              id: 'unknown',
              name: 'Unknown',
              serverUrl: 'https://example.test',
              model: 'totally-unknown-model',
              createdAt: 2,
            },
          ],
        },
      }),
    });

    expect(adapter.getAvailableProfiles()).toEqual([
      expect.objectContaining({ id: 'known-claude', supportsLargeContext: true }),
      expect.objectContaining({ id: 'unknown', supportsLargeContext: false }),
    ]);
  });

  it('REBEL-5BM — reportKnownCondition threads a STRING error into extra + a real Error (instanceof Error fix)', () => {
    const adapter = createDesktopRecoveryAdapter({
      win: null,
      executeAgentTurn: vi.fn(),
      getSettings: settings,
    });

    adapter.reportKnownCondition('recovery_pipeline_agent_loop_error_after_recovery', {
      turnId: 'turn-1',
      sessionId: 'session-1',
      depth: 2,
      attempt: 1,
      phase: 'post_activity',
      exhaustedReason: 'agent_loop_error_after_recovery',
      error: 'rate limit exceeded',
      errorKind: 'rate_limit',
      provider: 'Anthropic',
      rawError: 'HTTP 429 too many requests',
    });

    expect(captureKnownCondition).toHaveBeenCalledTimes(1);
    const [condition, context, errorArg] = vi.mocked(captureKnownCondition).mock.calls[0];
    expect(condition).toBe('recovery_pipeline_agent_loop_error_after_recovery');
    expect(context).toMatchObject({
      phase: 'post_activity',
      extra: {
        turnId: 'turn-1',
        sessionId: 'session-1',
        depth: 2,
        attempt: 1,
        exhaustedReason: 'agent_loop_error_after_recovery',
        error: 'rate limit exceeded',
        errorKind: 'rate_limit',
        provider: 'Anthropic',
        rawError: 'HTTP 429 too many requests',
      },
    });
    // The string error is no longer dropped: a real Error reaches Sentry's 3rd arg.
    expect(errorArg).toBeInstanceOf(Error);
    expect((errorArg as Error).message).toBe('rate limit exceeded');
  });

  it('emits recovery telemetry counters through the shared tracker', () => {
    const adapter = createDesktopRecoveryAdapter({
      win: null,
      executeAgentTurn: vi.fn(),
      getSettings: settings,
    });

    adapter.emitTelemetryCounter('recovery_depth_4_invocation', { profileId: 'profile-1', depth: 4 });

    expect(trackerTrack).toHaveBeenCalledWith('recovery_depth_4_invocation', { profileId: 'profile-1', depth: 4 });
  });
});
