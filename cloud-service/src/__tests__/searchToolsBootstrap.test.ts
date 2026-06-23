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

type SuperMcpStartupErrorFixture = {
  lastError: string;
  attempts: number;
  attemptErrors?: ReadonlyArray<{ attempt: number; phase: string; error: string }>;
  portBase: number;
  portRange: number;
};

type BootstrapHarnessOptions = {
  fetchMock: ReturnType<typeof vi.fn>;
  superMcpUrl?: string;
  omitSuperMcpUrl?: boolean;
  superMcpStartupError?: SuperMcpStartupErrorFixture;
  triggerFirstRequest?: boolean;
};

async function bootstrapWithHarness(options: BootstrapHarnessOptions): Promise<{
  createHeadlessRuntimeMock: ReturnType<typeof vi.fn>;
  setStoreFactoryMock: ReturnType<typeof vi.fn>;
  fetchMock: ReturnType<typeof vi.fn>;
  sentryCaptureExceptionMock: ReturnType<typeof vi.fn>;
  sentryCaptureMessageMock: ReturnType<typeof vi.fn>;
}> {
  const runtimeSuperMcpUrl = options.omitSuperMcpUrl
    ? undefined
    : (options.superMcpUrl ?? 'https://super-mcp.example/mcp');
  vi.stubGlobal('fetch', options.fetchMock);

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
    ...(options.superMcpStartupError ? { superMcpStartupError: options.superMcpStartupError } : {}),
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

  const sentryCaptureExceptionMock = vi.fn();
  const sentryCaptureMessageMock = vi.fn();
  vi.doMock('@sentry/node', () => ({
    init: vi.fn(),
    captureException: sentryCaptureExceptionMock,
    captureMessage: sentryCaptureMessageMock,
    addBreadcrumb: vi.fn(),
    withScope: vi.fn(),
    flush: vi.fn(async () => true),
    // Stage 6b bootstrap sets global scope tags/context at module-eval time.
    setTag: vi.fn(),
    setContext: vi.fn(),
    setUser: vi.fn(),
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
  // Use the REAL shared `redactSensitiveString` so the bootstrap scrub helper's
  // secret/token redaction is exercised faithfully (the others stay identity —
  // they feed Sentry's beforeSend, which these tests do not drive).
  vi.doMock('../services/sentryRedaction', async () => {
    const actual = await vi.importActual<typeof import('@shared/utils/sentryRedaction')>(
      '@shared/utils/sentryRedaction',
    );
    return {
      redactObjectDeep: vi.fn((value: unknown) => value),
      redactSensitiveString: actual.redactSensitiveString,
      redactSentryEvent: vi.fn((value: unknown) => value),
    };
  });
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

  const { bootstrap } = await import('../bootstrap');
  await bootstrap();
  if (options.triggerFirstRequest !== false) {
    const { cloudBootstrapWarmup } = await import('../services/cloudBootstrapWarmup');
    cloudBootstrapWarmup.observeRequest('POST', '/api/sessions', false);
  }

  return {
    createHeadlessRuntimeMock,
    setStoreFactoryMock,
    fetchMock: options.fetchMock,
    sentryCaptureExceptionMock,
    sentryCaptureMessageMock,
  };
}

describe('cloud bootstrap search-tools warm-up', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();

    delete process.env.FLY_MACHINE_ID;
    delete process.env.REBEL_SURFACE;
    delete process.env.REBEL_MOCK_AGENT_TURNS;
    // Sentry is opt-in via SENTRY_DSN (bootstrap computes `cloudSentryEnabled`
    // at module load). The startup-failure / url-missing captures these tests
    // assert on only fire when Sentry is enabled, so stub a DSN before the
    // bootstrap import inside the harness. Set before the dynamic import so the
    // module-load-time `cloudSentryEnabled` const reads it.
    vi.stubEnv('SENTRY_DSN', 'https://[external-email]/0');
    process.env.REBEL_USER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'rebel-cloud-search-tools-warmup-'));
  });

  afterEach(() => {
    delete process.env.REBEL_SURFACE;
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('fires /api/tools warm-up only after first non-health request without blocking bootstrap', async () => {
    const pendingWarmup = new Promise<Response>(() => {});
    const fetchMock = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) => pendingWarmup);
    const { createHeadlessRuntimeMock, setStoreFactoryMock } = await bootstrapWithHarness({
      fetchMock,
    });

    expect(setStoreFactoryMock).toHaveBeenCalled();
    expect(createHeadlessRuntimeMock).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledWith('https://super-mcp.example/api/tools');
    });

    const runtimeInitOrder = createHeadlessRuntimeMock.mock.invocationCallOrder[0] ?? 0;
    const warmupFetchOrder = fetchMock.mock.invocationCallOrder[0] ?? 0;
    expect(warmupFetchOrder).toBeGreaterThan(runtimeInitOrder);
  });

  it('exercises real bootstrap() and confirms embedding warmup is not eager', async () => {
    const pendingWarmup = new Promise<Response>(() => {});
    const fetchMock = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) => pendingWarmup);
    const { CloudEmbeddingGenerator } = await import('../services/cloudEmbeddingGenerator');
    const warmupSpy = vi.spyOn(CloudEmbeddingGenerator.prototype, 'warmup');
    const initializeSpy = vi.spyOn(
      CloudEmbeddingGenerator.prototype as unknown as { initializePipeline: () => Promise<unknown> },
      'initializePipeline',
    );

    await bootstrapWithHarness({
      fetchMock,
      triggerFirstRequest: false,
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(warmupSpy).not.toHaveBeenCalled();
    expect(initializeSpy).not.toHaveBeenCalled();
  });

  it('treats non-2xx warm-up response as non-fatal and logs warn-level message', async () => {
    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchMock = vi.fn(async () => ({ ok: false, status: 404 }) as Response);

    await expect(bootstrapWithHarness({ fetchMock })).resolves.not.toThrow();

    await vi.waitFor(() => {
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining('super-mcp tool warmup non-2xx (will rebuild on first search)'),
        expect.objectContaining({
          'tools.warmup.status': 'http_404',
        })
      );
    });
  });

  it('treats rejected warm-up fetch as non-fatal and logs warn-level message', async () => {
    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchMock = vi.fn(async () => Promise.reject(new Error('network down')));

    await expect(bootstrapWithHarness({ fetchMock })).resolves.not.toThrow();

    await vi.waitFor(() => {
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining('super-mcp tool warmup failed (will rebuild on first search)'),
        expect.objectContaining({
          err: 'network down',
          'tools.warmup.status': 'error',
        })
      );
    });
  });

  it('skips warm-up fetch when runtime.superMcpUrl is undefined', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200 }) as Response);

    await expect(
      bootstrapWithHarness({
        fetchMock,
        omitSuperMcpUrl: true,
      })
    ).resolves.not.toThrow();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('captures a structured Super-MCP startup failure with scrubbed strings when startup failed', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200 }) as Response);

    const { sentryCaptureExceptionMock, fetchMock: returnedFetchMock } = await bootstrapWithHarness({
      fetchMock,
      omitSuperMcpUrl: true,
      superMcpStartupError: {
        lastError: 'health check failed at http://127.0.0.1:3100/mcp after reading /data/mcp/super-mcp-router.json',
        attempts: 3,
        attemptErrors: [
          { attempt: 1, phase: 'spawn-or-health-check', error: 'ECONNREFUSED 127.0.0.1:3100' },
          { attempt: 2, phase: 'configure', error: 'invalid config at /Users/someone/secret/config.json' },
        ],
        portBase: 3100,
        portRange: 25,
      },
    });

    // (a) exactly ONE structured startup-failure capture with the distinct tag.
    expect(sentryCaptureExceptionMock).toHaveBeenCalledTimes(1);
    const [capturedError, captureContext] = sentryCaptureExceptionMock.mock.calls[0] ?? [];
    expect(captureContext).toEqual(expect.objectContaining({
      level: 'error',
      tags: expect.objectContaining({
        area: 'startup',
        component: 'super-mcp',
        surface: 'cloud',
        startup_context: 'headless-runtime',
        event: 'cloud.super_mcp.startup_failed',
      }),
    }));
    // (c) NOT the warmup "missing URL" exception/tag.
    expect((captureContext as { tags?: { event?: string } })?.tags?.event)
      .not.toBe('cloud.warmup.tool_index.failed');

    // (b) the warmup fetch is still skipped (no superMcpUrl present).
    expect(returnedFetchMock).not.toHaveBeenCalled();

    // (d) the captured payload contains no raw host:port or absolute paths.
    const serialized = JSON.stringify({
      message: capturedError instanceof Error ? capturedError.message : String(capturedError),
      context: captureContext,
    });
    expect(serialized).not.toContain('127.0.0.1:3100');
    expect(serialized).not.toContain('127.0.0.1');
    expect(serialized).not.toContain('/data/mcp');
    expect(serialized).not.toContain('/Users/someone');
    // Useful failure-phase wording + counts are preserved.
    expect(serialized).toContain('<host:port>');
    expect(serialized).toContain('<path>');
    expect((captureContext as { extra?: { attempts?: number } })?.extra?.attempts).toBe(3);
  });

  it('emits an anomaly captureMessage when superMcpUrl is missing AND no startup error (F2)', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200 }) as Response);

    const { sentryCaptureExceptionMock, sentryCaptureMessageMock, fetchMock: returnedFetchMock } =
      await bootstrapWithHarness({
        fetchMock,
        omitSuperMcpUrl: true,
        // superMcpStartupError intentionally omitted → anomalous on cloud.
      });

    // The anomaly must NOT be silent: a distinct captureMessage fires.
    expect(sentryCaptureMessageMock).toHaveBeenCalledTimes(1);
    const [message, messageContext] = sentryCaptureMessageMock.mock.calls[0] ?? [];
    expect(message).toBe('Super-MCP URL unavailable with no startup error (unexpected on cloud)');
    expect(messageContext).toEqual(expect.objectContaining({
      tags: expect.objectContaining({
        area: 'startup',
        component: 'super-mcp',
        surface: 'cloud',
        startup_context: 'headless-runtime',
        event: 'cloud.super_mcp.url_missing_no_error',
      }),
    }));

    // No startup-failure exception and no warmup fetch in this branch.
    expect(sentryCaptureExceptionMock).not.toHaveBeenCalled();
    expect(returnedFetchMock).not.toHaveBeenCalled();
  });

  it('scrubs IPv6/IPv4 host:port, absolute paths, and secret tokens in the captured payload (F1)', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200 }) as Response);
    const fakeBearer = 'Bearer abc123FAKEtokenXYZ987';

    const { sentryCaptureExceptionMock } = await bootstrapWithHarness({
      fetchMock,
      omitSuperMcpUrl: true,
      superMcpStartupError: {
        lastError: `auth ${fakeBearer} failed at [::1]:3100 and 127.0.0.1:3100 reading /data/secrets/key.json`,
        attempts: 2,
        attemptErrors: [
          { attempt: 1, phase: 'spawn-or-health-check', error: 'health timeout at [fe80::1]:8080' },
        ],
        portBase: 3100,
        portRange: 25,
      },
    });

    expect(sentryCaptureExceptionMock).toHaveBeenCalledTimes(1);
    const [capturedError, captureContext] = sentryCaptureExceptionMock.mock.calls[0] ?? [];
    const serialized = JSON.stringify({
      message: capturedError instanceof Error ? capturedError.message : String(capturedError),
      context: captureContext,
    });

    // host:port forms — IPv4 + bracketed IPv6 — all collapsed.
    expect(serialized).not.toContain('127.0.0.1:3100');
    expect(serialized).not.toContain('[::1]:3100');
    expect(serialized).not.toContain('[fe80::1]:8080');
    expect(serialized).toContain('<host:port>');
    // Absolute path scrubbed.
    expect(serialized).not.toContain('/data/secrets');
    expect(serialized).toContain('<path>');
    // Secret/bearer token redacted by the shared redactor (not leaked).
    expect(serialized).not.toContain('abc123FAKEtokenXYZ987');
    expect(serialized).toContain('REDACTED');
  });
});
