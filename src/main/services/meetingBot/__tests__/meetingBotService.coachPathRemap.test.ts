import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('meetingBotService coach path remap', () => {
  let tempDir: string | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.restoreAllMocks();
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  it('remaps persisted legacy coaching paths to OPERATOR.md before resolver hydration', async () => {
    vi.resetModules();

    tempDir = await mkdtemp(path.join(os.tmpdir(), 'meeting-bot-remap-'));
    const oldPath = path.join(tempDir, 'rebel-system', 'skills', 'coaching', 'sales-coach', 'SKILL.md');
    const newPath = path.join(tempDir, 'rebel-system', 'operators', 'sales-coach', 'OPERATOR.md');
    await mkdir(path.dirname(newPath), { recursive: true });
    await writeFile(newPath, '# Sales Coach\n\nLive prompt body.', 'utf8');

    const loggerInfo = vi.fn();
    const resolveMeetingCoachPrompt = vi.fn(() => ({
      prompt: 'Resolved live prompt',
      contentHash: 'sha256:coach',
      source: 'operator-frontmatter' as const,
      proactiveIntervalMinutes: 2,
    }));

    const pendingTranscript = {
      botId: 'bot-1',
      meetingUrl: 'https://example.com/meeting',
      meetingTitle: 'Weekly sync',
      scheduledAt: new Date().toISOString(),
      status: 'in_meeting' as const,
      companionSessionId: 'session-1',
      coachSkillPath: oldPath,
      presenceMode: 'coach' as const,
    };

    vi.doMock('electron', () => ({
      BrowserWindow: {
        getAllWindows: vi.fn(() => []),
      },
    }));

    vi.doMock('@core/logger', () => ({
      createScopedLogger: () => ({
        debug: vi.fn(),
        info: loggerInfo,
        warn: vi.fn(),
        error: vi.fn(),
      }),
    }));

    vi.doMock('@core/meetingSource/saveMeetingSource', () => ({
      notifyDistributionReady: vi.fn(),
    }));

    vi.doMock('@core/services/operatorRegistry', () => ({
      listAvailable: vi.fn(async () => []),
      listAvailableWithDiagnostics: vi.fn(async () => ({ operators: [], failures: [] })),
      getById: vi.fn(() => undefined),
      invalidateOperatorRegistry: vi.fn(),
    }));

    vi.doMock('@core/services/settingsStore', () => ({
      getSettings: vi.fn(() => ({ meetingBot: {} })),
      updateSettings: vi.fn(),
      setSettingsStoreAdapter: vi.fn(),
    }));

    vi.doMock('../pendingTranscriptsStore', () => ({
      getPendingTranscripts: vi.fn(() => [pendingTranscript]),
      getPendingTranscript: vi.fn((botId: string) => (botId === pendingTranscript.botId ? pendingTranscript : null)),
      addPendingTranscript: vi.fn(),
      updatePendingTranscriptStatus: vi.fn(),
      removePendingTranscript: vi.fn(() => true),
      cleanupExpiredTranscripts: vi.fn(),
      getTranscriptsNeedingCheck: vi.fn(() => []),
      getTranscriptsNeedingSave: vi.fn(() => []),
      getTranscriptsNeedingAnalysis: vi.fn(() => []),
      getTranscriptsNeedingAsyncUpgrade: vi.fn(() => []),
      getTimedOutAsyncUpgrades: vi.fn(() => []),
      markTranscriptSaved: vi.fn(),
      markTranscriptStaged: vi.fn(),
      incrementSaveAttempts: vi.fn(() => 0),
      incrementConsecutiveErrors: vi.fn(() => 0),
      resetConsecutiveErrors: vi.fn(),
      updateLastRetryAt: vi.fn(),
      updateTranscriptQuality: vi.fn(),
      updateAsyncUpgradeStatus: vi.fn(),
      scheduleAnalysis: vi.fn(),
      setNextRetryTime: vi.fn(),
      markExhaustedTranscriptsAsFailed: vi.fn(),
      resetTransientFailedTranscripts: vi.fn(),
      updateRelayBotId: vi.fn(),
      updateRecordingStartTime: vi.fn(),
      updatePendingTranscriptCoachSelection: vi.fn(),
      updatePendingTranscriptPresenceMode: vi.fn(),
      updatePendingTranscriptConversationState: vi.fn(),
    }));

    vi.doMock('../transcriptStorage', () => ({
      saveTranscript: vi.fn(async () => ({ success: true })),
      cleanTranscriptText: vi.fn((text: string) => text),
      upgradeTranscriptQuality: vi.fn(async () => ({ success: true })),
      upgradeExistingLiveTranscript: vi.fn(async () => ({ success: true })),
      readLiveTranscriptFrontmatter: vi.fn(async () => ({ success: false })),
      parseLiveTranscriptSegments: vi.fn(async () => ({ success: true, segments: [] })),
    }));

    vi.doMock('../meetingAnalysisService', () => ({
      triggerMeetingAnalysis: vi.fn(async () => ({ success: true })),
    }));

    vi.doMock('../transcriptEventBus', () => ({
      emitTranscriptDistributionReady: vi.fn(),
    }));

    vi.doMock('@core/services/meetingBotBackendConfig', async () => {
      const actual = await vi.importActual<typeof import('@core/services/meetingBotBackendConfig')>(
        '@core/services/meetingBotBackendConfig',
      );
      return {
        ...actual,
        resolveMeetingBotBackendConfig: vi.fn(() => ({
          configured: true,
          url: 'https://backend.example',
          authKey: 'test-key',
        })),
      };
    });

    vi.doMock('../backendAuth', () => ({
      generateBackendAuthHeader: vi.fn(() => 'auth-header'),
    }));

    vi.doMock('../desktopSdkService', () => ({
      broadcastCollaboratorStateIfPresent: vi.fn(() => false),
      setCollaboratorInfo: vi.fn(),
      broadcastCollaboratorFromPendingTranscript: vi.fn(),
    }));

    vi.doMock('../meetingBotRuntimeRegistry', () => ({
      registerActiveBotStateProvider: vi.fn(),
      getCurrentMeeting: vi.fn(() => null),
      isLocalRecordingCapturing: vi.fn(() => false),
    }));

    vi.doMock('../relayClient', () => ({
      connectToRelay: vi.fn(),
      disconnectFromRelay: vi.fn(),
      getRelayClient: vi.fn(() => null),
    }));

    vi.doMock('../botQAService', () => ({
      startBotQA: vi.fn(),
      stopBotQA: vi.fn(),
      processTranscriptSegment: vi.fn(),
      clearProactivePending: vi.fn(),
      rehydrateTranscriptBuffer: vi.fn(),
      startLocalTranscriptBuffer: vi.fn(),
      fetchChatMessagesFromBackend: vi.fn(async () => []),
    }));

    vi.doMock('../botVoiceService', () => ({
      announceJoin: vi.fn(async () => undefined),
      announceLeaveAndWait: vi.fn(async () => undefined),
    }));

    vi.doMock('../../liveCoachService', () => ({
      resetBotCoachState: vi.fn(),
      setCoachStartTime: vi.fn(),
    }));

    vi.doMock('../../meetingCoachPromptResolver', () => ({
      resolveMeetingCoachPrompt,
    }));

    vi.doMock('../conversationStateService', () => ({
      startStateTracking: vi.fn(),
      stopStateTracking: vi.fn(() => null),
    }));

    vi.doMock('../../authService', () => ({
      getAuthState: vi.fn(() => ({
        user: { id: 'user-1', name: 'Alice Example' },
      })),
    }));

    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ success: true, status: 'in_call_recording' }),
      text: async () => '',
    })));

    const meetingBotServiceModule = await import('../meetingBotService');
    const service = meetingBotServiceModule.createMeetingBotService();

    const activated = service.activatePreScheduledBot('bot-1');
    expect(activated).toBe(true);

    expect(resolveMeetingCoachPrompt).toHaveBeenCalledWith(newPath, expect.anything());
    expect(meetingBotServiceModule.getActiveBotState()?.coachSkillPath).toBe(newPath);
    expect(loggerInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        oldPath,
        newPath,
      }),
      'operators:coach_path_remapped',
    );

    service.dismissStatus();
  });
});
