import type { AgentSessionSummary } from '../ipc/schemas/sessions';

// =============================================================================
// Session History Lazy Loading Types
// =============================================================================

/**
 * Lightweight session summary for index file.
 * Contains only metadata needed for sidebar display, not full content.
 * Full session content is loaded on-demand via sessions:get IPC.
 *
 * Re-exported from Zod schema for single source of truth.
 * @see src/shared/ipc/schemas/sessions.ts
 */
export type { AgentSessionSummary };

/**
 * Index file structure for lazy-loaded session storage.
 * Replaces the old agent-session-history.json single-file format.
 */
export interface AgentSessionIndex {
  /** Index format version. Canonical source: INDEX_VERSION in core/services/incrementalSessionStore.ts */
  version: number;
  /** Lightweight session summaries for all sessions */
  sessions: AgentSessionSummary[];
  /** Timestamp of migration from v4 format (if migrated) */
  migratedAt?: number;
  /** Previous version that was migrated from (for diagnostics) */
  migratedFrom?: number;
  /** Timestamp of last index rebuild (crash recovery) */
  rebuiltAt?: number;
}
