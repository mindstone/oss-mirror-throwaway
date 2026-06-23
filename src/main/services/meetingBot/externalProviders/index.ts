/**
 * External Providers Module
 *
 * Exports adapters for importing transcripts from external meeting providers.
 */

export * from './types';
export * from './importTrackingStore';
export { createFathomAdapter } from './fathomAdapter';
export { createFirefliesAdapter } from './firefliesAdapter';
export {
  syncExternalProviders,
  testProviderConnection,
  startExternalProviderPolling,
  stopExternalProviderPolling,
  isExternalProviderPollingActive,
  triggerManualSync,
} from './pollingService';
