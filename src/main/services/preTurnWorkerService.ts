/**
 * Pre-Turn Worker Service
 *
 * Manages a utilityProcess for pre-turn context assembly to keep the main
 * Electron process responsive during expensive operations like:
 * - Semantic search (embedding + LanceDB)
 * - Tool index search
 *
 * The worker is spawned once on first use and kept alive for subsequent requests.
 * Includes crash supervision with automatic restart.
 */

import type { UtilityProcess } from 'electron';
import { getElectronModule } from '@core/lazyElectron';
import { getPlatformConfig } from '@core/platform';
import { getDataPath } from '@core/utils/dataPaths';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { createScopedLogger } from '@core/logger';
import { getErrorReporter } from '@core/errorReporter';
import { generateQueryEmbedding } from './embeddingService';
import { parseSearchKeywords } from './semanticContextService';
import { generateSearchQueries } from '@core/services/queryGenerationService';
import { sanitizeUrlsForEmbedding } from '@core/services/urlDetectionService';
import { getSettings } from '@core/services/settingsStore';
import {
  appendPreTurnWorkerCrash,
  countCrashesInLast7Days,
  createEmptyPreTurnWorkerHistory,
  getPreTurnWorkerHistoryPath,
  readPreTurnWorkerHistory,
  writePreTurnWorkerHistory,
  type PreTurnWorkerCrashCategory,
  type PreTurnWorkerHistoryV1,
} from './preTurnWorkerHistory';
import { fireAndForget } from '@shared/utils/fireAndForget';

const logger = createScopedLogger({ service: 'preTurnWorker' });

// Configuration
const MAX_CRASH_RESTARTS = 3;
const RESTART_DELAY_MS = 1000;
const CRASH_COOLDOWN_MS = [60_000, 5 * 60_000, 30 * 60_000] as const;
const REQUEST_TIMEOUT_MS = 30000;
const INIT_TIMEOUT_MS = 120000;
const IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
// Time for LanceDB connection cleanup on dispose. Production = 2000ms.
// Overridable ONLY from tests (see _setDisposeCleanupMsForTests) so the
// per-test afterEach dispose doesn't real-wait 2s × N tests in CI; the
// production default is unchanged. Kept as a mutable module var rather than
// broad fake timers because this file has many other real timers
// (RESTART_DELAY_MS, idle, init/request timeouts) that fake timers would perturb.
let disposeCleanupMs = 2000;

// Types
interface PreTurnRequest {
  prompt: string;
  fileQueryEmbedding?: number[];  // For semantic file search
  toolQueryEmbedding?: number[];  // For tool search
  conversationQueryEmbedding?: number[];  // For conversation search
  skillQueryEmbedding?: number[];  // For skill search
  fileQueryText?: string;  // For hybrid FTS in worker
  toolSearchIntentionallySkipped?: boolean;  // Smart query determined no tools needed
  toolIndexUsable?: boolean;  // False when tool index is stale/invalidated in main process
}

interface PreTurnResult {
  semanticContext?: {
    formattedContext: string;
    fileCount: number;
    files?: Array<{ relativePath: string; score: number }>;
  };
  suggestedTools?: Array<{
    toolId: string;
    serverId: string;
    serverName: string;
    description: string;
    summary: string;
    inputSchema: string;
    score: number;
  }>;
  suggestedConversations?: Array<{
    sessionId: string;
    title: string;
    score: number;
    createdAt: number;
    messageCount: number;
  }>;
  suggestedSkills?: Array<{
    relativePath: string;
    skillName: string;
    description: string;
    score: number;
  }>;
  toolSearchStatus?: 'ok' | 'skipped' | 'unavailable';
  conversationSearchStatus?: 'ok' | 'unavailable';
}

interface WorkerConfig {
  userDataPath: string;
  workspacePath: string;
  unpackedNodeModules?: string;
}

interface PendingRequest {
  resolve: (result: PreTurnResult) => void;
  reject: (error: Error) => void;
  timeoutId: NodeJS.Timeout;
}

export interface PreTurnWorkerStatsSnapshot {
  since: 'app_start';
  appStartedAt: number;
  spawnCount: number;
  restartCount: number;
  lastCrashCategory?: PreTurnWorkerCrashCategory;
  lastCrashAt?: number;
  averagePreTurnDurationBucket?: '<100ms' | '<500ms' | '<2s' | '>=2s';
  currentlyRestarting: boolean;
  persistedLastCrashAt?: number;
  persistedLastCrashCategory?: PreTurnWorkerCrashCategory;
  crashesInLast7Days?: number;
  totalCrashesAllTime?: number;
}

// Dev-only diagnostic logging for pre-turn assembly hang investigation.
// Guarded by !isPackaged so it never runs in production builds.
// See: docs/project/ARCHITECTURE_AGENT_TURN_EXECUTION.md § "Pre-Turn Assembly Timeout"
function devDiag(phase: string, extra?: Record<string, unknown>): void {
  if (getPlatformConfig().isPackaged) return;
  logger.debug({ phase, ...extra }, `[pre-turn-diag] ${phase}`);
}

// State
let worker: UtilityProcess | null = null;
let isReady = false;
let initPromise: Promise<void> | null = null;
let consecutiveCrashes = 0;
let crashCooldownLevel = 0;
let crashCooldownUntilMs = 0;
let permanentlyDisabled = false;
let intentionalShutdown = false;
let currentWorkspacePath: string | null = null;
let isDisposing = false;
let disposePromise: Promise<void> | null = null;
let idleTimer: NodeJS.Timeout | null = null;

// Session stats tracking (in-memory only, "since app start")
const appStartedAt = Date.now();
let spawnCount = 0;
let totalRestartCount = 0;
let lastCrashCategory: 'oom' | 'unhandled_exception' | 'sigterm' | 'unknown' | undefined = undefined;
let lastCrashAt: number | undefined = undefined;
let totalPreTurnDurationMs = 0;
let totalPreTurnRequests = 0;

// Persisted crash-history tracking (cross-restart)
let persistedHistory: PreTurnWorkerHistoryV1 = createEmptyPreTurnWorkerHistory();
let persistedHistoryLoaded = false;
let persistedHistoryLoadPromise: Promise<void> | null = null;
let lastPersistedHistoryWritePromise: Promise<void> | null = null;
let crashesRecordedBeforeHistoryLoad: Array<{ at: number; category: PreTurnWorkerCrashCategory }> = [];

const pendingRequests = new Map<string, PendingRequest>();
const modelReadyCallbacks: Array<{ resolve: () => void; reject: (err: Error) => void }> = [];

function applyCrashesRecordedBeforeHistoryLoad(history: PreTurnWorkerHistoryV1): {
  history: PreTurnWorkerHistoryV1;
  appliedCrashCount: number;
} {
  let nextHistory = history;
  for (const crash of crashesRecordedBeforeHistoryLoad) {
    nextHistory = appendPreTurnWorkerCrash(nextHistory, crash, crash.at);
  }
  const appliedCrashCount = crashesRecordedBeforeHistoryLoad.length;
  crashesRecordedBeforeHistoryLoad = [];
  return { history: nextHistory, appliedCrashCount };
}

function writePersistedHistorySnapshot(dataPath: string, historyPath: string): void {
  lastPersistedHistoryWritePromise = writePreTurnWorkerHistory(dataPath, persistedHistory)
    .catch((err: unknown) => {
      logger.warn(
        { err, historyPath },
        'Failed to persist pre-turn worker crash history',
      );
    });
  fireAndForget(lastPersistedHistoryWritePromise, 'preTurnWorkerService.line182');
}

async function ensurePersistedHistoryLoaded(): Promise<void> {
  if (persistedHistoryLoaded) return;
  if (persistedHistoryLoadPromise) return persistedHistoryLoadPromise;

  const dataPath = getDataPath();
  const historyPath = getPreTurnWorkerHistoryPath(dataPath);
  persistedHistoryLoadPromise = readPreTurnWorkerHistory(dataPath)
    .then((history) => {
      const applied = applyCrashesRecordedBeforeHistoryLoad(history);
      persistedHistory = applied.history;
      persistedHistoryLoaded = true;
      if (applied.appliedCrashCount > 0) {
        writePersistedHistorySnapshot(dataPath, historyPath);
      }
    })
    .catch((err: unknown) => {
      const applied = applyCrashesRecordedBeforeHistoryLoad(createEmptyPreTurnWorkerHistory());
      persistedHistory = applied.history;
      persistedHistoryLoaded = true;
      logger.warn(
        { err, historyPath },
        'Failed to read pre-turn worker crash history; starting with empty history',
      );
      if (applied.appliedCrashCount > 0) {
        writePersistedHistorySnapshot(dataPath, historyPath);
      }
    })
    .finally(() => {
      persistedHistoryLoadPromise = null;
    });

  return persistedHistoryLoadPromise;
}

function persistWorkerCrashHistory(crashAt: number, crashCategory: PreTurnWorkerCrashCategory): void {
  try {
    if (persistedHistoryLoadPromise) {
      crashesRecordedBeforeHistoryLoad.push({ at: crashAt, category: crashCategory });
    }
    persistedHistory = appendPreTurnWorkerCrash(
      persistedHistoryLoaded ? persistedHistory : createEmptyPreTurnWorkerHistory(),
      { at: crashAt, category: crashCategory },
      crashAt,
    );
    persistedHistoryLoaded = true;

    const dataPath = getDataPath();
    const historyPath = getPreTurnWorkerHistoryPath(dataPath);
    writePersistedHistorySnapshot(dataPath, historyPath);
  } catch (err) {
    logger.warn(
      { err },
      'Failed to schedule pre-turn worker crash history persistence',
    );
  }
}

function getCrashCooldownRemainingMs(now = Date.now()): number {
  return Math.max(0, crashCooldownUntilMs - now);
}

function isCrashCooldownActive(now = Date.now()): boolean {
  return getCrashCooldownRemainingMs(now) > 0;
}

function scheduleCooldownRetry(workspacePath: string, cooldownMs: number): void {
  const retryTimer = setTimeout(() => {
    if (currentWorkspacePath !== workspacePath || isDisposing) return;
    crashCooldownUntilMs = 0;
    consecutiveCrashes = 0;
    void initializeWorker(workspacePath).catch((err) => {
      logger.warn({ err }, 'Pre-turn worker cooldown retry failed');
    });
  }, cooldownMs);
  retryTimer.unref?.();
}

function resetIdleTimer(): void {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
}

function startIdleTimer(): void {
  resetIdleTimer();
  if (!isReady || permanentlyDisabled) return;

  idleTimer = setTimeout(() => {
    if (pendingRequests.size === 0 && isReady && !isDisposing) {
      logger.info({ idleMs: IDLE_TIMEOUT_MS }, 'Pre-turn worker idle timeout, disposing');
      fireAndForget(disposeWorker(), 'preTurnWorkerService.line276');
    }
  }, IDLE_TIMEOUT_MS);
}

/**
 * Get the path to the worker script
 */
function getWorkerPath(): string {
  const config = getPlatformConfig();
  if (config.isPackaged) {
    return path.join(
      config.appPath.replace('app.asar', 'app.asar.unpacked'),
      'workers',
      'preTurnWorker.js'
    );
  }

  // Development: worker is built to out/main/workers/ by scripts/build-worker.mjs
  const possiblePaths = [
    path.join(__dirname, 'workers', 'preTurnWorker.js'),
    path.join(config.appPath, 'out', 'main', 'workers', 'preTurnWorker.js'),
    path.join(process.cwd(), 'out', 'main', 'workers', 'preTurnWorker.js')
  ];

  for (const workerPath of possiblePaths) {
    if (fs.existsSync(workerPath)) {
      return workerPath;
    }
  }

  return possiblePaths[1];
}

/**
 * Get unpacked node_modules path for packaged builds
 */
function getUnpackedNodeModules(): string | undefined {
  if (getPlatformConfig().isPackaged) {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- process.resourcesPath is guaranteed when app.isPackaged is true (Electron API contract)
    return path.join(process.resourcesPath!, 'app.asar.unpacked', 'node_modules');
  }
  return undefined;
}

/**
 * Reject all pending requests
 */
function rejectAllPending(error: Error): void {
  for (const [_id, pending] of pendingRequests) {
    clearTimeout(pending.timeoutId);
    pending.reject(error);
  }
  pendingRequests.clear();
}

/**
 * Notify callbacks waiting for worker ready
 */
function notifyReadyCallbacks(error?: Error): void {
  for (const cb of modelReadyCallbacks) {
    if (error) {
      cb.reject(error);
    } else {
      cb.resolve();
    }
  }
  modelReadyCallbacks.length = 0;
}

/**
 * Handle messages from the worker
 */
function handleMessage(msg: {
  type: 'ready' | 'preTurnResult' | 'error' | 'disposed';
  id?: string;
  result?: PreTurnResult;
  error?: string;
  hasFileIndex?: boolean;
  hasToolIndex?: boolean;
  hasConversationIndex?: boolean;
}): void {
  if (msg.type === 'ready') {
    isReady = true;
    consecutiveCrashes = 0;
    crashCooldownLevel = 0;
    crashCooldownUntilMs = 0;
    logger.info('Pre-turn worker ready');
    getErrorReporter().addBreadcrumb({
      category: 'preTurnWorker',
      message: 'Worker ready (LanceDB only)',
      level: 'info',
    });
    notifyReadyCallbacks();
    startIdleTimer();
  } else if (msg.type === 'preTurnResult') {
    if (!msg.id) return;
    const pending = pendingRequests.get(msg.id);
    if (pending) {
      clearTimeout(pending.timeoutId);
      pending.resolve(msg.result ?? {});
      pendingRequests.delete(msg.id);
    }
  } else if (msg.type === 'error') {
    if (msg.id) {
      const pending = pendingRequests.get(msg.id);
      if (pending) {
        clearTimeout(pending.timeoutId);
        pending.reject(new Error(msg.error ?? 'Unknown worker error'));
        pendingRequests.delete(msg.id);
      }
    } else {
      // Init-time error
      const error = new Error(`Worker initialization failed: ${msg.error}`);
      logger.error({ error: msg.error }, 'Pre-turn worker init error');
      notifyReadyCallbacks(error);
    }
  } else if (msg.type === 'disposed') {
    logger.info('Pre-turn worker disposed');
  }
}

/**
 * Handle worker exit
 */
function handleExit(code: number): void {
  const signal = code !== null && code > 128 ? code - 128 : null;
  const signalNames: Record<number, string> = { 5: 'SIGTRAP', 6: 'SIGABRT', 9: 'SIGKILL', 11: 'SIGSEGV', 15: 'SIGTERM' };
  const signalName = signal ? signalNames[signal] ?? `SIG${signal}` : null;

  const wasReady = isReady;
  worker = null;
  isReady = false;
  initPromise = null;

  if (intentionalShutdown) {
    logger.info({ exitCode: code }, 'Pre-turn worker shutdown complete');
    return;
  }

  if (code !== 0) {
    totalRestartCount++;
    const crashAt = Date.now();
    let crashCategory: PreTurnWorkerCrashCategory;
    lastCrashAt = crashAt;
    if (signalName === 'SIGKILL' || signalName === 'SIGTERM') {
      crashCategory = 'sigterm';
    } else if (signalName === 'SIGABRT') {
      crashCategory = 'oom';
    } else if (code !== null) {
      crashCategory = 'unhandled_exception';
    } else {
      crashCategory = 'unknown';
    }
    lastCrashCategory = crashCategory;

    logger.warn(
      { exitCode: code, signal: signalName, consecutiveCrashes: consecutiveCrashes + 1 },
      'Pre-turn worker crashed'
    );
    persistWorkerCrashHistory(crashAt, crashCategory);
    
    consecutiveCrashes++;
    rejectAllPending(new Error('Pre-turn worker crashed'));
    notifyReadyCallbacks(new Error('Worker crashed during initialization'));

    if (consecutiveCrashes < MAX_CRASH_RESTARTS && !permanentlyDisabled) {
      logger.info({ delayMs: RESTART_DELAY_MS }, 'Scheduling worker restart');
      setTimeout(() => {
        if (!permanentlyDisabled && currentWorkspacePath) {
          void initializeWorker(currentWorkspacePath).catch((err) => {
            logger.warn({ err }, 'Pre-turn worker restart failed');
          });
        }
      }, RESTART_DELAY_MS);
    } else {
      const cooldownMs =
        CRASH_COOLDOWN_MS[Math.min(crashCooldownLevel, CRASH_COOLDOWN_MS.length - 1)];
      crashCooldownLevel += 1;
      crashCooldownUntilMs = Date.now() + cooldownMs;
      const workspacePath = currentWorkspacePath;
      logger.error(
        { cooldownMs, consecutiveCrashes, exitCode: code, signal: signalName },
        'Pre-turn worker disabled temporarily after repeated crashes',
      );
      getErrorReporter().captureException(
        new Error('Pre-turn worker disabled temporarily after repeated crashes'),
        {
          tags: { area: 'agent', component: 'pre-turn-worker' },
          extra: { consecutiveCrashes, cooldownMs, exitCode: code, signal: signalName },
        }
      );
      if (workspacePath) {
        scheduleCooldownRetry(workspacePath, cooldownMs);
      }
    }
  } else if (!wasReady) {
    notifyReadyCallbacks(new Error('Worker exited before ready'));
  }
}

/**
 * Initialize the worker process
 */
async function initializeWorker(workspacePath: string): Promise<void> {
  fireAndForget(ensurePersistedHistoryLoaded(), 'preTurnWorkerService.line481');

  // Wait for any in-progress disposal to complete before re-initializing
  if (disposePromise) {
    await disposePromise;
  }
  isDisposing = false;

  if (isCrashCooldownActive()) {
    currentWorkspacePath = workspacePath;
    const remainingMs = getCrashCooldownRemainingMs();
    logger.warn(
      { remainingMs, consecutiveCrashes },
      'Pre-turn worker crash cooldown active; initialization deferred',
    );
    initPromise = Promise.reject(
      new Error(`Pre-turn worker cooling down after repeated crashes; retry in ${Math.ceil(remainingMs / 1000)}s`)
    );
    initPromise.catch(() => { initPromise = null; });
    return initPromise;
  }

  if (worker && isReady && currentWorkspacePath === workspacePath) {
    return;
  }

  if (initPromise && currentWorkspacePath === workspacePath) {
    return initPromise;
  }

  // If workspace changed, dispose old worker
  if (worker && currentWorkspacePath !== workspacePath) {
    await disposeWorker();
  }

  currentWorkspacePath = workspacePath;

  // Early environment check: utilityProcess requires Electron
  if (!getElectronModule()) {
    permanentlyDisabled = true;
    logger.info('Pre-turn worker disabled: Electron utilityProcess not available (cloud/headless mode)');
    initPromise = Promise.reject(new Error('Pre-turn worker requires Electron (utilityProcess)'));
    initPromise.catch(() => { initPromise = null; });
    return initPromise;
  }

  initPromise = new Promise<void>((resolve, reject) => {
    const workerPath = getWorkerPath();

    if (!fs.existsSync(workerPath)) {
      const error = new Error(`Worker file not found: ${workerPath}`);
      logger.error({ workerPath }, error.message);
      permanentlyDisabled = true;
      getErrorReporter().captureException(error, {
        tags: { area: 'agent', component: 'pre-turn-worker' },
      });
      reject(error);
      return;
    }

    logger.info({ workerPath, workspacePath }, 'Spawning pre-turn worker');

    const initTimeout = setTimeout(() => {
      const error = new Error('Worker initialization timed out');
      logger.error({ timeoutMs: INIT_TIMEOUT_MS }, error.message);
      if (worker) {
        worker.kill();
        worker = null;
      }
      reject(error);
    }, INIT_TIMEOUT_MS);

    // Track if we've resolved/rejected to avoid double-handling
    let settled = false;

    const onReady = () => {
      if (settled) return;
      settled = true;
      clearTimeout(initTimeout);
      resolve();
    };

    const onError = (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(initTimeout);
      reject(err);
    };

    // Register callbacks before spawning
    modelReadyCallbacks.push({ resolve: onReady, reject: onError });

    try {
      const electron = getElectronModule();
      if (!electron) {
        throw new Error('Pre-turn worker requires Electron (utilityProcess)');
      }
      worker = electron.utilityProcess.fork(workerPath, [], {
        serviceName: 'Pre-Turn Context Worker',
        stdio: 'pipe'
      });
      spawnCount++;

      // Drain stdout/stderr pipes to prevent worker deadlock if it writes to them.
      // Worker communication uses postMessage/on('message'), so stdio is for debug/error output only.
      // Use bounded buffering to avoid memory exhaustion.
      const MAX_PIPE_BUFFER_LINES = 100;
      let stdoutLines = 0;
      let stderrLines = 0;

      worker.stdout?.on('data', (data: Buffer) => {
        // Drain pipe and log at debug level with bounded buffering
        if (stdoutLines < MAX_PIPE_BUFFER_LINES) {
          const output = data.toString().trim();
          if (output) {
            logger.debug({ output, source: 'pre-turn-worker-stdout' }, 'Worker stdout');
            stdoutLines++;
          }
        }
        // After limit, data is drained but not logged to prevent memory growth
      });

      worker.stderr?.on('data', (data: Buffer) => {
        // Drain pipe and log at warn level with bounded buffering
        if (stderrLines < MAX_PIPE_BUFFER_LINES) {
          const error = data.toString().trim();
          if (error) {
            logger.warn({ error, source: 'pre-turn-worker-stderr' }, 'Worker stderr');
            stderrLines++;
          }
        }
        // After limit, data is drained but not logged to prevent memory growth
      });

      worker.on('message', handleMessage);
      worker.on('exit', handleExit);

      // Send init message
      const config: WorkerConfig = {
        userDataPath: getPlatformConfig().userDataPath,
        workspacePath,
        unpackedNodeModules: getUnpackedNodeModules()
      };

      worker.postMessage({ type: 'init', config });

    } catch (err) {
      clearTimeout(initTimeout);
      const error = err instanceof Error ? err : new Error(String(err));
      logger.error({ err: error }, 'Failed to spawn pre-turn worker');
      reject(error);
    }
  });

  initPromise.catch(() => {
    initPromise = null;
  });

  return initPromise;
}

/**
 * Wait for worker to be ready
 */
export async function waitForWorkerReady(workspacePath: string): Promise<void> {
  if (permanentlyDisabled) {
    throw new Error('Pre-turn worker unavailable in this environment');
  }

  if (isReady && currentWorkspacePath === workspacePath) {
    return;
  }

  await initializeWorker(workspacePath);
  if (persistedHistoryLoadPromise) {
    await persistedHistoryLoadPromise;
  }
}

/**
 * Check if worker is available
 */
export function isWorkerAvailable(): boolean {
  return isReady && !permanentlyDisabled && worker !== null;
}

/**
 * Assemble pre-turn context using the worker
 *
 * @param workspacePath - Path to the user's workspace
 * @param request - Pre-turn request parameters (prompt, embeddings, etc.)
 * @param urlDomainHints - Optional URL domain hints for enriching tool search queries
 *   (e.g., "Google Docs document reader, Notion page reader"). See docs/plans/260403_document_prefetch_pipeline.md.
 */
export async function assemblePreTurnContext(
  workspacePath: string,
  request: PreTurnRequest,
  urlDomainHints?: string
): Promise<PreTurnResult> {
  // Reject if disposal is in progress
  if (isDisposing) {
    logger.debug('Pre-turn worker is disposing, returning empty context');
    return {};
  }

  // Clear idle timer while a request is active
  resetIdleTimer();

  try {
    // Fallback: return empty result if worker not available
    if (permanentlyDisabled) {
      logger.warn('Pre-turn worker unavailable, returning empty context');
      return {};
    }
    if (isCrashCooldownActive()) {
      logger.warn(
        { remainingMs: getCrashCooldownRemainingMs() },
        'Pre-turn worker crash cooldown active, returning empty context',
      );
      return {};
    }

    devDiag('worker-wait-start');
    try {
      await waitForWorkerReady(workspacePath);
    } catch (error) {
      logger.warn({ err: error }, 'Failed to initialize pre-turn worker, returning empty context');
      return {};
    }
    devDiag('worker-ready');

    if (!worker) {
      return {};
    }

    // Compute embeddings in main process (eliminates duplicate model in worker)
    let fileQueryEmbedding: number[] | undefined;
    let toolQueryEmbedding: number[] | undefined;
    let conversationQueryEmbedding: number[] | undefined;
    let skillQueryEmbedding: number[] | undefined;
    let fileQueryText: string | undefined;
    let toolSearchIntentionallySkipped = false;

    try {
      const startTime = Date.now();

      // Parse search keywords to get the query for file search
      const { hasExplicitSearch, sanitizedPrompt } = parseSearchKeywords(request.prompt);

      // Check for @conversations keyword (parsed separately from @files/@skills)
      const hasConversationKeyword = /(?:^|\s)@conversations(?=$|[\s,.:;!?\n\r])/i.test(request.prompt);

      // Smart query generation: when no explicit search keywords are present,
      // use LLM to generate purpose-optimized queries for each index
      let useSmartQueries = false;
      if (!hasExplicitSearch && !hasConversationKeyword) {
        try {
          devDiag('smart-query-start');
          const settings = getSettings();
          const queries = await generateSearchQueries(request.prompt, settings, urlDomainHints ? { urlDomainHints } : undefined);
          devDiag('smart-query-done', { hasQueries: !!queries });
          if (queries) {
            useSmartQueries = true;
            logger.debug(
              {
                fileQueryLen: queries.file_query.length,
                toolQueryLen: queries.tool_query.length,
                conversationQueryLen: queries.conversation_query.length,
                skillQueryLen: queries.skill_query.length,
              },
              'Using smart query generation for embeddings'
            );

            // Generate embeddings sequentially (per D8), skip empty queries
            if (queries.file_query) {
              devDiag('embedding-file-start');
              const embedding = await generateQueryEmbedding(queries.file_query);
              fileQueryEmbedding = Array.from(embedding);
              fileQueryText = queries.file_query;
              devDiag('embedding-file-done');
            }
            if (queries.tool_query && request.toolIndexUsable !== false) {
              devDiag('embedding-tool-start');
              const sanitizedToolQuery = sanitizeUrlsForEmbedding(queries.tool_query);
              const embedding = await generateQueryEmbedding(sanitizedToolQuery);
              toolQueryEmbedding = Array.from(embedding);
              devDiag('embedding-tool-done');
            } else if (!queries.tool_query) {
              // Smart query explicitly determined no tools needed for this prompt
              toolSearchIntentionallySkipped = true;
            }
            if (queries.conversation_query) {
              devDiag('embedding-conversation-start');
              const embedding = await generateQueryEmbedding(queries.conversation_query);
              conversationQueryEmbedding = Array.from(embedding);
              devDiag('embedding-conversation-done');
            }
            if (queries.skill_query) {
              devDiag('embedding-skill-start');
              const embedding = await generateQueryEmbedding(queries.skill_query);
              skillQueryEmbedding = Array.from(embedding);
              devDiag('embedding-skill-done');
            }
          }
        } catch (error) {
          logger.warn({ err: error }, 'Smart query generation failed, falling back to raw prompt');
        }
      }

      // Fallback: use current behavior (single embedding from raw prompt for all)
      if (!useSmartQueries) {
        devDiag('embedding-fallback-start');
        const queryForSearch = hasExplicitSearch ? sanitizedPrompt : request.prompt;

        // Compute file query embedding
        const fileEmbedding = await generateQueryEmbedding(queryForSearch);
        fileQueryEmbedding = Array.from(fileEmbedding);
        fileQueryText = queryForSearch;

        // Compute tool + conversation + skill query embeddings (may differ from file query when keywords present)
        // Tool embeddings get URL sanitization — raw URLs dilute vector search for tool discovery.
        // File/conversation/skill embeddings keep the original text (URLs are valuable context there).
        const sanitizedForTools = sanitizeUrlsForEmbedding(
          queryForSearch !== request.prompt ? request.prompt : queryForSearch
        );
        const needsSeparateToolEmbedding = sanitizedForTools !== (queryForSearch !== request.prompt ? request.prompt : queryForSearch);

        if (queryForSearch !== request.prompt) {
          const rawEmbedding = await generateQueryEmbedding(request.prompt);
          const rawEmbeddingArray = Array.from(rawEmbedding);
          conversationQueryEmbedding = rawEmbeddingArray;
          skillQueryEmbedding = rawEmbeddingArray;

          if (request.toolIndexUsable !== false) {
            if (needsSeparateToolEmbedding) {
              const toolEmbedding = await generateQueryEmbedding(sanitizedForTools);
              toolQueryEmbedding = Array.from(toolEmbedding);
            } else {
              toolQueryEmbedding = rawEmbeddingArray;
            }
          }
        } else {
          conversationQueryEmbedding = fileQueryEmbedding;
          skillQueryEmbedding = fileQueryEmbedding;

          if (request.toolIndexUsable !== false) {
            if (needsSeparateToolEmbedding) {
              const toolEmbedding = await generateQueryEmbedding(sanitizedForTools);
              toolQueryEmbedding = Array.from(toolEmbedding);
            } else {
              toolQueryEmbedding = fileQueryEmbedding;
            }
          }
        }
      }

      devDiag('embeddings-all-done');
      const duration = Date.now() - startTime;
      logger.info(
        {
          durationMs: duration,
          useSmartQueries,
          hasExplicitSearch,
          fileQueryTextLength: fileQueryText?.length ?? 0,
          toolSearchIntentionallySkipped,
          hasConversationQuery: !!conversationQueryEmbedding,
          hasSkillQuery: !!skillQueryEmbedding,
          fallbackReason: !useSmartQueries ? (hasExplicitSearch ? 'explicit_search' : 'smart_query_unavailable') : undefined,
        },
        'Pre-turn embedding generation complete'
      );
    } catch (error) {
      logger.warn({ err: error }, 'Failed to compute pre-turn embeddings, proceeding without');
    }

    const id = crypto.randomUUID();

    const augmentedRequest: PreTurnRequest = {
      ...request,
      fileQueryEmbedding,
      toolQueryEmbedding,
      conversationQueryEmbedding,
      skillQueryEmbedding,
      fileQueryText,
      ...(toolSearchIntentionallySkipped && { toolSearchIntentionallySkipped: true }),
    };

    devDiag('worker-rpc-start', { requestId: id });
    const rpcStartTime = Date.now();
    return await new Promise<PreTurnResult>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        pendingRequests.delete(id);
        const duration = Date.now() - rpcStartTime;
        totalPreTurnDurationMs += duration;
        totalPreTurnRequests++;
        reject(new Error(`Pre-turn context request timed out after ${REQUEST_TIMEOUT_MS}ms`));
      }, REQUEST_TIMEOUT_MS);

      pendingRequests.set(id, {
        resolve: (result) => {
          devDiag('worker-rpc-done', { requestId: id });
          const duration = Date.now() - rpcStartTime;
          totalPreTurnDurationMs += duration;
          totalPreTurnRequests++;
          resolve(result);
        },
        reject: (error) => {
          devDiag('worker-rpc-error', { requestId: id, error: error.message });
          const duration = Date.now() - rpcStartTime;
          totalPreTurnDurationMs += duration;
          totalPreTurnRequests++;
          reject(error);
        },
        timeoutId,
      });

      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- worker is guaranteed non-null: waitForWorkerReady() + explicit null check above
      worker!.postMessage({
        type: 'preTurnContext',
        id,
        request: augmentedRequest
      });
    });
  } finally {
    // Always restart idle timer when no requests are pending (even on error/early-return)
    if (pendingRequests.size === 0 && isReady && !isDisposing) {
      startIdleTimer();
    }
  }
}

/**
 * Dispose the worker.
 * Uses re-entrancy protection to prevent concurrent disposals.
 */
export async function disposeWorker(): Promise<void> {
  if (disposePromise) {
    return disposePromise;
  }

  if (!worker) return;

  isDisposing = true;
  disposePromise = doDispose();
  return disposePromise;
}

async function doDispose(): Promise<void> {
  resetIdleTimer();
  intentionalShutdown = true;
  rejectAllPending(new Error('Worker disposed'));
  notifyReadyCallbacks(new Error('Worker disposed during initialization'));

  try {
    worker?.postMessage({ type: 'dispose' });
    await new Promise(resolve => setTimeout(resolve, disposeCleanupMs));
  } catch {
    // Ignore errors during disposal
  }

  if (worker) {
    worker.kill();
    worker = null;
  }

  isReady = false;
  initPromise = null;
  currentWorkspacePath = null;
  intentionalShutdown = false;
  isDisposing = false;
  disposePromise = null;

  logger.info('Pre-turn worker disposed');
}

/**
 * Get worker status for diagnostics
 */
export function getWorkerStatus(): {
  isReady: boolean;
  permanentlyDisabled: boolean;
  consecutiveCrashes: number;
  crashCooldownRemainingMs: number;
  workspacePath: string | null;
} {
  return {
    isReady,
    permanentlyDisabled,
    consecutiveCrashes,
    crashCooldownRemainingMs: getCrashCooldownRemainingMs(),
    workspacePath: currentWorkspacePath
  };
}

/**
 * Get pre-turn worker stats for diagnostics (since app start)
 */
export function getPreTurnWorkerStats(): PreTurnWorkerStatsSnapshot {
  let averagePreTurnDurationBucket: '<100ms' | '<500ms' | '<2s' | '>=2s' | undefined = undefined;
  if (totalPreTurnRequests > 0) {
    const avg = totalPreTurnDurationMs / totalPreTurnRequests;
    if (avg < 100) averagePreTurnDurationBucket = '<100ms';
    else if (avg < 500) averagePreTurnDurationBucket = '<500ms';
    else if (avg < 2000) averagePreTurnDurationBucket = '<2s';
    else averagePreTurnDurationBucket = '>=2s';
  }

  return {
    since: 'app_start',
    appStartedAt,
    spawnCount,
    restartCount: totalRestartCount,
    lastCrashCategory,
    lastCrashAt,
    averagePreTurnDurationBucket,
    currentlyRestarting: initPromise !== null && !isReady,
    persistedLastCrashAt: persistedHistory.lastCrashAt,
    persistedLastCrashCategory: persistedHistory.lastCrashCategory,
    crashesInLast7Days: countCrashesInLast7Days(persistedHistory),
    totalCrashesAllTime: persistedHistory.totalCrashesAllTime,
  };
}

export function _getLastPreTurnWorkerHistoryWriteForTests(): Promise<void> | null {
  return lastPersistedHistoryWritePromise;
}

/**
 * Test-only override for the dispose cleanup delay. Lets the test suite's
 * per-test `afterEach` dispose collapse the real 2s LanceDB-cleanup wait to 0
 * (or any value) without touching the production default or any other timer.
 * Pass no argument to restore the 2000ms production default.
 */
export function _setDisposeCleanupMsForTests(ms = 2000): void {
  disposeCleanupMs = ms;
}
