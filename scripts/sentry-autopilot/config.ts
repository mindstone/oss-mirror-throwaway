import { homedir } from 'node:os';
import path from 'node:path';

export type AutopilotPhase = 'shadow' | 'guarded' | 'full';
export type AutopilotVerifyMode = 'disabled' | 'log_only' | 'enforce';
export type AutopilotPushMode = 'disabled' | 'branch_only' | 'pr';
export type AutopilotPendingMode = 'disabled' | 'mirror' | 'enforce';
export type AutopilotCli = 'droid' | 'cursor' | 'claude';

export interface AutopilotConfig {
  sentryAuthToken: string;
  sentryOrg: string;
  sentryProject: string;
  cli: AutopilotCli;
  cursorApiKey?: string;
  cursorModel: string;
  /**
   * Anthropic API key used by the `claude` runner (and indirectly by droid,
   * which already reads it from `~/.config/droid/env`). Required when
   * `cli === 'claude'`. The cron-launched supervisor only sources
   * `~/autopilot.env`, so the key must be present there for claude mode
   * even though it's also written into `~/.config/droid/env` for
   * interactive use.
   */
  anthropicApiKey?: string;
  /**
   * Model id passed to `claude --model`. Defaults to
   * `AUTOPILOT_CLAUDE_DEFAULT_MODEL` (`claude-opus-4-8`) and can be
   * overridden via `AUTOPILOT_CLAUDE_MODEL`. Only consulted when
   * `cli === 'claude'`.
   */
  claudeModel: string;
  linearApiKey?: string;
  slackWebhook?: string;
  /**
   * GitHub PAT used by the reporter's `executePrOpen` to call the REST API.
   * Required when `pushMode === 'pr'`. Required scopes (fine-grained PAT):
   * `pull_requests:write` + `contents:read` for the autopilot repo.
   */
  githubToken?: string;
  /**
   * Full GitHub `owner/repo` name (e.g. `mindstone/rebel-app`). Required
   * when `pushMode === 'pr'`. The PR creator splits this into owner + repo
   * to build the `POST /repos/{owner}/{repo}/pulls` URL.
   */
  repoFullName?: string;
  phase: AutopilotPhase;
  verifyMode: AutopilotVerifyMode;
  pushMode: AutopilotPushMode;
  pendingMode: AutopilotPendingMode;
  stateDir: string;
  maxConcurrent: number;
  maxHourly: number;
  maxDaily: number;
  maxRetries: number;
  sessionTimeoutSeconds: number;
  bootstrapLookbackHours: number;
  repoRoot: string;
  /** Enables the release-aware pre-dispatch gate. Defaults to false. */
  releaseGateEnabled?: boolean;
  /**
   * Number of previous minor release lines that the release-aware gate will
   * still dispatch. Defaults to 0 (same-or-newer minor only).
   */
  releaseLagToleranceMinor?: number;
  /** Enables Linear-existing dedup pre-dispatch gate. Defaults to false. */
  linearDedupEnabled?: boolean;
  /** Linear state names that cause the Linear dedup gate to skip. */
  linearDedupStatuses?: string[];
  /** Enables in-flight fingerprint dedup pre-dispatch gate. Defaults to false. */
  inFlightDedupEnabled?: boolean;
  /**
   * Lookback window (hours) for active same-fingerprint sessions used by the
   * in-flight dedup gate and dispatch-time transactional guard.
   */
  inFlightDedupWindowHours?: number;
  /**
   * When set, the dispatcher restricts a single tick to ONE specific Sentry
   * issue: it skips the Sentry poll entirely and refuses to dispatch any
   * pending row whose `sentry_id` doesn't match. Intended for controlled
   * Layer 4 / Layer 5 end-to-end tests where the operator pre-seeds
   * `state.db` with the chosen issue and wants deterministic targeting.
   *
   * Failure mode: if the env var is set but no matching pending row exists
   * in `state.db`, the dispatcher logs a structured error and throws —
   * never silently falls back to "next available" or no-op.
   *
   * Does NOT bypass rate limits or concurrency caps (those remain
   * orthogonal safety nets).
   */
  targetSentryId?: string;
}

const DEFAULT_SENTRY_ORG = 'mindstone';
const DEFAULT_SENTRY_PROJECT = 'rebel';
const DEFAULT_STATE_DIR = '~/sentry-autopilot';
const DEFAULT_REPO_ROOT = '~/src/rebel-app';
export const AUTOPILOT_CURSOR_DEFAULT_MODEL = 'composer-2.5';
export const AUTOPILOT_CLAUDE_DEFAULT_MODEL = 'claude-opus-4-8';

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optionalEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function parsePositiveIntegerEnv(name: string, defaultValue: number): number {
  const rawValue = process.env[name]?.trim();
  if (!rawValue) {
    return defaultValue;
  }

  const parsed = Number.parseInt(rawValue, 10);
  if (!Number.isInteger(parsed) || parsed <= 0 || String(parsed) !== rawValue) {
    throw new Error(
      `Invalid environment variable ${name}: expected a positive integer, received "${rawValue}"`,
    );
  }

  return parsed;
}

function parseNonNegativeIntegerEnv(name: string, defaultValue: number): number {
  const rawValue = process.env[name]?.trim();
  if (!rawValue) {
    return defaultValue;
  }

  const parsed = Number.parseInt(rawValue, 10);
  if (!Number.isInteger(parsed) || parsed < 0 || String(parsed) !== rawValue) {
    throw new Error(
      `Invalid environment variable ${name}: expected a non-negative integer, received "${rawValue}"`,
    );
  }

  return parsed;
}

function parseBooleanEnv(name: string, defaultValue: boolean): boolean {
  const rawValue = process.env[name]?.trim().toLowerCase();
  if (!rawValue) {
    return defaultValue;
  }

  if (rawValue === 'true') {
    return true;
  }
  if (rawValue === 'false') {
    return false;
  }

  throw new Error(
    `Invalid environment variable ${name}: expected "true" or "false", received "${process.env[name]}"`,
  );
}

function parseCommaSeparatedEnv(name: string, defaultValue: readonly string[]): string[] {
  const rawValue = process.env[name]?.trim();
  if (!rawValue) {
    return [...defaultValue];
  }

  const values = rawValue
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  if (values.length === 0) {
    throw new Error(
      `Invalid environment variable ${name}: expected at least one comma-separated value`,
    );
  }
  return values;
}

function parsePhase(rawValue: string | undefined): AutopilotPhase {
  const phase = rawValue?.trim() || 'shadow';
  if (phase === 'shadow' || phase === 'guarded' || phase === 'full') {
    return phase;
  }

  throw new Error(
    `Invalid environment variable AUTOPILOT_PHASE: expected "shadow", "guarded", or "full", received "${phase}"`,
  );
}

function parseVerifyMode(rawValue: string | undefined): AutopilotVerifyMode {
  const mode = rawValue?.trim() || 'disabled';
  if (mode === 'disabled' || mode === 'log_only' || mode === 'enforce') {
    return mode;
  }

  throw new Error(
    `Invalid environment variable AUTOPILOT_VERIFY_MODE: expected "disabled", "log_only", or "enforce", received "${mode}"`,
  );
}

function parsePushMode(rawValue: string | undefined): AutopilotPushMode {
  const mode = rawValue?.trim() || 'disabled';
  if (mode === 'disabled' || mode === 'branch_only' || mode === 'pr') {
    return mode;
  }

  throw new Error(
    `Invalid environment variable AUTOPILOT_PUSH_MODE: expected "disabled", "branch_only", or "pr", received "${mode}"`,
  );
}

function parsePendingMode(rawValue: string | undefined): AutopilotPendingMode {
  const mode = rawValue?.trim() || 'disabled';
  if (mode === 'disabled' || mode === 'mirror' || mode === 'enforce') {
    return mode;
  }

  throw new Error(
    `Invalid environment variable AUTOPILOT_PENDING_MODE: expected "disabled", "mirror", or "enforce", received "${mode}"`,
  );
}

function parseCli(rawValue: string | undefined): AutopilotCli {
  const cli = rawValue?.trim() || 'droid';
  if (cli === 'droid' || cli === 'cursor' || cli === 'claude') {
    return cli;
  }

  throw new Error(
    `Invalid environment variable AUTOPILOT_CLI: expected "droid", "cursor", or "claude", received "${cli}"`,
  );
}

function expandHome(inputPath: string): string {
  if (inputPath === '~') {
    return homedir();
  }

  if (inputPath.startsWith('~/')) {
    return path.join(homedir(), inputPath.slice(2));
  }

  return inputPath;
}

/**
 * Loads Sentry Autopilot configuration from environment variables.
 *
 * `SENTRY_AUTH_TOKEN` is required for Stage 1 polling. Reporter-only secrets
 * (`LINEAR_API_KEY`, `SLACK_WEBHOOK`) are surfaced when present and should be
 * validated by the Stage 3 reporter before it uses those integrations.
 */
export function loadConfig(): AutopilotConfig {
  const verifyMode = parseVerifyMode(process.env.AUTOPILOT_VERIFY_MODE);
  const pushMode = parsePushMode(process.env.AUTOPILOT_PUSH_MODE);
  const pendingMode = parsePendingMode(process.env.AUTOPILOT_PENDING_MODE);
  const releaseGateEnabled = parseBooleanEnv('AUTOPILOT_RELEASE_GATE_ENABLED', false);
  const linearDedupEnabled = parseBooleanEnv('AUTOPILOT_LINEAR_DEDUP_ENABLED', false);
  const linearDedupStatuses = parseCommaSeparatedEnv('AUTOPILOT_LINEAR_DEDUP_STATUSES', [
    'Done',
    'Cancelled',
    'Duplicate',
  ]);
  const inFlightDedupEnabled = parseBooleanEnv('AUTOPILOT_INFLIGHT_DEDUP_ENABLED', false);
  const inFlightDedupWindowHours = parsePositiveIntegerEnv('AUTOPILOT_INFLIGHT_DEDUP_WINDOW_HOURS', 6);
  const cli = parseCli(process.env.AUTOPILOT_CLI);
  const cursorApiKey = optionalEnv('CURSOR_API_KEY');
  const cursorModel = optionalEnv('AUTOPILOT_CURSOR_MODEL') ?? AUTOPILOT_CURSOR_DEFAULT_MODEL;
  const anthropicApiKey = optionalEnv('ANTHROPIC_API_KEY');
  const claudeModel = optionalEnv('AUTOPILOT_CLAUDE_MODEL') ?? AUTOPILOT_CLAUDE_DEFAULT_MODEL;

  // Config interlock: PR mode requires the verifier to be enforcing. Without
  // this, the bugfixer could push a branch whose claimed outcome doesn't
  // match the worktree (e.g. plan_file=plan.md but no plan.md committed), and
  // the reporter would happily open a PR against `dev` with a phantom fix.
  // Refusing to start is the safer failure mode.
  if (pushMode === 'pr' && verifyMode !== 'enforce') {
    throw new Error(
      `AUTOPILOT_PUSH_MODE=pr requires AUTOPILOT_VERIFY_MODE=enforce (got verifyMode="${verifyMode}") — refusing to start`,
    );
  }

  if (releaseGateEnabled === true && pendingMode !== 'enforce') {
    throw new Error(
      'AUTOPILOT_RELEASE_GATE_ENABLED requires AUTOPILOT_PENDING_MODE=enforce — release-skip quiet Sentry comments are routed through the pending-actions queue; with pendingMode=disabled or mirror, the queue is enqueued but never drained, so the comment is never delivered. Set AUTOPILOT_PENDING_MODE=enforce or AUTOPILOT_RELEASE_GATE_ENABLED=false.',
    );
  }

  if (linearDedupEnabled === true && pendingMode !== 'enforce') {
    throw new Error(
      'AUTOPILOT_LINEAR_DEDUP_ENABLED requires AUTOPILOT_PENDING_MODE=enforce — linear-dedup quiet Sentry comments are routed through the pending-actions queue; with pendingMode=disabled or mirror, the queue is enqueued but never drained, so the comment is never delivered. Set AUTOPILOT_PENDING_MODE=enforce or AUTOPILOT_LINEAR_DEDUP_ENABLED=false.',
    );
  }

  // Cursor CLI interlock: cursor-agent needs an API key at runtime. Fail during
  // config load so the supervisor doesn't start a session that can only fail
  // after it has claimed work.
  if (cli === 'cursor' && !cursorApiKey) {
    throw new Error('AUTOPILOT_CLI=cursor requires CURSOR_API_KEY — refusing to start');
  }

  // Claude CLI interlock: `claude --print` reads ANTHROPIC_API_KEY at runtime.
  // Mirror the cursor interlock so claude mode can't claim work it can't
  // complete. The autopilot env file may already carry the key for the droid
  // runner (droid uses Anthropic under the hood) — but if it's missing we
  // still need to fail fast rather than letting the session swallow an auth
  // error mid-tmux.
  if (cli === 'claude' && !anthropicApiKey) {
    throw new Error('AUTOPILOT_CLI=claude requires ANTHROPIC_API_KEY — refusing to start');
  }

  // GitHub credentials interlock: pr mode requires the PAT and the repo
  // full-name (`owner/repo`). Reporter.executePrOpen would otherwise fail at
  // first attempt with a 401 and bury credential issues in the pending-
  // actions retry queue. Fail-fast at config load instead.
  const githubToken = optionalEnv('GITHUB_TOKEN');
  const repoFullName = optionalEnv('AUTOPILOT_REPO_FULL_NAME');
  if (pushMode === 'pr') {
    if (!githubToken) {
      throw new Error('AUTOPILOT_PUSH_MODE=pr requires GITHUB_TOKEN — refusing to start');
    }
    if (!repoFullName) {
      throw new Error(
        'AUTOPILOT_PUSH_MODE=pr requires AUTOPILOT_REPO_FULL_NAME (e.g. "mindstone/rebel-app") — refusing to start',
      );
    }
    if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(repoFullName)) {
      throw new Error(
        `AUTOPILOT_REPO_FULL_NAME must be in "owner/repo" format (got "${repoFullName}")`,
      );
    }
  }

  return {
    sentryAuthToken: requireEnv('SENTRY_AUTH_TOKEN'),
    sentryOrg: optionalEnv('SENTRY_ORG') ?? DEFAULT_SENTRY_ORG,
    sentryProject: optionalEnv('SENTRY_PROJECT') ?? DEFAULT_SENTRY_PROJECT,
    cli,
    cursorApiKey,
    cursorModel,
    anthropicApiKey,
    claudeModel,
    linearApiKey: optionalEnv('LINEAR_API_KEY'),
    slackWebhook: optionalEnv('SLACK_WEBHOOK'),
    githubToken,
    repoFullName,
    phase: parsePhase(process.env.AUTOPILOT_PHASE),
    verifyMode,
    pushMode,
    pendingMode,
    stateDir: expandHome(optionalEnv('AUTOPILOT_STATE_DIR') ?? DEFAULT_STATE_DIR),
    maxConcurrent: parsePositiveIntegerEnv('AUTOPILOT_MAX_CONCURRENT', 3),
    maxHourly: parsePositiveIntegerEnv('AUTOPILOT_MAX_HOURLY', 6),
    maxDaily: parsePositiveIntegerEnv('AUTOPILOT_MAX_DAILY', 15),
    maxRetries: parsePositiveIntegerEnv('AUTOPILOT_MAX_RETRIES', 2),
    sessionTimeoutSeconds: parsePositiveIntegerEnv('AUTOPILOT_SESSION_TIMEOUT', 2700),
    bootstrapLookbackHours: parsePositiveIntegerEnv('BOOTSTRAP_LOOKBACK_HOURS', 24),
    repoRoot: expandHome(optionalEnv('REPO_ROOT') ?? DEFAULT_REPO_ROOT),
    releaseGateEnabled,
    releaseLagToleranceMinor: parseNonNegativeIntegerEnv('AUTOPILOT_RELEASE_LAG_TOLERANCE_MINOR', 0),
    linearDedupEnabled,
    linearDedupStatuses,
    inFlightDedupEnabled,
    inFlightDedupWindowHours,
    targetSentryId: optionalEnv('AUTOPILOT_TARGET_SENTRY_ID'),
  };
}
