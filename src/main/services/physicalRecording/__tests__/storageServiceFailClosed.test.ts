/**
 * Tests for fail-closed behavior in physical recording storageService.
 *
 * When the sensitivity guard requires staging but CoS is unavailable
 * (writeToPending returns null), the write MUST NOT proceed to shared space.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock fs/promises — use inline vi.fn() since vi.mock is hoisted.
// readdir is needed because the meeting-source kernel's dedup-lookup chain
// (findTranscriptByStableId in transcriptStorage) walks year/month/day folders.
vi.mock('node:fs/promises', () => ({
  default: {
    writeFile: vi.fn(),
    mkdir: vi.fn(),
    access: vi.fn(),
    stat: vi.fn(),
    readdir: vi.fn(),
  },
  writeFile: vi.fn(),
  mkdir: vi.fn(),
  access: vi.fn(),
  stat: vi.fn(),
  readdir: vi.fn(),
}));

// Mock transcriptStorage to bypass fs-heavy dedup lookup (the kernel needs
// `findTranscriptByStableId` returning null and `getUniqueFilePath` as a
// pass-through; we are testing fail-closed behavior, not dedup).
vi.mock('@main/services/meetingBot/transcriptStorage', () => ({
  findTranscriptByStableId: vi.fn(() => Promise.resolve(null)),
  getUniqueFilePath: vi.fn(async (filePath: string) => filePath),
  generateFilename: vi.fn((date: Date, title: string) => ({
    subfolder: '2026/04-Apr/15',
    filename: `260415_1400_meeting_limitless_${title.toLowerCase().replace(/\s+/g, '-')}.md`,
  })),
}));

// Mock calendar enrichment (kernel calls it; we just want pass-through "no match").
vi.mock('@main/services/calendar/calendarEnrichment', () => ({
  enrichMeetingFromCalendarCache: vi.fn(() => Promise.resolve({ matched: false })),
}));

// Mock transcriptEventBus so kernel-owned event emission is observable but inert.
vi.mock('@main/services/meetingBot/transcriptEventBus', () => ({
  emitTranscriptSaved: vi.fn(),
  deferTranscriptSaved: vi.fn(),
  emitTranscriptDistributionReady: vi.fn(),
}));

// Mock settings
vi.mock('@core/services/settingsStore', () => ({
  setSettingsStoreAdapter: vi.fn(),
  getSettings: () => ({
    coreDirectory: '/mock/workspace',
    claude: { apiKey: 'test-key' },
    meetingBot: { physicalMeetingSpaceId: null },
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
      getAuthState: () => ({ user: { email: 'test@example.com' } }),
  }),
  setRebelAuthProvider: vi.fn(),
  NULL_REBEL_AUTH_PROVIDER: {},
}));


// Mock spaceService
vi.mock('@main/services/spaceService', () => ({
  scanSpaces: vi.fn(() => Promise.resolve([{
    name: 'Chief of Staff',
    path: 'Chief-of-Staff',
    absolutePath: '/mock/workspace/Chief-of-Staff',
    type: 'chief-of-staff',
    sharing: 'private',
  }])),
  getSpaceDisplayName: vi.fn(() => 'Chief of Staff'),
}));

// Mock sensitivity guard
vi.mock('@main/services/meetingBot/transcriptSensitivityGuard', () => ({
  evaluateTranscriptForSharedSpace: vi.fn(() => Promise.resolve({ decision: 'allow' })),
  broadcastTranscriptStagingEvents: vi.fn(),
}));

// Mock cosPendingService
vi.mock('@main/services/safety/cosPendingService', () => ({
  writeToPending: vi.fn(() => Promise.resolve(null)),
}));

// Import after mocks are set up
import fs from 'node:fs/promises';
import { savePhysicalRecording } from '../storageService';
import { evaluateTranscriptForSharedSpace, broadcastTranscriptStagingEvents } from '@main/services/meetingBot/transcriptSensitivityGuard';
import { writeToPending } from '@main/services/safety/cosPendingService';
import type { PhysicalRecordingMetadata } from '../types';

const mockedFs = vi.mocked(fs);
const mockedGuard = vi.mocked(evaluateTranscriptForSharedSpace);
const mockedWriteToPending = vi.mocked(writeToPending);
const mockedBroadcast = vi.mocked(broadcastTranscriptStagingEvents);

const TEST_METADATA: PhysicalRecordingMetadata = {
  id: 'rec-001',
  title: '1:1 with Manager',
  startTime: '2026-04-15T14:00:00Z',
  duration: 1800,
  deviceName: 'Limitless Pendant',
  reviewStatus: 'pending',
};

describe('storageService fail-closed behavior', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: file doesn't exist (no collision)
    mockedFs.access.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    mockedFs.mkdir.mockResolvedValue(undefined);
    mockedFs.writeFile.mockResolvedValue(undefined);
  });

  it('throws error when guard returns stage but writeToPending returns null', async () => {
    mockedGuard.mockResolvedValue({
      decision: 'stage',
      summary: 'Sensitive 1:1 meeting',
    });
    mockedWriteToPending.mockResolvedValue(null);

    await expect(
      savePhysicalRecording('Confidential feedback discussion...', TEST_METADATA)
    ).rejects.toThrow('Staging required but Chief-of-Staff space is unavailable');

    // Must NOT have written any file to shared space
    expect(mockedFs.writeFile).not.toHaveBeenCalled();
    expect(mockedFs.mkdir).not.toHaveBeenCalled();
  });

  it('saves normally when guard returns allow', async () => {
    mockedGuard.mockResolvedValue({ decision: 'allow' });

    const result = await savePhysicalRecording(
      'Team standup discussion...',
      { ...TEST_METADATA, id: 'rec-002', title: 'Team Standup' }
    );

    expect(result.filePath).toBeTruthy();
    expect(result.staged).toBeUndefined();
    // Should have written the file directly
    expect(mockedFs.writeFile).toHaveBeenCalled();
  });

  it('returns staged result when guard returns stage and writeToPending succeeds', async () => {
    mockedGuard.mockResolvedValue({
      decision: 'stage',
      summary: 'Sensitive content detected',
    });
    mockedWriteToPending.mockResolvedValue({
      id: 'pending-001',
      filePath: '/mock/pending/file.md',
    } as never); // type cast since we don't need full PendingFile

    const result = await savePhysicalRecording(
      'Sensitive discussion...',
      { ...TEST_METADATA, id: 'rec-003' }
    );

    expect(result.staged).toBe(true);
    expect(result.destinationPath).toBeTruthy();
    // Should NOT have written to shared space (it was staged)
    expect(mockedFs.writeFile).not.toHaveBeenCalled();
    expect(mockedBroadcast).toHaveBeenCalled();
  });
});
