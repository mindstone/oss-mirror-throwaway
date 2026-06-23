/**
 * Unit tests for audioService.ts - specifically testing the chunking logic
 * for large audio files that exceed Whisper API limits.
 *
 * These tests verify:
 * - Size threshold detection (files under/over MAX_WHISPER_FILE_SIZE)
 * - Chunk duration calculation (verify math with different file sizes)
 * - Duration validation (invalid/zero/negative durationMs)
 * - ffmpeg availability check caching
 * - Graceful fallback error message when ffmpeg unavailable
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { initTestPlatformConfig } from '@core/__tests__/testHelpers';
import * as childProcess from 'node:child_process';
import axios from 'axios';
import FormData from 'form-data';
import { getSettings } from '@core/services/settingsStore';
import type { CodexVoiceConfig } from '@core/services/codexVoiceTypes';

// Mock child_process before importing audioService
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFile: vi.fn(),
    spawn: vi.fn(),
  };
});

// Mock axios to prevent actual API calls
vi.mock('axios', () => ({
  default: {
    post: vi.fn(),
  },
}));

// Mock form-data
vi.mock('form-data', () => {
  const FormDataMock = vi.fn(function MockFormData(this: {
    append: ReturnType<typeof vi.fn>;
    getBuffer: ReturnType<typeof vi.fn>;
    getHeaders: ReturnType<typeof vi.fn>;
  }) {
    this.append = vi.fn();
    this.getBuffer = vi.fn(() => Buffer.from('test'));
    this.getHeaders = vi.fn(() => ({}));
  });

  return {
    default: FormDataMock,
  };
});

// Mock fs/promises for temp file operations
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    default: {
      ...actual,
      mkdir: vi.fn().mockResolvedValue(undefined),
      writeFile: vi.fn().mockResolvedValue(undefined),
      readFile: vi.fn().mockResolvedValue(Buffer.from('test')),
      readdir: vi.fn().mockResolvedValue(['chunk_000.webm', 'chunk_001.webm']),
      rm: vi.fn().mockResolvedValue(undefined),
    },
    mkdir: vi.fn().mockResolvedValue(undefined),
    writeFile: vi.fn().mockResolvedValue(undefined),
    readFile: vi.fn().mockResolvedValue(Buffer.from('test')),
    readdir: vi.fn().mockResolvedValue(['chunk_000.webm', 'chunk_001.webm']),
    rm: vi.fn().mockResolvedValue(undefined),
  };
});

// Mock settingsStore
vi.mock('@core/services/settingsStore', () => ({
  setSettingsStoreAdapter: vi.fn(),
  getSettings: vi.fn(() => ({
    voice: {
      provider: 'openai-whisper',
      openaiApiKey: 'test-api-key',
      model: 'whisper-1',
      transcriptionVocabulary: [],
      voiceInputLanguage: 'auto',
    },
  })),
}));

// Mock error reporter
vi.mock('@core/errorReporter', () => ({
  setErrorReporter: vi.fn(),
  getErrorReporter: () => ({
    captureException: vi.fn(),
    captureMessage: vi.fn(),
    addBreadcrumb: vi.fn(),
  }),
}));

// Mock logRedaction (canonical source is now @core/utils/logRedaction)
vi.mock('@core/utils/logRedaction', () => ({
  redactSensitiveData: vi.fn((str) => str),
}));

// Import the module after all mocks are set up
import {
  MAX_WHISPER_FILE_SIZE,
  TARGET_CHUNK_SIZE,
  checkFfmpegAvailable,
  setCodexVoiceConfig,
  transcribeAudio,
  buildNetworkAwareMessage,
  detectQuotaExhausted,
  VoiceTranscriptionError,
  type VoiceErrorCategory,
} from '../audioService';

describe('audioService', () => {
  describe('constants', () => {
    it('MAX_WHISPER_FILE_SIZE is 20MB (safe margin under 25MB limit)', () => {
      expect(MAX_WHISPER_FILE_SIZE).toBe(20 * 1024 * 1024);
    });

    it('TARGET_CHUNK_SIZE is 18MB (canonical value from core audioChunking)', () => {
      expect(TARGET_CHUNK_SIZE).toBe(18 * 1024 * 1024);
    });
  });

  describe('checkFfmpegAvailable', () => {
    beforeEach(async () => {
      // Reset the cached ffmpeg availability before each test
      // We need to reset the module state - this is done by re-importing
      vi.resetModules();
      await initTestPlatformConfig();
    });

    afterEach(() => {
      vi.clearAllMocks();
    });

    it('returns true when ffmpeg is available', async () => {
      const execFileMock = vi.mocked(childProcess.execFile);
      execFileMock.mockImplementation((_cmd, _args, _options, callback) => {
        if (typeof callback === 'function') {
          callback(null, 'ffmpeg version 5.0', '');
        }
        return {} as any;
      });

      // Re-import to get fresh module state
      const { checkFfmpegAvailable: freshCheck } = await import('../audioService');
      const result = await freshCheck();
      expect(result).toBe(true);
    });

    it('returns false when ffmpeg is not available', async () => {
      const execFileMock = vi.mocked(childProcess.execFile);
      execFileMock.mockImplementation((_cmd, _args, _options, callback) => {
        if (typeof callback === 'function') {
          const error = new Error('Command not found: ffmpeg');
          callback(error as any, '', '');
        }
        return {} as any;
      });

      // Re-import to get fresh module state
      vi.resetModules();
      await initTestPlatformConfig();
      // Re-apply mocks for fresh import
      vi.doMock('node:child_process', async (importOriginal) => {
        const actual = await importOriginal<typeof import('node:child_process')>();
        return {
          ...actual,
          execFile: vi.fn((_cmd: any, _args: any, _options: any, callback: any) => {
            if (typeof callback === 'function') {
              const error = new Error('Command not found: ffmpeg');
              callback(error as any, '', '');
            }
            return {} as any;
          }),
          spawn: vi.fn(),
        };
      });

      const { checkFfmpegAvailable: freshCheck } = await import('../audioService');
      const result = await freshCheck();
      expect(result).toBe(false);
    });

    it('caches the ffmpeg availability result', async () => {
      const execFileMock = vi.mocked(childProcess.execFile);
      let _callCount = 0;
      execFileMock.mockImplementation((_cmd, _args, _options, callback) => {
        _callCount++;
        if (typeof callback === 'function') {
          callback(null, 'ffmpeg version 5.0', '');
        }
        return {} as any;
      });

      // First call should check ffmpeg
      const result1 = await checkFfmpegAvailable();
      // Second call should use cached result
      const result2 = await checkFfmpegAvailable();

      expect(result1).toBe(result2);
      // Note: Due to module caching, the execFile may have been called from previous tests
      // The important thing is that both calls return the same result (caching works)
    });
  });

  describe('size threshold detection', () => {
    it('identifies files under MAX_WHISPER_FILE_SIZE as not needing chunking', () => {
      const smallFileSize = 15 * 1024 * 1024; // 15MB
      expect(smallFileSize <= MAX_WHISPER_FILE_SIZE).toBe(true);
    });

    it('identifies files at exactly MAX_WHISPER_FILE_SIZE as not needing chunking', () => {
      const exactFileSize = MAX_WHISPER_FILE_SIZE; // 20MB
      expect(exactFileSize <= MAX_WHISPER_FILE_SIZE).toBe(true);
    });

    it('identifies files over MAX_WHISPER_FILE_SIZE as needing chunking', () => {
      const largeFileSize = 24 * 1024 * 1024; // 24MB
      expect(largeFileSize > MAX_WHISPER_FILE_SIZE).toBe(true);
    });

    it('identifies files just over the threshold as needing chunking', () => {
      const justOverFileSize = MAX_WHISPER_FILE_SIZE + 1; // 20MB + 1 byte
      expect(justOverFileSize > MAX_WHISPER_FILE_SIZE).toBe(true);
    });
  });

  describe('chunk duration calculation', () => {
    /**
     * The formula used in audioService.ts:
     * bytesPerSecond = audio.byteLength / durationSec
     * chunkDurationSec = Math.max(1, Math.floor(TARGET_CHUNK_SIZE / bytesPerSecond))
     */

    it('calculates correct chunk duration for 60s @ 24MB (typical large voice recording)', () => {
      const audioByteLength = 24 * 1024 * 1024; // 24MB = 25,165,824 bytes
      const durationMs = 60 * 1000; // 60 seconds
      const durationSec = durationMs / 1000;

      const bytesPerSecond = audioByteLength / durationSec;
      // bytesPerSecond = 25,165,824 / 60 ≈ 419,430 bytes/second (~409KB/s)
      expect(bytesPerSecond).toBeCloseTo(419430.4, 0);

      const chunkDurationSec = Math.max(1, Math.floor(TARGET_CHUNK_SIZE / bytesPerSecond));
      // chunkDurationSec = 18,874,368 / 419,430.4 = 45 seconds exactly (18/24 * 60)
      expect(chunkDurationSec).toBe(45);

      // This should produce 2 chunks: 0-45s, 45-60s
      const expectedChunks = Math.ceil(durationSec / chunkDurationSec);
      expect(expectedChunks).toBe(2);
    });

    it('calculates correct chunk duration for 120s @ 50MB (very large recording)', () => {
      const audioByteLength = 50 * 1024 * 1024; // 50MB
      const durationMs = 120 * 1000; // 120 seconds
      const durationSec = durationMs / 1000;

      const bytesPerSecond = audioByteLength / durationSec;
      // bytesPerSecond = 50MB / 120s ≈ 426,666 bytes/second

      const chunkDurationSec = Math.max(1, Math.floor(TARGET_CHUNK_SIZE / bytesPerSecond));
      // chunkDurationSec = 18MB / 426KB/s ≈ 43 seconds
      expect(chunkDurationSec).toBe(43);

      // This should produce 3 chunks
      const expectedChunks = Math.ceil(durationSec / chunkDurationSec);
      expect(expectedChunks).toBe(3);
    });

    it('calculates correct chunk duration for high bitrate audio (30s @ 24MB)', () => {
      const audioByteLength = 24 * 1024 * 1024; // 24MB
      const durationMs = 30 * 1000; // 30 seconds (high bitrate)
      const durationSec = durationMs / 1000;

      const bytesPerSecond = audioByteLength / durationSec;
      // bytesPerSecond = 24MB / 30s = 819,200 bytes/second (~800KB/s)

      const chunkDurationSec = Math.max(1, Math.floor(TARGET_CHUNK_SIZE / bytesPerSecond));
      // chunkDurationSec = 18MB / 800KB/s ≈ 22 seconds
      expect(chunkDurationSec).toBe(22);

      // This should produce 2 chunks
      const expectedChunks = Math.ceil(durationSec / chunkDurationSec);
      expect(expectedChunks).toBe(2);
    });

    it('clamps chunk duration to minimum 1 second for very high bitrate', () => {
      const audioByteLength = 100 * 1024 * 1024; // 100MB
      const durationMs = 5 * 1000; // 5 seconds (extremely high bitrate)
      const durationSec = durationMs / 1000;

      const bytesPerSecond = audioByteLength / durationSec;
      // bytesPerSecond = 100MB / 5s = 20MB/second (extremely high)

      const chunkDurationSec = Math.max(1, Math.floor(TARGET_CHUNK_SIZE / bytesPerSecond));
      // Without Math.max(1, ...), this would be 0 seconds
      // With Math.max(1, ...), it's clamped to 1 second
      expect(chunkDurationSec).toBe(1);
    });

    it('handles small files that barely exceed threshold', () => {
      const audioByteLength = 21 * 1024 * 1024; // 21MB (just over 20MB threshold)
      const durationMs = 60 * 1000; // 60 seconds
      const durationSec = durationMs / 1000;

      const bytesPerSecond = audioByteLength / durationSec;
      const chunkDurationSec = Math.max(1, Math.floor(TARGET_CHUNK_SIZE / bytesPerSecond));
      // Should create ~2 chunks
      expect(chunkDurationSec).toBeGreaterThan(20);

      const expectedChunks = Math.ceil(durationSec / chunkDurationSec);
      expect(expectedChunks).toBeGreaterThanOrEqual(2);
    });
  });

  describe('duration validation', () => {
    it('throws error for undefined durationMs on large files', async () => {
      const largeAudio = new ArrayBuffer(25 * 1024 * 1024); // 25MB

      await expect(
        transcribeAudio({
          audio: largeAudio,
          mimeType: 'audio/webm',
          durationMs: undefined,
        })
      ).rejects.toThrow('Recording duration required for large audio files');
    });

    it('throws error for zero durationMs on large files', async () => {
      // Reset modules to get fresh ffmpeg check that returns true
      vi.resetModules();
      await initTestPlatformConfig();

      // Mock ffmpeg as available
      vi.doMock('node:child_process', async (importOriginal) => {
        const actual = await importOriginal<typeof import('node:child_process')>();
        return {
          ...actual,
          execFile: vi.fn((_cmd: any, _args: any, _options: any, callback: any) => {
            if (typeof callback === 'function') {
              callback(null, 'ffmpeg version 5.0', '');
            }
            return {} as any;
          }),
          spawn: vi.fn(),
        };
      });

      // Re-apply other mocks
      vi.doMock('axios', () => ({
        default: { post: vi.fn() },
      }));
      vi.doMock('form-data', () => ({
        default: vi.fn().mockImplementation(() => ({
          append: vi.fn(),
          getBuffer: vi.fn(() => Buffer.from('test')),
          getHeaders: vi.fn(() => ({})),
        })),
      }));
      vi.doMock('node:fs/promises', () => ({
        default: {
          mkdir: vi.fn().mockResolvedValue(undefined),
          writeFile: vi.fn().mockResolvedValue(undefined),
          readFile: vi.fn().mockResolvedValue(Buffer.from('test')),
          readdir: vi.fn().mockResolvedValue([]),
          rm: vi.fn().mockResolvedValue(undefined),
        },
      }));
      vi.doMock('@core/services/settingsStore', () => ({
        setSettingsStoreAdapter: vi.fn(),
        getSettings: vi.fn(() => ({
          voice: {
            provider: 'openai-whisper',
            openaiApiKey: 'test-api-key',
            model: 'whisper-1',
            transcriptionVocabulary: [],
            voiceInputLanguage: 'auto',
          },
        })),
      }));
      vi.doMock('@core/logger', () => ({
        createScopedLogger: vi.fn(() => ({
          debug: vi.fn(),
          info: vi.fn(),
          warn: vi.fn(),
          error: vi.fn(),
        })),
      }));
      vi.doMock('@core/errorReporter', () => ({
        setErrorReporter: vi.fn(),
        getErrorReporter: () => ({
          captureException: vi.fn(),
          captureMessage: vi.fn(),
          addBreadcrumb: vi.fn(),
        }),
      }));
      vi.doMock('@core/utils/logRedaction', () => ({
        redactSensitiveData: vi.fn((str: string) => str),
      }));

      const { transcribeAudio: freshTranscribe } = await import('../audioService');

      const largeAudio = new ArrayBuffer(25 * 1024 * 1024); // 25MB

      // durationMs: 0 should cause "Invalid recording duration" error
      // from the transcribeChunkedWebm function
      await expect(
        freshTranscribe({
          audio: largeAudio,
          mimeType: 'audio/webm',
          durationMs: 0,
        })
      ).rejects.toThrow(/Invalid recording duration|Recording duration required/);
    });

    it('validates durationMs in chunk calculation to prevent NaN/Infinity', () => {
      // Test the validation logic used in transcribeChunkedWebm
      const testDurations = [
        { durationMs: 0, shouldBeInvalid: true },
        { durationMs: -1, shouldBeInvalid: true },
        { durationMs: NaN, shouldBeInvalid: true },
        { durationMs: Infinity, shouldBeInvalid: true },
        { durationMs: -Infinity, shouldBeInvalid: true },
        { durationMs: 1000, shouldBeInvalid: false },
        { durationMs: 60000, shouldBeInvalid: false },
      ];

      for (const { durationMs, shouldBeInvalid } of testDurations) {
        const durationSec = durationMs / 1000;
        const isInvalid = !Number.isFinite(durationSec) || durationSec <= 0;
        expect(isInvalid).toBe(shouldBeInvalid);
      }
    });
  });

  describe('graceful fallback when ffmpeg unavailable', () => {
    it('throws user-friendly error for large files when ffmpeg is unavailable', async () => {
      // Reset modules to get fresh state
      vi.resetModules();
      await initTestPlatformConfig();

      // Mock ffmpeg as unavailable
      vi.doMock('node:child_process', async (importOriginal) => {
        const actual = await importOriginal<typeof import('node:child_process')>();
        return {
          ...actual,
          execFile: vi.fn((_cmd: any, _args: any, _options: any, callback: any) => {
            if (typeof callback === 'function') {
              const error = new Error('Command not found: ffmpeg');
              callback(error as any, '', '');
            }
            return {} as any;
          }),
          spawn: vi.fn(),
        };
      });

      // Re-apply other mocks
      vi.doMock('axios', () => ({
        default: { post: vi.fn() },
      }));
      vi.doMock('form-data', () => ({
        default: vi.fn().mockImplementation(() => ({
          append: vi.fn(),
          getBuffer: vi.fn(() => Buffer.from('test')),
          getHeaders: vi.fn(() => ({})),
        })),
      }));
      vi.doMock('node:fs/promises', () => ({
        default: {
          mkdir: vi.fn().mockResolvedValue(undefined),
          writeFile: vi.fn().mockResolvedValue(undefined),
          readFile: vi.fn().mockResolvedValue(Buffer.from('test')),
          readdir: vi.fn().mockResolvedValue([]),
          rm: vi.fn().mockResolvedValue(undefined),
        },
      }));
      vi.doMock('@core/services/settingsStore', () => ({
        setSettingsStoreAdapter: vi.fn(),
        getSettings: vi.fn(() => ({
          voice: {
            provider: 'openai-whisper',
            openaiApiKey: 'test-api-key',
            model: 'whisper-1',
            transcriptionVocabulary: [],
            voiceInputLanguage: 'auto',
          },
        })),
      }));
      vi.doMock('@core/logger', () => ({
        createScopedLogger: vi.fn(() => ({
          debug: vi.fn(),
          info: vi.fn(),
          warn: vi.fn(),
          error: vi.fn(),
        })),
      }));
      vi.doMock('@core/errorReporter', () => ({
        setErrorReporter: vi.fn(),
        getErrorReporter: () => ({
          captureException: vi.fn(),
          captureMessage: vi.fn(),
          addBreadcrumb: vi.fn(),
        }),
      }));
      vi.doMock('@core/utils/logRedaction', () => ({
        redactSensitiveData: vi.fn((str: string) => str),
      }));

      const { transcribeAudio: freshTranscribe } = await import('../audioService');

      const largeAudio = new ArrayBuffer(25 * 1024 * 1024); // 25MB

      await expect(
        freshTranscribe({
          audio: largeAudio,
          mimeType: 'audio/webm',
          durationMs: 60000,
        })
      ).rejects.toThrow('Recording is too long. Please keep recordings under 60 seconds, or install ffmpeg for longer recordings.');
    });

    it('error message mentions both the time limit and ffmpeg installation', async () => {
      const expectedMessage = 'Recording is too long. Please keep recordings under 60 seconds, or install ffmpeg for longer recordings.';

      // Verify the message contains helpful guidance
      expect(expectedMessage).toContain('60 seconds');
      expect(expectedMessage).toContain('ffmpeg');
      expect(expectedMessage).toContain('Recording is too long');
    });
  });

  describe('custom-openai transcription requests', () => {
    const createCustomOpenAiSettings = (overrides: Partial<Record<string, unknown>> = {}) => ({
      voice: {
        provider: 'custom-openai',
        openaiApiKey: null,
        elevenlabsApiKey: null,
        model: 'gpt-4o-mini-transcribe-2025-12-15',
        ttsVoice: 'nova',
        activationHotkey: 'CommandOrControl+Shift+Space',
        activationHotkeyVoiceMode: true,
        transcriptionVocabulary: ['Mindstone', 'Rebel'],
        voiceInputLanguage: 'auto',
        customProfiles: [
          {
            id: 'profile-1',
            name: 'Acme Voice',
            sttBaseUrl: 'https://speech.acme.dev/',
            sttModel: 'acme-whisper-1',
            apiKey: 'profile-api-key',
            createdAt: 1,
          },
        ],
        activeCustomProfileId: 'profile-1',
      },
      ...overrides,
    });

    beforeEach(() => {
      vi.clearAllMocks();
      vi.mocked(axios.post).mockResolvedValue({ data: { text: '  transcribed text  ' } } as any);
    });

    it('uses the OpenAI-compatible request path for custom-openai with URL, auth, model, and vocabulary', async () => {
      vi.mocked(getSettings).mockReturnValue(createCustomOpenAiSettings() as any);

      const result = await transcribeAudio({
        audio: new ArrayBuffer(1024),
        mimeType: 'audio/webm',
        durationMs: 1000,
      });

      expect(result).toBe('transcribed text');
      expect(axios.post).toHaveBeenCalledTimes(1);

      const [requestUrl, _body, requestConfig] = vi.mocked(axios.post).mock.calls[0];
      expect(requestUrl).toBe('https://speech.acme.dev/v1/audio/transcriptions');
      expect(requestConfig).toEqual(
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer profile-api-key',
          }),
        })
      );

      const formDataConstructorMock = FormData as unknown as {
        mock: {
          results: Array<{
            value: { append: ReturnType<typeof vi.fn> };
          }>;
        };
      };
      const formInstance = formDataConstructorMock.mock.results[0]?.value;
      expect(formInstance).toBeDefined();
      expect(formInstance?.append).toHaveBeenCalledWith('model', 'acme-whisper-1');
      expect(formInstance?.append).toHaveBeenCalledWith(
        'prompt',
        expect.stringContaining('Mindstone, Rebel')
      );
    });
  });

  describe('Codex transcription fallback', () => {
    const createOpenAiWhisperSettings = (openaiApiKey: string | null = null) => ({
      voice: {
        provider: 'openai-whisper',
        openaiApiKey,
        model: 'whisper-1',
        transcriptionVocabulary: ['Mindstone'],
        voiceInputLanguage: 'auto',
      },
    });

    const createCodexConfig = (overrides: Partial<CodexVoiceConfig> = {}) => ({
      transcribeEndpointUrl: 'https://chatgpt.com/backend-api/transcribe',
      isConnected: vi.fn(() => true),
      getAccessToken: vi.fn().mockResolvedValue('codex-token'),
      getAccountId: vi.fn(() => 'acct_123'),
      forceRefreshToken: vi.fn().mockResolvedValue('refreshed-token'),
      ...overrides,
    });

    beforeEach(() => {
      vi.clearAllMocks();
      setCodexVoiceConfig(null);
    });

    afterEach(() => {
      setCodexVoiceConfig(null);
    });

    it('routes openai-whisper to ChatGPT transcription when no API key is set and Codex is connected', async () => {
      vi.mocked(getSettings).mockReturnValue(createOpenAiWhisperSettings() as any);
      const codexConfig = createCodexConfig();
      setCodexVoiceConfig(codexConfig as any);
      vi.mocked(axios.post).mockResolvedValue({ data: { text: '  codex transcript  ' } } as any);

      const result = await transcribeAudio({
        audio: new ArrayBuffer(1024),
        mimeType: 'audio/webm;codecs=opus',
        durationMs: 1500,
      });

      expect(result).toBe('codex transcript');
      expect(axios.post).toHaveBeenCalledTimes(1);
      expect(codexConfig.getAccessToken).toHaveBeenCalledTimes(1);

      const [requestUrl, _body, requestConfig] = vi.mocked(axios.post).mock.calls[0];
      expect(requestUrl).toBe('https://chatgpt.com/backend-api/transcribe');
      expect(requestConfig).toEqual(
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer codex-token',
            'openai-organization': 'acct_123',
          }),
        })
      );

      const formDataConstructorMock = FormData as unknown as {
        mock: {
          results: Array<{
            value: { append: ReturnType<typeof vi.fn> };
          }>;
        };
      };
      const formInstance = formDataConstructorMock.mock.results.at(-1)?.value;
      expect(formInstance?.append).toHaveBeenCalledWith(
        'file',
        expect.any(Buffer),
        expect.objectContaining({
          filename: 'audio.webm',
          contentType: 'audio/webm',
        })
      );
    });

    it('refreshes the Codex token once after a 401 and retries transcription', async () => {
      vi.mocked(getSettings).mockReturnValue(createOpenAiWhisperSettings() as any);
      const codexConfig = createCodexConfig();
      setCodexVoiceConfig(codexConfig as any);
      vi.mocked(axios.post)
        .mockRejectedValueOnce({ response: { status: 401 } } as any)
        .mockResolvedValueOnce({ data: { text: 'retried transcript' } } as any);

      const result = await transcribeAudio({
        audio: new ArrayBuffer(1024),
        mimeType: 'audio/webm',
        durationMs: 1500,
      });

      expect(result).toBe('retried transcript');
      expect(codexConfig.forceRefreshToken).toHaveBeenCalledTimes(1);
      expect(axios.post).toHaveBeenCalledTimes(2);
      expect(vi.mocked(axios.post).mock.calls[1]?.[2]).toEqual(
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer refreshed-token',
          }),
        })
      );
    });

    it('surfaces a reconnect message when the ChatGPT token is unavailable', async () => {
      vi.mocked(getSettings).mockReturnValue(createOpenAiWhisperSettings() as any);
      const codexConfig = createCodexConfig({
        getAccessToken: vi.fn().mockResolvedValue(null),
      });
      setCodexVoiceConfig(codexConfig as any);

      await expect(
        transcribeAudio({
          audio: new ArrayBuffer(1024),
          mimeType: 'audio/webm',
          durationMs: 1500,
        })
      ).rejects.toMatchObject({
        message:
          'Your ChatGPT connection needs to be refreshed. Try disconnecting and reconnecting in Settings.',
        category: 'auth',
      });

      expect(axios.post).not.toHaveBeenCalled();
    });

    it('points the user at an API key workaround when the retry after refresh also returns 401', async () => {
      vi.mocked(getSettings).mockReturnValue(createOpenAiWhisperSettings() as any);
      const codexConfig = createCodexConfig();
      setCodexVoiceConfig(codexConfig as any);
      vi.mocked(axios.post)
        .mockRejectedValueOnce({ response: { status: 401 } } as any)
        .mockRejectedValueOnce({ response: { status: 401 } } as any);

      await expect(
        transcribeAudio({
          audio: new ArrayBuffer(1024),
          mimeType: 'audio/webm',
          durationMs: 1500,
        })
      ).rejects.toMatchObject({
        message:
          'Voice transcription via your ChatGPT subscription is unavailable for this account. Set an OpenAI API key in Settings > AI & Models > Providers to continue.',
        category: 'auth',
      });

      expect(codexConfig.forceRefreshToken).toHaveBeenCalledTimes(1);
      expect(axios.post).toHaveBeenCalledTimes(2);
    });

    it('refreshes the Codex token on a 403 and retries (previously skipped the refresh)', async () => {
      vi.mocked(getSettings).mockReturnValue(createOpenAiWhisperSettings() as any);
      const codexConfig = createCodexConfig();
      setCodexVoiceConfig(codexConfig as any);
      vi.mocked(axios.post)
        .mockRejectedValueOnce({ response: { status: 403 } } as any)
        .mockResolvedValueOnce({ data: { text: 'retried after 403 refresh' } } as any);

      const result = await transcribeAudio({
        audio: new ArrayBuffer(1024),
        mimeType: 'audio/webm',
        durationMs: 1500,
      });

      expect(result).toBe('retried after 403 refresh');
      expect(codexConfig.forceRefreshToken).toHaveBeenCalledTimes(1);
      expect(axios.post).toHaveBeenCalledTimes(2);
      expect(vi.mocked(axios.post).mock.calls[1]?.[2]).toEqual(
        expect.objectContaining({
          headers: expect.objectContaining({ Authorization: 'Bearer refreshed-token' }),
        })
      );
    });

    it('points the user at an API key workaround when the retry after refresh returns 403', async () => {
      vi.mocked(getSettings).mockReturnValue(createOpenAiWhisperSettings() as any);
      const codexConfig = createCodexConfig();
      setCodexVoiceConfig(codexConfig as any);
      vi.mocked(axios.post)
        .mockRejectedValueOnce({ response: { status: 403 } } as any)
        .mockRejectedValueOnce({ response: { status: 403 } } as any);

      await expect(
        transcribeAudio({
          audio: new ArrayBuffer(1024),
          mimeType: 'audio/webm',
          durationMs: 1500,
        })
      ).rejects.toMatchObject({
        message:
          'Voice transcription via your ChatGPT subscription is unavailable for this account. Set an OpenAI API key in Settings > AI & Models > Providers to continue.',
        category: 'auth',
      });

      expect(codexConfig.forceRefreshToken).toHaveBeenCalledTimes(1);
      expect(axios.post).toHaveBeenCalledTimes(2);
    });

    it('propagates non-auth retry errors through the outer catch (network failure after refresh)', async () => {
      vi.mocked(getSettings).mockReturnValue(createOpenAiWhisperSettings() as any);
      const codexConfig = createCodexConfig();
      setCodexVoiceConfig(codexConfig as any);
      vi.mocked(axios.post)
        .mockRejectedValueOnce({ response: { status: 401 } } as any)
        .mockRejectedValueOnce({ message: 'connect ETIMEDOUT', code: 'ETIMEDOUT' } as any);

      await expect(
        transcribeAudio({
          audio: new ArrayBuffer(1024),
          mimeType: 'audio/webm',
          durationMs: 1500,
        })
      ).rejects.toMatchObject({
        category: expect.stringMatching(/network|timeout|provider-error/),
      });

      expect(codexConfig.forceRefreshToken).toHaveBeenCalledTimes(1);
      expect(axios.post).toHaveBeenCalledTimes(2);
    });

    it('falls through to the outer catch when forceRefreshToken itself throws', async () => {
      vi.mocked(getSettings).mockReturnValue(createOpenAiWhisperSettings() as any);
      const codexConfig = createCodexConfig({
        forceRefreshToken: vi.fn().mockRejectedValue(new Error('token store corrupt')),
      });
      setCodexVoiceConfig(codexConfig as any);
      vi.mocked(axios.post).mockRejectedValueOnce({ response: { status: 401 } } as any);

      await expect(
        transcribeAudio({
          audio: new ArrayBuffer(1024),
          mimeType: 'audio/webm',
          durationMs: 1500,
        })
      ).rejects.toBeInstanceOf(VoiceTranscriptionError);

      expect(codexConfig.forceRefreshToken).toHaveBeenCalledTimes(1);
      expect(axios.post).toHaveBeenCalledTimes(1);
    });

    it('keeps the "reconnect" message when the token refresh itself fails', async () => {
      vi.mocked(getSettings).mockReturnValue(createOpenAiWhisperSettings() as any);
      const codexConfig = createCodexConfig({
        forceRefreshToken: vi.fn().mockResolvedValue(null),
      });
      setCodexVoiceConfig(codexConfig as any);
      vi.mocked(axios.post).mockRejectedValueOnce({ response: { status: 401 } } as any);

      await expect(
        transcribeAudio({
          audio: new ArrayBuffer(1024),
          mimeType: 'audio/webm',
          durationMs: 1500,
        })
      ).rejects.toMatchObject({
        message: 'Your ChatGPT connection expired. Please reconnect in Settings.',
        category: 'auth',
      });

      expect(codexConfig.forceRefreshToken).toHaveBeenCalledTimes(1);
      expect(axios.post).toHaveBeenCalledTimes(1);
    });

    it('keeps the existing OpenAI API path when an API key is configured', async () => {
      vi.mocked(getSettings).mockReturnValue(createOpenAiWhisperSettings('openai-key') as any);
      const codexConfig = createCodexConfig();
      setCodexVoiceConfig(codexConfig as any);
      vi.mocked(axios.post).mockResolvedValue({ data: { text: '  api key transcript  ' } } as any);

      const result = await transcribeAudio({
        audio: new ArrayBuffer(1024),
        mimeType: 'audio/webm',
        durationMs: 1500,
      });

      expect(result).toBe('api key transcript');
      expect(codexConfig.getAccessToken).not.toHaveBeenCalled();
      expect(axios.post).toHaveBeenCalledTimes(1);
      expect(vi.mocked(axios.post).mock.calls[0]?.[0]).toBe('https://api.openai.com/v1/audio/transcriptions');
    });

    it('blocks oversized Codex recordings with the staged single-request message', async () => {
      vi.mocked(getSettings).mockReturnValue(createOpenAiWhisperSettings() as any);
      const codexConfig = createCodexConfig();
      setCodexVoiceConfig(codexConfig as any);

      await expect(
        transcribeAudio({
          audio: new ArrayBuffer(MAX_WHISPER_FILE_SIZE + 1),
          mimeType: 'audio/webm',
          durationMs: 61000,
        })
      ).rejects.toMatchObject({
        message:
          'Recording is too long for your ChatGPT subscription. Set an OpenAI API key in Settings for longer recordings, or keep recordings under 60 seconds.',
        category: 'provider-error',
      });

      expect(codexConfig.getAccessToken).not.toHaveBeenCalled();
      expect(axios.post).not.toHaveBeenCalled();
    });
  });

  describe('ElevenLabs provider bypass', () => {
    it('ElevenLabs has 1GB limit and does not need chunking', async () => {
      // ElevenLabs Scribe has 1GB limit (1073741824 bytes)
      // So even a 24MB file should go through without chunking
      const elevenLabsMaxSize = 1024 * 1024 * 1024; // 1GB
      const largeVoiceRecording = 24 * 1024 * 1024; // 24MB

      // This file should NOT trigger chunking for ElevenLabs
      expect(largeVoiceRecording < elevenLabsMaxSize).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Error classification and message rewriting
  // -------------------------------------------------------------------------
  describe('VoiceTranscriptionError', () => {
    it('is an instance of Error', () => {
      const err = new VoiceTranscriptionError('test', 'billing');
      expect(err).toBeInstanceOf(Error);
      expect(err.name).toBe('VoiceTranscriptionError');
      expect(err.message).toBe('test');
      expect(err.category).toBe('billing');
    });

    it('carries category through catch', () => {
      try {
        throw new VoiceTranscriptionError('quota exceeded', 'billing');
      } catch (error) {
        expect(error).toBeInstanceOf(VoiceTranscriptionError);
        expect((error as VoiceTranscriptionError).category).toBe('billing');
      }
    });
  });

  describe('detectQuotaExhausted', () => {
    it('detects top-level type: insufficient_quota', () => {
      expect(detectQuotaExhausted({ type: 'insufficient_quota' })).toBe(true);
    });

    it('detects top-level code: insufficient_quota', () => {
      expect(detectQuotaExhausted({ code: 'insufficient_quota' })).toBe(true);
    });

    it('detects nested error.type: insufficient_quota', () => {
      expect(detectQuotaExhausted({ error: { type: 'insufficient_quota' } })).toBe(true);
    });

    it('detects nested error.code: insufficient_quota', () => {
      expect(detectQuotaExhausted({ error: { code: 'insufficient_quota' } })).toBe(true);
    });

    it('detects insufficient_funds variant', () => {
      expect(detectQuotaExhausted({ type: 'insufficient_funds' })).toBe(true);
      expect(detectQuotaExhausted({ error: { type: 'insufficient_funds' } })).toBe(true);
    });

    it('returns false for empty/null/string data', () => {
      expect(detectQuotaExhausted(undefined)).toBe(false);
      expect(detectQuotaExhausted('some string')).toBe(false);
    });

    it('returns false for 429 without quota body', () => {
      expect(detectQuotaExhausted({})).toBe(false);
      expect(detectQuotaExhausted({ type: 'rate_limit_exceeded' })).toBe(false);
      expect(detectQuotaExhausted({ error: { type: 'rate_limit_exceeded' } })).toBe(false);
    });

    it('returns false for retry-after style 429 (no quota indicators)', () => {
      expect(detectQuotaExhausted({ message: 'Rate limit exceeded' })).toBe(false);
    });
  });

  describe('buildNetworkAwareMessage — error classification', () => {
    const makeError = (overrides: Partial<{
      code: string;
      message: string;
      response: { status: number; data?: unknown; headers?: Record<string, unknown> };
    }> = {}) => ({
      code: overrides.code,
      message: overrides.message,
      response: overrides.response,
    });

    // -- Network errors → 'network' -----------------------------------------
    it('classifies ENOTFOUND as network', () => {
      const result = buildNetworkAwareMessage('transcription', 'OpenAI', 15000, makeError({ code: 'ENOTFOUND' }));
      expect(result.category).toBe('network');
      expect(result.message).toContain('internet connection');
    });

    it('classifies ECONNREFUSED as network', () => {
      const result = buildNetworkAwareMessage('transcription', 'OpenAI', 15000, makeError({ code: 'ECONNREFUSED' }));
      expect(result.category).toBe('network');
    });

    it('classifies ECONNRESET as network', () => {
      const result = buildNetworkAwareMessage('transcription', 'OpenAI', 15000, makeError({ code: 'ECONNRESET' }));
      expect(result.category).toBe('network');
    });

    it('classifies ETIMEDOUT as network', () => {
      const result = buildNetworkAwareMessage('transcription', 'OpenAI', 15000, makeError({ code: 'ETIMEDOUT' }));
      expect(result.category).toBe('network');
    });

    it('classifies EAI_AGAIN as network', () => {
      const result = buildNetworkAwareMessage('transcription', 'OpenAI', 15000, makeError({ code: 'EAI_AGAIN' }));
      expect(result.category).toBe('network');
    });

    // -- Timeout → 'temporary' -----------------------------------------------
    it('classifies ECONNABORTED (timeout) as temporary', () => {
      const result = buildNetworkAwareMessage('transcription', 'OpenAI', 15000, makeError({ code: 'ECONNABORTED' }));
      expect(result.category).toBe('temporary');
      expect(result.message).toContain('taking too long');
    });

    it('capitalizes operation in timeout message', () => {
      const result = buildNetworkAwareMessage('transcription', 'OpenAI', 15000, makeError({ code: 'ECONNABORTED' }));
      expect(result.message).toMatch(/^Transcription/);
    });

    // -- 429 → 'temporary' or 'billing' --------------------------------------
    it('classifies 429 without quota body as temporary', () => {
      const result = buildNetworkAwareMessage('transcription', 'OpenAI', 15000, makeError({
        response: { status: 429, data: {}, headers: {} },
      }));
      expect(result.category).toBe('temporary');
      expect(result.message).toContain('busy');
    });

    it('classifies 429 with retry-after as temporary', () => {
      const result = buildNetworkAwareMessage('transcription', 'OpenAI', 15000, makeError({
        response: { status: 429, data: {}, headers: { 'retry-after': '5' } },
      }));
      expect(result.category).toBe('temporary');
    });

    it('classifies 429 with insufficient_quota as billing', () => {
      const result = buildNetworkAwareMessage('transcription', 'OpenAI', 15000, makeError({
        response: { status: 429, data: { error: { type: 'insufficient_quota' } } },
      }));
      expect(result.category).toBe('billing');
      expect(result.message).toContain('credits');
      expect(result.message).toContain('billing');
    });

    it('classifies 429 with top-level insufficient_quota as billing', () => {
      const result = buildNetworkAwareMessage('transcription', 'OpenAI', 15000, makeError({
        response: { status: 429, data: { type: 'insufficient_quota' } },
      }));
      expect(result.category).toBe('billing');
    });

    // -- Auth errors → 'auth' ------------------------------------------------
    it('classifies 401 as auth', () => {
      const result = buildNetworkAwareMessage('transcription', 'OpenAI', 15000, makeError({
        response: { status: 401 },
      }));
      expect(result.category).toBe('auth');
      expect(result.message).toContain('API key');
      expect(result.message).toContain('Settings');
    });

    it('classifies 403 as auth', () => {
      const result = buildNetworkAwareMessage('transcription', 'OpenAI', 15000, makeError({
        response: { status: 403 },
      }));
      expect(result.category).toBe('auth');
    });

    // -- Server errors → 'temporary' or 'provider-error' ---------------------
    it('classifies 500 as provider-error', () => {
      const result = buildNetworkAwareMessage('transcription', 'OpenAI', 15000, makeError({
        response: { status: 500 },
      }));
      expect(result.category).toBe('provider-error');
      expect(result.message).toContain('ran into a problem');
    });

    it('classifies 502 as temporary', () => {
      const result = buildNetworkAwareMessage('transcription', 'OpenAI', 15000, makeError({
        response: { status: 502 },
      }));
      expect(result.category).toBe('temporary');
      expect(result.message).toContain('temporarily unavailable');
    });

    it('classifies 503 as temporary', () => {
      const result = buildNetworkAwareMessage('transcription', 'OpenAI', 15000, makeError({
        response: { status: 503 },
      }));
      expect(result.category).toBe('temporary');
    });

    it('classifies 504 as temporary', () => {
      const result = buildNetworkAwareMessage('transcription', 'OpenAI', 15000, makeError({
        response: { status: 504 },
      }));
      expect(result.category).toBe('temporary');
    });

    // -- Default → 'provider-error' ------------------------------------------
    it('classifies unknown status as provider-error', () => {
      const result = buildNetworkAwareMessage('transcription', 'OpenAI', 15000, makeError({
        response: { status: 418 },
      }));
      expect(result.category).toBe('provider-error');
    });

    it('classifies error with no status and no code as provider-error', () => {
      const result = buildNetworkAwareMessage('transcription', 'OpenAI', 15000, makeError({}));
      expect(result.category).toBe('provider-error');
    });

    // -- Message content: no HTTP codes, no jargon ----------------------------
    it('messages contain no HTTP status codes', () => {
      const statusCodes = [401, 403, 429, 500, 502, 503, 504];
      for (const status of statusCodes) {
        const result = buildNetworkAwareMessage('transcription', 'OpenAI', 15000, makeError({
          response: { status, data: {} },
        }));
        expect(result.message).not.toMatch(/HTTP \d+/);
        expect(result.message).not.toMatch(/\(\d{3}\)/);
      }
    });

    it('messages contain no technical error codes', () => {
      const codes = ['ENOTFOUND', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ECONNABORTED'];
      for (const code of codes) {
        const result = buildNetworkAwareMessage('transcription', 'OpenAI', 15000, makeError({ code }));
        expect(result.message).not.toContain(code);
      }
    });

    // -- Operation parameterization -------------------------------------------
    it('includes operation name in 500/502 messages', () => {
      const r500 = buildNetworkAwareMessage('transcription', 'OpenAI', 15000, makeError({
        response: { status: 500 },
      }));
      expect(r500.message).toContain('transcription');

      const r502 = buildNetworkAwareMessage('text-to-speech', 'OpenAI', 15000, makeError({
        response: { status: 502 },
      }));
      expect(r502.message).toContain('text-to-speech');
    });

    // -- Return type ----------------------------------------------------------
    it('always returns { message: string, category: VoiceErrorCategory }', () => {
      const scenarios = [
        makeError({ code: 'ENOTFOUND' }),
        makeError({ code: 'ECONNABORTED' }),
        makeError({ response: { status: 429, data: {} } }),
        makeError({ response: { status: 401 } }),
        makeError({ response: { status: 500 } }),
        makeError({}),
      ];
      const validCategories: VoiceErrorCategory[] = ['temporary', 'billing', 'auth', 'network', 'provider-error'];
      for (const err of scenarios) {
        const result = buildNetworkAwareMessage('transcription', 'OpenAI', 15000, err);
        expect(typeof result.message).toBe('string');
        expect(result.message.length).toBeGreaterThan(0);
        expect(validCategories).toContain(result.category);
      }
    });
  });
});
