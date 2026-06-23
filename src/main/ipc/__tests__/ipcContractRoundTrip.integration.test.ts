import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';

import type { StoreFactoryOptions } from '@core/storeFactory';
import { TestMemoryStore } from '@core/__tests__/TestMemoryStore';
import { buildSettings } from '@core/__tests__/builders/settingsBuilder';
import type { KeyValueStore } from '@core/store';
import type { InvokeChannelDef } from '@shared/ipc/schemas/common';
import { feedbackChannels } from '@shared/ipc/channels/feedback';
import { libraryChannels } from '@shared/ipc/channels/library';

// These fakes neutralize ambient module-scope services pulled in by handler modules
// while preserving the handler behavior under test. To add a channel, provide its
// channelDef, raw request, real register function, and expected response; only add
// more fakes when that channel's registration imports another ambient service.
vi.mock('@core/logger', () => ({
  createScopedLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('@core/platform', () => ({
  getPlatformConfig: () => ({
    version: '0.0.0-test',
    platform: 'test',
    arch: 'x64',
    getPath: () => '/tmp/rebel-test',
  }),
}));

vi.mock('@core/featureGating', () => ({
  isFeatureEnabled: vi.fn().mockReturnValue(false),
}));

vi.mock('@core/services/settingsStore', () => ({
  updateSettingsAtomic: vi.fn(),
}));

vi.mock('@core/currentUserProvider', () => ({
  getCurrentUserProvider: () => ({
    getCurrentUser: vi.fn(() => null),
  }),
}));

vi.mock('@core/rebelAuth', () => ({
  getRebelAuthProvider: () => ({
    getAuthState: vi.fn(() => ({ isAuthenticated: false, user: null, isLoading: false })),
    onAuthStateChange: vi.fn(() => () => {}),
    getAccessToken: vi.fn(async () => null),
    invalidateAccessToken: vi.fn(),
    initializeAuth: vi.fn(async () => ({ isAuthenticated: false, user: null, isLoading: false })),
    setPostLoginCallback: vi.fn(),
    getCachedAuthConfig: vi.fn(() => null),
    requestAuthConfigRefresh: vi.fn(async () => {}),
    clearCachedProviderKey: vi.fn(),
    getSharedDriveConfig: vi.fn(() => null),
    getSubscriptionState: vi.fn(() => null),
    getManagedAllowanceResetsAt: vi.fn(() => undefined),
    refreshLicenseTier: vi.fn(),
  }),
}));

vi.mock('@core/skillQualityScore', () => ({
  computeSkillQualityScore: vi.fn().mockReturnValue({ overallScore: 50, breakdown: {} }),
}));

vi.mock('@core/utils/portablePath', () => ({
  toPortablePath: vi.fn((filePath: string) => filePath),
  relativePortablePath: vi.fn((filePath: string) => filePath),
}));

vi.mock('../../tracking', () => ({
  mainTracking: {
    skillCreated: vi.fn(),
    workArtifactCreated: vi.fn(),
  },
}));

vi.mock('../../services/systemSettingsSync', () => ({
  getSystemSettingsPath: () => '/tmp/rebel-system',
}));

vi.mock('../../utils/cloudStorageUtils', () => ({
  detectCloudStorage: vi.fn().mockReturnValue(null),
}));

vi.mock('../../services/demoModeService', () => ({
  isDemoModeActive: vi.fn().mockReturnValue(false),
}));

vi.mock('../../services/fileTreeService', () => ({
  buildFileTree: vi.fn(),
  countLibraryItems: vi.fn(),
}));

vi.mock('../../services/spaceService', () => ({
  scanSpacesWithSideEffects: vi.fn().mockResolvedValue([]),
  scanSpacesReadOnly: vi.fn().mockResolvedValue([]),
  scanSuggestedSpaces: vi.fn(),
  scanForFrontmatterWarnings: vi.fn(),
  createSpace: vi.fn(),
  initializeSpaceReadme: vi.fn(),
  removeSpace: vi.fn(),
  moveSpace: vi.fn(),
  renameSpace: vi.fn(),
  migrateSpacePathInSettings: vi.fn(),
  updateSpaceFrontmatter: vi.fn(),
  reconcileSpacesWithSettings: vi.fn(),
  readSpaceReadmeFrontmatter: vi.fn(),
  migrateLegacyAgentsMd: vi.fn(),
  resolveViaSpaceName: vi.fn().mockResolvedValue(null),
  invalidateSpaceScanCache: vi.fn(),
  registerSpaceScanCacheInvalidationListener: vi.fn(() => () => {}),
  isSpaceScanAccessError: vi.fn().mockReturnValue(false),
}));

vi.mock('../../services/skillsService', () => ({
  scanSkills: vi.fn(),
  getExampleMetas: vi.fn(),
}));

vi.mock('../../services/skillAttributionRepairService', () => ({
  repairSharedSkillAttributionFromScanResult: vi.fn(),
}));

vi.mock('../../services/skillUsageStore', () => ({
  getAllSkillUsage: vi.fn().mockReturnValue({}),
}));

vi.mock('../../services/behindTheScenesClient', () => ({
  callBehindTheScenesWithAuth: vi.fn(),
}));

vi.mock('../../services/achievementsStore', () => ({
  markJourneyDayComplete: vi.fn(),
  getOnboardingJourney: vi.fn(),
}));

vi.mock('../../services/achievementsEvaluator', () => ({
  getCurrentJourneyDay: vi.fn(),
}));

vi.mock('../../services/sharedDriveHealthService', () => ({
  runSharedDriveHealthChecks: vi.fn(),
}));

vi.mock('../../services/sharedSkillMutationService', () => ({
  sharedSkillMutationService: {
    writeManagedSkillFile: vi.fn(),
    attachManagedWriteObserver: vi.fn(),
  },
}));

vi.mock('../../services/driveSkillHistoryService', () => ({
  driveSkillHistoryService: {
    listVersions: vi.fn(),
    getSnapshot: vi.fn(),
    restoreVersion: vi.fn(),
    forkSnapshotToChiefOfStaff: vi.fn(),
  },
}));

vi.mock('../../services/skillChangeNotificationService', () => ({
  skillChangeNotificationService: {
    attachManagedWriteObserver: vi.fn(),
  },
}));

vi.mock('../../services/libraryBroadcaster', () => ({
  libraryBroadcaster: {
    broadcast: vi.fn(),
  },
}));

type RegisterHandlers = () => void | Promise<void>;

async function invokeContract<TRequest extends z.ZodTypeAny, TResponse extends z.ZodTypeAny>(
  channelDef: InvokeChannelDef<TRequest, TResponse>,
  rawRequest: unknown,
  registerHandlers: RegisterHandlers,
): Promise<z.infer<TResponse>> {
  // This is the intended seam for IPC handler contract tests: real registration,
  // real handler, JSON wire, and response.parse. Add new channels here.
  const [{ MapHandlerRegistry }, { setHandlerRegistry }] = await Promise.all([
    import('@core/handlerRegistry/mapHandlerRegistry'),
    import('@core/handlerRegistry'),
  ]);
  const registry = new MapHandlerRegistry();
  setHandlerRegistry(registry);

  await registerHandlers();

  const handler = registry.get(channelDef.channel);
  expect(handler, `${channelDef.channel} registered`).toBeDefined();

  // Request-side parsing is per-handler, not done here: feedback handlers parse
  // their own request schema (so the malformed-request test asserts that handler's
  // own parse), whereas library:stat-file takes a raw path string and doesn't
  // self-parse. invokeContract only guarantees the RESPONSE-side contract below.
  const result = await handler!(null, rawRequest);
  // JSON wire catches missing or wrongly typed response fields, including
  // undefined being dropped. Zod strips unknown fields by default, so this does
  // not catch extra-field drift. The cloud route currently JSON-sends without
  // response.parse, so this guards handler-vs-contract drift rather than full
  // cloud-route behavior.
  const wire = JSON.parse(JSON.stringify(result));

  return channelDef.response.parse(wire);
}

async function installMemoryStoreFactory(): Promise<void> {
  const { setStoreFactory } = await import('@core/storeFactory');
  setStoreFactory(<T extends Record<string, unknown>>(options: StoreFactoryOptions<T>) =>
    new TestMemoryStore(options) as unknown as KeyValueStore<T>,
  );
}

async function resetHandlerRegistryGlobal(): Promise<void> {
  const [{ MapHandlerRegistry }, { setHandlerRegistry }] = await Promise.all([
    import('@core/handlerRegistry/mapHandlerRegistry'),
    import('@core/handlerRegistry'),
  ]);
  setHandlerRegistry(new MapHandlerRegistry());
}

async function registerFeedbackHandlersForTest(): Promise<void> {
  const { registerFeedbackHandlers } = await import('../feedbackHandlers');
  registerFeedbackHandlers();
}

describe('IPC contract round trip harness', () => {
  let workspacePath: string | null = null;

  beforeEach(async () => {
    vi.resetModules();
    await installMemoryStoreFactory();
  });

  afterEach(async () => {
    if (workspacePath) {
      await rm(workspacePath, { recursive: true, force: true });
      workspacePath = null;
    }
    await resetHandlerRegistryGlobal();
    // Drops conversationFeedbackStore's module-scoped _store before the next test.
    vi.resetModules();
  });

  it('round-trips feedback:conversation-get through real registration, handler, wire JSON, and response contract', async () => {
    const response = await invokeContract(
      feedbackChannels['feedback:conversation-get'],
      { sessionId: 'session-feedback-get' },
      registerFeedbackHandlersForTest,
    );

    expect(response).toEqual({
      votes: [],
      dismissedAt: null,
    });
  });

  it('round-trips feedback:conversation-rate through real registration, handler, wire JSON, and response contract', async () => {
    const response = await invokeContract(
      feedbackChannels['feedback:conversation-rate'],
      {
        sessionId: 'session-feedback-rate',
        rating: 4,
        comment: 'Useful answer',
        chips: ['saved-time'],
      },
      registerFeedbackHandlersForTest,
    );

    expect(response).toEqual({
      success: true,
      voteId: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      ),
    });
  });

  it('rejects malformed raw requests from the handler-owned request parse', async () => {
    await expect(invokeContract(
      feedbackChannels['feedback:conversation-rate'],
      {
        sessionId: 'session-feedback-rate-malformed',
        rating: 4,
        chips: ['saved-time'],
      },
      registerFeedbackHandlersForTest,
    )).rejects.toMatchObject({
      issues: expect.arrayContaining([
        expect.objectContaining({
          path: ['comment'],
        }),
      ]),
    });
  });

  it('round-trips library:stat-file through real registration, handler, wire JSON, and response contract', async () => {
    workspacePath = await mkdtemp(path.join(os.tmpdir(), 'rebel-ipc-contract-'));
    const fixturePath = path.join(workspacePath, 'fixture.txt');
    await writeFile(fixturePath, 'contract harness fixture', 'utf8');

    const settings = buildSettings({
      coreDirectory: workspacePath,
      spaces: [],
    });

    const response = await invokeContract(
      libraryChannels['library:stat-file'],
      'fixture.txt',
      async () => {
        const { registerLibraryHandlers } = await import('../libraryHandlers');
        registerLibraryHandlers({
          getSettings: () => settings,
          getSettingsStore: () => ({ store: settings }),
        });
      },
    );

    expect(response).toEqual({
      exists: true,
      mtimeMs: expect.any(Number),
      size: Buffer.byteLength('contract harness fixture'),
    });
  });

  it('round-trips library:stat-file missing-file null branch through JSON wire and response contract', async () => {
    workspacePath = await mkdtemp(path.join(os.tmpdir(), 'rebel-ipc-contract-'));

    const settings = buildSettings({
      coreDirectory: workspacePath,
      spaces: [],
    });

    const response = await invokeContract(
      libraryChannels['library:stat-file'],
      'missing-fixture.txt',
      async () => {
        const { registerLibraryHandlers } = await import('../libraryHandlers');
        registerLibraryHandlers({
          getSettings: () => settings,
          getSettingsStore: () => ({ store: settings }),
        });
      },
    );

    expect(response).toEqual({
      exists: false,
      mtimeMs: null,
      size: null,
    });
  });
});
