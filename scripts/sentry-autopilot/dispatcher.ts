import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { loadConfig, type AutopilotConfig } from './config.ts';
import { emitCounter, errorLog } from './metrics.ts';
import { matchesNoiseTitle } from './noisePatterns.ts';
import type { PendingAction } from './pending-actions.ts';
import { PendingDrainer } from './pending-drainer.ts';
import { buildPrompt } from './prompt-builder.ts';
import { checkCommitResolutions, getStaleIssues, pollSentry, type PolledIssue } from './poller.ts';
import { Reporter } from './reporter.ts';
import { getKillSwitchState, SessionManager, type SessionOutcome } from './session-manager.ts';
import { StateDB, type IssueRow } from './state.ts';
import { inFlightDedupGate } from './triage/inFlightDedupGate.ts';
import { runTriageGates } from './triage/index.ts';
import { linearDedupGate } from './triage/linearDedupGate.ts';
import { releaseGate } from './triage/releaseGate.ts';

// Signal handling contract: SIGTERM/SIGINT means drain, not abort. The dispatcher
// finishes the current dispatch/housekeeping step, skips new sessions, and does
// NOT terminate active tmux sessions.

interface RunStats {
  issuesFound: number;
  issuesDispatched: number;
  issuesSkipped: number;
  failures: number;
}

interface RateLimitState {
  allowed: boolean;
  reason?: string;
  activeCount: number;
  hourlyDispatches: number;
  dailyDispatches: number;
}

interface DispatchPreparationContext {
  fingerprintHash?: string;
}

type DispatchPreparationMap = Map<string, DispatchPreparationContext>;

const FAILURE_CASCADE_THRESHOLD = 3;
const SLOW_BURN_MIN_RUNS = 3;
const SLOW_BURN_LOOKBACK_DAYS = 7;
const STALE_CLEANUP_OLDER_THAN_DAYS = 7;
const RELEASE_GATE_ROLLOUT_NOTIFICATION_FILE = '.release_gate_rollout_notified';
const RELEASE_SKIP_REASON_RE = /^release-aware-skip:lag=(\d+):current=([^:]+):issue=([^:]+)$/;
const LINEAR_ALREADY_FIXED_REASON_RE = /^linear-already-fixed:([^:]+)$/;
const LINEAR_FINGERPRINT_MATCH_REASON_RE = /^linear-fingerprint-match:([^:]+):([^:]+)$/;
const INFLIGHT_DEDUP_REASON_RE = /^inflight-dedup:fingerprint=([^:]+):active=([^:]+)$/;

let shutdownRequested = false;

function logInfo(data: Record<string, unknown> = {}, message: string): void {
  console.log(JSON.stringify({ level: 'info', component: 'sentry-autopilot-dispatcher', message, ...data }));
}

function logWarn(data: Record<string, unknown> = {}, message: string): void {
  console.warn(JSON.stringify({ level: 'warn', component: 'sentry-autopilot-dispatcher', message, ...data }));
}

function logError(data: Record<string, unknown> = {}, message: string): void {
  console.error(JSON.stringify({ level: 'error', component: 'sentry-autopilot-dispatcher', message, ...data }));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function installSignalHandlers(): void {
  const handleSignal = (signal: NodeJS.Signals): void => {
    shutdownRequested = true;
    logWarn({ signal }, 'Shutdown requested; no new sessions will be dispatched');
  };

  process.once('SIGINT', handleSignal);
  process.once('SIGTERM', handleSignal);
}

function getRateLimitState(db: StateDB, config: AutopilotConfig, dispatchesThisRun: number): RateLimitState {
  const activeCount = db.getActiveIssues().length;
  const hourlyDispatches = db.countRecentDispatches(1) + dispatchesThisRun;
  const dailyDispatches = db.countRecentDispatches(24) + dispatchesThisRun;

  if (activeCount >= config.maxConcurrent) {
    return {
      allowed: false,
      reason: `active sessions ${activeCount}/${config.maxConcurrent}`,
      activeCount,
      hourlyDispatches,
      dailyDispatches,
    };
  }

  if (hourlyDispatches >= config.maxHourly) {
    return {
      allowed: false,
      reason: `hourly dispatch limit ${hourlyDispatches}/${config.maxHourly}`,
      activeCount,
      hourlyDispatches,
      dailyDispatches,
    };
  }

  if (dailyDispatches >= config.maxDaily) {
    return {
      allowed: false,
      reason: `daily dispatch limit ${dailyDispatches}/${config.maxDaily}`,
      activeCount,
      hourlyDispatches,
      dailyDispatches,
    };
  }

  return { allowed: true, activeCount, hourlyDispatches, dailyDispatches };
}

function isTerminalTrackedIssue(issue: IssueRow): boolean {
  return issue.status === 'completed' || issue.status === 'escalated' || issue.status === 'failed';
}

function isActiveTrackedIssue(issue: IssueRow): boolean {
  return issue.status === 'dispatched' || issue.status === 'in_progress';
}

function upsertSkippedIssue(
  db: StateDB,
  issue: PolledIssue,
  config: AutopilotConfig,
  lastError?: string,
): void {
  const existing = db.getIssue(issue.sentryId);
  if (existing && (isTerminalTrackedIssue(existing) || isActiveTrackedIssue(existing))) {
    return;
  }

  db.upsertIssue({
    sentry_id: issue.sentryId,
    sentry_url: issue.sentryUrl,
    title: issue.title,
    error_type: issue.errorType,
    is_user_reported: issue.isUserReported,
    occurrences: issue.occurrences,
    users: issue.users,
    status: 'skipped',
    max_retries: config.maxRetries,
    last_error: lastError,
    user_description: issue.userDescription ?? null,
    user_email: issue.userEmail ?? null,
    user_name: issue.userName ?? null,
  });
}

function upsertDeferredIssue(
  db: StateDB,
  issue: PolledIssue,
  config: AutopilotConfig,
  lastError?: string,
  fingerprintHash?: string,
): void {
  const existing = db.getIssue(issue.sentryId);
  if (existing && (isTerminalTrackedIssue(existing) || isActiveTrackedIssue(existing))) {
    return;
  }

  const persistedFingerprintHash = existing?.fingerprint_hash ?? fingerprintHash ?? undefined;

  db.upsertIssue({
    sentry_id: issue.sentryId,
    sentry_url: issue.sentryUrl,
    title: issue.title,
    error_type: issue.errorType,
    is_user_reported: issue.isUserReported,
    occurrences: issue.occurrences,
    users: issue.users,
    status: 'deferred',
    max_retries: config.maxRetries,
    last_error: lastError ?? null,
    fingerprint_hash: persistedFingerprintHash,
    user_description: issue.userDescription ?? null,
    user_email: issue.userEmail ?? null,
    user_name: issue.userName ?? null,
  });
}

function parseReleaseSkipReason(
  reason: string | undefined,
): { currentRelease: string; issueRelease: string; lagSteps: number } | null {
  const match = reason?.match(RELEASE_SKIP_REASON_RE);
  if (!match) {
    return null;
  }

  return { lagSteps: Number(match[1]), currentRelease: match[2], issueRelease: match[3] };
}

function buildReleaseGateSkipComment(issueRelease: string, currentRelease: string): string {
  return `Autopilot: skipped — issue's last seen release (${issueRelease}) predates the current monitored release (${currentRelease}). Resolve manually if no longer relevant; if incorrect (e.g. issue still occurs on a newer release), no action needed — autopilot will re-evaluate when a fresh event arrives.`;
}

function parseLinearDedupSkipReason(
  reason: string | undefined,
): { matchedTicketId: string; fingerprint?: string } | null {
  const alreadyFixedMatch = reason?.match(LINEAR_ALREADY_FIXED_REASON_RE);
  if (alreadyFixedMatch) {
    return { matchedTicketId: alreadyFixedMatch[1] };
  }

  const fingerprintMatch = reason?.match(LINEAR_FINGERPRINT_MATCH_REASON_RE);
  if (fingerprintMatch) {
    return { fingerprint: fingerprintMatch[1], matchedTicketId: fingerprintMatch[2] };
  }

  return null;
}

function parseInFlightDedupReason(
  reason: string | null | undefined,
): { fingerprint: string; activeSentryId: string } | null {
  const match = reason?.match(INFLIGHT_DEDUP_REASON_RE);
  if (!match) {
    return null;
  }

  return { fingerprint: match[1], activeSentryId: match[2] };
}

function emitInFlightDedupDeferredCounter(reason: string | null | undefined): void {
  const parsed = parseInFlightDedupReason(reason);
  if (!parsed) {
    return;
  }

  emitCounter('reporter.deferred.inflight_dedup', {
    fingerprint: parsed.fingerprint,
    activeSentryId: parsed.activeSentryId,
  });
}

function buildLinearDedupSkipComment(matchedTicketId: string, status: string): string {
  return `Autopilot: skipped — matches Linear ticket ${matchedTicketId} (status=${status}). If incorrect, reopen ${matchedTicketId} or unlink. Autopilot will re-evaluate when a fresh event arrives.`;
}

export function enqueueReleaseGateSkipComment(
  db: StateDB,
  issue: PolledIssue,
  reason: string | undefined,
): boolean {
  const parsed = parseReleaseSkipReason(reason);
  if (!parsed) {
    logWarn(
      { sentryId: issue.sentryId, gate: 'release', reason },
      'Release gate skip reason was not parseable; skipping quiet Sentry comment enqueue',
    );
    return false;
  }

  const idempotencyKey = `sentry_comment:${issue.sentryId}:release-gate-skip:${parsed.currentRelease}-vs-${parsed.issueRelease}`;
  try {
    const enqueued = db.enqueueReleaseGateSkipComment(
      issue,
      buildReleaseGateSkipComment(parsed.issueRelease, parsed.currentRelease),
      idempotencyKey,
    );
    emitCounter('reporter.skipped.release_lag', {
      currentRelease: parsed.currentRelease,
      issueRelease: parsed.issueRelease,
      lagSteps: parsed.lagSteps,
    });
    return enqueued;
  } catch (error) {
    logWarn(
      { sentryId: issue.sentryId, gate: 'release', idempotencyKey, error: errorMessage(error) },
      'Failed to enqueue release-gate quiet Sentry comment',
    );
    return false;
  }
}

export function enqueueLinearDedupSkipComment(
  db: StateDB,
  issue: PolledIssue,
  reason: string | undefined,
  metadata?: Record<string, string>,
): boolean {
  const parsed = parseLinearDedupSkipReason(reason);
  const matchedTicketId = metadata?.matchedLinearId ?? parsed?.matchedTicketId;
  const status = metadata?.matchedLinearStatus;
  if (!matchedTicketId || !status) {
    logWarn(
      { sentryId: issue.sentryId, gate: 'linear-dedup', reason, metadata },
      'Linear dedup skip reason was not parseable; skipping quiet Sentry comment enqueue',
    );
    return false;
  }

  const idempotencyKey = `sentry_comment:${issue.sentryId}:linear-dedup:${matchedTicketId}`;
  const fingerprint = metadata?.fingerprint ?? parsed?.fingerprint;
  try {
    const enqueued = db.enqueueLinearDedupSkipComment(
      issue,
      buildLinearDedupSkipComment(matchedTicketId, status),
      idempotencyKey,
    );
    emitCounter('reporter.skipped.linear_dedup', {
      sentryId: issue.sentryId,
      linearId: matchedTicketId,
      ...(fingerprint ? { fingerprint } : {}),
    });
    return enqueued;
  } catch (error) {
    logWarn(
      { sentryId: issue.sentryId, gate: 'linear-dedup', idempotencyKey, error: errorMessage(error) },
      'Failed to enqueue Linear-dedup quiet Sentry comment',
    );
    return false;
  }
}

/**
 * Append a `sentry_status: archived_until_escalating` pending action to a
 * triage-skipped issue's queue. The pending-drainer's existing
 * `executeSentryStatus` path mutates Sentry; the probe is idempotent
 * (`status === 'ignored'` short-circuits), so re-runs across ticks are
 * safe. User-reported issues are excluded — see SENTRY_TRIAGE.md
 * § "Stale-archiving: do NOT auto-archive on the 7-day rule".
 *
 * No-ops when:
 *   - issue is user-reported (project doc carve-out)
 *   - issue is missing from state.db (upsertSkippedIssue declined to write)
 *   - an action with the same idempotency key is already queued
 *   - the underlying Sentry row is already in a terminal/active dispatched
 *     state (we don't want to archive issues we're actively fixing)
 *
 * Exported for unit testing.
 */
export function enqueueArchivePendingAction(
  db: StateDB,
  issue: PolledIssue,
  reason: 'triage_skipped' | 'stale_cleanup',
  now: string = new Date().toISOString(),
): boolean {
  if (issue.isUserReported) return false;

  const row = db.getIssue(issue.sentryId);
  if (!row) return false;
  if (isTerminalTrackedIssue(row) || isActiveTrackedIssue(row)) return false;

  const idempotencyKey = `sentry_status:${issue.sentryId}:ignored`;
  const existingQueue = db.getPendingActions(issue.sentryId);
  if (existingQueue.some((action) => action.idempotency_key === idempotencyKey)) {
    return false;
  }

  const archiveAction: PendingAction = {
    kind: 'sentry_status',
    payload: { status: 'ignored', status_details: {}, substatus: 'archived_until_escalating' },
    idempotency_key: idempotencyKey,
    attempts: 0,
    last_error: null,
    created_at: now,
  };

  db.replacePendingActions(issue.sentryId, [...existingQueue, archiveAction]);

  const noiseHit = matchesNoiseTitle(issue.title);
  logInfo(
    {
      sentryId: issue.sentryId,
      reason,
      noiseCategory: noiseHit.match ? noiseHit.category : null,
    },
    'Enqueued sentry_status archive for triage-skipped issue',
  );
  return true;
}

function upsertDispatchableIssue(
  db: StateDB,
  issue: PolledIssue,
  config: AutopilotConfig,
  fingerprintHash?: string,
): IssueRow | null {
  const existing = db.getIssue(issue.sentryId);
  if (existing && (isActiveTrackedIssue(existing) || isTerminalTrackedIssue(existing))) {
    return null;
  }

  const nextStatus: IssueRow['status'] = existing?.status === 'deferred' ? 'deferred' : 'pending';
  const persistedFingerprintHash = existing?.fingerprint_hash ?? fingerprintHash ?? undefined;

  return db.upsertIssue({
    sentry_id: issue.sentryId,
    sentry_url: issue.sentryUrl,
    title: issue.title,
    error_type: issue.errorType,
    is_user_reported: issue.isUserReported,
    occurrences: issue.occurrences,
    users: issue.users,
    status: nextStatus,
    max_retries: config.maxRetries,
    fingerprint_hash: persistedFingerprintHash,
    user_description: issue.userDescription ?? null,
    user_email: issue.userEmail ?? null,
    user_name: issue.userName ?? null,
  });
}

function shouldCountFailure(outcome: SessionOutcome): boolean {
  return outcome.outcome === 'failed';
}

/**
 * Filters pending issues to the single targeted Sentry ID when
 * `AUTOPILOT_TARGET_SENTRY_ID` is set. Throws if the env var is set but no
 * matching pending row exists in `state.db` — deliberately fail-loud so a
 * controlled test never silently dispatches "next available" or no-ops.
 *
 * Exported for unit testing.
 */
export function filterPendingForTarget(
  pendingIssues: IssueRow[],
  targetSentryId: string | undefined,
): IssueRow[] {
  if (!targetSentryId) {
    return pendingIssues;
  }

  const matched = pendingIssues.filter((issue) => issue.sentry_id === targetSentryId);
  if (matched.length === 0) {
    const availableIds = pendingIssues.map((issue) => issue.sentry_id);
    throw new Error(
      `AUTOPILOT_TARGET_SENTRY_ID=${targetSentryId} set but no matching pending row found in state.db. ` +
        `Pre-seed the row with status='pending' before dispatch. ` +
        `Available pending ids: ${availableIds.length > 0 ? availableIds.join(', ') : '(none)'}`,
    );
  }

  return matched;
}

const KILL_SWITCH_NOTIFICATION_FILE = '.kill_switch_notification_state';

function killSwitchNotificationPath(config: AutopilotConfig): string {
  return path.join(config.stateDir, KILL_SWITCH_NOTIFICATION_FILE);
}

function releaseGateRolloutNotificationPath(config: AutopilotConfig): string {
  return path.join(config.stateDir, RELEASE_GATE_ROLLOUT_NOTIFICATION_FILE);
}

export function readLastNotifiedKillSwitchState(config: AutopilotConfig): 'pause' | 'stop' | null {
  const filePath = killSwitchNotificationPath(config);
  if (!fs.existsSync(filePath)) {
    return null;
  }
  const contents = fs.readFileSync(filePath, 'utf8').trim();
  if (contents === 'pause' || contents === 'stop') {
    return contents;
  }
  return null;
}

export async function maybeReportReleaseGateRollout(
  config: AutopilotConfig,
  reporter: Reporter,
): Promise<void> {
  if (!config.releaseGateEnabled) {
    return;
  }

  const filePath = releaseGateRolloutNotificationPath(config);
  if (fs.existsSync(filePath)) {
    return;
  }

  await reporter.reportReleaseGateEnabled(config.releaseLagToleranceMinor ?? 0);
  fs.mkdirSync(config.stateDir, { recursive: true });
  fs.writeFileSync(filePath, `${new Date().toISOString()}\n`);
}

function writeLastNotifiedKillSwitchState(
  config: AutopilotConfig,
  state: 'pause' | 'stop' | null,
): void {
  const filePath = killSwitchNotificationPath(config);
  if (state === null) {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
    return;
  }
  fs.mkdirSync(config.stateDir, { recursive: true });
  fs.writeFileSync(filePath, `${state}\n`);
}

/**
 * Detects state changes in the kill-switch sentinels (STOP/PAUSE) and emits at
 * most one Slack notification per transition. Avoids the per-tick repeat
 * messages that would otherwise spam the autopilot channel during a long
 * pause/stop window.
 *
 * Transitions:
 *   - null → 'pause'/'stop'             → reportKillSwitch(new mode)
 *   - 'pause' → 'stop' (escalation)     → reportKillSwitch('stop')
 *   - 'stop' → 'pause' (de-escalation)  → reportKillSwitch('pause')
 *   - 'pause'/'stop' → null             → reportKillSwitchResumed(previous mode)
 *   - same → same                       → no-op (the silence the operator wants)
 *
 * Marker file (last-notified state): `<stateDir>/.kill_switch_notification_state`.
 * The marker is updated AFTER the Slack attempt so a Slack failure that's caught
 * by `executeOperation` doesn't get re-Slack'd next tick; pending-action retry
 * machinery handles the delivery retry instead.
 *
 * Exported for unit testing.
 */
export async function maybeReportKillSwitchTransition(
  config: AutopilotConfig,
  reporter: Reporter,
): Promise<void> {
  const currentState = getKillSwitchState(config);
  const lastNotifiedState = readLastNotifiedKillSwitchState(config);

  if (currentState === lastNotifiedState) {
    return;
  }

  if (currentState !== null) {
    await reporter.reportKillSwitch(currentState);
  } else if (lastNotifiedState !== null) {
    await reporter.reportKillSwitchResumed(lastNotifiedState);
  }

  writeLastNotifiedKillSwitchState(config, currentState);
}

async function reportHarvestedSessions(
  db: StateDB,
  config: AutopilotConfig,
  sessionManager: SessionManager,
  reporter: Reporter,
  drainer: PendingDrainer,
  stats: RunStats,
): Promise<void> {
  const harvested = await sessionManager.monitorSessions();
  for (const result of harvested) {
    const issue = db.getIssue(result.sentryId);
    if (!issue) {
      logWarn({ sentryId: result.sentryId }, 'Harvested session result has no matching state row');
      continue;
    }

    if (shouldCountFailure(result.outcome)) {
      stats.failures += 1;
      errorLog(
        'bugfixer_fail',
        {
          sentryId: result.sentryId,
          failure_kind: result.outcome.failure_kind ?? 'unknown',
          error: result.outcome.error ?? result.outcome.reason ?? 'unknown',
        },
        'Harvested session reported failed outcome',
      );
    }

    if (config.pendingMode === 'enforce') {
      // Drain just-written pending actions immediately. The legacy inline
      // reporter is intentionally NOT invoked — the drainer is the sole
      // side-effect channel under enforce.
      await drainer.drainIssue(issue);
    } else {
      // disabled OR mirror: legacy inline reporter fires side effects.
      // mirror additionally has the row-level shadow that reconcileAll
      // (at start-of-tick) prunes against external probes.
      const linearIssue = await reporter.reportOutcome(issue, result.outcome, result.verification);
      if (linearIssue) {
        db.upsertIssue({ sentry_id: issue.sentry_id, linear_issue_id: linearIssue.id });
      }
    }
  }
}

export async function dispatchPendingIssues(
  db: StateDB,
  config: AutopilotConfig,
  sessionManager: SessionManager,
  reporter: Reporter,
  stats: RunStats,
  canStartNewDispatches: () => boolean,
  dispatchPreparation: DispatchPreparationMap = new Map(),
): Promise<void> {
  const pendingIssues = filterPendingForTarget(db.getPendingIssues(), config.targetSentryId);
  for (const issue of pendingIssues) {
    if (!canStartNewDispatches() || shutdownRequested) {
      return;
    }

    const killSwitch = getKillSwitchState(config);
    if (killSwitch) {
      await maybeReportKillSwitchTransition(config, reporter);
      return;
    }

    const rateLimit = getRateLimitState(db, config, stats.issuesDispatched);
    if (!rateLimit.allowed) {
      logInfo({
        reason: rateLimit.reason,
        activeCount: rateLimit.activeCount,
        hourlyDispatches: rateLimit.hourlyDispatches,
        dailyDispatches: rateLimit.dailyDispatches,
      }, 'Dispatch paused by rate limit');
      return;
    }

    if (db.getAvailableSlot() === null) {
      logInfo({}, 'Dispatch paused because no worktree slot is available');
      return;
    }

    try {
      const promptFile = buildPrompt(issue, config);
      const fingerprintHash = config.inFlightDedupEnabled
        ? dispatchPreparation.get(issue.sentry_id)?.fingerprintHash ?? issue.fingerprint_hash
        : null;
      const dispatch = await sessionManager.dispatchIssue(issue, promptFile, {
        fingerprintHash,
        inFlightDedupWindowHours: config.inFlightDedupWindowHours,
      });
      if (!dispatch) {
        logInfo({ sentryId: issue.sentry_id }, 'Dispatch paused because session manager could not acquire a slot');
        return;
      }
      if (dispatch.decision === 'deferred') {
        dispatchPreparation.delete(issue.sentry_id);
        stats.issuesSkipped += 1;
        const deferredRow = db.getIssue(issue.sentry_id);
        emitInFlightDedupDeferredCounter(deferredRow?.last_error ?? issue.last_error);
        logInfo({ sentryId: issue.sentry_id }, 'Dispatch deferred by in-flight dedup transactional guard');
        continue;
      }

      dispatchPreparation.delete(issue.sentry_id);
      stats.issuesDispatched += 1;
      await reporter.reportSessionStarted(db.getIssue(issue.sentry_id) ?? issue);
    } catch (error) {
      stats.failures += 1;
      logError({ sentryId: issue.sentry_id, error: errorMessage(error) }, 'Failed to dispatch issue');
      if (stats.failures >= FAILURE_CASCADE_THRESHOLD) {
        return;
      }
    }
  }
}

export async function triagePolledIssues(
  db: StateDB,
  config: AutopilotConfig,
  stats: RunStats,
  dispatchPreparation: DispatchPreparationMap = new Map(),
): Promise<void> {
  const polledIssues = await pollSentry(config);
  stats.issuesFound = polledIssues.length;

  for (const issue of polledIssues) {
    dispatchPreparation.delete(issue.sentryId);
    const decision = await runTriageGates(issue, {
      config,
      db,
      gates: [releaseGate, linearDedupGate, inFlightDedupGate],
    });
    if (decision.decision === 'skip') {
      stats.issuesSkipped += 1;
      upsertSkippedIssue(
        db,
        issue,
        config,
        decision.gate === 'release' || decision.gate === 'linear-dedup' ? decision.reason : undefined,
      );
      if (decision.gate === 'release') {
        enqueueReleaseGateSkipComment(db, issue, decision.reason);
      } else if (decision.gate === 'linear-dedup') {
        enqueueLinearDedupSkipComment(db, issue, decision.reason, decision.metadata);
      } else {
        enqueueArchivePendingAction(db, issue, 'triage_skipped');
      }
      continue;
    }
    if (decision.decision === 'defer') {
      stats.issuesSkipped += 1;
      upsertDeferredIssue(db, issue, config, decision.reason, decision.context?.fingerprint_hash);
      emitInFlightDedupDeferredCounter(decision.reason);
      continue;
    }

    const fingerprintHash = decision.context?.fingerprint_hash;
    if (fingerprintHash) {
      dispatchPreparation.set(issue.sentryId, { fingerprintHash });
    }

    const upserted = upsertDispatchableIssue(db, issue, config, fingerprintHash);
    if (!upserted) {
      dispatchPreparation.delete(issue.sentryId);
      stats.issuesSkipped += 1;
    }
  }
}

async function runHousekeeping(
  db: StateDB,
  config: AutopilotConfig,
  reporter: Reporter,
  stats: RunStats,
): Promise<void> {
  if (db.shouldRunHousekeeping('stale_cleanup')) {
    try {
      const staleIssues = await getStaleIssues(config);
      let archiveEnqueued = 0;
      let userReportedSkipped = 0;
      for (const staleIssue of staleIssues) {
        if (staleIssue.isUserReported) {
          // SENTRY_TRIAGE.md § User Bug Reports: never auto-archive these
          // under the 7-day stale rule. Resolution is gated on the linked
          // Linear ticket, not aging.
          userReportedSkipped += 1;
          continue;
        }
        upsertSkippedIssue(db, staleIssue, config);
        if (enqueueArchivePendingAction(db, staleIssue, 'stale_cleanup')) {
          archiveEnqueued += 1;
        }
      }
      logInfo({
        count: staleIssues.length,
        olderThanDays: STALE_CLEANUP_OLDER_THAN_DAYS,
        archiveEnqueued,
        userReportedSkipped,
      }, 'Stale Sentry cleanup scan completed');
      db.logRun('stale_cleanup', staleIssues.length, archiveEnqueued, 0);
    } catch (error) {
      logError({ error: errorMessage(error) }, 'Stale cleanup failed');
      db.logRun('stale_cleanup', 0, 0, 0, errorMessage(error));
      await reporter.reportPollerQueryFailure('stale_cleanup', error);
    }
  }

  if (db.shouldRunHousekeeping('cross_day_patterns')) {
    try {
      const slowBurnIssues = db.getSlowBurnPatterns(SLOW_BURN_MIN_RUNS, SLOW_BURN_LOOKBACK_DAYS);
      for (const issue of slowBurnIssues) {
        logInfo({
          sentryId: issue.sentry_id,
          reason: 'slow-burn pattern',
        }, 'Promoting slow-burn issue to pending');
        db.upsertIssue({
          sentry_id: issue.sentry_id,
          status: 'pending',
        });
      }
      db.logRun('cross_day_patterns', slowBurnIssues.length, slowBurnIssues.length, 0);
    } catch (error) {
      logError({ error: errorMessage(error) }, 'Cross-day pattern detection failed');
      db.logRun('cross_day_patterns', 0, 0, 0, errorMessage(error));
    }
  }

  if (db.shouldRunHousekeeping('heartbeat')) {
    try {
      const heartbeatStats = db.getHeartbeatStats(24);
      await reporter.reportHeartbeat(heartbeatStats);
      db.logRun('heartbeat', heartbeatStats.processed, stats.issuesDispatched, stats.issuesSkipped);
    } catch (error) {
      logError({ error: errorMessage(error) }, 'Heartbeat failed');
      db.logRun('heartbeat', 0, 0, 0, errorMessage(error));
    }
  }
}

function pauseForFailureCascade(config: AutopilotConfig, count: number): void {
  fs.mkdirSync(config.stateDir, { recursive: true });
  fs.writeFileSync(
    path.join(config.stateDir, 'PAUSE'),
    `Sentry Autopilot paused at ${new Date().toISOString()} after ${count} failures in one dispatcher run.\n`,
  );
}

async function maybeHandleFailureCascade(
  config: AutopilotConfig,
  reporter: Reporter,
  stats: RunStats,
): Promise<void> {
  if (stats.failures < FAILURE_CASCADE_THRESHOLD) {
    return;
  }

  pauseForFailureCascade(config, stats.failures);
  await reporter.reportFailureCascade(stats.failures);
}

function isEntryPoint(): boolean {
  const entryPoint = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
  return import.meta.url === entryPoint;
}

export async function main(): Promise<void> {
  installSignalHandlers();

  let db: StateDB | undefined;
  let config: AutopilotConfig | undefined;
  let reporter: Reporter | undefined;
  let runId: number | undefined;
  let runError: string | undefined;
  const stats: RunStats = { issuesFound: 0, issuesDispatched: 0, issuesSkipped: 0, failures: 0 };

  try {
    config = loadConfig();
    fs.mkdirSync(config.stateDir, { recursive: true });
    db = new StateDB(path.join(config.stateDir, 'state.db'), { maxConcurrent: config.maxConcurrent });
    runId = db.startRun('hourly_poll');
    reporter = new Reporter(config);
    const sessionManager = new SessionManager(config, db);
    const drainer = new PendingDrainer(db, reporter, config);

    // Surface every unacknowledged escalation on stderr at startup. Per
    // Appendix C this is the operator's last-resort visibility channel
    // when Slack itself is failing — present from tick 1 so a missed Slack
    // ping doesn't hide a stuck queue.
    const unacknowledged = db.listUnacknowledgedEscalations();
    if (unacknowledged.length > 0) {
      for (const escalation of unacknowledged) {
        logError(
          {
            escalation_id: escalation.id,
            run_id: escalation.run_id,
            kind: escalation.kind,
            context: escalation.context,
            created_at: escalation.created_at,
          },
          `Unacknowledged autopilot escalation: ${escalation.kind}`,
        );
      }
    }

    await maybeReportKillSwitchTransition(config, reporter);
    await maybeReportReleaseGateRollout(config, reporter);

    // Start-of-tick pending-action handling.
    //   - enforce  → drainAll  (probe → execute → remove; recovers from
    //                            crashed previous run).
    //   - mirror   → reconcileAll (probe-and-prune only; never invokes
    //                              executors — strictly observational).
    //   - disabled → no-op.
    try {
      if (config.pendingMode === 'enforce') {
        await drainer.drainAll({ runId });
      } else if (config.pendingMode === 'mirror') {
        await drainer.reconcileAll();
      }
    } catch (error) {
      logError(
        { pendingMode: config.pendingMode, error: errorMessage(error) },
        'Start-of-tick pending-action handling failed',
      );
    }

    const initialRateLimit = getRateLimitState(db, config, 0);
    if (!initialRateLimit.allowed) {
      logInfo({
        reason: initialRateLimit.reason,
        activeCount: initialRateLimit.activeCount,
        hourlyDispatches: initialRateLimit.hourlyDispatches,
        dailyDispatches: initialRateLimit.dailyDispatches,
      }, 'Initial dispatch rate-limit check blocks new sessions');
    }

    await checkCommitResolutions(config, db);
    await reportHarvestedSessions(db, config, sessionManager, reporter, drainer, stats);

    const canStartNewDispatches = (): boolean =>
      !shutdownRequested && !getKillSwitchState(config as AutopilotConfig) && stats.failures < FAILURE_CASCADE_THRESHOLD;

    if (canStartNewDispatches()) {
      const dispatchPreparation: DispatchPreparationMap = new Map();
      if (config.targetSentryId) {
        // Targeted-dispatch mode (Layer 4 / Layer 5 controlled tests):
        // do NOT poll Sentry. Polling would (a) mutate state.db with new
        // pending rows that could compete with — or under
        // `is_user_reported DESC` ordering preempt — the operator-seeded
        // target, and (b) incur a live Sentry API call we don't need.
        // dispatchPendingIssues will fail loud if the target row is absent.
        logInfo(
          { targetSentryId: config.targetSentryId },
          'Targeted-dispatch mode: skipping Sentry poll; only the pre-seeded target will be considered',
        );
      } else {
        await triagePolledIssues(db, config, stats, dispatchPreparation);
      }
      await dispatchPendingIssues(
        db,
        config,
        sessionManager,
        reporter,
        stats,
        canStartNewDispatches,
        dispatchPreparation,
      );
    } else {
      logInfo({}, 'Skipping Sentry poll and dispatch because new dispatches are paused');
    }

    await maybeHandleFailureCascade(config, reporter, stats);
    if (stats.failures < FAILURE_CASCADE_THRESHOLD) {
      await runHousekeeping(db, config, reporter, stats);
    } else {
      logWarn({
        failures: stats.failures,
        threshold: FAILURE_CASCADE_THRESHOLD,
      }, 'Skipping housekeeping because failure cascade threshold was reached');
    }
  } catch (error) {
    runError = errorMessage(error);
    process.exitCode = 1;
    errorLog('supervisor_fail', { error: runError }, 'Dispatcher run failed');
  } finally {
    if (db) {
      try {
        if (runId !== undefined) {
          db.finishRun(runId, stats.issuesFound, stats.issuesDispatched, stats.issuesSkipped, runError);
        } else {
          db.logRun('hourly_poll', stats.issuesFound, stats.issuesDispatched, stats.issuesSkipped, runError);
        }
      } catch (error) {
        process.exitCode = 1;
        logError({ error: errorMessage(error) }, 'Failed to write dispatcher run log');
      }

      try {
        db.close();
      } catch (error) {
        process.exitCode = 1;
        logError({ error: errorMessage(error) }, 'Failed to close dispatcher state DB');
      }
    }
  }
}

if (isEntryPoint()) {
  void main();
}
