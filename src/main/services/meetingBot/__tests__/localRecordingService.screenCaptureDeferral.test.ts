/**
 * RC-5 deferral pin (consumer side): Screen Recording is requested on-demand at
 * the first ACTUAL local recording, NOT eagerly at SDK init.
 *
 * Pairs with desktopSdkService.screenCaptureDeferral.test.ts (which pins that
 * init does NOT request `screen-capture`). Here we pin requestScreenCapturePermission:
 *  - on darwin it asks the SDK for `screen-capture`;
 *  - on non-darwin it is a no-op (no prompt, no SDK call);
 *  - a missing SDK is a logged no-op, never a throw (best-effort — must not
 *    block the recording attempt);
 *  - an SDK that throws is swallowed (same reason).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  // Default: NOT granted, so the deferred SDK request is exercised.
  getMediaAccessStatus: vi.fn(() => 'not-determined' as string),
}));

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  systemPreferences: { getMediaAccessStatus: h.getMediaAccessStatus },
  dialog: {},
  shell: { openExternal: vi.fn(async () => {}) },
  app: { getPath: () => '/tmp' },
}));
vi.mock('@core/logger', () => ({
  createScopedLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('@core/services/settingsStore', () => ({ getSettings: () => ({ meetingBot: {} }), updateSettings: vi.fn() }));
vi.mock('@core/rebelAuth', () => ({
  getRebelAuthProvider: () => ({ getAuthState: () => ({ user: { id: 'user-1' } }) }),
  setRebelAuthProvider: vi.fn(),
  NULL_REBEL_AUTH_PROVIDER: {},
}));
vi.mock('../../gracefulShutdown', () => ({ isUpdateQuit: () => false }));
vi.mock('../recallTransport', () => ({ getRecallTransport: vi.fn() }));
vi.mock('../transcriptStorage', () => ({ saveTranscript: vi.fn(async () => ({ success: true, filePath: '/tmp/x' })) }));
vi.mock('../recorderInstallation', () => ({ isRecorderInstalled: () => true }));
vi.mock('../pendingLocalUploadsStore', () => ({
  addPendingLocalUpload: vi.fn(),
  getPendingLocalUploads: () => [],
  getPendingLocalUploadsNeedingPoll: () => [],
  updatePendingLocalUploadStatus: vi.fn(),
  removePendingLocalUpload: vi.fn(),
  cleanupExpiredUploads: vi.fn(),
}));
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

import { requestScreenCapturePermission } from '../localRecordingService';

const ORIGINAL_PLATFORM = process.platform;

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}

describe('requestScreenCapturePermission (on-demand screen-capture deferral)', () => {
  beforeEach(() => {
    setPlatform('darwin');
    h.getMediaAccessStatus.mockReturnValue('not-determined');
  });
  afterEach(() => {
    setPlatform(ORIGINAL_PLATFORM);
  });

  it('asks the SDK for screen-capture on darwin', async () => {
    const requestPermission = vi.fn(async () => {});
    await requestScreenCapturePermission({ requestPermission });
    expect(requestPermission).toHaveBeenCalledWith('screen-capture');
  });

  it('is idempotent — skips the SDK call when screen is already granted', async () => {
    h.getMediaAccessStatus.mockReturnValue('granted');
    const requestPermission = vi.fn(async () => {});
    await requestScreenCapturePermission({ requestPermission });
    expect(requestPermission).not.toHaveBeenCalled();
  });

  it('is a no-op on non-darwin platforms (no prompt)', async () => {
    setPlatform('win32');
    const requestPermission = vi.fn(async () => {});
    await requestScreenCapturePermission({ requestPermission });
    expect(requestPermission).not.toHaveBeenCalled();
  });

  it('is a logged no-op (not a throw) when the SDK is unavailable', async () => {
    await expect(requestScreenCapturePermission(null)).resolves.toBeUndefined();
  });

  it('swallows SDK errors so the recording attempt is never blocked', async () => {
    const requestPermission = vi.fn(async () => {
      throw new Error('TCC busy');
    });
    await expect(requestScreenCapturePermission({ requestPermission })).resolves.toBeUndefined();
  });
});
