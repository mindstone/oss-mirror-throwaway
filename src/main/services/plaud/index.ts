/**
 * Plaud Integration Module
 *
 * Exports all Plaud-related services and types.
 */

// Types
export * from './types';

// Auth service
export {
  startPlaudAuth,
  handlePlaudOAuthCallback,
  cancelPlaudAuth,
  getPlaudAccount,
  getPlaudTokens,
  ensureValidToken,
  disconnectPlaud,
  isPlaudConnected,
  getPlaudConfigDir,
  type PlaudOAuthResult,
  type PlaudAuthResult,
} from './plaudAuthService';

// API client
export { fetchPlaudFiles, fetchPlaudFileDetails, downloadAudioFile, fileExists } from './plaudApiClient';

// Sync service
export {
  initializePlaudSyncService,
  syncPlaudRecordings,
  startPeriodicSync,
  stopPeriodicSync,
  isSyncInProgress,
  getLastSyncTime,
  triggerManualSync,
  retranscribePlaudMeeting,
  type PlaudSyncDeps,
} from './plaudSyncService';
