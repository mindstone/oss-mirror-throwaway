/**
 * Safe-resume tests for resumePendingLocalUploads (the silent-transcript-loss fix).
 *
 * A pending upload carries a persisted `transport` tag. Resume must route by that
 * tag, NOT by the current Recall-key state:
 *  (a) a 'direct' record with the key still present resumes against Recall (direct);
 *  (b) a 'direct' record with the key CLEARED surfaces a recoverable
 *      health-warning and is left UNTOUCHED — never falls back to the worker,
 *      never marked failed, never removed (so it resumes intact once the key
 *      returns);
 *  (c) a 'worker' record is unaffected and resumes via the worker.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PendingLocalUpload } from '../pendingLocalUploadsStore';

// ---- hoisted mock state -----------------------------------------------------
const h = vi.hoisted(() => ({
  settings: { meetingBot: {} as { recallApiKey?: string } },
  pending: [] as PendingLocalUpload[],
  getUploadStatus: vi.fn(),
  getUploadTranscript: vi.fn(),
  getRecallTransport: vi.fn(),
  isDirect: false,
  updateStatus: vi.fn(),
  remove: vi.fn(),
  cleanupExpired: vi.fn(),
  sentMessages: [] as Array<{ channel: string; payload: unknown }>,
}));

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: () => [
      {
        isDestroyed: () => false,
        webContents: {
          isDestroyed: () => false,
          send: (channel: string, payload: unknown) => h.sentMessages.push({ channel, payload }),
        },
      },
    ],
  },
  systemPreferences: {},
  dialog: {},
  shell: {},
  app: { getPath: () => '/tmp' },
}));

vi.mock('@core/logger', () => ({
  createScopedLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock('@core/services/settingsStore', () => ({
  getSettings: () => h.settings,
  updateSettings: vi.fn(),
}));

vi.mock('@core/rebelAuth', () => ({
  getRebelAuthProvider: () => ({
    getAuthState: () => ({ user: { id: 'user-1' } }),
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
  }),
  setRebelAuthProvider: vi.fn(),
  NULL_REBEL_AUTH_PROVIDER: {},
}));

vi.mock('../../gracefulShutdown', () => ({ isUpdateQuit: () => false }));

vi.mock('../recallTransport', () => ({
  getRecallTransport: h.getRecallTransport,
}));

vi.mock('../pendingLocalUploadsStore', () => ({
  getPendingLocalUploadsNeedingPoll: () => h.pending,
  addPendingLocalUpload: vi.fn(),
  updatePendingLocalUploadStatus: h.updateStatus,
  removePendingLocalUpload: h.remove,
  cleanupExpiredUploads: h.cleanupExpired,
}));

vi.mock('../transcriptStorage', () => ({ saveTranscript: vi.fn(async () => ({ success: true, filePath: '/tmp/x' })) }));
vi.mock('../../physicalRecording/physicalRecordingService', () => ({ isPhysicalRecordingActive: () => false }));
vi.mock('@main/ipc/quickCaptureState', () => ({ isQuickCaptureActive: () => false }));
vi.mock('../meetingBotRuntimeRegistry', () => ({
  registerIsLocalRecordingCapturingProvider: vi.fn(),
  registerLocalRecordingStatusProvider: vi.fn(),
  registerStopLocalRecordingHandler: vi.fn(),
  getActiveBotState: () => null,
  getCurrentMeeting: () => null,
}));
vi.mock('../botQAService', () => ({
  startLocalTranscriptBuffer: vi.fn(),
  stopBotQA: vi.fn(),
  processTranscriptSegment: vi.fn(),
}));
vi.mock('../conversationStateService', () => ({ startStateTracking: vi.fn(), stopStateTracking: vi.fn() }));
vi.mock('../../liveCoachService', () => ({ resetBotCoachState: vi.fn(), setCoachStartTime: vi.fn() }));

import { processAndSaveLocalRecording, resumePendingLocalUploads } from '../localRecordingService';

function makeUpload(over: Partial<PendingLocalUpload>): PendingLocalUpload {
  const now = new Date().toISOString();
  return {
    uploadId: 'up_1',
    clientSecret: 'secret',
    meetingTitle: 'Standup',
    createdAt: now,
    expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
    status: 'transcribing',
    pollAttempts: 0,
    transport: 'worker',
    ...over,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  h.settings = { meetingBot: {} };
  h.pending = [];
  h.sentMessages = [];
  h.getUploadStatus.mockReset();
  h.getUploadTranscript.mockReset();
  h.getRecallTransport.mockReset();
  h.getRecallTransport.mockImplementation(() => ({
    getUploadStatus: h.getUploadStatus,
    getUploadTranscript: h.getUploadTranscript,
    createUploadSession: vi.fn(),
  }));
  h.updateStatus.mockReset();
  h.remove.mockReset();
  h.cleanupExpired.mockReset();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('resumePendingLocalUploads — direct record, key present (a)', () => {
  it('polls Recall via the transport (does not surface the recoverable warning)', async () => {
    h.settings = { meetingBot: { recallApiKey: 'rk_live_abc' } };
    h.pending = [makeUpload({ transport: 'direct', recallUploadId: 'rec_up_1' })];
    // Still processing → starts background polling; assert the status call happened.
    h.getUploadStatus.mockResolvedValue({ ok: true, status: 200, data: { success: true, status: 'in_progress', transcriptReady: false } });

    await resumePendingLocalUploads();

    expect(h.getUploadStatus).toHaveBeenCalled();
    expect(h.getUploadStatus).toHaveBeenCalledWith(
      expect.objectContaining({ uploadId: 'up_1', recallUploadId: 'rec_up_1' }),
    );
    const keyWarnings = h.sentMessages.filter(
      m => m.channel === 'meeting-bot:health-warning',
    );
    expect(keyWarnings).toHaveLength(0);
  });
});

describe('resumePendingLocalUploads — direct record, key cleared (b)', () => {
  it('surfaces a recoverable health-warning and never touches the record or worker', async () => {
    h.settings = { meetingBot: { recallApiKey: '' } }; // key cleared
    h.pending = [makeUpload({ transport: 'direct', recallUploadId: 'rec_up_1' })];

    await resumePendingLocalUploads();

    // No transport call at all — no worker fallback, no direct call.
    expect(h.getUploadStatus).not.toHaveBeenCalled();
    expect(h.getUploadTranscript).not.toHaveBeenCalled();
    // Record left intact: not marked failed, not removed.
    expect(h.updateStatus).not.toHaveBeenCalled();
    expect(h.remove).not.toHaveBeenCalled();
    // Recoverable warning surfaced on the health-warning channel.
    const warnings = h.sentMessages.filter(m => m.channel === 'meeting-bot:health-warning');
    expect(warnings).toHaveLength(1);
    const payload = warnings[0].payload as { warning: string; type: string };
    expect(payload.type).toBe('sdk_init_failed');
    expect(payload.warning).toMatch(/Recall API key/i);
  });
});

describe('direct upload, key cleared mid-session retry', () => {
  it('treats transcript processing as recoverable and never resolves a worker transport', async () => {
    h.settings = { meetingBot: { recallApiKey: '' } };

    const result = await processAndSaveLocalRecording({
      uploadId: 'up_1',
      clientSecret: 'secret',
      recallUploadId: 'rec_up_1',
      transport: 'direct',
      meetingTitle: 'Standup',
    });

    expect(result).toEqual(expect.objectContaining({
      success: false,
      recoverable: true,
      error: 'Recall API key required',
    }));
    expect(h.getRecallTransport).not.toHaveBeenCalled();
    expect(h.getUploadTranscript).not.toHaveBeenCalled();
    const warnings = h.sentMessages.filter(m => m.channel === 'meeting-bot:health-warning');
    expect(warnings).toHaveLength(1);
  });

  it('treats direct 404 after a key change as recoverable, not terminal', async () => {
    h.settings = { meetingBot: { recallApiKey: 'rk_live_different_account' } };
    h.getUploadTranscript.mockResolvedValue({ ok: false, status: 404, errorText: 'not found' });

    const result = await processAndSaveLocalRecording({
      uploadId: 'up_1',
      clientSecret: 'secret',
      recallUploadId: 'rec_up_1',
      transport: 'direct',
      meetingTitle: 'Standup',
    });

    expect(result).toEqual(expect.objectContaining({
      success: false,
      recoverable: true,
      error: 'Recall API key required',
    }));
    expect(h.getRecallTransport).toHaveBeenCalledTimes(1);
    expect(h.getUploadTranscript).toHaveBeenCalledWith(
      expect.objectContaining({ uploadId: 'up_1', recallUploadId: 'rec_up_1' }),
    );
    const warnings = h.sentMessages.filter(m => m.channel === 'meeting-bot:health-warning');
    expect(warnings).toHaveLength(1);
  });

  it('leaves a direct ready upload pending if the key is cleared before transcript fetch', async () => {
    h.settings = { meetingBot: { recallApiKey: 'rk_live_abc' } };
    h.pending = [makeUpload({ transport: 'direct', recallUploadId: 'rec_up_1' })];
    h.getUploadStatus.mockImplementation(async () => {
      h.settings = { meetingBot: { recallApiKey: '' } };
      return {
        ok: true,
        status: 200,
        data: { success: true, status: 'complete', transcriptReady: true },
      };
    });

    await resumePendingLocalUploads();

    expect(h.getUploadStatus).toHaveBeenCalledTimes(1);
    expect(h.getRecallTransport).toHaveBeenCalledTimes(1);
    expect(h.getUploadTranscript).not.toHaveBeenCalled();
    expect(h.updateStatus).not.toHaveBeenCalledWith('up_1', 'failed', expect.anything());
    expect(h.remove).not.toHaveBeenCalled();
    const warnings = h.sentMessages.filter(m => m.channel === 'meeting-bot:health-warning');
    expect(warnings).toHaveLength(1);
    expect(vi.getTimerCount()).toBeGreaterThan(0);
  });
});

describe('resumePendingLocalUploads — worker record (c)', () => {
  it('resumes via the worker transport regardless of key state', async () => {
    h.settings = { meetingBot: {} };
    h.pending = [makeUpload({ transport: 'worker' })];
    h.getUploadStatus.mockResolvedValue({ ok: true, status: 200, data: { success: true, status: 'in_progress', transcriptReady: false } });

    await resumePendingLocalUploads();

    expect(h.getUploadStatus).toHaveBeenCalled();
    const warnings = h.sentMessages.filter(m => m.channel === 'meeting-bot:health-warning');
    expect(warnings).toHaveLength(0);
  });
});
