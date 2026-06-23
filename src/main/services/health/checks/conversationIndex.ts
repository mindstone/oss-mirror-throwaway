/**
 * Conversation Index Health Checks
 *
 * Checks for conversation semantic search index status.
 * Uses lightweight status to avoid allocating large session ID array.
 */

import type { CheckResult } from '../types';
import { getConversationIndexHealthStatus, isBackfillInProgress } from '../../conversationIndexService';

/**
 * Check conversation index health.
 * Reports on index initialization, embedding count, and staleness.
 */
export function checkConversationIndexHealth(): CheckResult {
  const status = getConversationIndexHealthStatus();
  const isBackfilling = isBackfillInProgress();

  if (!status.isInitialized) {
    return {
      id: 'conversationIndexHealth',
      name: 'Conversation Index',
      status: 'warn',
      message: 'Conversation index not initialized',
      details: {
        isInitialized: false,
        isBackfilling,
      },
      remediation: 'Index initializes automatically when conversation search is used.',
    };
  }

  // Check staleness - warn if not indexed in 7 days and has sessions
  const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const isStale = status.lastIndexedAt && status.lastIndexedAt < sevenDaysAgo && status.totalEmbeddings > 0;

  if (isStale) {
    return {
      id: 'conversationIndexHealth',
      name: 'Conversation Index',
      status: 'warn',
      message: `Index may be stale (last indexed ${Math.floor((Date.now() - (status.lastIndexedAt ?? 0)) / (24 * 60 * 60 * 1000))} days ago)`,
      details: {
        isInitialized: true,
        totalEmbeddings: status.totalEmbeddings,
        lastIndexedAt: status.lastIndexedAt,
        lastReconcileAt: status.lastReconcileAt,
        embeddingModel: status.embeddingModel,
        isBackfilling,
      },
      remediation: 'Recent conversations may not appear in search. Try starting a new conversation.',
    };
  }

  if (isBackfilling) {
    return {
      id: 'conversationIndexHealth',
      name: 'Conversation Index',
      status: 'pass',
      message: `Backfilling in progress (${status.totalEmbeddings} embeddings so far)`,
      details: {
        isInitialized: true,
        totalEmbeddings: status.totalEmbeddings,
        lastIndexedAt: status.lastIndexedAt,
        lastReconcileAt: status.lastReconcileAt,
        embeddingModel: status.embeddingModel,
        isBackfilling: true,
      },
    };
  }

  return {
    id: 'conversationIndexHealth',
    name: 'Conversation Index',
    status: 'pass',
    message: status.totalEmbeddings === 0
      ? 'Index ready (no conversations indexed yet)'
      : `${status.totalEmbeddings} conversation embeddings indexed`,
    details: {
      isInitialized: true,
      totalEmbeddings: status.totalEmbeddings,
      lastIndexedAt: status.lastIndexedAt,
      lastReconcileAt: status.lastReconcileAt,
      embeddingModel: status.embeddingModel,
      isBackfilling: false,
    },
  };
}
