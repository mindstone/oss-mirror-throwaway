// cloud-client/src/offlineQueue/index.ts

// Types
export type {
  QueueItem,
  QueueItemType,
  QueueItemStatus,
  QueueSnapshot,
  QueueStorageAdapter,
  QueueConsumer,
  QueueConsumerResult,
  QueueFullRejection,
  QueueStateSnapshot,
  QueueTransitionEvent,
  DrainOptions,
  DrainSummary,
} from './types';

// Queue logic
export {
  OfflineQueue,
  computeBackoff,
  BASE_BACKOFF_MS,
  MAX_BACKOFF_MS,
  MAX_ATTEMPTS_BEFORE_PERMANENT,
  DEFER_DELAY_MS,
  QUEUE_MAX_SIZE,
  DEFAULT_PROCESSING_TIMEOUT_MS,
  DRAIN_INITIAL_JITTER_MS,
} from './OfflineQueue';
export type { QueueChangeListener, OfflineQueueConfig } from './OfflineQueue';

// Zustand store
export { initOfflineQueueStore, useOfflineQueueStore, _resetOfflineQueueStore } from './offlineQueueStore';
export type { OfflineQueueState } from './offlineQueueStore';

// Queue status derivation
export { useQueueStatus } from './useQueueStatus';
export type { QueueState, QueueStatusInputs, QueueStatus } from './useQueueStatus';

// Errors
export { QueueFullError } from './errors';

// Shared media-upload failure classifier (permanent-whitelist SSOT)
export { classifyUploadFailureCategory } from './classifyUploadFailureCategory';
