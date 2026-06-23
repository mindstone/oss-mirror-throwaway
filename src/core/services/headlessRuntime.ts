import type { EventWindow } from '@core/types';
import type { AgentEvent, AgentSession, AgentTurnRequest, AppSettings } from '@shared/types';
import type { HeadlessTurnOptions } from '@core/types/headlessTurnOptions';
import type { AgentTurnServiceDeps, StartAgentTurnResult } from './agentTurnService';

type ExecuteAgentTurn = AgentTurnServiceDeps['executeAgentTurn'];
type ExecuteAgentTurnWithRecovery = NonNullable<AgentTurnServiceDeps['executeAgentTurnWithRecovery']>;
type AgentLoopOptions = Parameters<ExecuteAgentTurnWithRecovery>[3];
type RuntimePreToolHook = AgentLoopOptions['mcpDenyHook'];
type RuntimeMemoryWriteHook = AgentLoopOptions['memoryWriteHook'];
type StartAgentTurn = (
  deps: AgentTurnServiceDeps,
  request: AgentTurnRequest,
  win: EventWindow | null,
) => StartAgentTurnResult;
type RunHeadlessTurn = (params: {
  prompt: string;
  onEvent: (event: AgentEvent) => void;
  options: HeadlessTurnOptions;
}) => Promise<void>;
type ConfigureHeadlessTurnExecutor = (executeAgentTurn: ExecuteAgentTurn) => void;
type DispatchAgentEvent = AgentTurnServiceDeps['dispatchAgentEvent'];

interface AgentTurnRegistryLike {
  setEventListener(turnId: string, listener: (event: AgentEvent) => void): void;
  deleteEventListener(turnId: string): boolean;
  getActiveTurnController(turnId: string): AbortController | undefined;
  getTurnCloseCallback(turnId: string): (() => void) | undefined;
  deleteRendererSession(turnId: string): void;
  cancelExistingTurnForSession(sessionId: string): string | undefined;
  getActiveTurnForSession(sessionId: string): string | undefined;
  abortAllTurns(): void;
  getActiveTurnCount?: () => number;
}

interface SuperMcpHttpManagerLike {
  getState(): { isRunning?: boolean; port?: number | null; url?: string | null };
}

type StartSuperMcpAttemptPhase = 'port-finder' | 'configure' | 'spawn-or-health-check' | 'unknown';

type StartSuperMcpWithRetries = (
  configPath: string,
  options?: {
    logContext?: string;
    force?: boolean;
    preferredPort?: number;
    portRange?: number;
    startupTimeoutMs?: number;
  },
) => Promise<{
  success: boolean;
  port?: number | null;
  attempts?: number;
  error?: string;
  lastError?: string;
  lastErrorObj?: unknown;
  attemptErrors?: ReadonlyArray<{
    attempt: number;
    phase: StartSuperMcpAttemptPhase;
    error: string;
  }>;
}>;

type FindAvailablePort = (
  preferredPort: number,
  maxAttempts?: number,
) => Promise<{ port: number; conflicted: boolean }>;

interface HeadlessCoreStartupDeps {
  userDataDir: string;
  resourcesDir: string;
  isPackaged: boolean;
  routerConfigPath: string;
  getSettings: () => AppSettings;
  getAutomationScheduler?: () => unknown;
  getMeetingBotService?: () => unknown;
  memoryUpdateDeps?: unknown;
  errorRecoveryDeps?: unknown;
}

type InitCoreServices = (deps: HeadlessCoreStartupDeps) => Promise<unknown>;

interface ProxyManagerLike {
  stop(): Promise<void> | void;
}

interface HeadlessRuntimeDeps {
  executeAgentTurn: ExecuteAgentTurn;
  startAgentTurn: StartAgentTurn;
  runHeadlessTurn: RunHeadlessTurn;
  configureHeadlessTurnExecutor: ConfigureHeadlessTurnExecutor;
  agentTurnRegistry: AgentTurnRegistryLike;
  dispatchAgentEvent: DispatchAgentEvent;
  superMcpHttpManager: SuperMcpHttpManagerLike;
  stopSuperMcpForHeadlessCleanup: () => Promise<void> | void;
  findAvailablePort: FindAvailablePort;
  startSuperMcpWithRetries: StartSuperMcpWithRetries;
  initCoreServices: InitCoreServices;
  setMcpDisabled: (disabled: boolean) => void;
  registerPreOAuthCallHook: (hook: () => Promise<void>) => void;
  setMigrationComplete: (complete: boolean) => void;
  stopBundledInboxBridge: () => Promise<void> | void;
  closeFileIndex: () => Promise<void> | void;
  proxyManager: ProxyManagerLike;
}

export interface HeadlessRuntimeConfig {
  userDataDir: string;
  resourcesDir: string;
  isPackaged: boolean;
  routerConfigPath: string;
  getSettings: () => AppSettings;
  updateSettings: (partial: Partial<AppSettings>) => void;
  win?: EventWindow | null;
  loadAgentSessions?: () => AgentSession[];
  getAutomationScheduler?: () => unknown;
  getMeetingBotService?: () => unknown;
  memoryUpdateDeps?: unknown;
  errorRecoveryDeps?: unknown;
  /**
   * Overrides the default agent executor loaded from the desktop runtime.
   * Evals use this to inject their bash-blocking hook chain, and future
   * surfaces can use it to wrap execution without reaching into __testOverrides.
   */
  executeAgentTurn?: ExecuteAgentTurn;
  /**
   * Optional context-overflow recovery wrapper for surfaces that need recovery
   * semantics around executeAgentTurn. Cloud wires its recovery adapter here.
   */
  executeAgentTurnWithRecovery?: ExecuteAgentTurnWithRecovery;
  /**
   * Required OAuth-refresh hook invoked before behind-the-scenes OAuth calls.
   * Each surface must explicitly wire its token-refresh behavior to avoid
   * silently losing BTS refresh in headless migrations.
   */
  preOAuthCallHook: () => Promise<void>;
  /**
   * Surface-owned PreToolUse hook wired to AgentLoopOptions.mcpDenyHook.
   * Used by evals for bash blocking / hermetic MCP denial and by memory-update
   * turns to deny MCP calls before normal tool execution.
   */
  preToolHook?: RuntimePreToolHook;
  /**
   * Surface-owned memory-write hook wired to AgentLoopOptions.memoryWriteHook.
   * Kept separate from preToolHook because production distinguishes memory-write
   * staging from generic PreToolUse/MCP denial.
   */
  memoryWriteHook?: RuntimeMemoryWriteHook;
  skipMcp?: boolean;
  waitForSuperMcpReady?: (url: string) => Promise<void>;
  superMcpPortBase?: number;
  superMcpPortRange?: number;
  superMcpTimeoutMs?: number;
  afterCoreStartup?: () => Promise<void> | void;
  turnDrainTimeoutMs?: number;
  __testOverrides?: Partial<HeadlessRuntimeDeps>;
}

/**
 * Diagnostic snapshot of a Super-MCP startup failure, surfaced on
 * `HeadlessRuntime.superMcpStartupError` whenever `superMcpUrl` is undefined
 * AND `skipMcp !== true`. Lets surface code (eval bootstrap, cloud, etc.)
 * report the actual cause to operators instead of guessing at hard-coded
 * common-cause hints.
 */
export interface SuperMcpStartupErrorInfo {
  lastError: string;
  attempts: number;
  attemptErrors?: ReadonlyArray<{
    attempt: number;
    phase: 'port-finder' | 'configure' | 'spawn-or-health-check' | 'unknown';
    error: string;
  }>;
  portBase: number;
  portRange: number;
}

export interface HeadlessRuntime {
  startAgentTurn: (request: AgentTurnRequest, win?: EventWindow | null) => StartAgentTurnResult;
  runTurn: RunHeadlessTurn;
  setEventListener: AgentTurnRegistryLike['setEventListener'];
  deleteEventListener: AgentTurnRegistryLike['deleteEventListener'];
  getAbortController: AgentTurnRegistryLike['getActiveTurnController'];
  getTurnCloseCallback: AgentTurnRegistryLike['getTurnCloseCallback'];
  getSettings: () => AppSettings;
  updateSettings: (partial: Partial<AppSettings>) => void;
  cleanup: () => Promise<void>;
  superMcpUrl?: string;
  superMcpStartupError?: SuperMcpStartupErrorInfo;
}

let singletonRuntime: HeadlessRuntime | null = null;
let singletonCreating = false;

const DEFAULT_SUPER_MCP_PORT_BASE = 3100;
const DEFAULT_SUPER_MCP_PORT_RANGE = 25;
const DEFAULT_SUPER_MCP_TIMEOUT_MS = 30_000;
const DEFAULT_TURN_DRAIN_TIMEOUT_MS = 5_000;

const moduleLoaders: Record<string, () => Promise<unknown>> = {
  '@main/services/agentTurnExecutor': () => import('@main/services/agentTurnExecutor'),
  '@core/services/agentTurnService': () => import('@core/services/agentTurnService'),
  '@core/services/turnPipeline/headlessTurnRunner': () => import('@core/services/turnPipeline/headlessTurnRunner'),
  '@core/services/agentTurnRegistry': () => import('@core/services/agentTurnRegistry'),
  '@core/services/agentEventDispatcher': () => import('@core/services/agentEventDispatcher'),
  '@core/services/superMcpHttpManager': () => import('@core/services/superMcpHttpManager'),
  '@main/services/coreStartup': () => import('@main/services/coreStartup'),
  '@main/services/mcpService': () => import('@main/services/mcpService'),
  '@core/services/behindTheScenesClient': () => import('@core/services/behindTheScenesClient'),
  '@core/safetyPromptStore': () => import('@core/safetyPromptStore'),
  '@main/services/bundledInboxBridge': () => import('@main/services/bundledInboxBridge'),
  '@main/services/fileIndexService': () => import('@main/services/fileIndexService'),
  '@main/services/localModelProxyServer': () => import('@main/services/localModelProxyServer'),
};

const importModule = async <T>(specifier: string): Promise<T> => {
  const loader = moduleLoaders[specifier];
  return (loader ? loader() : import(specifier)) as Promise<T>;
};

const requireLoaded = <T>(module: T | null, name: string): T => {
  if (module === null) {
    throw new Error(`createHeadlessRuntime missing dependency: ${name}`);
  }
  return module;
};

const loadDeps = async (overrides: Partial<HeadlessRuntimeDeps> = {}): Promise<HeadlessRuntimeDeps> => {
  const [
    agentTurnExecutorMod,
    agentTurnServiceMod,
    headlessTurnRunnerMod,
    agentTurnRegistryMod,
    agentEventDispatcherMod,
    superMcpHttpManagerMod,
    coreStartupMod,
    mcpServiceMod,
    behindTheScenesClientMod,
    safetyPromptStoreMod,
    bundledInboxBridgeMod,
    fileIndexServiceMod,
    localModelProxyServerMod,
  ] = await Promise.all([
    overrides.executeAgentTurn ? Promise.resolve(null) : importModule<{ executeAgentTurn: ExecuteAgentTurn }>('@main/services/agentTurnExecutor'),
    overrides.startAgentTurn ? Promise.resolve(null) : importModule<{ startAgentTurn: StartAgentTurn }>('@core/services/agentTurnService'),
    overrides.runHeadlessTurn && overrides.configureHeadlessTurnExecutor
      ? Promise.resolve(null)
      : importModule<{
        runHeadlessTurn: RunHeadlessTurn;
        configureHeadlessTurnExecutor: ConfigureHeadlessTurnExecutor;
      }>('@core/services/turnPipeline/headlessTurnRunner'),
    overrides.agentTurnRegistry ? Promise.resolve(null) : importModule<{ agentTurnRegistry: AgentTurnRegistryLike }>('@core/services/agentTurnRegistry'),
    overrides.dispatchAgentEvent ? Promise.resolve(null) : importModule<{ dispatchAgentEvent: DispatchAgentEvent }>('@core/services/agentEventDispatcher'),
    overrides.superMcpHttpManager
      && overrides.stopSuperMcpForHeadlessCleanup
      && overrides.findAvailablePort
      && overrides.startSuperMcpWithRetries
      ? Promise.resolve(null)
      : importModule<{
        superMcpHttpManager: SuperMcpHttpManagerLike;
        stopSuperMcpForHeadlessCleanup: () => Promise<void> | void;
        findAvailablePort: FindAvailablePort;
        startSuperMcpWithRetries: StartSuperMcpWithRetries;
      }>('@core/services/superMcpHttpManager'),
    overrides.initCoreServices ? Promise.resolve(null) : importModule<{ initCoreServices: InitCoreServices }>('@main/services/coreStartup'),
    overrides.setMcpDisabled
      ? Promise.resolve(null)
      : importModule<{ setMcpDisabled: (disabled: boolean) => void }>('@main/services/mcpService'),
    overrides.registerPreOAuthCallHook
      ? Promise.resolve(null)
      : importModule<{ registerPreOAuthCallHook: (hook: () => Promise<void>) => void }>('@core/services/behindTheScenesClient'),
    overrides.setMigrationComplete
      ? Promise.resolve(null)
      : importModule<{ setMigrationComplete: (complete: boolean) => void }>('@core/safetyPromptStore'),
    overrides.stopBundledInboxBridge
      ? Promise.resolve(null)
      : importModule<{ stopBundledInboxBridge: () => Promise<void> | void }>('@main/services/bundledInboxBridge'),
    overrides.closeFileIndex
      ? Promise.resolve(null)
      : importModule<{ closeIndex: () => Promise<void> | void }>('@main/services/fileIndexService'),
    overrides.proxyManager
      ? Promise.resolve(null)
      : importModule<{ proxyManager: ProxyManagerLike }>('@main/services/localModelProxyServer'),
  ]);

  return {
    executeAgentTurn: overrides.executeAgentTurn ?? requireLoaded(agentTurnExecutorMod, 'agentTurnExecutor').executeAgentTurn,
    startAgentTurn: overrides.startAgentTurn ?? requireLoaded(agentTurnServiceMod, 'agentTurnService').startAgentTurn,
    runHeadlessTurn: overrides.runHeadlessTurn ?? requireLoaded(headlessTurnRunnerMod, 'headlessTurnRunner').runHeadlessTurn,
    configureHeadlessTurnExecutor: overrides.configureHeadlessTurnExecutor ?? requireLoaded(headlessTurnRunnerMod, 'headlessTurnRunner').configureHeadlessTurnExecutor,
    agentTurnRegistry: overrides.agentTurnRegistry ?? requireLoaded(agentTurnRegistryMod, 'agentTurnRegistry').agentTurnRegistry,
    dispatchAgentEvent: overrides.dispatchAgentEvent ?? requireLoaded(agentEventDispatcherMod, 'agentEventDispatcher').dispatchAgentEvent,
    superMcpHttpManager: overrides.superMcpHttpManager ?? requireLoaded(superMcpHttpManagerMod, 'superMcpHttpManager').superMcpHttpManager,
    stopSuperMcpForHeadlessCleanup: overrides.stopSuperMcpForHeadlessCleanup
      ?? requireLoaded(superMcpHttpManagerMod, 'superMcpHttpManager').stopSuperMcpForHeadlessCleanup,
    findAvailablePort: overrides.findAvailablePort ?? requireLoaded(superMcpHttpManagerMod, 'superMcpHttpManager').findAvailablePort,
    startSuperMcpWithRetries: overrides.startSuperMcpWithRetries ?? requireLoaded(superMcpHttpManagerMod, 'superMcpHttpManager').startSuperMcpWithRetries,
    initCoreServices: overrides.initCoreServices ?? requireLoaded(coreStartupMod, 'coreStartup').initCoreServices,
    setMcpDisabled: overrides.setMcpDisabled ?? requireLoaded(mcpServiceMod, 'mcpService').setMcpDisabled,
    registerPreOAuthCallHook: overrides.registerPreOAuthCallHook ?? requireLoaded(behindTheScenesClientMod, 'behindTheScenesClient').registerPreOAuthCallHook,
    setMigrationComplete: overrides.setMigrationComplete ?? requireLoaded(safetyPromptStoreMod, 'safetyPromptStore').setMigrationComplete,
    stopBundledInboxBridge: overrides.stopBundledInboxBridge ?? requireLoaded(bundledInboxBridgeMod, 'bundledInboxBridge').stopBundledInboxBridge,
    closeFileIndex: overrides.closeFileIndex ?? requireLoaded(fileIndexServiceMod, 'fileIndexService').closeIndex,
    proxyManager: overrides.proxyManager ?? requireLoaded(localModelProxyServerMod, 'localModelProxyServer').proxyManager,
  };
};

const waitForTurnDrain = async (
  registry: AgentTurnRegistryLike,
  timeoutMs: number,
): Promise<void> => {
  if (!registry.getActiveTurnCount || registry.getActiveTurnCount() === 0) {
    return;
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (registry.getActiveTurnCount() === 0) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};

const toSuperMcpUrl = (
  manager: SuperMcpHttpManagerLike,
  result: Awaited<ReturnType<StartSuperMcpWithRetries>> | null,
): string | undefined => {
  // Startup-failure guards. When startWithRetries() exhausts its attempts it
  // returns `{success: false, ...}`. The underlying manager called configure()
  // at the start of each attempt, which sets `state.url` and `state.port`
  // BEFORE the subprocess spawn / waitForServerReady() check. stop() (run from
  // doStart()'s catch block on failure) clears `state.isRunning` and the
  // process handle but leaves `state.url`/`state.port` populated, so a naive
  // truthiness check on `state.url` surfaces a STALE URL pointing at a port
  // no listener is bound to. Both gates below close that window.
  if (result && result.success === false) return undefined;
  const state = manager.getState();
  if (state.isRunning === false) return undefined;
  if (state.url) return state.url;
  const port = result?.port ?? state.port;
  return typeof port === 'number' && port > 0 ? `http://127.0.0.1:${port}/mcp` : undefined;
};

/**
 * Create the shared headless Rebel runtime.
 *
 * Preconditions:
 * - Caller MUST have called `setPlatformConfig()` before invoking.
 * - Caller MUST have called `setStoreFactory()` before invoking.
 * - Caller MUST have wired error reporter, broadcast service, and tracking service.
 * - Node-only contexts need Electron dependency handling before invoking.
 *   For eval/cloud, register an Electron module stub before invoking. For Stage 8
 *   standalone CLI, use bundler-time aliasing — NEVER a runtime
 *   `Module.prototype.require` monkey-patch (would defeat the bundle-import guard).
 */
export async function createHeadlessRuntime(config: HeadlessRuntimeConfig): Promise<HeadlessRuntime> {
  if (singletonRuntime || singletonCreating) {
    throw new Error('createHeadlessRuntime called twice; runtime is singleton-per-process');
  }

  singletonCreating = true;
  try {
    const deps = await loadDeps({
      ...config.__testOverrides,
      ...(config.executeAgentTurn ? { executeAgentTurn: config.executeAgentTurn } : {}),
    });
    deps.configureHeadlessTurnExecutor(deps.executeAgentTurn);
    deps.setMcpDisabled(config.skipMcp === true);
    deps.registerPreOAuthCallHook(config.preOAuthCallHook);
    deps.setMigrationComplete(true);

    await deps.initCoreServices({
      userDataDir: config.userDataDir,
      resourcesDir: config.resourcesDir,
      isPackaged: config.isPackaged,
      routerConfigPath: config.routerConfigPath,
      getSettings: config.getSettings,
      getAutomationScheduler: config.getAutomationScheduler,
      getMeetingBotService: config.getMeetingBotService,
      memoryUpdateDeps: config.memoryUpdateDeps,
      errorRecoveryDeps: config.errorRecoveryDeps,
    });

    await config.afterCoreStartup?.();

    let superMcpStarted = false;
    let superMcpUrl: string | undefined;
    let superMcpStartupError: SuperMcpStartupErrorInfo | undefined;
    if (config.skipMcp !== true) {
      const portBase = config.superMcpPortBase ?? DEFAULT_SUPER_MCP_PORT_BASE;
      const portRange = config.superMcpPortRange ?? DEFAULT_SUPER_MCP_PORT_RANGE;
      const startResult = await deps.startSuperMcpWithRetries(config.routerConfigPath, {
        logContext: 'headless-runtime',
        preferredPort: portBase,
        portRange,
        startupTimeoutMs: config.superMcpTimeoutMs ?? DEFAULT_SUPER_MCP_TIMEOUT_MS,
      });
      superMcpStarted = startResult.success;
      superMcpUrl = toSuperMcpUrl(deps.superMcpHttpManager, startResult);
      // Defense-in-depth: verify readiness whenever a URL is present. The
      // primary success gate above (and toSuperMcpUrl's startup-failure
      // guards) already prevent surfacing stale URLs, but the manager's
      // internal health check polls a generic endpoint — eval consumers
      // typically hit /api/tools immediately after this returns, so an
      // additional caller-supplied readiness probe closes any remaining race.
      if (superMcpUrl && config.waitForSuperMcpReady) {
        await config.waitForSuperMcpReady(superMcpUrl);
      }
      if (superMcpUrl === undefined) {
        superMcpStartupError = {
          lastError:
            startResult.lastError ??
            startResult.error ??
            '(no error captured — runtime returned no superMcpUrl)',
          attempts: startResult.attempts ?? 0,
          ...(startResult.attemptErrors ? { attemptErrors: startResult.attemptErrors } : {}),
          portBase,
          portRange,
        };
      }
    }

    const agentTurnServiceDeps: AgentTurnServiceDeps = {
      executeAgentTurn: deps.executeAgentTurn,
      ...(config.executeAgentTurnWithRecovery
        ? { executeAgentTurnWithRecovery: config.executeAgentTurnWithRecovery }
        : {}),
      dispatchAgentEvent: deps.dispatchAgentEvent,
      deleteRendererSessionByTurn: (turnId: string) => deps.agentTurnRegistry.deleteRendererSession(turnId),
      cancelExistingTurnForSession: (sessionId: string) =>
        deps.agentTurnRegistry.cancelExistingTurnForSession(sessionId),
      getActiveTurnForSession: (sessionId: string) =>
        deps.agentTurnRegistry.getActiveTurnForSession(sessionId),
      isActiveTurnId: (turnId: string) => deps.agentTurnRegistry.getActiveTurnController(turnId) !== undefined,
      loadAgentSessions: config.loadAgentSessions,
      ...(config.preToolHook ? { mcpDenyHook: config.preToolHook } : {}),
      ...(config.memoryWriteHook ? { memoryWriteHook: config.memoryWriteHook } : {}),
    };

    let cleanupPromise: Promise<void> | null = null;
    const cleanup = async (): Promise<void> => {
      cleanupPromise ??= (async () => {
        const errors: unknown[] = [];
        const runStep = async (step: () => Promise<void> | void): Promise<void> => {
          try {
            await step();
          } catch (error) {
            errors.push(error);
          }
        };

        await runStep(() => deps.agentTurnRegistry.abortAllTurns());
        await runStep(() => waitForTurnDrain(deps.agentTurnRegistry, config.turnDrainTimeoutMs ?? DEFAULT_TURN_DRAIN_TIMEOUT_MS));
        if (superMcpStarted) {
          await runStep(() => deps.stopSuperMcpForHeadlessCleanup());
        }
        await runStep(() => deps.stopBundledInboxBridge());
        await runStep(() => deps.closeFileIndex());
        await runStep(() => deps.proxyManager.stop());
        deps.setMcpDisabled(false);

        singletonRuntime = null;
        singletonCreating = false;

        if (errors.length > 0) {
          throw new AggregateError(errors, 'Headless runtime cleanup failed');
        }
      })();
      return cleanupPromise;
    };

    singletonRuntime = {
      startAgentTurn: (request, win = config.win ?? null) =>
        deps.startAgentTurn(agentTurnServiceDeps, request, win),
      runTurn: deps.runHeadlessTurn,
      setEventListener: deps.agentTurnRegistry.setEventListener.bind(deps.agentTurnRegistry),
      deleteEventListener: deps.agentTurnRegistry.deleteEventListener.bind(deps.agentTurnRegistry),
      getAbortController: deps.agentTurnRegistry.getActiveTurnController.bind(deps.agentTurnRegistry),
      getTurnCloseCallback: deps.agentTurnRegistry.getTurnCloseCallback.bind(deps.agentTurnRegistry),
      getSettings: config.getSettings,
      updateSettings: config.updateSettings,
      cleanup,
      superMcpUrl,
      superMcpStartupError,
    };
    singletonCreating = false;
    return singletonRuntime;
  } catch (error) {
    singletonCreating = false;
    singletonRuntime = null;
    try {
      const deps = await loadDeps(config.__testOverrides);
      deps.setMcpDisabled(false);
    } catch {
      // Best-effort reset only; preserve the original runtime creation error.
    }
    throw error;
  }
}
