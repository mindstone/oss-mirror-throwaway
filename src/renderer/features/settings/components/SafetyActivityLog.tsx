/**
 * SafetyActivityLog
 *
 * Self-contained Zone 2 component for the Safety tab.
 * Fetches activity log entries via IPC, subscribes for real-time updates,
 * shows first 20 entries by default, and supports "Show more" expansion
 * and "This wasn't OK" flagging.
 */

import { useState, useEffect, useCallback } from 'react';
import { Spinner } from '@renderer/components/ui';
import { AlertTriangle } from 'lucide-react';
import type { SafetyActivityLogCloudSyncState } from '@shared/ipc/channels/safetyActivityLog';
import { ignoreBestEffortCleanup } from '@shared/utils/intentionalSwallow';
import { SafetyActivityEntry } from './SafetyActivityEntry';
import type { ActivityLogEntry } from './SafetyActivityEntry';
import styles from './SettingsSurface.module.css';

const VISIBLE_COUNT = 20;
const CLOUD_SYNC_NOTE = "Cloud activity hasn't synced yet. Showing this device's history.";
const CLOUD_SYNC_PENDING_NOTE = 'Checking for cloud activity…';

export const SafetyActivityLog: React.FC = () => {
  const [entries, setEntries] = useState<ActivityLogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [cloudSyncState, setCloudSyncState] = useState<SafetyActivityLogCloudSyncState | null>(null);

  // Fetch entries from IPC
  const fetchEntries = useCallback(async () => {
    try {
      setError(null);
      const result = await window.safetyActivityLogApi.get({});
      // Cast to local type — Zod schema matches the discriminated union
      setEntries(result.entries as ActivityLogEntry[]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load activity log');
    } finally {
      setLoading(false);
    }
  }, []);

  // Initial fetch + cloud catch-up. The follow-up fetch covers the case where
  // the merge broadcast fires before this component subscribes.
  useEffect(() => {
    let cancelled = false;

    const loadEntriesAndSyncCloud = async () => {
      const syncPromise = window.safetyActivityLogApi.syncCloud()
        .then(result => result.cloudSyncState)
        .catch((err): SafetyActivityLogCloudSyncState => {
          // The IPC handler resolves with a cloudSyncState even on cloud/merge
          // failure (those are logged main-side), so this only catches a rare
          // transport-level rejection. Record it (so it isn't silently lost) and
          // degrade to the user-visible 'failed' sync-state.
          ignoreBestEffortCleanup(err, {
            operation: 'safety_activity_log_cloud_sync',
            reason: 'syncCloud() IPC request rejected at the transport layer; degrading to failed sync-state',
            severity: 'warn',
          });
          return 'failed';
        });

      await fetchEntries();

      const nextCloudSyncState = await syncPromise;
      if (cancelled) return;

      setCloudSyncState(nextCloudSyncState);
      if (nextCloudSyncState === 'success') {
        await fetchEntries();
      }
    };

    loadEntriesAndSyncCloud();

    return () => {
      cancelled = true;
    };
  }, [fetchEntries]);

  // Subscribe to real-time updates
  useEffect(() => {
    const cleanup = window.safetyActivityLogSubscriptions.onSafetyActivityLogUpdated(() => {
      fetchEntries();
    });
    return cleanup;
  }, [fetchEntries]);

  // Handle flagging an entry and opening a conversation about it
  const handleFlag = useCallback(async (entryId: string) => {
    const entry = entries.find(candidate => candidate.id === entryId);
    if (!entry || entry.type !== 'evaluation') return;

    // Optimistic update
    setEntries(prev =>
      prev.map(e =>
        e.id === entryId && e.type === 'evaluation'
          ? { ...e, flagged: true }
          : e,
      ),
    );

    window.dispatchEvent(
      new CustomEvent('safety:flag-and-chat', {
        detail: { ...entry, flagged: true },
      }),
    );

    try {
      const result = await window.safetyActivityLogApi.flag({ entryId });
      if (!result.success) {
        fetchEntries();
      }
    } catch {
      fetchEntries();
    }
  }, [entries, fetchEntries]);

  // Handle unflagging an entry
  const handleUnflag = useCallback(async (entryId: string) => {
    // Optimistic update
    setEntries(prev =>
      prev.map(e =>
        e.id === entryId && e.type === 'evaluation'
          ? { ...e, flagged: false }
          : e,
      ),
    );

    try {
      const result = await window.safetyActivityLogApi.unflag({ entryId });
      if (!result.success) {
        fetchEntries();
      }
    } catch {
      fetchEntries();
    }
  }, [fetchEntries]);

  // Cloud-sync note for the populated list. We must guard against "false
  // completeness": while a cloud fetch is still pending (cloudSyncState === null)
  // OR after it failed/went offline, local entries alone can look like the full
  // record. Pending shows a calm "checking" note; failed/offline shows the
  // "hasn't synced" note. success / not-configured need no note.
  // (The empty + pending case is handled by the spinner-hold below, so by the
  // time the list renders with no entries cloudSyncState is no longer null.)
  const cloudSyncFailedOrOffline = cloudSyncState === 'failed' || cloudSyncState === 'offline';
  const cloudSyncPending = cloudSyncState === null;
  const cloudSyncNote = cloudSyncFailedOrOffline
    ? CLOUD_SYNC_NOTE
    : cloudSyncPending
      ? CLOUD_SYNC_PENDING_NOTE
      : null;
  const waitingForCloudSyncBeforeEmptyState = !loading && entries.length === 0 && cloudSyncState === null;

  // Loading state
  if (loading || waitingForCloudSyncBeforeEmptyState) {
    return (
      <div className={styles.flexCenter}>
        <Spinner size="sm" />
      </div>
    );
  }

  // Error state (no entries loaded)
  if (error && entries.length === 0) {
    return (
      <div className={styles.flexCenter}>
        <AlertTriangle size={16} style={{ color: 'var(--color-destructive)' }} />
        <span className={styles.errorText}>{error}</span>
      </div>
    );
  }

  // Empty state
  if (entries.length === 0) {
    // Only the failed/offline note belongs here — empty + pending was already
    // held on the spinner above, so we never claim "no actions" prematurely.
    if (cloudSyncFailedOrOffline) {
      return (
        <p className={styles.emptyState} data-testid="safety-activity-cloud-sync-note">
          {CLOUD_SYNC_NOTE}
        </p>
      );
    }

    return (
      <p className={styles.emptyState}>
        No actions taken yet — when Rebel does something on your behalf, you&apos;ll see the record here
      </p>
    );
  }

  // Normal state
  const visibleEntries = expanded ? entries : entries.slice(0, VISIBLE_COUNT);

  return (
    <>
      {cloudSyncNote && (
        <p className={styles.emptyState} data-testid="safety-activity-cloud-sync-note">
          {cloudSyncNote}
        </p>
      )}
      <div className={styles.activityLogList}>
        {visibleEntries.map(entry => (
          <SafetyActivityEntry
            key={entry.id}
            entry={entry}
            onFlag={
              entry.type === 'evaluation' && entry.decision === 'allowed' && !entry.flagged
                ? handleFlag
                : undefined
            }
            onUnflag={
              entry.type === 'evaluation' && entry.decision === 'allowed' && entry.flagged
                ? handleUnflag
                : undefined
            }
          />
        ))}
        {entries.length > VISIBLE_COUNT && !expanded && (
          <button
            type="button"
            className={styles.activityShowMore}
            onClick={() => setExpanded(true)}
          >
            Show more
          </button>
        )}
      </div>
    </>
  );
};
