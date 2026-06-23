import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PendingTranscript } from '@shared/ipc/channels/meetingBot';

// Mock dependencies before importing the module under test
vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
}));
vi.mock('@core/services/settingsStore', () => ({
  setSettingsStoreAdapter: vi.fn(),
  getSettings: () => ({}),
  settingsStore: { set: vi.fn() },
}));
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
      getAuthState: () => ({ user: { id: 'user_1' } }),
  }),
  setRebelAuthProvider: vi.fn(),
  NULL_REBEL_AUTH_PROVIDER: {},
}));


// Track cancel calls and removed bots
const cancelledBotIds: string[] = [];
const removedBotIds: string[] = [];
let mockTranscripts: PendingTranscript[] = [];

vi.mock('../pendingTranscriptsStore', () => ({
  getPendingTranscripts: () => mockTranscripts,
  removePendingTranscript: (botId: string) => {
    removedBotIds.push(botId);
    return true;
  },
  getPendingTranscript: vi.fn(),
  addPendingTranscript: vi.fn(),
  updatePendingTranscriptStatus: vi.fn(),
  cleanupExpiredTranscripts: vi.fn(),
  getTranscriptsNeedingCheck: () => [],
  getTranscriptsNeedingSave: () => [],
  getTranscriptsNeedingAnalysis: () => [],
  getTranscriptsNeedingAsyncUpgrade: () => [],
  getTimedOutAsyncUpgrades: () => [],
  markTranscriptSaved: vi.fn(),
  incrementSaveAttempts: vi.fn(),
  incrementConsecutiveErrors: vi.fn(),
  resetConsecutiveErrors: vi.fn(),
  updateLastRetryAt: vi.fn(),
  updateTranscriptQuality: vi.fn(),
  updateAsyncUpgradeStatus: vi.fn(),
  scheduleAnalysis: vi.fn(),
  setNextRetryTime: vi.fn(),
  markExhaustedTranscriptsAsFailed: () => 0,
  resetTransientFailedTranscripts: () => 0,
  updateRelayBotId: vi.fn(),
  updateRecordingStartTime: vi.fn(),
  updatePendingTranscriptCoachSelection: vi.fn(),
  updateLiveTranscriptPath: vi.fn(),
  markAnalysisTriggered: vi.fn(),
  markAnalysisCompleted: vi.fn(),
}));

vi.mock('@core/services/meetingBotBackendConfig', async () => {
  const actual = await vi.importActual<typeof import('@core/services/meetingBotBackendConfig')>(
    '@core/services/meetingBotBackendConfig',
  );
  return {
    ...actual,
    resolveMeetingBotBackendConfig: vi.fn(() => ({
      configured: true,
      url: 'https://test.backend',
      authKey: 'test-key',
    })),
  };
});

vi.mock('../desktopSdkService', () => ({
  getCurrentMeeting: () => null,
  broadcastCollaboratorStateIfPresent: () => false,
}));

vi.mock('../localRecordingService', () => ({
  isLocalRecordingCapturing: () => false,
}));

vi.mock('../relayClient', () => ({
  connectToRelay: vi.fn(),
  disconnectFromRelay: vi.fn(),
  getRelayClient: vi.fn(),
  disconnectAllRelays: vi.fn(),
}));

vi.mock('../botQAService', () => ({
  startBotQA: vi.fn(),
  startLocalTranscriptBuffer: vi.fn(),
  stopBotQA: vi.fn(),
  processTranscriptSegment: vi.fn(),
  setKnowledgeAccess: vi.fn(),
  stopAllBotQA: vi.fn(),
}));

vi.mock('../botVoiceService', () => ({
  goodbyeInMeeting: vi.fn(),
  announceJoin: vi.fn(),
  announceLeaveAndWait: vi.fn(),
}));

vi.mock('../../liveCoachService', () => ({
  resetBotCoachState: vi.fn(),
  setCoachStartTime: vi.fn(),
}));

vi.mock('../transcriptStorage', () => ({
  saveTranscript: vi.fn(),
  upgradeTranscriptQuality: vi.fn(),
  upgradeExistingLiveTranscript: vi.fn(),
  readLiveTranscriptFrontmatter: vi.fn(),
}));

vi.mock('../meetingAnalysisService', () => ({
  triggerMeetingAnalysis: vi.fn(),
}));

vi.mock('../transcriptEventBus', () => ({
  emitTranscriptSaved: vi.fn(),
  deferTranscriptSaved: vi.fn(),
  emitTranscriptDistributionReady: vi.fn(),
}));

// Mock global fetch for backendFetch
const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200, json: () => ({}) });
vi.stubGlobal('fetch', (...args: unknown[]) => {
  const url = args[0] as string;
  if (url.includes('/api/bot/cancel')) {
    const body = JSON.parse((args[1] as RequestInit).body as string);
    cancelledBotIds.push(body.botId);
  }
  return mockFetch(...args);
});

import { cleanupDuplicateBots } from '../meetingBotService';

function makeTranscript(overrides: Partial<PendingTranscript> & { botId: string; meetingUrl: string }): PendingTranscript {
  return {
    scheduledAt: '2026-03-09T14:00:00Z',
    createdAt: '2026-03-09T14:00:00Z',
    expiresAt: '2026-03-16T14:00:00Z',
    status: 'scheduled',
    ...overrides,
  } as PendingTranscript;
}

describe('cleanupDuplicateBots', () => {
  beforeEach(() => {
    cancelledBotIds.length = 0;
    removedBotIds.length = 0;
    mockTranscripts = [];
    mockFetch.mockResolvedValue({ ok: true, status: 200, json: () => ({}) });
  });

  it('returns 0 when there are no transcripts', async () => {
    expect(await cleanupDuplicateBots()).toBe(0);
  });

  it('returns 0 when there is only one active bot', async () => {
    mockTranscripts = [
      makeTranscript({ botId: 'bot1', meetingUrl: 'https://zoom.us/j/123' }),
    ];
    expect(await cleanupDuplicateBots()).toBe(0);
  });

  it('returns 0 when two bots are for different meetings', async () => {
    mockTranscripts = [
      makeTranscript({ botId: 'bot1', meetingUrl: 'https://zoom.us/j/111' }),
      makeTranscript({ botId: 'bot2', meetingUrl: 'https://zoom.us/j/222' }),
    ];
    expect(await cleanupDuplicateBots()).toBe(0);
    expect(removedBotIds).toEqual([]);
  });

  it('returns 0 when same URL but outside time window', async () => {
    mockTranscripts = [
      makeTranscript({ botId: 'bot1', meetingUrl: 'https://zoom.us/j/111', scheduledAt: '2026-03-09T08:00:00Z' }),
      makeTranscript({ botId: 'bot2', meetingUrl: 'https://zoom.us/j/111', scheduledAt: '2026-03-09T14:00:00Z' }),
    ];
    expect(await cleanupDuplicateBots()).toBe(0);
  });

  it('cancels the duplicate and keeps one when two bots match same meeting', async () => {
    mockTranscripts = [
      makeTranscript({ botId: 'bot1', meetingUrl: 'https://zoom.us/j/111', createdAt: '2026-03-09T14:00:00Z' }),
      makeTranscript({ botId: 'bot2', meetingUrl: 'https://zoom.us/j/111', createdAt: '2026-03-09T14:15:00Z' }),
    ];
    expect(await cleanupDuplicateBots()).toBe(1);
    // bot2 is newer → kept; bot1 cancelled
    expect(removedBotIds).toEqual(['bot1']);
    expect(cancelledBotIds).toEqual(['bot1']);
  });

  it('cancels all but one when 3+ bots match same meeting', async () => {
    mockTranscripts = [
      makeTranscript({ botId: 'bot1', meetingUrl: 'https://zoom.us/j/111', createdAt: '2026-03-09T14:00:00Z' }),
      makeTranscript({ botId: 'bot2', meetingUrl: 'https://zoom.us/j/111', createdAt: '2026-03-09T14:15:00Z' }),
      makeTranscript({ botId: 'bot3', meetingUrl: 'https://zoom.us/j/111', createdAt: '2026-03-09T14:30:00Z' }),
      makeTranscript({ botId: 'bot4', meetingUrl: 'https://zoom.us/j/111', createdAt: '2026-03-09T14:45:00Z' }),
    ];
    expect(await cleanupDuplicateBots()).toBe(3);
    // Sorted newest-first: bot4 kept, then bot3, bot2, bot1 cancelled in that order
    expect(removedBotIds).toEqual(['bot3', 'bot2', 'bot1']);
    expect(cancelledBotIds).toEqual(['bot3', 'bot2', 'bot1']);
  });

  it('prefers in_meeting bot over newer scheduled bot', async () => {
    mockTranscripts = [
      makeTranscript({ botId: 'old-recording', meetingUrl: 'https://zoom.us/j/111', status: 'in_meeting', createdAt: '2026-03-09T14:00:00Z' }),
      makeTranscript({ botId: 'new-scheduled', meetingUrl: 'https://zoom.us/j/111', status: 'scheduled', createdAt: '2026-03-09T14:30:00Z' }),
    ];
    expect(await cleanupDuplicateBots()).toBe(1);
    // in_meeting has higher priority → kept; newer scheduled is cancelled
    expect(removedBotIds).toEqual(['new-scheduled']);
  });

  it('prefers processing bot over newer scheduled bot', async () => {
    mockTranscripts = [
      makeTranscript({ botId: 'old-processing', meetingUrl: 'https://zoom.us/j/111', status: 'processing', createdAt: '2026-03-09T14:00:00Z' }),
      makeTranscript({ botId: 'new-scheduled', meetingUrl: 'https://zoom.us/j/111', status: 'scheduled', createdAt: '2026-03-09T14:30:00Z' }),
    ];
    expect(await cleanupDuplicateBots()).toBe(1);
    expect(removedBotIds).toEqual(['new-scheduled']);
  });

  it('skips bots with real activity (savedPath)', async () => {
    mockTranscripts = [
      makeTranscript({ botId: 'bot-active', meetingUrl: 'https://zoom.us/j/111', createdAt: '2026-03-09T14:30:00Z' }),
      makeTranscript({ botId: 'bot-saved', meetingUrl: 'https://zoom.us/j/111', createdAt: '2026-03-09T14:00:00Z', savedPath: '/path/to/transcript.md' }),
    ];
    expect(await cleanupDuplicateBots()).toBe(0);
    // bot-saved has real activity and should not be cancelled even though it's older
    expect(removedBotIds).toEqual([]);
  });

  it('skips bots with real activity (recordingStartTimeMs)', async () => {
    mockTranscripts = [
      makeTranscript({ botId: 'bot-new', meetingUrl: 'https://zoom.us/j/111', createdAt: '2026-03-09T14:30:00Z' }),
      makeTranscript({ botId: 'bot-recording', meetingUrl: 'https://zoom.us/j/111', createdAt: '2026-03-09T14:00:00Z', recordingStartTimeMs: 1741525200000 }),
    ];
    expect(await cleanupDuplicateBots()).toBe(0);
    expect(removedBotIds).toEqual([]);
  });

  it('still removes locally when backend cancel fails', async () => {
    mockFetch.mockRejectedValue(new Error('Network error'));
    mockTranscripts = [
      makeTranscript({ botId: 'bot1', meetingUrl: 'https://zoom.us/j/111', createdAt: '2026-03-09T14:00:00Z' }),
      makeTranscript({ botId: 'bot2', meetingUrl: 'https://zoom.us/j/111', createdAt: '2026-03-09T14:15:00Z' }),
    ];
    expect(await cleanupDuplicateBots()).toBe(1);
    expect(removedBotIds).toEqual(['bot1']);
  });

  it('treats backend 404 as success', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 404, json: () => ({}) });
    mockTranscripts = [
      makeTranscript({ botId: 'bot1', meetingUrl: 'https://zoom.us/j/111', createdAt: '2026-03-09T14:00:00Z' }),
      makeTranscript({ botId: 'bot2', meetingUrl: 'https://zoom.us/j/111', createdAt: '2026-03-09T14:15:00Z' }),
    ];
    expect(await cleanupDuplicateBots()).toBe(1);
    expect(removedBotIds).toEqual(['bot1']);
  });

  it('ignores non-active statuses (ready, failed)', async () => {
    mockTranscripts = [
      makeTranscript({ botId: 'bot-scheduled', meetingUrl: 'https://zoom.us/j/111', status: 'scheduled' }),
      makeTranscript({ botId: 'bot-ready', meetingUrl: 'https://zoom.us/j/111', status: 'ready' }),
      makeTranscript({ botId: 'bot-failed', meetingUrl: 'https://zoom.us/j/111', status: 'failed' }),
    ];
    // Only 1 active bot (scheduled), so no duplicates
    expect(await cleanupDuplicateBots()).toBe(0);
  });
});
