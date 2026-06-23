/**
 * Tests for cleanupLegacyMicrosoftEntries in microsoftHandlers.ts.
 *
 * Verifies removal of legacy static Microsoft MCP entries ("Microsoft365Mail")
 * when instance-specific entries ("Microsoft365Mail-user-outlook-com") exist.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — declared before importing the module under test
// ---------------------------------------------------------------------------

const mockGetMcpServerNames = vi.fn();
const mockRemoveMcpServerEntry = vi.fn();

vi.mock('../../services/mcpConfigManager', () => ({
  getMcpServerNames: (...args: unknown[]) => mockGetMcpServerNames(...args),
  removeMcpServerEntry: (...args: unknown[]) => mockRemoveMcpServerEntry(...args),
  upsertMcpServerEntry: vi.fn(),
}));

vi.mock('../../services/bundledMcpManager', () => ({
  MICROSOFT_SERVER_BASE_NAMES: [
    'Microsoft365Mail',
    'Microsoft365Calendar',
    'Microsoft365Files',
    'Microsoft365Teams',
    'Microsoft365SharePoint',
  ],
  buildMicrosoft365MailPayload: vi.fn(),
  buildMicrosoft365CalendarPayload: vi.fn(),
  buildMicrosoft365FilesPayload: vi.fn(),
  buildMicrosoft365TeamsPayload: vi.fn(),
  buildMicrosoft365SharePointPayload: vi.fn(),
}));

// Mock unused imports required by microsoftHandlers.ts
vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }));
vi.mock('../../services/microsoftAuthService', () => ({
  getMicrosoftAccounts: vi.fn(),
  getMicrosoftConfigDir: vi.fn(),
  startMicrosoftAuth: vi.fn(),
  removeMicrosoftAccount: vi.fn(),
  cancelMicrosoftAuth: vi.fn(),
  isMicrosoftConnected: vi.fn(),
  getExtraScopesForAccount: vi.fn(),
  MICROSOFT_SHAREPOINT_SCOPES: [],
}));
vi.mock('../../services/oauthCredentials', () => ({
  resolveMicrosoftClientId: vi.fn(),
  microsoftCredentialSource: {},
}));
vi.mock('../../services/mcpServerRemovalService', () => ({
  removeMcpServerWithCleanup: vi.fn(),
  performPostRemovalCleanup: vi.fn(),
}));
vi.mock('@shared/utils/mcpInstanceUtils', () => ({
  generateInstanceId: vi.fn(),
}));
vi.mock('../../services/mcpService', () => ({
  resolveMcpConfigPath: vi.fn(),
  reconfigureSuperMcpWithCacheRefreshResolvingOnDeferral: vi.fn(async () => ({ queued: false })),
}));
vi.mock('../../settingsStore', () => ({
  getSettings: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------

import { cleanupLegacyMicrosoftEntries } from '../microsoftHandlers';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('cleanupLegacyMicrosoftEntries', () => {
  const TEST_CONFIG_PATH = '/test/mcp-config.json';

  beforeEach(() => {
    vi.clearAllMocks();
    mockRemoveMcpServerEntry.mockResolvedValue({ backupPath: null });
  });

  it('removes static entries when instance entries exist for the same base name', async () => {
    mockGetMcpServerNames.mockResolvedValue([
      // Static (legacy) entries
      'Microsoft365Mail',
      'Microsoft365Calendar',
      // Instance entries for same account
      'Microsoft365Mail-hlatky-outlook-com',
      'Microsoft365Calendar-hlatky-outlook-com',
    ]);

    await cleanupLegacyMicrosoftEntries(TEST_CONFIG_PATH);

    // Should remove the static entries
    expect(mockRemoveMcpServerEntry).toHaveBeenCalledWith(TEST_CONFIG_PATH, 'Microsoft365Mail');
    expect(mockRemoveMcpServerEntry).toHaveBeenCalledWith(TEST_CONFIG_PATH, 'Microsoft365Calendar');
    expect(mockRemoveMcpServerEntry).toHaveBeenCalledTimes(2);
  });

  it('keeps static entries when no instance entries exist (backward compat)', async () => {
    mockGetMcpServerNames.mockResolvedValue([
      // Only static entries — user hasn't migrated yet
      'Microsoft365Mail',
      'Microsoft365Calendar',
      'Microsoft365Files',
      'Microsoft365Teams',
      'Microsoft365SharePoint',
    ]);

    await cleanupLegacyMicrosoftEntries(TEST_CONFIG_PATH);

    // Should NOT remove any — no instance entries exist to replace them
    expect(mockRemoveMcpServerEntry).not.toHaveBeenCalled();
  });

  it('is idempotent — safe to call when no static entries exist', async () => {
    mockGetMcpServerNames.mockResolvedValue([
      // Only instance entries, no static
      'Microsoft365Mail-hlatky-outlook-com',
      'Microsoft365Calendar-hlatky-outlook-com',
      'GoogleWorkspace-user-gmail-com',
    ]);

    await cleanupLegacyMicrosoftEntries(TEST_CONFIG_PATH);

    // No static entries to remove
    expect(mockRemoveMcpServerEntry).not.toHaveBeenCalled();
  });

  it('partial cleanup — removes only base names that have instances', async () => {
    mockGetMcpServerNames.mockResolvedValue([
      // Mail has both static and instance
      'Microsoft365Mail',
      'Microsoft365Mail-hlatky-outlook-com',
      // Calendar is static only (no instance)
      'Microsoft365Calendar',
      // Files has instance only (no static)
      'Microsoft365Files-hlatky-outlook-com',
    ]);

    await cleanupLegacyMicrosoftEntries(TEST_CONFIG_PATH);

    // Only Mail static should be removed (it has an instance replacement)
    expect(mockRemoveMcpServerEntry).toHaveBeenCalledWith(TEST_CONFIG_PATH, 'Microsoft365Mail');
    expect(mockRemoveMcpServerEntry).toHaveBeenCalledTimes(1);
    // Calendar static kept (no instance replacement)
    expect(mockRemoveMcpServerEntry).not.toHaveBeenCalledWith(TEST_CONFIG_PATH, 'Microsoft365Calendar');
  });

  it('handles empty server names list', async () => {
    mockGetMcpServerNames.mockResolvedValue([]);

    await cleanupLegacyMicrosoftEntries(TEST_CONFIG_PATH);

    expect(mockRemoveMcpServerEntry).not.toHaveBeenCalled();
  });

  it('does not throw on getMcpServerNames failure', async () => {
    mockGetMcpServerNames.mockRejectedValue(new Error('Config file not found'));

    // Should not throw
    await expect(cleanupLegacyMicrosoftEntries(TEST_CONFIG_PATH)).resolves.toBeUndefined();
    expect(mockRemoveMcpServerEntry).not.toHaveBeenCalled();
  });
});
