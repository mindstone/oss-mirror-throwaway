/**
 * Enhancement Service - Background Contextual Retrieval
 * 
 * Processes indexed chunks in the background to add contextual embeddings.
 * Part of two-phase indexing: basic indexing happens immediately,
 * then this service enhances search quality over time using Haiku.
 */

import { onElectronAppEvent } from '@core/lazyElectron';
import { createScopedLogger } from '@core/logger';
import { getSettings } from '@core/services/settingsStore';
import {
  getUnenhancedChunks,
  getChunkCounts,
  updateChunkEmbedding,
  updateEnhancementState,
  type FileEmbeddingRecord
} from './fileIndexService';
import { generateEmbedding } from './embeddingService';
import { callWithModelAuthAware } from './behindTheScenesClient';
import { hasValidAuth } from '../utils/authEnvUtils';
import { calculateCostOrWarn } from '@shared/utils/pricingCalculator';
import type { AppSettings } from '@shared/types';
import {
  normalizeStoredBtsModelValue,
  rejectionReasonLabel,
} from '@shared/utils/modelChoiceCodec';
import { appendCostEntry } from './costLedgerService';
import { fireAndForget } from '@shared/utils/fireAndForget';

const logger = createScopedLogger({ service: 'enhancementService' });

/** @internal Exported for testing — resolves the BTS model for the enhancement queue,
 *  decoding the codec's storage prefix. Returns `undefined` when no model is configured. */
export function resolveEnhancementModel(
  settings: Pick<AppSettings, 'behindTheScenesModel'>,
): string | undefined {
  const raw = settings.behindTheScenesModel;
  const normalized = normalizeStoredBtsModelValue(raw);
  if (normalized.ok) {
    if (normalized.kind === 'profile') return `profile:${normalized.profileId}`;
    return normalized.modelId;
  }
  if (typeof raw === 'string' && raw.length > 0) {
    logger.warn({
      siteId: 'enhancementService:resolveEnhancementModel',
      rawTruncated: raw.slice(0, 32),
      rejectionReason: normalized.reason,
    }, `[resolveEnhancementModel] BTS read rejected by normalizer: ${rejectionReasonLabel(normalized.reason)}; returning undefined`);
  } else if (raw != null && typeof raw !== 'string') {
    logger.warn({
      siteId: 'enhancementService:resolveEnhancementModel',
      rawType: typeof raw,
      rejectionReason: normalized.reason,
    }, `[resolveEnhancementModel] BTS read rejected non-string input by normalizer: ${rejectionReasonLabel(normalized.reason)}; returning undefined`);
  }
  return undefined;
}

// Configuration
const BATCH_SIZE = 10;
const RATE_LIMIT_MS = 100;  // 100ms between API requests (~10 req/sec conservative)
const INTER_CHUNK_DELAY_MS = 500;  // 500ms between chunks to reduce system strain
const MAX_RETRIES = 3;
const BACKOFF_BASE_MS = 1000;
const CONTEXT_MAX_TOKENS = 100;
const PROGRESS_UPDATE_INTERVAL = 10;  // Update counts every N chunks

// State
let abortController: AbortController | null = null;
let isRunning = false;
let isPaused = false;
let processedCount = 0;
let lastProgressUpdate = 0;

// Rate limiting state
let lastRequestTime = 0;
let currentBackoffMs = 0;

// Cost batching state
// Accumulates costs in memory to avoid ledger bloat (high-volume service: ~10 req/sec)
let pendingCost = 0;
let pendingCount = 0;
let pendingModel: string | null = null;
let pendingAuthMethod: string | null = null;
let lastFlushTime = Date.now();
const COST_BATCH_SIZE = 50; // Flush after this many chunks
const COST_FLUSH_INTERVAL_MS = 30000; // Flush every 30 seconds

/**
 * Accumulate cost for a successful LLM call.
 * Flushes to ledger when batch size reached or interval elapsed.
 */
function accumulateCost(cost: number, model: string, authMethod: string): void {
  pendingCost += cost;
  pendingCount++;
  pendingModel = model; // Track last model used
  pendingAuthMethod = authMethod;
  
  // Flush if batch size reached or interval elapsed
  if (pendingCount >= COST_BATCH_SIZE || Date.now() - lastFlushTime >= COST_FLUSH_INTERVAL_MS) {
    flushPendingCosts();
  }
}

/**
 * Flush accumulated costs to the ledger as a single entry.
 * Called on batch size limit, timer, service stop, or app quit.
 */
export function flushPendingCosts(): void {
  if (pendingCost > 0 && pendingCount > 0) {
    appendCostEntry({
      ts: Date.now(),
      cost: pendingCost,
      cat: 'enhancement',
      m: pendingModel ?? undefined,
      auth: pendingAuthMethod ?? undefined,
      outcome: { kind: 'auxiliary_success' },
    });
    logger.debug({ cost: pendingCost, count: pendingCount }, 'Flushed enhancement costs to ledger');
    pendingCost = 0;
    pendingCount = 0;
    pendingAuthMethod = null;
    lastFlushTime = Date.now();
  }
}

// Register app shutdown handler to prevent data loss.
// Desktop-only: cloud uses explicit shutdown calls.
onElectronAppEvent('will-quit', () => {
  flushPendingCosts();
});

/**
 * Start the enhancement service
 */
export async function startEnhancement(): Promise<void> {
  if (isRunning) {
    logger.debug('Enhancement already running');
    return;
  }

  const settings = getSettings();
  
  if (!hasValidAuth(settings)) {
    logger.info('No valid auth configured, enhancement disabled');
    return;
  }

  // Check if background enhancement is disabled in settings
  if (settings.backgroundEnhancement === false) {
    logger.info('Background enhancement disabled in settings');
    return;
  }

  logger.info('Starting enhancement service');
  isRunning = true;
  isPaused = false;
  processedCount = 0;
  abortController = new AbortController();

  // Update initial state
  await refreshChunkCounts();
  updateEnhancementState({ isRunning: true, isPaused: false });

  // Start processing in background
  fireAndForget(processEnhancementQueue(settings, abortController.signal), 'enhancementService.line166');
}

/**
 * Stop the enhancement service
 */
export function stopEnhancement(): void {
  if (!isRunning && !abortController) {
    return;
  }

  logger.info('Stopping enhancement service');
  
  // Flush any pending costs before stopping
  flushPendingCosts();
  
  if (abortController) {
    abortController.abort();
    abortController = null;
  }
  
  isRunning = false;
  isPaused = false;
  processedCount = 0;
  currentBackoffMs = 0;
  
  updateEnhancementState({
    isRunning: false,
    isPaused: false,
    totalChunks: 0,
    enhancedChunks: 0
  });
}

/**
 * Pause enhancement processing
 */
export function pauseEnhancement(): void {
  if (!isRunning) return;
  
  logger.info('Pausing enhancement service');
  isPaused = true;
  updateEnhancementState({ isPaused: true });
}

/**
 * Resume enhancement processing
 */
export function resumeEnhancement(): void {
  if (!isRunning || !isPaused) return;
  
  logger.info('Resuming enhancement service');
  isPaused = false;
  updateEnhancementState({ isPaused: false });
}

/**
 * Check if enhancement is currently running
 */
export function isEnhancementRunning(): boolean {
  return isRunning;
}

/**
 * Check if enhancement is paused
 */
export function isEnhancementPaused(): boolean {
  return isPaused;
}

/**
 * Main processing loop
 */
async function processEnhancementQueue(settings: AppSettings, signal: AbortSignal): Promise<void> {
  const model = resolveEnhancementModel(settings);

  try {
    while (!signal.aborted) {
      // Wait if paused
      while (isPaused && !signal.aborted) {
        await delay(1000, signal);
      }

      if (signal.aborted) break;

      // Get batch of unenhanced chunks
      const chunks = await getUnenhancedChunks(BATCH_SIZE);
      
      if (chunks.length === 0) {
        logger.info({ processedCount }, 'Enhancement complete - no more unenhanced chunks');
        break;
      }

      // Process each chunk in the batch
      for (const chunk of chunks) {
        if (signal.aborted || isPaused) break;

        const success = await processChunk(chunk, settings, model, signal);
        
        if (success) {
          processedCount++;
          
          // Update counts periodically
          if (processedCount - lastProgressUpdate >= PROGRESS_UPDATE_INTERVAL) {
            await refreshChunkCounts();
            lastProgressUpdate = processedCount;
          }
        }

        // Yield to event loop between chunks to reduce system strain
        // This prevents the GPU worker from consuming 100% CPU continuously
        if (!signal.aborted && !isPaused) {
          await delay(INTER_CHUNK_DELAY_MS, signal).catch(() => {});
        }
      }
    }
  } catch (error) {
    if ((error as Error).name !== 'AbortError') {
      logger.error({ err: error }, 'Enhancement queue processing failed');
    }
  } finally {
    // Flush any remaining pending costs when processing ends (natural completion or stop)
    flushPendingCosts();
    isRunning = false;
    updateEnhancementState({ isRunning: false });
    logger.info({ processedCount }, 'Enhancement service stopped');
  }
}

/**
 * Process a single chunk
 */
async function processChunk(
  chunk: FileEmbeddingRecord,
  settings: AppSettings,
  model: string | undefined,
  signal: AbortSignal
): Promise<boolean> {
  try {
    // Rate limit
    await rateLimitDelay(signal);
    if (signal.aborted) return false;

    // Generate context for this chunk
    const context = await generateChunkContextWithRetry(
      chunk,
      settings,
      model,
      signal
    );
    
    if (signal.aborted) return false;
    if (!context) {
      // Context generation failed after retries, skip this chunk
      logger.debug({ chunkId: chunk.id }, 'Skipping chunk - context generation failed');
      return false;
    }

    // Generate enhanced embedding
    const enhancedText = context + chunk.content;
    const embedding = await generateEmbedding(enhancedText, 'background_indexing');
    
    if (signal.aborted) return false;

    // Update the chunk in the database
    const updated = await updateChunkEmbedding(
      chunk.id,
      Array.from(embedding),
      Date.now()
    );

    if (updated) {
      logger.debug({ chunkId: chunk.id, path: chunk.relativePath }, 'Enhanced chunk');
    }

    return updated;
  } catch (error) {
    if ((error as Error).name !== 'AbortError') {
      logger.warn({ err: error, chunkId: chunk.id }, 'Failed to process chunk');
    }
    return false;
  }
}

/**
 * Generate context for a chunk with retry logic
 */
async function generateChunkContextWithRetry(
  chunk: FileEmbeddingRecord,
  settings: AppSettings,
  model: string | undefined,
  signal: AbortSignal
): Promise<string | null> {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    if (signal.aborted) return null;

    try {
      const response = await callWithModelAuthAware(
        settings,
        model,
        {
          messages: [{
            role: 'user',
            content: `<chunk>
${chunk.content}
</chunk>

File: ${chunk.relativePath}
Chunk ${chunk.chunkIndex + 1} of ${chunk.totalChunks}

Write a brief (1-2 sentence) context for this chunk that explains what it covers. Focus on making the chunk more searchable. Output only the context text.`
          }],
          maxTokens: CONTEXT_MAX_TOKENS,
          timeout: 15000,
        }
      );

      // Track cost if we have usage data (batched to avoid ledger bloat)
      const effectiveAuth = response._resolvedAuth ?? 'unknown';
      if (response.usage) {
        const cost = calculateCostOrWarn(
          response.model,
          response.usage.input_tokens,
          response.usage.output_tokens,
          logger,
          'enhancement',
        );
        if (cost !== null) {
          accumulateCost(cost, response.model, effectiveAuth);
        }
      } else if (response._sdkCostUsd != null) {
        accumulateCost(response._sdkCostUsd, response.model, effectiveAuth);
      }

      const textBlock = response.content?.[0];
      if (textBlock?.type === 'text' && textBlock.text) {
        // Reset backoff on success
        currentBackoffMs = 0;
        return textBlock.text.trim() + '\n\n';
      }
      return '';
    } catch (error) {
      const axiosError = error as { response?: { status?: number; headers?: Record<string, string> } };
      
      // Handle rate limiting
      if (axiosError.response?.status === 429) {
        const retryAfter = axiosError.response.headers?.['retry-after'];
        const backoffMs = retryAfter 
          ? parseInt(retryAfter, 10) * 1000 
          : BACKOFF_BASE_MS * Math.pow(2, attempt);
        
        currentBackoffMs = Math.max(currentBackoffMs, backoffMs);
        
        logger.warn(
          { attempt: attempt + 1, backoffMs, chunkId: chunk.id },
          'Enhancement rate limited, backing off'
        );
        
        await delay(backoffMs, signal);
        continue;
      }

      // Other errors - log and give up on this chunk
      logger.debug({ err: error, chunkId: chunk.id }, 'Context generation failed');
      return null;
    }
  }

  return null;
}

/**
 * Rate limit delay between requests
 */
async function rateLimitDelay(signal: AbortSignal): Promise<void> {
  const now = Date.now();
  const timeSinceLastRequest = now - lastRequestTime;
  const minDelay = RATE_LIMIT_MS + currentBackoffMs;
  
  if (timeSinceLastRequest < minDelay) {
    const waitTime = minDelay - timeSinceLastRequest;
    await delay(waitTime, signal);
  }
  
  lastRequestTime = Date.now();
}

/**
 * Refresh chunk counts and update state
 */
async function refreshChunkCounts(): Promise<void> {
  const counts = await getChunkCounts();
  updateEnhancementState({
    totalChunks: counts.total,
    enhancedChunks: counts.enhanced
  });
}

/**
 * Helper: Abortable delay
 */
function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }

    const timeout = setTimeout(resolve, ms);
    
    signal.addEventListener('abort', () => {
      clearTimeout(timeout);
      reject(new DOMException('Aborted', 'AbortError'));
    }, { once: true });
  });
}
