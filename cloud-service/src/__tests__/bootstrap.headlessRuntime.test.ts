import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const createNoopHandlers = () => ({
  registerLibraryHandlers: vi.fn(),
  registerSettingsHandlers: vi.fn(),
  registerSessionsHandlers: vi.fn(),
  registerInboxHandlers: vi.fn(),
  registerAutomationsHandlers: vi.fn(),
  registerDashboardHandlers: vi.fn(),
  registerUserTasksHandlers: vi.fn(),
  registerScratchpadHandlers: vi.fn(),
  registerSkillsHandlers: vi.fn(),
  registerUseCaseLibraryHandlers: vi.fn(),
  registerFileConversationHandlers: vi.fn(),
  registerSafetyHandlers: vi.fn(),
  registerSafetyActivityLogHandlers: vi.fn(),
  registerSafetyPromptHandlers: vi.fn(),
  registerSearchHandlers: vi.fn(),
  registerFeedbackHandlers: vi.fn(),
  registerDiagnosticsHandlers: vi.fn(),
  registerMemoryHandlers: vi.fn(),
  registerCommunityHandlers: vi.fn(),
  registerMiscHandlers: vi.fn(),
  registerCalendarHandlers: vi.fn(),
  registerErrorRecoveryHandlers: vi.fn(),
  registerUsageHandlers: vi.fn(),
});

describe('cloud bootstrap headless runtime wiring', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    delete process.env.FLY_MACHINE_ID;
    delete process.env.REBEL_SURFACE;
    delete process.env.REBEL_MOCK_AGENT_TURNS;
    process.env.REBEL_USER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'rebel-cloud-runtime-test-'));
  });

  afterEach(() => {
    delete process.env.REBEL_SURFACE;
  });

  it('passes cloud executors and awaits shutdown cleanup in order', async () => {
    const cleanupOrder: string[] = [];
    let storeFactoryInitialized = false;
    const setStoreFactoryMock = vi.fn(() => {
      storeFactoryInitialized = true;
    });
    const defaultSettings = {
      coreDirectory: path.join(process.env.REBEL_USER_DATA ?? '', 'workspace'),
      behindTheScenesModel: undefined as string | undefined,
    };
    let currentSettings = defaultSettings;
    const getSettingsMock = vi.fn(() => {
      if (!storeFactoryInitialized) {
        throw new Error('settings read before setStoreFactory');
      }
      return currentSettings;
    });

    const createCleanupStep = (startLabel: string, doneLabel: string) => {
      let resolveStep: () => void = () => {};
      const promise = new Promise<void>((resolve) => {
        resolveStep = () => {
          cleanupOrder.push(doneLabel);
          resolve();
        };
      });
      const mock = vi.fn(() => {
        cleanupOrder.push(startLabel);
        return promise;
      });
      return { mock, resolveStep };
    };
    const cloudSchedulerStop = createCleanupStep('cloudScheduler.stop:start', 'cloudScheduler.stop:done');
    const selfUpdateStop = createCleanupStep('selfUpdate.stop:start', 'selfUpdate.stop:done');
    const runtimeCleanup = createCleanupStep('runtime.cleanup:start', 'runtime.cleanup:done');
    const sentryFlush = createCleanupStep('Sentry.flush:start', 'Sentry.flush:done');
    const getAccessTokenMock = vi.fn(async () => 'fresh-codex-token');
    const runtimeStartAgentTurnMock = vi.fn(() => ({ turnId: 'runtime-turn' }));
    const createHeadlessRuntimeMock = vi.fn(async (_config: unknown) => ({
      startAgentTurn: runtimeStartAgentTurnMock,
      runTurn: vi.fn(),
      setEventListener: vi.fn(),
      deleteEventListener: vi.fn(),
      getAbortController: vi.fn(),
      getTurnCloseCallback: vi.fn(),
      getSettings: vi.fn(),
      updateSettings: vi.fn(),
      cleanup: runtimeCleanup.mock,
    }));
    const executeAgentTurnMock = vi.fn(async () => undefined);
    const store = {
      load: vi.fn(async () => []),
      loadSync: vi.fn(() => []),
      listSessions: vi.fn(() => []),
      getSession: vi.fn(async () => null),
      upsertSession: vi.fn(async () => undefined),
      deleteSession: vi.fn(async () => undefined),
      cleanupLeakedSessions: vi.fn(async () => undefined),
    };
    const sendToAllWindowsMock = vi.fn();
    const onInboxStateChangeMock = vi.fn();
    const sessionSeqIndex = {
      hydrateFromSessions: vi.fn(),
      setSeqFromStorage: vi.fn(),
      getCurrentSeq: vi.fn(() => 0),
      deleteSession: vi.fn(),
    };

    vi.doMock('@sentry/node', () => ({
      init: vi.fn(),
      captureException: vi.fn(),
      captureMessage: vi.fn(),
      addBreadcrumb: vi.fn(),
      withScope: vi.fn(),
      flush: sentryFlush.mock,
    }));
    vi.doMock('@core/errorReporter', () => ({
      setErrorReporter: vi.fn(),
      getErrorReporter: vi.fn(() => ({
        captureException: vi.fn(),
        captureMessage: vi.fn(),
        addBreadcrumb: vi.fn(),
      })),
    }));
    vi.doMock('@core/feedbackReporter', () => ({ setFeedbackReporter: vi.fn() }));
    vi.doMock('@core/utils/gracefulFsObservability', () => ({
      installGracefulFsObservability: vi.fn(() => vi.fn()),
    }));
    vi.doMock('@core/storeFactory', () => ({ setStoreFactory: setStoreFactoryMock }));
    vi.doMock('@core/tracking', () => ({ setTracker: vi.fn() }));
    vi.doMock('@core/broadcastService', () => ({
      setBroadcastService: vi.fn(),
      getBroadcastService: vi.fn(() => ({
        sendToAllWindows: sendToAllWindowsMock,
        sendToFocusedWindow: vi.fn(),
      })),
    }));
    vi.doMock('@core/codexAuth', () => ({ setCodexAuthProvider: vi.fn() }));
    vi.doMock('@core/services/defaultCodexAuthProvider', () => ({
      DEFAULT_CODEX_AUTH_PROVIDER: {
        isConnected: vi.fn(() => true),
        getAccessToken: getAccessTokenMock,
        getAccountId: vi.fn(() => 'acct_123'),
        forceRefreshToken: vi.fn(async () => 'fresh-codex-token'),
        getStatus: vi.fn(() => ({ connected: true })),
      },
    }));
    vi.doMock('@core/services/diagnosticEventsLedger', () => ({
      setDiagnosticEventsLedgerReader: vi.fn(),
      setDiagnosticEventsLedgerWriter: vi.fn(),
      setDiagnosticEventsSurface: vi.fn(),
    }));
    vi.doMock('@core/handlerRegistry', () => ({
      setHandlerRegistry: vi.fn(),
      getHandlerRegistry: vi.fn(() => ({ register: vi.fn() })),
    }));
    vi.doMock('@core/safetyEvaluationService', () => ({ setSafetyEvaluationService: vi.fn() }));
    vi.doMock('@core/featureGating', () => ({ setLicenseTier: vi.fn() }));
    vi.doMock('@rebel/cloud-client', () => ({ setLogErrorReporter: vi.fn() }));
    vi.doMock('../mapHandlerRegistry', () => ({ MapHandlerRegistry: class MapHandlerRegistry {} }));
    vi.doMock('../sentryFeedbackReporter', () => ({ createCloudFeedbackReporter: vi.fn(() => ({})) }));
    vi.doMock('../services/sentryRedaction', () => ({
      redactObjectDeep: vi.fn((value: unknown) => value),
      redactSensitiveString: vi.fn((value: string) => value),
      redactSentryEvent: vi.fn((value: unknown) => value),
    }));
    vi.doMock('../electronStoreShim', () => ({ default: class CloudStore {} }));
    vi.doMock('../cloudEventBroadcaster', () => ({
      cloudEventBroadcaster: {
        broadcast: vi.fn(),
        virtualWindow: {},
      },
    }));
    vi.doMock('../services/cloudDiagnosticEventsLedger', () => ({
      cloudDiagnosticEventsLedgerReader: {},
      cloudDiagnosticEventsLedgerWriter: {},
    }));
    vi.doMock('@core/services/settingsStore/index', () => ({
      ensureNormalizedSettings: vi.fn(),
      getSettings: getSettingsMock,
      settingsStore: {},
      updateSettings: vi.fn(),
    }));
    vi.doMock('@core/services/settingsStore', () => ({ setSettingsStoreAdapter: vi.fn() }));
    vi.doMock('@core/services/safety/btsSafetyEvalService', () => ({
      createBtsSafetyEvalService: vi.fn(() => ({})),
    }));
    vi.doMock('@core/services/incrementalSessionStore', () => ({
      getIncrementalSessionStore: vi.fn(() => store),
    }));
    vi.doMock('@core/services/agentTurnRegistry', () => ({
      agentTurnRegistry: {
        setEventListener: vi.fn(),
        deleteEventListener: vi.fn(),
        subscribeTurnEvents: vi.fn(() => vi.fn()),
        getActiveTurnController: vi.fn(),
        getTurnCloseCallback: vi.fn(),
        deleteRendererSession: vi.fn(),
        cancelExistingTurnForSession: vi.fn(),
      },
    }));
    vi.doMock('@core/services/turnPipeline/agentTurnExecute', () => ({ executeAgentTurn: executeAgentTurnMock }));
    vi.doMock('@core/services/agentEventDispatcher', () => ({ dispatchAgentEvent: vi.fn() }));
    vi.doMock('@core/services/recovery/recoveryPipeline', () => ({
      runRecoveryPipeline: vi.fn(async () => undefined),
    }));
    vi.doMock('../services/cloudRecoveryAdapter', () => ({
      createCloudRecoveryAdapter: vi.fn(() => ({})),
    }));
    vi.doMock('@core/services/headlessRuntime', () => ({
      createHeadlessRuntime: createHeadlessRuntimeMock,
    }));
    vi.doMock('@main/services/safety', () => ({ createMemoryWriteHook: vi.fn() }));
    vi.doMock('@core/services/safety/mcpDenyHook', () => ({ createMcpDenyHook: vi.fn() }));
    vi.doMock('@shared/utils/modelNormalization', () => ({ DEFAULT_AUXILIARY_MODEL: 'test-model', MODEL_OPTIONS: [] }));
    vi.doMock('@core/rebelCore/learnedLimitsMigration', () => ({
      migrateLearnedLimitsIfNeeded: vi.fn(),
    }));
    vi.doMock('@core/services/behindTheScenesClient', () => ({
      registerManagedKeyAvailability: vi.fn(),
      registerBtsProxyProviders: vi.fn(),
    }));
    vi.doMock('@main/services/localModelProxyServer', () => ({
      proxyManager: {
        isRunning: vi.fn(() => true),
        ensureRunningForBts: vi.fn(async () => undefined),
        getUrl: vi.fn(() => 'http://127.0.0.1:3100'),
        getAuthToken: vi.fn(() => 'proxy-auth'),
      },
    }));
    vi.doMock('@core/services/continuity/serverClock', () => ({
      clearServerClockSession: vi.fn(),
      seedServerClock: vi.fn(),
      stampCloudUpdatedAt: vi.fn((session: unknown) => session),
    }));
    vi.doMock('@core/services/continuity/sessionSeqIndex', () => ({
      getMaxSeqFromSession: vi.fn(() => 0),
      getSessionSeqIndex: vi.fn(() => sessionSeqIndex),
    }));
    vi.doMock('@core/services/continuity/outboxStallMonitor', () => ({
      getOutboxStallMonitor: vi.fn(() => ({ start: vi.fn() })),
    }));
    vi.doMock('@core/services/continuity/sessionTombstoneStore', () => ({
      getSessionTombstoneStore: vi.fn(() => ({})),
    }));
    vi.doMock('../services/cleanupLeakedSessionsBridge', () => ({
      createCleanupLeakedSessionDeletedCallback: vi.fn(() => vi.fn()),
    }));
    vi.doMock('../services/externalConversationServiceFactory', () => ({
      initExternalConversationService: vi.fn(),
    }));
    vi.doMock('@main/ipc/cloudIpcHandlers', () => createNoopHandlers());
    vi.doMock('../cloudAutomationStore', () => ({
      CloudAutomationStoreAdapter: class CloudAutomationStoreAdapter {
        getState(): { definitions: unknown[] } {
          return { definitions: [] };
        }
        setOnDefinitionChange(): void {}
        setOnDelta(): void {}
      },
    }));
    vi.doMock('@core/services/inboxStore', () => ({
      onInboxStateChange: onInboxStateChangeMock,
    }));
    vi.doMock('@main/services/toolSafetyService', () => ({
      handleApprovalResponse: vi.fn(),
    }));
    vi.doMock('@core/services/safety/toolSafetyService', () => ({
      handleApprovalResponse: vi.fn(),
    }));
    vi.doMock('@core/services/userQuestionResponseHandler', () => ({
      registerUserQuestionResponseHandler: vi.fn(),
      setUserQuestionAnsweredPersister: vi.fn(),
      setUserQuestionProvenanceResolver: vi.fn(),
      findPersistedUserQuestionProvenance: vi.fn(() => null),
    }));
    vi.doMock('@core/services/sessionMutex', () => ({
      getSessionMutex: vi.fn(() => ({
        withLock: vi.fn(async (_id: string, fn: () => Promise<void> | void) => fn()),
      })),
    }));
    vi.doMock('@core/services/safety/conflictCapabilityService', () => ({
      createConflictCapabilityService: vi.fn(() => ({})),
    }));
    vi.doMock('@core/services/safety/ipcDedupService', () => ({
      createIpcDedupService: vi.fn(() => ({})),
    }));
    vi.doMock('../services/cloudAutomationScheduler', () => ({
      CloudAutomationScheduler: class CloudAutomationScheduler {
        onDefinitionsChanged(): void {}
        start(): void {}
        stop(): Promise<void> {
          return cloudSchedulerStop.mock();
        }
      },
    }));
    vi.doMock('../selfUpdateScheduler', () => ({
      startSelfUpdateScheduler: vi.fn(),
      stopSelfUpdateScheduler: selfUpdateStop.mock,
    }));
    vi.doMock('../services/cloudHygieneScheduler', () => ({
      startCloudHygieneScheduler: vi.fn(),
    }));

    const { bootstrap } = await import('../bootstrap');
    // REGRESSION GUARD (Phase 8): this test exercises the REAL `@main/analytics`
    // (not mocked) and never calls `setPlatformConfig()`. The shared
    // `initAnalytics()` → `resolveRudderCreds()` reads
    // `getPlatformConfig().isOss`, which throws 'PlatformConfig not initialized'
    // when unwired. bootstrap() guards the analytics init (try/catch +
    // observable error log) so a telemetry-init failure never crashes boot —
    // i.e. `bootstrap()` must RESOLVE here, not reject. (Negative case for the
    // 23-test cloud regression fixed in fix(cloud-analytics): analytics init
    // must not crash cloud bootstrap.)
    const bootstrapPromise = bootstrap();
    await expect(bootstrapPromise).resolves.toBeDefined();
    const deps = await bootstrapPromise;

    expect(createHeadlessRuntimeMock).toHaveBeenCalledTimes(1);
    expect(process.env.REBEL_SURFACE).toBe('cloud');
    expect(setStoreFactoryMock).toHaveBeenCalled();
    expect(getSettingsMock).toHaveBeenCalled();
    expect(setStoreFactoryMock.mock.invocationCallOrder[0]).toBeLessThan(
      getSettingsMock.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    const runtimeConfig = createHeadlessRuntimeMock.mock.calls[0]?.[0] as {
      preOAuthCallHook?: () => Promise<void>;
      executeAgentTurn?: unknown;
      executeAgentTurnWithRecovery?: unknown;
      memoryUpdateDeps?: {
        executeAgentTurn: (
          turnId: string,
          prompt: string,
          options: {
            sessionId: string;
            originalTurnId: string;
            originalSessionId: string;
            privateMode?: boolean;
            onEvent: (event: unknown) => void;
          },
        ) => Promise<void>;
      };
      superMcpPortBase?: number;
      superMcpPortRange?: number;
      superMcpTimeoutMs?: number;
    };

    expect(onInboxStateChangeMock).toHaveBeenCalledTimes(1);
    const inboxChangeCallback = onInboxStateChangeMock.mock.calls[0]?.[0] as
      | ((state: { version: number; items: unknown[]; history: unknown[] }) => void)
      | undefined;
    expect(typeof inboxChangeCallback).toBe('function');
    const inboxState = { version: 2, items: [{ id: 'item-1' }], history: [] };
    inboxChangeCallback?.(inboxState);
    expect(sendToAllWindowsMock).toHaveBeenCalledWith('inbox:state', inboxState);
    expect(sendToAllWindowsMock).toHaveBeenCalledWith('inbox:changed', {});

    expect(typeof runtimeConfig.preOAuthCallHook).toBe('function');
    expect(typeof runtimeConfig.executeAgentTurn).toBe('function');
    expect(typeof runtimeConfig.executeAgentTurnWithRecovery).toBe('function');
    expect(runtimeConfig.superMcpPortBase).toBe(3100);
    expect(runtimeConfig.superMcpPortRange).toBe(25);
    expect(runtimeConfig.superMcpTimeoutMs).toBe(30_000);

    expect(typeof runtimeConfig.memoryUpdateDeps?.executeAgentTurn).toBe('function');
    const memoryCases = [
      {
        name: 'profile-form BTS',
        behindTheScenesModel: 'profile:dash-bts',
        expected: {
          modelOverride: undefined,
          workingProfileOverrideId: 'dash-bts',
        },
      },
      {
        name: 'bare model BTS',
        behindTheScenesModel: 'deepseek/deepseek-v4-flash',
        expected: {
          modelOverride: 'deepseek/deepseek-v4-flash',
          workingProfileOverrideId: undefined,
        },
      },
      {
        name: 'unset BTS',
        behindTheScenesModel: undefined,
        expected: {
          modelOverride: 'test-model',
          workingProfileOverrideId: undefined,
        },
      },
    ];

    for (const memoryCase of memoryCases) {
      executeAgentTurnMock.mockClear();
      currentSettings = {
        ...defaultSettings,
        behindTheScenesModel: memoryCase.behindTheScenesModel,
      };

      await runtimeConfig.memoryUpdateDeps?.executeAgentTurn(
        `memory-${memoryCase.name}`,
        'update memory',
        {
          sessionId: 'memory-session',
          originalTurnId: 'original-turn',
          originalSessionId: 'original-session',
          onEvent: vi.fn(),
        },
      );

      const turnOptions = (executeAgentTurnMock.mock.calls[0] as unknown[] | undefined)?.[3] as
        | { modelOverride?: string; workingProfileOverrideId?: string; thinkingModelOverride?: string }
        | undefined;
      expect(turnOptions, memoryCase.name).toBeDefined();
      expect(turnOptions?.modelOverride).toBe(memoryCase.expected.modelOverride);
      expect(turnOptions?.workingProfileOverrideId).toBe(memoryCase.expected.workingProfileOverrideId);
      expect(turnOptions?.thinkingModelOverride).toBe('');
    }

    await runtimeConfig.preOAuthCallHook?.();
    expect(getAccessTokenMock).toHaveBeenCalledTimes(1);

    const cleanupPromise = deps.cleanup?.();
    await Promise.resolve();
    expect(cleanupOrder).toEqual(['cloudScheduler.stop:start']);

    cloudSchedulerStop.resolveStep();
    await Promise.resolve();
    expect(cleanupOrder).toEqual([
      'cloudScheduler.stop:start',
      'cloudScheduler.stop:done',
      'selfUpdate.stop:start',
    ]);

    selfUpdateStop.resolveStep();
    await Promise.resolve();
    expect(cleanupOrder).toEqual([
      'cloudScheduler.stop:start',
      'cloudScheduler.stop:done',
      'selfUpdate.stop:start',
      'selfUpdate.stop:done',
      'runtime.cleanup:start',
    ]);

    runtimeCleanup.resolveStep();
    await Promise.resolve();
    expect(cleanupOrder).toEqual([
      'cloudScheduler.stop:start',
      'cloudScheduler.stop:done',
      'selfUpdate.stop:start',
      'selfUpdate.stop:done',
      'runtime.cleanup:start',
      'runtime.cleanup:done',
      'Sentry.flush:start',
    ]);

    sentryFlush.resolveStep();
    await cleanupPromise;
    expect(cleanupOrder).toEqual([
      'cloudScheduler.stop:start',
      'cloudScheduler.stop:done',
      'selfUpdate.stop:start',
      'selfUpdate.stop:done',
      'runtime.cleanup:start',
      'runtime.cleanup:done',
      'Sentry.flush:start',
      'Sentry.flush:done',
    ]);
    expect(runtimeCleanup.mock).toHaveBeenCalledTimes(1);
    expect(sentryFlush.mock).toHaveBeenCalledWith(2000);
  });
});
