/**
 * Space-related types for settings components
 *
 * Extracted to break circular dependency between SpaceCard and SpaceMetadataStrip.
 */

import type { SpaceInfo } from '@shared/ipc/schemas/library';
import type { SpaceStorageProvider } from '@shared/types';

/**
 * SpaceInfo enriched with additional fields from SpaceConfig.
 * These fields are merged at render time in SpacesManager.
 */
export interface EnrichedSpaceInfo extends SpaceInfo {
  /** Storage provider (e.g., 'google_drive', 'onedrive', 'local') - from SpaceConfig */
  storageProvider?: SpaceStorageProvider;
  /** Timestamp when space was created - from SpaceConfig */
  createdAt?: number;
  /** Company name for work spaces - from SpaceConfig */
  companyName?: string;
  /** User-local account associations for this space - from SpaceConfig */
  associatedAccounts?: string[];
}
