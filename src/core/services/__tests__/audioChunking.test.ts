import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

 
vi.mock('@core/logger', () => ({
  createScopedLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// Mock child_process
const mockExecFile = vi.fn();
const mockSpawn = vi.fn();

 
vi.mock('node:child_process', () => ({
  execFile: (...args: unknown[]) => mockExecFile(...args),
  spawn: (...args: unknown[]) => mockSpawn(...args),
}));

// Mock fs/promises
const mockMkdir = vi.fn().mockResolvedValue(undefined);
const mockWriteFile = vi.fn().mockResolvedValue(undefined);
const mockReadFile = vi.fn();
const mockReaddir = vi.fn().mockResolvedValue([]);
const mockStat = vi.fn();
const mockRm = vi.fn().mockResolvedValue(undefined);
const mockOpen = vi.fn();

// Direct override for readdir in ffmpeg tests — vi.fn() mock state leaks
// across tests despite clearAllMocks, so we use a direct function override.
let _readdirOverride: ((dir: string) => Promise<string[]>) | null = null;

 
vi.mock('node:fs/promises', () => ({
  default: {
    mkdir: (...args: unknown[]) => mockMkdir(...args),
    writeFile: (...args: unknown[]) => mockWriteFile(...args),
    readFile: (...args: unknown[]) => mockReadFile(...args),
    readdir: (dir: string) => _readdirOverride ? _readdirOverride(dir) : mockReaddir(dir),
    stat: (...args: unknown[]) => mockStat(...args),
    rm: (...args: unknown[]) => mockRm(...args),
    open: (...args: unknown[]) => mockOpen(...args),
  },
  mkdir: (...args: unknown[]) => mockMkdir(...args),
  writeFile: (...args: unknown[]) => mockWriteFile(...args),
  readFile: (...args: unknown[]) => mockReadFile(...args),
  readdir: (dir: string) => _readdirOverride ? _readdirOverride(dir) : mockReaddir(dir),
  stat: (...args: unknown[]) => mockStat(...args),
  rm: (...args: unknown[]) => mockRm(...args),
  open: (...args: unknown[]) => mockOpen(...args),
}));

// Import after mocks
import {
  isChunkingRequired,
  getAudioDurationMs,
  chunkAudioFile,
  checkFfmpegAvailable,
  checkFfprobeAvailable,
  createWavChunk,
  MAX_FILE_SIZE_BYTES,
  TARGET_CHUNK_SIZE_BYTES,
  ELEVENLABS_MAX_FILE_SIZE_BYTES,
  _resetAvailabilityCache,
} from '../audioChunking';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a minimal valid 16-bit mono WAV buffer with given PCM data size. */
function createMinimalWavBuffer(pcmDataSize: number, sampleRate = 16000): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcmDataSize, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); // Subchunk1Size
  header.writeUInt16LE(1, 20); // PCM format
  header.writeUInt16LE(1, 22); // Mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28); // ByteRate
  header.writeUInt16LE(2, 32); // BlockAlign
  header.writeUInt16LE(16, 34); // BitsPerSample
  header.write('data', 36);
  header.writeUInt32LE(pcmDataSize, 40);

  const pcmData = Buffer.alloc(pcmDataSize, 0xAB);
  return Buffer.concat([header, pcmData]);
}

/** Helper to make execFile mock call the callback (promisify-compatible). */
function mockExecFileSuccess(stdout = '', stderr = ''): void {
  mockExecFile.mockImplementation(
    (_cmd: string, _args: string[], _opts: unknown, cb?: (err: Error | null, result: { stdout: string; stderr: string }) => void) => {
      if (typeof cb === 'function') {
        cb(null, { stdout, stderr });
      }
      // If no callback, it's being used with promisify which expects the 3-arg form
    }
  );
}

function mockExecFileError(err: Error): void {
  mockExecFile.mockImplementation(
    (_cmd: string, _args: string[], _opts: unknown, cb?: (err: Error) => void) => {
      if (typeof cb === 'function') {
        cb(err);
      }
    }
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('audioChunking', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetAvailabilityCache();
    // Reset persistent mockImplementation to avoid cross-test leakage
    mockExecFile.mockReset();
    mockSpawn.mockReset();
    // Re-apply default resolved values after reset
    mockMkdir.mockResolvedValue(undefined);
    mockWriteFile.mockResolvedValue(undefined);
    mockRm.mockResolvedValue(undefined);
    mockReaddir.mockResolvedValue([]);
    _readdirOverride = null;
  });

  // =========================================================================
  // isChunkingRequired
  // =========================================================================
  describe('isChunkingRequired', () => {
    it('returns false for small files', () => {
      expect(isChunkingRequired(1024)).toBe(false);
      expect(isChunkingRequired(MAX_FILE_SIZE_BYTES - 1)).toBe(false);
    });

    it('returns false for file exactly at MAX_FILE_SIZE_BYTES', () => {
      expect(isChunkingRequired(MAX_FILE_SIZE_BYTES)).toBe(false);
    });

    it('returns true for files exceeding MAX_FILE_SIZE_BYTES', () => {
      expect(isChunkingRequired(MAX_FILE_SIZE_BYTES + 1)).toBe(true);
      expect(isChunkingRequired(50 * 1024 * 1024)).toBe(true);
    });

    it('uses ElevenLabs 1GB limit when provider is elevenlabs', () => {
      const size = 500 * 1024 * 1024; // 500 MB
      expect(isChunkingRequired(size, 'elevenlabs')).toBe(false);
      expect(isChunkingRequired(size, 'elevenlabs-scribe')).toBe(false);
    });

    it('returns true for ElevenLabs when file exceeds 1GB', () => {
      const size = ELEVENLABS_MAX_FILE_SIZE_BYTES + 1;
      expect(isChunkingRequired(size, 'elevenlabs')).toBe(true);
      expect(isChunkingRequired(size, 'elevenlabs-scribe')).toBe(true);
    });

    it('uses standard limit for non-ElevenLabs providers', () => {
      const size = MAX_FILE_SIZE_BYTES + 1;
      expect(isChunkingRequired(size, 'openai-whisper')).toBe(true);
      expect(isChunkingRequired(size, 'custom-openai')).toBe(true);
      expect(isChunkingRequired(size, undefined)).toBe(true);
    });

    it('handles zero and negative sizes', () => {
      expect(isChunkingRequired(0)).toBe(false);
      expect(isChunkingRequired(-1)).toBe(false);
    });
  });

  // =========================================================================
  // checkFfmpegAvailable / checkFfprobeAvailable
  // =========================================================================
  describe('checkFfmpegAvailable', () => {
    it('returns true and caches when ffmpeg is found', async () => {
      mockExecFileSuccess('ffmpeg version 6.0');

      const result1 = await checkFfmpegAvailable();
      expect(result1).toBe(true);

      // Second call should be cached — no additional execFile call
      const result2 = await checkFfmpegAvailable();
      expect(result2).toBe(true);
      expect(mockExecFile).toHaveBeenCalledTimes(1);
    });

    it('returns false and caches when ffmpeg is not found', async () => {
      mockExecFileError(new Error('command not found'));

      const result1 = await checkFfmpegAvailable();
      expect(result1).toBe(false);

      // Second call should be cached
      const result2 = await checkFfmpegAvailable();
      expect(result2).toBe(false);
      expect(mockExecFile).toHaveBeenCalledTimes(1);
    });
  });

  describe('checkFfprobeAvailable', () => {
    it('returns true and caches when ffprobe is found', async () => {
      mockExecFileSuccess('ffprobe version 6.0');

      const result1 = await checkFfprobeAvailable();
      expect(result1).toBe(true);

      const result2 = await checkFfprobeAvailable();
      expect(result2).toBe(true);
      expect(mockExecFile).toHaveBeenCalledTimes(1);
    });

    it('returns false and caches when ffprobe is not found', async () => {
      mockExecFileError(new Error('command not found'));

      const result1 = await checkFfprobeAvailable();
      expect(result1).toBe(false);

      const result2 = await checkFfprobeAvailable();
      expect(result2).toBe(false);
      expect(mockExecFile).toHaveBeenCalledTimes(1);
    });
  });

  // =========================================================================
  // createWavChunk
  // =========================================================================
  describe('createWavChunk', () => {
    it('creates a valid WAV buffer with correct header', () => {
      const pcmData = Buffer.alloc(1000, 0xFF);
      const wav = createWavChunk(pcmData, 16000);

      // Check header fields
      expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
      expect(wav.readUInt32LE(4)).toBe(36 + 1000);
      expect(wav.toString('ascii', 8, 12)).toBe('WAVE');
      expect(wav.toString('ascii', 12, 16)).toBe('fmt ');
      expect(wav.readUInt16LE(20)).toBe(1); // PCM
      expect(wav.readUInt16LE(22)).toBe(1); // Mono
      expect(wav.readUInt32LE(24)).toBe(16000); // Sample rate
      expect(wav.readUInt32LE(28)).toBe(32000); // Byte rate
      expect(wav.readUInt16LE(32)).toBe(2); // Block align
      expect(wav.readUInt16LE(34)).toBe(16); // Bits per sample
      expect(wav.toString('ascii', 36, 40)).toBe('data');
      expect(wav.readUInt32LE(40)).toBe(1000);

      // Check PCM data is preserved
      expect(wav.subarray(44)).toEqual(pcmData);
    });

    it('handles empty PCM data', () => {
      const pcmData = Buffer.alloc(0);
      const wav = createWavChunk(pcmData, 44100);
      expect(wav.length).toBe(44);
      expect(wav.readUInt32LE(40)).toBe(0); // Data size = 0
    });

    it('preserves PCM data exactly', () => {
      // Create recognizable pattern
      const pcmData = Buffer.from([0x01, 0x02, 0x03, 0x04, 0xFE, 0xFF]);
      const wav = createWavChunk(pcmData, 8000);
      expect(wav.subarray(44)).toEqual(pcmData);
    });
  });

  // =========================================================================
  // getAudioDurationMs
  // =========================================================================
  describe('getAudioDurationMs', () => {
    it('returns ffprobe duration when available', async () => {
      // First call checks ffprobe availability
      mockExecFile
        .mockImplementationOnce((_cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null, result: { stdout: string; stderr: string }) => void) => {
          cb(null, { stdout: 'ffprobe version 6.0', stderr: '' });
        })
        // Second call is the actual ffprobe duration query
        .mockImplementationOnce((_cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null, result: { stdout: string; stderr: string }) => void) => {
          cb(null, { stdout: '123.456\n', stderr: '' });
        });

      const result = await getAudioDurationMs('/test/audio.mp3');
      expect(result.durationMs).toBe(123456);
      expect(result.source).toBe('ffprobe');
    });

    it('falls back to WAV header when ffprobe fails', async () => {
      // ffprobe not available
      mockExecFileError(new Error('not found'));

      // WAV header parsing via fs.open
      const sampleRate = 16000;
      const pcmDataSize = sampleRate * 2 * 10; // 10 seconds of 16-bit mono
      const wavBuf = createMinimalWavBuffer(pcmDataSize, sampleRate);
      const mockFd = {
        read: vi.fn().mockResolvedValue({ bytesRead: 44, buffer: wavBuf.subarray(0, 44) }),
        close: vi.fn().mockResolvedValue(undefined),
      };
      mockOpen.mockResolvedValueOnce(mockFd);

      // Override the read to copy data into the provided buffer
      mockFd.read.mockImplementation((buf: Buffer, _offset: number, length: number, _position: number) => {
        wavBuf.copy(buf, 0, 0, Math.min(length, wavBuf.length));
        return Promise.resolve({ bytesRead: Math.min(length, wavBuf.length), buffer: buf });
      });

      const result = await getAudioDurationMs('/test/audio.wav');
      expect(result.durationMs).toBe(10000);
      expect(result.source).toBe('wav-header');
    });

    it('falls back to bitrate estimation when both ffprobe and WAV header fail', async () => {
      // ffprobe not available
      mockExecFileError(new Error('not found'));

      // fs.open fails (not a WAV)
      mockOpen.mockRejectedValueOnce(new Error('ENOENT'));

      // stat for file size
      mockStat.mockResolvedValueOnce({ size: 40000 }); // 40KB

      const result = await getAudioDurationMs('/test/audio.mp3');
      // 40000 / 4000 = 10 seconds = 10000 ms
      expect(result.durationMs).toBe(10000);
      expect(result.source).toBe('bitrate-estimate');
    });
  });

  // =========================================================================
  // chunkAudioFile — WAV path
  // =========================================================================
  describe('chunkAudioFile — WAV splitting', () => {
    it('splits a WAV file into the correct number of chunks', async () => {
      const sampleRate = 16000;
      // Create 3 seconds of PCM data
      const pcmDataSize = sampleRate * 2 * 3;
      const wavBuf = createMinimalWavBuffer(pcmDataSize, sampleRate);

      mockReadFile.mockResolvedValueOnce(wavBuf);
      mockReaddir.mockResolvedValueOnce([]); // Not needed for WAV path

      const result = await chunkAudioFile('/test/recording.wav', {
        // Use a small target to force multiple chunks
        targetChunkSizeBytes: sampleRate * 2 + 44, // ~1 second of audio + header per chunk
        sampleRate,
      });

      // 3 seconds of data with ~1 second target → 3 chunks
      expect(result.chunkPaths.length).toBe(3);
      expect(result.chunkPaths[0]).toMatch(/chunk_000\.wav$/);
      expect(result.chunkPaths[1]).toMatch(/chunk_001\.wav$/);
      expect(result.chunkPaths[2]).toMatch(/chunk_002\.wav$/);

      // Verify each chunk was written
      expect(mockWriteFile).toHaveBeenCalledTimes(3);

      // Verify each written buffer is a valid WAV
      for (const call of mockWriteFile.mock.calls) {
        const writtenBuf = call[1] as Buffer;
        expect(writtenBuf.toString('ascii', 0, 4)).toBe('RIFF');
        expect(writtenBuf.toString('ascii', 8, 12)).toBe('WAVE');
      }

      // Cleanup should work
      await result.cleanup();
      expect(mockRm).toHaveBeenCalledTimes(1);
    });

    it('creates a single chunk for small WAV files', async () => {
      const sampleRate = 16000;
      const pcmDataSize = 1000; // Very small
      const wavBuf = createMinimalWavBuffer(pcmDataSize, sampleRate);

      mockReadFile.mockResolvedValueOnce(wavBuf);

      const result = await chunkAudioFile('/test/short.wav', { sampleRate });

      expect(result.chunkPaths.length).toBe(1);
      await result.cleanup();
    });

    it('parses sample rate from WAV header when not provided', async () => {
      const sampleRate = 44100;
      const pcmDataSize = sampleRate * 2; // 1 second
      const wavBuf = createMinimalWavBuffer(pcmDataSize, sampleRate);

      mockReadFile.mockResolvedValueOnce(wavBuf);

      const result = await chunkAudioFile('/test/recording.wav');

      // Should produce at least 1 chunk
      expect(result.chunkPaths.length).toBeGreaterThanOrEqual(1);
      await result.cleanup();
    });
  });

  // =========================================================================
  // chunkAudioFile — ffmpeg path
  // =========================================================================
  describe('chunkAudioFile — ffmpeg splitting', () => {
    it('throws when ffmpeg is not available', async () => {
      // ffmpeg not found
      mockExecFileError(new Error('not found'));

      await expect(chunkAudioFile('/test/recording.mp3')).rejects.toThrow(
        'ffmpeg is required for chunking non-WAV audio files'
      );
    });

    it('invokes ffmpeg with correct arguments and returns chunk paths', async () => {
      // ffmpeg availability check succeeds
      mockExecFile
        .mockImplementationOnce((_cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null, result: { stdout: string; stderr: string }) => void) => {
          cb(null, { stdout: 'ffmpeg version 6.0', stderr: '' });
        });

      // stat for file size
      mockStat.mockResolvedValueOnce({ size: 30 * 1024 * 1024 }); // 30MB

      // Mock spawn for the ffmpeg segmenting process
      // Capture close handler and fire it after setup
      let closeHandler: ((code: number) => void) | null = null;
      const mockStderr = { on: vi.fn() };
      const mockFfmpegProcess = {
        stderr: mockStderr,
        on: vi.fn((event: string, handler: (code: number) => void) => {
          if (event === 'close') closeHandler = handler;
        }),
      };
      mockSpawn.mockReturnValueOnce(mockFfmpegProcess);

      // Start chunkAudioFile — it will block on the ffmpeg spawn Promise
      const resultPromise = chunkAudioFile('/test/recording.mp3', { durationMs: 600_000 });

      // Allow microtasks to run so the spawn/on calls are made
      await vi.waitFor(() => {
        expect(closeHandler).not.toBeNull();
      });

      // Use direct override to bypass any mockReaddir state issues
      _readdirOverride = () => Promise.resolve(['chunk_000.mp3', 'chunk_001.mp3']);

      // Now simulate ffmpeg completing successfully
      closeHandler!(0);

      const result = await resultPromise;

      expect(result.chunkPaths.length).toBe(2);
      expect(result.chunkPaths[0]).toMatch(/chunk_000\.mp3$/);
      expect(result.chunkPaths[1]).toMatch(/chunk_001\.mp3$/);

      // Verify spawn was called with windowsHide
      expect(mockSpawn).toHaveBeenCalledWith(
        'ffmpeg',
        expect.arrayContaining(['-f', 'segment', '-c', 'copy']),
        { windowsHide: true }
      );

      await result.cleanup();
      expect(mockRm).toHaveBeenCalled();
    });

    it('cleans up temp dir when ffmpeg fails', async () => {
      // ffmpeg availability check succeeds
      mockExecFile
        .mockImplementationOnce((_cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null, result: { stdout: string; stderr: string }) => void) => {
          cb(null, { stdout: 'ffmpeg version 6.0', stderr: '' });
        });

      // stat
      mockStat.mockResolvedValueOnce({ size: 30 * 1024 * 1024 });

      // Mock spawn that fails — capture close handler
      let closeHandler: ((code: number) => void) | null = null;
      const mockStderr = { on: vi.fn() };
      const mockFfmpegProcess = {
        stderr: mockStderr,
        on: vi.fn((event: string, handler: (code: number) => void) => {
          if (event === 'close') closeHandler = handler;
        }),
      };
      mockSpawn.mockReturnValueOnce(mockFfmpegProcess);

      const resultPromise = chunkAudioFile('/test/recording.mp3', { durationMs: 300_000 });

      // Wait for spawn to be called and handler registered
      await vi.waitFor(() => {
        expect(closeHandler).not.toBeNull();
      });

      // Simulate ffmpeg failing
      closeHandler!(1);

      await expect(resultPromise).rejects.toThrow('ffmpeg failed with exit code 1');

      // Temp dir should be cleaned up on error
      expect(mockRm).toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Constants
  // =========================================================================
  describe('constants', () => {
    it('exports expected size limits', () => {
      expect(MAX_FILE_SIZE_BYTES).toBe(20 * 1024 * 1024);
      expect(TARGET_CHUNK_SIZE_BYTES).toBe(18 * 1024 * 1024);
      expect(ELEVENLABS_MAX_FILE_SIZE_BYTES).toBe(1024 * 1024 * 1024);
    });
  });
});
