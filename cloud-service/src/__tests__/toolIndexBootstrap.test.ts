import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const STATUS_TIMEOUT_MS = 2_500;

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

type BootstrapHarnessOptions = {
  fetchMock: ReturnType<typeof vi.fn>;
  superMcpUrl?: string;
  omitSuperMcpUrl?: boolean;
  stubbedToolCount?: number;
  refreshToolIndexImpl?: () => Promise<{
    success: boolean;
    added: number;
    updated: number;
    removed: number;
    total: number;
  }>;
  refreshToolIndexFromCatalogDataImpl?: () => Promise<{
    success: boolean;
    added: number;
    updated: number;
    removed: number;
    total: number;
  }>;
};

async function bootstrapWithHarness(options: BootstrapHarnessOptions): Promise<{
  initializeToolIndexMock: ReturnType<typeof vi.fn>;
  refreshToolIndexMock: ReturnType<typeof vi.fn>;
  refreshToolIndexFromCatalogDataMock: ReturnType<typeof vi.fn>;
  markToolIndexInvalidatedMock: ReturnType<typeof vi.fn>;
  markToolIndexRefreshCompleteMock: ReturnType<typeof vi.fn>;
}> {
  const runtimeSuperMcpUrl = options.omitSuperMcpUrl
    ? undefined
    : (options.superMcpUrl ?? 'https://super-mcp.example/mcp');
  const stubbedToolCount = options.stubbedToolCount ?? 6;
  vi.stubGlobal('fetch', options.fetchMock);

  const toolIndexStatus = {
    isInitialized: false,
    toolCount: 0,
    lastRefreshAt: null as number | null,
    etag: null as string | null,
    byServer: undefined as Record<string, number> | undefined,
    isStale: false,
    staleReason: null as string | null,
    staleSince: null as number | null,
    staleGeneration: null as number | null,
    freshnessGeneration: 0,
    lastRefreshError: null as string | null,
  };

  const initializeToolIndexMock = vi.fn(async () => {
    toolIndexStatus.isInitialized = true;
  });

  const defaultRefreshImpl = async () => {
    toolIndexStatus.isInitialized = true;
    toolIndexStatus.toolCount = stubbedToolCount;
    toolIndexStatus.lastRefreshAt = Date.now();
    toolIndexStatus.byServer = { 'stub-catalog': stubbedToolCount };
    return {
      success: true as const,
      added: stubbedToolCount,
      updated: 0,
      removed: 0,
      total: stubbedToolCount,
    };
  };

  const refreshToolIndexMock = vi.fn(options.refreshToolIndexImpl ?? defaultRefreshImpl);

  const refreshToolIndexFromCatalogDataMock = vi.fn(
    options.refreshToolIndexFromCatalogDataImpl ?? defaultRefreshImpl,
  );

  const markToolIndexInvalidatedMock = vi.fn((reason: string) => {
    toolIndexStatus.freshnessGeneration += 1;
    toolIndexStatus.isStale = true;
    toolIndexStatus.staleReason = reason;
    toolIndexStatus.staleSince = Date.now();
    toolIndexStatus.staleGeneration = toolIndexStatus.freshnessGeneration;
    toolIndexStatus.lastRefreshError = null;
    return toolIndexStatus.freshnessGeneration;
  });

  const markToolIndexRefreshCompleteMock = vi.fn(
    (generation: number, result: { success: boolean; error?: string }) => {
      if (generation !== toolIndexStatus.freshnessGeneration) {
        return;
      }
      if (result.success) {
        toolIndexStatus.isStale = false;
        toolIndexStatus.staleReason = null;
        toolIndexStatus.staleSince = null;
        toolIndexStatus.staleGeneration = null;
        toolIndexStatus.lastRefreshError = null;
      } else {
        toolIndexStatus.isStale = true;
        toolIndexStatus.lastRefreshError = result.error ?? 'tool index refresh failed';
      }
    },
  );

  const rollbackToolIndexInvalidationMock = vi.fn((generation: number) => {
    if (generation !== toolIndexStatus.freshnessGeneration) {
      return;
    }
    toolIndexStatus.isStale = false;
    toolIndexStatus.staleReason = null;
    toolIndexStatus.staleSince = null;
    toolIndexStatus.staleGeneration = null;
    toolIndexStatus.lastRefreshError = null;
  });

  const createHeadlessRuntimeMock = vi.fn(async () => ({
    startAgentTurn: vi.fn(() => ({ turnId: 'runtime-turn' })),
    runTurn: vi.fn(),
    setEventListener: vi.fn(),
    deleteEventListener: vi.fn(),
    getAbortController: vi.fn(),
    getTurnCloseCallback: vi.fn(),
    getSettings: vi.fn(),
    updateSettings: vi.fn(),
    cleanup: vi.fn(async () => undefined),
    superMcpUrl: runtimeSuperMcpUrl,
  }));

  const setStoreFactoryMock = vi.fn();
  const getSettingsMock = vi.fn(() => ({
    coreDirectory: path.join(process.env.REBEL_USER_DATA ?? '', 'workspace'),
  }));
  const store = {
    load: vi.fn(async () => []),
    loadSync: vi.fn(() => []),
    listSessions: vi.fn(() => []),
    getSession: vi.fn(async () => null),
    upsertSession: vi.fn(async () => undefined),
    deleteSession: vi.fn(async () => undefined),
    cleanupLeakedSessions: vi.fn(async () => undefined),
  };
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
    flush: vi.fn(async () => true),
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
      sendToAllWindows: vi.fn(),
      sendToFocusedWindow: vi.fn(),
    })),
  }));
  vi.doMock('@core/codexAuth', () => ({ setCodexAuthProvider: vi.fn() }));
  vi.doMock('@core/services/defaultCodexAuthProvider', () => ({
    DEFAULT_CODEX_AUTH_PROVIDER: {
      isConnected: vi.fn(() => true),
      getAccessToken: vi.fn(async () => 'fresh-codex-token'),
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
      abortAllTurns: vi.fn(),
    },
  }));
  vi.doMock('@core/services/turnPipeline/agentTurnExecute', () => ({ executeAgentTurn: vi.fn(async () => undefined) }));
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
  vi.doMock('@shared/utils/btsModelResolver', () => ({ resolveBtsModel: vi.fn(() => 'test-memory-model') }));
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
      stop: vi.fn(async () => undefined),
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
    onInboxStateChange: vi.fn(),
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
        return Promise.resolve();
      }
    },
  }));
  vi.doMock('../selfUpdateScheduler', () => ({
    startSelfUpdateScheduler: vi.fn(),
    stopSelfUpdateScheduler: vi.fn(async () => undefined),
  }));
  vi.doMock('../services/cloudHygieneScheduler', () => ({
    startCloudHygieneScheduler: vi.fn(),
  }));

  vi.doMock('@core/services/toolIndex/toolIndexService', () => ({
    initializeToolIndex: initializeToolIndexMock,
    refreshToolIndex: refreshToolIndexMock,
    refreshToolIndexFromCatalogData: refreshToolIndexFromCatalogDataMock,
    markToolIndexInvalidated: markToolIndexInvalidatedMock,
    markToolIndexRefreshComplete: markToolIndexRefreshCompleteMock,
    rollbackToolIndexInvalidation: rollbackToolIndexInvalidationMock,
    getToolIndexStatus: vi.fn(() => ({ ...toolIndexStatus })),
    searchTools: vi.fn(async () => []),
    hasToolIndex: vi.fn(() => toolIndexStatus.isInitialized && toolIndexStatus.toolCount > 0 && !toolIndexStatus.isStale),
  }));

  const { bootstrap } = await import('../bootstrap');
  await bootstrap();
  const { cloudBootstrapWarmup } = await import('../services/cloudBootstrapWarmup');
  await cloudBootstrapWarmup.ensureWarm('first-request');

  return {
    initializeToolIndexMock,
    refreshToolIndexMock,
    refreshToolIndexFromCatalogDataMock,
    markToolIndexInvalidatedMock,
    markToolIndexRefreshCompleteMock,
  };
}

describe('cloud bootstrap tool-index initialization', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();

    delete process.env.FLY_MACHINE_ID;
    delete process.env.REBEL_SURFACE;
    delete process.env.REBEL_MOCK_AGENT_TURNS;
    process.env.REBEL_USER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'rebel-cloud-tool-index-bootstrap-'));
  });

  afterEach(() => {
    delete process.env.REBEL_SURFACE;
    vi.unstubAllGlobals();
  });

  it('initializes and refreshes the tool index after bootstrap', async () => {
    const stubbedToolCount = 9;
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        tools: [
          {
            package_id: 'stub-catalog',
            package_name: 'Stub Catalog',
            tool_id: 'stub__tool',
            name: 'Stub Tool',
            description: 'Stub tool description',
          },
        ],
        etag: 'stub-etag',
        package_hashes: { 'stub-catalog': 'stub-hash' },
      }),
    }) as Response);
    const {
      initializeToolIndexMock,
      refreshToolIndexMock,
      refreshToolIndexFromCatalogDataMock,
    } = await bootstrapWithHarness({
      fetchMock,
      stubbedToolCount,
    });

    const { getToolIndexStatus } = await import('@core/services/toolIndex/toolIndexService');

    await vi.waitFor(
      () => {
        const status = getToolIndexStatus();
        expect(status.isInitialized).toBe(true);
        expect(status.toolCount).toBe(stubbedToolCount);
      },
      { timeout: STATUS_TIMEOUT_MS },
    );

    expect(initializeToolIndexMock).toHaveBeenCalledTimes(1);
    expect(refreshToolIndexFromCatalogDataMock).toHaveBeenCalledTimes(1);
    expect(refreshToolIndexMock).toHaveBeenCalledTimes(0);
  });

  it('falls back to refreshToolIndex when warmup fetch returns non-2xx', async () => {
    const stubbedToolCount = 4;
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 503,
    }) as Response);
    const { refreshToolIndexMock, refreshToolIndexFromCatalogDataMock } = await bootstrapWithHarness({
      fetchMock,
      stubbedToolCount,
    });
    const { getToolIndexStatus } = await import('@core/services/toolIndex/toolIndexService');

    await vi.waitFor(
      () => {
        expect(getToolIndexStatus().toolCount).toBe(stubbedToolCount);
      },
      { timeout: STATUS_TIMEOUT_MS },
    );

    expect(refreshToolIndexFromCatalogDataMock).toHaveBeenCalledTimes(0);
    expect(refreshToolIndexMock).toHaveBeenCalledTimes(1);
  });

  it('falls back to refreshToolIndex when warmup response JSON parsing fails', async () => {
    const stubbedToolCount = 3;
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error('invalid warmup payload');
      },
    }) as unknown as Response);
    const { refreshToolIndexMock, refreshToolIndexFromCatalogDataMock } = await bootstrapWithHarness({
      fetchMock,
      stubbedToolCount,
    });
    const { getToolIndexStatus } = await import('@core/services/toolIndex/toolIndexService');

    await vi.waitFor(
      () => {
        expect(getToolIndexStatus().toolCount).toBe(stubbedToolCount);
      },
      { timeout: STATUS_TIMEOUT_MS },
    );

    expect(refreshToolIndexFromCatalogDataMock).toHaveBeenCalledTimes(0);
    expect(refreshToolIndexMock).toHaveBeenCalledTimes(1);
  });

  it('logs and leaves observable failure state when refreshToolIndexFromCatalogData throws', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        tools: [
          {
            package_id: 'stub-catalog',
            package_name: 'Stub Catalog',
            tool_id: 'stub__tool',
            name: 'Stub Tool',
            description: 'Stub tool description',
          },
        ],
        etag: 'stub-etag',
        package_hashes: { 'stub-catalog': 'stub-hash' },
      }),
    }) as Response);

    const {
      refreshToolIndexMock,
      refreshToolIndexFromCatalogDataMock,
    } = await bootstrapWithHarness({
      fetchMock,
      refreshToolIndexFromCatalogDataImpl: async () => {
        throw new Error('catalog refresh failed');
      },
    });
    const { getToolIndexStatus } = await import('@core/services/toolIndex/toolIndexService');

    await vi.waitFor(
      () => {
        expect(refreshToolIndexFromCatalogDataMock).toHaveBeenCalledTimes(1);
      },
      { timeout: STATUS_TIMEOUT_MS },
    );

    const status = getToolIndexStatus();
    expect(status.isInitialized).toBe(true);
    expect(status.toolCount).toBe(0);
    expect(refreshToolIndexMock).toHaveBeenCalledTimes(0);
    expect(warnSpy).toHaveBeenCalledWith(
      '[bootstrap] Tool index init/refresh failed (BM25 fallback active):',
      expect.any(Error),
    );
  });

  it('completes cloud stale-gate refresh flow after markToolIndexInvalidated', async () => {
    const stubbedToolCount = 5;
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        tools: [
          {
            package_id: 'stub-catalog',
            package_name: 'Stub Catalog',
            tool_id: 'stub__tool',
            name: 'Stub Tool',
            description: 'Stub tool description',
          },
        ],
        etag: 'stub-etag',
        package_hashes: { 'stub-catalog': 'stub-hash' },
      }),
    }) as Response);
    const {
      markToolIndexInvalidatedMock,
      markToolIndexRefreshCompleteMock,
      refreshToolIndexMock,
      refreshToolIndexFromCatalogDataMock,
    } = await bootstrapWithHarness({
      fetchMock,
      stubbedToolCount,
    });

    const {
      getToolIndexStatus,
      markToolIndexInvalidated,
      markToolIndexRefreshComplete,
      refreshToolIndex,
    } = await import('@core/services/toolIndex/toolIndexService');

    const generation = markToolIndexInvalidated('cloud-settings-change');
    const staleStatus = getToolIndexStatus();
    expect(staleStatus.isStale).toBe(true);
    expect(staleStatus.staleReason).toBe('cloud-settings-change');

    const refreshResult = await refreshToolIndex();
    markToolIndexRefreshComplete(generation, { success: refreshResult.success });

    const finalStatus = getToolIndexStatus();
    expect(refreshResult.success).toBe(true);
    expect(finalStatus.isStale).toBe(false);
    expect(finalStatus.isInitialized).toBe(true);
    expect(finalStatus.toolCount).toBe(stubbedToolCount);
    expect(markToolIndexInvalidatedMock).toHaveBeenCalledWith('cloud-settings-change');
    expect(markToolIndexRefreshCompleteMock).toHaveBeenCalledWith(generation, { success: true });
    expect(refreshToolIndexFromCatalogDataMock).toHaveBeenCalledTimes(1);
    expect(refreshToolIndexMock).toHaveBeenCalledTimes(1);
  });
});
