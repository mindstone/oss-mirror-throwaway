import { existsSync } from 'node:fs';
import path from 'node:path';
import { config as loadDotenv } from 'dotenv';
import { vi } from 'vitest';
import { setPlatformConfig } from './src/core/platform';
import { assertTestDataRootSafe } from './cloud-service/src/testDataRootGuard';
import { scrubGitLocationEnv } from './scripts/lib/git-env-isolation';

// ---------------------------------------------------------------------------
// Git isolation chokepoint (FIRST — before any code can shell out to git).
//
// When vitest runs inside the `.husky/pre-push` hook, git exports GIT_DIR /
// GIT_WORK_TREE / … pointing at the REAL repo. Those override `cwd`, so a
// fixture that spawns git against a tempdir would instead mutate the real
// repo's shared `.git/config` (e.g. flip `core.bare=true`, which breaks every
// worktree) or create stray commits. Scrubbing the location-redirect vars here
// isolates EVERY git-shelling fixture in every project that loads this setup,
// by construction — instead of relying on each fixture to remember.
// See scripts/lib/git-env-isolation.ts + docs/plans/260609_core-bare-corruption-guard.
// ---------------------------------------------------------------------------
scrubGitLocationEnv(process.env);

// ---------------------------------------------------------------------------
// Load `.env.test` into process.env for gated live-API integration tests.
//
// Vitest does NOT load `.env.test` into process.env on its own (Vite only
// exposes prefixed vars to import.meta.env). Gated tests read keys like
// TEST_OPENROUTER_API_KEY / TEST_ANTHROPIC_API_KEY / TEST_CLAUDE_API_KEY from
// process.env and skip cleanly when absent (see docs/plans/improve_tests.md §4).
//
// `override: false` so a key already exported in the shell or injected as a CI
// secret always wins over the local `.env.test` file. The file is gitignored;
// `.env.test.example` documents the recognised vars for colleagues.
// ---------------------------------------------------------------------------
const envTestPath = path.resolve(__dirname, '.env.test');
if (existsSync(envTestPath)) {
  loadDotenv({ path: envTestPath, override: false });
}

// Data-isolation guard for the test env. We do NOT *force* REBEL_USER_DATA when
// it is unset: many desktop tests set their own data dir via PlatformConfig
// (e.g. `initTestPlatformConfig({ userDataPath: tempDir })`) and rely on
// REBEL_USER_DATA being unset, because `@core/utils/dataPaths` prefers the env
// var OVER PlatformConfig — forcing it here silently redirects those tests'
// writes away from their own temp dir (broke cliPersistStress). When unset, the
// effective data path comes from PlatformConfig, which this setup pins to a temp
// path below (and per-test overrides keep within temp). We only FAIL CLOSED on
// the real isolation risk: a developer running vitest with REBEL_USER_DATA set
// in their shell to a real (non-temp) Rebel path.
if (process.env.REBEL_USER_DATA) {
  assertTestDataRootSafe(process.env.REBEL_USER_DATA, { label: 'vitest REBEL_USER_DATA' });
}

// ---------------------------------------------------------------------------
// Node 25+ localStorage / sessionStorage global conflict shim.
//
// Node 25 ships an experimental built-in `localStorage` / `sessionStorage`
// global exposed via a getter/setter on `globalThis`. When `--localstorage-file`
// is not provided, the getter returns a broken empty object (no `clear`,
// `setItem`, etc. methods on its prototype). The setter silently swallows
// assignments, so happy-dom's environment cannot replace it with its own
// Storage instance in the usual way — tests see `localStorage.clear is not a
// function`. Fix: on happy-dom-powered test files, delete the Node-provided
// accessor after environment setup so happy-dom's setters take effect.
// See https://nodejs.org/api/cli.html#--localstorage-filefile for the Node
// flag and the symptoms we hit on v25.x.
// ---------------------------------------------------------------------------
for (const key of ['localStorage', 'sessionStorage'] as const) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
  // Only repair when the descriptor is an accessor (Node's built-in) whose
  // getter yields a value without a working `clear` method. Happy-dom's own
  // Storage instance has `clear` on its prototype, so it passes this check
  // and is left untouched.
  if (!descriptor || typeof descriptor.get !== 'function') continue;
  const current = (globalThis as Record<string, unknown>)[key];
  if (current && typeof (current as { clear?: unknown }).clear === 'function') continue;

  delete (globalThis as Record<string, unknown>)[key];

  // Try to substitute happy-dom's Storage. Its constructor is callable with
  // `new Storage()`. Node's built-in Storage is not (it throws "Illegal
  // constructor"). If `new Storage()` fails we simply leave the key deleted —
  // node-env tests don't expect a usable localStorage anyway, and deleting
  // Node's broken accessor keeps it out of the way.
  const StorageCtor = (globalThis as { Storage?: new () => Storage }).Storage;
  if (typeof StorageCtor === 'function') {
    try {
      (globalThis as Record<string, unknown>)[key] = new StorageCtor();
    } catch {
      // Node's Storage is not constructable; leave the global absent.
    }
  }
}
import { setStoreFactory } from './src/core/storeFactory';
import { setSchedulerFactory } from './src/core/scheduler';
import { setSecureTokenStoreFactory } from './src/core/secureTokenStore';
import { setProcessSpawnerFactory } from './src/core/processSpawner';
import { setPushNotificationSinkFactory } from './src/core/pushNotificationSink';
import { setPowerSaveBlockerFactory } from './src/core/powerSaveBlocker';
import { setPreTurnWorkerFactory } from './src/core/preTurnWorker';
import { setCurrentUserProviderFactory } from './src/core/currentUserProvider';
import { setEmbeddingGeneratorFactory } from './src/core/embeddingGenerator';
import { setDockBadgeFactory } from './src/core/dockBadge';
import { setDesktopNotificationSinkFactory } from './src/core/desktopNotificationSink';
import { setWorkspaceFileSystemFactory, type WorkspaceFileSystem } from './src/core/workspaceFileSystem';
import { setErrorReporter } from './src/core/errorReporter';
import { setTracker } from './src/core/tracking';
import { setBroadcastService } from './src/core/broadcastService';
import { setSettingsStoreAdapter } from './src/core/services/settingsStore';
import { TestMemoryStore } from './src/core/__tests__/TestMemoryStore';
import { DEFAULT_TEST_SETTINGS } from './src/core/__tests__/builders/settingsBuilder';
// NOTE: ElectronWorkspaceFileSystem is loaded LAZILY inside its factory thunk below
// (NOT statically here) — see the invariant comment at setWorkspaceFileSystemFactory.
import { MainProcessSpawner } from './src/main/services/mcp/mcpSubprocessAdapter';
import { NoOpPushNotificationSink } from './src/main/services/pushNotificationSink/noOpPushNotificationSink';

// Initialize PlatformConfig for tests so that @core/utils/dataPaths and
// other core modules that depend on getPlatformConfig() work correctly.
// Values match the mocked electron app below.
setPlatformConfig({
  userDataPath: '/tmp/test-user-data',
  appPath: '/tmp/test-app',
  tempPath: '/tmp/test-temp',
  logsPath: '/tmp/test-logs',
  homePath: '/tmp/test-home',
  documentsPath: '/tmp/test-documents',
  desktopPath: '/tmp/test-desktop',
  appDataPath: '/tmp/test-appData',
  version: '0.0.0-test',
  isPackaged: false,
  platform: process.platform,
  totalMemoryBytes: 36 * 1024 * 1024 * 1024, // 36 GB
  arch: process.arch,
  surface: 'desktop',
  isOss: false,
});

// Initialize StoreFactory with in-memory stores for tests.
// Must be before any module that calls createStore().
// TestMemoryStore is imported from src/core/__tests__/TestMemoryStore.ts (single source of truth).
setStoreFactory((opts) => new TestMemoryStore(opts) as any);
setSchedulerFactory(() => ({
  registerTimeout: (callback, delayMs) => setTimeout(callback, Math.max(0, delayMs)),
  registerInterval: (callback, intervalMs) => setInterval(callback, Math.max(0, intervalMs)),
  clear: (timer) => clearTimeout(timer),
  now: () => Date.now(),
  sleep: async (ms: number) => new Promise((resolve) => {
    setTimeout(resolve, Math.max(0, ms));
  }),
  isVisible: () => true,
  deferUntilVisible: async () => 'visible',
}));
setSecureTokenStoreFactory(() => ({
  isEncryptionAvailable: () => false,
  read: ({ store, key, validate }) => {
    const stored = store.get(key);
    if (typeof stored !== 'string' || stored.length === 0) return null;
    const plain = Buffer.from(stored, 'base64').toString('utf-8');
    return validate(plain) ? plain : null;
  },
  write: ({ store, key, value }) => {
    store.set(key, Buffer.from(value).toString('base64'));
  },
  delete: ({ store, key }) => {
    store.delete(key);
  },
  has: ({ store, key }) => store.has(key),
}));
setProcessSpawnerFactory(() => new MainProcessSpawner());
setPushNotificationSinkFactory(() => new NoOpPushNotificationSink());
setPowerSaveBlockerFactory(() => ({
  acquireBlock: () => {},
  releaseBlock: () => {},
  getBlockerStatus: () => ({
    active: false,
    refCount: 0,
    reasons: {},
    startedAt: null,
    durationMs: null,
  }),
  dispose: () => {},
  resetForTesting: () => {},
}));
setPreTurnWorkerFactory(() => ({
  waitForWorkerReady: async () => {},
  isWorkerAvailable: () => false,
  assemblePreTurnContext: async () => ({}),
  disposeWorker: async () => {},
  getWorkerStatus: () => ({
    isReady: false,
    permanentlyDisabled: true,
    consecutiveCrashes: 0,
    crashCooldownRemainingMs: 0,
    workspacePath: null,
  }),
  getPreTurnWorkerStats: () => ({
    since: 'app_start',
    appStartedAt: Date.now(),
    spawnCount: 0,
    restartCount: 0,
    currentlyRestarting: false,
  }),
}));
setCurrentUserProviderFactory(() => ({
  getCurrentUser: () => null,
}));
setEmbeddingGeneratorFactory(() => ({
  generateEmbedding: async () => new Float32Array(384),
  generateQueryEmbedding: async () => new Float32Array(384),
  generateEmbeddings: async (texts: string[]) => texts.map(() => new Float32Array(384)),
}));
setDockBadgeFactory(() => ({
  initDockBadge: () => {},
  showUnreadDot: () => {},
  clearUnreadDot: () => {},
}));
setDesktopNotificationSinkFactory(() => ({
  showDesktopNotification: () => {},
}));
// INVARIANT: setupFiles must NOT statically import concrete workspace-filesystem
// implementations. ElectronWorkspaceFileSystem's module graph reaches boundedWorkspaceFs
// (via guardedPath AND directly), whose local lane binds `import fsp from 'node:fs/promises'`
// at module-eval time. A static import here evaluates that graph during setupFiles — BEFORE
// per-suite vi.mock('node:fs/promises') runs — permanently binding the boundary's local lane
// to REAL fs and silently defeating every desktop suite's fs mock (wrong-pass / timeout).
// Loading EWFS lazily inside the factory thunk defers boundary evaluation until the first
// getWorkspaceFileSystem() call (after mocks are installed). The check-workspace-fs-boundary
// gate enforces this (no static setup import of boundary-governed files). See
// docs/plans/260619_cloud-symlink-indexing (S4.1b blocker decision).
//
// CROSS-SURFACE: this setup file is shared by every vitest project, but the lazy `require`
// only resolves in the desktop project. Non-desktop projects (e.g. cloud-service) keep
// `src/main` outside their transform scope, so vitest's require hook never intercepts the
// `.ts` path and native `require` throws "Cannot find module". Those projects set their OWN
// factory before use (e.g. CloudWorkspaceFileSystem in cloud-service routes tests); the
// default here only needs to be CONSTRUCTIBLE so a pre-override capture
// (`const prev = getWorkspaceFileSystem()`) doesn't throw. On require failure we therefore
// return a loud-on-use stub: constructing it is free, but any actual method call throws
// (carrying the original resolution error) — never a silent no-op filesystem.
// Only the REQUIRED WorkspaceFileSystem methods are stubbed. The optional members
// (`appendFile?`/`renameFile?`) are deliberately omitted so optional-method feature
// detection (`if (fs.appendFile)`) correctly reports them as unsupported on the stub,
// rather than "supported but throws".
const WORKSPACE_FS_METHODS = [
  'listDirectory',
  'realPath',
  'stat',
  'readFile',
  'writeFile',
  'deleteFile',
  'exists',
] as const;
setWorkspaceFileSystemFactory((): WorkspaceFileSystem => {
  try {
    const {
      ElectronWorkspaceFileSystem,
    }: typeof import('./src/main/services/workspaceFileSystem/electronWorkspaceFileSystem') = require(
      './src/main/services/workspaceFileSystem/electronWorkspaceFileSystem',
    );
    return new ElectronWorkspaceFileSystem();
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    // ONLY the expected cross-surface condition is tolerated: the EWFS module ITSELF is
    // unresolvable (non-desktop project where `src/main` is outside transform scope). A
    // genuine desktop-side breakage — a transitive dependency of EWFS failing to resolve, or
    // a module-eval error inside the impl — must still surface loudly at construction.
    // Node names the REQUESTED missing module in the first `Cannot find module '<specifier>'`
    // of the message; the require-stack frames that follow can name electronWorkspaceFileSystem
    // as an IMPORTER even when it is NOT the missing module. So match the requested specifier,
    // never any occurrence in the full message — otherwise a transitive failure would be
    // misclassified as the cross-surface case and silently reframed as the stub.
    const requestedMissingModule = /Cannot find module ['"]([^'"]+)['"]/.exec(cause)?.[1];
    const isEwfsModuleItselfMissing =
      requestedMissingModule?.endsWith('electronWorkspaceFileSystem') === true;
    if (!isEwfsModuleItselfMissing) {
      throw error;
    }
    const stub = Object.fromEntries(
      WORKSPACE_FS_METHODS.map((method) => [
        method,
        () => {
          throw new Error(
            `WorkspaceFileSystem.${method}() was called in a vitest project that cannot load ` +
              `ElectronWorkspaceFileSystem (e.g. cloud-service). Set a project-appropriate factory ` +
              `via setWorkspaceFileSystemFactory() before workspace file access. ` +
              `Original resolution error: ${cause}`,
          );
        },
      ]),
    );
    return stub as unknown as WorkspaceFileSystem;
  }
});

// Initialize other boundary interfaces with test-safe defaults.
setErrorReporter({
  captureException: () => {},
  captureMessage: () => {},
  addBreadcrumb: () => {},
});
setTracker({ track: () => {}, identify: () => {}, getAnonymousId: () => '', isAvailable: () => false });
setBroadcastService({
  sendToAllWindows: () => {},
  sendToFocusedWindow: () => {},
});

// Initialize SettingsStoreAdapter with test-safe defaults.
// Provides getSettings()/updateSettings() so core modules that import from
// @core/services/settingsStore work without requiring electron-store.
// DEFAULT_TEST_SETTINGS is the single source of truth (from settingsBuilder).
setSettingsStoreAdapter({
  getSettings: () => structuredClone(DEFAULT_TEST_SETTINGS),
  updateSettings: () => { /* no-op in tests */ },
  updateSettingsAtomic: () => { /* no-op in tests */ },
});

// Global no-op logger mock — provides silent logger instances so individual
// test files don't each need their own vi.mock('@core/logger') boilerplate.
// Per-file vi.mock('@core/logger', ...) calls override this global mock,
// so existing tests that define their own logger mocks still work unchanged.
const noopLogMethods = vi.hoisted(() => {
  const createNoopLogMethods = () => ({
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn(() => createNoopLogMethods()),
    isLevelEnabled: vi.fn(() => false),
  });
  return createNoopLogMethods;
});
vi.mock('@core/logger', () => {
  const methods = noopLogMethods();
  return {
    logger: methods,
    createScopedLogger: vi.fn(() => noopLogMethods()),
    createTurnSessionLogger: vi.fn(() => ({
      ...noopLogMethods(),
      sessionLogPath: null,
      flushSessionLogs: vi.fn(async () => {}),
    })),
    logAtLevel: vi.fn(),
    runWithTurnContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
    getTurnContext: vi.fn(() => undefined),
    getRecentLogs: vi.fn(() => []),
    clearLogBuffer: vi.fn(),
    getLogDirectory: vi.fn(() => '/tmp/test-logs'),
    getLogFilePath: vi.fn(() => '/tmp/test-logs/mindstone-rebel.log'),
    cleanupSessionLogs: vi.fn(async () => ({ deleted: 0, errors: 0, remainingCount: 0, remainingBytes: 0 })),
    SESSION_LOG_DEFAULTS: { retentionDays: 14, maxFiles: 200, maxBytes: 250 * 1024 * 1024 },
    _resetCleanupGuard: vi.fn(),
    _isCleanupRunning: vi.fn(() => false),
  };
});

// Initialize Codex auth boundary with a safe default for tests that import
// agentTurnExecutor/localModelProxyServer directly (outside full bootstrap).
const { setCodexAuthProvider, NULL_CODEX_AUTH_PROVIDER } = await import('./src/core/codexAuth');
setCodexAuthProvider(NULL_CODEX_AUTH_PROVIDER);

// Mock expo-server-sdk for cloud-service tests
vi.mock('expo-server-sdk', () => {
  class Expo {
    static isExpoPushToken(token: string): boolean {
      return typeof token === 'string' && token.startsWith('ExponentPushToken[');
    }
    chunkPushNotifications(messages: unknown[]): unknown[][] {
      return [messages];
    }
    async sendPushNotificationsAsync(_messages: unknown[]): Promise<{ status: string; id: string }[]> {
      return _messages.map(() => ({ status: 'ok', id: 'mock-receipt-id' }));
    }
  }
  return { default: Expo, Expo };
});

// Mock electron-store for main process tests (still needed for settingsStore.ts + index.ts)
// This must come before any module that imports electron-store
vi.mock('electron-store', () => {
  class MemoryStore<T extends Record<string, unknown>> {
    private data: T;
    private readonly defaults: T;
    constructor(options?: { defaults?: T; name?: string }) {
      this.defaults = options?.defaults ?? {} as T;
      this.data = structuredClone(this.defaults);
    }
    get store(): T {
      return this.data;
    }
    set store(value: T) {
      this.data = value;
    }
    get<K extends keyof T>(key: K): T[K] {
      return this.data[key];
    }
    set<K extends keyof T>(key: K, value: T[K]): void {
      this.data[key] = value;
    }
    has(key: keyof T): boolean {
      return key in this.data;
    }
    delete(key: keyof T): void {
      delete this.data[key];
    }
    clear(): void {
      this.data = structuredClone(this.defaults);
    }
    onDidChange(_key: keyof T, _callback: () => void): () => void {
      return () => {};
    }
    onDidAnyChange(_callback: () => void): () => void {
      return () => {};
    }
  }
  return { default: MemoryStore };
});

// Mock electron module for main process tests
vi.mock('electron', () => ({
  default: {
    app: {
      getPath: vi.fn((name: string) => {
        if (name === 'userData') return '/tmp/test-user-data';
        if (name === 'logs') return '/tmp/test-logs';
        return `/tmp/test-${name}`;
      }),
      getVersion: vi.fn(() => '0.0.0-test'),
      isPackaged: false,
      getName: vi.fn(() => 'mindstone-rebel-test'),
      on: vi.fn(),
      quit: vi.fn(),
    },
    ipcMain: {
      handle: vi.fn(),
      on: vi.fn(),
      removeHandler: vi.fn(),
    },
    BrowserWindow: vi.fn(),
    shell: {
      openExternal: vi.fn(),
      openPath: vi.fn(),
    },
    dialog: {
      showOpenDialog: vi.fn(),
      showSaveDialog: vi.fn(),
      showMessageBox: vi.fn(),
    },
    nativeTheme: {
      shouldUseDarkColors: true,
      themeSource: 'system',
    },
  },
  app: {
    getPath: vi.fn((name: string) => {
      if (name === 'userData') return '/tmp/test-user-data';
      if (name === 'logs') return '/tmp/test-logs';
      return `/tmp/test-${name}`;
    }),
    getVersion: vi.fn(() => '0.0.0-test'),
    isPackaged: false,
    getName: vi.fn(() => 'mindstone-rebel-test'),
    on: vi.fn(),
    quit: vi.fn(),
  },
  ipcMain: {
    handle: vi.fn(),
    on: vi.fn(),
    removeHandler: vi.fn(),
  },
  BrowserWindow: vi.fn(),
  shell: {
    openExternal: vi.fn(),
    openPath: vi.fn(),
  },
  dialog: {
    showOpenDialog: vi.fn(),
    showSaveDialog: vi.fn(),
    showMessageBox: vi.fn(),
  },
  nativeTheme: {
    shouldUseDarkColors: true,
    themeSource: 'system',
  },
}));

// Mock @sentry/electron/main
vi.mock('@sentry/electron/main', () => ({
  init: vi.fn(),
  captureException: vi.fn(() => 'mock-event-id'),
  captureMessage: vi.fn(() => 'mock-event-id'),
  addBreadcrumb: vi.fn(),
  setTag: vi.fn(),
  setContext: vi.fn(),
  setUser: vi.fn(),
  flush: vi.fn(() => Promise.resolve(true)),
  close: vi.fn(() => Promise.resolve()),
  IPCMode: { Classic: 'classic', Protocol: 'protocol' },
  withScope: vi.fn((callback) => callback({ setExtra: vi.fn(), setTag: vi.fn() })),
}));

// Initialize prompt file service globally so tests that import services
// using getPrompt() don't need per-file configurePromptFileService() calls.
// Uses dynamic import to avoid triggering module resolution before mocks above.
const { configurePromptFileService } = await import('./src/core/services/promptFileService');
configurePromptFileService(path.resolve(__dirname, 'rebel-system', 'prompts'));

