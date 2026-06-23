/**
 * Contribution Domain IPC Handlers
 *
 * Wires all contribution IPC channels to their respective services:
 * - Submission channels → contributionSubmitDispatcher (branches on attributionMode)
 * - Store read channels → contributionStore
 * - Store write channels → contributionStore
 * - Dismiss channel → contributionStore acknowledgeEvent
 *
 * `contribution:submit-unified` is the canonical submit channel; the
 * legacy `contribution:submit` and `contribution:submit-from-store`
 * channels remain as thin deprecated adapters for one release cycle.
 *
 * @see src/main/services/contributionSubmitDispatcher.ts
 * @see src/core/services/contributionStore.ts
 * @see src/core/services/contributionRelayExtension.ts
 * @see docs/plans/260410_oss_mcp_integration_forward_plan.md (P4.5)
 * @see docs/plans/260420_oss_mcp_backend_relay.md (Stage 2)
 */

import { registerHandler } from './utils/registerHandler';
import { contributionChannels } from '@shared/ipc/channels/contribution';
import { createScopedLogger } from '@core/logger';
import {
  listContributions,
  getActiveContributionBySession,
  getContributionsBySession,
  updateContribution,
  acknowledgeEvent,
  addLinkedSession,
  deleteContribution,
  isContributionStoreFdExhausted,
} from '@core/services/contributionStore';
import {
  createFollowUpSessionContext,
} from '@core/services/contributionFollowUpService';
import {
  submitContribution,
  type SubmitContributionResult,
} from '../services/contributionSubmitDispatcher';
import { refreshContributionStatus } from '../services/contributionStatusService';
import { getOrGenerateAnonymousId, trackMainEvent } from '../analytics';

const log = createScopedLogger({ service: 'contributionHandlers' });

/**
 * Re-shape the dispatcher's typed result into the legacy flat response
 * used by `contribution:submit` and `contribution:submit-from-store`
 * (`{ success, prUrl, prNumber, error, reAuthRequired }`). Exists only
 * to keep backward compatibility with existing renderer callers during
 * the Stage 2 rollout; delete with the legacy handlers when they go.
 */
function reshapeToLegacySubmitResponse(
  result: SubmitContributionResult,
): {
  success: boolean;
  prUrl?: string;
  prNumber?: number;
  error?: string;
  reAuthRequired?: boolean;
} {
  if (result.success) {
    if (result.degraded) {
      log.warn(
        { degraded: result.degraded, prUrl: result.prUrl, prNumber: result.prNumber },
        'Legacy contribution submit adapter returning success from degraded persistence result',
      );
    }
    return {
      success: true,
      prUrl: result.prUrl,
      prNumber: result.prNumber,
    };
  }
  return {
    success: false,
    error: result.error.message,
    ...(result.reAuthRequired ? { reAuthRequired: true } : {}),
  };
}

function trackDeprecatedChannelInvocation(
  channel: 'contribution:submit' | 'contribution:submit-from-store',
): void {
  trackMainEvent({
    anonymousId: getOrGenerateAnonymousId(),
    event: 'deprecated.ipc.invoked',
    properties: {
      channel,
      caller: 'renderer',
    },
  });
  log.info(
    { channel, caller: 'renderer' },
    'Deprecated contribution IPC channel invoked',
  );
}

export function registerContributionHandlers(): void {
  // ── Submit (unified) ─────────────────────────────────────────────
  // Single entry point that branches on `attributionMode`:
  //   - 'github' → disabled in OSS-scrubbed builds
  //   - 'rebel-name' | 'anonymous' → private relay extension when registered
  // See `contributionSubmitDispatcher.ts` for the routing logic.
  const submitUnifiedChannel = contributionChannels['contribution:submit-unified'];
  registerHandler(submitUnifiedChannel.channel, async (_event, ...args) => {
    const validated = submitUnifiedChannel.request.parse(args[0]);
    return submitContribution(validated.contributionId, {
      desiredAttributionMode: validated.desiredAttributionMode,
      desiredAttributionName: validated.desiredAttributionName,
    });
  });

  // ── Submit: Fork, push files, create PR (DEPRECATED adapter) ────
  // TODO(260420 Stage 2 follow-up): remove once all renderer callers have
  // migrated to `contribution:submit-unified`. See plan doc.
  //
  // The legacy channel accepted pre-read files + explicit title/body; the
  // dispatcher reads from disk via `contributionFileReader` and derives
  // PR metadata from the contribution record. We emit telemetry on every
  // invocation and re-shape the result to the legacy flat error
  // surface so existing renderer callers continue to work unmodified.
  const submitChannel = contributionChannels['contribution:submit'];
  registerHandler(submitChannel.channel, async (_event, ...args) => {
    trackDeprecatedChannelInvocation('contribution:submit');
    const validated = submitChannel.request.parse(args[0]);
    const result = await submitContribution(validated.contributionId);
    return reshapeToLegacySubmitResponse(result);
  });

  // ── Submit from store (DEPRECATED adapter) ──────────────────────
  // TODO(260420 Stage 2 follow-up): remove once all renderer callers have
  // migrated to `contribution:submit-unified`. See plan doc.
  const submitFromStoreChannel = contributionChannels['contribution:submit-from-store'];
  registerHandler(submitFromStoreChannel.channel, async (_event, ...args) => {
    trackDeprecatedChannelInvocation('contribution:submit-from-store');
    const validated = submitFromStoreChannel.request.parse(args[0]);
    const result = await submitContribution(validated.contributionId);
    return reshapeToLegacySubmitResponse(result);
  });

  // ── Refresh: Check PR status from GitHub ────────────────────────
  // Delegates to contributionStatusService which handles staleness check
  // (5 min threshold), single-flight dedup, and PR status mapping.
  const refreshStatusChannel = contributionChannels['contribution:refresh-status'];
  registerHandler(refreshStatusChannel.channel, async (_event, ...args) => {
    const validated = refreshStatusChannel.request.parse(args[0]);
    return refreshContributionStatus(validated.contributionId, { force: validated.force });
  });

  // ── Store read: List all contributions ──────────────────────────
  // REBEL-1HF: `loadContributions()` catches EMFILE/ENFILE internally and
  // serves cached/empty data without throwing, so this catch block almost
  // never fires for FD exhaustion. The renderer's `isEmfileError(err)`
  // check on the IPC catch path was therefore dead code. We forward the
  // store's post-EMFILE "awaiting hydration" state explicitly through
  // `fdExhausted` so renderer pollers can ratchet up their backoff. The
  // field is conditionally spread (only included when truthy) to keep the
  // existing strict-equality test (`expect(result).toEqual({ contributions: [] })`)
  // green in normal operation.
  const listChannel = contributionChannels['contribution:list'];
  registerHandler(listChannel.channel, async () => {
    try {
      const contributions = listContributions();
      return {
        contributions,
        ...(isContributionStoreFdExhausted() ? { fdExhausted: true } : {}),
      };
    } catch (error) {
      log.warn({ error }, 'Failed to list contributions');
      return {
        contributions: [],
        ...(isContributionStoreFdExhausted() ? { fdExhausted: true } : {}),
      };
    }
  });

  // ── Store read: Get contribution by session ID ──────────────────
  // Stage 2.D (260426): renderer reads use the active-session lookup
  // (most-recently-updated linked record) rather than the legacy
  // first-match compat shim. This is renderer-facing UX consistency:
  // when a session is linked to multiple contributions, the renderer
  // shows the one the user most recently touched.
  const getBySessionChannel = contributionChannels['contribution:get-by-session'];
  registerHandler(getBySessionChannel.channel, async (_event, ...args) => {
    const validated = getBySessionChannel.request.parse(args[0]);
    try {
      // Stage 4 (260426): surface the count of ALL contributions whose
      // `linkedSessionIds` includes this session, so the renderer can warn
      // once per growth transition when a session has multiple builds
      // (matrix #25). Telemetry-only — no UX change today; the renderer
      // shows the active record only.
      //
      // Footer-question suppression follow-on (260427): also surface the
      // connector names of those linked contributions so the renderer can
      // suppress the `suggest_connector_setup` footer card once a build
      // exists for the same connector (regardless of status).
      // See docs/plans/260427_contribution_flow_followon_self_block_at_registration.md.
      const contribution = getActiveContributionBySession(validated.sessionId) ?? null;
      const linkedContributions = getContributionsBySession(validated.sessionId);
      const linkedContributionsCount = linkedContributions.length;
      const linkedContributionConnectorNames = linkedContributions.map((c) => c.connectorName);
      // REBEL-1HF: see `contribution:list` rationale — surface FD-exhaustion
      // state explicitly so the renderer can back off its 2s poll loop.
      // Conditionally spread so existing tests that strict-equality the
      // response shape stay green in normal operation.
      return {
        contribution,
        linkedContributionsCount,
        linkedContributionConnectorNames,
        ...(isContributionStoreFdExhausted() ? { fdExhausted: true } : {}),
      };
    } catch (error) {
      log.warn({ error, sessionId: validated.sessionId }, 'Failed to get contribution by session');
      return {
        contribution: null,
        linkedContributionsCount: 0,
        linkedContributionConnectorNames: [],
        ...(isContributionStoreFdExhausted() ? { fdExhausted: true } : {}),
      };
    }
  });

  // ── Store write: Update local contribution state ────────────────
  const updateLocalStateChannel = contributionChannels['contribution:update-local-state'];
  registerHandler(updateLocalStateChannel.channel, async (_event, ...args) => {
    const validated = updateLocalStateChannel.request.parse(args[0]);
    try {
      const result = updateContribution(validated.contributionId, validated.updates);

      if (result === undefined) {
        return { success: false, error: 'Contribution not found' };
      }
      if (result === null) {
        return { success: false, error: 'Invalid state transition' };
      }

      return { success: true, contribution: result };
    } catch (error) {
      log.warn({ error, contributionId: validated.contributionId }, 'Failed to update contribution local state');
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  });

  // ── Dismiss: Acknowledge event on specific surface ──────────────
  const dismissChannel = contributionChannels['contribution:dismiss'];
  registerHandler(dismissChannel.channel, async (_event, ...args) => {
    const validated = dismissChannel.request.parse(args[0]);
    try {
      acknowledgeEvent(validated.contributionId, validated.status, validated.surface);
      return { success: true };
    } catch (error) {
      log.warn({ error, contributionId: validated.contributionId }, 'Failed to dismiss contribution');
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  });

  // ── Delete: Operator-initiated stuck-contribution recovery ────
  // Stage 5 affordance — operator clicks "Discard" in Settings. Files on
  // disk are untouched; only the store record is removed.
  const deleteChannel = contributionChannels['contribution:delete'];
  registerHandler(deleteChannel.channel, async (_event, ...args) => {
    const validated = deleteChannel.request.parse(args[0]);
    try {
      const deleted = deleteContribution(validated.contributionId);
      return { success: true, deleted };
    } catch (error) {
      log.warn({ error, contributionId: validated.contributionId }, 'Failed to delete contribution');
      return {
        success: false,
        deleted: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  });

  // ── Follow-up: Create follow-up session context ──────────────
  const createFollowUpContextChannel = contributionChannels['contribution:create-follow-up-context'];
  registerHandler(createFollowUpContextChannel.channel, async (_event, ...args) => {
    const validated = createFollowUpContextChannel.request.parse(args[0]);
    try {
      const context = createFollowUpSessionContext(validated.contributionId);
      return { context };
    } catch (error) {
      log.warn({ error, contributionId: validated.contributionId }, 'Failed to create follow-up context');
      return { context: null };
    }
  });

  // ── Follow-up: Link follow-up session to contribution ──────────
  const linkFollowUpSessionChannel = contributionChannels['contribution:link-follow-up-session'];
  registerHandler(linkFollowUpSessionChannel.channel, async (_event, ...args) => {
    const validated = linkFollowUpSessionChannel.request.parse(args[0]);
    try {
      const result = addLinkedSession(validated.contributionId, validated.followUpSessionId);
      if (!result) {
        return { success: false, error: 'Contribution not found' };
      }
      return { success: true };
    } catch (error) {
      log.warn({ error, contributionId: validated.contributionId }, 'Failed to link follow-up session');
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  });

  log.info('Contribution IPC handlers registered (14 channels, incl. deprecated submit adapters)');
}
