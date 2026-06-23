/**
 * Voice Mock Infrastructure for E2E Tests
 *
 * This module provides mock infrastructure for voice IPC channels,
 * enabling fast, deterministic E2E tests without live TTS/STT calls.
 *
 * Mocked IPC channels:
 * - `voice:transcribe` - STT, returns transcribed text
 * - `voice:text-to-speech` - TTS, returns audio buffer
 * - `voice:text-to-speech-with-timestamps` - TTS with ElevenLabs alignment data
 *
 * Subscription channels:
 * - `voice:tts-chunk` - Streaming TTS audio chunks (for tests that check playback UI)
 *
 * Architecture:
 * - Injects via electronApp.evaluate() to override IPC handlers in the main process
 * - Uses event.sender.send() for streaming TTS chunks
 * - Returns empty Uint8Array(0) for TTS by default (sufficient for most tests)
 *
 * @see docs/plans/partway/260126_e2e_test_architecture_overhaul.md (Stage 3.2)
 */

import type { ElectronApplication } from '@playwright/test';

// =============================================================================
// Types
// =============================================================================

/**
 * Options for enabling voice mocking.
 */
export interface VoiceMockOptions {
  /**
   * Map audio source identifiers to transcription text.
   * Keys can be any identifier (the mock doesn't actually decode audio).
   * When voice:transcribe is called, returns the first matching value or defaultTranscription.
   */
  transcriptions?: Record<string, string>;
  /**
   * Default transcription text when no specific mapping matches.
   * Default: 'Mock transcription'
   */
  defaultTranscription?: string;
  /**
   * Whether to emit voice:tts-chunk events for tests that check playback UI.
   * If true, emits chunk events via event.sender.send().
   * Default: false
   */
  emitTtsChunks?: boolean;
  /**
   * Delay between TTS chunks when emitTtsChunks is true (ms).
   * Default: 10
   */
  ttsChunkDelayMs?: number;
  /**
   * Number of TTS chunks to emit when emitTtsChunks is true.
   * Default: 3
   */
  ttsChunkCount?: number;
  /**
   * Enable debug logging in the main process.
   * Default: false
   */
  debug?: boolean;
  /**
   * If set, voice:transcribe throws an error instead of returning a transcription.
   * Saves a dummy pending file first (mimicking safe-transcribe pattern) so the
   * pending audio popover can detect the failure. Error message uses `[category]`
   * prefix format matching the real voiceHandlers error encoding.
   */
  errorResponse?: {
    message: string;
    category?: string;
  };
}

/**
 * Serializable version of VoiceMockOptions for passing through electronApp.evaluate().
 */
interface SerializableVoiceMockOptions {
  transcriptions: Record<string, string>;
  defaultTranscription: string;
  emitTtsChunks: boolean;
  ttsChunkDelayMs: number;
  ttsChunkCount: number;
  debug: boolean;
  errorResponse: { message: string; category?: string } | null;
  /** Pre-resolved userData path (avoids require('electron') inside evaluate) */
  userDataPath: string;
}

// =============================================================================
// Implementation
// =============================================================================

/**
 * Enable voice mocking in an Electron app for E2E testing.
 *
 * This function injects mock handlers for voice IPC channels,
 * allowing tests to run without making live TTS/STT calls.
 *
 * Usage:
 * ```typescript
 * await enableVoiceMocking(electronApp, {
 *   defaultTranscription: 'Hello, how are you?',
 *   emitTtsChunks: false,
 * });
 * ```
 *
 * For tests that check TTS playback UI:
 * ```typescript
 * await enableVoiceMocking(electronApp, {
 *   emitTtsChunks: true,
 *   ttsChunkCount: 5,
 *   ttsChunkDelayMs: 20,
 * });
 * ```
 *
 * @param app - The Playwright ElectronApplication instance
 * @param options - Mock configuration options
 */
export async function enableVoiceMocking(
  app: ElectronApplication,
  options?: VoiceMockOptions
): Promise<void> {
  // Pre-resolve userData path so we don't need require('electron') inside evaluate
  const userDataPath = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'));

  // Serialize options for passing through Electron IPC
  const serializedOptions: SerializableVoiceMockOptions = {
    transcriptions: options?.transcriptions ?? {},
    defaultTranscription: options?.defaultTranscription ?? 'Mock transcription',
    emitTtsChunks: options?.emitTtsChunks ?? false,
    ttsChunkDelayMs: options?.ttsChunkDelayMs ?? 10,
    ttsChunkCount: options?.ttsChunkCount ?? 3,
    debug: options?.debug ?? false,
    errorResponse: options?.errorResponse ?? null,
    userDataPath,
  };

  // Stash Node.js fs/path on globalThis for the mock handler to use.
  // electronApp.evaluate() runs in a V8 context where require() is not available,
  // but we can access it through the bundled main process module system.
  if (options?.errorResponse) {
    await app.evaluate(async () => {
      // Access require through the main module (available in Electron's CJS bundle)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mainRequire = (process as any).mainModule?.require ?? (globalThis as any).require;
      if (mainRequire) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (globalThis as any).__voiceMockFs = mainRequire('fs');
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (globalThis as any).__voiceMockPath = mainRequire('path');
      }
    });
  }

  await app.evaluate(async ({ ipcMain }, opts: SerializableVoiceMockOptions) => {
    const {
      transcriptions,
      defaultTranscription,
      emitTtsChunks,
      ttsChunkDelayMs,
      ttsChunkCount,
      debug,
      errorResponse,
      userDataPath,
    } = opts;

    // Helper to log in debug mode
    const debugLog = (msg: string) => {
      if (debug) {
        console.log(`[Voice-Mock] ${msg}`);
      }
    };

    // Remove existing handlers to prevent conflicts
    const handlersToRemove = [
      'voice:transcribe',
      'voice:text-to-speech',
      'voice:text-to-speech-with-timestamps',
    ];

    for (const channel of handlersToRemove) {
      try {
        ipcMain.removeHandler(channel);
        debugLog(`Removed existing handler: ${channel}`);
      } catch {
        // Handler may not exist - that's fine
      }
    }

    // Mock voice:transcribe (STT)
    ipcMain.handle(
      'voice:transcribe',
      async (
        _event: Electron.IpcMainInvokeEvent,
        payload: {
          audio: ArrayBuffer;
          mimeType: string;
          source: string;
          sessionId?: string;
          durationMs?: number;
          pendingAudioWav?: ArrayBuffer;
        }
      ) => {
        const { source, sessionId, mimeType } = payload;
        debugLog(`voice:transcribe received - source: ${source}, sessionId: ${sessionId}, mimeType: ${mimeType}`);

        // Error simulation: save pending file then throw (mimics safe-transcribe pattern).
        // File I/O uses the stashed fs/path references from globalThis (set before this evaluate).
        if (errorResponse) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const nodeFs = (globalThis as any).__voiceMockFs;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const nodePath = (globalThis as any).__voiceMockPath;

          if (nodeFs && nodePath) {
            const pendingDir = nodePath.join(userDataPath, 'pending-audio');
            nodeFs.mkdirSync(pendingDir, { recursive: true });

            const ts = new Date().toISOString().replace(/[:.]/g, '-');
            const src = source || 'inline-mic';
            const ext = payload.pendingAudioWav ? 'wav' : (mimeType?.includes('webm') ? 'webm' : 'wav');
            const filename = sessionId ? `${ts}_${src}_${sessionId}.${ext}` : `${ts}_${src}.${ext}`;
            const filePath = nodePath.join(pendingDir, filename);

            const audioData = payload.pendingAudioWav ?? payload.audio;
            nodeFs.writeFileSync(filePath, Buffer.from(audioData));
            debugLog(`Saved pending audio for error simulation: ${filePath}`);
          } else {
            debugLog('WARNING: fs/path globals not found — pending file not saved');
          }

          const prefix = errorResponse.category ? `[${errorResponse.category}]` : '';
          throw new Error(`${prefix}${errorResponse.message}`);
        }

        // Check if there's a specific transcription for this source
        let transcription = defaultTranscription;

        // Check transcriptions map - try source, then sessionId
        if (source in transcriptions) {
          transcription = transcriptions[source];
          debugLog(`Matched transcription by source: "${source}"`);
        } else if (sessionId && sessionId in transcriptions) {
          transcription = transcriptions[sessionId];
          debugLog(`Matched transcription by sessionId: "${sessionId}"`);
        } else {
          debugLog(`Using default transcription`);
        }

        debugLog(`Returning transcription: "${transcription.slice(0, 50)}${transcription.length > 50 ? '...' : ''}"`);

        // Return transcription in the same format as the real handler
        return transcription;
      }
    );

    // Mock voice:text-to-speech (TTS)
    ipcMain.handle(
      'voice:text-to-speech',
      async (event: Electron.IpcMainInvokeEvent, text: string) => {
        debugLog(`voice:text-to-speech received - text: "${text.slice(0, 50)}${text.length > 50 ? '...' : ''}"`);

        if (emitTtsChunks) {
          // Emit TTS chunk events for tests that check playback UI
          const sender = event.sender;

          for (let i = 0; i < ttsChunkCount; i++) {
            await new Promise<void>((resolve) => {
              setTimeout(() => {
                const isFinal = i === ttsChunkCount - 1;
                debugLog(`Emitting voice:tts-chunk ${i + 1}/${ttsChunkCount} (final: ${isFinal})`);
                
                // Send chunk event - mimics real TTS streaming behavior
                // Subscription expects ArrayBuffer (fix: was sending Uint8Array)
                sender.send('voice:tts-chunk', new ArrayBuffer(0));
                resolve();
              }, ttsChunkDelayMs);
            });
          }

          debugLog(`TTS chunk streaming completed`);
        }

        // Return empty ArrayBuffer - sufficient for most tests
        // Real handler returns audio data from TTS service
        debugLog(`Returning empty audio buffer`);
        return new ArrayBuffer(0);
      }
    );

    // Mock voice:text-to-speech-with-timestamps (TTS with ElevenLabs alignment data)
    ipcMain.handle(
      'voice:text-to-speech-with-timestamps',
      async (_event: Electron.IpcMainInvokeEvent, text: string) => {
        debugLog(`voice:text-to-speech-with-timestamps received - text: "${text.slice(0, 50)}${text.length > 50 ? '...' : ''}"`);

        // Return mock response matching ElevenLabs alignment format
        // Real handler returns { audio: ArrayBuffer, alignment: { characters, ... } }
        // Fix: use camelCase property names to match real response (was snake_case)
        const mockAlignment = {
          characters: text.split(''),
          characterStartTimesSeconds: text.split('').map((_, i) => i * 0.05),
          characterEndTimesSeconds: text.split('').map((_, i) => (i + 1) * 0.05),
        };

        debugLog(`Returning mock alignment with ${text.length} characters`);

        return {
          audio: new ArrayBuffer(0),
          alignment: mockAlignment,
        };
      }
    );

    // Mock voice:retry-pending-audio so auto-retry returns same error category
    // (without this, the real handler would call the actual API with a fake key)
    if (errorResponse) {
      try { ipcMain.removeHandler('voice:retry-pending-audio'); } catch { /* may not exist */ }
      ipcMain.handle(
        'voice:retry-pending-audio',
        async (_event: Electron.IpcMainInvokeEvent, _payload: { filePath: string }) => {
          const prefix = errorResponse.category ? `[${errorResponse.category}]` : '';
          debugLog(`voice:retry-pending-audio mock returning error: ${prefix}${errorResponse.message}`);
          return {
            success: false,
            error: `${prefix}${errorResponse.message}`,
            errorCategory: errorResponse.category,
          };
        }
      );
      debugLog('voice:retry-pending-audio mock enabled');
    }

    debugLog('Voice mocking enabled');
  }, serializedOptions);
}

/**
 * Disable voice mocking by removing mock IPC handlers.
 *
 * Note: This doesn't restore the original handlers - it just removes the mocks.
 * The app will need to be restarted to get real voice functionality back.
 * For most test scenarios, simply closing the app after the test is sufficient.
 *
 * @param app - The Playwright ElectronApplication instance
 */
export async function disableVoiceMocking(app: ElectronApplication): Promise<void> {
  await app.evaluate(async ({ ipcMain }) => {
    const handlersToRemove = [
      'voice:transcribe',
      'voice:text-to-speech',
      'voice:text-to-speech-with-timestamps',
      'voice:retry-pending-audio',
    ];

    for (const channel of handlersToRemove) {
      try {
        ipcMain.removeHandler(channel);
      } catch {
        // Handler may not exist
      }
    }

    console.log('[Voice-Mock] Voice mocking disabled');
  });
}

// =============================================================================
// Convenience Helpers
// =============================================================================

/**
 * Create VoiceMockOptions with common presets for different test scenarios.
 */
export const VoiceMockPresets = {
  /**
   * Minimal mock - returns empty audio and default transcription.
   * Suitable for tests that don't focus on voice features.
   */
  minimal: (): VoiceMockOptions => ({
    defaultTranscription: 'Mock transcription',
    emitTtsChunks: false,
  }),

  /**
   * Playback UI mock - emits TTS chunks for testing audio playback indicators.
   */
  playbackUI: (): VoiceMockOptions => ({
    defaultTranscription: 'Mock transcription',
    emitTtsChunks: true,
    ttsChunkCount: 5,
    ttsChunkDelayMs: 20,
  }),

  /**
   * Debug mock - enables verbose logging.
   */
  debug: (): VoiceMockOptions => ({
    defaultTranscription: 'Mock transcription',
    emitTtsChunks: false,
    debug: true,
  }),
};
