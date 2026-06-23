/**
 * SafetyActivityEntry
 *
 * Renders a single row in the Safety Activity Log (Zone 2).
 * Supports three visual variants:
 *   - version-change: pencil icon, muted gray
 *   - evaluation (allowed): green check, optional "This wasn't OK" flag button
 *   - evaluation (blocked): amber × icon
 */

import { CheckCircle2, XCircle, Edit2, Flag } from 'lucide-react';
import styles from './SettingsSurface.module.css';

// ─────────────────────────────────────────────────────────────────────────────
// Types (local mirrors of core discriminated union — renderer can't import @core/)
// ─────────────────────────────────────────────────────────────────────────────

interface BaseEntry {
  id: string;
  timestamp: number;
  executionSurface?: 'desktop' | 'cloud';
}

interface EvaluationEntry extends BaseEntry {
  type: 'evaluation';
  toolDisplayName: string;
  toolId: string;
  actionSummary: string;
  decision: 'allowed' | 'blocked';
  reason: string;
  sessionType: 'interactive' | 'automation' | 'role';
  automationName?: string;
  source?: 'deterministic' | 'safety-prompt' | 'user-approved';
  flagged: boolean;
}

interface VersionChangeEntry extends BaseEntry {
  type: 'version-change';
  fromVersion: number;
  toVersion: number;
}

export type ActivityLogEntry = EvaluationEntry | VersionChangeEntry;

// ─────────────────────────────────────────────────────────────────────────────
// Props
// ─────────────────────────────────────────────────────────────────────────────

export interface SafetyActivityEntryProps {
  entry: ActivityLogEntry;
  /** Provided only for allowed evaluation entries */
  onFlag?: (entryId: string) => void;
  /** Provided only for flagged evaluation entries */
  onUnflag?: (entryId: string) => void;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function formatRelativeTime(epochMs: number): string {
  const diff = Date.now() - epochMs;
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function formatSessionLabel(entry: EvaluationEntry): string {
  if (entry.sessionType === 'automation') {
    return entry.automationName ? `Automation "${entry.automationName}"` : 'Automation';
  }
  if (entry.sessionType === 'role') {
    return entry.automationName ? `Role "${entry.automationName}"` : 'Role check-in';
  }
  return 'Interactive';
}

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

export const SafetyActivityEntry: React.FC<SafetyActivityEntryProps> = ({ entry, onFlag, onUnflag }) => {
  // `executionSurface` is a desktop-display hint derived at the fetch/merge
  // boundary (cloud rows are stamped 'cloud' when merged into this device's log).
  // It is NOT a persisted cross-surface property of the entry, so treat it purely
  // as a render-time marker.
  const cloudMarker =
    entry.executionSurface === 'cloud' ? (
      <span
        className={styles.activityEntryCloudMarker}
        data-testid="safety-activity-cloud-marker"
        title="Ran in the cloud"
        aria-label="Ran in the cloud"
      >
        Cloud
      </span>
    ) : null;

  if (entry.type === 'version-change') {
    return (
      <div className={styles.activityEntry}>
        <span className={`${styles.activityEntryIcon} ${styles.activityEntryIconVersionChange}`}>
          <Edit2 size={16} />
        </span>
        <div className={styles.activityEntryContent}>
          <span className={styles.activityEntrySummary}>Your safety rules were updated</span>
          <span className={styles.activityEntryMeta}>
            v{entry.fromVersion} → v{entry.toVersion}
            {cloudMarker}
          </span>
        </div>
        <span className={styles.activityEntryTimestamp}>
          {formatRelativeTime(entry.timestamp)}
        </span>
      </div>
    );
  }

  // type === 'evaluation'
  const isAllowed = entry.decision === 'allowed';

  return (
    <div className={styles.activityEntry}>
      <span
        className={`${styles.activityEntryIcon} ${
          isAllowed ? styles.activityEntryIconAllowed : styles.activityEntryIconBlocked
        }`}
      >
        {isAllowed ? <CheckCircle2 size={16} /> : <XCircle size={16} />}
      </span>
      <div className={styles.activityEntryContent}>
        <span className={styles.activityEntrySummary}>
          {isAllowed ? entry.toolDisplayName : `Blocked: ${entry.toolDisplayName}`}
        </span>
        <span className={styles.activityEntryMeta}>
          {formatSessionLabel(entry)}
          {cloudMarker}
          <span className={styles.activityEntryBadge}>
            {isAllowed ? 'Allowed' : 'Blocked'}
          </span>
        </span>
      </div>
      <span className={styles.activityEntryTimestamp}>
        {formatRelativeTime(entry.timestamp)}
      </span>
      {isAllowed && !entry.flagged && onFlag && (
        <button
          type="button"
          className={styles.activityFlagButton}
          onClick={() => onFlag(entry.id)}
          aria-label="Flag as incorrect"
          title="Flag this action as something that shouldn't have been allowed"
        >
          <Flag size={12} />
          This wasn{'\u2019'}t OK
        </button>
      )}
      {isAllowed && entry.flagged && onUnflag && (
        <button
          type="button"
          className={`${styles.activityFlagButton} ${styles.activityFlagButtonFlagged}`}
          onClick={() => onUnflag(entry.id)}
          aria-label="Remove flag"
          title="Remove flag from this entry"
        >
          <Flag size={12} />
          Flagged
        </button>
      )}
    </div>
  );
};
