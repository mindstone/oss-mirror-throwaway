/**
 * Plaud Integration Types
 *
 * Types for the Plaud voice recorder cloud sync integration.
 */

/** Plaud user info from /users/current endpoint */
export interface PlaudUser {
  id: string;
  email: string;
  nickname?: string;
  avatar?: string;
}

/** Plaud file from /files/ list endpoint */
export interface PlaudFile {
  id: string;
  name: string;
  created_at: string;
  serial_number: string;
  start_at: string;
  duration: number; // milliseconds
}

/** Plaud file details from /files/{id} endpoint */
export interface PlaudFileDetails extends PlaudFile {
  presigned_url: string;
  source_list: unknown[];
  note_list: unknown[];
}

/** Plaud OAuth tokens */
export interface PlaudTokens {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
  expires_at: number; // timestamp ms
}

/** Plaud account info stored locally */
export interface PlaudAccount {
  userId: string;
  email: string;
  nickname?: string;
  connectedAt: string;
}

/** Metadata stored in the staging .meta.json file */
export interface PlaudFileMetadata {
  id: string;
  name: string;
  created_at: string;
  start_at: string;
  duration: number; // milliseconds
  serial_number: string;
}

/** Sync state persisted between syncs */
export interface PlaudSyncState {
  lastSyncTime: string | null;
  processedFileIds: string[];
  /** File currently being processed - cleared on success, used to detect interrupted syncs */
  inProgressFileId?: string;
  failureCounts: Record<string, number>;
  /** Files we've already notified user about - prevents inbox spam */
  notifiedFileIds?: string[];
  /** Files abandoned after max retries - won't retry unless user clears state */
  abandonedFileIds?: string[];
  /** Timestamps (ISO strings) when files were abandoned — used for 24h re-examination */
  abandonedAt?: Record<string, string>;
  /** Timestamp of last auth failure notification (ISO string) - used to throttle notifications */
  lastAuthNotificationAt?: string;
  /** Timestamp of last API key/setup notification (ISO string) - used to throttle setup notifications */
  lastApiKeyNotificationAt?: string;
}

/** Result of a sync operation */
export interface PlaudSyncResult {
  synced: number;
  errors: number;
}

/** Connection state for UI */
export interface PlaudConnectionState {
  connected: boolean;
  user?: PlaudUser;
  lastSyncTime?: string;
  syncInProgress: boolean;
  error?: string;
}

/** Plaud settings in MeetingBotSettings */
export interface PlaudSettings {
  enabled?: boolean;
  userEmail?: string;
  userId?: string;
  lastSyncTime?: string;
  autoSyncIntervalMinutes?: number;
}
