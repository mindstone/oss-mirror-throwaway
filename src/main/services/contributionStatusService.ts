/**
 * Contribution Status Service
 *
 * Implements contribution status transport with fetch-on-mount pattern and
 * staleness cache. Each UI surface (MCPBuildCard, HomepagePanel,
 * NotificationDrawer) triggers a refresh on mount; the service checks
 * staleness (5 min threshold) and skips the API call if data is fresh.
 *
 * Features:
 * - Staleness check: no API call if < 5 min since lastCheckedAt
 * - Single-flight dedup: concurrent refreshes for the same contribution
 *   result in exactly one upstream status call
 * - PR status mapping: GitHub/relay PR state → ContributionStatus
 * - The contribution-specific GitHub transport is disabled for the OSS
 *   content scrub; relay-backed modes refresh only when the private relay
 *   extension is registered.
 *
 * @see docs/plans/260410_oss_mcp_integration_forward_plan.md (P4 + D1)
 */

import { createScopedLogger } from '@core/logger';
import {
  getContributionById,
  updateContribution,
} from '@core/services/contributionStore';
import type { ConnectorContribution, ContributionStatus } from '@core/services/contributionTypes';
import { getContributionRelayExtension } from '@core/services/contributionRelayExtension';
import { getOrGenerateAnonymousId, trackMainEvent } from '../analytics';

const log = createScopedLogger({ service: 'contribution-status-service' });

// ─── Constants ──────────────────────────────────────────────────────

/** Staleness threshold: 5 minutes in milliseconds. */
export const STALENESS_THRESHOLD_MS = 5 * 60 * 1000;
/** Backoff window after refresh failures to avoid rapid retries. */
export const REFRESH_FAILURE_COOLDOWN_MS = 60 * 1000;

const RELAY_ID_MISSING_MESSAGE =
  'Relay contribution ID is missing for this non-GitHub contribution';

const NON_COOLDOWN_ERRORS = new Set([
  'Contribution not found',
  'No PR URL — contribution not yet submitted',
  'Invalid PR URL format',
  'RELAY_ID_MISSING',
  'Contribution not found during update',
  'COOLDOWN',
  // IN_FLIGHT means the relay has accepted the submission but the PR is still
  // being created. The next poll should succeed, so don't penalise with a
  // 60s cooldown — staleness + single-flight already prevent hammering.
  'IN_FLIGHT',
]);

// ─── Types ──────────────────────────────────────────────────────────

export interface RefreshStatusResult {
  success: boolean;
  /** True if the refresh was skipped because data is fresh. */
  skipped?: boolean;
  contribution?: ConnectorContribution | null;
  error?: string;
  message?: string;
  /**
   * Set to `true` when the GitHub refresh path threw
   * `GitHubReAuthRequiredError` — the renderer uses this to render a
   * "Reconnect GitHub" action on the refresh-failure toast instead of a
   * dead-end error. Covers both normal expiry-without-usable-refresh-token
   * and legacy pre-refresh-rotation token records.
   */
  reAuthRequired?: boolean;
}

export interface RefreshStatusOptions {
  /** Bypass the staleness check and always fetch from the upstream status transport. */
  force?: boolean;
}

interface PRStatus {
  prState: 'open' | 'closed';
  merged: boolean;
  reviews: Array<{ state: string; user: string; body: string }>;
  checkRuns: Array<{ name: string; status: string; conclusion: string | null }>;
  htmlUrl: string;
}

// ─── Single-Flight Dedup ────────────────────────────────────────────

/**
 * Map of in-flight refresh promises keyed by contribution ID.
 * When a refresh is in progress for a given contribution, subsequent
 * callers receive the same promise instead of initiating a new API call.
 */
const inFlightRequests = new Map<string, Promise<RefreshStatusResult>>();
const failureCooldowns = new Map<string, number>();

function cooldownKey(
  contributionId: string,
  attributionMode: ConnectorContribution['attributionMode'],
): string {
  return `${contributionId}::${attributionMode}`;
}

function getActiveFailureCooldown(
  contributionId: string,
  attributionMode: ConnectorContribution['attributionMode'],
): number | null {
  const key = cooldownKey(contributionId, attributionMode);
  const expiresAt = failureCooldowns.get(key);
  if (expiresAt === undefined) {
    return null;
  }
  if (expiresAt <= Date.now()) {
    failureCooldowns.delete(key);
    return null;
  }
  return expiresAt;
}

function setFailureCooldown(
  contributionId: string,
  attributionMode: ConnectorContribution['attributionMode'],
): void {
  failureCooldowns.set(
    cooldownKey(contributionId, attributionMode),
    Date.now() + REFRESH_FAILURE_COOLDOWN_MS,
  );
}

function clearFailureCooldown(
  contributionId: string,
  attributionMode: ConnectorContribution['attributionMode'],
): void {
  failureCooldowns.delete(cooldownKey(contributionId, attributionMode));
}

function shouldApplyFailureCooldown(result: RefreshStatusResult): boolean {
  if (result.success || !result.error) {
    return false;
  }
  return !NON_COOLDOWN_ERRORS.has(result.error);
}

// ─── Staleness Check ────────────────────────────────────────────────

/**
 * Check if cached contribution data is stale.
 * Returns true if lastCheckedAt is missing, malformed, or older than the threshold.
 *
 * Defensively handles invalid timestamps:
 * - NaN (unparseable date string) → treated as stale
 * - Future timestamps (negative elapsed time) → treated as stale
 * This ensures a refresh is always triggered rather than skipping indefinitely.
 */
function isStale(lastCheckedAt: string | undefined): boolean {
  if (!lastCheckedAt) return true;
  const lastChecked = new Date(lastCheckedAt).getTime();
  if (Number.isNaN(lastChecked)) return true;
  const elapsed = Date.now() - lastChecked;
  if (elapsed < 0) return true;
  return elapsed >= STALENESS_THRESHOLD_MS;
}

function extractPRNumber(prUrl: string): number | null {
  const prNumberMatch = prUrl.match(/\/pull\/(\d+)/);
  if (!prNumberMatch) {
    return null;
  }

  return parseInt(prNumberMatch[1], 10);
}

// ─── PR Status → ContributionStatus Mapping ─────────────────────────

/**
 * Map GitHub PR status to ContributionStatus.
 *
 * Priority:
 * 1. Merged PR → published
 * 2. Closed (not merged) → rejected
 * 3. Open with APPROVED review → approved
 * 4. Open with CHANGES_REQUESTED review → changes_requested
 * 5. Open with any failed check → ci_fail
 * 6. Open with all checks passed → ci_pass
 * 7. Otherwise → keep current status (e.g., submitted while checks are pending)
 */
function mapPRStatusToContributionStatus(
  prStatus: PRStatus,
  currentStatus: ContributionStatus,
): { newStatus: ContributionStatus; reviewNotes?: string } {
  // Merged PR → published
  if (prStatus.merged) {
    return { newStatus: 'published' };
  }

  // Closed (not merged) → rejected
  if (prStatus.prState === 'closed') {
    return { newStatus: 'rejected' };
  }

  // Open PR — check reviews first (higher priority than CI)
  const hasApproval = prStatus.reviews.some((r) => r.state === 'APPROVED');
  const hasChangesRequested = prStatus.reviews.some((r) => r.state === 'CHANGES_REQUESTED');

  if (hasApproval) {
    return { newStatus: 'approved' };
  }

  if (hasChangesRequested) {
    // Collect review notes from all CHANGES_REQUESTED reviews
    const reviewNotes = prStatus.reviews
      .filter((r) => r.state === 'CHANGES_REQUESTED' && r.body)
      .map((r) => `${r.user}: ${r.body}`)
      .join('\n');

    return {
      newStatus: 'changes_requested',
      ...(reviewNotes ? { reviewNotes } : {}),
    };
  }

  // Check CI status
  const allChecksPassed = prStatus.checkRuns.length > 0 &&
    prStatus.checkRuns.every((c) => c.conclusion === 'success');
  const anyCheckFailed = prStatus.checkRuns.some((c) => c.conclusion === 'failure');

  if (anyCheckFailed) {
    return { newStatus: 'ci_fail' };
  }

  if (allChecksPassed) {
    return { newStatus: 'ci_pass' };
  }

  // Pending checks or no checks — keep current status
  return { newStatus: currentStatus };
}

// ─── Core Refresh Logic ─────────────────────────────────────────────

/**
 * Perform the actual GitHub API call and store update.
 * This is the inner function that does not handle dedup — the outer
 * refreshContributionStatus handles that.
 *
 * **Invariant** (Stage 1.1 of `docs/plans/260420_oss_mcp_backend_relay.md`):
 * `attributionMode` can be written to the store **before** a submission
 * succeeds — the renderer persists the user's choice (`runAttributedSubmit`
 * in `App.tsx`) before dispatching the unified submit. That means it's
 * normal for a status refresh to observe `attributionMode !== 'github'`
 * without a `relayContributionId`, or `attributionMode === 'github'`
 * without a `prUrl`, during the brief window between "user clicked an
 * option" and "submit completed". Both cases short-circuit to typed
 * failures below and must NOT be collapsed into a silent success — if
 * you're tempted to remove those guards, read Stage 1.1 C2 before doing
 * so. The refresh path is designed to fail closed when the transport
 * identifier isn't yet populated.
 */
async function doRefresh(contributionId: string): Promise<RefreshStatusResult> {
  const contribution = getContributionById(contributionId);
  if (!contribution) {
    return { success: false, error: 'Contribution not found' };
  }

  try {
    let prStatus: PRStatus;
    const relayExtension = contribution.attributionMode !== 'github'
      ? getContributionRelayExtension()
      : null;

    if (contribution.attributionMode === 'github') {
      return {
        success: false,
        error: 'GITHUB_SUBMISSION_UNAVAILABLE',
        message: 'GitHub account submission is not available in this build.',
      };
    } else {
      if (!relayExtension) {
        return {
          success: false,
          error: 'RELAY_UNAVAILABLE_OSS_BUILD',
          message: 'Contribution sharing through Rebel is not available in this build.',
        };
      }

      if (!contribution.relayContributionId) {
        return {
          success: false,
          error: 'RELAY_ID_MISSING',
          message: RELAY_ID_MISSING_MESSAGE,
        };
      }

      const relayResult = await relayExtension.refreshStatus(contribution.relayContributionId);
      if (!relayResult.success) {
        return {
          success: false,
          error: relayResult.error.code,
          message: relayResult.error.message,
        };
      }

      prStatus = relayResult.data;
    }

    const { newStatus, reviewNotes } = mapPRStatusToContributionStatus(
      prStatus,
      contribution.status,
    );

    // Build update payload
    const updates: Partial<Pick<ConnectorContribution, 'status' | 'lastCheckedAt' | 'reviewNotes'>> = {
      lastCheckedAt: new Date().toISOString(),
    };

    if (newStatus !== contribution.status) {
      updates.status = newStatus;
    }

    if (reviewNotes !== undefined) {
      updates.reviewNotes = reviewNotes;
    }

    const updated = updateContribution(contribution.id, updates);

    if (updated === undefined) {
      return { success: false, error: 'Contribution not found during update' };
    }

    if (updated === null) {
      log.warn(
        { contributionId, from: contribution.status, to: newStatus },
        'Refresh status computed invalid state transition',
      );
      return {
        success: false,
        error: `Invalid state transition from '${contribution.status}' to '${newStatus}'`,
      };
    }

    log.info(
      {
        contributionId,
        previousStatus: contribution.status,
        newStatus: updated.status,
        prNumber: extractPRNumber(prStatus.htmlUrl) ?? undefined,
      },
      'Contribution status refreshed',
    );

    // Broadened guard covers both (a) first-transition happy path and
    // (b) retry-after-failure (contribution locally at `published` without a
    // stamp). Server idempotency keeps retries safe; the stamp reflects
    // server-confirmed delivery so we stop chattering once acknowledged.
    const shouldAttemptEmail =
      updated.status === 'published' &&
      !updated.publishedEmailSentAt;

    if (shouldAttemptEmail) {
      if (!relayExtension?.notifyPublished) {
        log.info(
          { contributionId: updated.id },
          'Published-email hook skipped because no relay extension notifier is registered',
        );
      } else {
        try {
          const result = await relayExtension.notifyPublished(updated);
          if (result.sent || result.alreadySent) {
            const stamped = updateContribution(updated.id, {
              publishedEmailSentAt: new Date().toISOString(),
            });
            if (!stamped) {
              log.warn(
                { contributionId: updated.id },
                'Published-email confirmed but stamp failed; contribution may have been deleted mid-flight',
              );
            }
            trackMainEvent({
              anonymousId: getOrGenerateAnonymousId(),
              event: 'Contribution Published Email Sent',
              properties: {
                contributionId: updated.id,
                alreadySent: result.alreadySent ?? false,
              },
            });
          } else {
            log.warn(
              { contributionId: updated.id, reason: result.reason },
              'Published-email POST did not confirm send; will retry on next refresh',
            );
          }
        } catch (emailError) {
          log.error(
            { err: emailError, contributionId: updated.id },
            'Published-email hook threw unexpectedly; refresh succeeded, email will retry',
          );
        }
      }
    }

    return { success: true, contribution: updated };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    log.warn({ error, contributionId }, 'Failed to refresh contribution status');
    return { success: false, error: message };
  }
}

// ─── Public API ─────────────────────────────────────────────────────

/**
 * Refresh the contribution status from the appropriate upstream PR transport.
 *
 * 1. Checks staleness — skips if data is fresh (< 5 min since lastCheckedAt)
 * 2. Single-flight dedup — concurrent calls for the same contribution share one API call
 * 3. Maps GitHub / relay PR state to ContributionStatus
 * 4. Updates contribution store with new status and lastCheckedAt
 *
 * @param contributionId - The contribution to refresh
 * @param options - Optional settings (force bypass staleness check)
 */
export async function refreshContributionStatus(
  contributionId: string,
  options?: RefreshStatusOptions,
): Promise<RefreshStatusResult> {
  // Pre-flight validation — these don't need dedup
  const contribution = getContributionById(contributionId);
  if (!contribution) {
    return { success: false, error: 'Contribution not found' };
  }

  if (contribution.attributionMode === 'github' && !contribution.prUrl) {
    return { success: false, error: 'No PR URL — contribution not yet submitted' };
  }

  if (
    contribution.attributionMode !== 'github' &&
    !getContributionRelayExtension()
  ) {
    return {
      success: false,
      error: 'RELAY_UNAVAILABLE_OSS_BUILD',
      message: 'Contribution sharing through Rebel is not available in this build.',
    };
  }

  if (
    contribution.attributionMode !== 'github' &&
    !contribution.relayContributionId
  ) {
    log.warn(
      {
        contributionId: contribution.id,
        attributionMode: contribution.attributionMode,
      },
      'Relay-submitted contribution is missing relayContributionId',
    );
    return {
      success: false,
      error: 'RELAY_ID_MISSING',
      message: RELAY_ID_MISSING_MESSAGE,
    };
  }

  if (!options?.force) {
    const activeCooldown = getActiveFailureCooldown(
      contributionId,
      contribution.attributionMode,
    );
    if (activeCooldown !== null) {
      return {
        success: false,
        error: 'COOLDOWN',
        message: 'Refresh recently failed; will retry shortly',
      };
    }
  }

  // Staleness check (unless force is true)
  if (!options?.force && !isStale(contribution.lastCheckedAt)) {
    return {
      success: true,
      skipped: true,
      contribution,
    };
  }

  // Single-flight dedup — if a refresh is already in progress for this contribution,
  // return the same promise instead of starting a new API call
  const existingRequest = inFlightRequests.get(contributionId);
  if (existingRequest) {
    return existingRequest;
  }

  // Start new refresh and track it
  const refreshPromise = doRefresh(contributionId)
    .then((result) => {
      if (result.success) {
        clearFailureCooldown(contributionId, contribution.attributionMode);
        return result;
      }

      if (shouldApplyFailureCooldown(result)) {
        setFailureCooldown(contributionId, contribution.attributionMode);
      }

      return result;
    })
    .finally(() => {
      // Clean up the in-flight entry once the request completes
      inFlightRequests.delete(contributionId);
    });

  inFlightRequests.set(contributionId, refreshPromise);

  return refreshPromise;
}

// ─── Testing ────────────────────────────────────────────────────────

/** Reset internal state for testing. */
export function _resetForTesting(): void {
  inFlightRequests.clear();
  failureCooldowns.clear();
}
