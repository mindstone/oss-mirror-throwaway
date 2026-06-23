import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { needsConversionForLocalStt } from '../audioConversion';

// Mock AudioContext for convertBlobToWav tests
const mockClose = vi.fn().mockResolvedValue(undefined);
const mockDecodeAudioData = vi.fn();

class MockAudioBuffer {
  numberOfChannels = 1;
  length = 16000; // 1 second at 16kHz
  sampleRate = 16000;
  private data = new Float32Array(16000).fill(0.5);

  getChannelData(_channel: number): Float32Array {
    return this.data;
  }
}

class MockAudioContext {
  close = mockClose;
  decodeAudioData = mockDecodeAudioData;
}

describe('audioConversion', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // @ts-expect-error - mocking global AudioContext
    global.AudioContext = MockAudioContext;
    mockDecodeAudioData.mockResolvedValue(new MockAudioBuffer());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('needsConversionForLocalStt', () => {
    it('returns true for local-parakeet with webm mimeType', () => {
      expect(needsConversionForLocalStt('local-parakeet', 'audio/webm')).toBe(true);
      expect(needsConversionForLocalStt('local-parakeet', 'audio/webm;codecs=opus')).toBe(true);
    });

    it('returns false for local-parakeet with non-webm mimeType', () => {
      expect(needsConversionForLocalStt('local-parakeet', 'audio/wav')).toBe(false);
      expect(needsConversionForLocalStt('local-parakeet', 'audio/ogg')).toBe(false);
      expect(needsConversionForLocalStt('local-parakeet', 'audio/mp3')).toBe(false);
    });

    it('returns false for cloud providers regardless of mimeType', () => {
      expect(needsConversionForLocalStt('openai-whisper', 'audio/webm')).toBe(false);
      expect(needsConversionForLocalStt('elevenlabs-scribe', 'audio/webm')).toBe(false);
    });

    it('returns true for local-moonshine with webm mimeType', () => {
      expect(needsConversionForLocalStt('local-moonshine', 'audio/webm')).toBe(true);
      expect(needsConversionForLocalStt('local-moonshine', 'audio/webm;codecs=opus')).toBe(true);
    });

    it('returns false for local-moonshine with non-webm mimeType', () => {
      expect(needsConversionForLocalStt('local-moonshine', 'audio/wav')).toBe(false);
      expect(needsConversionForLocalStt('local-moonshine', 'audio/ogg')).toBe(false);
    });

    it('returns false for unknown provider with webm', () => {
      expect(needsConversionForLocalStt('unknown-provider', 'audio/webm')).toBe(false);
    });
  });

  describe('convertBlobToWav', () => {
    it('produces valid WAV header', async () => {
      // Dynamically import to get fresh module with mocked AudioContext
      const { convertBlobToWav } = await import('../audioConversion');
      
      const mockBlob = new Blob([new ArrayBuffer(1000)], { type: 'audio/webm' });
      const result = await convertBlobToWav(mockBlob);

      expect(result.mimeType).toBe('audio/wav');
      
      // Check WAV header
      const view = new DataView(result.buffer);
      // RIFF header
      expect(String.fromCharCode(view.getUint8(0))).toBe('R');
      expect(String.fromCharCode(view.getUint8(1))).toBe('I');
      expect(String.fromCharCode(view.getUint8(2))).toBe('F');
      expect(String.fromCharCode(view.getUint8(3))).toBe('F');
      // WAVE format
      expect(String.fromCharCode(view.getUint8(8))).toBe('W');
      expect(String.fromCharCode(view.getUint8(9))).toBe('A');
      expect(String.fromCharCode(view.getUint8(10))).toBe('V');
      expect(String.fromCharCode(view.getUint8(11))).toBe('E');
    });

    it('closes AudioContext after conversion', async () => {
      const { convertBlobToWav } = await import('../audioConversion');
      
      const mockBlob = new Blob([new ArrayBuffer(1000)], { type: 'audio/webm' });
      await convertBlobToWav(mockBlob);

      expect(mockClose).toHaveBeenCalledOnce();
    });

    it('closes AudioContext even if decoding fails', async () => {
      mockDecodeAudioData.mockRejectedValueOnce(new Error('Decode failed'));
      
      const { convertBlobToWav } = await import('../audioConversion');
      
      const mockBlob = new Blob([new ArrayBuffer(1000)], { type: 'audio/webm' });
      
      await expect(convertBlobToWav(mockBlob)).rejects.toThrow('Decode failed');
      expect(mockClose).toHaveBeenCalledOnce();
    });

    it('uses correct target sample rate (16kHz for Parakeet)', async () => {
      const { convertBlobToWav } = await import('../audioConversion');
      
      const mockBlob = new Blob([new ArrayBuffer(1000)], { type: 'audio/webm' });
      const result = await convertBlobToWav(mockBlob);

      // Check sample rate in WAV header (bytes 24-27, little-endian)
      const view = new DataView(result.buffer);
      const sampleRate = view.getUint32(24, true);
      expect(sampleRate).toBe(16000);
    });

    it('outputs mono audio (1 channel)', async () => {
      const { convertBlobToWav } = await import('../audioConversion');
      
      const mockBlob = new Blob([new ArrayBuffer(1000)], { type: 'audio/webm' });
      const result = await convertBlobToWav(mockBlob);

      // Check channel count in WAV header (bytes 22-23, little-endian)
      const view = new DataView(result.buffer);
      const numChannels = view.getUint16(22, true);
      expect(numChannels).toBe(1);
    });

    it('outputs 16-bit PCM', async () => {
      const { convertBlobToWav } = await import('../audioConversion');
      
      const mockBlob = new Blob([new ArrayBuffer(1000)], { type: 'audio/webm' });
      const result = await convertBlobToWav(mockBlob);

      // Check bits per sample in WAV header (bytes 34-35, little-endian)
      const view = new DataView(result.buffer);
      const bitsPerSample = view.getUint16(34, true);
      expect(bitsPerSample).toBe(16);
    });
  });

  describe('stereo to mono mixing', () => {
    it('averages stereo channels correctly', async () => {
      // Create stereo audio buffer
      class StereoMockAudioBuffer {
        numberOfChannels = 2;
        length = 4;
        sampleRate = 16000;
        private channel0 = new Float32Array([0.2, 0.4, 0.6, 0.8]);
        private channel1 = new Float32Array([0.8, 0.6, 0.4, 0.2]);

        getChannelData(channel: number): Float32Array {
          return channel === 0 ? this.channel0 : this.channel1;
        }
      }

      mockDecodeAudioData.mockResolvedValueOnce(new StereoMockAudioBuffer());
      
      const { convertBlobToWav } = await import('../audioConversion');
      
      const mockBlob = new Blob([new ArrayBuffer(1000)], { type: 'audio/webm' });
      const result = await convertBlobToWav(mockBlob);

      // The mixed mono samples should be (0.2+0.8)/2=0.5 for all samples
      // Convert to 16-bit: 0.5 * 32767 ≈ 16383
      // WAV data starts at offset 44
      const view = new DataView(result.buffer);
      const sample0 = view.getInt16(44, true);
      // Allow some tolerance for floating point
      expect(sample0).toBeGreaterThan(16000);
      expect(sample0).toBeLessThan(17000);
    });
  });

  describe('resampling', () => {
    it('resamples from 48kHz to 16kHz', async () => {
      // Create 48kHz audio buffer (3x 16kHz)
      class HighSampleRateMockAudioBuffer {
        numberOfChannels = 1;
        length = 48000; // 1 second at 48kHz
        sampleRate = 48000;
        private data = new Float32Array(48000).fill(0.5);

        getChannelData(_channel: number): Float32Array {
          return this.data;
        }
      }

      mockDecodeAudioData.mockResolvedValueOnce(new HighSampleRateMockAudioBuffer());
      
      const { convertBlobToWav } = await import('../audioConversion');
      
      const mockBlob = new Blob([new ArrayBuffer(1000)], { type: 'audio/webm' });
      const result = await convertBlobToWav(mockBlob);

      // Expected output: 16000 samples (1 second at 16kHz)
      // WAV header is 44 bytes, each sample is 2 bytes (16-bit)
      // Total size should be 44 + 16000 * 2 = 44 + 32000 = 32044 bytes
      expect(result.buffer.byteLength).toBe(32044);
    });
  });
});
