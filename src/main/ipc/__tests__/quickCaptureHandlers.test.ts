/**
 * Unit tests for Quick Capture handler pipeline.
 *
 * Mocks the Whisper HTTP call (axios.post) at the network boundary so the
 * full internal pipeline is exercised without hitting a real API:
 *   IPC start → IPC stop → transcription service → storage → event bus → status broadcasts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { initTestPlatformConfig } from '@core/__tests__/testHelpers';
import type { AppSettings } from '@shared/types';

// ---------------------------------------------------------------------------
// Mock axios at the HTTP boundary (hoisted so vi.resetModules doesn't lose it)
// ---------------------------------------------------------------------------
const mockAxiosPost = vi.hoisted(() => vi.fn());

vi.mock('axios', () => ({
  default: { post: mockAxiosPost },
}));

const DUMMY_AUDIO = Buffer.alloc(100);

// ---------------------------------------------------------------------------
// Mock only Electron runtime APIs (not available in Vitest)
// ---------------------------------------------------------------------------
const mockSend = vi.fn();
const mockGetAllWindows = vi.fn(() => [
  { isDestroyed: () => false, webContents: { send: mockSend } },
]);

// Capture registered IPC handlers
const handlers = new Map<string, (...args: unknown[]) => unknown>();

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => mockGetAllWindows() },
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler);
    },
  },
  app: { on: vi.fn(), quit: vi.fn() },
  dialog: { showMessageBox: vi.fn() },
}));

// ---------------------------------------------------------------------------
// Mock the storage layer (needs workspace + spaces which aren't set up in test).
// After the meeting-source kernel refactor (77738034f), transcript-saved
// events are emitted by the kernel via deps.emitTranscriptSaved — not by
// savePhysicalRecording's caller. So this mock must emit the event itself to
// preserve the original test contract ("stop captures audio AND emits saved
// event"). The real transcriptEventBus is not mocked, so onTranscriptSaved
// listeners in the test will receive the emission.
vi.mock('@main/services/physicalRecording/storageService', () => ({
  savePhysicalRecording: vi.fn(async (
    transcript: string,
    metadata: { id: string; title?: string; startTime?: string; duration?: number },
    _audioBuffer: Buffer | undefined,
    options: { sourceSystem?: string } = {}
  ) => {
    const source = options.sourceSystem ?? 'limitless';
    const filePath = `/tmp/test-space/memory/sources/${source}_${metadata.id}.md`;
    const { emitTranscriptSaved } = await import('@main/services/meetingBot/transcriptEventBus');
    emitTranscriptSaved({
      sourceSystem: source as 'quick_capture' | 'limitless' | 'plaud',
      sourceUid: `${source}_${metadata.id}`,
      filePath,
      meetingTitle: metadata.title ?? `Test ${source}`,
      startTime: metadata.startTime ?? new Date().toISOString(),
      participants: [],
      duration: metadata.duration ?? 0,
      alreadyExists: false,
      timestamp: Date.now(),
    });
    return { filePath, staged: false };
  }),
}));

// ---------------------------------------------------------------------------
// Quiet loggers
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Mock mutual exclusion deps (these are simple boolean flags)
// ---------------------------------------------------------------------------
const mockIsPhysicalActive = vi.fn(() => false);
const mockIsLocalCapturing = vi.fn(() => false);

vi.mock('@main/services/physicalRecording/physicalRecordingService', () => ({
  isPhysicalRecordingActive: () => mockIsPhysicalActive(),
}));
vi.mock('@main/services/meetingBot/localRecordingService', () => ({
  isLocalRecordingCapturing: () => mockIsLocalCapturing(),
}));
vi.mock('@main/services/gracefulShutdown', () => ({
  isUpdateQuit: () => false,
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function getHandler(channel: string) {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`Handler not registered: ${channel}`);
  return handler;
}

function getStatusBroadcasts(): Array<{ state: string; source: string; quip: string }> {
  return mockSend.mock.calls
    .filter(([channel]: unknown[]) => channel === 'meeting-bot:status')
    .map((args: any[]) => args[1] as { state: string; source: string; quip: string });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('quickCaptureHandlers', () => {
  beforeEach(async () => {
    // Reset module registry so each test gets fresh module-level state
    vi.resetModules();
    handlers.clear();
    mockSend.mockClear();
    mockIsPhysicalActive.mockReturnValue(false);
    mockIsLocalCapturing.mockReturnValue(false);

    // Default: Whisper API succeeds with a mock transcript
    mockAxiosPost.mockReset();
    mockAxiosPost.mockResolvedValue({ data: { text: 'Mock quick capture transcript' } });

    await initTestPlatformConfig();

    const { setSettingsStoreAdapter: setAdapter } = await import(
      '@core/services/settingsStore'
    );
    setAdapter({
      getSettings: () => ({
        providerKeys: { openai: 'test-openai-key' },
        voice: { voiceInputLanguage: 'auto', transcriptionVocabulary: [] },
      }) as unknown as AppSettings,
      updateSettings: () => {},
      updateSettingsAtomic: () => {},
    });

    const mod = await import('../quickCaptureHandlers');
    mod.registerQuickCaptureHandlers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // =========================================================================
  // Start / mutual exclusion (fast, no API calls)
  // =========================================================================
  describe('quick-capture:start', () => {
    it('should start capture and broadcast recording_quick_capture', async () => {
      const result = await getHandler('quick-capture:start')(null);
      expect(result).toEqual({ success: true });

      const broadcasts = getStatusBroadcasts();
      expect(broadcasts.length).toBeGreaterThanOrEqual(1);
      expect(broadcasts[0].state).toBe('recording_quick_capture');
      expect(broadcasts[0].source).toBe('quick_capture');
    });

    it('should reject when physical recording is active', async () => {
      mockIsPhysicalActive.mockReturnValue(true);
      const result = await getHandler('quick-capture:start')(null);
      expect(result).toEqual(expect.objectContaining({
        success: false,
        error: expect.stringContaining('Physical recording'),
      }));
    });

    it('should reject when local recording is active', async () => {
      mockIsLocalCapturing.mockReturnValue(true);
      const result = await getHandler('quick-capture:start')(null);
      expect(result).toEqual(expect.objectContaining({
        success: false,
        error: expect.stringContaining('Local recording'),
      }));
    });

    it('should reject double-start', async () => {
      await getHandler('quick-capture:start')(null);
      const result = await getHandler('quick-capture:start')(null);
      expect(result).toEqual(expect.objectContaining({ success: false }));
    });
  });

  // =========================================================================
  // Full pipeline: start → stop → Whisper → event bus → done
  // =========================================================================
  describe('quick-capture:stop (full pipeline)', () => {
    it('should transcribe audio and emit transcript event', async () => {
      // Listen for the event bus emission (the "routing to transcript analysis" path)
      const { onTranscriptSaved } = await import(
        '@main/services/meetingBot/transcriptEventBus'
      );
      const savedEvents: Array<{ sourceSystem: string; sourceUid: string; filePath: string; alreadyExists: boolean; meetingTitle?: string }> = [];
      const unsubscribe = onTranscriptSaved((event) => savedEvents.push(event));

      try {
        // Start capture
        await getHandler('quick-capture:start')(null);
        mockSend.mockClear();

        // Stop with a real WAV audio buffer
        const audio = DUMMY_AUDIO;
        const result = await getHandler('quick-capture:stop')(null, {
          audio,
          mimeType: 'audio/wav',
        });

        // -- Handler result --
        expect(result).toEqual(expect.objectContaining({
          success: true,
          transcriptPath: expect.stringContaining('quick_capture'),
        }));

        // -- Status broadcasts: transcribing → done --
        const broadcasts = getStatusBroadcasts();
        const states = broadcasts.map(b => b.state);
        expect(states).toContain('transcribing_quick_capture');
        expect(states).toContain('done_quick_capture');
        expect(states.indexOf('transcribing_quick_capture'))
          .toBeLessThan(states.indexOf('done_quick_capture'));

        // -- Event bus: transcript saved with quick_capture source --
        expect(savedEvents.length).toBe(1);
        const event = savedEvents[0];
        expect(event.sourceSystem).toBe('quick_capture');
        expect(event.sourceUid).toMatch(/^quick_capture_/);
        expect(event.filePath).toContain('quick_capture');
        expect(event.alreadyExists).toBe(false);
        expect(event.meetingTitle).toBeTruthy();
      } finally {
        unsubscribe();
      }
    });

    it('should broadcast done_quick_capture (not stuck transcribing) on API error', async () => {
      mockAxiosPost.mockRejectedValueOnce(new Error('Request failed with status code 401'));

      await getHandler('quick-capture:start')(null);
      mockSend.mockClear();

      const audio = DUMMY_AUDIO;
      const result = await getHandler('quick-capture:stop')(null, {
        audio,
        mimeType: 'audio/wav',
      });

      expect(result).toEqual(expect.objectContaining({ success: false }));

      const broadcasts = getStatusBroadcasts();
      const lastState = broadcasts[broadcasts.length - 1].state;
      expect(lastState).toBe('done_quick_capture');
      expect(lastState).not.toBe('transcribing_quick_capture');
    });

    it('should pass source identity options through to transcription', async () => {
      const { savePhysicalRecording } = await import(
        '@main/services/physicalRecording/storageService'
      );

      await getHandler('quick-capture:start')(null);

      const audio = DUMMY_AUDIO;
      await getHandler('quick-capture:stop')(null, {
        audio,
        mimeType: 'audio/webm;codecs=opus',
      });

      // Verify storage was called with quick_capture source identity
      expect(savePhysicalRecording).toHaveBeenCalledWith(
        expect.any(String), // transcript text
        expect.objectContaining({ deviceName: 'Built-in Microphone' }),
        expect.any(Buffer), // audio buffer
        expect.objectContaining({
          sourceSystem: 'quick_capture',
          filenameInfix: 'quick_capture',
          audioMimeType: 'audio/webm;codecs=opus',
        }),
      );
    });

    it('should allow a new capture after stop completes', async () => {
      await getHandler('quick-capture:start')(null);
      const audio = DUMMY_AUDIO;
      await getHandler('quick-capture:stop')(null, { audio, mimeType: 'audio/wav' });

      const result = await getHandler('quick-capture:start')(null);
      expect(result).toEqual({ success: true });
    });
  });
});
