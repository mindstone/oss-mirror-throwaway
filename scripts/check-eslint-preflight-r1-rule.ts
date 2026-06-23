#!/usr/bin/env tsx
/**
 * R1 phase-to-phase ESLint rule preflight (chunk S2-B1).
 *
 * **Why this exists**: R1 Stage 1 introduced two `no-restricted-imports`
 * rules in `eslint.config.mjs` to prevent `turnPipeline/*` phase modules
 * from importing each other and to prevent the orchestrator's peer
 * modules (`queryOptionsBuilder.ts`, `agentQueryRunner.ts`,
 * `turnErrorRecovery.ts`) from re-importing back into `turnPipeline/*`.
 * Both rules are load-bearing: without them, the structural argument
 * for R1's Stage 2 turnAdmission extraction (commit `242a9377d`) is
 * undermined and the cycles the rules forbid can re-emerge silently.
 *
 * R2 Stage 2 introduces a parallel structural defence (the manifest
 * approach) that has its own ESLint hooks (e.g., chunk S2-B2's
 * `as AgentEvent` lint rule). To make sure R2's edits to
 * `eslint.config.mjs` don't accidentally drop or rename R1's rules,
 * `validate:fast` runs this preflight: if either of R1's two anchor
 * messages is missing from the config, fail with a clear remediation.
 *
 * The detection is deliberately string-based, not AST-based: an
 * AST-based check would couple this script to the internal structure
 * of the ESLint flat config. The two anchor strings (the human-readable
 * `message:` text in each rule) are the most stable identifier R1
 * produces, and a malicious or careless edit that preserves the rule
 * but renames the message text is a bigger problem this script is
 * supposed to surface anyway.
 *
 * Test fixtures live in `scripts/__tests__/check-eslint-preflight-r1-rule.test.ts`.
 *
 * @see eslint.config.mjs § "R1 turnPipeline phase-to-phase import guards"
 * @see docs/plans/260427_refactor_agent_turn_executor_pipeline.md § Stage 1
 * @see docs/plans/260429_r2_stage2_chunked_implementation_plan.md § S2-B1
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * The two anchor message strings R1 Stage 1 placed in
 * `eslint.config.mjs`. Both must be present.
 *
 * If R1 ever legitimately renames either message (e.g., refactors the
 * rule into a shared helper), the rename PR must update this constant
 * and the matching test fixtures atomically. Co-locating the constant
 * here means the preflight is the single source of truth.
 */
export const REQUIRED_R1_ANCHORS = [
  'R1 phase-to-phase import forbidden:',
  'R1 cycle-prevention:',
] as const;

export type R1Anchor = (typeof REQUIRED_R1_ANCHORS)[number];

export type PreflightResult = Readonly<{
  ok: boolean;
  configPath: string;
  /** The anchors that were NOT found. Empty array means all present. */
  missingAnchors: readonly R1Anchor[];
  /** Optional read error (file missing, permission, etc.); null on success. */
  readError: string | null;
}>;

/**
 * Pure preflight: given config text, return which anchors are missing.
 *
 * Exposed as a separate function so the test suite can exercise the
 * detector without touching the filesystem. The CLI wrapper at the
 * bottom of this file does the I/O.
 */
export function evaluatePreflight(configText: string): readonly R1Anchor[] {
  return REQUIRED_R1_ANCHORS.filter((anchor) => !configText.includes(anchor));
}

/**
 * Resolve the absolute path of `eslint.config.mjs` relative to this
 * script. Allows the CLI to be invoked from any CWD without surprise.
 */
export function resolveDefaultConfigPath(): string {
  return resolve(__dirname, '..', 'eslint.config.mjs');
}

/**
 * Load and check the ESLint config file. On read failure, returns
 * `ok: false` with a descriptive `readError`; the CLI caller surfaces
 * it as a fail-closed remediation. Never silently treats "file missing"
 * as "rule absent" — those are different failure modes and the
 * remediation differs.
 */
export function runPreflight(configPath: string): PreflightResult {
  if (!existsSync(configPath)) {
    return {
      ok: false,
      configPath,
      missingAnchors: REQUIRED_R1_ANCHORS,
      readError: `eslint.config.mjs not found at ${configPath}`,
    };
  }

  let configText: string;
  try {
    configText = readFileSync(configPath, 'utf8');
  } catch (err) {
    return {
      ok: false,
      configPath,
      missingAnchors: REQUIRED_R1_ANCHORS,
      readError: `Failed to read ${configPath}: ${(err as Error).message}`,
    };
  }

  const missing = evaluatePreflight(configText);
  return {
    ok: missing.length === 0,
    configPath,
    missingAnchors: missing,
    readError: null,
  };
}

/**
 * Render a remediation message for a failed preflight result. Pure
 * (no console.log) so the test suite can snapshot the exact text.
 */
export function renderFailureMessage(result: PreflightResult): string {
  const lines: string[] = [];
  lines.push('R1 phase-to-phase ESLint rule preflight FAILED.');
  lines.push('');

  if (result.readError !== null) {
    lines.push(`Reason: ${result.readError}`);
    lines.push('');
  }

  if (result.missingAnchors.length > 0) {
    lines.push('Missing anchor messages in eslint.config.mjs:');
    for (const anchor of result.missingAnchors) {
      lines.push(`  - "${anchor}"`);
    }
    lines.push('');
  }

  lines.push('Why this matters:');
  lines.push(
    '  R1 Stage 1 introduced two no-restricted-imports rules to prevent',
  );
  lines.push(
    '  turnPipeline/* cycles. Removing or renaming either rule undermines',
  );
  lines.push(
    '  R1\'s structural argument and re-opens the bug class the refactor',
  );
  lines.push('  exists to close.');
  lines.push('');
  lines.push('Remediation:');
  lines.push(
    '  Restore the rules in eslint.config.mjs (see git history of that',
  );
  lines.push(
    '  file for the canonical form). If you legitimately renamed an anchor',
  );
  lines.push(
    '  message, update REQUIRED_R1_ANCHORS in scripts/check-eslint-preflight-r1-rule.ts',
  );
  lines.push(
    '  and the matching test fixtures atomically in the same PR.',
  );
  lines.push('');
  lines.push(
    '  See docs/plans/260427_refactor_agent_turn_executor_pipeline.md § Stage 1.',
  );
  return lines.join('\n');
}

// ============================================================================
//   CLI entry point
// ============================================================================

if (require.main === module) {
  const result = runPreflight(resolveDefaultConfigPath());
  if (result.ok) {
    // Quiet success — validate:fast prefers no-news-is-good-news for
    // green-path checks.
    process.exit(0);
  }
  process.stderr.write(renderFailureMessage(result));
  process.stderr.write('\n');
  process.exit(1);
}
