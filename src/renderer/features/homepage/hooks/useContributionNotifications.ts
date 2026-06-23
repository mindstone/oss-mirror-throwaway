/**
 * Hook to derive contribution notification data from the contribution store.
 *
 * Provides:
 * - PRApprovedBanner props for HomepagePanel (approved/published, not dismissed on banner surface)
 * - MCPNotificationCard items for NotificationDrawer/InboxPanel (status transitions not dismissed on drawer surface)
 *
 * Per-surface dismissal independence: banner dismissal doesn't suppress drawer and vice versa.
 *
 * @see docs/plans/260410_oss_mcp_integration_forward_plan.md (P6)
 */

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import type { PRApprovedBannerProps } from '../components/PRApprovedBanner';
import type { MCPNotificationState } from '@renderer/features/inbox/components/MCPNotificationCard';
import {
  BANNER_STATUSES,
  DRAWER_NOTIFICATION_STATUSES,
  toNotificationState,
  isAcknowledged,
} from '@shared/utils/contributionNotificationDerivation';
import { computeEmfileBackoffDelay, isEmfileError } from '@renderer/utils/emfileBackoff';

// Re-export derivation functions/constants for consumers that import from this hook
export { BANNER_STATUSES, DRAWER_NOTIFICATION_STATUSES, toNotificationState, isAcknowledged };

/** Contribution record shape mirrored from shared types (no @core/ dependency). */
interface ContributionRecord {
  id: string;
  sessionId: string;
  connectorName: string;
  status: string;
  reviewNotes?: string;
  prUrl?: string;
  updatedAt?: string;
  acknowledgedEvents: Array<{
    status: string;
    surface: string;
    at: string;
  }>;
}

const contributionPollIdentity = (contribution: ContributionRecord): string =>
  `${contribution.id}:${contribution.updatedAt ?? ''}:${contribution.status}`;

const arraysShallowEqualByKey = <T,>(
  prev: T[],
  next: T[],
  keyFn: (item: T) => string,
): boolean => {
  if (prev === next) return true;
  if (prev.length !== next.length) return false;
  for (let i = 0; i < prev.length; i += 1) {
    if (keyFn(prev[i]) !== keyFn(next[i])) {
      return false;
    }
  }
  return true;
};

/** A notification card item derived from the contribution store. */
export interface ContributionNotificationItem {
  /** Unique key for React rendering. */
  key: string;
  /** The contribution ID for dismissal. */
  contributionId: string;
  /** The MCPNotificationCard visual state. */
  state: MCPNotificationState;
  /** Connector name for display. */
  connectorName: string;
  /** Review notes (for changes-requested / rejected). */
  reviewNotes?: string;
  /** GitHub PR URL. */
  prUrl?: string;
  /** The contribution status this notification represents. */
  contributionStatus: string;
  /** The original build session ID (for follow-up session linking). */
  sessionId: string;
}

/** Polling interval for contribution data (ms). */
const POLL_INTERVAL_MS = 3000;
/**
 * Number of consecutive EMFILE/ENFILE failures before the polling loop
 * switches to a longer cooldown so the OS can recover file descriptors.
 * REBEL-1HF: prevents this hook from amplifying main-process FD pressure.
 */
const EMFILE_PAUSE_AFTER_ATTEMPTS = 5;
/** Delay applied once `EMFILE_PAUSE_AFTER_ATTEMPTS` is reached (ms). */
const EMFILE_COOLDOWN_DELAY_MS = 60_000;

export interface ContributionNotificationsResult {
  /** PRApprovedBanner props, or null if no banner should show. */
  bannerProps: PRApprovedBannerProps | null;
  /** Notification card items for the drawer/inbox. */
  drawerNotifications: ContributionNotificationItem[];
  /** Dismiss a contribution event on the banner surface. */
  dismissBanner: (contributionId: string, status: string) => void;
  /** Dismiss a contribution event on the drawer surface. */
  dismissDrawer: (contributionId: string, status: string) => void;
}

/**
 * Derives banner and notification data from the contribution store via IPC.
 *
 * @param enabled - Whether to fetch data (allows pausing when surface is not visible).
 */
export function useContributionNotifications(enabled = true): ContributionNotificationsResult {
  const [contributions, setContributions] = useState<ContributionRecord[]>([]);
  // REBEL-1HF: tracks consecutive EMFILE/ENFILE polling failures so we can
  // back off exponentially when the main process is under file-descriptor
  // pressure. Reset on every successful poll. Lives in a ref because the
  // recursive setTimeout closure reads/writes it across ticks.
  const consecutiveEmfileFailuresRef = useRef(0);

  // Fetch contributions from store via IPC. REBEL-1HF: switched from
  // setInterval to recursive setTimeout so the delay can adapt when the
  // main process surfaces EMFILE/ENFILE errors. Each poll waits for the
  // previous fetch to resolve before scheduling the next one (prevents
  // overlapping fetches when main is slow).
  useEffect(() => {
    if (!enabled) return;

    let cancelled = false;
    let pollTimer: ReturnType<typeof setTimeout> | null = null;

    const fetchContributions = async () => {
      try {
        const result = await window.contributionApi.list({});
        if (cancelled) return;
        // REBEL-1HF: the main-process store catches EMFILE internally and
        // returns success-shaped data, so the IPC promise resolves even
        // during FD exhaustion. The `fdExhausted` envelope flag is the
        // post-success signal we use to ratchet up the backoff. When
        // it's true we increment the streak; when it's false/absent we
        // reset to 0 as the normal success path does.
        if (result.fdExhausted) {
          consecutiveEmfileFailuresRef.current += 1;
          console.warn(
            '[useContributionNotifications] contribution store reports FD exhaustion - backing off',
            { consecutiveFailures: consecutiveEmfileFailuresRef.current },
          );
        } else {
          consecutiveEmfileFailuresRef.current = 0;
        }
        const nextContributions = result.contributions as unknown as ContributionRecord[];
        setContributions((prev) =>
          arraysShallowEqualByKey(prev, nextContributions, contributionPollIdentity)
            ? prev
            : nextContributions,
        );
      } catch (err) {
        if (cancelled) return;
        // Secondary defense: IPC transport errors that surface EMFILE
        // strings still increment the backoff streak. Other errors are
        // logged but don't trigger backoff (they don't carry the same
        // "stop polling" signal).
        if (isEmfileError(err)) {
          consecutiveEmfileFailuresRef.current += 1;
          console.warn(
            '[useContributionNotifications] EMFILE/ENFILE during contribution poll - backing off',
            {
              consecutiveFailures: consecutiveEmfileFailuresRef.current,
              error: String(err),
            },
          );
        }
      }
    };

    const scheduleNext = (): void => {
      if (cancelled) return;
      const delay = computeEmfileBackoffDelay(consecutiveEmfileFailuresRef.current, {
        baseDelayMs: POLL_INTERVAL_MS,
        pauseAfterAttempts: EMFILE_PAUSE_AFTER_ATTEMPTS,
        cooldownDelayMs: EMFILE_COOLDOWN_DELAY_MS,
      });
      pollTimer = setTimeout(() => {
        pollTimer = null;
        if (cancelled) return;
        void fetchContributions().finally(() => {
          if (cancelled) return;
          scheduleNext();
        });
      }, delay);
    };

    // Initial fetch runs immediately, matching the prior setInterval cadence.
    void fetchContributions().finally(() => {
      if (cancelled) return;
      scheduleNext();
    });

    return () => {
      cancelled = true;
      if (pollTimer !== null) {
        clearTimeout(pollTimer);
        pollTimer = null;
      }
      // Reset the streak on unmount/disable so re-mounting starts fresh.
      consecutiveEmfileFailuresRef.current = 0;
    };
  }, [enabled]);

  // Derive banner props from contributions
  const bannerContribution = useMemo(() => {
    // Find the most recently updated contribution with approved/published status
    // that hasn't been dismissed on the banner surface.
    // Sort by updatedAt descending so the newest contribution is shown first.
    const eligible = contributions
      .filter(
        (c) =>
          BANNER_STATUSES.has(c.status) &&
          !isAcknowledged(c, c.status, 'banner'),
      )
      .sort((a, b) => {
        const aTime = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
        const bTime = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
        return bTime - aTime; // newest first
      });
    return eligible[0] ?? null;
  }, [contributions]);

  // Dismiss banner callback
  const dismissBanner = useCallback((contributionId: string, status: string) => {
    void window.contributionApi.dismiss({
      contributionId,
      status: status as 'approved' | 'published',
      surface: 'banner',
    });
    // Optimistic update
    setContributions((prev) =>
      prev.map((c) =>
        c.id === contributionId
          ? {
              ...c,
              acknowledgedEvents: [
                ...c.acknowledgedEvents,
                { status, surface: 'banner', at: new Date().toISOString() },
              ],
            }
          : c,
      ),
    );
  }, []);

  // Dismiss drawer callback
  const dismissDrawer = useCallback((contributionId: string, status: string) => {
    void window.contributionApi.dismiss({
      contributionId,
      status: status as 'ci_pass' | 'ci_fail' | 'approved' | 'changes_requested' | 'rejected',
      surface: 'drawer',
    });
    // Optimistic update
    setContributions((prev) =>
      prev.map((c) =>
        c.id === contributionId
          ? {
              ...c,
              acknowledgedEvents: [
                ...c.acknowledgedEvents,
                { status, surface: 'drawer', at: new Date().toISOString() },
              ],
            }
          : c,
      ),
    );
  }, []);

  // Build banner props
  const bannerProps: PRApprovedBannerProps | null = useMemo(() => {
    if (!bannerContribution) return null;
    return {
      connectorName: bannerContribution.connectorName,
      onDismiss: () => dismissBanner(bannerContribution.id, bannerContribution.status),
    };
  }, [bannerContribution, dismissBanner]);

  // Derive drawer notification items
  const drawerNotifications: ContributionNotificationItem[] = useMemo(() => {
    const items: ContributionNotificationItem[] = [];
    for (const contribution of contributions) {
      if (
        DRAWER_NOTIFICATION_STATUSES.has(contribution.status) &&
        !isAcknowledged(contribution, contribution.status, 'drawer')
      ) {
        const state = toNotificationState(contribution.status);
        if (state) {
          items.push({
            key: `mcp-notification-${contribution.id}-${contribution.status}`,
            contributionId: contribution.id,
            state,
            connectorName: contribution.connectorName,
            reviewNotes: contribution.reviewNotes,
            prUrl: contribution.prUrl,
            contributionStatus: contribution.status,
            sessionId: contribution.sessionId,
          });
        }
      }
    }
    return items;
  }, [contributions]);

  return { bannerProps, drawerNotifications, dismissBanner, dismissDrawer };
}
