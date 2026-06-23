import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageTimeoutError } from '@core/utils/timeoutAsyncIterator';
import { ConnectionNotConfiguredError, UnsupportedModelError } from '@shared/utils/connectionCredentials';
import type {
  RuntimePhaseAccumulator,
  TurnCompletionBaseContext,
} from '../turnPipeline/types';

const {
  dispatchErrorRecoveryMock,
  dispatchAgentErrorEventMock,
  completeTurnCleanupMock,
  captureExceptionMock,
} = vi.hoisted(() => ({
  dispatchErrorRecoveryMock: vi.fn(),
  dispatchAgentErrorEventMock: vi.fn(),
  completeTurnCleanupMock: vi.fn(),
  captureExceptionMock: vi.fn(),
}));

vi.mock('../turnErrorRecovery', () => ({
  dispatchErrorRecovery: dispatchErrorRecoveryMock,
}));

vi.mock('../agentEventDispatcher', () => ({
  dispatchAgentErrorEvent: dispatchAgentErrorEventMock,
}));

vi.mock('../agentTurnCleanup', () => ({
  completeTurnCleanup: completeTurnCleanupMock,
}));

vi.mock('@core/errorReporter', () => ({
  getErrorReporter: () => ({ captureException: captureExceptionMock }),
}));

import { handleError } from '../turnPipeline/turnCompletion';

const turnLogger = () => ({
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
});

function buildBase(overrides: Partial<TurnCompletionBaseContext> = {}): TurnCompletionBaseContext {
  return {
    turnId: 'turn-1',
    win: null,
    turnLogger: turnLogger() as never,
    abortController: new AbortController(),
    settings: {
      activeProvider: 'anthropic',
      claude: { model: 'claude-sonnet-4-5' },
      localModel: { profiles: [] },
    } as never,
    rendererSessionId: 'session-1',
    turnOptions: { resetConversation: false },
    prompt: 'hello',
    retryTurn: vi.fn(async () => {}),
    trackingCounters: {
      messageCount: 0,
      receivedResultMessage: false,
      lastMessageType: undefined,
      lastToolName: undefined,
      mcpMode: undefined,
      hasMedia: false,
    },
    watchdogDiagnostics: {
      abortedByWatchdog: false,
      abortedByAwaitingApiStall: false,
      watchdogFired: false,
      watchdogFiredAt: undefined,
      maxWatchdogLevel: 0,
      watchdogLevel: 0,
      effectiveAbortMs: 0,
      rawStreamEventCount: 0,
      rawStreamLastEventType: null,
      rawStreamLastEventAgeMs: null,
    },
    effectiveResetConversation: false,
    availableProfiles: [{ id: 'p1', name: 'Profile 1', model: 'model-a' } as never],
    thinkingProfile: null,
    workingProfile: null,
    requestedModelForTurn: 'claude-sonnet-4-5',
    getLastActivityAgeMs: () => 123,
    getMessageTimeoutMs: () => 456,
    ...overrides,
  };
}

function buildRuntimeAccumulator(
  overrides: Partial<Extract<RuntimePhaseAccumulator, { stage: 'runtime-ready' }>> = {},
): Extract<RuntimePhaseAccumulator, { stage: 'runtime-ready' }> {
  return {
    stage: 'runtime-ready',
    error: undefined,
    modelConfig: { model: 'claude-sonnet-4-5', envOverrides: undefined } as never,
    extendedContextEnabled: false,
    queryOptions: { model: 'claude-sonnet-4-5' } as never,
    buildQueryOptions: vi.fn(() => ({ model: 'claude-sonnet-4-5' }) as never),
    createPromptOrGenerator: vi.fn(() => 'prompt') as never,
    routerContext: undefined,
    thinkingModelOverride: undefined,
    plan: { kind: 'direct', provider: 'anthropic' } as never,
    routeInput: { role: 'execution' } as never,
    routeRuntimeContextForDecision: vi.fn(() => ({}) as never),
    applyRoutePlan: vi.fn(),
    activeProfile: null,
    isDirectRoleProfile: false,
    altModelFallbackAttempted: false,
    nestedFallbackQueryAttempted: false,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('turnCompletion.handleError', () => {
  it('runtime-ready: builds the ErrorRecoveryContext parity surface', async () => {
    const base = buildBase();
    const accumulator = buildRuntimeAccumulator();
    const error = new Error('boom');

    await handleError(base, accumulator, { phase: 'primaryQueryShell', error, recoverable: false });

    expect(dispatchErrorRecoveryMock).toHaveBeenCalledTimes(1);
    expect(dispatchErrorRecoveryMock.mock.calls[0][0]).toMatchObject({
      error,
      turnId: base.turnId,
      win: base.win,
      turnLogger: base.turnLogger,
      abortController: base.abortController,
      settings: base.settings,
      rendererSessionId: base.rendererSessionId,
      modelConfig: accumulator.modelConfig,
      queryOptions: accumulator.queryOptions,
      plan: accumulator.plan,
      routeInput: accumulator.routeInput,
      effectiveResetConversation: false,
      turnOptions: base.turnOptions,
      prompt: 'hello',
    });
  });

  it('runtime-ready: dispatches via dispatchErrorRecovery, not terminal cleanup', async () => {
    await handleError(buildBase(), buildRuntimeAccumulator(), {
      phase: 'primaryQueryShell',
      error: new Error('boom'),
      recoverable: false,
    });

    expect(dispatchErrorRecoveryMock).toHaveBeenCalledTimes(1);
    expect(completeTurnCleanupMock).not.toHaveBeenCalled();
  });

  it('runtime-ready: preserves Error instance identity', async () => {
    const error = new TypeError('typed boom');
    await handleError(buildBase(), buildRuntimeAccumulator(), { phase: 'primaryQueryShell', error, recoverable: false });

    expect(dispatchErrorRecoveryMock.mock.calls[0][0].error).toBe(error);
  });

  it.each([['string'], [undefined], [{ custom: true }]])(
    'runtime-ready: preserves non-Error throw %#',
    async (error) => {
      await handleError(buildBase(), buildRuntimeAccumulator(), { phase: 'primaryQueryShell', error, recoverable: false });

      expect(dispatchErrorRecoveryMock.mock.calls[0][0].error).toBe(error);
    },
  );

  it('runtime-ready: retryTurn reference is exactly base.retryTurn', async () => {
    const retryTurn = vi.fn(async () => {});
    const base = buildBase({ retryTurn });
    await handleError(base, buildRuntimeAccumulator(), { phase: 'primaryQueryShell', error: new Error('boom'), recoverable: false });

    expect(dispatchErrorRecoveryMock.mock.calls[0][0].retryTurn).toBe(retryTurn);
  });

  it('runtime-ready: reads trackingCounters at dispatch time', async () => {
    const base = buildBase();
    base.trackingCounters.messageCount = 7;
    base.trackingCounters.receivedResultMessage = true;
    base.trackingCounters.lastToolName = 'Read';

    await handleError(base, buildRuntimeAccumulator(), { phase: 'primaryQueryShell', error: new Error('boom'), recoverable: false });

    expect(dispatchErrorRecoveryMock.mock.calls[0][0]).toMatchObject({
      messageCount: 7,
      receivedResultMessage: true,
      lastToolName: 'Read',
    });
  });

  it('runtime-ready: reads watchdogDiagnostics at dispatch time', async () => {
    const base = buildBase();
    base.watchdogDiagnostics.watchdogFired = true;
    base.watchdogDiagnostics.rawStreamEventCount = 11;
    base.watchdogDiagnostics.rawStreamLastEventType = 'content_block_delta';

    await handleError(base, buildRuntimeAccumulator(), { phase: 'primaryQueryShell', error: new Error('boom'), recoverable: false });

    expect(dispatchErrorRecoveryMock.mock.calls[0][0]).toMatchObject({
      watchdogFired: true,
      rawStreamEventCount: 11,
      rawStreamLastEventType: 'content_block_delta',
    });
  });

  it('runtime-ready: availableProfiles is a defensive copy', async () => {
    const base = buildBase();
    await handleError(base, buildRuntimeAccumulator(), { phase: 'primaryQueryShell', error: new Error('boom'), recoverable: false });

    const ctx = dispatchErrorRecoveryMock.mock.calls[0][0];
    expect(ctx.availableProfiles).toEqual(base.availableProfiles);
    expect(ctx.availableProfiles).not.toBe(base.availableProfiles);
  });

  it('runtime-ready: codex-active diagnostic logs before recovery dispatch', async () => {
    const base = buildBase({
      settings: { activeProvider: 'codex', claude: { model: 'claude-sonnet-4-5' } } as never,
    });
    base.trackingCounters.messageCount = 3;

    await handleError(base, buildRuntimeAccumulator(), { phase: 'primaryQueryShell', error: new Error('boom'), recoverable: false });

    expect(base.turnLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ errorMessage: 'boom', messageCount: 3 }),
      '[CODEX-DIAG] Raw turn error before recovery',
    );
    const errorLog = base.turnLogger.error as unknown as ReturnType<typeof vi.fn>;
    expect(errorLog.mock.invocationCallOrder[0]).toBeLessThan(
      dispatchErrorRecoveryMock.mock.invocationCallOrder[0],
    );
  });

  it('runtime-ready: MessageTimeoutError enrichment logs raw stream diagnostics before dispatch', async () => {
    const base = buildBase();
    base.watchdogDiagnostics.rawStreamEventCount = 4;
    const error = new MessageTimeoutError(180_000, 2, 'hard_cap', 5);

    await handleError(base, buildRuntimeAccumulator(), { phase: 'primaryQueryShell', error, recoverable: false });

    expect(base.turnLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'hard_cap', rearmCount: 5, rawStreamEventCount: 4 }),
      'MessageTimeoutError (hard_cap) with raw stream diagnostics',
    );
    const warnLog = base.turnLogger.warn as unknown as ReturnType<typeof vi.fn>;
    expect(warnLog.mock.invocationCallOrder[0]).toBeLessThan(
      dispatchErrorRecoveryMock.mock.invocationCallOrder[0],
    );
  });

  it('pre-runtime: dispatches error event and completeTurnCleanup with pre-runtime-failure', async () => {
    const error = new Error('before runtime');

    await handleError(buildBase(), { stage: 'pre-runtime' }, { phase: 'modelMcp', error, recoverable: false });

    expect(dispatchAgentErrorEventMock).toHaveBeenCalledWith(null, 'turn-1', error);
    expect(completeTurnCleanupMock).toHaveBeenCalledWith('turn-1', 'pre-runtime-failure');
    expect(dispatchErrorRecoveryMock).not.toHaveBeenCalled();
  });

  it('pre-runtime: skips Sentry capture for ConnectionNotConfiguredError but still dispatches and cleans up', async () => {
    const error = new ConnectionNotConfiguredError(
      'OpenRouter needs reconnecting. Sign in again in Settings to continue.',
      'OpenRouter',
    );

    await handleError(buildBase(), { stage: 'pre-runtime' }, { phase: 'primaryQueryShell', error, recoverable: false });

    expect(captureExceptionMock).not.toHaveBeenCalled();
    expect(dispatchAgentErrorEventMock).toHaveBeenCalledWith(null, 'turn-1', error);
    expect(completeTurnCleanupMock).toHaveBeenCalledWith('turn-1', 'pre-runtime-failure');
  });

  it('pre-runtime: skips Sentry capture for UnsupportedModelError but still dispatches and cleans up', async () => {
    const error = new UnsupportedModelError(
      'ChatGPT Pro doesn\'t support gpt-5.5-pro. Pick a different model in Settings.',
      'gpt-5.5-pro',
      'ChatGPT Pro',
    );

    await handleError(buildBase(), { stage: 'pre-runtime' }, { phase: 'primaryQueryShell', error, recoverable: false });

    expect(captureExceptionMock).not.toHaveBeenCalled();
    expect(dispatchAgentErrorEventMock).toHaveBeenCalledWith(null, 'turn-1', error);
    expect(completeTurnCleanupMock).toHaveBeenCalledWith('turn-1', 'pre-runtime-failure');
  });

  it('pre-runtime: logs failure phase and recoverable flag', async () => {
    const base = buildBase();

    await handleError(base, { stage: 'pre-runtime' }, { phase: 'routingProxy', error: new Error('nope'), recoverable: true });

    expect(base.turnLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ failurePhase: 'routingProxy', recoverable: true }),
      'Pre-runtime phase failure — running minimum-viable terminal cleanup',
    );
  });

  it.each([
    ['string failure', 'string failure'],
    [undefined, 'Pre-runtime phase failed'],
  ])('pre-runtime: wraps non-Error throw %# before dispatchAgentErrorEvent', async (thrown, message) => {
    await handleError(buildBase(), { stage: 'pre-runtime' }, { phase: 'admission', error: thrown, recoverable: false });

    const dispatched = dispatchAgentErrorEventMock.mock.calls[0][2];
    expect(dispatched).toBeInstanceOf(Error);
    expect(dispatched.message).toBe(message);
  });

  it('pre-runtime: captures to Sentry with pre_runtime tag and failurePhase', async () => {
    const error = new Error('admission boom');

    await handleError(buildBase(), { stage: 'pre-runtime' }, { phase: 'admission', error, recoverable: false });

    expect(captureExceptionMock).toHaveBeenCalledWith(
      error,
      expect.objectContaining({
        tags: expect.objectContaining({
          source: 'rebel-core-runtime',
          pre_runtime: true,
          failurePhase: 'admission',
        }),
        extra: expect.objectContaining({
          turnId: 'turn-1',
          recoverable: false,
        }),
      }),
    );
  });

  it('pre-runtime: generic Error still captures to Sentry and dispatches user error event', async () => {
    const error = new Error('routing exploded');

    await handleError(buildBase(), { stage: 'pre-runtime' }, { phase: 'routingProxy', error, recoverable: true });

    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
    expect(dispatchAgentErrorEventMock).toHaveBeenCalledWith(null, 'turn-1', error);
  });

  it('pre-runtime: Sentry capture errors do not mask the original failure', async () => {
    captureExceptionMock.mockImplementationOnce(() => {
      throw new Error('Sentry transport down');
    });

    await expect(
      handleError(buildBase(), { stage: 'pre-runtime' }, { phase: 'modelMcp', error: new Error('orig'), recoverable: false }),
    ).resolves.toBeUndefined();

    expect(completeTurnCleanupMock).toHaveBeenCalledWith('turn-1', 'pre-runtime-failure');
  });

  it('pre-runtime: codex-active diagnostic still emits', async () => {
    const base = buildBase({
      settings: { activeProvider: 'codex', claude: { model: 'claude-sonnet-4-5' } } as never,
    });

    await handleError(base, { stage: 'pre-runtime' }, { phase: 'modelMcp', error: new Error('codex fail'), recoverable: false });

    expect(base.turnLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ errorMessage: 'codex fail' }),
      '[CODEX-DIAG] Raw turn error before recovery',
    );
  });

  it('runtime-ready: buildQueryOptions and applyRoutePlan references are passed through', async () => {
    const buildQueryOptions = vi.fn(() => ({ model: 'updated' }) as never);
    const applyRoutePlan = vi.fn();
    const accumulator = buildRuntimeAccumulator({ buildQueryOptions, applyRoutePlan });

    await handleError(buildBase(), accumulator, { phase: 'primaryQueryShell', error: new Error('boom'), recoverable: false });

    const ctx = dispatchErrorRecoveryMock.mock.calls[0][0];
    expect(ctx.buildQueryOptions).toBe(buildQueryOptions);
    expect(ctx.applyRoutePlan).toBe(applyRoutePlan);
  });
});
