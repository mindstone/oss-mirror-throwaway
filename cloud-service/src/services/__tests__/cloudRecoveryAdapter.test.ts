import { afterEach, describe, expect, it, vi, beforeEach } from 'vitest';
import type { AgentEvent, AgentTurnMessage, AppSettings } from '@shared/types';
import { agentTurnRegistry } from '@core/services/agentTurnRegistry';
import { SKELETON_FALLBACK_USER_TEXT } from '@core/rebelCore/skeletonStripping';
import { setTracker, type Tracker } from '@core/tracking';
import { dispatchAgentErrorEvent } from '@core/services/agentEventDispatcher';

import { createCloudRecoveryAdapter, type CloudRecoveryAdapterDeps } from '../cloudRecoveryAdapter';

vi.mock('@core/services/agentEventDispatcher', () => ({
  dispatchAgentEvent: vi.fn(),
  dispatchAgentErrorEvent: vi.fn(() => ({ ok: true })),
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

describe('cloudRecoveryAdapter', () => {
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
    const adapter = createCloudRecoveryAdapter({
      win: null,
      executeAgentTurn: vi.fn(),
      getSettings: settings,
      onEvent,
    });
    const event: AgentEvent = { type: 'context_overflow', originalPrompt: 'prompt', timestamp: 1 };

    adapter.forwardOriginalEvent('turn-1', event);

    expect(onEvent).toHaveBeenCalledWith(event);
  });

  it('returns empty toolSuggestions on overflow (cloud has no per-turn tracking)', async () => {
    const executeAgentTurn = vi.fn<CloudRecoveryAdapterDeps['executeAgentTurn']>(async (_win, turnId) => {
      agentTurnRegistry.getEventListener(turnId)?.({
        type: 'context_overflow',
        originalPrompt: 'prompt',
        timestamp: Date.now(),
      });
    });
    const adapter = createCloudRecoveryAdapter({
      win: null,
      executeAgentTurn,
      getSettings: settings,
    });

    const outcome = await adapter.invokeAgentLoop(
      'prompt',
      { sessionId: 'session-1', metadata: { turnId: 'turn-cloud' } },
      vi.fn(),
    );

    expect(outcome.kind).toBe('overflow');
    if (outcome.kind === 'overflow') {
      expect(outcome.toolSuggestions).toEqual([]);
    }
  });

  it('Stage 4 (I1) — routes a recovery-disabled throw through the funnel so the error still surfaces (no fail-open)', async () => {
    // Cloud mirror of the desktop Stage 1 no-fail-open case. executeAgentTurn
    // rejects WITHOUT the funnel having dispatched a terminal error (an error
    // escaped handleTurnError). The cloud .catch (cloudRecoveryAdapter.ts:207)
    // must NOT hand-build a raw classification-blind {type:'error'}; it must
    // route the escaped error through dispatchAgentErrorEvent so it surfaces
    // *classified* to the cloud broadcaster + subscribers.
    const thrown = new Error('fetch failed');
    const executeAgentTurn = vi.fn<CloudRecoveryAdapterDeps['executeAgentTurn']>(async () => {
      throw thrown;
    });
    const onEvent = vi.fn();
    const adapter = createCloudRecoveryAdapter({
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

    // I1 — the escaped error still surfaces, now via the classifying funnel,
    // carrying the ORIGINAL error object (win is null on cloud turns).
    expect(dispatchAgentErrorEvent).toHaveBeenCalledTimes(1);
    expect(dispatchAgentErrorEvent).toHaveBeenCalledWith(null, 'turn-throw', thrown);
    // The recovery outcome carries the ORIGINAL error object so the pipeline's
    // Sentry/telemetry classification is unchanged.
    expect(outcome).toEqual({ kind: 'error_non_overflow', error: thrown });
    // The seam no longer hand-builds a raw {type:'error'} for the onEvent sink;
    // surfacing is the funnel's responsibility.
    expect(onEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error' }),
    );
  });

  it('Stage 4 (I9) — the .catch funnel dispatch relays the classified error to onEvent exactly once', async () => {
    // Cloud mirror of the desktop Stage 2 (Runtime-Safety F2) real-funnel-relay
    // case. The funnel mock synchronously drives the still-registered
    // wrappingListener with the classified error, exactly as the real funnel
    // does (dispatchAgentEventInternal → getEventListener → wrappingListener).
    // The listener's error branch relays the classified event to deps.onEvent
    // (the cloud subscriber/SSE accumulator sink) — and the .catch's `resolved`
    // guard prevents a duplicate resolve. Asserts exactly ONE error reaches
    // deps.onEvent (I1 surfacing + I9 once-per-turn).
    const thrown = new Error('fetch failed');
    const classifiedEvent: AgentEvent = {
      type: 'error',
      error: 'The AI service had a moment.',
      errorKind: 'server_error',
      isTransient: true,
      errorSource: 'main',
      timestamp: 1,
    } as AgentEvent;

    const executeAgentTurn = vi.fn<CloudRecoveryAdapterDeps['executeAgentTurn']>(async () => {
      throw thrown;
    });

    // Make the mocked funnel behave like the real one: when dispatched, drive
    // the turn's registered listener with the classified error event.
    vi.mocked(dispatchAgentErrorEvent).mockImplementationOnce(((_win: unknown, turnId: string) => {
      agentTurnRegistry.getEventListener(turnId)?.(classifiedEvent);
      return { ok: true } as const;
    }) as unknown as typeof dispatchAgentErrorEvent);

    const onEvent = vi.fn();
    const adapter = createCloudRecoveryAdapter({
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
    // deps.onEvent sink exactly once (I1: surfaces to cloud subscribers; I9: no
    // double-emit — the `resolved` guard short-circuits the duplicate resolve).
    const errorRelays = onEvent.mock.calls.filter(
      ([e]) => (e as AgentEvent)?.type === 'error',
    );
    expect(errorRelays).toHaveLength(1);
    expect(errorRelays[0][0]).toEqual(classifiedEvent);
    // The recovery outcome still carries the ORIGINAL error object (resolved
    // BEFORE the funnel dispatch — the duplicate-resolve guard kept it).
    expect(outcome).toEqual({ kind: 'error_non_overflow', error: thrown });
  });

  it('Stage 4 (in-band relay) — relays an already-classified error event to onEvent without re-dispatching', async () => {
    // Cloud mirror of the desktop Stage 1 in-band relay case. An in-band error
    // event arriving on the listener was already classified + surfaced by the
    // funnel (notifyTurnEventSubscribers / cloud broadcaster); the cloud adapter
    // relays it straight to deps.onEvent (cloudRecoveryAdapter.ts:184) WITHOUT a
    // second funnel dispatch (preserves I9: recovery emits once per turn).
    const inBandError: AgentEvent = {
      type: 'error',
      error: 'classified upstream',
      errorKind: 'server_error',
      isTransient: true,
      errorSource: 'main',
      timestamp: 1,
    } as AgentEvent;
    const executeAgentTurn = vi.fn<CloudRecoveryAdapterDeps['executeAgentTurn']>(async (_win, turnId) => {
      agentTurnRegistry.getEventListener(turnId)?.(inBandError);
    });
    const onEvent = vi.fn();
    const adapter = createCloudRecoveryAdapter({
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

    // The classified in-band error relays to the deps.onEvent sink...
    expect(onEvent).toHaveBeenCalledWith(inBandError);
    // ...with NO re-classification — the funnel is NOT invoked for an
    // already-classified in-band error (I9).
    expect(dispatchAgentErrorEvent).not.toHaveBeenCalled();
    // REBEL-5BM: the in-band error's classification fields are now threaded onto
    // the outcome so the downstream known-condition capture carries them.
    expect(outcome).toEqual({
      kind: 'error_non_overflow',
      error: 'classified upstream',
      errorKind: 'server_error',
    });
  });

  it('REBEL-5BM — reportKnownCondition threads a STRING error into extra + a real Error (parity with desktop)', () => {
    const adapter = createCloudRecoveryAdapter({
      win: null,
      executeAgentTurn: vi.fn(),
      getSettings: settings,
    });

    adapter.reportKnownCondition('recovery_pipeline_agent_loop_error_after_recovery', {
      turnId: 'turn-1',
      sessionId: 'session-1',
      depth: 2,
      attempt: 1,
      phase: 'pre_activity',
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
      phase: 'pre_activity',
      tags: { component: 'recovery_pipeline', surface: 'cloud', phase: 'pre_activity' },
      extra: {
        error: 'rate limit exceeded',
        errorKind: 'rate_limit',
        provider: 'Anthropic',
        rawError: 'HTTP 429 too many requests',
      },
    });
    expect(errorArg).toBeInstanceOf(Error);
    expect((errorArg as Error).message).toBe('rate limit exceeded');
  });

  it('resolves long-context fallback target from configured profile', () => {
    const adapter = createCloudRecoveryAdapter({
      win: null,
      executeAgentTurn: vi.fn(),
      getSettings: () => ({
        ...settings(),
        models: {
          ...settings().models,
          longContextFallbackProfileId: 'profile-1',
        } as AppSettings['models'],
      }),
    });

    expect(adapter.resolveLongContextFallbackTarget()).toMatchObject({
      kind: 'profile',
      profileId: 'profile-1',
      modelName: 'claude-opus-4-7',
    });
  });

  it('builds skeleton messages by stripping tool, thinking, and image blocks', () => {
    const adapter = createCloudRecoveryAdapter({
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
        { type: 'redacted_thinking', data: 'private' },
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
    const adapter = createCloudRecoveryAdapter({
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
    const adapter = createCloudRecoveryAdapter({
      win: null,
      executeAgentTurn: vi.fn(),
      getSettings: () => ({
        ...settings(),
        models: {
          ...settings().models,
          longContextFallbackProfileId: 'profile-1',
        } as AppSettings['models'],
      }),
    });

    expect(adapter.getRecoveryProfilePreference()).toEqual({ profileId: 'profile-1', configuredId: 'profile-1' });
  });

  it('reports a configured-but-missing recovery profile preference for observability', () => {
    const adapter = createCloudRecoveryAdapter({
      win: null,
      executeAgentTurn: vi.fn(),
      getSettings: () => ({
        ...settings(),
        models: {
          ...settings().models,
          longContextFallbackProfileId: 'deleted-profile',
        } as AppSettings['models'],
      }),
    });

    expect(adapter.getRecoveryProfilePreference()).toEqual({
      profileId: null,
      configuredId: 'deleted-profile',
    });
  });

  it('back-fills known context windows and fails closed for unknown context windows', () => {
    const adapter = createCloudRecoveryAdapter({
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

  it('emits recovery telemetry counters through the shared tracker', () => {
    const adapter = createCloudRecoveryAdapter({
      win: null,
      executeAgentTurn: vi.fn(),
      getSettings: settings,
    });

    adapter.emitTelemetryCounter('recovery_depth_4_invocation', { profileId: 'profile-1', depth: 4 });

    expect(trackerTrack).toHaveBeenCalledWith('recovery_depth_4_invocation', { profileId: 'profile-1', depth: 4 });
  });
});
