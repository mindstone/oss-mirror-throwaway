/**
 * Sentry Autopilot pending-action drainer.
 *
 * The drainer has two distinct modes:
 *   - **drainAll / drainIssue** (used by `pendingMode='enforce'`): for each
 *     action in `ACTION_DRAIN_ORDER`, run its idempotency probe; if the
 *     external side effect is already in place, remove the action without
 *     invoking the executor; otherwise call the matching executor on
 *     Reporter, and on success remove the action. On failure, bump
 *     `attempts` and leave it in the queue for the next tick.
 *   - **reconcileAll / reconcileIssue** (used by `pendingMode='mirror'`):
 *     probe-and-prune only — for each action, run its idempotency probe;
 *     if "already done", remove from queue; otherwise log divergence and
 *     leave in place. **Reconcile NEVER invokes executors** — this is the
 *     invariant that keeps mirror mode strictly observational.
 *
 * The mode split (folded from v2.2 audit on mirror × drainAll interaction)
 * is the load-bearing reason mirror mode is safe: legacy inline reporter
 * fires the side effects (Stage A behavior preserved); reconcile only
 * tells us which of those side effects mirror mode "would have" agreed
 * with, by probing the external system after the fact.
 *
 * Aggregate-failure escalation: if any action exhausts retries (attempts
 * reaches `MAX_ATTEMPTS_PER_ACTION`), drainAll appends an escalation row
 * (`state.db.escalations`), writes a marker file at
 * `~/sentry-autopilot/ESCALATION-<runId>`, and best-effort posts a Slack
 * notification. The marker file is the last-resort visibility channel
 * when Slack itself is also failing.
 */

import fs from 'node:fs';
import path from 'node:path';

import type { AutopilotConfig } from './config.ts';
import { emitCounter, errorLog } from './metrics.ts';
import {
  ACTION_DRAIN_ORDER,
  MAX_ATTEMPTS_PER_ACTION,
  type PendingAction,
  type PendingActionKind,
} from './pending-actions.ts';
import { Reporter, rerenderSlackOutcomeWithCurrentRow } from './reporter.ts';
import type { IssueRow, StateDB } from './state.ts';
import { VerificationResult } from './verifier.ts';

/** Parse the persisted JSON verification_details column back to a
 * VerificationResult, returning null on any parse / shape error. The
 * drainer uses this for drain-time Slack re-render so the rendered text
 * matches what the original plan-time render would have produced. */
function safeParseVerification(raw: string): VerificationResult | null {
  try {
    const parsed = JSON.parse(raw);
    const result = VerificationResult.safeParse(parsed);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

export interface DrainStats {
  drained: number;
  retry: number;
  permanently_failed: number;
  probe_skipped: number;
}

export interface ReconcileStats {
  pruned: number;
  divergent: number;
}

export interface DrainContext {
  /**
   * Optional run id used as the seed for the escalation marker file path
   * and the escalations table row. Defaults to `Date.now()` so the marker
   * file is still unique even when invoked outside the dispatcher.
   */
  runId?: number;
}

function actionKindOrder(): Map<PendingActionKind, number> {
  const map = new Map<PendingActionKind, number>();
  ACTION_DRAIN_ORDER.forEach((kind, index) => {
    map.set(kind, index);
  });
  return map;
}

function sortActionsByDrainOrder(actions: readonly PendingAction[]): PendingAction[] {
  const order = actionKindOrder();
  return [...actions].sort((a, b) => {
    const ai = order.get(a.kind) ?? ACTION_DRAIN_ORDER.length;
    const bi = order.get(b.kind) ?? ACTION_DRAIN_ORDER.length;
    if (ai !== bi) return ai - bi;
    return a.created_at.localeCompare(b.created_at);
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Probe an action against its external side-effect channel. Returns
 * `'done'` when the side effect is already in place (drainer can prune
 * the action without firing the executor), `'pending'` when the side
 * effect needs to be fired, and `'no_probe'` when no probe is available
 * for this kind (treat as `'pending'` — the at-least-once Slack /
 * sentry_comment case where the idempotency key is the body hash).
 */
async function probeAction(
  reporter: Reporter,
  issue: IssueRow,
  action: PendingAction,
): Promise<'done' | 'pending' | 'no_probe'> {
  switch (action.kind) {
    case 'sentry_status': {
      try {
        const currentStatus = await reporter.probeSentryStatus(issue);
        if (currentStatus === null) return 'pending';
        if (action.payload.status === 'resolved' && currentStatus === 'resolved') return 'done';
        if (action.payload.status === 'ignored' && currentStatus === 'ignored') return 'done';
        return 'pending';
      } catch {
        return 'pending';
      }
    }
    case 'linear_create_issue': {
      try {
        const annotation = await reporter.probeLinearAnnotation(issue);
        return annotation ? 'done' : 'pending';
      } catch {
        return 'pending';
      }
    }
    case 'pr_open': {
      // Stage E probe: ask GitHub if an open PR for this head branch
      // already exists. If credentials are missing the reporter returns
      // null and we fall through to the executor (which throws with a
      // clear "credentials required" message).
      try {
        const existingUrl = await reporter.probePrOpen(action.payload.branch_name);
        return existingUrl ? 'done' : 'pending';
      } catch {
        return 'pending';
      }
    }
    case 'pr_merge': {
      // Probe via the issue row's pr_url (written by pr_open earlier in the
      // drain order). When pr_open hasn't run yet the row's pr_url is null,
      // so probePrMerged returns false and the action stays in 'pending'
      // until pr_open populates it.
      try {
        const merged = await reporter.probePrMerged(issue.pr_url);
        if (merged === true) return 'done';
        return 'pending';
      } catch {
        return 'pending';
      }
    }
    case 'sentry_comment':
    case 'slack_outcome':
    case 'slack_user_alert':
    case 'slack_draft_response':
    case 'linear_comment_existing':
      return 'no_probe';
  }
}

export interface ExecuteActionResult {
  /** PR URL returned by `executePrOpen` — undefined for other kinds. The
   * drainer persists this to the issue row so subsequent Slack
   * re-renderings (Stage E) can include it. */
  prUrl?: string;
}

async function executeAction(
  reporter: Reporter,
  issue: IssueRow,
  action: PendingAction,
): Promise<ExecuteActionResult> {
  switch (action.kind) {
    case 'sentry_status':
      await reporter.executeSentryStatus(issue, action.payload);
      return {};
    case 'sentry_comment':
      await reporter.executeSentryComment(issue, action.payload);
      return {};
    case 'slack_outcome':
    case 'slack_user_alert':
    case 'slack_draft_response':
      await reporter.executeSlackMessage(action.payload);
      return {};
    case 'linear_create_issue':
      await reporter.executeLinearCreateIssue(issue, action.payload);
      return {};
    case 'linear_comment_existing':
      await reporter.executeLinearCommentExisting(issue, action.payload);
      return {};
    case 'pr_open': {
      const { url } = await reporter.executePrOpen(issue, action.payload);
      return { prUrl: url };
    }
    case 'pr_merge':
      await reporter.executePrMerge(issue, action.payload);
      return {};
  }
}

function emptyDrainStats(): DrainStats {
  return { drained: 0, retry: 0, permanently_failed: 0, probe_skipped: 0 };
}

function emptyReconcileStats(): ReconcileStats {
  return { pruned: 0, divergent: 0 };
}

function addStats(target: DrainStats, source: DrainStats): void {
  target.drained += source.drained;
  target.retry += source.retry;
  target.permanently_failed += source.permanently_failed;
  target.probe_skipped += source.probe_skipped;
}

function addReconcile(target: ReconcileStats, source: ReconcileStats): void {
  target.pruned += source.pruned;
  target.divergent += source.divergent;
}

function writeEscalationMarker(
  config: AutopilotConfig,
  runId: number,
  context: unknown,
): void {
  try {
    const markerPath = path.join(config.stateDir, `ESCALATION-${runId}`);
    const body = `Escalation written at ${new Date().toISOString()}\n${JSON.stringify(context, null, 2)}\n`;
    fs.mkdirSync(path.dirname(markerPath), { recursive: true });
    fs.writeFileSync(markerPath, body);
  } catch (error) {
    // Marker is best-effort — if the filesystem is unhappy we still have
    // the escalations table and (if Slack works) the Slack message.
    errorLog(
      'reporter_fail',
      { runId, error: errorMessage(error) },
      'Failed to write escalation marker file',
    );
  }
}

export class PendingDrainer {
  constructor(
    private readonly db: StateDB,
    private readonly reporter: Reporter,
    private readonly config: AutopilotConfig,
  ) {}

  /**
   * Drain pending actions for every issue with a non-empty
   * `pending_actions` queue. Used by `pendingMode='enforce'` at
   * start-of-tick (post-crash recovery) and immediately after
   * `harvestOutcome` writes new actions.
   */
  async drainAll(ctx: DrainContext = {}): Promise<DrainStats> {
    const runId = ctx.runId ?? Date.now();
    const aggregate = emptyDrainStats();
    const issues = this.getIssuesWithPendingActions();
    for (const issue of issues) {
      const stats = await this.drainIssue(issue);
      addStats(aggregate, stats);
    }

    if (aggregate.permanently_failed > 0) {
      const context = {
        runId,
        permanently_failed: aggregate.permanently_failed,
        retry: aggregate.retry,
        drained: aggregate.drained,
      };
      this.db.addEscalation(runId, 'pending_drain_failed', context);
      writeEscalationMarker(this.config, runId, context);
      try {
        await this.reporter.executeSlackMessage({
          text: `:rotating_light: *Autopilot pending-action drain failed permanently* (run ${runId}): ${aggregate.permanently_failed} action(s) exhausted ${MAX_ATTEMPTS_PER_ACTION} attempts. See \`${this.config.stateDir}/ESCALATION-${runId}\` and \`state.db.escalations\`.`,
          log_discriminator: 'supervisor_fail',
        });
      } catch (error) {
        // Slack itself is failing — the marker file + escalations row are
        // the channels of last resort, already populated above.
        errorLog(
          'reporter_fail',
          { runId, error: errorMessage(error) },
          'Failed to post pending-drain escalation Slack message',
        );
      }
    }

    return aggregate;
  }

  /**
   * Drain a single issue. Public so the `harvestOutcome` path can invoke
   * it immediately after writing a fresh `pending_actions` queue without
   * waiting for the next start-of-tick drainAll.
   */
  async drainIssue(issue: IssueRow): Promise<DrainStats> {
    const stats = emptyDrainStats();
    const queue = this.db.getPendingActions(issue.sentry_id);
    if (queue.length === 0) return stats;

    let currentIssue = issue;
    const sorted = sortActionsByDrainOrder(queue);
    for (const action of sorted) {
      // Drain-time re-render: when a `pr_open` succeeded earlier in this
      // tick the URL is now on the issue row. Rebuild slack_outcome's
      // payload + idempotency_key so the Slack message includes the PR
      // URL. Stage E / Q1 mitigation — predecessor ordering via
      // ACTION_DRAIN_ORDER places `pr_open` before `slack_outcome`, so by
      // the time we reach the Slack action here, `pr_url` is already
      // persisted.
      let renderedAction: PendingAction = action;
      if (action.kind === 'slack_outcome' && currentIssue.pr_url) {
        const verification = currentIssue.verification_details
          ? safeParseVerification(currentIssue.verification_details)
          : null;
        const rerendered = rerenderSlackOutcomeWithCurrentRow(currentIssue, verification);
        if (rerendered.idempotency_key !== action.idempotency_key) {
          renderedAction = {
            ...action,
            payload: { text: rerendered.text },
            idempotency_key: rerendered.idempotency_key,
          };
        }
      }
      // Skip actions that have already exhausted retries — they're stuck
      // until an admin clears them via `pending-cancel.ts`. Counted as
      // permanently_failed in this run so the aggregate-failure escalation
      // surfaces them.
      if (renderedAction.attempts >= MAX_ATTEMPTS_PER_ACTION) {
        stats.permanently_failed += 1;
        emitCounter('pending.permanently_failed', { kind: renderedAction.kind });
        continue;
      }

      const probeResult = await probeAction(this.reporter, currentIssue, renderedAction);
      if (probeResult === 'done') {
        // pr_open probe-skip path: if there's already an open PR we should
        // capture its URL so subsequent Slack re-renders include it. The
        // probe doesn't return the URL directly, but a follow-up probe call
        // can — kept cheap because GitHub list-PR responses are small.
        if (renderedAction.kind === 'pr_open') {
          try {
            const existingUrl = await this.reporter.probePrOpen(renderedAction.payload.branch_name);
            if (existingUrl) {
              this.db.upsertIssue({
                sentry_id: currentIssue.sentry_id,
                pr_url: existingUrl,
                pushed_at: currentIssue.pushed_at ?? new Date().toISOString(),
              });
              currentIssue = this.db.getIssue(currentIssue.sentry_id) ?? currentIssue;
            }
          } catch {
            // Best-effort; the action is being removed regardless.
          }
        }
        this.db.removePendingAction(currentIssue.sentry_id, action.idempotency_key);
        stats.probe_skipped += 1;
        emitCounter('pending.probe_skipped', { kind: renderedAction.kind });
        continue;
      }

      try {
        const result = await executeAction(this.reporter, currentIssue, renderedAction);
        if (renderedAction.kind === 'pr_open' && result.prUrl) {
          // Persist the URL so future Slack/Linear re-renders include it.
          // Stage E predecessor ordering means slack_outcome will be
          // processed after this in the same drainIssue() loop, with the
          // re-render hook above picking up the freshly-persisted URL.
          this.db.upsertIssue({
            sentry_id: currentIssue.sentry_id,
            pr_url: result.prUrl,
            pushed_at: currentIssue.pushed_at ?? new Date().toISOString(),
          });
          currentIssue = this.db.getIssue(currentIssue.sentry_id) ?? currentIssue;
        }
        // Remove using the ORIGINAL idempotency_key (the queue identifies
        // entries by their stored key, not the re-rendered one).
        this.db.removePendingAction(currentIssue.sentry_id, action.idempotency_key);
        stats.drained += 1;
        emitCounter('pending.drained', { kind: renderedAction.kind });
      } catch (error) {
        const message = errorMessage(error);
        this.db.recordPendingAttempt(currentIssue.sentry_id, action.idempotency_key, message);
        stats.retry += 1;
        emitCounter('pending.retry', { kind: renderedAction.kind });
        errorLog(
          'reporter_fail',
          {
            sentryId: currentIssue.sentry_id,
            kind: renderedAction.kind,
            idempotency_key: action.idempotency_key,
            attempts: action.attempts + 1,
            error: message,
          },
          'Pending action drain attempt failed',
        );
        if (action.attempts + 1 >= MAX_ATTEMPTS_PER_ACTION) {
          stats.permanently_failed += 1;
          emitCounter('pending.permanently_failed', { kind: renderedAction.kind });
        }
      }
    }

    return stats;
  }

  /**
   * Reconcile (probe-and-prune only): for every issue with pending
   * actions, run each action's probe; remove the action when its external
   * channel reports "already done", otherwise log divergence and leave
   * the action in place. **Never invokes executors.**
   *
   * Used by `pendingMode='mirror'` so the row-level `pending_actions`
   * shadow tracks reality (legacy inline reporter fires the side effects;
   * reconcile records "yes, mirror would have agreed").
   */
  async reconcileAll(): Promise<ReconcileStats> {
    const aggregate = emptyReconcileStats();
    const issues = this.getIssuesWithPendingActions();
    for (const issue of issues) {
      const stats = await this.reconcileIssue(issue);
      addReconcile(aggregate, stats);
    }
    return aggregate;
  }

  /** Reconcile a single issue's queue. See `reconcileAll`. */
  async reconcileIssue(issue: IssueRow): Promise<ReconcileStats> {
    const stats = emptyReconcileStats();
    const queue = this.db.getPendingActions(issue.sentry_id);
    if (queue.length === 0) return stats;

    for (const action of queue) {
      const probeResult = await probeAction(this.reporter, issue, action);
      if (probeResult === 'done') {
        this.db.removePendingAction(issue.sentry_id, action.idempotency_key);
        stats.pruned += 1;
        emitCounter('pending.reconcile.pruned', { kind: action.kind });
      } else {
        stats.divergent += 1;
        emitCounter('pending.reconcile.divergent', { kind: action.kind });
        // Divergences in mirror mode are EXPECTED for at-least-once kinds
        // (sentry_comment, slack_*, linear_comment_existing) and for
        // actions where the legacy inline path didn't fire (e.g.
        // slack_user_alert wasn't enqueued by the inline path in the same
        // shape). See Q4 in the planning doc — the allowlist is
        // maintained in `__tests__/pending-drainer.test.ts` fixtures.
      }
    }
    return stats;
  }

  /** Internal helper — surfaces the rows whose queues currently hold any
   * actions. Returns the full IssueRow because executors need
   * `issue.sentry_id`, `issue.sentry_url`, etc. */
  private getIssuesWithPendingActions(): IssueRow[] {
    const rows = this.db.listIssuesWithPendingActions();
    return rows;
  }
}

// Internal hook (not in the public Reporter API) — exposed for testing
// the probe / execute dispatcher directly without going through Reporter.
export const __drainer_internals__ = {
  probeAction,
  executeAction,
  sortActionsByDrainOrder,
};
