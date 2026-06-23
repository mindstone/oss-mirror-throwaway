/**
 * Audio format conversion utilities for local STT.
 *
 * Local STT models (Parakeet, Moonshine) require WAV format input, but browsers
 * output WebM from MediaRecorder. This module provides conversion using Web Audio API.
 *
 * Note: Cloud providers (OpenAI/ElevenLabs) accept WebM directly, so this
 * conversion is only used for local STT providers.
 */

import { isLocalProvider } from '@shared/utils/voiceProviderUtils';

/**
 * Result of audio conversion
 */
export interface ConvertedAudio {
  buffer: ArrayBuffer;
  mimeType: 'audio/wav';
}

/**
 * Convert an audio blob to WAV format using Web Audio API.
 *
 * Uses AudioContext.decodeAudioData() which handles WebM, OGG, MP3, etc.
 * Output is 16-bit PCM WAV at the specified sample rate (default 16kHz for STT).
 *
 * @param blob - Audio blob from MediaRecorder
 * @param targetSampleRate - Target sample rate (default 16000 for Parakeet)
 * @returns Converted audio as ArrayBuffer with WAV mimeType
 * @throws Error if decoding fails
 */
export async function convertBlobToWav(
  blob: Blob,
  targetSampleRate: number = 16000
): Promise<ConvertedAudio> {
  // Read blob as ArrayBuffer
  const arrayBuffer = await blob.arrayBuffer();

  // Create AudioContext for decoding
  // Note: We use AudioContext (not OfflineAudioContext) because OfflineAudioContext
  // requires knowing the duration upfront. The AudioContext is closed after use.
  const audioContext = new AudioContext();

  try {
    // Decode the audio (handles WebM, OGG, MP3, WAV, etc.)
    const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);

    // Mix to mono if stereo
    const monoData = mixToMono(audioBuffer);

    // Resample to target sample rate
    const resampledData = resample(monoData, audioBuffer.sampleRate, targetSampleRate);

    // Encode as 16-bit PCM WAV
    const wavBuffer = encodeWav(resampledData, targetSampleRate);

    return {
      buffer: wavBuffer,
      mimeType: 'audio/wav',
    };
  } finally {
    // Clean up AudioContext
    await audioContext.close();
  }
}

/**
 * Mix multi-channel audio to mono by averaging channels.
 */
function mixToMono(audioBuffer: AudioBuffer): Float32Array {
  if (audioBuffer.numberOfChannels === 1) {
    return audioBuffer.getChannelData(0);
  }

  const length = audioBuffer.length;
  const mono = new Float32Array(length);
  const numChannels = audioBuffer.numberOfChannels;

  // Sum all channels
  for (let ch = 0; ch < numChannels; ch++) {
    const channelData = audioBuffer.getChannelData(ch);
    for (let i = 0; i < length; i++) {
      mono[i] += channelData[i];
    }
  }

  // Average
  for (let i = 0; i < length; i++) {
    mono[i] /= numChannels;
  }

  return mono;
}

/**
 * Resample audio using linear interpolation.
 * For STT, this is sufficient quality. Higher quality methods (sinc, polyphase)
 * would add complexity without noticeable benefit for speech recognition.
 */
function resample(
  samples: Float32Array,
  fromRate: number,
  toRate: number
): Float32Array {
  if (fromRate === toRate) {
    return samples;
  }

  const ratio = fromRate / toRate;
  const newLength = Math.round(samples.length / ratio);
  const result = new Float32Array(newLength);

  for (let i = 0; i < newLength; i++) {
    const srcIndex = i * ratio;
    const srcIndexFloor = Math.floor(srcIndex);
    const srcIndexCeil = Math.min(srcIndexFloor + 1, samples.length - 1);
    const t = srcIndex - srcIndexFloor;

    // Linear interpolation
    result[i] = samples[srcIndexFloor] * (1 - t) + samples[srcIndexCeil] * t;
  }

  return result;
}

/**
 * Encode Float32 samples as 16-bit PCM WAV.
 */
function encodeWav(samples: Float32Array, sampleRate: number): ArrayBuffer {
  const numChannels = 1;
  const bitsPerSample = 16;
  const bytesPerSample = bitsPerSample / 8;
  const blockAlign = numChannels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = samples.length * bytesPerSample;
  const headerSize = 44;
  const totalSize = headerSize + dataSize;

  const buffer = new ArrayBuffer(totalSize);
  const view = new DataView(buffer);

  // RIFF header
  writeString(view, 0, 'RIFF');
  view.setUint32(4, totalSize - 8, true); // file size - 8
  writeString(view, 8, 'WAVE');

  // fmt chunk
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true); // chunk size
  view.setUint16(20, 1, true); // PCM format
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);

  // data chunk
  writeString(view, 36, 'data');
  view.setUint32(40, dataSize, true);

  // Write samples as 16-bit PCM
  let offset = headerSize;
  for (let i = 0; i < samples.length; i++) {
    // Clamp to [-1, 1] and convert to 16-bit signed integer
    const sample = Math.max(-1, Math.min(1, samples[i]));
    const int16 = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
    view.setInt16(offset, int16, true);
    offset += 2;
  }

  return buffer;
}

/**
 * Write ASCII string to DataView.
 */
function writeString(view: DataView, offset: number, str: string): void {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}

/**
 * Check if conversion is needed for the given provider and mimeType.
 * Conversion is needed for any local STT provider with WebM input,
 * since local models require WAV format.
 */
export function needsConversionForLocalStt(
  provider: string,
  mimeType: string
): boolean {
  return isLocalProvider(provider) && mimeType.includes('webm');
}
