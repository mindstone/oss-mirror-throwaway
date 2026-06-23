import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { buildChildPath } from './childEnv.ts';
import type { AutopilotConfig } from './config.ts';
import { emitCounter, errorLog } from './metrics.ts';
import { parseOutcome, type FailureKind, type Outcome } from './outcome-schema.ts';
import type { PendingAction } from './pending-actions.ts';
import { planActions } from './reporter.ts';
import type { IssueRow, StateDB } from './state.ts';
import { summarizeVerification, verifyOutcome, type VerificationResult } from './verifier.ts';

export interface SessionOutcome {
  outcome: Outcome['outcome'] | 'commit_detected';
  sentry_id?: string;
  confidence?: number;
  commit_hash?: string;
  plan_file?: string;
  pr_url?: string;
  branch_name?: string;
  reason?: string;
  error?: string;
  exit_code?: number;
  root_cause?: string;
  plan_summary?: string;
  diagnosis?: string;
  files_changed?: string[];
  shadow_would_commit?: boolean;
  is_bug?: boolean;
  failure_kind?: FailureKind;
  original_outcome?: string | null;
}

export interface HarvestResult {
  sentryId: string;
  outcome: SessionOutcome;
  logFile: string;
  /**
   * Verification result from `verifier.verifyOutcome()`. Always present —
   * `status='skipped'` when verifyMode=disabled or when the outcome is not
   * verifiable (e.g. parse_failure, not_a_bug).
   */
  verification: VerificationResult;
}

export interface DispatchResult {
  decision: 'dispatched';
  sentryId: string;
  slot: number;
  tmuxSession: string;
  artifactDir: string;
}

export interface DeferredDispatchResult {
  decision: 'deferred';
  sentryId: string;
}

export interface DispatchAttemptOptions {
  fingerprintHash?: string | null;
  inFlightDedupWindowHours?: number;
}

const execFileAsync = promisify(execFile);
const SESSION_PREFIX = 'sentry-';
const LOCKFILE_HASH_NAME = '.lockfile-hash';
const QUARANTINE_SUFFIX = '.quarantined';
const DEFAULT_STUCK_SECONDS = 45 * 60;

function safePathSegment(value: string): string {
  const segment = value.replace(/[^A-Za-z0-9._-]/g, '_');
  if (segment && segment !== '.' && segment !== '..') {
    return segment;
  }

  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 16);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * Build the inline-`env` shell command that tmux runs when spawning a new
 * autopilot bugfixer session. Extracted so the env-pair construction can be
 * tested directly without standing up tmux.
 *
 * Why inline `env KEY=val` rather than relying on tmux's environment
 * inheritance: the tmux server can outlive individual invocations and carry
 * stale env across sessions, and older tmux versions lack the `-e` flag.
 * Inline `env` works everywhere.
 *
 * Why each variable is explicit rather than `env -i …` + a fixed allowlist:
 * the supervisor needs PATH, HOME, etc. from the parent env to find binaries.
 * Explicit overrides for the autopilot-managed keys keep their values
 * deterministic without scrubbing the rest.
 */
export function buildSpawnTmuxCommand(args: {
  config: AutopilotConfig;
  worktreePath: string;
  sentryId: string;
  promptFile: string;
  artifactDir: string;
  supervisorScript: string;
}): string {
  const { config, worktreePath, sentryId, promptFile, artifactDir, supervisorScript } = args;

  const envPairs: string[] = [
    `AUTOPILOT_CLI=${shellQuote(config.cli)}`,
    `AUTOPILOT_CURSOR_MODEL=${shellQuote(config.cursorModel)}`,
    `AUTOPILOT_CLAUDE_MODEL=${shellQuote(config.claudeModel)}`,
  ];
  if (config.cursorApiKey) {
    envPairs.push(`CURSOR_API_KEY=${shellQuote(config.cursorApiKey)}`);
  }
  if (config.anthropicApiKey) {
    envPairs.push(`ANTHROPIC_API_KEY=${shellQuote(config.anthropicApiKey)}`);
  }
  // SENTRY_AUTH_TOKEN powers the Sentry REST fallback the bugfixer uses when
  // the Sentry MCP is unreachable (CHIEF_BUGFIXER Phase 2 evidence retrieval).
  // The long-running tmux server on the autopilot VM was started before the
  // env was extended with this key, so its global env doesn't carry it; the
  // inline `env KEY=val` pairs above are the only reliable propagation path.
  // Reporter-only secrets (SLACK_WEBHOOK, LINEAR_API_KEY) are deliberately
  // unset by session-supervisor.sh; SENTRY_AUTH_TOKEN is intentionally kept,
  // scoped to read + issue-resolve only (see SENTRY_REST_FALLBACK.md).
  if (config.sentryAuthToken) {
    envPairs.push(`SENTRY_AUTH_TOKEN=${shellQuote(config.sentryAuthToken)}`);
  }

  return [
    'env',
    ...envPairs,
    'bash',
    shellQuote(supervisorScript),
    shellQuote(worktreePath),
    shellQuote(sentryId),
    shellQuote(promptFile),
    shellQuote(artifactDir),
    shellQuote(String(config.sessionTimeoutSeconds)),
  ].join(' ');
}

export function reclassifyOutcome(outcome: Outcome): SessionOutcome {
  if (outcome.outcome === 'plan_created' && outcome.is_bug === false) {
    return { ...outcome, outcome: 'not_a_bug' };
  }

  return outcome;
}

function parseTimestamp(timestamp: string | null): number | null {
  if (!timestamp) {
    return null;
  }

  const normalized = timestamp.includes('T') ? timestamp : `${timestamp.replace(' ', 'T')}Z`;
  const parsed = Date.parse(normalized);
  return Number.isNaN(parsed) ? null : parsed;
}

function writeQuarantineMarker(config: AutopilotConfig, slot: number, reason: string): void {
  const markerPath = getQuarantineMarkerPath(config, slot);
  fs.mkdirSync(path.dirname(markerPath), { recursive: true });
  fs.writeFileSync(markerPath, `${new Date().toISOString()}\n${reason}\n`);
}

function getQuarantineMarkerPath(config: AutopilotConfig, slot: number): string {
  return path.join(config.stateDir, 'worktrees', `slot-${slot}${QUARANTINE_SUFFIX}`);
}

function isSlotQuarantined(config: AutopilotConfig, slot: number): boolean {
  return fs.existsSync(getQuarantineMarkerPath(config, slot));
}

function getWorktreePath(config: AutopilotConfig, slot: number): string {
  return path.join(config.stateDir, 'worktrees', `slot-${slot}`);
}

function getArtifactDir(config: AutopilotConfig, sentryId: string): string {
  return path.join(config.stateDir, 'artifacts', safePathSegment(sentryId));
}

/**
 * Snapshots `outcome.plan_file` from the worktree into the artifact dir as
 * `plan.md`, before the worktree is released. CE2-native plans live at
 * `docs/plans/<slug>/PLAN.md` inside the worktree, but reporter handoff
 * (Linear/Sentry) runs after slot release, so the file must be copied to
 * a durable location while the worktree is still intact.
 *
 * Best-effort: silently no-ops on missing files or absolute paths. The
 * verifier's `plan_file_exists` check independently catches the case where
 * the bugfixer claimed a plan but didn't write one.
 *
 * Exported for testing; not part of the SessionManager class because it is
 * a pure file-system operation that doesn't need access to instance state.
 */
export function trySnapshotPlanFile(
  outcome: SessionOutcome,
  worktreePath: string,
  artifactDir: string,
): void {
  if (!worktreePath) return;
  const planFile = outcome.plan_file;
  if (!planFile || path.isAbsolute(planFile)) return;
  const sourcePath = path.join(worktreePath, planFile);
  if (!fs.existsSync(sourcePath)) return;
  try {
    fs.mkdirSync(artifactDir, { recursive: true });
    fs.copyFileSync(sourcePath, path.join(artifactDir, 'plan.md'));
    emitCounter('plan_snapshot.success', { plan_file: planFile });
  } catch (error) {
    emitCounter('plan_snapshot.failure', { plan_file: planFile });
    errorLog(
      'plan_snapshot_failed',
      {
        worktreePath,
        planFile,
        error: error instanceof Error ? error.message : String(error),
      },
      'Failed to snapshot plan_file from worktree to artifact dir',
    );
  }
}

function getTmuxSessionName(sentryId: string): string {
  return `${SESSION_PREFIX}${safePathSegment(sentryId)}`;
}

function getSupervisorScriptPath(): string {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  return path.join(scriptDir, 'session-supervisor.sh');
}

async function runCommand(
  command: string,
  args: readonly string[],
  cwd?: string,
  extraEnv: Record<string, string> = {},
): Promise<string> {
  const { stdout } = await execFileAsync(command, [...args], {
    cwd,
    maxBuffer: 10 * 1024 * 1024,
    env: {
      ...process.env,
      PATH: buildChildPath(process.env.PATH),
      ...extraEnv,
    },
  });
  return stdout;
}

async function runGit(args: readonly string[], cwd: string): Promise<string> {
  return runCommand('git', args, cwd);
}

async function runGitBestEffort(args: readonly string[], cwd: string): Promise<string> {
  try {
    return await runGit(args, cwd);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function computeFileHash(filePath: string): string {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

function shouldRunNpmCi(worktreePath: string): boolean {
  const lockfilePath = path.join(worktreePath, 'package-lock.json');
  const hashPath = path.join(worktreePath, LOCKFILE_HASH_NAME);
  const nodeModulesPath = path.join(worktreePath, 'node_modules');
  const currentHash = computeFileHash(lockfilePath);

  if (!fs.existsSync(nodeModulesPath)) {
    return true;
  }

  try {
    return fs.readFileSync(hashPath, 'utf8').trim() !== currentHash;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return true;
    }
    throw error;
  }
}

function recordLockfileHash(worktreePath: string): void {
  const lockfilePath = path.join(worktreePath, 'package-lock.json');
  const hashPath = path.join(worktreePath, LOCKFILE_HASH_NAME);
  fs.writeFileSync(hashPath, `${computeFileHash(lockfilePath)}\n`);
}

function getOutcomeError(outcome: SessionOutcome): string {
  return outcome.error ?? outcome.reason ?? `Session ended with outcome: ${outcome.outcome}`;
}

function shouldMarkFailed(outcome: SessionOutcome): boolean {
  return outcome.outcome === 'failed';
}

export function getKillSwitchState(config: AutopilotConfig): 'pause' | 'stop' | null {
  if (fs.existsSync(path.join(config.stateDir, 'STOP'))) {
    return 'stop';
  }

  if (fs.existsSync(path.join(config.stateDir, 'PAUSE'))) {
    return 'pause';
  }

  return null;
}

function logWarn(message: string, data: Record<string, unknown> = {}): void {
  console.warn(JSON.stringify({ level: 'warn', component: 'sentry-autopilot-session-manager', message, ...data }));
}

function logInfo(message: string, data: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ level: 'info', component: 'sentry-autopilot-session-manager', message, ...data }));
}

function isSlotRaceError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('expected one row') || message.includes('expected one row to change');
}

export class SessionManager {
  constructor(
    private readonly config: AutopilotConfig,
    private readonly db: StateDB,
  ) {}

  async dispatchIssue(
    issue: IssueRow,
    promptFile: string,
    options: DispatchAttemptOptions = {},
  ): Promise<DispatchResult | DeferredDispatchResult | null> {
    const killSwitch = getKillSwitchState(this.config);
    if (killSwitch) {
      throw new Error(`Sentry Autopilot dispatch is ${killSwitch}ed by kill switch`);
    }

    const slot = this.acquireSlot(issue.sentry_id, options);
    if (slot === 'deferred') {
      return { decision: 'deferred', sentryId: issue.sentry_id };
    }
    if (slot === null) {
      return null;
    }

    const sentryId = issue.sentry_id;
    const artifactDir = getArtifactDir(this.config, sentryId);
    fs.mkdirSync(artifactDir, { recursive: true });

    try {
      await this.freshenWorktree(slot);
      await this.spawnTmuxSession(sentryId, promptFile, artifactDir, slot);
      return {
        decision: 'dispatched',
        sentryId,
        slot,
        tmuxSession: getTmuxSessionName(sentryId),
        artifactDir,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const cleanupError = await this.tryReleaseSlot(slot, artifactDir, message);
      this.db.markFailed(
        sentryId,
        cleanupError
          ? `Failed to dispatch session: ${message}; slot cleanup also failed: ${cleanupError.message}`
          : `Failed to dispatch session: ${message}`,
      );
      throw cleanupError ?? error;
    }
  }

  async monitorSessions(): Promise<HarvestResult[]> {
    const results: HarvestResult[] = [];
    let loggedStopDrain = false;
    for (const issue of this.db.getActiveIssues()) {
      if (getKillSwitchState(this.config) === 'stop' && !loggedStopDrain) {
        logWarn('STOP kill switch detected during monitoring; active sessions will drain, not abort');
        loggedStopDrain = true;
      }

      try {
        const harvested = await this.monitorSession(issue);
        if (harvested) {
          results.push(harvested);
        }
      } catch (error) {
        logWarn('Failed to monitor session; continuing with remaining sessions', {
          sentryId: issue.sentry_id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return results;
  }

  private acquireSlot(sentryId: string, options: DispatchAttemptOptions): number | 'deferred' | null {
    for (let attempt = 0; attempt < this.config.maxConcurrent; attempt += 1) {
      const activeSlots = new Set(
        this.db
          .getActiveIssues()
          .map((issue) => issue.worktree_slot)
          .filter((slot): slot is number => slot !== null),
      );

      for (let slot = 0; slot < this.config.maxConcurrent; slot += 1) {
        if (activeSlots.has(slot) || isSlotQuarantined(this.config, slot)) {
          continue;
        }

        try {
          const result = this.db.markDispatched(
            sentryId,
            slot,
            getTmuxSessionName(sentryId),
            {
              fingerprintHash: options.fingerprintHash ?? null,
              inFlightWindowHours: options.inFlightDedupWindowHours ?? 6,
            },
          );
          if (result === 'deferred') {
            return 'deferred';
          }
          return slot;
        } catch (error) {
          if (!isSlotRaceError(error)) {
            throw error;
          }
        }
      }
    }

    return null;
  }

  private async freshenWorktree(slot: number): Promise<void> {
    const worktreePath = getWorktreePath(this.config, slot);
    await runGit(['reset', '--hard'], worktreePath);
    await runGit(['clean', '-fdx', '-e', 'node_modules/', '-e', LOCKFILE_HASH_NAME], worktreePath);
    await runGit(['fetch', 'origin'], worktreePath);
    await runGit(['checkout', '--detach', 'origin/dev'], worktreePath);

    // Submodules track pinned versions in dev. Without these the worktree
    // can carry a stale rebel-system / super-mcp / coding-agent-instructions
    // checkout from a previous tick, so the bug-fixer reasons against
    // out-of-date workflow instructions and skill files.
    await runGit(['submodule', 'sync', '--recursive'], worktreePath);
    await runGit(['submodule', 'update', '--init', '--recursive'], worktreePath);

    if (shouldRunNpmCi(worktreePath)) {
      // HUSKY=0 prevents husky's `prepare` script from re-installing the
      // superproject's hooks and clobbering the per-worktree core.hooksPath
      // that points at the autopilot pre-push hook. Without this, npm ci
      // would silently disable the main/dev push guard on every freshen.
      await runCommand('npm', ['ci'], worktreePath, { HUSKY: '0' });
      recordLockfileHash(worktreePath);
    }

    // Re-apply per-worktree core.hooksPath as defense-in-depth. Even with
    // HUSKY=0 above, any other tool (a stray postinstall, a future package
    // bump) could write to .git config and break the autopilot hook chain.
    // setup-worktrees.sh installs the same value initially; re-applying it
    // here is cheap and idempotent.
    const hooksPath = path.join(this.config.stateDir, 'hooks');
    await runGit(['config', '--worktree', 'core.hooksPath', hooksPath], worktreePath);
  }

  private async spawnTmuxSession(
    sentryId: string,
    promptFile: string,
    artifactDir: string,
    slot: number,
  ): Promise<void> {
    const worktreePath = getWorktreePath(this.config, slot);
    const supervisorScript = getSupervisorScriptPath();

    const command = buildSpawnTmuxCommand({
      config: this.config,
      worktreePath,
      sentryId,
      promptFile,
      artifactDir,
      supervisorScript,
    });

    logInfo('Spawning autopilot session', {
      sentryId,
      slot,
      cli: this.config.cli,
      cursorModel: this.config.cli === 'cursor' ? this.config.cursorModel : undefined,
      claudeModel: this.config.cli === 'claude' ? this.config.claudeModel : undefined,
    });

    await runCommand('tmux', ['new-session', '-d', '-s', getTmuxSessionName(sentryId), command]);
  }

  private async monitorSession(issue: IssueRow): Promise<HarvestResult | null> {
    if (issue.worktree_slot === null) {
      return null;
    }

    const artifactDir = getArtifactDir(this.config, issue.sentry_id);
    const doneFile = path.join(artifactDir, '.done');
    if (fs.existsSync(doneFile)) {
      return this.harvestOutcome(issue, artifactDir);
    }

    const ageMs = Date.now() - (parseTimestamp(issue.dispatched_at) ?? Date.now());
    const stuckMs = (this.config.sessionTimeoutSeconds || DEFAULT_STUCK_SECONDS) * 1000;
    const tmuxAlive = await this.isTmuxSessionAlive(issue.tmux_session ?? getTmuxSessionName(issue.sentry_id));

    if (ageMs > stuckMs && !fs.existsSync(doneFile)) {
      await this.failAndRelease(issue, `Session exceeded ${Math.round(stuckMs / 1000)}s without .done sentinel`);
      return null;
    }

    if (!tmuxAlive && ageMs > 60_000) {
      await this.failAndRelease(issue, 'Session supervisor is no longer alive and no .done sentinel was written');
    }

    return null;
  }

  private async harvestOutcome(issue: IssueRow, artifactDir: string): Promise<HarvestResult> {
    const outcomePath = path.join(artifactDir, 'outcome.json');
    const logFile = path.join(artifactDir, 'supervisor.log');
    let outcome: SessionOutcome;
    let originalOutcome: Outcome['outcome'] | undefined;

    try {
      const rawOutcome = JSON.parse(fs.readFileSync(outcomePath, 'utf8')) as unknown;
      const parsedOutcome = parseOutcome(rawOutcome, this.config);
      originalOutcome = parsedOutcome.outcome;
      outcome = reclassifyOutcome(parsedOutcome);
      emitCounter('parseOutcome.success', { outcome: parsedOutcome.outcome });
      if (parsedOutcome.outcome !== 'failed' && parsedOutcome.is_bug === undefined) {
        emitCounter('parseOutcome.is_bug_missing', { outcome: parsedOutcome.outcome });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      let rawText = '<unreadable>';
      try {
        rawText = fs.readFileSync(outcomePath, 'utf8');
      } catch {
        rawText = '<unreadable>';
      }
      const truncatedText = rawText.length > 8000 ? rawText.slice(0, 8000) : rawText;
      const originalOutcomeJson = JSON.stringify({
        truncated_text: truncatedText,
        artifact_path: outcomePath,
      });
      const cleanupError = await this.tryReleaseSlot(issue.worktree_slot, artifactDir);
      const combinedError = cleanupError
        ? `Failed to harvest outcome: ${message}; slot cleanup also failed: ${cleanupError.message}`
        : `Failed to harvest outcome: ${message}`;
      const syntheticOutcome: SessionOutcome = {
        outcome: 'failed',
        failure_kind: 'parse_failure',
        error: combinedError,
        original_outcome: originalOutcomeJson,
      };
      const parseFailurePending = this.planPendingActions(issue, syntheticOutcome, {
        status: 'skipped',
        details: [],
        metrics: {},
      });
      this.db.markParseFailure(issue.sentry_id, combinedError, originalOutcomeJson, parseFailurePending);
      emitCounter('parseOutcome.failure', {
        failure_kind: 'parse_failure',
        sentry_id: issue.sentry_id,
      });
      errorLog(
        'schema_fail',
        { sentryId: issue.sentry_id, artifactPath: outcomePath, error: combinedError },
        'Failed to harvest outcome from outcome.json',
      );
      return {
        sentryId: issue.sentry_id,
        outcome: syntheticOutcome,
        logFile,
        verification: { status: 'skipped', details: [], metrics: {} },
      };
    }

    // Verifier runs while the worktree is still intact (BEFORE tryReleaseSlot).
    // In `disabled` mode this returns `{ status: 'skipped' }` immediately.
    const verification = verifyOutcome(issue, outcome, {
      worktreePath: issue.worktree_slot !== null
        ? getWorktreePath(this.config, issue.worktree_slot)
        : '',
      mode: this.config.verifyMode,
      pushMode: this.config.pushMode,
      repoRoot: this.config.repoRoot,
    });

    if (
      verification.status !== 'skipped' &&
      verification.status !== 'pass'
    ) {
      errorLog(
        'verification_mismatch',
        {
          sentryId: issue.sentry_id,
          status: verification.status,
          summary: summarizeVerification(verification),
          details: verification.details,
        },
        `Verifier reported ${verification.status}`,
      );
    }

    // Snapshot plan_file from the worktree to artifact dir before slot release.
    // CE2-native plan paths (docs/plans/<slug>/PLAN.md) live only in the worktree;
    // reporter handoff (Linear/Sentry) runs after cleanup and reads from artifact dir.
    if (issue.worktree_slot !== null) {
      trySnapshotPlanFile(
        outcome,
        getWorktreePath(this.config, issue.worktree_slot),
        artifactDir,
      );
    }

    const cleanupError = await this.tryReleaseSlot(issue.worktree_slot, artifactDir);
    if (cleanupError) {
      this.db.markFailed(issue.sentry_id, `Slot cleanup failed after outcome ${outcome.outcome}: ${cleanupError.message}`);
      throw cleanupError;
    }

    if (verification.status === 'verification_error') {
      // Transient — counts toward retries via markFailed. Stage B test
      // `verifier.test.ts` simulates a missing git binary to exercise this.
      this.db.markFailed(
        issue.sentry_id,
        `Verification error: ${summarizeVerification(verification)}`,
      );
    } else if (
      verification.status === 'hard_mismatch' &&
      this.config.verifyMode === 'enforce'
    ) {
      // Terminal — no retry. Stage E will use this to refuse PR creation.
      // Plan actions for the mismatch (Slack alert minimum) so operators see
      // the failure even under pendingMode=enforce.
      const verificationPending = this.planPendingActions(issue, outcome, verification);
      this.db.markVerificationFailure(
        issue.sentry_id,
        {
          details: verification,
          summary: `Verification hard_mismatch: ${summarizeVerification(verification)}`,
        },
        verificationPending,
      );
    } else if (shouldMarkFailed(outcome)) {
      const failurePending = this.planPendingActions(issue, outcome, verification);
      this.db.markFailed(issue.sentry_id, getOutcomeError(outcome), failurePending);
    } else {
      const completedPending = this.planPendingActions(issue, outcome, verification);
      this.db.markCompleted(
        issue.sentry_id,
        outcome.outcome,
        outcome.confidence,
        outcome.outcome === 'auto_committed' ? outcome.commit_hash : undefined,
        outcome.outcome === 'plan_created' ? outcome.plan_file : undefined,
        {
          original_outcome: originalOutcome,
          root_cause: outcome.root_cause,
          plan_summary: outcome.plan_summary,
          diagnosis: outcome.diagnosis,
          is_bug: outcome.is_bug,
          failure_kind: outcome.failure_kind,
        },
        completedPending,
      );

      // In log_only mode the outcome is unchanged but we still record the
      // verification status so the historical baseline is collectible.
      if (this.config.verifyMode === 'log_only' && verification.status !== 'skipped') {
        this.db.recordVerificationResult(issue.sentry_id, verification.status, verification);
      } else if (this.config.verifyMode === 'enforce' && verification.status !== 'skipped') {
        // Soft mismatches and passes get recorded too in enforce mode.
        this.db.recordVerificationResult(issue.sentry_id, verification.status, verification);
      }
    }

    return {
      sentryId: issue.sentry_id,
      outcome,
      logFile,
      verification,
    };
  }

  /**
   * Compute the pending-action queue for a terminal-state outcome. Gated by
   * `pendingMode`:
   *   - `'disabled'` → returns `[]` (legacy inline reporter handles side
   *     effects).
   *   - `'mirror'` → returns the planActions() output; legacy inline
   *     reporter still fires. The dispatcher's reconcile pass then prunes
   *     mirrored actions whose probes report "already done" (Stage C
   *     observational mode).
   *   - `'enforce'` → returns planActions() output; legacy inline reporter
   *     skipped — the drainer is the sole side-effect channel.
   *
   * Counters: `pending.enqueued.<kind>` is emitted for every action that
   * gets written into the row.
   */
  private planPendingActions(
    issue: IssueRow,
    outcome: SessionOutcome,
    verification: VerificationResult,
  ): PendingAction[] {
    if (this.config.pendingMode === 'disabled') return [];
    const actions = planActions({
      issue,
      outcome,
      verification,
      config: this.config,
    });
    for (const action of actions) {
      emitCounter('pending.enqueued', { kind: action.kind });
    }
    return actions;
  }

  private async failAndRelease(issue: IssueRow, reason: string): Promise<void> {
    const cleanupError = await this.tryReleaseSlot(issue.worktree_slot, getArtifactDir(this.config, issue.sentry_id));
    this.db.markFailed(
      issue.sentry_id,
      cleanupError ? `${reason}; slot cleanup also failed: ${cleanupError.message}` : reason,
    );
    if (cleanupError) {
      throw cleanupError;
    }
  }

  private async tryReleaseSlot(slot: number | null, artifactDir: string, context?: string): Promise<Error | null> {
    try {
      if (slot !== null) {
        await this.forceCleanOrQuarantine(slot, artifactDir, context);
      }
      return null;
    } catch (error) {
      return error instanceof Error ? error : new Error(String(error));
    }
  }

  private async forceCleanOrQuarantine(slot: number, artifactDir: string, context?: string): Promise<void> {
    const worktreePath = getWorktreePath(this.config, slot);
    const status = await runGit(['status', '--porcelain'], worktreePath);

    if (status.trim()) {
      fs.mkdirSync(artifactDir, { recursive: true });
      const diffLog = [
        `Context: ${context ?? 'release'}`,
        '',
        '## git status --porcelain',
        status,
        '',
        '## git diff --binary',
        await runGitBestEffort(['diff', '--binary'], worktreePath),
        '',
        '## git diff --cached --binary',
        await runGitBestEffort(['diff', '--cached', '--binary'], worktreePath),
      ].join('\n');
      fs.writeFileSync(path.join(artifactDir, 'dirty-worktree.diff'), diffLog);
    }

    try {
      await runGit(['checkout', '--detach', 'origin/dev'], worktreePath);
      await runGit(['clean', '-fdx', '-e', LOCKFILE_HASH_NAME, '-e', 'node_modules/'], worktreePath);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      writeQuarantineMarker(this.config, slot, message);
      throw new Error(`Slot ${slot} quarantined after force-clean failure: ${message}`);
    }
  }

  private async isTmuxSessionAlive(sessionName: string): Promise<boolean> {
    try {
      await runCommand('tmux', ['has-session', '-t', sessionName]);
      return true;
    } catch {
      return false;
    }
  }
}
