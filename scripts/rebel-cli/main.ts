import './installGracefulFs';
import './platformInit';

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AppSettings } from '@shared/types';
import { userDataPath } from './platformInit';
import { initializeStandaloneStoreFactory } from './storeFactory';
import { flushStandaloneErrorReporter, initializeStandaloneErrorReporter } from './errorReporter';
import { setSchedulerFactory } from '@core/scheduler';
import { setSecureTokenStoreFactory } from '@core/secureTokenStore';
import { setProcessSpawnerFactory } from '@core/processSpawner';
import { setPushNotificationSinkFactory } from '@core/pushNotificationSink';
import { setPowerSaveBlockerFactory } from '@core/powerSaveBlocker';
import { setPreTurnWorkerFactory } from '@core/preTurnWorker';
import { setCurrentUserProviderFactory } from '@core/currentUserProvider';
import { setEmbeddingGeneratorFactory } from '@core/embeddingGenerator';
import { setDockBadgeFactory } from '@core/dockBadge';
import { setDesktopNotificationSinkFactory } from '@core/desktopNotificationSink';
import { setWorkspaceFileSystemFactory } from '@core/workspaceFileSystem';
import { MapHandlerRegistry } from '@core/handlerRegistry/mapHandlerRegistry';
import { StandaloneSecureTokenStore } from './standaloneSecureTokenStore';
import { StandaloneProcessSpawner } from './standaloneProcessSpawner';
import { NoOpPushNotificationSink } from './noOpPushNotificationSink';
import { StandaloneScheduler } from './standaloneScheduler';
import { StandalonePowerSaveBlocker } from './standalonePowerSaveBlocker';
import { StandalonePreTurnWorker } from './standalonePreTurnWorker';
import { StandaloneCurrentUserProvider } from './standaloneCurrentUserProvider';
import { StandaloneEmbeddingGenerator } from './standaloneEmbeddingGenerator';
import { StandaloneDockBadge } from './standaloneDockBadge';
import { StandaloneDesktopNotificationSink } from './standaloneDesktopNotificationSink';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
function findProjectRoot(startDir: string): string {
  let current = startDir;
  for (let i = 0; i < 5; i += 1) {
    if (fs.existsSync(path.join(current, 'package.json'))) return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return path.resolve(startDir, '..', '..');
}
const projectRoot = process.env.REBEL_APP_ROOT || findProjectRoot(__dirname);

const commandName = process.argv.slice(2).find((arg) => !arg.startsWith('-'));
if (commandName === 'smoke-test') {
  process.env.REBEL_STANDALONE_SMOKE_TEST = '1';
  fs.writeSync(2, 'smoke-test is a process-start probe only; use `run -p` or the Electron-backed `smoke-test` for agent health.\n');
  fs.writeSync(1, 'OK\n');
  process.exit(0);
}
if (process.env.REBEL_ANTHROPIC_API_KEY && !process.env.ANTHROPIC_API_KEY) {
  process.env.ANTHROPIC_API_KEY = process.env.REBEL_ANTHROPIC_API_KEY;
}

function withEnvAuth(settings: AppSettings): AppSettings {
  const anthropicKey = process.env.REBEL_ANTHROPIC_API_KEY;
  const openRouterKey = process.env.REBEL_OPENROUTER_API_KEY;
  const next: AppSettings = { ...settings };
  if (anthropicKey) {
    next.models = { ...(settings.models ?? {}), apiKey: anthropicKey } as AppSettings['models'];
    next.claude = { ...(settings.claude ?? {}), apiKey: anthropicKey } as AppSettings['claude'];
  }
  if (openRouterKey) {
    next.openRouter = {
      ...(settings.openRouter ?? {}),
      enabled: true,
      oauthToken: openRouterKey,
    } as AppSettings['openRouter'];
  }
  return next;
}

async function main(): Promise<number> {
  initializeStandaloneStoreFactory();
  setSchedulerFactory(() => new StandaloneScheduler());
  setSecureTokenStoreFactory(() => new StandaloneSecureTokenStore());
  setProcessSpawnerFactory(() => new StandaloneProcessSpawner());
  setPushNotificationSinkFactory(() => new NoOpPushNotificationSink());
  setPowerSaveBlockerFactory(() => new StandalonePowerSaveBlocker());
  setPreTurnWorkerFactory(() => new StandalonePreTurnWorker());
  setCurrentUserProviderFactory(() => new StandaloneCurrentUserProvider());
  setEmbeddingGeneratorFactory(() => new StandaloneEmbeddingGenerator());
  setDockBadgeFactory(() => new StandaloneDockBadge());
  setDesktopNotificationSinkFactory(() => new StandaloneDesktopNotificationSink());
  await initializeStandaloneErrorReporter();

  const [
    { setBroadcastService },
    { setTracker },
    { setFeedbackReporter },
    { setHandlerRegistry },
    { setCodexAuthProvider },
    { setSettingsStoreAdapter },
    { setDiagnosticEventsLedgerReader, setDiagnosticEventsLedgerWriter, setDiagnosticEventsSurface },
    { setSafetyEvaluationService },
    { setLicenseTier },
    { createBtsSafetyEvalService },
    settingsStoreModule,
    { createSessionLockManager, defaultIsProcessAlive },
    { getIncrementalSessionStore },
    { configureCliSessionPersistence },
    { ElectronWorkspaceFileSystem },
    { createHeadlessRuntime },
    { configureCliPlatformDeps, initCliRuntime, parseCliFlagsBeforeRuntime, runCli },
    { loadAttachmentsFromPaths },
    { createCliApprovalHandler },
    { startMcpServer },
  ] = await Promise.all([
    import('@core/broadcastService'),
    import('@core/tracking'),
    import('@core/feedbackReporter'),
    import('@core/handlerRegistry'),
    import('@core/codexAuth'),
    import('@core/services/settingsStore'),
    import('@core/services/diagnosticEventsLedger'),
    import('@core/safetyEvaluationService'),
    import('@core/featureGating'),
    import('@core/services/safety/btsSafetyEvalService'),
    import('@core/services/settingsStore/index'),
    import('@core/utils/sessionFileLock'),
    import('@core/services/incrementalSessionStore'),
    import('@core/services/turnPipeline/headlessTurnRunner'),
    import('../../src/main/services/workspaceFileSystem/electronWorkspaceFileSystem'),
    import('@core/services/headlessRuntime'),
    import('@core/cli/runCli'),
    import('../../src/main/utils/cliAttachments'),
    import('../../src/main/cli/ttyApprovalPrompt'),
    import('../../src/main/mcpServer'),
  ]);

  setBroadcastService({ sendToAllWindows: () => {}, sendToFocusedWindow: () => {} });
  setTracker({ track: () => {}, identify: () => {}, getAnonymousId: () => '', isAvailable: () => false });
  setFeedbackReporter({ submitConversationFeedback: async () => ({}) });
  setHandlerRegistry(new MapHandlerRegistry());
  setDiagnosticEventsLedgerWriter(null);
  setDiagnosticEventsLedgerReader(null);
  setDiagnosticEventsSurface('unknown');
  setLicenseTier('free');
  setWorkspaceFileSystemFactory(() => new ElectronWorkspaceFileSystem());

  setCodexAuthProvider({
    isConnected: () => Boolean(process.env.REBEL_CODEX_TOKEN),
    getAccessToken: async () => process.env.REBEL_CODEX_TOKEN ?? null,
    getAccountId: () => null,
    forceRefreshToken: async () => process.env.REBEL_CODEX_TOKEN ?? null,
    getStatus: () => ({ connected: Boolean(process.env.REBEL_CODEX_TOKEN) }),
  });

  const { getSettings, updateSettings, settingsStore } = settingsStoreModule;
  setSettingsStoreAdapter({
    getSettings: () => withEnvAuth(getSettings()),
    updateSettings,
    updateSettingsAtomic: (updater) => {
      const partial = updater(withEnvAuth(getSettings()));
      if (Object.keys(partial).length > 0) updateSettings(partial);
    },
    onSettingsChange: (callback) => {
      if (settingsStore.onDidAnyChange) {
        return settingsStore.onDidAnyChange((newSettings: AppSettings | undefined) => {
          if (newSettings) callback(withEnvAuth(newSettings));
        });
      }
      return () => {};
    },
  });
  const { registerManagedKeyAvailability } = await import('@core/services/behindTheScenesClient');
  // Standalone CLI has no Electron safeStorage-managed key path; keep BTS routing fail-closed.
  registerManagedKeyAvailability(() => false);
  setSafetyEvaluationService(createBtsSafetyEvalService());

  for (const dir of ['sessions', 'sessions-locks', 'workspace', 'logs', 'mcp']) {
    fs.mkdirSync(path.join(userDataPath, dir), { recursive: true });
  }

  const lockManager = createSessionLockManager({
    locksDirectory: path.join(userDataPath, 'sessions-locks'),
    isProcessAlive: defaultIsProcessAlive,
    now: Date.now,
  });
  configureCliSessionPersistence({
    getSessionStore: getIncrementalSessionStore,
    lockManager,
    ownerKind: 'cli',
  });
  configureCliPlatformDeps({
    loadAttachmentsFromPaths,
    createCliApprovalHandler,
    startMcpServer,
  });

  const cliFlags = parseCliFlagsBeforeRuntime();
  const routerConfigPath = path.join(userDataPath, 'mcp', 'super-mcp-router.json');
  const runtime = await createHeadlessRuntime({
    userDataDir: userDataPath,
    resourcesDir: path.join(projectRoot, 'resources'),
    isPackaged: false,
    routerConfigPath,
    getSettings: () => withEnvAuth(getSettings()),
    updateSettings,
    loadAgentSessions: () => getIncrementalSessionStore().loadSync(),
    preOAuthCallHook: async () => {},
    skipMcp: cliFlags.noMcp || commandName === 'smoke-test',
  });

  initCliRuntime({
    runtime,
    appVersion: process.env.REBEL_VERSION || __REBEL_VERSION__,
    getSessionStore: getIncrementalSessionStore,
    lockManager,
  });

  try {
    return await runCli();
  } finally {
    await runtime.cleanup();
  }
}

main()
  .then(async (code) => {
    await flushStandaloneErrorReporter();
    process.exitCode = code;
  })
  .catch(async (error) => {
    console.error(error instanceof Error ? error.message : String(error));
    await flushStandaloneErrorReporter();
    process.exitCode = 1;
  });
