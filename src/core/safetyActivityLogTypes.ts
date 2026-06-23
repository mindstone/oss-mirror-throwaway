/**
 * Safety Activity Log Types
 *
 * Discriminated union types for the Safety Activity Log entries.
 * Used by store, IPC channels, and UI components.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Entry types (discriminated union per Amendment A1.6)
// ─────────────────────────────────────────────────────────────────────────────

interface BaseActivityLogEntry {
  /** Unique entry ID (UUID) */
  id: string;
  /** Epoch ms */
  timestamp: number;
  /** Discriminator */
  type: 'evaluation' | 'version-change';
  /** Surface that executed the safety-relevant action; undefined means desktop/local legacy entry. */
  executionSurface?: 'desktop' | 'cloud';
}

export interface EvaluationEntry extends BaseActivityLogEntry {
  type: 'evaluation';
  /** Tool display name (e.g., "Send Slack message") */
  toolDisplayName: string;
  /** Tool ID (e.g., "slack_send_message") */
  toolId: string;
  /** Brief description of the action */
  actionSummary: string;
  /** Evaluation decision */
  decision: 'allowed' | 'blocked';
  /** Reason from evaluator */
  reason: string;
  /** Session type */
  sessionType: 'interactive' | 'automation' | 'role';
  /** Automation or role name (if automation/role) */
  automationName?: string;
  /** Source of the evaluation decision */
  source?: 'deterministic' | 'safety-prompt' | 'user-approved';
  /** Whether user flagged this entry as incorrect */
  flagged: boolean;
}

export interface VersionChangeEntry extends BaseActivityLogEntry {
  type: 'version-change';
  /** Previous version number */
  fromVersion: number;
  /** New version number */
  toVersion: number;
  /** Surface or system path that changed the safety rules. */
  source?: 'ui-picker' | 'chat-intent' | 'settings-editor' | 'system' | 'migration';
}

export type ActivityLogEntry = EvaluationEntry | VersionChangeEntry;

// ─────────────────────────────────────────────────────────────────────────────
// Store schema
// ─────────────────────────────────────────────────────────────────────────────

export type SafetyActivityLogStoreSchema = {
  entries: ActivityLogEntry[];
};

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** Max entries in the ring buffer */
export const SAFETY_ACTIVITY_LOG_MAX_ENTRIES = 500;
