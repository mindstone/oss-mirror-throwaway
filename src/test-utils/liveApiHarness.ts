/**
 * Shared live-API test harness (TEST-ONLY — never imported by production code).
 *
 * Consolidates the hand-rolled `const liveDescribe = KEY ? describe : describe.skip`
 * pattern that every `*.live.integration.test.ts` file re-implements onto one helper
 * that enforces the live-tier invariants by construction. Design:
 * docs/plans/260604_testing-bug-catching/subagent_reports/260605_000031_researcher-liveapi-design-gpt55.md
 * and the "Live-API integration test pattern" section of
 * docs/project/TESTING_AUTOMATION_OVERVIEW.md (the 260419 diagnostic discipline).
 *
 * Five invariants, enforced HERE so individual tests can't get them wrong:
 *  1. Missing / empty / whitespace-only key  =>  SKIP, never fail.
 *  2. The skip line names exactly WHICH prerequisite failed (one console.log per
 *     skipped cell), per the 260419 diagnostic discipline.
 *  3. Key material is NEVER logged or returned except as the opaque `key` passed
 *     to the test callback — never in a skipReason, never in a `requires`
 *     diagnostic (defensively redacted as a backstop), never in a console line.
 *  4. Env values are trimmed; empty / whitespace-only is treated as absent.
 *  5. No retries anywhere in the harness.
 *
 * The whole tier is additionally gated behind an explicit opt-in env var,
 * `RUN_LIVE_API_TESTS`: if unset (or blank) every cell SKIPS with a clear reason,
 * so the file is inert in normal / CI runs even if provider keys happen to be
 * present. `TEST_CLAUDE_API_KEY` is a legacy alias for `TEST_ANTHROPIC_API_KEY`.
 *
 * Two credential classes are supported:
 *  - ENV-KEYED providers (anthropic / openai / openrouter) gate on `cell.envVar`;
 *    the resolved key is the harness's sole secret channel (invariant 3).
 *  - NON-ENV providers (codex / ChatGPT Pro) gate on a cheap `cell.credentialProbe`
 *    instead. Their OAuth tokens are `safeStorage`-encrypted on disk and can only
 *    be sourced (via Electron) inside the test body — never as an env var — so NO
 *    secret flows through the harness for these cells (invariant 3 holds for free).
 *    The probe returns a boolean + a key-free diagnostic only.
 *
 * IMPORTANT: this module must NOT enter app/runtime bundles. It lives under
 * `src/test-utils/`, imports only `vitest`, and reads only `process.env` (or an
 * injected env map). Do not import it from anything under `src/main`, `src/core`,
 * `src/renderer`, or `src/preload`.
 */
import { describe } from 'vitest';

export type LiveProvider = 'anthropic' | 'openrouter' | 'openai' | 'codex';

export type LiveApiEnvVar =
  | 'TEST_ANTHROPIC_API_KEY'
  | 'TEST_CLAUDE_API_KEY'
  | 'TEST_OPENROUTER_API_KEY'
  | 'TEST_OPENAI_API_KEY';

/**
 * Cheap, synchronous availability probe for NON-env credential providers (codex).
 * MUST NOT return or embed secret material — only a boolean + a key-free
 * `diagnostic` surfaced verbatim in the skip line when `available` is false. The
 * real credential is sourced inside the test body, not here.
 */
export type LiveApiCredentialProbe = () => { available: boolean; diagnostic: string };

/**
 * Extra named prerequisite that must hold for a cell to run, beyond the key.
 * `diagnostic` is author-supplied and surfaced in the skip line, so it MUST NOT
 * contain secret material (invariant 3); the harness also defensively redacts any
 * known key value before surfacing it.
 */
export interface LiveApiRequirement {
  name: string;
  ok: boolean;
  diagnostic: string;
}

export interface LiveApiCell {
  provider: LiveProvider;
  /** Human-readable label used in the describe block + skip diagnostics. */
  label: string;
  /**
   * The env var holding the key for ENV-KEYED providers. Mutually exclusive with
   * `credentialProbe` — a cell MUST declare exactly one credential source.
   */
  envVar?: LiveApiEnvVar;
  /**
   * Cheap availability probe for NON-env providers (codex). Mutually exclusive
   * with `envVar`. No secret flows through the harness for probe-gated cells.
   */
  credentialProbe?: LiveApiCredentialProbe;
  model: string;
  timeoutMs?: number;
  maxTokens?: number;
  requires?: LiveApiRequirement[];
}

/** Minimal, read-only env shape so callers/tests can inject without `process.env`. */
export type LiveApiEnv = Readonly<Record<string, string | undefined>>;

/**
 * Gating result. A discriminated union: `key` (the opaque secret) is present ONLY
 * when `canRun` is true; `skipReason` is present ONLY when `canRun` is false and
 * NEVER contains key material.
 */
export type LiveApiPrereq =
  | { canRun: true; key: string }
  | { canRun: false; skipReason: string };

/** Cheap default models per provider (one tiny call per cell). */
export const CHEAP_LIVE_MODELS = {
  anthropic: 'claude-haiku-4-5',
  openrouter: 'deepseek/deepseek-v4-flash',
  openai: 'gpt-5-nano',
  // ChatGPT Pro / Codex bills against the subscription (not per-token), so the
  // pick optimizes for a fast, reliable round-trip rather than price.
  codex: 'gpt-5.4',
} as const;

/** Source-of-truth list of key-bearing env vars, used for defensive redaction. */
const LIVE_API_KEY_ENV_VARS: readonly LiveApiEnvVar[] = [
  'TEST_ANTHROPIC_API_KEY',
  'TEST_CLAUDE_API_KEY',
  'TEST_OPENROUTER_API_KEY',
  'TEST_OPENAI_API_KEY',
];

/** Invariant 4: trim, and treat empty / whitespace-only as absent (undefined). */
function trimEnvValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Ordered list of env vars to consult for a cell's key. Anthropic accepts
 * `TEST_CLAUDE_API_KEY` as a legacy alias for `TEST_ANTHROPIC_API_KEY` (and
 * vice-versa, preserving whichever the cell declared as primary).
 */
function keyEnvVarsFor(envVar: LiveApiEnvVar): LiveApiEnvVar[] {
  if (envVar === 'TEST_ANTHROPIC_API_KEY') {
    return ['TEST_ANTHROPIC_API_KEY', 'TEST_CLAUDE_API_KEY'];
  }
  if (envVar === 'TEST_CLAUDE_API_KEY') {
    return ['TEST_CLAUDE_API_KEY', 'TEST_ANTHROPIC_API_KEY'];
  }
  return [envVar];
}

/**
 * Shared `requires[]` check. Returns a key-free skip prereq for the first failing
 * requirement (defensively redacted per invariant 3), or null if all hold.
 */
function firstFailedRequirement(
  cell: LiveApiCell,
  env: LiveApiEnv,
): { canRun: false; skipReason: string } | null {
  const failed = cell.requires?.find((requirement) => !requirement.ok);
  if (!failed) return null;
  return {
    canRun: false,
    skipReason: `prerequisite '${failed.name}' not met: ${sanitizeDiagnostic(failed.diagnostic, env)}`,
  };
}

/**
 * Defense-in-depth for invariant 3: strip any present key value out of a string
 * before it is surfaced. Authors are expected to keep keys out of diagnostics;
 * this guarantees it even if one slips through.
 */
function sanitizeDiagnostic(diagnostic: string, env: LiveApiEnv): string {
  let sanitized = diagnostic;
  for (const envVar of LIVE_API_KEY_ENV_VARS) {
    const key = trimEnvValue(env[envVar]);
    if (!key) continue;
    sanitized = sanitized.split(key).join('[REDACTED]');
  }
  return sanitized;
}

function formatEnvPrerequisite(envVars: readonly LiveApiEnvVar[]): string {
  if (envVars.length === 1) return envVars[0];
  return `${envVars[0]} (or legacy alias ${envVars[1]})`;
}

/**
 * Pure gating decision for a single cell. SKIP is always the safe outcome — this
 * function never throws and never fails a test. `env` is injectable so the unit
 * tests can exercise the logic without mutating `process.env`.
 *
 * Order of checks (each produces a specific, key-free skipReason):
 *  1. Opt-in gate `RUN_LIVE_API_TESTS` unset/blank.
 *  2a. ENV-KEYED cell: the key env var (with anthropic alias) missing/blank.
 *  2b. PROBE-GATED cell (codex): the credential probe reports unavailable.
 *  3. Any failing `requires[]` prerequisite — surfaces its (redacted) diagnostic.
 *
 * A cell MUST declare exactly one of `envVar` / `credentialProbe`; a cell with
 * neither is a test-author error and skips with a clear reason (never throws).
 */
export function getLiveApiPrereq(cell: LiveApiCell, env: LiveApiEnv = process.env): LiveApiPrereq {
  // Invariant: the whole tier is opt-in. Checked first so the reason is unambiguous.
  if (!trimEnvValue(env.RUN_LIVE_API_TESTS)) {
    return {
      canRun: false,
      skipReason: 'RUN_LIVE_API_TESTS is not set (live-API tier is opt-in).',
    };
  }

  // Test-author error: the two credential sources are mutually exclusive. Enforce
  // it rather than silently preferring one (envVar) — SKIP (never throw) so a
  // malformed cell can't fail the whole tier.
  if (cell.envVar && cell.credentialProbe) {
    return {
      canRun: false,
      skipReason: `cell '${cell.label}' declares BOTH envVar and credentialProbe (test-author error — declare exactly one).`,
    };
  }

  // ENV-KEYED providers: resolve the key (invariants 1 + 4): trim, blank = absent.
  if (cell.envVar) {
    const keyEnvVars = keyEnvVarsFor(cell.envVar);
    let key: string | undefined;
    for (const envVar of keyEnvVars) {
      key = trimEnvValue(env[envVar]);
      if (key) break;
    }
    if (!key) {
      // Invariant 2: name exactly which env var(s) were missing. No key material
      // is in scope here, so invariant 3 holds trivially.
      return {
        canRun: false,
        skipReason: `${formatEnvPrerequisite(keyEnvVars)} is not set.`,
      };
    }
    const failed = firstFailedRequirement(cell, env);
    if (failed) return failed;
    // Invariant 3: the key is returned ONLY here, as the opaque `key`.
    return { canRun: true, key };
  }

  // NON-env providers (codex): a cheap availability probe gates the cell. The
  // probe yields NO secret — the real credential is sourced in the test body.
  if (cell.credentialProbe) {
    const probe = cell.credentialProbe();
    if (!probe.available) {
      return { canRun: false, skipReason: sanitizeDiagnostic(probe.diagnostic, env) };
    }
    const failed = firstFailedRequirement(cell, env);
    if (failed) return failed;
    // No secret flows through the harness for probe-gated cells; `key` is an
    // empty sentinel (invariant 3 holds for free — see module docstring).
    return { canRun: true, key: '' };
  }

  // Test-author error: a cell must declare a credential source. SKIP (never
  // throw) so one malformed cell can't fail the whole tier.
  return {
    canRun: false,
    skipReason: `cell '${cell.label}' declares neither envVar nor credentialProbe (test-author error).`,
  };
}

/**
 * Build the single skip-diagnostic line for a skipped cell (invariant 2). Pure
 * and exported so it can be unit-tested without driving vitest's suite functions
 * (which may not be called from inside a test). `skipReason` is guaranteed
 * key-free by getLiveApiPrereq, so this line never carries secret material
 * (invariant 3).
 */
export function liveApiSkipLogLine(cell: LiveApiCell, skipReason: string): string {
  return `Skipping live-API integration test: ${cell.label}: ${skipReason}`;
}

/**
 * Wrap a live-API test body in `describe` (when the cell can run) or
 * `describe.skip` (otherwise), logging exactly one diagnostic line per skipped
 * cell (invariant 2). The callback receives only `{ key, model }` — `key` is the
 * sole channel for secret material (invariant 3).
 *
 * No retries are configured anywhere (invariant 5); per-test timeouts are the
 * test author's responsibility via the `it`-level timeout (cell.timeoutMs is a
 * convenience the test body can read). `env` is injectable for unit testing.
 *
 * NOTE: this must be called at the top level of a test file (or inside another
 * `describe`), never from inside an `it` — it creates a vitest suite.
 */
export function describeLiveApi(
  cell: LiveApiCell,
  fn: (ctx: { key: string; model: string }) => void,
  env: LiveApiEnv = process.env,
): void {
  const prereq = getLiveApiPrereq(cell, env);
  if (!prereq.canRun) {
    // Invariant 2: exactly one diagnostic line per skipped cell. `skipReason`
    // is guaranteed key-free by getLiveApiPrereq (invariant 3).
    console.warn(liveApiSkipLogLine(cell, prereq.skipReason));
    describe.skip(cell.label, () => undefined);
    return;
  }

  describe(cell.label, () => {
    fn({ key: prereq.key, model: cell.model });
  });
}

/**
 * Identity pass-through for a matrix of cells. Exists as the single declaration
 * point so the type is enforced at the call site and future validation (dedupe,
 * CN-gate assertions) has one chokepoint to live in.
 */
export function liveApiMatrix(cells: readonly LiveApiCell[]): readonly LiveApiCell[] {
  return cells;
}
