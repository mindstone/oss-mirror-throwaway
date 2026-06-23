import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings } from '@shared/types';

const registeredHandlers = new Map<string, (event: unknown, request: unknown) => unknown>();

const mockListVersions = vi.fn();
const mockGetSnapshot = vi.fn();
const mockRestoreVersion = vi.fn();
const mockForkSnapshot = vi.fn();
const mockLibraryBroadcasterBroadcast = vi.fn();
const mockGetCurrentUser = vi.fn();

vi.mock('../utils/registerHandler', () => ({
  registerHandler: vi.fn((channel: string, handler: (event: unknown, request: unknown) => unknown) => {
    registeredHandlers.set(channel, handler);
  }),
}));

vi.mock('../../services/driveSkillHistoryService', () => ({
  driveSkillHistoryService: {
    listVersions: (...args: unknown[]) => mockListVersions(...args),
    getSnapshot: (...args: unknown[]) => mockGetSnapshot(...args),
    restoreVersion: (...args: unknown[]) => mockRestoreVersion(...args),
    forkSnapshotToChiefOfStaff: (...args: unknown[]) => mockForkSnapshot(...args),
  },
}));

vi.mock('../../services/skillChangeNotificationService', () => ({
  skillChangeNotificationService: {
    attachManagedWriteObserver: vi.fn(),
    listNotifications: vi.fn().mockResolvedValue([]),
    dismissNotification: vi.fn().mockResolvedValue(true),
  },
}));

vi.mock('@core/currentUserProvider', () => ({
  getCurrentUserProvider: () => ({
    getCurrentUser: () => mockGetCurrentUser(),
  }),
  setCurrentUserProviderFactory: vi.fn(),
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
  setRebelAuthProvider: vi.fn(),
  NULL_REBEL_AUTH_PROVIDER: {},
}));

vi.mock('../../utils/broadcastHelpers', () => ({
  broadcastToAllWindows: vi.fn(),
}));

vi.mock('../../services/libraryBroadcaster', () => ({
  libraryBroadcaster: {
    broadcast: (...args: unknown[]) => mockLibraryBroadcasterBroadcast(...args),
    start: vi.fn(),
    stop: vi.fn(),
  },
}));

const { registerLibraryHandlers } = await import('../libraryHandlers');

describe('libraryHandlers skill-history routing', () => {
  const settings = {
    coreDirectory: '/tmp/workspace',
    mcpConfigFile: null,
    onboardingCompleted: true,
    userFirstName: null,
    userEmail: null,
    onboardingFirstCompletedAt: null,
    voice: {
      provider: 'openai-whisper',
      openaiApiKey: null,
      elevenlabsApiKey: null,
      model: 'gpt-4o-mini-transcribe-2025-12-15',
      ttsVoice: null,
      activationHotkey: 'Alt+Space',
      activationHotkeyVoiceMode: 'V',
    },
    claude: {
      apiKey: null,
      oauthToken: null,
      authMethod: 'api-key',
      model: 'claude-sonnet-4-5',
      permissionMode: 'bypassPermissions',
      executablePath: null,
      planMode: true,
      extendedContext: true,
      thinkingEffort: 'high',
    },
    diagnostics: { debugBreadcrumbsUntil: null },
  } as unknown as AppSettings;

  beforeEach(() => {
    vi.clearAllMocks();
    registeredHandlers.clear();
    mockGetCurrentUser.mockReturnValue({ id: 'user-1', email: 'owner@example.com' });
    registerLibraryHandlers({
      getSettings: () => settings,
      getSettingsStore: () => ({ store: settings }),
    });
  });

  it('routes get-versions and get-snapshot through driveSkillHistoryService', async () => {
    mockListVersions.mockResolvedValue({ success: true, versions: [] });
    mockGetSnapshot.mockResolvedValue({ success: false, error: 'drive-history-unavailable:not-google-drive-backed' });

    const getVersions = registeredHandlers.get('skill-history:get-versions');
    const getSnapshot = registeredHandlers.get('skill-history:get-snapshot');
    expect(getVersions).toBeDefined();
    expect(getSnapshot).toBeDefined();

    await getVersions?.({}, { skillWorkspacePath: 'shared-space/SKILL.md' });
    await getSnapshot?.({}, { skillWorkspacePath: 'shared-space/SKILL.md', snapshotId: 'rev-1' });

    expect(mockListVersions).toHaveBeenCalledWith('/tmp/workspace/shared-space/SKILL.md', '/tmp/workspace');
    expect(mockGetSnapshot).toHaveBeenCalledWith('/tmp/workspace/shared-space/SKILL.md', 'rev-1', '/tmp/workspace');
  });

  it('broadcasts library change after successful restore/fork', async () => {
    mockRestoreVersion.mockResolvedValue({ success: true, path: '/tmp/workspace/shared-space/SKILL.md', currentHash: 'abc', updatedAt: 42 });
    mockForkSnapshot.mockResolvedValue({
      success: true,
      forkPath: '/tmp/workspace/Chief-of-Staff/skills/copied-skill.md',
      forkWorkspaceRelative: 'Chief-of-Staff/skills/copied-skill.md',
    });

    const restore = registeredHandlers.get('skill-history:restore');
    const fork = registeredHandlers.get('skill-history:fork');
    expect(restore).toBeDefined();
    expect(fork).toBeDefined();

    await restore?.({}, { skillWorkspacePath: 'shared-space/SKILL.md', snapshotId: 'rev-restore' });
    await fork?.({}, { skillWorkspacePath: 'shared-space/SKILL.md', snapshotId: 'rev-restore', forkName: 'Copied' });

    expect(mockRestoreVersion).toHaveBeenCalledWith(
      '/tmp/workspace/shared-space/SKILL.md',
      'rev-restore',
      '/tmp/workspace',
      expect.objectContaining({ kind: 'human' }),
    );
    expect(mockForkSnapshot).toHaveBeenCalledWith(
      '/tmp/workspace/shared-space/SKILL.md',
      'rev-restore',
      '/tmp/workspace',
      'Copied',
    );
    expect(mockLibraryBroadcasterBroadcast).toHaveBeenCalledWith(
      expect.objectContaining({ affectsTree: false }),
      'user',
    );
    expect(mockLibraryBroadcasterBroadcast).toHaveBeenCalledWith(
      expect.objectContaining({ affectsTree: true }),
      'user',
    );
  });
});
