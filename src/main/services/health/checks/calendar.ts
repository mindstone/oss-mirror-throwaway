/**
 * Calendar Health Checks
 *
 * Checks for calendar cache and sync health.
 *
 * Stage 3, 260611_calendar-followups: typed-first reader.
 * - `syncIssues` (typed, written at the Stage-2 chokepoints) is the
 *   authority whenever the KEY IS PRESENT — emptiness does not hand
 *   authority back to the legacy strings (a new-build write always sets
 *   both fields atomically; stray legacy content under a present typed key
 *   is skew and must not resurrect the string path).
 * - All display copy (message/remediation/details.syncWarnings) derives
 *   from `SyncIssueDisplayProjection`, which has NO `detail` field — the
 *   copy-derivation code literally cannot receive diagnostics text
 *   ([Claude-ruling/RS] binding amendment).
 * - The legacy-string fallback (typed key absent = pre-update cache, a
 *   ≤15-min self-healing window) classifies/counts only: raw string
 *   content NEVER reaches any check output (kills the old
 *   extractConnectorName raw-fallback email leak).
 */

import type { CheckResult } from '../types';
import { getMeetingCacheState } from '../../meetingCacheStore';
import { SyncIssueSchema, scrubSyncDetailText, type SyncIssueConnector, type SyncIssueCause } from '@shared/ipc/channels/calendar';
import { parseMultiInstanceServer } from '@shared/utils/mcpInstanceUtils';
import {
  hasCalendarSyncBeenAttempted,
  isWithinFreshProfileSuppressionWindow,
} from '@core/services/calendarSyncAttempt';

const DISPLAY_NAMES: Record<string, string> = {
  GoogleWorkspace: 'Google Workspace',
  Microsoft365Calendar: 'Microsoft 365 Calendar',
  Microsoft365Mail: 'Microsoft 365 Mail',
};

function displayName(serverName: string): string {
  return DISPLAY_NAMES[serverName] ?? serverName;
}

// =============================================================================
// Typed path — projection-enforced display derivation
// =============================================================================

/**
 * Display projection of a `SyncIssue`. Deliberately EXCLUDES `detail` and
 * `accountRef`: deriving copy from this type makes it impossible for
 * diagnostics text (raw error messages, which can embed emails) to reach
 * `message`/`remediation`/`details` — the leak is dead by construction,
 * not by discipline.
 */
type SyncIssueDisplayProjection =
  | { kind: 'auth_transient'; connector: SyncIssueConnector }
  | { kind: 'calendar_fetch_failed'; connector: SyncIssueConnector; cause?: SyncIssueCause }
  | { kind: 'account_sync_failed'; connector: SyncIssueConnector; cause?: SyncIssueCause }
  | { kind: 'bridge_reported' }
  | { kind: 'validation_skipped'; count: number }
  /** Fail-closed bucket: zod-invalid or unknown-kind persisted elements. */
  | { kind: 'unreadable' };

/**
 * Project one persisted element (treated as untrusted: per-element
 * `safeParse`, fail-closed) down to its display-safe fields.
 */
function projectSyncIssue(raw: unknown): SyncIssueDisplayProjection {
  const parsed = SyncIssueSchema.safeParse(raw);
  if (!parsed.success) return { kind: 'unreadable' };
  const issue = parsed.data;
  switch (issue.kind) {
    case 'auth_transient':
      return { kind: issue.kind, connector: issue.connector };
    case 'calendar_fetch_failed':
      return { kind: issue.kind, connector: issue.connector, cause: issue.cause };
    case 'account_sync_failed':
      return { kind: issue.kind, connector: issue.connector, cause: issue.cause };
    case 'bridge_reported':
      return { kind: issue.kind };
    case 'validation_skipped':
      return { kind: issue.kind, count: issue.count };
  }
}

/**
 * Derive deduped, count-aware display lines + the closed-set connector
 * names from projections ONLY (the signature is the enforcement: no
 * `detail` can arrive here). Same-class issues collapse into one line with
 * a count (N transient-auth accounts → one message, not N near-identical
 * lines).
 */
function deriveDisplayLines(projections: SyncIssueDisplayProjection[]): {
  lines: string[];
  connectorServerNames: string[];
  /** Any failure the user may need to ACT on (a real connection/permission problem). */
  hasConnectionProblem: boolean;
  /** Any transient/self-healing failure (network blip, or token-refresh backoff). */
  hasTransientFailure: boolean;
} {
  // Group by class in first-seen order.
  const classCounts = new Map<string, { projection: SyncIssueDisplayProjection; count: number }>();
  const connectorServerNames: string[] = [];
  let hasConnectionProblem = false;
  let hasTransientFailure = false;

  for (const projection of projections) {
    // network-caused fetch/sync failures (and the inherently-retrying
    // auth_transient class) are TRANSIENT — usually self-healing, so copy must
    // not blame the connection (260617_calendar-cache-transient-debounce).
    // Everything else in the fetch/sync failure family (cause 'account' or
    // unknown) is a connection problem the user may need to act on.
    const isNetwork =
      (projection.kind === 'calendar_fetch_failed' || projection.kind === 'account_sync_failed') &&
      projection.cause === 'network';
    if (projection.kind === 'auth_transient' || isNetwork) {
      hasTransientFailure = true;
    } else if (projection.kind === 'calendar_fetch_failed' || projection.kind === 'account_sync_failed') {
      hasConnectionProblem = true;
    }

    const causeKey =
      projection.kind === 'calendar_fetch_failed' || projection.kind === 'account_sync_failed'
        ? (projection.cause === 'network' ? 'network' : 'account')
        : '';
    const classKey = 'connector' in projection
      ? `${projection.kind}:${projection.connector}:${causeKey}`
      : projection.kind;
    const entry = classCounts.get(classKey);
    if (entry) {
      entry.count += 1;
      // validation_skipped carries its own count — sum, don't tally elements.
      if (entry.projection.kind === 'validation_skipped' && projection.kind === 'validation_skipped') {
        entry.projection = { kind: 'validation_skipped', count: entry.projection.count + projection.count };
      }
    } else {
      classCounts.set(classKey, { projection: { ...projection }, count: 1 });
    }
    if ('connector' in projection && !connectorServerNames.includes(projection.connector)) {
      connectorServerNames.push(projection.connector);
    }
  }

  const lines = [...classCounts.values()].map(({ projection, count }) => {
    switch (projection.kind) {
      case 'auth_transient': {
        const name = displayName(projection.connector);
        return count === 1
          ? `${name}: account token refresh is temporarily unavailable; retrying with backoff`
          : `${name}: token refresh is temporarily unavailable for ${count} accounts; retrying with backoff`;
      }
      case 'calendar_fetch_failed': {
        const name = displayName(projection.connector);
        if (projection.cause === 'network') {
          return count === 1
            ? `${name}: couldn't reach the calendar service (network issue)`
            : `${name}: ${count} calendars couldn't be reached (network issue)`;
        }
        return count === 1
          ? `${name}: a calendar could not be fetched during sync`
          : `${name}: ${count} calendars could not be fetched during sync`;
      }
      case 'account_sync_failed': {
        const name = displayName(projection.connector);
        if (projection.cause === 'network') {
          return count === 1
            ? `${name}: temporarily unreachable (network issue)`
            : `${name}: ${count} accounts temporarily unreachable (network issue)`;
        }
        return count === 1
          ? `${name}: account sync failed`
          : `${name}: sync failed for ${count} accounts`;
      }
      case 'bridge_reported':
        return count === 1
          ? 'A calendar source reported a sync problem'
          : `${count} calendar sources reported sync problems`;
      case 'validation_skipped':
        return `${projection.count} meeting(s) skipped due to validation errors`;
      case 'unreadable':
        return count === 1
          ? 'A calendar sync issue could not be read'
          : `${count} calendar sync issues could not be read`;
    }
  });

  return { lines, connectorServerNames, hasConnectionProblem, hasTransientFailure };
}

// =============================================================================
// Legacy fallback — classification only, never echo
// =============================================================================

/**
 * Fallback-classification-only successor to the old `extractConnectorName`:
 * maps a legacy warning string to a CLOSED-SET connector base name, or null.
 * The old raw-prefix fallback (which echoed full emails/slugs into
 * remediation copy) is gone — an unclassifiable string contributes to the
 * generic count only, and its content never reaches any check output.
 */
function classifyLegacyWarning(warning: string): string | null {
  const colonIdx = warning.indexOf(':');
  if (colonIdx <= 0) return null;
  const prefix = warning.slice(0, colonIdx).trim();
  if (!prefix) return null;
  const parsed = parseMultiInstanceServer(prefix);
  return parsed.isInstance && parsed.baseName ? parsed.baseName : null;
}

function remediationFor(connectorServerNames: string[]): string {
  return connectorServerNames.length > 0
    ? `Check your ${connectorServerNames.map(displayName).join(' and ')} connection in Settings > Connectors.`
    : 'Check your calendar connections in Settings > Connectors.';
}

/**
 * Honest copy for transient/network failures (260617_calendar-cache-transient-debounce):
 * a network blip is not a connection problem, so don't send the user to the
 * connectors panel where everything looks fine. By the time this surfaces the
 * failure has been sustained (debounced past the threshold), so "keep retrying"
 * is accurate.
 */
const TRANSIENT_SYNC_REMEDIATION =
  "Rebel couldn't reach your calendar just now. This is usually a brief network issue, and it'll keep retrying automatically.";

/**
 * Check calendar cache health.
 * Reports warnings if calendar sources failed during sync.
 */
export function checkCalendarCacheHealth(): CheckResult {
  const state = getMeetingCacheState();

  // No cache at all — calendar sync hasn't produced one yet.
  if (state.populatedAt === null) {
    // Fresh-profile gate (B1, time-bounded): before any sync attempt this
    // session AND within the bounded post-boot window, "no cache yet" is the
    // expected state (first direct sync fires at boot+30s; the first health
    // poll at +10s used to race it into a false warn). Past the bound, a
    // never-attempting scheduler is wedged and MUST surface.
    if (!hasCalendarSyncBeenAttempted() && isWithinFreshProfileSuppressionWindow()) {
      return {
        id: 'calendarCacheHealth',
        name: 'Calendar Cache',
        status: 'pass',
        message: 'Calendar sync has not started yet (first sync pending)',
      };
    }
    // Attempted-but-null is a TRUE positive: a thrown direct sync never
    // calls recordSyncError, so this branch is the only signal for that
    // failure shape. EMFILE cousin (accepted residual, map F7): a transient
    // store read failure mid-session makes populatedAt null with
    // attempted=true → warn + transition toast, same as before Stage 3.
    return {
      id: 'calendarCacheHealth',
      name: 'Calendar Cache',
      status: 'warn',
      message: 'Calendar sync has not run yet',
    };
  }

  // Typed sync issues: authoritative whenever the key is PRESENT (key
  // presence, not emptiness — see module doc).
  if (state.syncIssues !== undefined) {
    if (state.syncIssues.length > 0) {
      const projections = (state.syncIssues as unknown[]).map(projectSyncIssue);
      const { lines, connectorServerNames, hasConnectionProblem, hasTransientFailure } = deriveDisplayLines(projections);

      // Honest remediation: a real connection/permission problem → check the
      // connector; a purely transient/network failure → "keep retrying" (never
      // blame the connection); otherwise the generic fallback.
      const remediation = hasConnectionProblem
        ? remediationFor(connectorServerNames)
        : hasTransientFailure
          ? TRANSIENT_SYNC_REMEDIATION
          : remediationFor(connectorServerNames);

      return {
        id: 'calendarCacheHealth',
        name: 'Calendar Cache',
        status: 'warn',
        message: `Calendar sync issues: ${lines.join('; ')}`,
        remediation,
        details: {
          // Derived display-safe lines — NOT the persisted strings, and
          // never `detail` (projection-enforced).
          syncWarnings: lines,
          connectorServerNames,
          populatedAt: new Date(state.populatedAt).toISOString(),
          isStale: state.isStale,
        },
      };
    }
    // Typed key present and empty: a new-build write said "no issues" —
    // legacy strings are never consulted. Fall through to error/staleness.
  } else {
    // Legacy fallback (pre-update cache; self-heals ≤15 min after update):
    // classify + count ONLY. Raw string content never reaches output.
    const legacyWarnings = state.syncWarnings ?? [];
    if (legacyWarnings.length > 0) {
      const connectorServerNames = [
        ...new Set(legacyWarnings.map(classifyLegacyWarning).filter((n): n is string => n !== null)),
      ];
      const count = legacyWarnings.length;

      return {
        id: 'calendarCacheHealth',
        name: 'Calendar Cache',
        status: 'warn',
        message: `Calendar sync issues: ${count} warning${count === 1 ? '' : 's'} from the last sync`,
        remediation: remediationFor(connectorServerNames),
        details: {
          legacyWarningCount: count,
          connectorServerNames,
          populatedAt: new Date(state.populatedAt).toISOString(),
          isStale: state.isStale,
        },
      };
    }
  }

  // Check for hard error
  if (state.lastSyncError) {
    return {
      id: 'calendarCacheHealth',
      name: 'Calendar Cache',
      status: 'fail',
      // Belt for legacy persisted values (Phase 7, DA-F4): recordSyncError
      // now scrubs at write, but a lastSyncError persisted by a pre-fix
      // build can still carry raw emails/slugs — scrub again at read so
      // the fail message (→ toast) never echoes them.
      message: `Calendar sync failed: ${scrubSyncDetailText(state.lastSyncError)}`,
    };
  }

  // Cache is stale
  if (state.isStale) {
    return {
      id: 'calendarCacheHealth',
      name: 'Calendar Cache',
      status: 'warn',
      message: 'Calendar cache is stale (last sync > 4 hours ago)',
      details: {
        populatedAt: new Date(state.populatedAt).toISOString(),
      },
    };
  }

  // All good
  return {
    id: 'calendarCacheHealth',
    name: 'Calendar Cache',
    status: 'pass',
    message: 'Calendar cache is healthy',
    details: {
      populatedAt: new Date(state.populatedAt).toISOString(),
    },
  };
}
