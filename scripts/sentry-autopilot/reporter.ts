import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type { AutopilotConfig } from './config.ts';
import { emitCounter, errorLog } from './metrics.ts';
import type { PendingAction } from './pending-actions.ts';
import {
  classifyHttpError,
  type ReportOperationResult,
  TransientHttpError,
} from './reporter-results.ts';
import { fetchIssueDetail, extractStackFrames } from './sentryRest.ts';
import type { SessionOutcome } from './session-manager.ts';
import type { HeartbeatStats, IssueRow } from './state.ts';
import { fingerprintLooseHash } from './triage/fingerprint.ts';
import type { VerificationResult } from './verifier.ts';

export interface LinearIssue {
  id: string;
  url: string;
  /** True when this was an existing issue we commented on rather than creating new. */
  reused?: boolean;
}

const SENTRY_API_BASE_URL = process.env.SENTRY_API_BASE_URL || 'https://us.sentry.io';
const LINEAR_API_URL = 'https://api.linear.app/graphql';
const REQUEST_TIMEOUT_MS = 30_000;
const AUTOPILOT_FINGERPRINT_PREFIX = 'autopilot-fingerprint:';

interface SlackMessagePayload {
  text: string;
  log_discriminator?: string;
}

function logWarn(data: Record<string, unknown> = {}, message: string): void {
  console.warn(JSON.stringify({ level: 'warn', component: 'sentry-autopilot-reporter', message, ...data }));
}

function logError(data: Record<string, unknown> = {}, message: string): void {
  console.error(JSON.stringify({ level: 'error', component: 'sentry-autopilot-reporter', message, ...data }));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Build runner metadata tags for log/metric emission so we can attribute
 * Autopilot output to the correct CLI runner (droid / cursor / claude). The
 * runner-specific model field is only included when the matching runner is
 * active, to avoid noisy empty tags on other runners.
 */
function runnerMeta(config: AutopilotConfig): Record<string, string> {
  const meta: Record<string, string> = { cli: config.cli };
  if (config.cli === 'cursor' && config.cursorModel) {
    meta.cursorModel = config.cursorModel;
  }
  if (config.cli === 'claude' && config.claudeModel) {
    meta.claudeModel = config.claudeModel;
  }
  return meta;
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

/**
 * Build the optional verification line surfaced in `slack.outcome` messages.
 * Returns `null` for `pass` / `skipped` / null verification (no behavioural
 * change in the `disabled` verifier mode); a `*Verification:*` line otherwise.
 */
function formatVerificationLine(verification: VerificationResult | null): string | null {
  if (!verification) return null;
  if (verification.status === 'pass' || verification.status === 'skipped') return null;

  const label =
    verification.status === 'soft_mismatch'
      ? ':warning: soft mismatch'
      : verification.status === 'hard_mismatch'
        ? ':x: hard mismatch'
        : verification.status === 'verification_error'
          ? ':grey_exclamation: verification error'
          : verification.status;

  const failedChecks = verification.details
    .filter((detail) => !detail.passed)
    .map((detail) => detail.check)
    .join(', ');
  const suffix = failedChecks ? ` — ${failedChecks}` : '';
  return `*Verification:* ${label}${suffix}`;
}

const ALREADY_FIXED_SIGNALS = ['already fixed', 'already merged', 'already resolved', 'fix is already', 'no new code change'];
const NOT_A_BUG_SIGNALS = [
  'working as designed',
  'not a bug',
  'not a code bug',
  'not a runtime code bug',
  'expected behavior',
  'expected behaviour',
  'by design',
  'intentional behavior',
  'intentional behaviour',
  'no fix needed',
  'no fix required',
  'no code change needed',
  'no code change required',
];

/**
 * Defensive `nonEmpty`: accepts unknown rather than `string | undefined`.
 *
 * Rationale: the outcome schema (`outcome-schema.ts`) uses `.catchall(z.unknown())`
 * on every branch, so prose fields like `outcome.blockers_to_auto_commit` and
 * `outcome.risks` are not declared on `SessionOutcome` but reach the reporter
 * intact. When the runner emits one of those as a non-string (object, array,
 * number), the previous `value.trim()` call threw `value.trim is not a function`
 * and the entire `linear.create_issue` operation failed silently. Widening to
 * `unknown` + a `typeof` guard preserves all string callsite semantics — which
 * was the only valid input shape anyway — and turns the schema's catchall
 * fields from a runtime crash into a clean no-op.
 */
function nonEmpty(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function outcomeTextForSignals(outcome: SessionOutcome): string {
  return [
    nonEmpty(outcome.root_cause),
    nonEmpty(outcome.diagnosis),
    nonEmpty(outcome.plan_summary),
    nonEmpty(outcome.reason),
  ]
    .filter((value): value is string => Boolean(value))
    .join(' ')
    .toLowerCase();
}

function looksAlreadyFixed(outcome: SessionOutcome): boolean {
  const text = outcomeTextForSignals(outcome);
  return ALREADY_FIXED_SIGNALS.some((signal) => text.includes(signal));
}

/** Defense-in-depth: detect "not a bug" even when is_bug field wasn't set in outcome. */
function looksNotABug(outcome: SessionOutcome): boolean {
  if (outcome.is_bug === false) return true;
  const text = outcomeTextForSignals(outcome);
  return NOT_A_BUG_SIGNALS.some((signal) => text.includes(signal));
}

function safePathSegment(value: string): string {
  const segment = value.replace(/[^A-Za-z0-9._-]/g, '_');
  if (segment && segment !== '.' && segment !== '..') {
    return segment;
  }

  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 16);
}

function getOutcomeReason(outcome: SessionOutcome): string {
  return nonEmpty(outcome.reason) ?? nonEmpty(outcome.error) ?? `Outcome: ${outcome.outcome}`;
}

function isParseFailure(outcome: SessionOutcome): boolean {
  return outcome.outcome === 'failed' && outcome.failure_kind === 'parse_failure';
}

function getParseFailureArtifactPath(outcome: SessionOutcome): string {
  try {
    const parsed = JSON.parse(outcome.original_outcome ?? '');
    if (parsed && typeof parsed === 'object') {
      const artifactPath = (parsed as { artifact_path?: unknown }).artifact_path;
      if (typeof artifactPath === 'string') {
        return artifactPath;
      }
    }
  } catch {
    return '<unknown>';
  }

  return '<unknown>';
}

function getPlanFile(issue: IssueRow, outcome: SessionOutcome, config: AutopilotConfig): string {
  const planFile = outcome.plan_file ?? issue.plan_file;
  // Absolute paths are explicitly rejected by `planFileSchema` (see outcome-schema.ts),
  // so this branch only fires when the value bypasses the schema (e.g. legacy DB rows
  // pre-dating the bound, or a future code path that resolves a planFile to an absolute
  // path before passing it here). Treat as a defensive escape hatch, not a routine path.
  if (planFile && path.isAbsolute(planFile)) return planFile;
  // Both accepted shapes — legacy 'plan.md' and CE2-native docs/plans/<slug>/PLAN.md —
  // resolve to the artifact-dir snapshot at <artifactDir>/plan.md, which is populated
  // by session-manager's trySnapshotPlanFile() before slot release. Reporter handoff
  // runs after the worktree is gone, so this is the canonical durable location.
  return path.join(getArtifactDir(config, issue.sentry_id), 'plan.md');
}

function getOnBranchPlanPath(outcome: SessionOutcome, issue: IssueRow): string {
  // The path the bugfixer COMMITTED the plan to on the autopilot branch — distinct
  // from the artifact-dir snapshot that getPlanFile() returns. CE2-native paths land
  // at docs/plans/<slug>/PLAN.md; legacy sessions write the literal `plan.md` at the
  // repo root. Used by handoff sections and truncation footers that point operators
  // at the on-branch file (not the host VM's artifact dir, which they cannot access).
  const planFile = outcome.plan_file ?? issue.plan_file;
  if (planFile && !path.isAbsolute(planFile)) return planFile;
  return 'plan.md';
}

function getDraftFile(issue: IssueRow, config: AutopilotConfig): string {
  return path.join(getArtifactDir(config, issue.sentry_id), 'user_response_draft.md');
}

/**
 * Format the reporter's contact info for inclusion in Slack messages, so the
 * human reviewer knows who they are responding to. Returns `null` when both
 * name and email are absent (graceful degradation — Sentry feedback widget
 * doesn't require either field). Used by both the user-reported notice and
 * the draft response.
 */
function formatReporterContactLine(issue: IssueRow): string | null {
  const name = nonEmpty(issue.user_name ?? undefined);
  const email = nonEmpty(issue.user_email ?? undefined);
  if (!name && !email) return null;
  if (name && email) return `*Reporter:* ${name} <${email}>`;
  if (email) return `*Reporter email:* ${email}`;
  return `*Reporter name:* ${name}`;
}

function getArtifactDir(config: AutopilotConfig, sentryId: string): string {
  return path.join(config.stateDir, 'artifacts', safePathSegment(sentryId));
}

function getRootCauseSummary(outcome: SessionOutcome): string {
  return (
    nonEmpty(outcome.root_cause) ??
    nonEmpty(outcome.diagnosis) ??
    nonEmpty(outcome.reason) ??
    'See linked Autopilot artifacts for diagnosis details'
  );
}

function getPlanSummary(outcome: SessionOutcome): string {
  return nonEmpty(outcome.plan_summary) ?? nonEmpty(outcome.reason) ?? 'See linked plan file for details';
}

/** Extract a Linear issue identifier (e.g. "FOX-3122") from Sentry annotations if one is linked. */
function findLinearAnnotation(annotations: unknown): { issueIdentifier: string; url: string } | null {
  if (!Array.isArray(annotations)) return null;
  for (const ann of annotations) {
    if (!isRecord(ann) || typeof ann.url !== 'string') continue;
    if (ann.url.includes('linear.app/') && typeof ann.displayName === 'string') {
      // displayName is like "FOX#3122" — Linear API needs "FOX-3122"
      const identifier = (ann.displayName as string).replace('#', '-');
      return { issueIdentifier: identifier, url: ann.url };
    }
  }
  return null;
}

function extractFingerprintFromDetail(detail: unknown): string | null {
  return fingerprintLooseHash(extractStackFrames(detail));
}

function bodyHasAutopilotFingerprint(body: string): boolean {
  return new RegExp(`^${AUTOPILOT_FINGERPRINT_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\S+`, 'm').test(body);
}

function appendAutopilotFingerprintTrailer(body: string, fingerprint: string): string {
  if (bodyHasAutopilotFingerprint(body)) {
    return body;
  }
  return `${body.trimEnd()}\n${AUTOPILOT_FINGERPRINT_PREFIX} ${fingerprint}`;
}

function getLinearPriority(issue: IssueRow): number {
  if (issue.is_user_reported) {
    return 1;
  }

  if (issue.error_type === 'crash') {
    return 2;
  }

  return 3;
}

function shouldCreateLinearIssue(outcome: SessionOutcome): boolean {
  if (isParseFailure(outcome)) return false;
  if (outcome.outcome === 'auto_committed' || outcome.outcome === 'commit_detected') return false;
  if (outcome.outcome === 'not_a_bug') return false;
  if (outcome.outcome === 'plan_created' && (looksAlreadyFixed(outcome) || looksNotABug(outcome))) return false;
  return true;
}

async function fetchWithTimeout(url: string, init: RequestInit, label = 'request'): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new TransientHttpError(`${label} timed out after ${REQUEST_TIMEOUT_MS}ms`);
    }
    if (error instanceof Error) {
      // Network-level failures (DNS, TCP RST, fetch failed) are treated as transient.
      throw new TransientHttpError(`${label} network error: ${error.message}`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function assertOk(response: Response, integration: string): Promise<void> {
  if (response.ok) {
    return;
  }

  const body = (await response.text()).slice(0, 500);
  const message = `${integration} request failed (${response.status} ${response.statusText}): ${body}`;
  throw classifyHttpError(message, response.status);
}

/**
 * Extract the numeric pull-request id from a GitHub PR html_url.
 * Returns `null` when the URL doesn't match the expected
 * `https://github.com/<owner>/<repo>/pull/<number>` shape, so callers can
 * distinguish "missing PR" from "malformed PR URL" and fail loudly.
 */
export function parsePrNumberFromUrl(prUrl: string): number | null {
  const match = /\/pull\/(\d+)(?:[/?#]|$)/.exec(prUrl);
  if (!match) return null;
  const parsed = Number.parseInt(match[1], 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parseLinearIssue(payload: unknown): LinearIssue | null {
  if (!isRecord(payload)) {
    throw new Error('Unexpected Linear response: expected an object');
  }

  if (Array.isArray(payload.errors) && payload.errors.length > 0) {
    throw new Error(`Linear GraphQL error: ${JSON.stringify(payload.errors).slice(0, 500)}`);
  }

  const data = payload.data;
  if (!isRecord(data) || !isRecord(data.issueCreate)) {
    throw new Error('Unexpected Linear response: missing data.issueCreate');
  }

  if (data.issueCreate.success !== true) {
    throw new Error('Linear issueCreate returned success=false');
  }

  const issue = data.issueCreate.issue;
  if (!isRecord(issue) || typeof issue.id !== 'string' || typeof issue.url !== 'string') {
    throw new Error('Unexpected Linear response: missing issue id/url');
  }

  return { id: issue.id, url: issue.url };
}

export class Reporter {
  private readonly log = {
    warn: (data: Record<string, unknown>, message: string): void => {
      logWarn(data, message);
    },
  };

  constructor(private readonly config: AutopilotConfig) {}

  async reportSessionStarted(issue: IssueRow): Promise<void> {
    await this.executeOperation('sentry.start_comment', () =>
      this.postSentryComment(issue, this.buildSessionStartedSentryComment()),
    );

    const sentryLink = `<${issue.sentry_url}|${issue.sentry_id}>`;
    const title = truncate(issue.title, 80);
    await this.executeOperation('slack.session_started', () =>
      this.sendSlack(
        `:robot_face: *Autopilot is investigating a bug*\n*Issue:* ${sentryLink} — ${title}\n*Impact:* ${issue.occurrences ?? '?'} events, ${issue.users ?? '?'} users`,
      ),
    );
  }

  private buildSessionStartedSentryComment(): string {
    return [
      `Sentry Autopilot is investigating this issue. Started at ${new Date().toISOString()}.`,
      "Please don't pick up this issue manually — a follow-up comment will land here in ~10 min (longer if the bugfix subagent is invoked) with the diagnosis, any Linear ticket link, and any auto-applied fix commit.",
    ].join('\n\n');
  }

  async reportOutcome(
    issue: IssueRow,
    outcome: SessionOutcome,
    verification: VerificationResult | null = null,
  ): Promise<LinearIssue | null> {
    // Plan files no longer get committed to the repo from the reporter (Stage
    // C removed `commitPlanToRepo`). The autopilot-branch flow (Stages D + E)
    // is how plan files reach origin; until then the plan file lives only in
    // `~/sentry-autopilot/artifacts/<id>/plan.md` and operators reference it
    // there directly.
    const repoPlanPath: string | null = null;

    let linearIssue: LinearIssue | null = null;
    if (shouldCreateLinearIssue(outcome)) {
      // Check if a Linear issue is already linked via Sentry annotations (e.g. from in-app bug report)
      const linkResult = await this.executeOperation('sentry.check_linear_link', () =>
        this.fetchLinearLinkFromSentry(issue),
      );
      const existingLink = linkResult.success ? linkResult.value : null;
      if (existingLink) {
        const resolveResult = await this.executeOperation('linear.resolve_existing', () =>
          this.resolveLinearIssueId(existingLink.issueIdentifier),
        );
        const resolved = resolveResult.success ? resolveResult.value : null;
        if (resolved) {
          const commentResult = await this.executeOperation('linear.comment_existing', () =>
            this.commentOnLinearIssue(resolved.id, issue, outcome),
          );
          if (commentResult.success) {
            linearIssue = { id: resolved.id, url: resolved.url, reused: true };
          }
        }
      }
      if (!linearIssue) {
        const createResult = await this.executeOperation('linear.create_issue', () =>
          this.createLinearIssue(issue, outcome),
        );
        linearIssue = createResult.success ? createResult.value : null;
      }
    }
    const linearUrl = linearIssue?.url ?? issue.linear_issue_id ?? 'not created';

    if (looksAlreadyFixed(outcome) && issue.linear_issue_id) {
      await this.executeOperation('linear.backfill_fingerprint', () =>
        this.backfillFingerprintOnLooksAlreadyFixed(issue),
      );
    }

    await this.executeOperation('slack.outcome', () =>
      this.sendSlack(
        this.buildOutcomeSlackMessage(issue, outcome, linearUrl, repoPlanPath, linearIssue?.reused, verification),
      ),
    );

    // User-response draft is only useful — and only honest — when we have
    // actually shipped a fix to `dev` (auto_committed → autopilot PR
    // squash-merged into dev). For every other outcome (plan_created,
    // escalated, not_a_bug, failed, parse_failure) the draft would either
    // promise something we haven't done or leak a half-investigation, so we
    // skip both the notice and the draft Slack messages.
    if (issue.is_user_reported && outcome.outcome === 'auto_committed') {
      const sentryLink = `<${issue.sentry_url}|${issue.sentry_id}>`;
      const reporterLine = formatReporterContactLine(issue);
      const noticeLines = [
        `:bust_in_silhouette: *User-reported bug — someone needs to respond to the reporter*`,
        `*Issue:* ${sentryLink} — ${truncate(issue.title, 80)}`,
        ...(reporterLine ? [reporterLine] : []),
        `*Action:* Review the draft response below and send it to the user via the appropriate channel (in-app reply, email, etc).`,
      ];
      await this.executeOperation('slack.user_reported_notice', () =>
        this.sendSlack(noticeLines.join('\n')),
      );
      await this.executeOperation('slack.draft_response', () => this.sendDraftResponse(issue));
    }

    if (!isParseFailure(outcome)) {
      await this.executeOperation('sentry.comment', () =>
        this.postSentryComment(issue, this.buildSentryComment(issue, outcome, linearUrl)),
      );
    }

    await this.executeOperation('sentry.status_update', () => this.updateSentryIssueStatus(issue, outcome));

    return linearIssue;
  }

  async reportKillSwitch(mode: 'pause' | 'stop'): Promise<void> {
    const filename = mode === 'stop' ? 'STOP' : 'PAUSE';
    const stateLabel = mode === 'stop' ? 'stopped' : 'paused';
    const result = await this.executeOperation('slack.kill_switch', () =>
      this.sendSlack(
        `:octagonal_sign: *Autopilot has been ${stateLabel}*\nA \`${filename}\` file was detected — no new issues will be dispatched until it is removed.\n*Action:* To resume, delete \`~/sentry-autopilot/${filename}\` on the VM. To investigate, check \`~/sentry-autopilot/logs/cron.log\`.`,
      ),
    );
    if (result.success) {
      logWarn({ mode, ...runnerMeta(this.config) }, 'Kill switch is active; new dispatches are paused');
    }
  }

  async reportKillSwitchResumed(previousMode: 'pause' | 'stop'): Promise<void> {
    const previousFile = previousMode === 'stop' ? 'STOP' : 'PAUSE';
    const result = await this.executeOperation('slack.kill_switch_resumed', () =>
      this.sendSlack(
        `:white_check_mark: *Autopilot resumed* — the \`${previousFile}\` file was cleared; dispatching will continue next tick.`,
      ),
    );
    if (result.success) {
      logWarn({ previousMode, ...runnerMeta(this.config) }, 'Kill switch cleared; dispatching will resume next tick');
    }
  }

  async reportHeartbeat(stats: HeartbeatStats): Promise<void> {
    await this.executeOperation('slack.heartbeat', () =>
      this.sendSlack(
        `:heartbeat: *Autopilot daily*: ${stats.processed} processed, ${stats.committed} auto-committed, ${stats.plans} plans, ${stats.escalated} escalated, ${stats.failed} failed`,
      ),
    );
  }

  async reportReleaseGateEnabled(lagToleranceMinor: number): Promise<void> {
    await this.executeOperation('slack.release_gate_enabled', () =>
      this.sendSlack(
        `Autopilot: release-aware triage filter is now enabled (lag tolerance: ${lagToleranceMinor} minor versions; requires AUTOPILOT_PENDING_MODE=enforce). Issues whose last seen release predates the current monitored release will be skipped with one quiet Sentry comment per (issue, release-pair). If you didn't expect this behavioural change, see plan 260607_autopilot-triage-hardening.`,
      ),
    );
  }

  async reportFailureCascade(count: number): Promise<void> {
    await this.executeOperation('slack.failure_cascade', () =>
      this.sendSlack(
        `:rotating_light: *Autopilot auto-paused after ${count} failures in a single run*\nThis usually means an infrastructure problem (expired token, VM issue, or code error) rather than individual bug complexity.\n*Action:* Check \`~/sentry-autopilot/logs/cron.log\` on the VM, fix the underlying issue, then delete the \`PAUSE\` file to resume.`,
      ),
    );
  }

  async reportPollerQueryFailure(name: string, error: unknown): Promise<void> {
    const message = errorMessage(error);
    const stack = error instanceof Error ? error.stack : undefined;
    // The warn breadcrumb is emitted unconditionally; the Slack send is the
    // only failable side effect, so it's the only thing wrapped in executeOperation.
    this.log.warn(
      { name, error: message, stack, log_discriminator: 'supervisor_fail', ...runnerMeta(this.config) },
      `Poller query ${name} failed`,
    );
    await this.executeOperation(`reportPollerQueryFailure:${name}`, () =>
      this.sendSlack({
        text: `:exclamation: Sentry autopilot poller query \`${name}\` failed: ${message}`,
        log_discriminator: 'supervisor_fail',
      }),
    );
  }

  /**
   * Execute a single reporter side effect with structured success/failure
   * accounting. Each call emits one of:
   *   - `reporter.call.success.<operation>` counter on resolve
   *   - `reporter.call.failure.<operation>` counter + `reporter_fail` errorLog
   *     on throw
   * and never re-throws, so the orchestrator continues to subsequent calls.
   *
   * The typed return value lets future stages (mirror-mode reconciliation,
   * push-mode retry) inspect both the success value and the error class
   * (`TransientHttpError` vs `PermanentHttpError`) for richer decisions.
   */
  private async executeOperation<T>(
    operation: string,
    fn: () => Promise<T>,
  ): Promise<ReportOperationResult<T>> {
    const meta = runnerMeta(this.config);
    try {
      const value = await fn();
      emitCounter('reporter.call.success', { operation, ...meta });
      return { success: true, operation, value };
    } catch (error) {
      const errorAsError = error instanceof Error ? error : new Error(errorMessage(error));
      emitCounter('reporter.call.failure', { operation, ...meta });
      errorLog(
        'reporter_fail',
        { operation, error: errorMessage(error), success: false, ...meta },
        'Reporter operation failed',
      );
      return { success: false, operation, error: errorAsError };
    }
  }

  private buildOutcomeSlackMessage(
    issue: IssueRow,
    outcome: SessionOutcome,
    linearUrl: string,
    repoPlanPath: string | null,
    linearReused?: boolean,
    verification: VerificationResult | null = null,
  ): string {
    const sentryLink = `<${issue.sentry_url}|${issue.sentry_id}>`;
    const title = issue.title.length > 80 ? `${issue.title.slice(0, 77)}...` : issue.title;
    const confidence = outcome.confidence ?? issue.confidence;
    const planRef = repoPlanPath ? `\`${repoPlanPath}\`` : null;
    const verificationLine = formatVerificationLine(verification);

    const maybeVerification = verificationLine ? [verificationLine] : [];

    if (outcome.outcome === 'auto_committed') {
      const commit = outcome.commit_hash ?? issue.commit_hash ?? 'unknown';
      return [
        `:white_check_mark: *Autopilot fixed a bug and merged it into dev*`,
        `*Issue:* ${sentryLink} — ${title}`,
        ...maybeVerification,
        `*Commit:* \`${commit}\` (confidence: ${confidence ?? 'unknown'}%)`,
        `Squash-merged via autopilot PR. No action needed — verify in next beta deploy.`,
      ].join('\n');
    }

    if (outcome.outcome === 'plan_created') {
      if (looksAlreadyFixed(outcome)) {
        return [
          `:white_check_mark: *Autopilot confirmed this bug is already fixed on dev*`,
          `*Issue:* ${sentryLink} — ${title}`,
          ...maybeVerification,
          `*Confidence:* ${confidence ?? 'unknown'}% · ${issue.occurrences ?? '?'} events, ${issue.users ?? '?'} users`,
          `*Details:* ${truncate(getRootCauseSummary(outcome), 200)}`,
          `Sentry issue resolved. No action needed — the fix will ship with the next stable release.`,
        ].join('\n');
      }

      if (looksNotABug(outcome)) {
        return [
          `:see_no_evil: *Autopilot triaged as not-a-bug*`,
          `*Issue:* ${sentryLink} — ${title}`,
          ...maybeVerification,
          `*Reason:* ${truncate(getRootCauseSummary(outcome), 200)}`,
          `Sentry issue ignored (will resurface if it escalates). No action needed unless you disagree.`,
        ].join('\n');
      }

      const pickupLines: string[] = [];
      if (linearUrl !== 'not created') {
        const linkLabel = linearReused ? 'Diagnosis added to existing ticket' : 'Pick up here';
        pickupLines.push(`→ *Linear:* <${linearUrl}|${linkLabel}>`);
      }
      if (planRef) {
        pickupLines.push(`→ *Plan:* ${planRef} (committed to repo)`);
      }

      return [
        `:memo: *Autopilot diagnosed a bug — needs someone to implement the fix*`,
        `*Issue:* ${sentryLink} — ${title}`,
        ...maybeVerification,
        `*Confidence:* ${confidence ?? 'unknown'}% · ${issue.occurrences ?? '?'} events, ${issue.users ?? '?'} users`,
        `*Root cause:* ${truncate(getRootCauseSummary(outcome), 200)}`,
        `*Action:* Review the diagnosis and implement the proposed fix.`,
        ...pickupLines,
      ].join('\n');
    }

    if (outcome.outcome === 'escalated') {
      const pickupLines: string[] = [];
      if (linearUrl !== 'not created') {
        const linkLabel = linearReused ? 'Diagnosis added to existing ticket' : 'Pick up here';
        pickupLines.push(`→ *Linear:* <${linearUrl}|${linkLabel}>`);
      }
      if (planRef) {
        pickupLines.push(`→ *Notes:* ${planRef} (committed to repo)`);
      }

      return [
        `:warning: *Autopilot couldn't resolve this one — human investigation needed*`,
        `*Issue:* ${sentryLink} — ${title}`,
        ...maybeVerification,
        `*Why:* ${truncate(getOutcomeReason(outcome), 200)}`,
        `*Action:* Open the Sentry issue, review the autopilot comment for what was tried, and investigate further.`,
        ...pickupLines,
      ].join('\n');
    }

    if (outcome.outcome === 'not_a_bug') {
      return [
        `:see_no_evil: *Autopilot triaged as noise/not-a-bug*`,
        `*Issue:* ${sentryLink} — ${title}`,
        `*Reason:* ${truncate(getOutcomeReason(outcome), 200)}`,
        `Sentry issue ignored (will resurface if it escalates). No action needed unless you disagree.`,
      ].join('\n');
    }

    if (outcome.outcome === 'failed' && outcome.failure_kind === 'parse_failure') {
      const artifactPath = getParseFailureArtifactPath(outcome);
      return [
        `:exclamation: *Autopilot outcome parse failure* — terminal, no retry`,
        `*Issue:* ${sentryLink} — ${title}`,
        `*Failure kind:* parse_failure (terminal)`,
        `*Reason:* ${truncate(getOutcomeReason(outcome), 200)}`,
        `*Artifact:* \`${artifactPath}\``,
        `*Action:* Inspect outcome.json + supervisor.log.`,
      ].join('\n');
    }

    return [
      `:x: *Autopilot failed after ${issue.dispatch_count} attempt${issue.dispatch_count === 1 ? '' : 's'}*`,
      `*Issue:* ${sentryLink} — ${title}`,
      `*Error:* ${truncate(getOutcomeReason(outcome), 200)}`,
      `*Action:* Check the Sentry issue and autopilot logs. This may need manual diagnosis, or the autopilot hit an infrastructure problem.`,
    ].join('\n');
  }

  private buildSentryComment(issue: IssueRow, outcome: SessionOutcome, linearUrl: string): string {
    const userReportedSuffix = issue.is_user_reported ? ' Draft response to user prepared.' : '';

    if (outcome.outcome === 'auto_committed') {
      return `Autopilot fix merged to dev (squash) via autopilot PR: \`${
        outcome.commit_hash ?? issue.commit_hash ?? 'unknown'
      }\`. Diagnosis: ${getRootCauseSummary(outcome)}.${userReportedSuffix}`;
    }

    if (outcome.outcome === 'plan_created') {
      return `Autopilot analysis complete. Confidence: ${
        outcome.confidence ?? issue.confidence ?? 'unknown'
      }%. Plan: ${getPlanSummary(outcome)}. Linear: ${linearUrl}.${userReportedSuffix}`;
    }

    if (outcome.outcome === 'escalated') {
      return `Autopilot investigated but couldn't resolve autonomously. Reason: ${getOutcomeReason(
        outcome,
      )}. Linear: ${linearUrl}.${userReportedSuffix}`;
    }

    if (outcome.outcome === 'not_a_bug') {
      return `Autopilot triaged this as not a code bug. Reason: ${getOutcomeReason(outcome)}.${userReportedSuffix}`;
    }

    return `Autopilot failed after ${issue.dispatch_count} attempts. Error: ${getOutcomeReason(
      outcome,
    )}.${userReportedSuffix}`;
  }

  private async sendSlack(message: string | SlackMessagePayload): Promise<void> {
    const payload: SlackMessagePayload = typeof message === 'string' ? { text: message } : message;

    if (!this.config.slackWebhook) {
      logWarn({
        ...(payload.log_discriminator ? { log_discriminator: payload.log_discriminator } : {}),
        ...runnerMeta(this.config),
      }, 'Skipping Slack notification because SLACK_WEBHOOK is not set');
      return;
    }

    const response = await fetchWithTimeout(this.config.slackWebhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }, 'Slack webhook');
    await assertOk(response, 'Slack');
  }

  private async sendDraftResponse(issue: IssueRow): Promise<void> {
    if (!this.config.slackWebhook) {
      return;
    }

    const draftFile = getDraftFile(issue, this.config);
    if (!fs.existsSync(draftFile)) {
      return;
    }

    const draftText = fs.readFileSync(draftFile, 'utf8').trim();
    if (!draftText) {
      return;
    }

    // Surface the reporter's contact alongside the draft so the human
    // reviewer knows exactly who they're responding to. Falls back
    // gracefully (no line) when no contact info was captured from the
    // Sentry feedback widget.
    const reporterLine = formatReporterContactLine(issue);
    const headerLines = [
      `:bust_in_silhouette: *Draft response for ${issue.sentry_id} reporter:*`,
      ...(reporterLine ? [reporterLine] : []),
    ];
    await this.sendSlack(
      `${headerLines.join('\n')}\n\n${draftText}\n\n_Review and send via appropriate channel (in-app, email, etc.)_`,
    );
  }

  /** Fetch annotations from Sentry issue detail and check for an existing Linear link. */
  private async fetchLinearLinkFromSentry(issue: IssueRow): Promise<{ issueIdentifier: string; url: string } | null> {
    const url = new URL(`/api/0/issues/${encodeURIComponent(issue.sentry_id)}/`, SENTRY_API_BASE_URL);
    const response = await fetchWithTimeout(
      url.toString(),
      {
        method: 'GET',
        headers: { Authorization: `Bearer ${this.config.sentryAuthToken}` },
      },
      'Sentry issue detail',
    );
    await assertOk(response, 'Sentry issue detail');
    const data = await response.json();
    return findLinearAnnotation(data?.annotations);
  }

  /** Resolve a Linear issue identifier (e.g. "FOX-3122") to its UUID via the Linear API. */
  private async resolveLinearIssueId(identifier: string): Promise<{ id: string; url: string } | null> {
    if (!this.config.linearApiKey) return null;

    const response = await fetchWithTimeout(
      LINEAR_API_URL,
      {
        method: 'POST',
        headers: {
          Authorization: this.config.linearApiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          query: `query IssueByIdentifier($id: String!) { issue(id: $id) { id url } }`,
          variables: { id: identifier },
        }),
      },
      'Linear issue lookup',
    );
    await assertOk(response, 'Linear issue lookup');
    const payload = await response.json();
    const issue = payload?.data?.issue;
    if (isRecord(issue) && typeof issue.id === 'string' && typeof issue.url === 'string') {
      return { id: issue.id as string, url: issue.url as string };
    }
    return null;
  }

  private async getLooseFingerprintForIssue(sentryId: string): Promise<string | null> {
    const detail = await fetchIssueDetail(sentryId, this.config);
    return extractFingerprintFromDetail(detail);
  }

  private async getLooseFingerprintForLinearBody(issue: IssueRow): Promise<string | null> {
    try {
      return await this.getLooseFingerprintForIssue(issue.sentry_id);
    } catch (error) {
      logWarn(
        { sentryId: issue.sentry_id, error: errorMessage(error), ...runnerMeta(this.config) },
        'Linear handoff body: could not compute Sentry stack fingerprint; emitting ticket without fingerprint trailer',
      );
      return null;
    }
  }

  private async fetchLinearIssueDescription(linearIssueId: string): Promise<string | null> {
    if (!this.config.linearApiKey) return null;

    const response = await fetchWithTimeout(
      LINEAR_API_URL,
      {
        method: 'POST',
        headers: {
          Authorization: this.config.linearApiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          query: `query AutopilotIssueDescription($id: String!) { issue(id: $id) { description } }`,
          variables: { id: linearIssueId },
        }),
      },
      'Linear issue description',
    );
    await assertOk(response, 'Linear issue description');
    const payload = await response.json();
    if (Array.isArray(payload?.errors) && payload.errors.length > 0) {
      throw new Error(`Linear GraphQL error: ${JSON.stringify(payload.errors).slice(0, 500)}`);
    }
    const description = payload?.data?.issue?.description;
    return typeof description === 'string' ? description : null;
  }

  private async updateLinearIssueDescription(linearIssueId: string, description: string): Promise<void> {
    if (!this.config.linearApiKey) return;

    const response = await fetchWithTimeout(
      LINEAR_API_URL,
      {
        method: 'POST',
        headers: {
          Authorization: this.config.linearApiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          query: `
            mutation AutopilotIssueDescriptionUpdate($id: String!, $input: IssueUpdateInput!) {
              issueUpdate(id: $id, input: $input) {
                success
              }
            }
          `,
          variables: { id: linearIssueId, input: { description } },
        }),
      },
      'Linear issue update',
    );
    await assertOk(response, 'Linear issue update');
    const payload = await response.json();
    if (Array.isArray(payload?.errors) && payload.errors.length > 0) {
      throw new Error(`Linear GraphQL error: ${JSON.stringify(payload.errors).slice(0, 500)}`);
    }
    if (payload?.data?.issueUpdate?.success !== true) {
      throw new Error('Linear issueUpdate returned success=false');
    }
  }

  private async backfillFingerprintOnLooksAlreadyFixed(issue: IssueRow): Promise<void> {
    if (!issue.linear_issue_id) return;
    if (!this.config.linearApiKey) return;

    const fingerprint = await this.getLooseFingerprintForIssue(issue.sentry_id);
    if (!fingerprint) {
      logWarn(
        { sentryId: issue.sentry_id, linearIssueId: issue.linear_issue_id, ...runnerMeta(this.config) },
        'Skipping Linear fingerprint backfill because no stack-frame fingerprint was computable',
      );
      return;
    }

    const currentDescription = await this.fetchLinearIssueDescription(issue.linear_issue_id);
    if (!currentDescription || bodyHasAutopilotFingerprint(currentDescription)) {
      return;
    }

    try {
      await this.updateLinearIssueDescription(
        issue.linear_issue_id,
        appendAutopilotFingerprintTrailer(currentDescription, fingerprint),
      );
    } catch (error) {
      this.log.warn(
        { sentryId: issue.sentry_id, linearTicketId: issue.linear_issue_id, error: errorMessage(error) },
        'autopilot.backfill_fingerprint.failed',
      );
    }
  }

  /** Add a comment to an existing Linear issue with the autopilot diagnosis. */
  private async commentOnLinearIssue(linearIssueId: string, issue: IssueRow, outcome: SessionOutcome): Promise<void> {
    if (!this.config.linearApiKey) return;

    const body = buildLinearCommentBody(
      issue,
      outcome,
      this.config,
      await this.getLooseFingerprintForLinearBody(issue),
    );

    const response = await fetchWithTimeout(
      LINEAR_API_URL,
      {
        method: 'POST',
        headers: {
          Authorization: this.config.linearApiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          query: `mutation CommentCreate($input: CommentCreateInput!) { commentCreate(input: $input) { success } }`,
          variables: { input: { issueId: linearIssueId, body } },
        }),
      },
      'Linear comment',
    );
    await assertOk(response, 'Linear comment');
  }

  private async createLinearIssue(issue: IssueRow, outcome: SessionOutcome): Promise<LinearIssue | null> {
    if (!this.config.linearApiKey) {
      logWarn(
        { sentryId: issue.sentry_id, ...runnerMeta(this.config) },
        'Skipping Linear issue creation because LINEAR_API_KEY is not set',
      );
      return null;
    }

    const teamId = process.env.LINEAR_TEAM_ID?.trim();
    if (!teamId) {
      logWarn(
        { sentryId: issue.sentry_id, ...runnerMeta(this.config) },
        'Skipping Linear issue creation because LINEAR_TEAM_ID is not set',
      );
      return null;
    }

    const response = await fetchWithTimeout(
      LINEAR_API_URL,
      {
        method: 'POST',
        headers: {
          Authorization: this.config.linearApiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          query: `
            mutation AutopilotIssueCreate($input: IssueCreateInput!) {
              issueCreate(input: $input) {
                success
                issue {
                  id
                  url
                }
              }
            }
          `,
          variables: {
            input: {
              teamId,
              title: `[Autopilot] ${issue.title}`,
              description: await this.buildLinearDescription(issue, outcome),
              priority: getLinearPriority(issue),
            },
          },
        }),
      },
      'Linear',
    );

    await assertOk(response, 'Linear');
    return parseLinearIssue(await response.json());
  }

  private async buildLinearDescription(issue: IssueRow, outcome: SessionOutcome): Promise<string> {
    return buildLinearHandoffBody(
      issue,
      outcome,
      this.config,
      await this.getLooseFingerprintForLinearBody(issue),
    );
  }

  private async updateSentryIssueStatus(issue: IssueRow, outcome: SessionOutcome): Promise<void> {
    let body: Record<string, unknown> | null = null;

    if (outcome.outcome === 'auto_committed') {
      body = { status: 'resolved' };
    } else if (outcome.outcome === 'plan_created' && looksAlreadyFixed(outcome)) {
      body = { status: 'resolved' };
    } else if (outcome.outcome === 'not_a_bug' || (outcome.outcome === 'plan_created' && looksNotABug(outcome))) {
      body = { status: 'ignored', statusDetails: {}, substatus: 'archived_until_escalating' };
    }

    if (!body) {
      return;
    }

    const url = new URL(`/api/0/issues/${encodeURIComponent(issue.sentry_id)}/`, SENTRY_API_BASE_URL);
    const response = await fetchWithTimeout(
      url.toString(),
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${this.config.sentryAuthToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      },
      'Sentry status update',
    );
    await assertOk(response, 'Sentry status update');
  }

  private async postSentryComment(issue: IssueRow, text: string): Promise<void> {
    const url = new URL(`/api/0/issues/${encodeURIComponent(issue.sentry_id)}/comments/`, SENTRY_API_BASE_URL);
    const response = await fetchWithTimeout(
      url.toString(),
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.config.sentryAuthToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ text }),
      },
      'Sentry comments',
    );
    await assertOk(response, 'Sentry comments');
  }

  // === Per-kind executors (Stage C) =========================================
  //
  // Each executor accepts a fully-typed payload and either resolves on
  // success or throws (Transient/Permanent HTTP error). The pending-drainer
  // wraps each call in `executeOperation` for success/failure counters; this
  // mirrors the inline `reportOutcome` path on Stage A. Pass the IssueRow
  // for any executor that needs to address an external resource (Sentry
  // issue id, Linear ticket id, etc.); the payload itself stays opaque so
  // the schema can evolve without changing executor signatures.

  /** Execute a `sentry_status` pending action. Idempotent: re-firing the same
   * status is a no-op on Sentry's side. */
  async executeSentryStatus(
    issue: IssueRow,
    payload: {
      status: 'resolved' | 'ignored';
      status_details?: Record<string, unknown>;
      substatus?: 'archived_until_escalating' | 'archived_forever';
    },
  ): Promise<void> {
    const body: Record<string, unknown> = { status: payload.status };
    if (payload.status_details) {
      body.statusDetails = payload.status_details;
    }
    if (payload.substatus) {
      body.substatus = payload.substatus;
    }
    const url = new URL(`/api/0/issues/${encodeURIComponent(issue.sentry_id)}/`, SENTRY_API_BASE_URL);
    const response = await fetchWithTimeout(
      url.toString(),
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${this.config.sentryAuthToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      },
      'Sentry status update',
    );
    await assertOk(response, 'Sentry status update');
  }

  /** Execute a `sentry_comment` pending action. At-least-once — Sentry has
   * no native dedup, so the drainer's body-hash idempotency_key prevents
   * re-firing identical text. */
  async executeSentryComment(issue: IssueRow, payload: { text: string }): Promise<void> {
    await this.postSentryComment(issue, payload.text);
  }

  /** Execute a `slack_outcome` / `slack_user_alert` / `slack_draft_response`
   * pending action. Slack is at-least-once by design; the drainer's body
   * hash prevents duplicate text. */
  async executeSlackMessage(payload: { text: string; log_discriminator?: string }): Promise<void> {
    await this.sendSlack(payload);
  }

  /** Execute a `linear_create_issue` pending action. Probe-first via the
   * drainer (it re-fetches Sentry annotations) — by the time we reach this
   * executor, no existing link was found. */
  async executeLinearCreateIssue(
    issue: IssueRow,
    payload: { title: string; description: string; priority: number },
  ): Promise<LinearIssue | null> {
    if (!this.config.linearApiKey) {
      logWarn(
        { sentryId: issue.sentry_id, ...runnerMeta(this.config) },
        'Skipping Linear issue creation because LINEAR_API_KEY is not set',
      );
      return null;
    }

    const teamId = process.env.LINEAR_TEAM_ID?.trim();
    if (!teamId) {
      logWarn(
        { sentryId: issue.sentry_id, ...runnerMeta(this.config) },
        'Skipping Linear issue creation because LINEAR_TEAM_ID is not set',
      );
      return null;
    }

    const response = await fetchWithTimeout(
      LINEAR_API_URL,
      {
        method: 'POST',
        headers: {
          Authorization: this.config.linearApiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          query: `
            mutation AutopilotIssueCreate($input: IssueCreateInput!) {
              issueCreate(input: $input) {
                success
                issue {
                  id
                  url
                }
              }
            }
          `,
          variables: {
            input: {
              teamId,
              title: payload.title,
              description: payload.description,
              priority: payload.priority,
            },
          },
        }),
      },
      'Linear',
    );

    await assertOk(response, 'Linear');
    return parseLinearIssue(await response.json());
  }

  /** Execute a `linear_comment_existing` pending action. `identifier_hint`,
   * when present, lets the drainer skip re-resolution (Stage C: hint always
   * present from the Sentry-annotations probe). */
  async executeLinearCommentExisting(
    issue: IssueRow,
    payload: { identifier_hint?: string; body: string },
  ): Promise<void> {
    if (!this.config.linearApiKey) {
      logWarn(
        { sentryId: issue.sentry_id, ...runnerMeta(this.config) },
        'Skipping Linear comment because LINEAR_API_KEY is not set',
      );
      return;
    }

    const identifier = payload.identifier_hint;
    if (!identifier) {
      throw new Error(
        `linear_comment_existing for ${issue.sentry_id} missing identifier_hint`,
      );
    }
    const resolved = await this.resolveLinearIssueId(identifier);
    if (!resolved) {
      throw new Error(
        `linear_comment_existing for ${issue.sentry_id} could not resolve ${identifier}`,
      );
    }

    const response = await fetchWithTimeout(
      LINEAR_API_URL,
      {
        method: 'POST',
        headers: {
          Authorization: this.config.linearApiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          query: `mutation CommentCreate($input: CommentCreateInput!) { commentCreate(input: $input) { success } }`,
          variables: { input: { issueId: resolved.id, body: payload.body } },
        }),
      },
      'Linear comment',
    );
    await assertOk(response, 'Linear comment');
  }

  /** Execute a `pr_open` pending action via the GitHub REST API.
   *
   * Idempotency: a `GET /repos/{owner}/{repo}/pulls?head=...&state=open`
   * probe runs first. If an open PR already exists for the head branch we
   * return its URL without POSTing. This matches the at-most-once semantics
   * the drainer expects — the probe is the external check-then-skip.
   *
   * Errors:
   *   - Missing `githubToken` or `repoFullName` → throws (config-interlock
   *     should prevent this, but guard explicitly so a misuse via direct
   *     drainer invocation fails fast).
   *   - 422 on POST with `body.errors[].message` matching `head` → branch
   *     not yet on origin. Surfaced as a transient-style error so the
   *     drainer keeps it in the queue for the next tick.
   *   - Other non-2xx → `classifyHttpError` (TransientHttpError or
   *     PermanentHttpError) so the drainer's retry policy applies.
   */
  async executePrOpen(
    _issue: IssueRow,
    payload: { branch_name: string; base: 'dev'; title: string; body: string },
  ): Promise<{ url: string }> {
    if (!this.config.githubToken) {
      throw new Error('executePrOpen requires githubToken (GITHUB_TOKEN env)');
    }
    if (!this.config.repoFullName) {
      throw new Error('executePrOpen requires repoFullName (AUTOPILOT_REPO_FULL_NAME env)');
    }
    const [owner, repo] = this.config.repoFullName.split('/');
    const authHeader = `Bearer ${this.config.githubToken}`;
    const acceptHeader = 'application/vnd.github+json';

    // Idempotency probe: an open PR for this head branch already exists?
    const probeUrl = `https://api.github.com/repos/${owner}/${repo}/pulls`
      + `?head=${owner}:${encodeURIComponent(payload.branch_name)}&state=open`;
    const probe = await fetchWithTimeout(
      probeUrl,
      { method: 'GET', headers: { Authorization: authHeader, Accept: acceptHeader } },
      'GitHub PR list',
    );
    await assertOk(probe, 'GitHub PR list');
    const existing = (await probe.json()) as Array<{ html_url?: unknown }>;
    if (Array.isArray(existing) && existing.length > 0) {
      const first = existing[0];
      if (first && typeof first.html_url === 'string') {
        emitCounter('pending.pr_open.skipped_existing', runnerMeta(this.config));
        return { url: first.html_url };
      }
    }

    const createResponse = await fetchWithTimeout(
      `https://api.github.com/repos/${owner}/${repo}/pulls`,
      {
        method: 'POST',
        headers: {
          Authorization: authHeader,
          Accept: acceptHeader,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          title: payload.title,
          body: payload.body,
          head: payload.branch_name,
          base: payload.base,
        }),
      },
      'GitHub PR create',
    );
    if (!createResponse.ok) {
      const bodyText = (await createResponse.text()).slice(0, 1000);
      if (createResponse.status === 422 && /head/i.test(bodyText)) {
        // 422 with a head-related error message means the branch isn't on
        // origin yet (or was just deleted). Treat as transient so the
        // drainer retries on the next tick after the branch is pushed.
        throw new TransientHttpError(
          `GitHub PR create returned 422 (branch likely not on origin yet): ${bodyText}`,
        );
      }
      throw classifyHttpError(
        `GitHub PR create failed (${createResponse.status} ${createResponse.statusText}): ${bodyText}`,
        createResponse.status,
      );
    }
    const created = (await createResponse.json()) as { html_url?: unknown };
    if (!created || typeof created.html_url !== 'string') {
      throw new Error('GitHub PR create response missing html_url');
    }
    emitCounter('pending.pr_open.created', runnerMeta(this.config));
    return { url: created.html_url };
  }

  /** Probe GitHub for an existing open PR for the given head branch. Used
   * by the drainer's `pr_open` probe (Stage E): returns the PR URL when an
   * open PR exists, `null` when none does. Returns `null` rather than
   * throwing on missing credentials so the drainer can fall through to the
   * executor (which throws with the canonical "credentials required"
   * message). */
  async probePrOpen(branchName: string): Promise<string | null> {
    if (!this.config.githubToken || !this.config.repoFullName) return null;
    const [owner, repo] = this.config.repoFullName.split('/');
    const probeUrl = `https://api.github.com/repos/${owner}/${repo}/pulls`
      + `?head=${owner}:${encodeURIComponent(branchName)}&state=open`;
    const probe = await fetchWithTimeout(
      probeUrl,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${this.config.githubToken}`,
          Accept: 'application/vnd.github+json',
        },
      },
      'GitHub PR list',
    );
    await assertOk(probe, 'GitHub PR list');
    const existing = (await probe.json()) as Array<{ html_url?: unknown }>;
    if (Array.isArray(existing) && existing.length > 0) {
      const first = existing[0];
      if (first && typeof first.html_url === 'string') return first.html_url;
    }
    return null;
  }

  /** Execute a `pr_merge` pending action via the GitHub REST merge endpoint.
   *
   * Reads the PR URL from `issue.pr_url` (written by `executePrOpen` in the
   * same drain pass — `ACTION_DRAIN_ORDER` puts pr_open immediately before
   * pr_merge). The drainer is expected to call this with an issue whose
   * `pr_url` is set; otherwise we throw a transient-style error so the next
   * tick (after pr_open populates the column) can retry.
   *
   * Idempotency: a `GET /repos/{owner}/{repo}/pulls/{number}` probe via
   * `probePrMerged` runs first. If `merged === true` the drainer prunes the
   * action without invoking this executor.
   *
   * Errors:
   *   - Missing `githubToken` / `repoFullName` — config interlock should
   *     prevent this; throw fast if it slips through.
   *   - Missing `issue.pr_url` — pr_open hasn't run yet; throw transient so
   *     the next tick retries after pr_open populates pr_url.
   *   - 405 (not mergeable) / 409 (head changed) — surface as a permanent
   *     error so the drainer escalates to operators rather than spinning.
   *   - Other non-2xx — `classifyHttpError` for the standard retry policy.
   */
  async executePrMerge(
    issue: IssueRow,
    payload: { branch_name: string; merge_method: 'squash' },
  ): Promise<void> {
    if (!this.config.githubToken) {
      throw new Error('executePrMerge requires githubToken (GITHUB_TOKEN env)');
    }
    if (!this.config.repoFullName) {
      throw new Error('executePrMerge requires repoFullName (AUTOPILOT_REPO_FULL_NAME env)');
    }
    if (!issue.pr_url) {
      throw new TransientHttpError(
        'executePrMerge requires issue.pr_url (pr_open has not populated it yet)',
      );
    }

    const prNumber = parsePrNumberFromUrl(issue.pr_url);
    if (prNumber === null) {
      throw new Error(`executePrMerge could not parse PR number from url: ${issue.pr_url}`);
    }
    const [owner, repo] = this.config.repoFullName.split('/');
    const authHeader = `Bearer ${this.config.githubToken}`;
    const acceptHeader = 'application/vnd.github+json';

    const mergeResponse = await fetchWithTimeout(
      `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/merge`,
      {
        method: 'PUT',
        headers: {
          Authorization: authHeader,
          Accept: acceptHeader,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ merge_method: payload.merge_method }),
      },
      'GitHub PR merge',
    );

    if (!mergeResponse.ok) {
      const bodyText = (await mergeResponse.text()).slice(0, 1000);
      // 405 = not mergeable (branch protection, conflicts, blocked by review);
      // 409 = head SHA moved since the request was built. Both indicate the
      // merge cannot land without operator intervention; escalate via the
      // drainer's permanent-failure path rather than retrying forever.
      if (mergeResponse.status === 405 || mergeResponse.status === 409) {
        throw classifyHttpError(
          `GitHub PR merge rejected (${mergeResponse.status} ${mergeResponse.statusText}): ${bodyText}`,
          mergeResponse.status,
        );
      }
      throw classifyHttpError(
        `GitHub PR merge failed (${mergeResponse.status} ${mergeResponse.statusText}): ${bodyText}`,
        mergeResponse.status,
      );
    }

    emitCounter('pending.pr_merge.merged', runnerMeta(this.config));
  }

  /** Probe GitHub for whether a PR has already been merged. Returns `true`
   * when `merged === true` on the PR resource, `false` when the PR exists
   * but is unmerged, and `null` when credentials are missing or the URL
   * can't be parsed (the drainer falls through to the executor which
   * surfaces a clear error). */
  async probePrMerged(prUrl: string | null | undefined): Promise<boolean | null> {
    if (!this.config.githubToken || !this.config.repoFullName) return null;
    if (!prUrl) return false;
    const prNumber = parsePrNumberFromUrl(prUrl);
    if (prNumber === null) return null;
    const [owner, repo] = this.config.repoFullName.split('/');
    const probe = await fetchWithTimeout(
      `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}`,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${this.config.githubToken}`,
          Accept: 'application/vnd.github+json',
        },
      },
      'GitHub PR detail',
    );
    await assertOk(probe, 'GitHub PR detail');
    const data = (await probe.json()) as { merged?: unknown };
    return data.merged === true;
  }

  /** Probe Sentry for the current status of an issue. Used by the drainer
   * to skip a `sentry_status` action when the target status is already
   * applied (idempotency on Sentry's side). */
  async probeSentryStatus(issue: IssueRow): Promise<string | null> {
    const url = new URL(
      `/api/0/issues/${encodeURIComponent(issue.sentry_id)}/`,
      SENTRY_API_BASE_URL,
    );
    const response = await fetchWithTimeout(
      url.toString(),
      {
        method: 'GET',
        headers: { Authorization: `Bearer ${this.config.sentryAuthToken}` },
      },
      'Sentry issue detail',
    );
    await assertOk(response, 'Sentry issue detail');
    const data = (await response.json()) as { status?: unknown };
    return typeof data.status === 'string' ? data.status : null;
  }

  /** Probe Sentry annotations for an existing Linear link — exposed for the
   * drainer's `linear_create_issue` probe. */
  async probeLinearAnnotation(
    issue: IssueRow,
  ): Promise<{ issueIdentifier: string; url: string } | null> {
    return this.fetchLinearLinkFromSentry(issue);
  }
}

// === planActions pure function (Stage C) ====================================
//
// `planActions` is the single source of truth for "what side effects should
// happen for this outcome". It is intentionally pure: same inputs always
// produce the same `PendingAction[]`. The drainer (pending-drainer.ts) is
// responsible for actually firing them; the legacy inline `reportOutcome`
// path in this file remains for `pendingMode='disabled'` / `'mirror'` and
// is byte-identical to pre-Stage-C behavior except for the elimination of
// `commitPlanToRepo()`.
//
// Contract:
//   - Returns actions in plan-order; the drainer sorts by `ACTION_DRAIN_ORDER`
//     so cross-kind precedence (e.g. `pr_open` before `slack_outcome` so the
//     Slack body can include the PR URL — Q1 mitigation) is enforced
//     centrally.
//   - For `parse_failure` outcomes, MUST emit `slack_outcome` at minimum
//     (per Stage B audit — parse failure is terminal, so this is the only
//     visibility channel under `pendingMode='enforce'`).
//   - Idempotency keys are deterministic body hashes, so a re-render at
//     drain time naturally produces a fresh key (the at-least-once Slack
//     case Q1 documents; predecessor ordering prevents it in normal flow).
//   - `pr_open` is intentionally NEVER enqueued in Stage C (Stage E adds
//     `pushMode === 'pr'` handling). The executor is stubbed so accidental
//     enqueues fail fast.

interface PlanActionsInput {
  issue: IssueRow;
  outcome: SessionOutcome;
  verification: VerificationResult | null;
  config: AutopilotConfig;
  /** Linear identifier inferred at plan time (from Sentry annotations), if
   * the bugfixer's harvest probe already saw one. Stage C planners pass
   * `null` and let the drainer's probe re-fetch — but the field exists for
   * Stage E when the harvest path may pre-resolve. */
  existingLinearIdentifier?: string | null;
  /** ISO timestamp for `created_at` on actions. Defaults to now; tests
   * inject a fixed value for snapshot stability. */
  now?: string;
}

function hashShort(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex').slice(0, 16);
}

function readPlanFileText(issue: IssueRow, outcome: SessionOutcome, config: AutopilotConfig): string | null {
  try {
    const planPath = getPlanFile(issue, outcome, config);
    if (!fs.existsSync(planPath)) return null;
    return fs.readFileSync(planPath, 'utf8');
  } catch {
    return null;
  }
}

const PLAN_INLINE_MAX_BYTES = 50_000;
// Reserves room inside the byte budget for the truncation footer line.
const PLAN_TRUNCATION_FOOTER_RESERVE_BYTES = 200;

// Mirrors `BRANCH_RE` in `outcome-schema.ts` for the typed `auto_committed`
// path. `branch_name` on `plan_created` / `escalated` outcomes is currently
// accepted via the `.catchall(z.unknown())` extras escape hatch, so we
// validate it locally before ever rendering it into a copy-pasteable shell
// command in a Linear ticket. A malformed or prompt-injected branch_name
// (newlines, backticks, `; rm -rf`) would otherwise round-trip through the
// ticket as an executable instruction to a downstream operator.
const AUTOPILOT_BRANCH_RE = /^autopilot\/[A-Za-z0-9._-]+$/;

function isValidAutopilotBranchName(value: unknown): value is string {
  return typeof value === 'string' && AUTOPILOT_BRANCH_RE.test(value);
}

function getValidatedBranchName(
  issue: IssueRow,
  outcome: SessionOutcome,
  config: AutopilotConfig,
): string | null {
  const candidate = outcome.branch_name ?? issue.branch_name ?? null;
  if (candidate === null) return null;
  if (isValidAutopilotBranchName(candidate)) return candidate;
  logWarn(
    { sentryId: issue.sentry_id, candidate, ...runnerMeta(config) },
    'Linear handoff body: rejecting malformed branch_name; falling back to no-branch handoff section',
  );
  return null;
}

function truncateToUtf8Bytes(input: string, maxBytes: number): string {
  if (Buffer.byteLength(input, 'utf8') <= maxBytes) return input;
  // Binary search for the longest character-prefix that fits in maxBytes.
  // This avoids slicing mid-codepoint (which would emit a replacement char)
  // and avoids walking a 200KB-class plan one character at a time.
  let lo = 0;
  let hi = input.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    if (Buffer.byteLength(input.slice(0, mid), 'utf8') <= maxBytes) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return input.slice(0, lo);
}

function readPlanForLinear(
  issue: IssueRow,
  outcome: SessionOutcome,
  config: AutopilotConfig,
): { content: string; truncated: boolean; originalBytes: number } | null {
  let raw: string;
  try {
    const planPath = getPlanFile(issue, outcome, config);
    if (!fs.existsSync(planPath)) return null;
    raw = fs.readFileSync(planPath, 'utf8');
  } catch (error) {
    // Differentiate IO/perm errors from missing-file: missing-file is benign
    // (bugfixer simply didn't write a plan), but a read error after the
    // existence check passed indicates a real problem (perms, EIO, partial
    // mount) that the operator should see in the autopilot logs.
    logWarn(
      {
        sentryId: issue.sentry_id,
        planPath: getPlanFile(issue, outcome, config),
        error: error instanceof Error ? error.message : String(error),
        ...runnerMeta(config),
      },
      'Linear handoff body: failed to read plan.md from artifact dir; falling back to summary-only body',
    );
    return null;
  }
  const originalBytes = Buffer.byteLength(raw, 'utf8');
  if (originalBytes <= PLAN_INLINE_MAX_BYTES) {
    return { content: raw, truncated: false, originalBytes };
  }
  const sliced = truncateToUtf8Bytes(
    raw,
    PLAN_INLINE_MAX_BYTES - PLAN_TRUNCATION_FOOTER_RESERVE_BYTES,
  );
  const onBranchPlanPath = getOnBranchPlanPath(outcome, issue);
  const footer = `\n\n_…[truncated; full plan was ${originalBytes} bytes — see \`${onBranchPlanPath}\` on the autopilot branch]_`;
  return { content: sliced + footer, truncated: true, originalBytes };
}

function buildHandoffPickupSection(
  branchName: string | null,
  onBranchPlanPath: string,
): string {
  if (!branchName) {
    return '_The autopilot did not commit a (validated) branch for this issue. Start a fresh agent session from `dev` and use the inlined plan as context._';
  }
  // branchName has already passed `AUTOPILOT_BRANCH_RE` via
  // `getValidatedBranchName()`, so this is safe to render into a shell block.
  // onBranchPlanPath comes from outcome.plan_file (validated by planFileSchema —
  // relative path, no traversal, no absolute) so it is also safe to inline.
  return [
    'The autopilot committed its plan (and any in-progress fix) to a branch on origin. To continue from where it left off:',
    '',
    '```bash',
    'git fetch origin',
    `git checkout ${branchName}`,
    `# Plan file on this branch: \`${onBranchPlanPath}\`.`,
    '# Then start your agent session in this worktree.',
    '```',
  ].join('\n');
}

function buildHandoffInstructions(outcome: SessionOutcome): string {
  const debuggers = Array.isArray(outcome.debuggers_consulted) && outcome.debuggers_consulted.length > 0
    ? outcome.debuggers_consulted.join(', ')
    : null;
  const blockers = nonEmpty(outcome.blockers_to_auto_commit) ?? null;
  const risks = nonEmpty(outcome.risks) ?? null;

  const lines: string[] = [
    'The autopilot reached this point and stopped short of shipping a fix on its own — its diagnosis below is **evidence, not ground truth**. Do not rubber-stamp it.',
    '',
    'When you start your agent session:',
    '',
    '1. Read the inlined plan below carefully — proposed fix, risks, and verification plan.',
    '2. **Independently re-derive the failure mechanism** from the Sentry stacktrace and breadcrumbs without assuming the autopilot is correct. If you re-investigate, use a different model family for diversity' + (debuggers ? ` (autopilot consulted: ${debuggers}).` : '.'),
    '3. If your independent diagnosis confirms the autopilot\'s, implement the proposed fix, add tests, push.',
    '4. If your independent diagnosis diverges, state that clearly and reconcile against the autopilot\'s evidence — it may have seen something you missed. Do not silently override.',
  ];
  let nextNum = 5;
  if (blockers) {
    lines.push(`${nextNum}. Pay particular attention to what blocked the autopilot from auto-committing: ${blockers}`);
    nextNum += 1;
  }
  if (risks) {
    lines.push(`${nextNum}. The autopilot identified these risks — verify each before merging: ${risks}`);
    nextNum += 1;
  }
  return lines.join('\n');
}

/**
 * The 4-section enriched Linear body used for both `linear_create_issue`
 * descriptions and `linear_comment_existing` / adopted-link comment bodies.
 *
 * Sections:
 *   1. Autopilot summary (terse facts: outcome, confidence, branch, files-in-scope)
 *   2. How to pick this up (git checkout commands, or fallback prose if no branch)
 *   3. Instructions for the picking-up agent (evidence-not-ground-truth framing)
 *   4. Full plan (autopilot's diagnosis) — inlined plan.md, truncated at PLAN_INLINE_MAX_BYTES
 *
 * Designed so a fresh agent session reading the Linear ticket has enough context
 * to either confirm + ship the autopilot's plan, or independently re-investigate
 * with the autopilot's evidence as input. Replaces the previous ~850-char
 * description that pointed at a VM-local plan path no human could reach.
 */
function buildPlanFallbackSection(issue: IssueRow, outcome: SessionOutcome): string {
  // When plan.md is missing, unreadable, or wiped, the picking-up agent
  // would otherwise be left with effectively the old low-signal body.
  // Salvage every persisted prose field from `outcome.json` (durable in
  // state.db) so the ticket stays useful as a starting point.
  const sections: string[] = [
    '_(plan.md unavailable in the artifact directory — see the persisted-fields summary below for what the autopilot wrote into `outcome.json` before the artifact was removed.)_',
    '',
  ];
  const rootCause = nonEmpty(outcome.root_cause);
  const planSummary = nonEmpty(outcome.plan_summary);
  const diagnosis = nonEmpty(outcome.diagnosis);
  const reason = nonEmpty(outcome.reason);
  const blockers = nonEmpty(outcome.blockers_to_auto_commit);
  const risks = nonEmpty(outcome.risks);
  if (rootCause) {
    sections.push('### Root cause (persisted)', '', rootCause, '');
  }
  if (planSummary) {
    sections.push('### Plan summary (persisted)', '', planSummary, '');
  }
  if (diagnosis && diagnosis !== rootCause) {
    sections.push('### Diagnosis (persisted)', '', diagnosis, '');
  }
  if (reason) {
    sections.push('### Reason / what was attempted (persisted)', '', reason, '');
  }
  if (blockers) {
    sections.push('### Blockers to auto-commit (persisted)', '', blockers, '');
  }
  if (risks) {
    sections.push('### Risks (persisted)', '', risks, '');
  }
  if (sections.length === 2) {
    sections.push(
      `_(no persisted prose either — Sentry: ${issue.sentry_url}, outcome: \`${outcome.outcome}\`, confidence ${outcome.confidence ?? issue.confidence ?? 'unknown'}%)_`,
    );
  }
  return sections.join('\n');
}

function fingerprintFromInlineStackData(issue: IssueRow, outcome: SessionOutcome): string | null {
  return extractFingerprintFromDetail(issue) ?? extractFingerprintFromDetail(outcome);
}

function buildLinearTrailerLines(issue: IssueRow, outcome: SessionOutcome, fingerprintOverride?: string | null): string[] {
  const fingerprint = fingerprintOverride ?? fingerprintFromInlineStackData(issue, outcome);
  return [
    `sentry-issue-id: ${issue.sentry_id}`,
    ...(fingerprint ? [`${AUTOPILOT_FINGERPRINT_PREFIX} ${fingerprint}`] : []),
  ];
}

function buildLinearHandoffBody(
  issue: IssueRow,
  outcome: SessionOutcome,
  config: AutopilotConfig,
  fingerprint?: string | null,
): string {
  const branchName = getValidatedBranchName(issue, outcome, config);
  const filesChanged = (outcome.files_changed ?? []).map((f) => `- \`${f}\``).join('\n') || '_(none recorded)_';
  const planForLinear = readPlanForLinear(issue, outcome, config);
  const planSection = planForLinear
    ? planForLinear.content
    : buildPlanFallbackSection(issue, outcome);

  return [
    '## Autopilot summary',
    `- **Outcome:** \`${outcome.outcome}\``,
    `- **Confidence:** ${outcome.confidence ?? issue.confidence ?? 'unknown'}%`,
    `- **Sentry:** ${issue.sentry_url}`,
    `- **Branch:** ${branchName ? `\`${branchName}\`` : '_(not committed — see "How to pick this up" below)_'}`,
    `- **Files in scope (proposed):**`,
    filesChanged,
    '',
    '## How to pick this up',
    '',
    buildHandoffPickupSection(branchName, getOnBranchPlanPath(outcome, issue)),
    '',
    '## Instructions for the picking-up agent',
    '',
    buildHandoffInstructions(outcome),
    '',
    '---',
    '',
    '## Full plan (autopilot\'s diagnosis)',
    '',
    planSection,
    '',
    ...buildLinearTrailerLines(issue, outcome, fingerprint),
  ].join('\n');
}

function readDraftFileText(issue: IssueRow, config: AutopilotConfig): string | null {
  try {
    const draftPath = getDraftFile(issue, config);
    if (!fs.existsSync(draftPath)) return null;
    return fs.readFileSync(draftPath, 'utf8').trim();
  } catch {
    return null;
  }
}

function buildLinearDescriptionPure(
  issue: IssueRow,
  outcome: SessionOutcome,
  config: AutopilotConfig,
): string {
  return buildLinearHandoffBody(issue, outcome, config);
}

function buildLinearCommentBody(
  issue: IssueRow,
  outcome: SessionOutcome,
  config: AutopilotConfig,
  fingerprint?: string | null,
): string {
  // Adopted-link path: posted as a comment on a user-filed Linear issue, so
  // we deliberately do NOT clobber the user's original description. The
  // comment carries the same enriched handoff body so a picking-up agent
  // gets the same context whether the autopilot created the ticket or
  // adopted an existing one.
  const header = `**Sentry Autopilot update** — added by the autopilot to the user-filed issue ${issue.sentry_id}.`;
  return [header, '', buildLinearHandoffBody(issue, outcome, config, fingerprint)].join('\n');
}

function formatPrLines(issue: IssueRow, outcome: SessionOutcome): string[] {
  // Drain-time re-render: when the drainer has already executed `pr_open`
  // and persisted `pr_url`, the next slack_outcome render (the at-least-
  // once Slack re-fire — Q1) surfaces the PR URL. While the branch is
  // pushed but the PR not yet open (mid-drain), surface the branch name
  // instead so operators have a clickable reference.
  const lines: string[] = [];
  const prUrl = issue.pr_url ?? null;
  const branch = outcome.branch_name ?? issue.branch_name ?? null;
  if (prUrl) {
    lines.push(`*PR:* ${prUrl}`);
  } else if (branch) {
    lines.push(`*Branch:* \`${branch}\``);
  }
  return lines;
}

function buildSlackOutcomeText(
  issue: IssueRow,
  outcome: SessionOutcome,
  linearUrlHint: string,
  verification: VerificationResult | null,
): string {
  const sentryLink = `<${issue.sentry_url}|${issue.sentry_id}>`;
  const title = issue.title.length > 80 ? `${issue.title.slice(0, 77)}...` : issue.title;
  const confidence = outcome.confidence ?? issue.confidence;
  const verificationLine = formatVerificationLine(verification);
  const maybeVerification = verificationLine ? [verificationLine] : [];
  const prLines = formatPrLines(issue, outcome);

  if (outcome.outcome === 'auto_committed') {
    const commit = outcome.commit_hash ?? issue.commit_hash ?? 'unknown';
    return [
      `:white_check_mark: *Autopilot fixed a bug and merged it into dev*`,
      `*Issue:* ${sentryLink} — ${title}`,
      ...maybeVerification,
      ...prLines,
      `*Commit:* \`${commit}\` (confidence: ${confidence ?? 'unknown'}%)`,
      `Squash-merged via autopilot PR. No action needed — verify in next beta deploy.`,
    ].join('\n');
  }

  if (outcome.outcome === 'plan_created') {
    if (looksAlreadyFixed(outcome)) {
      return [
        `:white_check_mark: *Autopilot confirmed this bug is already fixed on dev*`,
        `*Issue:* ${sentryLink} — ${title}`,
        ...maybeVerification,
        `*Confidence:* ${confidence ?? 'unknown'}% · ${issue.occurrences ?? '?'} events, ${issue.users ?? '?'} users`,
        `*Details:* ${truncate(getRootCauseSummary(outcome), 200)}`,
        `Sentry issue resolved. No action needed — the fix will ship with the next stable release.`,
      ].join('\n');
    }
    if (looksNotABug(outcome)) {
      return [
        `:see_no_evil: *Autopilot triaged as not-a-bug*`,
        `*Issue:* ${sentryLink} — ${title}`,
        ...maybeVerification,
        `*Reason:* ${truncate(getRootCauseSummary(outcome), 200)}`,
        `Sentry issue ignored (will resurface if it escalates). No action needed unless you disagree.`,
      ].join('\n');
    }
    const pickupLines: string[] = [];
    if (linearUrlHint !== 'not created') {
      pickupLines.push(`→ *Linear:* <${linearUrlHint}|Pick up here>`);
    }
    return [
      `:memo: *Autopilot diagnosed a bug — needs someone to implement the fix*`,
      `*Issue:* ${sentryLink} — ${title}`,
      ...maybeVerification,
      `*Confidence:* ${confidence ?? 'unknown'}% · ${issue.occurrences ?? '?'} events, ${issue.users ?? '?'} users`,
      `*Root cause:* ${truncate(getRootCauseSummary(outcome), 200)}`,
      `*Action:* Review the diagnosis and implement the proposed fix.`,
      ...pickupLines,
    ].join('\n');
  }

  if (outcome.outcome === 'escalated') {
    const pickupLines: string[] = [];
    if (linearUrlHint !== 'not created') {
      pickupLines.push(`→ *Linear:* <${linearUrlHint}|Pick up here>`);
    }
    return [
      `:warning: *Autopilot couldn't resolve this one — human investigation needed*`,
      `*Issue:* ${sentryLink} — ${title}`,
      ...maybeVerification,
      `*Why:* ${truncate(getOutcomeReason(outcome), 200)}`,
      `*Action:* Open the Sentry issue, review the autopilot comment for what was tried, and investigate further.`,
      ...pickupLines,
    ].join('\n');
  }

  if (outcome.outcome === 'not_a_bug') {
    return [
      `:see_no_evil: *Autopilot triaged as noise/not-a-bug*`,
      `*Issue:* ${sentryLink} — ${title}`,
      `*Reason:* ${truncate(getOutcomeReason(outcome), 200)}`,
      `Sentry issue ignored (will resurface if it escalates). No action needed unless you disagree.`,
    ].join('\n');
  }

  if (outcome.outcome === 'failed' && outcome.failure_kind === 'parse_failure') {
    const artifactPath = getParseFailureArtifactPath(outcome);
    return [
      `:exclamation: *Autopilot outcome parse failure* — terminal, no retry`,
      `*Issue:* ${sentryLink} — ${title}`,
      `*Failure kind:* parse_failure (terminal)`,
      `*Reason:* ${truncate(getOutcomeReason(outcome), 200)}`,
      `*Artifact:* \`${artifactPath}\``,
      `*Action:* Inspect outcome.json + supervisor.log.`,
    ].join('\n');
  }

  return [
    `:x: *Autopilot failed after ${issue.dispatch_count} attempt${issue.dispatch_count === 1 ? '' : 's'}*`,
    `*Issue:* ${sentryLink} — ${title}`,
    `*Error:* ${truncate(getOutcomeReason(outcome), 200)}`,
    `*Action:* Check the Sentry issue and autopilot logs. This may need manual diagnosis, or the autopilot hit an infrastructure problem.`,
  ].join('\n');
}

function buildSentryCommentText(
  issue: IssueRow,
  outcome: SessionOutcome,
  linearUrlHint: string,
): string {
  const userReportedSuffix = issue.is_user_reported ? ' Draft response to user prepared.' : '';
  if (outcome.outcome === 'auto_committed') {
    return `Autopilot fix merged to dev (squash) via autopilot PR: \`${
      outcome.commit_hash ?? issue.commit_hash ?? 'unknown'
    }\`. Diagnosis: ${getRootCauseSummary(outcome)}.${userReportedSuffix}`;
  }
  if (outcome.outcome === 'plan_created') {
    return `Autopilot analysis complete. Confidence: ${
      outcome.confidence ?? issue.confidence ?? 'unknown'
    }%. Plan: ${getPlanSummary(outcome)}. Linear: ${linearUrlHint}.${userReportedSuffix}`;
  }
  if (outcome.outcome === 'escalated') {
    return `Autopilot investigated but couldn't resolve autonomously. Reason: ${getOutcomeReason(
      outcome,
    )}. Linear: ${linearUrlHint}.${userReportedSuffix}`;
  }
  if (outcome.outcome === 'not_a_bug') {
    return `Autopilot triaged this as not a code bug. Reason: ${getOutcomeReason(outcome)}.${userReportedSuffix}`;
  }
  return `Autopilot failed after ${issue.dispatch_count} attempts. Error: ${getOutcomeReason(
    outcome,
  )}.${userReportedSuffix}`;
}

function shouldUpdateSentryStatus(
  outcome: SessionOutcome,
): {
  status: 'resolved' | 'ignored';
  status_details?: Record<string, unknown>;
  substatus?: 'archived_until_escalating' | 'archived_forever';
} | null {
  if (outcome.outcome === 'auto_committed') return { status: 'resolved' };
  if (outcome.outcome === 'plan_created' && looksAlreadyFixed(outcome)) {
    return { status: 'resolved' };
  }
  if (
    outcome.outcome === 'not_a_bug' ||
    (outcome.outcome === 'plan_created' && looksNotABug(outcome))
  ) {
    return { status: 'ignored', status_details: {}, substatus: 'archived_until_escalating' };
  }
  return null;
}

/** Maximum PR body length per planning-doc Q7 / Appendix A. The Zod schema
 * caps at 65000; we truncate at 60000 to leave headroom for the trailer.
 * Real PR bodies almost never approach this — the truncation is a defense
 * against pathological diagnoses. */
const PR_BODY_MAX_CHARS = 60_000;
const PR_TITLE_MAX_CHARS = 256;

/** Build the PR title per Appendix A: `[Autopilot] <truncated 100-char outcome title> (<sentry_id>)`.
 * Total title is Zod-capped at 256 chars. */
function buildPrTitle(issue: IssueRow): string {
  const titleSlice = truncate(issue.title, 100);
  const candidate = `[Autopilot] ${titleSlice} (${issue.sentry_id})`;
  return candidate.length > PR_TITLE_MAX_CHARS
    ? `${candidate.slice(0, PR_TITLE_MAX_CHARS - 3)}...`
    : candidate;
}

/** Build the PR body per Appendix A. */
function buildPrBody(issue: IssueRow, outcome: SessionOutcome, verification: VerificationResult | null): string {
  const verificationStatus = verification?.status ?? 'skipped';
  const verificationSummary = verification
    ? verification.details
        .filter((d) => !d.passed)
        .map((d) => `${d.check}: ${d.message}`)
        .join('; ') || 'all checks passed'
    : 'verifier not run';
  const diagnosis = truncate(getRootCauseSummary(outcome), 2000);
  const planSummary = truncate(getPlanSummary(outcome), 2000);
  const branch = outcome.branch_name ?? issue.branch_name ?? `autopilot/sentry-${safePathSegment(issue.sentry_id)}`;
  const body = [
    '> Opened by the Sentry → CHIEF_BUGFIXER autopilot. This PR is set to auto-merge (squash) into `dev` once it reaches the front of the drain queue — local verification has already passed and the autopilot is high-confidence on the fix.',
    '',
    `**Sentry issue:** ${issue.sentry_url}`,
    `**Confidence:** ${outcome.confidence ?? issue.confidence ?? 'unknown'}%`,
    `**Verification:** ${verificationStatus} (${verificationSummary})`,
    '',
    '## Diagnosis',
    diagnosis,
    '',
    '## Plan summary',
    planSummary,
    '',
    '## Notes',
    `- Branch: \`${branch}\``,
    `- Bugfixer outcome: \`${outcome.outcome}\``,
    `- Generated ${new Date().toISOString()}`,
    '',
    '---',
    '_Autopilot disclaimer: this PR was authored by an AI agent. It may be wrong. Verify the diagnosis against the Sentry stack trace, run the affected tests, and treat the diff as a starting point, not a finished change._',
  ].join('\n');

  if (body.length <= PR_BODY_MAX_CHARS) return body;
  const onBranchPlanPath = getOnBranchPlanPath(outcome, issue);
  return `${body.slice(0, PR_BODY_MAX_CHARS - 80)}\n\n[truncated; see \`${onBranchPlanPath}\` on the autopilot branch for full]`;
}

/** Should `planActions` enqueue a `pr_open` action for this outcome?
 *
 * Required conditions (all must hold):
 *   - config.pushMode === 'pr'
 *   - outcome.outcome === 'auto_committed' (plan_created branches aren't
 *     ready to merge; escalated branches don't have a commit to PR)
 *   - verification.status === 'pass' (config interlock guarantees
 *     verifyMode='enforce'; a non-pass verification means the bugfixer's
 *     claim disagrees with the worktree — we should NOT open a PR)
 *   - outcome.branch_name is set AND matches the `autopilot/*` convention
 *     (the verifier's branch_pushed_to_origin check already confirms the
 *     branch is on origin in enforce mode; this is a belt-and-braces
 *     check)
 */
function shouldEnqueuePrOpen(
  outcome: SessionOutcome,
  verification: VerificationResult | null,
  config: AutopilotConfig,
): boolean {
  if (config.pushMode !== 'pr') return false;
  if (outcome.outcome !== 'auto_committed') return false;
  if (!verification || verification.status !== 'pass') return false;
  const branch = outcome.branch_name;
  if (!branch) return false;
  return /^autopilot\/[A-Za-z0-9._-]+$/.test(branch);
}

export function planActions(input: PlanActionsInput): PendingAction[] {
  const { issue, outcome, verification, config } = input;
  const now = input.now ?? new Date().toISOString();
  const existingLinearIdentifier = input.existingLinearIdentifier ?? null;
  const actions: PendingAction[] = [];

  // 1. Sentry status update (resolved / ignored) when warranted.
  const statusUpdate = shouldUpdateSentryStatus(outcome);
  if (statusUpdate) {
    actions.push({
      kind: 'sentry_status',
      payload: statusUpdate,
      idempotency_key: `sentry_status:${issue.sentry_id}:${statusUpdate.status}`,
      attempts: 0,
      last_error: null,
      created_at: now,
    });
  }

  // 2. Linear create vs comment-existing. parse_failure / auto_committed /
  // commit_detected / not_a_bug never create Linear issues. plan_created
  // with already-fixed / not-a-bug signals also skip.
  if (shouldCreateLinearIssue(outcome)) {
    if (existingLinearIdentifier) {
      const body = buildLinearCommentBody(issue, outcome, config);
      actions.push({
        kind: 'linear_comment_existing',
        payload: { identifier_hint: existingLinearIdentifier, body },
        idempotency_key: `linear_comment_existing:${issue.sentry_id}:${hashShort(body)}`,
        attempts: 0,
        last_error: null,
        created_at: now,
      });
    } else {
      actions.push({
        kind: 'linear_create_issue',
        payload: {
          title: `[Autopilot] ${issue.title}`,
          description: buildLinearDescriptionPure(issue, outcome, config),
          priority: getLinearPriority(issue),
        },
        idempotency_key: `linear_create_issue:${issue.sentry_id}`,
        attempts: 0,
        last_error: null,
        created_at: now,
      });
    }
  }

  // 3. Sentry comment — every outcome except parse_failure gets a comment.
  if (!isParseFailure(outcome)) {
    const linearUrlHint = issue.linear_issue_id ? issue.linear_issue_id : 'not created';
    const commentText = buildSentryCommentText(issue, outcome, linearUrlHint);
    actions.push({
      kind: 'sentry_comment',
      payload: { text: commentText },
      idempotency_key: `sentry_comment:${issue.sentry_id}:${hashShort(commentText)}`,
      attempts: 0,
      last_error: null,
      created_at: now,
    });
  }

  // 3b. pr_open — Stage E. Only for auto_committed outcomes with passing
  // verification under pushMode=pr. Enqueued AFTER sentry_comment and BEFORE
  // slack_outcome (ACTION_DRAIN_ORDER), so the Slack body's re-render at
  // drain time can include the PR URL — Q1 predecessor-ordering mitigation.
  if (shouldEnqueuePrOpen(outcome, verification, config)) {
    const branchName = outcome.branch_name as string;
    const prTitle = buildPrTitle(issue);
    const prBody = buildPrBody(issue, outcome, verification);
    actions.push({
      kind: 'pr_open',
      payload: {
        branch_name: branchName,
        base: 'dev',
        title: prTitle,
        body: prBody,
      },
      idempotency_key: `pr_open:${issue.sentry_id}:${branchName}`,
      attempts: 0,
      last_error: null,
      created_at: now,
    });

    // 3c. pr_merge — auto-merge the PR opened above. Same gate as pr_open
    // (verification.status=pass, auto_committed, valid autopilot/* branch);
    // enqueueing both in one planActions call keeps the lifecycle atomic
    // with the sentry_status update that opens the queue. The drainer's
    // ACTION_DRAIN_ORDER places pr_merge immediately after pr_open so the
    // same drain pass that creates the PR also lands it. The pr_merge
    // executor reads pr_url off the issue row written by executePrOpen,
    // so no plan-time URL is needed.
    actions.push({
      kind: 'pr_merge',
      payload: { branch_name: branchName, merge_method: 'squash' },
      idempotency_key: `pr_merge:${issue.sentry_id}:${branchName}`,
      attempts: 0,
      last_error: null,
      created_at: now,
    });
  }

  // 4. Slack outcome — ALWAYS emitted. parse_failure path MUST surface here
  // since it's the only visibility channel under pendingMode=enforce (Stage
  // B audit; parse failure is terminal so there's no retry-from-supervisor).
  const slackLinearHint = issue.linear_issue_id ?? 'not created';
  const slackText = buildSlackOutcomeText(issue, outcome, slackLinearHint, verification);
  actions.push({
    kind: 'slack_outcome',
    payload: { text: slackText },
    idempotency_key: `slack_outcome:${issue.sentry_id}:${hashShort(slackText)}`,
    attempts: 0,
    last_error: null,
    created_at: now,
  });

  // 5. User-reported notice + draft response — only when the issue was
  // flagged as user-reported in Sentry AND we actually shipped a fix to
  // `dev`. For every other outcome (plan_created, escalated, not_a_bug,
  // failed, parse_failure) the draft would either promise something we
  // haven't done or leak a half-investigation, so we skip both messages.
  // This must stay in sync with the equivalent gate in `reportOutcome`.
  if (issue.is_user_reported && outcome.outcome === 'auto_committed') {
    const sentryLink = `<${issue.sentry_url}|${issue.sentry_id}>`;
    const reporterLine = formatReporterContactLine(issue);
    const alertLines = [
      `:bust_in_silhouette: *User-reported bug — someone needs to respond to the reporter*`,
      `*Issue:* ${sentryLink} — ${truncate(issue.title, 80)}`,
      ...(reporterLine ? [reporterLine] : []),
      `*Action:* Review the draft response below and send it to the user via the appropriate channel (in-app reply, email, etc).`,
    ];
    const alertText = alertLines.join('\n');
    actions.push({
      kind: 'slack_user_alert',
      payload: { text: alertText },
      idempotency_key: `slack_user_alert:${issue.sentry_id}:${hashShort(alertText)}`,
      attempts: 0,
      last_error: null,
      created_at: now,
    });

    const draftText = readDraftFileText(issue, config);
    if (draftText) {
      const draftHeaderLines = [
        `:bust_in_silhouette: *Draft response for ${issue.sentry_id} reporter:*`,
        ...(reporterLine ? [reporterLine] : []),
      ];
      const draftSlack = `${draftHeaderLines.join('\n')}\n\n${draftText}\n\n_Review and send via appropriate channel (in-app, email, etc.)_`;
      actions.push({
        kind: 'slack_draft_response',
        payload: { text: draftSlack },
        idempotency_key: `slack_draft_response:${issue.sentry_id}:${hashShort(draftSlack)}`,
        attempts: 0,
        last_error: null,
        created_at: now,
      });
    }
  }

  return actions;
}

// Re-export for tests that want to call the plan-time helpers directly.
export const __testing__ = {
  buildSlackOutcomeText,
  buildSentryCommentText,
  buildLinearDescriptionPure,
  buildLinearCommentBody,
  shouldUpdateSentryStatus,
  shouldEnqueuePrOpen,
  buildPrTitle,
  buildPrBody,
  readPlanFileText,
  readDraftFileText,
  reconstructOutcomeFromRow,
};

/**
 * Reconstruct a `SessionOutcome`-shaped object from a persisted IssueRow so
 * the drainer can re-render Slack/Linear bodies at drain time (Q1
 * mitigation — see planning doc).
 *
 * The fields `reason` and `error` are not persisted per-outcome on the row;
 * `last_error` is the closest proxy and only ever surfaces in failure
 * branches of `buildSlackOutcomeText`. Drain-time re-render is targeted at
 * `auto_committed` / `plan_created` success paths where these fields are
 * unused, so the lossiness is benign.
 */
function reconstructOutcomeFromRow(issue: IssueRow): SessionOutcome {
  return {
    outcome: (issue.outcome ?? 'failed') as SessionOutcome['outcome'],
    sentry_id: issue.sentry_id,
    confidence: issue.confidence ?? undefined,
    commit_hash: issue.commit_hash ?? undefined,
    plan_file: issue.plan_file ?? undefined,
    pr_url: issue.pr_url ?? undefined,
    branch_name: issue.branch_name ?? undefined,
    reason: issue.last_error ?? undefined,
    root_cause: issue.root_cause,
    plan_summary: issue.plan_summary,
    diagnosis: issue.diagnosis,
    is_bug: issue.is_bug,
    failure_kind: issue.failure_kind,
    original_outcome: issue.original_outcome ?? null,
  };
}

/**
 * Build a fresh `slack_outcome` payload from the CURRENT issue row, so a
 * post-pr_open re-render includes the PR URL. Returns the new text and a
 * fresh idempotency key (body hash) so the drainer fires the new content
 * once. Idempotency-key change is deliberate: it's how at-least-once Slack
 * semantics surface the "URL added" delta (Q1 in the planning doc).
 *
 * Caller must already have refreshed the IssueRow (`db.getIssue`) after the
 * `pr_open` action has executed and persisted `pr_url`.
 */
export function rerenderSlackOutcomeWithCurrentRow(
  issue: IssueRow,
  verification: VerificationResult | null,
): { text: string; idempotency_key: string } {
  const outcome = reconstructOutcomeFromRow(issue);
  const linearUrlHint = issue.linear_issue_id ?? 'not created';
  const text = buildSlackOutcomeText(issue, outcome, linearUrlHint, verification);
  return {
    text,
    idempotency_key: `slack_outcome:${issue.sentry_id}:${hashShort(text)}`,
  };
}
