/**
 * Tests for fail-closed behavior when sensitivity guard requires staging
 * but CoS (Chief-of-Staff) space is unavailable (writeToPending returns null).
 *
 * Verifies that NO direct write occurs and an error result is returned.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock fs/promises — must be before imports that use it
const mockWriteFile = vi.fn();
const mockMkdir = vi.fn();
const mockReadFile = vi.fn();
const mockAccess = vi.fn();
const mockStat = vi.fn();
const mockReaddir = vi.fn();
const mockUnlink = vi.fn();
vi.mock('node:fs/promises', () => ({
  default: {
    writeFile: mockWriteFile,
    mkdir: mockMkdir,
    readFile: mockReadFile,
    access: mockAccess,
    stat: mockStat,
    readdir: mockReaddir,
    unlink: mockUnlink,
  },
  writeFile: mockWriteFile,
  mkdir: mockMkdir,
  readFile: mockReadFile,
  access: mockAccess,
  stat: mockStat,
  readdir: mockReaddir,
  unlink: mockUnlink,
}));

// Mock atomically
const mockAtomicWriteFile = vi.fn();
vi.mock('atomically', () => ({
  writeFile: mockAtomicWriteFile,
}));

// Mock front-matter
vi.mock('front-matter', () => ({
  default: Object.assign(
    (content: string) => ({
      attributes: {
        live: true,
        source_uid: 'bot-123',
      },
      body: content,
    }),
    { test: () => true }
  ),
}));

// Mock settings
vi.mock('@core/services/settingsStore', () => ({
  setSettingsStoreAdapter: vi.fn(),
  getSettings: () => ({
    coreDirectory: '/mock/workspace',
    claude: { apiKey: 'test-key' },
  }),
}));

// Mock auth
vi.mock('@core/rebelAuth', () => ({
  getRebelAuthProvider: () => ({
      onAuthStateChange: vi.fn(() => () => {}),
      getAccessToken: vi.fn(async () => null),
      invalidateAccessToken: vi.fn(),
      initializeAuth: vi.fn(async () => ({ isAuthenticated: false, user: null, isLoading: false })),
      setPostLoginCallback: vi.fn(),
      getCachedAuthConfig: vi.fn(() => null),
      requestAuthConfigRefresh: vi.fn(async () => {}),
      refreshLicenseTier: vi.fn(async () => 'free'),
      clearCachedProviderKey: vi.fn(),
      getSharedDriveConfig: vi.fn(() => null),
      getSubscriptionState: vi.fn(() => null),
      getManagedAllowanceResetsAt: vi.fn(() => undefined),
      getAuthState: () => ({ user: { name: 'Test User', email: 'test@example.com' } }),
  }),
  setRebelAuthProvider: vi.fn(),
  NULL_REBEL_AUTH_PROVIDER: {},
}));


// Mock spaceService — returns a shared space
vi.mock('../../spaceService', () => ({
  scanSpaces: vi.fn(() => Promise.resolve([{
    name: 'Chief of Staff',
    path: 'Chief-of-Staff',
    absolutePath: '/mock/workspace/Chief-of-Staff',
    type: 'chief-of-staff',
    sharing: 'private',
  }])),
  getSpaceDisplayName: vi.fn(() => 'Chief of Staff'),
}));

// Mock sensitivity guard — returns 'stage' decision
const mockEvaluateTranscriptForSharedSpace = vi.fn(() =>
  Promise.resolve({ decision: 'stage', summary: 'Sensitive meeting content' })
);
const mockBroadcastTranscriptStagingEvents = vi.fn();
vi.mock('../transcriptSensitivityGuard', () => ({
  evaluateTranscriptForSharedSpace: mockEvaluateTranscriptForSharedSpace,
  broadcastTranscriptStagingEvents: mockBroadcastTranscriptStagingEvents,
}));

// Mock cosPendingService — returns null (CoS unavailable)
const mockWriteToPending = vi.fn(() => Promise.resolve(null));
vi.mock('../../safety/cosPendingService', () => ({
  writeToPending: mockWriteToPending,
}));

// Mock BTS client (for cleanTranscriptText)
vi.mock('../../behindTheScenesClient', () => ({
  callBehindTheScenesWithAuth: vi.fn(),
}));

// Mock prompt service
vi.mock('@core/services/promptFileService', () => ({
  getPrompt: vi.fn(() => ''),
  PROMPT_IDS: { UTILITY_TRANSCRIPT_CLEANUP: 'cleanup' },
}));

import type { TranscriptData, ExternalTranscriptData } from '../transcriptStorage';

describe('transcriptStorage fail-closed behavior', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: file doesn't exist (no dedup collision)
    mockAccess.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    // Default: readdir returns empty (no existing transcripts)
    mockReaddir.mockResolvedValue([]);
    // Default: stat throws ENOENT (directory doesn't exist)
    mockStat.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    // Guard returns 'stage'
    mockEvaluateTranscriptForSharedSpace.mockResolvedValue({
      decision: 'stage',
      summary: 'Sensitive meeting content',
    });
    // writeToPending returns null (CoS unavailable)
    mockWriteToPending.mockResolvedValue(null);
  });

  describe('saveTranscript', () => {
    it('returns error when guard returns stage but writeToPending returns null', async () => {
      const { saveTranscript } = await import('../transcriptStorage');

      const data: TranscriptData = {
        botId: 'bot-123',
        meetingTitle: 'Sensitive 1:1',
        participants: ['Alice', 'Bob'],
        duration: 3600,
        startTime: '2026-04-15T10:00:00Z',
        rawTranscript: 'Confidential discussion about performance...',
      };

      const result = await saveTranscript(data);

      // Must fail — NOT succeed
      expect(result.success).toBe(false);
      expect(result.error).toContain('Staging required');
      expect(result.error).toContain('Chief-of-Staff');

      // Must NOT have written any file to shared space
      expect(mockWriteFile).not.toHaveBeenCalled();
      expect(mockMkdir).not.toHaveBeenCalled();
    });
  });

  describe('saveExternalTranscript', () => {
    it('returns error when guard returns stage but writeToPending returns null', async () => {
      const { saveExternalTranscript } = await import('../transcriptStorage');

      const data: ExternalTranscriptData = {
        externalId: 'ext-456',
        provider: 'fireflies',
        meetingTitle: 'HR Review',
        participants: ['Manager', 'Employee'],
        duration: 1800,
        startTime: '2026-04-15T14:00:00Z',
        rawTranscript: 'Performance improvement plan discussion...',
      };

      const result = await saveExternalTranscript(data);

      // Must fail — NOT succeed
      expect(result.success).toBe(false);
      expect(result.error).toContain('Staging required');
      expect(result.error).toContain('Chief-of-Staff');

      // Must NOT have written any file to shared space
      expect(mockWriteFile).not.toHaveBeenCalled();
      expect(mockMkdir).not.toHaveBeenCalled();
    });
  });

  describe('upgradeExistingLiveTranscript', () => {
    it('returns error when guard returns stage but writeToPending returns null', async () => {
      const { upgradeExistingLiveTranscript } = await import('../transcriptStorage');

      // Mock reading the existing live transcript file
      mockReadFile.mockResolvedValue(
        '---\nlive: true\nsource_uid: bot-123\n---\n\n# Live Meeting\n\nContent...'
      );

      const recallData: TranscriptData = {
        botId: 'bot-123',
        meetingTitle: 'Confidential 1:1',
        participants: ['Manager', 'Report'],
        duration: 2700,
        startTime: '2026-04-15T09:00:00Z',
        rawTranscript: 'Salary discussion and performance feedback...',
      };

      const result = await upgradeExistingLiveTranscript(
        '/mock/workspace/Chief-of-Staff/memory/sources/2026/04-Apr/15/live-meeting.md',
        recallData
      );

      // Must fail — NOT succeed
      expect(result.success).toBe(false);
      expect(result.error).toContain('Staging required');
      expect(result.error).toContain('Chief-of-Staff');

      // Must NOT have written upgraded content to original file
      expect(mockAtomicWriteFile).not.toHaveBeenCalled();
      expect(mockWriteFile).not.toHaveBeenCalled();
    });
  });

  describe('non-staged writes still work', () => {
    it('saveTranscript proceeds normally when guard returns allow', async () => {
      // Override guard to return 'allow'
      mockEvaluateTranscriptForSharedSpace.mockResolvedValue({ decision: 'allow', summary: '' });
      mockMkdir.mockResolvedValue(undefined);
      mockWriteFile.mockResolvedValue(undefined);

      const { saveTranscript } = await import('../transcriptStorage');

      const data: TranscriptData = {
        botId: 'bot-789',
        meetingTitle: 'Team Standup',
        participants: ['Alice', 'Bob', 'Charlie', 'Dave'],
        duration: 900,
        startTime: '2026-04-15T09:00:00Z',
        rawTranscript: 'Sprint planning discussion...',
      };

      const result = await saveTranscript(data);

      expect(result.success).toBe(true);
      // Should have written the file directly
      expect(mockWriteFile).toHaveBeenCalled();
    });
  });
});
