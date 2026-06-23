/**
 * Semantic Search Health Checks
 *
 * Checks for embedding service readiness and index health.
 */

import type { AppSettings } from '@shared/types';
import type { CheckResult } from '../types';
import { isEmbeddingServiceReady, getServiceStatus } from '../../embeddingService';
import { hasIndex, getIndexMetadata, getSearchMetrics, getFtsStatus, CURRENT_EMBEDDING_MODEL } from '../../fileIndexService';
import { getWatcherStatus } from '../../fileWatcherService';
import { appendDiagnosticEvent } from '@core/services/diagnosticEventsLedger';

// Cooldown period must match embeddingService.ts RETRY_COOLDOWN_MS
const RETRY_COOLDOWN_MS = 5000;

// Module-level state tracking for transition emits
let lastEmbeddingServiceStatus: 'ready' | 'unready' | null = null;
let lastSemanticIndexStatus: 'fresh' | 'stale' | 'unready' | null = null;

// Export for tests to clear state
export function resetSemanticSearchHealthStateForTests(): void {
  lastEmbeddingServiceStatus = null;
  lastSemanticIndexStatus = null;
}

/**
 * Check if the embedding service worker is ready.
 * The embedding service is required for semantic search to function.
 */
export function checkEmbeddingServiceReady(): CheckResult {
  const id = 'embeddingServiceReady';
  const name = 'Embedding Service';
  const modelName = 'Xenova/bge-small-en-v1.5';

  const ready = isEmbeddingServiceReady();
  const status = getServiceStatus();

  const currentEmbeddingServiceStatus: 'ready' | 'unready' = ready ? 'ready' : 'unready';
  if (lastEmbeddingServiceStatus !== null && lastEmbeddingServiceStatus !== currentEmbeddingServiceStatus) {
    appendDiagnosticEvent({
      kind: 'embedding_index_health',
      data: {
        component: 'embedding_service',
        transition: currentEmbeddingServiceStatus === 'ready' ? 'unready_to_ready' : 'ready_to_unready',
      },
    });
  }
  lastEmbeddingServiceStatus = currentEmbeddingServiceStatus;

  // Failed state: initialization failed after all retry attempts
  if (status.failed) {
    const now = Date.now();
    const cooldownRemainingMs = status.lastAttemptAt
      ? Math.max(0, RETRY_COOLDOWN_MS - (now - status.lastAttemptAt))
      : 0;

    // Within cooldown - show recovery available message
    if (cooldownRemainingMs > 0) {
      return {
        id,
        name,
        status: 'fail',
        message: `Embedding service failed after ${status.attempts} attempts - recovery available in ${Math.ceil(cooldownRemainingMs / 1000)}s`,
        details: {
          modelName,
          attempts: status.attempts,
          lastError: status.lastError,
          cooldownRemainingMs,
        },
        remediation: 'Auto-recovery will be attempted on next search. You can also restart the app or check Diagnostics.',
      };
    }

    // Cooldown elapsed - show restart message
    return {
      id,
      name,
      status: 'fail',
      message: `Embedding service failed after ${status.attempts} attempts - auto-recovery will be attempted on next search`,
      details: {
        modelName,
        attempts: status.attempts,
        lastError: status.lastError,
        cooldownRemainingMs: 0,
      },
      remediation: 'Auto-recovery is enabled. If the issue persists, try restarting the application.',
    };
  }

  // Not ready yet but not failed - still initializing
  if (!ready) {
    return {
      id,
      name,
      status: 'warn',
      message: 'Embedding service not yet initialized',
      details: {
        modelName,
        attempts: status.attempts,
      },
      remediation: 'The embedding model is still loading. This typically takes 10-30 seconds on first launch.',
    };
  }

  return {
    id,
    name,
    status: 'pass',
    message: 'Embedding service ready',
    details: { modelName },
  };
}

/**
 * Check semantic search index health.
 * Verifies index exists and embedding model matches current version.
 */
export function checkSemanticIndexHealth(settings: AppSettings): CheckResult {
  const id = 'semanticIndexHealth';
  const name = 'Semantic Index';

  // Check if enhanced indexing is enabled (opt-out: undefined means enabled)
  if (settings.indexingEnabled === false) {
    return {
      id,
      name,
      status: 'skip',
      message: 'Enhanced search indexing is disabled',
    };
  }

  // Check if workspace is configured
  if (!settings.coreDirectory) {
    return {
      id,
      name,
      status: 'skip',
      message: 'No Library configured',
    };
  }

  const hasIdx = hasIndex();
  let currentSemanticIndexStatus: 'fresh' | 'stale' | 'unready';
  if (!hasIdx) {
    currentSemanticIndexStatus = 'unready';
  } else {
    const metadata = getIndexMetadata();
    if (metadata && metadata.embeddingModel !== CURRENT_EMBEDDING_MODEL) {
      currentSemanticIndexStatus = 'stale';
    } else {
      currentSemanticIndexStatus = 'fresh';
    }
  }

  if (lastSemanticIndexStatus !== null && lastSemanticIndexStatus !== currentSemanticIndexStatus) {
    let transition: 'ready_to_unready' | 'unready_to_ready' | 'fresh_to_stale' | 'stale_to_fresh' | null = null;
    if (lastSemanticIndexStatus === 'fresh' && currentSemanticIndexStatus === 'stale') transition = 'fresh_to_stale';
    else if (lastSemanticIndexStatus === 'stale' && currentSemanticIndexStatus === 'fresh') transition = 'stale_to_fresh';
    else if ((lastSemanticIndexStatus === 'fresh' || lastSemanticIndexStatus === 'stale') && currentSemanticIndexStatus === 'unready') transition = 'ready_to_unready';
    else if (lastSemanticIndexStatus === 'unready' && (currentSemanticIndexStatus === 'fresh' || currentSemanticIndexStatus === 'stale')) transition = 'unready_to_ready';

    if (transition) {
      appendDiagnosticEvent({
        kind: 'embedding_index_health',
        data: {
          component: 'semantic_index',
          transition,
        },
      });
    }
  }
  lastSemanticIndexStatus = currentSemanticIndexStatus;

  // Check if the search index is OPEN. `hasIndex()` reflects whether the
  // chunk-level `file_embeddings` table handle is loaded in memory — NOT
  // whether files exist or are findable. Even while this is false, files
  // stay findable by name via Quick Open (a local filename search over the
  // live tree) and the assistant can still read and grep your files directly.
  // What is unavailable is only the meaning-based (semantic) ranking, which
  // comes back automatically once the index finishes opening/building. So the
  // copy below must not imply your files are missing or that you must turn
  // indexing on by hand — that would be dishonest (indexing is on by default).
  if (!hasIndex()) {
    const status = getWatcherStatus();
    if (status.isWatching) {
      return {
        id,
        name,
        status: 'warn',
        message: 'Search index is still building — files are findable by name meanwhile',
        details: {
          indexedFiles: status.indexedFiles,
          pendingFiles: status.pendingFiles,
          indexState: status.indexState,
        },
        remediation: 'Indexing runs automatically. Meaning-based search becomes available once it finishes; until then, use Quick Open to find files by name, or just ask the assistant.',
      };
    }

    return {
      id,
      name,
      status: 'warn',
      message: 'Search index is not open yet — files are still findable by name',
      remediation: 'The index builds automatically when the Library is open. Meaning-based search returns once it finishes; meanwhile, use Quick Open to find files by name, or just ask the assistant. If this persists, open the Library panel and use the info icon next to the file count to rebuild it.',
    };
  }

  // Check for model mismatch
  const metadata = getIndexMetadata();
  if (metadata && metadata.embeddingModel !== CURRENT_EMBEDDING_MODEL) {
    return {
      id,
      name,
      status: 'warn',
      message: 'Index was built with a different embedding model',
      details: {
        indexModel: metadata.embeddingModel,
        currentModel: CURRENT_EMBEDDING_MODEL,
      },
      remediation: 'Reindex workspace to use the latest embedding model for better search results.',
    };
  }

  // FTS (keyword) index degraded. When the index IS open and the model matches
  // but the keyword-search half failed to build (`ftsStatus === 'failed'`),
  // hybrid search degrades to vector-only ranking: exact-word matches rank a
  // little lower, but name search and meaning-based (semantic) search are
  // unaffected, and the keyword index rebuilds itself automatically. This is a
  // quiet `warn` — NOT a `fail` (which would roll global health to red and read
  // as data loss for a self-healing quality dip) and NOT a toast (the fold into
  // this check, which is ∉ USER_ACTIONABLE_CHECKS, gives the correct
  // Diagnostics+amber-glow tier automatically, with no alarm for a non-technical
  // user). The vector-only fallback itself is correct runtime behaviour and
  // stays — we surface the degradation, we don't change search. Ordered AFTER
  // the not-open and model-mismatch branches so it never shadows their more
  // urgent copy; `'unavailable'` (benign still-building / freshly-cleared state)
  // must NOT warn. Desktop-only: FTS/LanceDB does not run on cloud/mobile.
  // Design + copy settled by chief-designer (Picker Decision); see
  // docs/plans/260618_semantic-index-error-surfacing/PLAN.md.
  if (getFtsStatus() === 'failed') {
    return {
      id,
      name,
      status: 'warn',
      message: 'Keyword search ranking is temporarily reduced — search still works',
      details: {
        ftsStatus: 'failed',
      },
      remediation: 'The keyword part of search needs to rebuild, so exact-word matches may rank a little lower for now. Finding files by name and meaning-based search are unaffected. This rebuilds itself automatically as your Library updates. To rebuild it now, open the Library panel and use the info icon next to the file count.',
    };
  }

  // Get current status for details
  const status = getWatcherStatus();

  return {
    id,
    name,
    status: 'pass',
    message: `Index healthy with ${status.indexedFiles} files`,
    details: {
      indexedFiles: status.indexedFiles,
      pendingFiles: status.pendingFiles,
      isWatching: status.isWatching,
      embeddingModel: CURRENT_EMBEDDING_MODEL,
      metrics: {
        search: getSearchMetrics(),
      },
    },
  };
}
