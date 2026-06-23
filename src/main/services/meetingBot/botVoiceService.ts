/**
 * Meeting Bot Voice Service
 * 
 * Generates TTS audio for the meeting bot and sends it to the avatar via relay.
 * Reuses the existing TTS infrastructure (same voice provider as desktop Rebel).
 */

import { createScopedLogger } from '@core/logger';
import { getSettings } from '@core/services/settingsStore';
import { textToSpeechStream } from '../audioService';
import { getRelayClient } from './relayClient';
import { setBotSpeakingState, shouldAbortSpeaking } from './botSpeakingStateRegistry';
import { isLocalProvider } from '@shared/utils/voiceProviderUtils';

const log = createScopedLogger({ service: 'bot-voice' });

// For now, we'll use data URLs for small audio clips
// TODO: For larger audio, upload to R2 and use signed URLs
const MAX_DATA_URL_SIZE = 1024 * 1024; // 1MB limit for data URLs (~60s of speech)

// Maximum text length per TTS chunk (to avoid hitting data URL size limits)
// ~400 chars ≈ 20-25 seconds of speech ≈ 400-500KB audio
const MAX_TTS_CHUNK_LENGTH = 400;

/**
 * Split text into chunks at sentence boundaries for sequential TTS playback
 * Each chunk is ≤ MAX_TTS_CHUNK_LENGTH chars
 */
function splitTextIntoChunks(text: string): string[] {
  if (text.length <= MAX_TTS_CHUNK_LENGTH) return [text];
  
  const chunks: string[] = [];
  let remaining = text;
  
  while (remaining.length > 0) {
    if (remaining.length <= MAX_TTS_CHUNK_LENGTH) {
      chunks.push(remaining.trim());
      break;
    }
    
    // Try to break at sentence boundary within the limit
    const slice = remaining.slice(0, MAX_TTS_CHUNK_LENGTH);
    const lastSentenceEnd = Math.max(
      slice.lastIndexOf('. '),
      slice.lastIndexOf('! '),
      slice.lastIndexOf('? ')
    );
    
    if (lastSentenceEnd > MAX_TTS_CHUNK_LENGTH * 0.5) {
      // Found a good sentence break point
      chunks.push(remaining.slice(0, lastSentenceEnd + 1).trim());
      remaining = remaining.slice(lastSentenceEnd + 1).trim();
    } else {
      // Fall back to word boundary
      const lastSpace = slice.lastIndexOf(' ');
      if (lastSpace > MAX_TTS_CHUNK_LENGTH * 0.7) {
        chunks.push(remaining.slice(0, lastSpace).trim());
        remaining = remaining.slice(lastSpace).trim();
      } else {
        // No good break point, just cut at limit
        chunks.push(slice.trim());
        remaining = remaining.slice(MAX_TTS_CHUNK_LENGTH).trim();
      }
    }
  }
  
  return chunks.filter(c => c.length > 0);
}

/**
 * Convert a readable stream to a buffer
 */
async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/**
 * Generate TTS and send to avatar in meeting
 * 
 * @param botId - The bot to speak through
 * @param text - Text to speak
 * @param status - Optional status text to display while speaking
 * @param options - Options: skipThinkingState, keepAnimation
 * @returns true if audio was sent successfully
 */
export async function speakInMeeting(
  botId: string,
  text: string,
  status?: string,
  options?: { skipThinkingState?: boolean; keepAnimation?: boolean }
): Promise<boolean> {
  const { skipThinkingState = false, keepAnimation = false } = options || {};
  
  // Split long text into chunks for sequential playback
  const chunks = splitTextIntoChunks(text);
  const isMultiChunk = chunks.length > 1;
  
  if (isMultiChunk) {
    log.info({ botId, originalLength: text.length, chunkCount: chunks.length }, 'Split long text into chunks for TTS');
  }
  
  log.info({ botId, textLength: text.length, chunkCount: chunks.length, textPreview: text.slice(0, 50) }, '===== speakInMeeting START =====');
  
  const client = getRelayClient(botId);
  if (!client?.connected) {
    log.warn({ botId, hasClient: !!client, connected: client?.connected }, 'Cannot speak - relay not connected');
    return false;
  }
  log.info({ botId }, 'Relay client connected, proceeding');

  const settings = getSettings();
  log.info({ botId, provider: settings.voice.provider, voice: settings.voice.ttsVoice }, 'Voice settings');
  
  // Check if TTS is available
  if (isLocalProvider(settings.voice.provider)) {
    log.warn({ botId, provider: settings.voice.provider }, 'TTS not available for local provider');
    return false;
  }

  try {
    // Set avatar to thinking state while generating first chunk (unless skipped for announcements)
    if (!skipThinkingState) {
      log.info({ botId }, 'Setting avatar to thinking state');
      client.setState('thinking', status || 'Preparing response...');
    }

    // Set speaking state before first chunk
    setBotSpeakingState(botId, true);

    // Helper to generate TTS for a single chunk and convert to data URL
    const generateChunkAudio = async (chunk: string, chunkIndex: number): Promise<{ dataUrl: string; index: number } | null> => {
      const audioStream = await textToSpeechStream(chunk, settings);
      if (!audioStream) {
        log.error({ botId, chunkIndex }, 'TTS returned null stream for chunk');
        return null;
      }

      const audioBuffer = await streamToBuffer(audioStream);
      
      log.info({ 
        botId, 
        chunkIndex,
        audioSizeBytes: audioBuffer.length,
        audioSizeKb: Math.round(audioBuffer.length / 1024),
        textLength: chunk.length,
      }, 'TTS chunk audio generated');

      if (audioBuffer.length > MAX_DATA_URL_SIZE) {
        log.warn({ botId, chunkIndex, audioSize: audioBuffer.length, maxSize: MAX_DATA_URL_SIZE }, 'Chunk audio too large, skipping');
        return null;
      }

      const base64Audio = audioBuffer.toString('base64');
      const dataUrl = `data:audio/mpeg;base64,${base64Audio}`;
      return { dataUrl, index: chunkIndex };
    };

    // HYBRID APPROACH: Generate chunk 1 immediately, then prefetch remaining chunks in parallel
    // This gives us: fast first-byte latency + no gaps between subsequent chunks
    
    if (chunks.length === 1) {
      // Single chunk - simple path
      if (shouldAbortSpeaking(botId)) {
        log.info({ botId }, 'Speaking aborted before generation');
        setBotSpeakingState(botId, false);
        client.setState('idle', 'Taking notes...');
        return false;
      }

      log.info({ botId, chunkIndex: 1, chunkCount: 1, chunkLength: chunks[0].length }, 'Processing TTS chunk');
      const result = await generateChunkAudio(chunks[0], 1);
      
      if (!result) {
        client.setState('idle');
        setBotSpeakingState(botId, false);
        return false;
      }

      // Check abort after generation, before playback
      if (shouldAbortSpeaking(botId)) {
        log.info({ botId }, 'Speaking aborted after generation');
        setBotSpeakingState(botId, false);
        client.setState('idle', 'Taking notes...');
        return false;
      }

      log.info({ 
        botId, 
        chunkIndex: 1,
        dataUrlSizeKb: Math.round(result.dataUrl.length / 1024), 
        keepAnimation, 
      }, 'Sending TTS chunk to avatar');

      // Always wait for audio to complete to keep speaking state accurate
      await client.playAudioAndWait(result.dataUrl, status || 'Speaking...', keepAnimation, chunks[0]);
    } else {
      // Multi-chunk: Generate chunk 1 first, start playback, then generate rest in parallel
      const generationStartTime = Date.now();
      
      // Check abort before starting
      if (shouldAbortSpeaking(botId)) {
        log.info({ botId }, 'Speaking aborted before generation');
        setBotSpeakingState(botId, false);
        client.setState('idle', 'Taking notes...');
        return false;
      }

      // Generate first chunk
      log.info({ botId, chunkIndex: 1, chunkCount: chunks.length, chunkLength: chunks[0].length }, 'Processing TTS chunk');
      const firstChunkResult = await generateChunkAudio(chunks[0], 1);
      
      if (!firstChunkResult) {
        client.setState('idle');
        setBotSpeakingState(botId, false);
        return false;
      }

      // Check abort after first chunk generation
      if (shouldAbortSpeaking(botId)) {
        log.info({ botId }, 'Speaking aborted after first chunk generation');
        setBotSpeakingState(botId, false);
        client.setState('idle', 'Taking notes...');
        return false;
      }

      // Start generating remaining chunks in parallel while we begin playback
      // Use Promise.allSettled for graceful partial failure handling
      const remainingChunksPromise = Promise.allSettled(
        chunks.slice(1).map((chunk, i) => generateChunkAudio(chunk, i + 2))
      );

      // Start playing first chunk immediately (don't wait for others)
      log.info({ 
        botId, 
        chunkIndex: 1,
        dataUrlSizeKb: Math.round(firstChunkResult.dataUrl.length / 1024), 
        keepAnimation, 
      }, 'Sending TTS chunk to avatar');
      
      // Wait for first chunk to finish playing
      await client.playAudioAndWait(firstChunkResult.dataUrl, status || 'Speaking...', keepAnimation, chunks[0]);

      // Now wait for remaining chunks to be ready
      const remainingResults = await remainingChunksPromise;
      
      const totalGenerationMs = Date.now() - generationStartTime;
      log.info({ botId, chunkCount: chunks.length, totalGenerationMs }, 'All TTS chunks generated (hybrid approach)');

      // Check abort after all generation complete
      if (shouldAbortSpeaking(botId)) {
        log.info({ botId, nextChunkIndex: 2 }, 'Speaking aborted after parallel generation, before chunk 2');
        setBotSpeakingState(botId, false);
        client.setState('idle', 'Taking notes...');
        return false;
      }

      // Play remaining chunks sequentially (they're already generated - no gaps!)
      let playbackCompleted = true;
      for (let i = 0; i < remainingResults.length; i++) {
        const chunkIndex = i + 2;
        
        // Check abort before each chunk playback
        if (shouldAbortSpeaking(botId)) {
          log.info({ botId, chunkIndex }, 'Speaking aborted during playback');
          playbackCompleted = false;
          break;
        }

        const result = remainingResults[i];

        if (result.status === 'rejected' || !result.value) {
          log.warn({ botId, chunkIndex, reason: result.status === 'rejected' ? result.reason : 'null result' }, 'Chunk generation failed, stopping playback');
          playbackCompleted = false;
          break; // Stop at first failure to maintain speech coherence
        }

        const { dataUrl } = result.value;
        // Always wait for all chunks to ensure speaking state stays accurate until audio finishes
        const shouldWait = true;
        // Each chunk needs keepAnimation=false (for normal speech) so audio.onplay
        // triggers speaking state on the avatar. For announcements where the caller
        // passes keepAnimation=true, all chunks honor that.
        const chunkKeepAnimation = keepAnimation;

        log.info({ 
          botId, 
          chunkIndex,
          dataUrlSizeKb: Math.round(dataUrl.length / 1024), 
          keepAnimation: chunkKeepAnimation, 
        }, 'Sending TTS chunk to avatar');

        if (shouldWait) {
          await client.playAudioAndWait(dataUrl, status || 'Speaking...', chunkKeepAnimation, chunks[i + 1]);
        } else {
          client.playAudio(dataUrl, status || 'Speaking...', chunkKeepAnimation, chunks[i + 1]);
        }
      }
      
      log.info({ botId, chunkCount: chunks.length, playbackCompleted }, '===== speakInMeeting COMPLETE =====');
      setBotSpeakingState(botId, false);
      // Bug 10 fix: Reset avatar to idle after speaking completes
      client.setState('idle', 'Taking notes...');
      return playbackCompleted;
    }
    
    log.info({ botId, chunkCount: chunks.length }, '===== speakInMeeting COMPLETE =====');
    // Clear speaking state on completion
    setBotSpeakingState(botId, false);
    // Bug 10 fix: Reset avatar to idle after speaking completes
    client.setState('idle', 'Taking notes...');
    return true;
  } catch (error) {
    log.error({ botId, error }, 'Failed to generate TTS for meeting bot');
    setBotSpeakingState(botId, false);
    client.setState('idle');
    return false;
  }
}

/**
 * Set the avatar state
 */
export function setAvatarState(
  botId: string,
  state: string,
  status?: string
): boolean {
  const client = getRelayClient(botId);
  if (!client?.connected) {
    return false;
  }

  client.setState(state, status);
  return true;
}

/**
 * Trigger goodbye animation on avatar
 */
export function goodbyeInMeeting(botId: string): boolean {
  log.info({ botId }, 'goodbyeInMeeting called');
  const client = getRelayClient(botId);
  if (!client?.connected) {
    log.warn({ botId, hasClient: !!client, connected: client?.connected }, 'Cannot trigger goodbye - relay not connected');
    return false;
  }

  log.info({ botId }, 'Sending goodbye animation');
  client.goodbye();
  return true;
}

/**
 * Trigger wave animation on avatar (for join)
 */
export function waveInMeeting(botId: string): boolean {
  log.info({ botId }, 'waveInMeeting called');
  const client = getRelayClient(botId);
  if (!client?.connected) {
    log.warn({ botId, hasClient: !!client, connected: client?.connected }, 'Cannot trigger wave - relay not connected');
    return false;
  }

  log.info({ botId }, 'Sending wave animation');
  client.wave();
  return true;
}

/**
 * Stop audio playback immediately (interrupt)
 * Returns true if stop command was sent successfully
 */
export function stopSpeaking(botId: string): boolean {
  log.info({ botId }, 'stopSpeaking called');
  const client = getRelayClient(botId);
  if (!client?.connected) {
    log.warn({ botId, hasClient: !!client, connected: client?.connected }, 'Cannot stop speaking - relay not connected');
    return false;
  }

  log.info({ botId }, 'Sending stop_audio to avatar');
  client.stopAudio();
  return true;
}

// =============================================================================
// Meeting Announcements (Dynamic TTS)
// =============================================================================

/**
 * Announcement messages - computed on the fly with TTS
 */
const ANNOUNCEMENTS = {
  join: (name: string) => `Taking notes for ${name}. Pretend I'm not here.`,
  leave: () => `That's a wrap. Notes will be ready shortly.`,
};

/**
 * Speak the join announcement when bot joins meeting
 * Call this after avatar is connected and ready
 */
export async function announceJoin(botId: string, ownerName: string): Promise<boolean> {
  log.info({ botId, ownerName }, '===== announceJoin CALLED =====');
  
  // Wave animation first
  waveInMeeting(botId);
  
  const text = ANNOUNCEMENTS.join(ownerName);
  log.info({ botId, text }, 'Join announcement text generated');
  // Skip thinking state and keep wave animation while speaking
  const result = await speakInMeeting(botId, text, 'Joining...', { 
    skipThinkingState: true, 
    keepAnimation: true 
  });
  log.info({ botId, result }, '===== announceJoin COMPLETE =====');
  return result;
}

/**
 * Speak the leave/goodbye announcement and wait for it to finish
 * Returns a promise that resolves when audio playback completes
 * This ensures we don't leave the meeting before finishing the announcement
 */
export async function announceLeaveAndWait(botId: string): Promise<boolean> {
  const client = getRelayClient(botId);
  if (!client?.connected) {
    log.warn({ botId }, 'Cannot announce leave - relay not connected');
    return false;
  }

  // Trigger goodbye animation
  goodbyeInMeeting(botId);

  const settings = getSettings();
  
  // Check if TTS is available
  if (isLocalProvider(settings.voice.provider)) {
    log.warn({ botId, provider: settings.voice.provider }, 'TTS not available for local provider');
    return false;
  }

  const text = ANNOUNCEMENTS.leave();
  log.info({ botId }, 'Speaking leave announcement (will wait for completion)');

  try {
    // Generate TTS audio
    const audioStream = await textToSpeechStream(text, settings);
    if (!audioStream) {
      log.error({ botId }, 'TTS returned null stream for leave announcement');
      return false;
    }

    const audioBuffer = await streamToBuffer(audioStream);
    
    if (audioBuffer.length > MAX_DATA_URL_SIZE) {
      log.warn({ botId, audioSize: audioBuffer.length }, 'Leave audio too large, skipping');
      return false;
    }

    const dataUrl = `data:audio/mpeg;base64,${audioBuffer.toString('base64')}`;

    // Play and WAIT for it to finish before returning
    // keepAnimation: true so goodbye animation plays while speaking
    await client.playAudioAndWait(dataUrl, 'Wrapping up...', true, text);
    
    log.info({ botId }, 'Leave announcement completed');
    return true;
  } catch (error) {
    log.error({ botId, error }, 'Failed to announce leave');
    return false;
  }
}


