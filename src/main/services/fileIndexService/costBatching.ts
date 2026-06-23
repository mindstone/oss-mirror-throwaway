/**
 * File Index Service — cost batching.
 *
 * Accumulates contextual-retrieval LLM costs in memory and flushes them to the
 * cost ledger as a single entry, to avoid ledger bloat on this high-volume
 * service (~20 req/sec). Extracted from `fileIndexService/index.ts` (Stage B3).
 * Behavior-preserving move only: state is local to this module; the `will-quit`
 * shutdown flush hook moves with it.
 */

import { onElectronAppEvent } from '@core/lazyElectron';
import { logger } from '@core/logger';
import { appendCostEntry } from '../costLedgerService';

// Cost batching state for file indexing contextual retrieval
// Accumulates costs in memory to avoid ledger bloat (high-volume service: ~20 req/sec)
let pendingFileIndexCost = 0;
let pendingFileIndexCount = 0;
let pendingFileIndexModel: string | null = null;
let pendingFileIndexAuthMethod: string | null = null;
let lastFileIndexFlushTime = Date.now();
const FILE_INDEX_COST_BATCH_SIZE = 50; // Flush after this many chunks
const FILE_INDEX_COST_FLUSH_INTERVAL_MS = 30000; // Flush every 30 seconds

/**
 * Accumulate cost for a successful file index LLM call.
 * Flushes to ledger when batch size reached or interval elapsed.
 */
export function accumulateFileIndexCost(cost: number, model: string, authMethod: string): void {
  pendingFileIndexCost += cost;
  pendingFileIndexCount++;
  pendingFileIndexModel = model; // Track last model used
  pendingFileIndexAuthMethod = authMethod;

  // Flush if batch size reached or interval elapsed
  if (pendingFileIndexCount >= FILE_INDEX_COST_BATCH_SIZE ||
      Date.now() - lastFileIndexFlushTime >= FILE_INDEX_COST_FLUSH_INTERVAL_MS) {
    flushFileIndexCosts();
  }
}

/**
 * Flush accumulated file index costs to the ledger as a single entry.
 * Called on batch size limit, timer, contextual retrieval disable, or app quit.
 */
export function flushFileIndexCosts(): void {
  if (pendingFileIndexCost > 0 && pendingFileIndexCount > 0) {
    appendCostEntry({
      ts: Date.now(),
      cost: pendingFileIndexCost,
      cat: 'fileIndex',
      m: pendingFileIndexModel ?? undefined,
      auth: pendingFileIndexAuthMethod ?? undefined,
      outcome: { kind: 'auxiliary_success' },
    });
    logger.debug({ cost: pendingFileIndexCost, count: pendingFileIndexCount }, 'Flushed file index costs to ledger');
    pendingFileIndexCost = 0;
    pendingFileIndexCount = 0;
    pendingFileIndexAuthMethod = null;
    lastFileIndexFlushTime = Date.now();
  }
}

// Register app shutdown handler to prevent data loss.
// Desktop-only: cloud uses explicit shutdown calls.
onElectronAppEvent('will-quit', () => {
  flushFileIndexCosts();
});
