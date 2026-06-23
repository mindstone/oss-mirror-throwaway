import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CODEX_BTS_PROFILE_ID,
  CODEX_WORKING_PROFILE_ID,
} from '@shared/utils/codexDefaults';

const makeTempUserDataDir = (): string => {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rebel-cloud-bootstrap-migration-'));
};

const writeSettings = (dir: string, settings: Record<string, unknown>): void => {
  fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify(settings, null, 2), 'utf-8');
};

const readSettings = (dir: string): Record<string, unknown> =>
  JSON.parse(fs.readFileSync(path.join(dir, 'app-settings.json'), 'utf-8')) as Record<string, unknown>;

const installBootstrapMocks = (): void => {
  vi.doMock('@sentry/node', () => ({
    init: vi.fn(),
    captureException: vi.fn(),
    captureMessage: vi.fn(),
    addBreadcrumb: vi.fn(),
    withScope: vi.fn(),
  }));
  vi.doMock('@core/logger', () => ({
    createScopedLogger: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    }),
  }));
  vi.doMock('@core/errorReporter', () => ({
    setErrorReporter: vi.fn(),
    getErrorReporter: vi.fn(() => ({
      captureException: vi.fn(),
      captureMessage: vi.fn(),
      addBreadcrumb: vi.fn(),
    })),
  }));
  vi.doMock('@core/utils/gracefulFsObservability', () => ({
    installGracefulFsObservability: vi.fn(() => vi.fn()),
  }));
  vi.doMock('@core/storeFactory', () => ({
    setStoreFactory: vi.fn(),
    createStore: vi.fn(),
  }));
  vi.doMock('@core/tracking', () => ({ setTracker: vi.fn() }));
  vi.doMock('@core/broadcastService', () => ({ setBroadcastService: vi.fn() }));
  vi.doMock('@core/codexAuth', () => ({ setCodexAuthProvider: vi.fn() }));
  vi.doMock('@core/services/defaultCodexAuthProvider', () => ({ DEFAULT_CODEX_AUTH_PROVIDER: {} }));
  vi.doMock('@core/handlerRegistry', () => ({
    setHandlerRegistry: vi.fn(),
    getHandlerRegistry: vi.fn(() => ({ register: vi.fn() })),
  }));
  vi.doMock('@core/safetyEvaluationService', () => ({ setSafetyEvaluationService: vi.fn() }));
  vi.doMock('@core/featureGating', () => ({ setLicenseTier: vi.fn() }));
  vi.doMock('@rebel/cloud-client', () => ({ setLogErrorReporter: vi.fn() }));
  vi.doMock('../mapHandlerRegistry', () => ({ MapHandlerRegistry: class MapHandlerRegistry {} }));
  vi.doMock('../cloudEventBroadcaster', () => ({
    cloudEventBroadcaster: { broadcast: vi.fn(), virtualWindow: {} },
  }));
  vi.doMock('@core/services/settingsStore', () => ({ setSettingsStoreAdapter: vi.fn() }));
  vi.doMock('@core/services/safety/btsSafetyEvalService', () => ({
    createBtsSafetyEvalService: vi.fn(() => ({})),
  }));
  vi.doMock('@core/services/incrementalSessionStore', () => ({
    getIncrementalSessionStore: vi.fn(),
  }));
  vi.doMock('@core/services/agentTurnService', () => ({
    startAgentTurn: vi.fn(),
  }));
  vi.doMock('@core/services/agentTurnRegistry', () => ({ agentTurnRegistry: {} }));
  vi.doMock('@core/services/turnPipeline/agentTurnExecute', () => ({ executeAgentTurn: vi.fn() }));
  vi.doMock('@core/services/agentEventDispatcher', () => ({ dispatchAgentEvent: vi.fn() }));
  vi.doMock('@core/services/superMcpHttpManager', () => ({
    superMcpHttpManager: {},
    findAvailablePort: vi.fn(),
  }));
  vi.doMock('@main/services/coreStartup', () => ({ initCoreServices: vi.fn() }));
  vi.doMock('@main/services/safety', () => ({ createMemoryWriteHook: vi.fn() }));
  vi.doMock('@core/services/safety/mcpDenyHook', () => ({ createMcpDenyHook: vi.fn() }));
  vi.doMock('@core/services/transcriptService', () => ({ cleanupOldTranscripts: vi.fn() }));
  vi.doMock('@shared/utils/btsModelResolver', () => ({ resolveBtsModel: vi.fn() }));
  vi.doMock('@shared/utils/modelNormalization', async () => ({
    ...(await vi.importActual<typeof import('@shared/utils/modelNormalization')>('@shared/utils/modelNormalization')),
    DEFAULT_AUXILIARY_MODEL: 'test-model',
  }));
  vi.doMock('@core/services/continuity/serverClock', () => ({
    clearServerClockSession: vi.fn(),
    seedServerClock: vi.fn(),
    stampCloudUpdatedAt: vi.fn(),
  }));
  vi.doMock('@core/services/continuity/sessionSeqIndex', () => ({
    getMaxSeqFromSession: vi.fn(),
    getSessionSeqIndex: vi.fn(),
  }));
  vi.doMock('@core/services/continuity/outboxStallMonitor', () => ({
    getOutboxStallMonitor: vi.fn(),
  }));
  vi.doMock('@core/services/continuity/sessionTombstoneStore', () => ({
    getSessionTombstoneStore: vi.fn(),
  }));
  vi.doMock('../services/cleanupLeakedSessionsBridge', () => ({
    createCleanupLeakedSessionDeletedCallback: vi.fn(),
  }));
  vi.doMock('electron-store', async () => {
    const shim = await vi.importActual<typeof import('../electronStoreShim')>('../electronStoreShim');
    return { default: shim.default };
  });
};

describe('cloud bootstrap settings migrations', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    delete process.env.REBEL_USER_DATA;
  });

  it('imports the core settings store and auto-fires Codex + models namespace migrations against cloud shim storage', async () => {
    const userDataDir = makeTempUserDataDir();
    process.env.REBEL_USER_DATA = userDataDir;
    writeSettings(userDataDir, {
      activeProvider: 'codex',
      claude: {
        workingProfileId: null,
        model: 'gpt-5.4',
      },
      localModel: {
        profiles: [{
          id: 'codex-gpt-5.4',
          name: 'GPT-5.4 (ChatGPT Pro)',
          authSource: 'codex-subscription',
          model: 'gpt-5.4',
          providerType: 'openai',
          serverUrl: 'https://api.openai.com/v1',
          createdAt: 0,
        }],
        activeProfileId: null,
      },
    });
    installBootstrapMocks();

    await import('../bootstrap');

    // The one-shot boot migrations are now DEFERRED to first settings access
    // (the OSS boot-crash fix). In production cloud, bootstrap() fires them via
    // its getSettings()/heal path; here we trigger that first access directly on
    // the same canonical settings store the bootstrap import wired.
    const { getSettings } = await import('@core/services/settingsStore/index');
    getSettings();

    const migrated = readSettings(userDataDir);
    const models = migrated.models as Record<string, unknown>;
    const localModel = migrated.localModel as { profiles: Array<{ id: string }> };
    expect(models.workingProfileId).toBe(CODEX_WORKING_PROFILE_ID);
    expect(localModel.profiles.map((profile) => profile.id)).toEqual([
      CODEX_WORKING_PROFILE_ID,
      CODEX_BTS_PROFILE_ID,
    ]);
    expect(migrated.codexRepairSchemaVersion).toBe(2);
    expect(migrated.modelsNamespaceSchemaVersion).toBe(2);
    expect(migrated.codexProviderRepairedAt).toEqual(expect.any(Number));
  });

  it('runs models namespace migration even when codex repair is already stamped', async () => {
    const userDataDir = makeTempUserDataDir();
    process.env.REBEL_USER_DATA = userDataDir;
    writeSettings(userDataDir, {
      codexRepairSchemaVersion: 2,
      activeProvider: 'anthropic',
      claude: {
        model: 'claude-opus-4-7',
        apiKey: 'fake-ant-cloud-key',
      },
    });
    installBootstrapMocks();

    await import('../bootstrap');

    // The one-shot boot migrations are now DEFERRED to first settings access
    // (the OSS boot-crash fix). In production cloud, bootstrap() fires them via
    // its getSettings()/heal path; here we trigger that first access directly on
    // the same canonical settings store the bootstrap import wired.
    const { getSettings } = await import('@core/services/settingsStore/index');
    getSettings();

    const migrated = readSettings(userDataDir);
    const models = migrated.models as Record<string, unknown>;
    expect(migrated.modelsNamespaceSchemaVersion).toBe(2);
    expect(models.model).toBe('claude-opus-4-7');
    expect(models.apiKey).toBe('fake-ant-cloud-key');
  });

  it('normalizes already-v2 partial models at cloud bootstrap before serving settings', async () => {
    const userDataDir = makeTempUserDataDir();
    process.env.REBEL_USER_DATA = userDataDir;
    writeSettings(userDataDir, {
      codexRepairSchemaVersion: 2,
      modelsNamespaceSchemaVersion: 2,
      openRouterProviderHealVersion: 1,
      activeProvider: 'anthropic',
      models: {
        apiKey: 'fake-models-cloud-key',
      },
      claude: {
        apiKey: 'fake-legacy-cloud-key',
        model: 'claude-opus-4-7',
        learnedContextWindowEnabled: true,
        thinkingEffort: 'medium',
      },
    });
    installBootstrapMocks();

    const { bootstrap } = await import('../bootstrap');
    await bootstrap().catch(() => undefined);

    const bootNormalized = readSettings(userDataDir);
    const models = bootNormalized.models as Record<string, unknown>;
    expect(bootNormalized.modelsNamespaceSchemaVersion).toBe(2);
    expect(models.apiKey).toBe('fake-models-cloud-key');
    expect(models.model).toBe('claude-opus-4-7');
    expect(models.learnedContextWindowEnabled).toBe(true);
    expect(models.thinkingEffort).toBe('medium');
  });

  it('runs OpenRouter profileSource migration at cloud boot for legacy profile shape', async () => {
    const userDataDir = makeTempUserDataDir();
    process.env.REBEL_USER_DATA = userDataDir;
    writeSettings(userDataDir, {
      codexRepairSchemaVersion: 2,
      modelsNamespaceSchemaVersion: 2,
      openRouterProviderHealVersion: 1,
      activeProvider: 'openrouter',
      openRouter: {
        enabled: true,
        oauthToken: 'fake-or-cloud-token',
        selectedModel: 'anthropic/claude-sonnet-4-6',
      },
      localModel: {
        activeProfileId: null,
        profiles: [{
          id: 'legacy-or',
          name: 'Legacy OR',
          providerType: 'openrouter',
          routeSurface: 'pool',
          serverUrl: 'https://openrouter.ai/api/v1',
          model: 'anthropic/claude-sonnet-4-6',
          createdAt: 0,
          enabled: true,
        }],
      },
    });
    installBootstrapMocks();

    await import('../bootstrap');

    // The one-shot boot migrations are now DEFERRED to first settings access
    // (the OSS boot-crash fix). In production cloud, bootstrap() fires them via
    // its getSettings()/heal path; here we trigger that first access directly on
    // the same canonical settings store the bootstrap import wired.
    const { getSettings } = await import('@core/services/settingsStore/index');
    getSettings();

    const migrated = readSettings(userDataDir);
    const localModel = migrated.localModel as {
      profiles: Array<{ id: string; profileSource?: string }>;
    };

    expect(migrated.openRouterProfileSourceMigrationVersion).toBe(1);
    expect(localModel.profiles).toHaveLength(1);
    expect(localModel.profiles[0]?.id).toBe('legacy-or');
    expect(localModel.profiles[0]?.profileSource).toBe('connection');
  });

  it('propagates cloud shim persist failures and leaves the on-disk flag unstamped', async () => {
    const userDataDir = makeTempUserDataDir();
    process.env.REBEL_USER_DATA = userDataDir;
    const settingsPath = path.join(userDataDir, 'app-settings.json');
    writeSettings(userDataDir, {
      activeProvider: 'codex',
      claude: {
        workingProfileId: null,
        model: 'gpt-5.4',
      },
      localModel: {
        profiles: [],
        activeProfileId: null,
      },
    });
    installBootstrapMocks();
    const originalWriteFileSync = fs.writeFileSync;
    vi.spyOn(fs, 'writeFileSync').mockImplementation((file, data, options) => {
      const filePath = String(file);
      if (filePath === settingsPath || filePath.startsWith(`${settingsPath}.`)) {
        throw new Error('simulated persist failure');
      }
      return originalWriteFileSync(file, data, options);
    });

    await import('../bootstrap');

    // Boot migrations are deferred to first settings access; the persist failure
    // now surfaces from that first read rather than from importing bootstrap.
    const { getSettings } = await import('@core/services/settingsStore/index');
    expect(() => getSettings()).toThrow('Cloud settings persist failed');

    expect(readSettings(userDataDir).codexRepairSchemaVersion).toBeUndefined();
  });
});
