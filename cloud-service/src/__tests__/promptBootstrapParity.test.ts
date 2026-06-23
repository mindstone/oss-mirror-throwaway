/**
 * Cloud prompt-config bootstrap parity (REBEL-64K, spun out of REBEL-63K).
 *
 * Stage 3 wires `configurePromptFileService(getSystemSettingsPath()/prompts)` +
 * `warmAllPrompts()` into cloud `bootstrap()`, mirroring desktop coreStartup §4b,
 * guarded by a non-fatal try/catch (the analytics-init guard posture). This test
 * proves three contracts:
 *
 *  (a) PARITY — under cloud-style PlatformConfig (surface:'cloud', isPackaged:false)
 *      pointed at the repo's real `rebel-system`, the configure call resolves the
 *      prompts root to `<root>/rebel-system/prompts` and a forager read succeeds.
 *      This is the path the Fly image takes (IS_CLOUD_SERVICE=1 → dev-mode →
 *      WORKDIR /app → /app/rebel-system/prompts; see bootstrap.ts prompt block +
 *      cloud-service/Dockerfile `COPY rebel-system/ rebel-system/`).
 *
 *  (b) NON-FATAL CONTRACT — with PlatformConfig UNWIRED (the deliberate state the
 *      cloud bootstrap test harnesses run bootstrap() in: they `vi.resetModules()`
 *      before importing ../bootstrap, so the freshly re-evaluated `@core/platform`
 *      has `_config === undefined`), `getSystemSettingsPath()` throws
 *      'PlatformConfig not initialized'. The bootstrap try/catch swallows it
 *      (logged loud), so boot still resolves. We assert the throw here so the
 *      guard is provably load-bearing; the full `bootstrap()`-resolves-unwired
 *      assertion lives in bootstrap.headlessRuntime.test.ts (the regression guard
 *      this Stage must not break).
 *
 *  (c) WIRING PIN (F1) — the integration-shaped guard. Contracts (a)/(b) exercise
 *      the configure/warm HELPERS directly; if the wiring block in bootstrap.ts
 *      were deleted, they would still pass. This contract wires a cloud-style
 *      PlatformConfig (pointed at the real repo root) and runs the FULL mocked
 *      `bootstrap()` (the same ~40-mock harness pattern as
 *      toolIndexBootstrap.test.ts / bootstrap.headlessRuntime.test.ts, but WIRED
 *      — those run UNWIRED by design), then asserts `getPromptsRootPath()` equals
 *      the wired prompts root. That state is set ONLY by the configure call inside
 *      bootstrap()'s prompt block, so the assertion proves the block actually ran
 *      from bootstrap() — deleting it makes this test fail.
 *
 * @see cloud-service/src/bootstrap.ts (the guarded configure+warm block)
 * @see cloud-service/src/__tests__/toolIndexBootstrap.test.ts (the harness pattern)
 * @see src/main/services/coreStartup.ts §4b (desktop reference pattern)
 * @see docs/plans/260618_cloud-prompt-bootstrap-parity/PLAN.md
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PlatformConfigInput } from '@core/platform';

// Repo root = three levels up from cloud-service/src/__tests__/.
const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..', '..');
const REAL_PROMPTS_DIR = path.join(REPO_ROOT, 'rebel-system', 'prompts');

// Contracts (a) and (c) below exercise prompt resolution against the REAL
// `rebel-system/prompts` content (the Dockerfile-COPY parity surface). That dir
// only exists when the `rebel-system` submodule is checked out — true locally
// and in cloud-ci (which now does a targeted `rebel-system` checkout), but NOT
// in a tokenless fork-PR checkout. When it is absent we SKIP those two contracts
// rather than red the suite on a missing fixture — but loudly, so a degraded
// run is never mistaken for real coverage. (b)/(F3) are submodule-independent.
// See .github/workflows/cloud-ci.yml (rebel-system submodule step) +
// docs/plans/260621_cloud-ci-submodule-parity/PLAN.md.
const HAS_REAL_PROMPTS = fs.existsSync(REAL_PROMPTS_DIR);
if (!HAS_REAL_PROMPTS) {
  // Loud, intentional degraded-coverage signal (not a swallowed failure).
  console.warn(
    `[promptBootstrapParity] rebel-system/prompts absent at ${REAL_PROMPTS_DIR} — ` +
      `SKIPPING real-prompt parity contracts (a)/(c). This is expected only in a ` +
      `submodule-less checkout (e.g. tokenless fork PR); cloud-ci checks out ` +
      `rebel-system so it must NOT skip there.`,
  );
}

function cloudPlatformConfig(appPath: string): PlatformConfigInput {
  return {
    userDataPath: path.join(appPath, '.tmp-cloud-prompt-parity'),
    appPath,
    tempPath: '/tmp',
    logsPath: path.join(appPath, '.tmp-cloud-prompt-parity', 'logs'),
    homePath: '/tmp',
    documentsPath: '/tmp',
    desktopPath: '/tmp',
    appDataPath: path.join(appPath, '.tmp-cloud-prompt-parity'),
    version: 'test',
    isPackaged: false,
    platform: process.platform,
    totalMemoryBytes: 8 * 1024 * 1024 * 1024,
    arch: process.arch,
    surface: 'cloud',
    isOss: false,
  };
}

describe('cloud prompt-config bootstrap parity', () => {
  let priorCloudServiceEnv: string | undefined;
  let priorAppRootEnv: string | undefined;
  let priorUserDataEnv: string | undefined;

  beforeEach(() => {
    priorCloudServiceEnv = process.env.IS_CLOUD_SERVICE;
    priorAppRootEnv = process.env.REBEL_APP_ROOT;
    priorUserDataEnv = process.env.REBEL_USER_DATA;
    // The cloud-service vitest project does not set IS_CLOUD_SERVICE, so
    // isPackaged() reads PlatformConfig.isPackaged (false) → dev-mode submodule
    // resolution, mirroring the Fly image's IS_CLOUD_SERVICE=1 dev-mode path.
    delete process.env.IS_CLOUD_SERVICE;
  });

  afterEach(() => {
    if (priorCloudServiceEnv === undefined) delete process.env.IS_CLOUD_SERVICE;
    else process.env.IS_CLOUD_SERVICE = priorCloudServiceEnv;
    if (priorAppRootEnv === undefined) delete process.env.REBEL_APP_ROOT;
    else process.env.REBEL_APP_ROOT = priorAppRootEnv;
    if (priorUserDataEnv === undefined) delete process.env.REBEL_USER_DATA;
    else process.env.REBEL_USER_DATA = priorUserDataEnv;
    vi.resetModules();
  });

  it('(b) getSystemSettingsPath() throws when PlatformConfig is unwired — proving the bootstrap guard is load-bearing', async () => {
    // Replicate the bootstrap harnesses exactly: reset modules so the freshly
    // re-evaluated @core/platform has `_config === undefined` (the global
    // vitest.setup.ts setPlatformConfig() ran against the PRE-reset instance).
    vi.resetModules();
    // Also remove the env escape hatches so the accessor must read PlatformConfig.
    delete process.env.REBEL_APP_ROOT;
    delete process.env.REBEL_USER_DATA;
    const { getSystemSettingsPath } = await import('@core/services/systemSettingsSync');
    expect(() => getSystemSettingsPath()).toThrow(/PlatformConfig not initialized/);
  });

  it.skipIf(!HAS_REAL_PROMPTS)('(a) configure→warm→read works under cloud-style PlatformConfig resolution', async () => {
    // Sanity: the checkout actually ships rebel-system/prompts (Dockerfile
    // COPY parity). Guarded by skipIf(HAS_REAL_PROMPTS) above, so reaching here
    // means the submodule is present; this assert is the in-test confirmation.
    expect(fs.existsSync(REAL_PROMPTS_DIR)).toBe(true);

    // Fresh module graph, then wire a cloud-style PlatformConfig pointed at the
    // repo root so getSubmodulePath() finds the real rebel-system. Pin
    // REBEL_APP_ROOT too (getAppRoot() prefers it) for cwd-independence.
    vi.resetModules();
    process.env.REBEL_APP_ROOT = REPO_ROOT;
    const { setPlatformConfig } = await import('@core/platform');
    setPlatformConfig(cloudPlatformConfig(REPO_ROOT));

    const { getSystemSettingsPath } = await import('@core/services/systemSettingsSync');
    const {
      configurePromptFileService,
      warmAllPrompts,
      getPromptsRootPath,
      getRawPrompt,
      PROMPT_IDS,
      _resetForTesting,
    } = await import('@core/services/promptFileService');
    _resetForTesting();

    // Mirror exactly what bootstrap() now does. warmAllPrompts() now returns a
    // structured PromptWarmOutcome (additive); on this real-prompts path every
    // critical prompt loads, so criticalFailed is 0 and failures is empty.
    const promptsPath = path.join(getSystemSettingsPath(), 'prompts');
    configurePromptFileService(promptsPath);
    const outcome = await warmAllPrompts();
    expect(outcome.criticalFailed).toBe(0);
    expect(outcome.failures).toEqual([]);
    expect(outcome.warmed).toBeGreaterThan(0);

    // The configured root must be the Docker-shipped rebel-system/prompts dir.
    const root = getPromptsRootPath();
    expect(root).not.toBeNull();
    expect(root && root.split(path.sep).join('/')).toMatch(/rebel-system\/prompts$/);

    // A forager read must succeed against the real, shipped prompt file —
    // proving the configured root actually serves prompts on cloud.
    const foragerPrompt = getRawPrompt(PROMPT_IDS.AGENT_FORAGER);
    expect(foragerPrompt.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// (c) WIRING PIN (F1) — runs the FULL mocked bootstrap() with PlatformConfig
//     WIRED and asserts the prompt block ran from inside bootstrap(). Distinct
//     describe so its heavyweight mock/env setup is isolated from contracts
//     (a)/(b) above. Mock set mirrors toolIndexBootstrap.test.ts /
//     bootstrap.headlessRuntime.test.ts (the minimal set that makes bootstrap()
//     resolve), with the one difference that we call setPlatformConfig() AFTER
//     vi.resetModules() and BEFORE importing ../bootstrap.
// ---------------------------------------------------------------------------

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

/** Apply the shared cloud-bootstrap mock set (mirrors the existing harnesses). */
function applyBootstrapMocks(): void {
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
    setTag: vi.fn(),
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
  vi.doMock('@core/storeFactory', () => ({ setStoreFactory: vi.fn() }));
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
  vi.doMock('@core/featureGating', () => ({ setLicenseTier: vi.fn(), getLicenseTier: vi.fn(() => 'pro') }));
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
    cloudEventBroadcaster: { broadcast: vi.fn(), virtualWindow: {} },
  }));
  vi.doMock('../services/cloudDiagnosticEventsLedger', () => ({
    cloudDiagnosticEventsLedgerReader: {},
    cloudDiagnosticEventsLedgerWriter: {},
  }));
  vi.doMock('@core/services/settingsStore/index', () => ({
    ensureNormalizedSettings: vi.fn(),
    getSettings: vi.fn(() => ({ coreDirectory: path.join(process.env.REBEL_USER_DATA ?? '', 'workspace') })),
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
    createHeadlessRuntime: vi.fn(async () => ({
      startAgentTurn: vi.fn(() => ({ turnId: 'runtime-turn' })),
      runTurn: vi.fn(),
      setEventListener: vi.fn(),
      deleteEventListener: vi.fn(),
      getAbortController: vi.fn(),
      getTurnCloseCallback: vi.fn(),
      getSettings: vi.fn(),
      updateSettings: vi.fn(),
      cleanup: vi.fn(async () => undefined),
    })),
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
  vi.doMock('@core/services/inboxStore', () => ({ onInboxStateChange: vi.fn() }));
  vi.doMock('@core/services/safety/toolSafetyService', () => ({ handleApprovalResponse: vi.fn() }));
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
    initializeToolIndex: vi.fn(async () => undefined),
    refreshToolIndex: vi.fn(async () => ({ success: true, added: 0, updated: 0, removed: 0, total: 0 })),
    refreshToolIndexFromCatalogData: vi.fn(async () => ({ success: true, added: 0, updated: 0, removed: 0, total: 0 })),
    markToolIndexInvalidated: vi.fn(() => 0),
    markToolIndexRefreshComplete: vi.fn(),
    rollbackToolIndexInvalidation: vi.fn(),
    getToolIndexStatus: vi.fn(() => ({ isInitialized: false, toolCount: 0 })),
    searchTools: vi.fn(async () => []),
    hasToolIndex: vi.fn(() => false),
  }));
}

describe('cloud prompt-config bootstrap WIRING pin (F1)', () => {
  const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..', '..');
  let priorCloudServiceEnv: string | undefined;
  let priorAppRootEnv: string | undefined;
  let priorUserDataEnv: string | undefined;
  let priorSurfaceEnv: string | undefined;
  let priorMachineEnv: string | undefined;
  let priorMockTurnsEnv: string | undefined;

  beforeEach(() => {
    priorCloudServiceEnv = process.env.IS_CLOUD_SERVICE;
    priorAppRootEnv = process.env.REBEL_APP_ROOT;
    priorUserDataEnv = process.env.REBEL_USER_DATA;
    priorSurfaceEnv = process.env.REBEL_SURFACE;
    priorMachineEnv = process.env.FLY_MACHINE_ID;
    priorMockTurnsEnv = process.env.REBEL_MOCK_AGENT_TURNS;

    vi.resetModules();
    vi.restoreAllMocks();
    // Mirror the existing harnesses' env posture.
    delete process.env.IS_CLOUD_SERVICE;
    delete process.env.FLY_MACHINE_ID;
    delete process.env.REBEL_SURFACE;
    delete process.env.REBEL_MOCK_AGENT_TURNS;
    process.env.REBEL_USER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'rebel-cloud-prompt-wiring-'));
  });

  afterEach(() => {
    const restore = (key: string, value: string | undefined): void => {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    };
    restore('IS_CLOUD_SERVICE', priorCloudServiceEnv);
    restore('REBEL_APP_ROOT', priorAppRootEnv);
    restore('REBEL_USER_DATA', priorUserDataEnv);
    restore('REBEL_SURFACE', priorSurfaceEnv);
    restore('FLY_MACHINE_ID', priorMachineEnv);
    restore('REBEL_MOCK_AGENT_TURNS', priorMockTurnsEnv);
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it.skipIf(!HAS_REAL_PROMPTS)('bootstrap() itself configures the prompt service when PlatformConfig is wired (deleting the wiring block fails this test)', async () => {
    // WIRE PlatformConfig AFTER vi.resetModules() and BEFORE importing
    // ../bootstrap, pointing at the real repo root so getSystemSettingsPath() →
    // <root>/rebel-system, and pin REBEL_APP_ROOT so getAppRoot() is
    // cwd-independent. This is the one difference from the UNWIRED harnesses.
    process.env.REBEL_APP_ROOT = REPO_ROOT;
    const { setPlatformConfig } = await import('@core/platform');
    setPlatformConfig({
      userDataPath: process.env.REBEL_USER_DATA as string,
      appPath: REPO_ROOT,
      tempPath: os.tmpdir(),
      logsPath: path.join(process.env.REBEL_USER_DATA as string, 'logs'),
      homePath: os.tmpdir(),
      documentsPath: os.tmpdir(),
      desktopPath: os.tmpdir(),
      appDataPath: process.env.REBEL_USER_DATA as string,
      version: 'test',
      isPackaged: false,
      platform: process.platform,
      totalMemoryBytes: 8 * 1024 * 1024 * 1024,
      arch: process.arch,
      surface: 'cloud',
      isOss: false,
    });

    // The prompt service singleton lives in the freshly re-evaluated module
    // graph (post-resetModules). Reset its state so we observe ONLY what
    // bootstrap() does to it. Import the SAME module instance bootstrap() will
    // use (no second resetModules between here and the bootstrap import).
    const { getPromptsRootPath, _resetForTesting } = await import('@core/services/promptFileService');
    _resetForTesting();
    expect(getPromptsRootPath()).toBeNull();

    applyBootstrapMocks();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ tools: [] }) }) as Response),
    );

    const { bootstrap } = await import('../bootstrap');
    const deps = await bootstrap();

    // The prompt block in bootstrap() ran configurePromptFileService(
    // getSystemSettingsPath()/prompts). That is the ONLY writer of
    // promptsRootPath in this flow, so a non-null root ending in
    // rebel-system/prompts proves the wiring block executed from bootstrap().
    const root = getPromptsRootPath();
    expect(root).not.toBeNull();
    expect(root && root.split(path.sep).join('/')).toMatch(/rebel-system\/prompts$/);

    await deps.cleanup?.();
  });

  it('(F3) unwired bootstrap logs the prompt-warm catch at WARN (skipped_unwired), NOT error', async () => {
    // F3: the catch must split BY ERROR REASON. With PlatformConfig UNWIRED,
    // getSystemSettingsPath() throws 'PlatformConfig not initialized' — the
    // EXPECTED harness state — so the catch logs at warn (event
    // 'cloud.prompt_warm.skipped_unwired'), not error. A real warm failure
    // (any other reason) would still be loud (event 'cloud.prompt_warm.failed').
    // We do NOT call setPlatformConfig() here (the deliberate unwired state).
    //
    // Capture log calls by partially mocking @core/logger: keep every real
    // export (faithful — bootstrap's graph imports many of them) and only wrap
    // createScopedLogger to record (level, payload) before delegating to the
    // real child logger, so behaviour is unchanged.
    type LogCall = { level: string; payload: Record<string, unknown> | undefined };
    const logCalls: LogCall[] = [];
    vi.doMock('@core/logger', async (importOriginal) => {
      const actual = await importOriginal<typeof import('@core/logger')>();
      const recordingLevels = new Set(['warn', 'error', 'info', 'debug', 'trace', 'fatal']);
      return {
        ...actual,
        createScopedLogger: (bindings: Record<string, unknown>) => {
          const real = actual.createScopedLogger(bindings) as unknown as Record<string, unknown>;
          return new Proxy(real, {
            get(target, prop) {
              const value = target[prop as string];
              if (typeof prop === 'string' && recordingLevels.has(prop) && typeof value === 'function') {
                return (...args: unknown[]) => {
                  const payload = typeof args[0] === 'object' && args[0] !== null
                    ? (args[0] as Record<string, unknown>)
                    : undefined;
                  logCalls.push({ level: prop, payload });
                  return (value as (...a: unknown[]) => unknown).apply(target, args);
                };
              }
              if (typeof value === 'function') return (value as (...a: unknown[]) => unknown).bind(target);
              return value;
            },
          });
        },
      };
    });

    applyBootstrapMocks();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ tools: [] }) }) as Response),
    );

    const { bootstrap } = await import('../bootstrap');
    const deps = await bootstrap();

    const promptWarmCalls = logCalls.filter((c) => {
      const event = c.payload?.event;
      return event === 'cloud.prompt_warm.skipped_unwired' || event === 'cloud.prompt_warm.failed';
    });
    // Exactly one prompt-warm catch log, and it must be the WARN/skipped variant.
    expect(promptWarmCalls).toHaveLength(1);
    expect(promptWarmCalls[0].level).toBe('warn');
    expect(promptWarmCalls[0].payload?.event).toBe('cloud.prompt_warm.skipped_unwired');
    // The reason must be the unwired-PlatformConfig throw (proving the branch).
    expect(String(promptWarmCalls[0].payload?.reason)).toMatch(/PlatformConfig not initialized/);
    // And the loud error variant must NOT have fired for the prompt block.
    const errorFailures = logCalls.filter(
      (c) => c.level === 'error' && c.payload?.event === 'cloud.prompt_warm.failed',
    );
    expect(errorFailures).toEqual([]);

    await deps.cleanup?.();
  });
});
