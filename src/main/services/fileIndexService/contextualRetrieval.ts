/**
 * File Index Service — embedding / contextual retrieval + session metrics.
 *
 * Owns the contextual-retrieval configuration, the Haiku context-prefix
 * generation (`_generateChunkContext`), the rate limiter, and the diagnostic
 * `sessionMetrics` counters. Extracted from `fileIndexService/index.ts`
 * (Stage B3). Behavior-preserving move only.
 *
 * `sessionMetrics` is written by two clusters: the contextual-retrieval path
 * here, and the search path (`semanticSearch`) which stays in `index.ts`. To
 * avoid the search path reaching into this module's internals, the search
 * counters are bumped through the `recordSearch*` helpers exported below —
 * exact behavior-preserving wrappers around the same field mutations.
 */

import type { AppSettings } from '@shared/types';
import { logger } from '@core/logger';
import { hasValidAuth } from '../../utils/authEnvUtils';
import { callWithModelAuthAware } from '../behindTheScenesClient';
import { calculateCostOrWarn } from '@shared/utils/pricingCalculator';
import { accumulateFileIndexCost, flushFileIndexCosts } from './costBatching';

// Contextual retrieval configuration
const CONTEXT_MAX_TOKENS = 100; // Brief context prefix
const CONTEXT_RATE_LIMIT_MS = 50; // Minimum ms between requests (~20 req/sec, well under 4000 RPM limit)
const CONTEXT_MAX_RETRIES = 3;
const CONTEXT_BACKOFF_BASE_MS = 1000;
let contextualRetrievalSettings: AppSettings | null = null; // Set via enableContextualRetrieval()
let contextualRetrievalModel: string | null = null; // Set via enableContextualRetrieval()
let contextualRetrievalEnabled: boolean = false;
let lastContextRequestTime: number = 0;

// Session metrics for diagnostics (reset on app restart)
const sessionMetrics = {
  searchCount: 0,
  searchFailures: 0,
  totalSearchTimeMs: 0,
  contextualRetrievalCalls: 0,
  contextualRetrievalFailures: 0,
  contextualRetrievalRateLimitHits: 0,
};

export function getSearchMetrics() {
  return {
    ...sessionMetrics,
    avgSearchTimeMs: sessionMetrics.searchCount > 0
      ? Math.round(sessionMetrics.totalSearchTimeMs / sessionMetrics.searchCount)
      : 0,
  };
}

export function resetSearchMetrics() {
  sessionMetrics.searchCount = 0;
  sessionMetrics.searchFailures = 0;
  sessionMetrics.totalSearchTimeMs = 0;
  sessionMetrics.contextualRetrievalCalls = 0;
  sessionMetrics.contextualRetrievalFailures = 0;
  sessionMetrics.contextualRetrievalRateLimitHits = 0;
}

// Search-path metric incrementers — used by `semanticSearch` /
// `semanticSearchVectorOnly` in index.ts. Behavior-preserving wrappers around
// the same `sessionMetrics` field mutations that lived inline before Stage B3.
export function recordSearchStart(): void {
  sessionMetrics.searchCount++;
}

export function recordSearchTime(elapsedMs: number): void {
  sessionMetrics.totalSearchTimeMs += elapsedMs;
}

export function recordSearchFailure(): void {
  sessionMetrics.searchFailures++;
}

/**
 * Enable contextual retrieval for improved semantic search.
 * Generates chunk context using Haiku before embedding (Anthropic's 49% improvement technique).
 * @param settings - App settings containing auth credentials
 * @param model - Model to use for context generation (defaults to claude-haiku-4-5)
 */
export function enableContextualRetrieval(settings: AppSettings, model?: string): void {
  contextualRetrievalSettings = settings;
  contextualRetrievalModel = model ?? null;
  contextualRetrievalEnabled = true;
  logger.info({ model: model ?? 'default' }, 'Contextual retrieval enabled');
}

/**
 * Disable contextual retrieval (fall back to direct embedding).
 */
export function disableContextualRetrieval(): void {
  // Flush any pending costs before disabling
  flushFileIndexCosts();

  contextualRetrievalEnabled = false;
  logger.info('Contextual retrieval disabled');
}

/**
 * Simple rate limiter - ensures minimum delay between requests.
 */
async function rateLimitContextRequest(): Promise<void> {
  const now = Date.now();
  const elapsed = now - lastContextRequestTime;
  if (elapsed < CONTEXT_RATE_LIMIT_MS) {
    await new Promise(resolve => setTimeout(resolve, CONTEXT_RATE_LIMIT_MS - elapsed));
  }
  lastContextRequestTime = Date.now();
}

/**
 * Generate context prefix for a chunk using Haiku.
 * Gives the chunk situational context within the larger document.
 * Includes rate limiting and exponential backoff for 429 errors.
 * @returns Context string to prepend to chunk, or empty string on failure
 */
async function _generateChunkContext(
  chunkContent: string,
  documentContext: string,
  filePath: string
): Promise<string> {
  if (!contextualRetrievalEnabled || !contextualRetrievalSettings || !hasValidAuth(contextualRetrievalSettings)) {
    logger.debug({ contextualRetrievalEnabled, hasAuth: contextualRetrievalSettings && hasValidAuth(contextualRetrievalSettings) }, 'Skipping context generation');
    return '';
  }

  sessionMetrics.contextualRetrievalCalls++;

  for (let attempt = 0; attempt < CONTEXT_MAX_RETRIES; attempt++) {
    try {
      // Rate limit requests
      await rateLimitContextRequest();

      const response = await callWithModelAuthAware(
        contextualRetrievalSettings,
        contextualRetrievalModel ?? undefined,
        {
          messages: [{
            role: 'user',
            content: `<document>
${documentContext.slice(0, 5000)}
</document>

<chunk>
${chunkContent}
</chunk>

File: ${filePath}

Write a brief (1-2 sentence) context for this chunk that explains what it covers and how it fits in the document. Focus on making the chunk more searchable by capturing its key purpose. Output only the context text.`
          }],
          maxTokens: CONTEXT_MAX_TOKENS,
          timeout: 15000, // 15s timeout for context generation
        }
      );

      const effectiveAuth = response._resolvedAuth ?? 'unknown';

      // Track cost if we have usage data (batched to avoid ledger bloat)
      if (response.usage) {
        const cost = calculateCostOrWarn(
          response.model,
          response.usage.input_tokens,
          response.usage.output_tokens,
          logger,
          'file-index',
        );
        if (cost !== null) {
          accumulateFileIndexCost(cost, response.model, effectiveAuth);
        }
      } else if (response._sdkCostUsd != null) {
        accumulateFileIndexCost(response._sdkCostUsd, response.model, effectiveAuth);
      }

      const textBlock = response.content?.[0];
      if (textBlock?.type === 'text' && textBlock.text) {
        const context = textBlock.text.trim();
        logger.info({ filePath, contextLength: context.length }, 'Generated context for chunk');
        return context + '\n\n';
      }
      return '';
    } catch (error) {
      const axiosError = error as { response?: { status?: number; headers?: Record<string, string> } };

      // Handle rate limiting with exponential backoff
      if (axiosError.response?.status === 429) {
        sessionMetrics.contextualRetrievalRateLimitHits++;
        const retryAfter = axiosError.response.headers?.['retry-after'];
        const backoffMs = retryAfter
          ? parseInt(retryAfter, 10) * 1000
          : CONTEXT_BACKOFF_BASE_MS * Math.pow(2, attempt);

        logger.warn(
          { attempt: attempt + 1, backoffMs, filePath },
          'Context generation rate limited, backing off'
        );
        await new Promise(resolve => setTimeout(resolve, backoffMs));
        continue;
      }

      // For other errors, log and return empty (don't retry)
      sessionMetrics.contextualRetrievalFailures++;
      logger.debug({ err: error, filePath }, 'Failed to generate chunk context, continuing without');
      return '';
    }
  }

  // Exhausted retries
  logger.warn({ filePath, maxRetries: CONTEXT_MAX_RETRIES }, 'Context generation failed after retries');
  return '';
}

// NOTE: `_generateChunkContext` is currently unreferenced (the two-phase
// enhancement path never enables contextual retrieval — `contextualRetrievalEnabled`
// is always false). It was an unexported, unreferenced function declaration in
// index.ts before Stage B3; preserved verbatim here. The leading-underscore name
// satisfies the no-unused-vars rule, matching its prior treatment.
