#!/usr/bin/env npx tsx
/**
 * CI Validation: SKIP-capable gate strictness meta-gate.
 *
 * Kills the "a SKIP-capable validate:fast guard rots to a permanent SKIP in
 * every environment" class by construction — the exact shape that let the OSS
 * atomic-helper equivalence gate sit inert for ~5 weeks while a credential-write
 * helper drifted (postmortem
 * docs-private/postmortems/260612_inert_atomic_helper_equivalence_gate_postmortem.md,
 * recommendation #1, implement_now: true; fix run
 * docs/plans/260611_fix-mcp-equivalence-gate/PLAN.md Stage 4).
 *
 * Approach (mirrors the rot-proof release-mapping completeness gate,
 * commit 1716d8e7b / scripts/check-release-mapping-completeness.ts):
 *
 *   1. Enumerate the AUTHORITATIVE set of gate scripts — the ones actually
 *      wired into validate:fast (parsed from scripts/run-validate-fast.ts STEPS,
 *      resolved through package.json scripts).
 *   2. Conservatively detect which of those are SKIP-capable (can exit 0 on a
 *      missing-environment precondition). The detector deliberately over-flags;
 *      semantic precision is not assumed — the manifest is authoritative.
 *   3. Two-way staleness check against scripts/skip-capable-gate-manifest.ts:
 *        (a) UNDECLARED: a detected SKIP-capable script absent from the manifest
 *            → FAIL (forces an explicit strict-or-exclude decision).
 *        (b) STALE: a manifest entry whose script no longer exists, no longer
 *            matches the SKIP pattern, or is no longer wired into validate:fast
 *            → FAIL (dead/misleading declaration).
 *   4. Per STRICT entry: verify the named env var is wired in the named workflow
 *      (a non-comment mapping key / assignment line — comment mentions don't
 *      count; no full YAML semantics).
 *   5. Per EXCLUSION: reject blank/trivial reasons.
 *
 * This makes the manifest the single explicit place where every SKIP-capable
 * gate is classified, and makes adding a new one without a decision impossible.
 *
 * Run: npx tsx scripts/check-skip-capable-gate-strictness.ts
 * Wired into: validate:fast (scripts/run-validate-fast.ts)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { STEPS } from './run-validate-fast';
import {
  EXCLUDED_SKIP_CAPABLE_GATES,
  STRICT_SKIP_CAPABLE_GATES,
  type ExcludedSkipCapableGate,
  type StrictSkipCapableGate,
} from './skip-capable-gate-manifest';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST_FILE = 'scripts/skip-capable-gate-manifest.ts';

/**
 * This meta-gate's own script + manifest. They are excluded from the SKIP-capable
 * scan: the detector false-positives on them (they legitimately contain SKIP
 * advisory strings, error-message text, and the `status: 'skip'` detector regex
 * literal), yet neither ever exits 0 on a missing-environment precondition — the
 * meta-gate always evaluates fully and the manifest is data. Self-classifying the
 * scanner via the scanner would be meaningless. Kept as a by-construction filter
 * (not a manifest exclusion, which would falsely assert "this can skip").
 */
export const SELF_SCRIPTS: ReadonlySet<string> = new Set([
  'scripts/check-skip-capable-gate-strictness.ts',
  MANIFEST_FILE,
]);

/** Minimum reason length — same posture as the release-mapping exclusion gate. */
const MIN_REASON_LEN = 20;

/** Tokens in the STEPS list that name a gate script directly. */
const SCRIPT_TOKEN = /(scripts\/[A-Za-z0-9_./-]+\.ts)/g;
const NPM_RUN = /^npm run (\S+)$/;

/**
 * Resolve the authoritative set of gate-script paths wired into validate:fast.
 * A step's command either names a `scripts/*.ts` file directly or is
 * `npm run <name>` (looked up in package.json scripts, which itself names the
 * script). We collect every `scripts/*.ts` token from both forms.
 */
export function resolveValidateFastScripts(
  steps: ReadonlyArray<{ readonly command: string }>,
  pkgScripts: Readonly<Record<string, string | undefined>>,
): string[] {
  const found = new Set<string>();
  for (const step of steps) {
    const cmd = step.command.trim();
    const npm = NPM_RUN.exec(cmd);
    const effective = npm ? pkgScripts[npm[1]] : cmd;
    if (!effective) continue;
    for (const m of effective.matchAll(SCRIPT_TOKEN)) {
      found.add(m[1]);
    }
  }
  return [...found].sort();
}

/**
 * Conservative SKIP-capable detector. A script is SKIP-capable if its source
 * contains one of the repo's environment-conditional-success / bypass idioms
 * (broadened in Phase 6 after review F1 found callee-anchored matching
 * false-negatived on three real validate:fast gates):
 *
 *   1. A skip-advisory string literal — any quoted/template literal mentioning
 *      SKIP / SKIPPED / ⏭ / "skip:" / lowercase "skipping". Matching the
 *      LITERAL (not a specific logging callee) is deliberate: real gates log
 *      via console.*, process.std*.write, streams.stderr.write, AND injected
 *      log() functions (check-worker-build-smoke), so anchoring on the callee
 *      misses them.
 *   2. A discriminated `status: 'skip'` result (check-atomic-helper-equivalence).
 *   3. An env-var bypass read: `env.SKIP_<NAME>` (also matches the tail of
 *      `process.env.SKIP_<NAME>`) — check-cross-surface-parity-gap's emergency
 *      `SKIP_CROSS_SURFACE_PARITY_GAP=1`. Property access on `env` only — bare
 *      walk constants like SKIP_DIRS don't match.
 *   4. An env-value force-skip comparison: `=== 'skip'` —
 *      check-worker-build-smoke's `WORKER_BUILD_SMOKE=skip`.
 *
 * This over-flags (per-file "skipping" resilience logs, per-entry floor skips)
 * by design — the manifest classifies each honestly. It does NOT match
 * incidental directory-walk names like SKIP_DIRS / SKIP_DIR_NAMES /
 * WALK_SKIP_DIRECTORIES (bare identifiers, not advisory literals or env reads)
 * nor lowercase "(skipped)" summary counts.
 *
 * Honest residual: a SKIP-capable gate written with NO advisory text, no
 * status:'skip', no SKIP_* env read and no 'skip' value comparison (e.g. a
 * bare env-conditional `return 0`) is not pattern-matchable without AST/
 * data-flow analysis. The postmortem's companion lint-rule recommendation
 * (rec #2) is the author-time complement for that shape.
 *
 * Kept as a literal-pattern detector (not AST) to stay dependency-light and
 * <1s; the manifest's two-way staleness check is what makes the gate rot-proof,
 * so the detector only needs to reliably flag the family — false positives are
 * absorbed by exclusions, and a false negative is caught the moment that script
 * lands in the manifest (or by the strict/exclusion decision its author makes).
 */
export function isSkipCapable(source: string): boolean {
  // 1: a string/template literal carrying a skip advisory. The char class stops
  // at quotes/backticks/newlines so a match stays within one line's literal
  // segment (template `${...}` interpolations are crossed when quote-free —
  // that is how check-renderer-bundle-singletons' advisory matches).
  const SKIP_ADVISORY_LITERAL = /['"`][^'"`\n]*(?:\bSKIP\b|\bSKIPPED\b|⏭|\bskip:|\bskipping\b)/;
  // 2: a discriminated skip result.
  const SKIP_STATUS = /status:\s*['"]skip(?:ped)?['"]/;
  // 3: an env-var bypass read (covers process.env.SKIP_* via the trailing `env.`).
  const ENV_BYPASS = /\benv\.SKIP_[A-Z][A-Z0-9_]*/;
  // 4: an env-value force-skip comparison.
  const ENV_VALUE_SKIP = /===\s*['"]skip['"]/;
  return (
    SKIP_ADVISORY_LITERAL.test(source) ||
    SKIP_STATUS.test(source) ||
    ENV_BYPASS.test(source) ||
    ENV_VALUE_SKIP.test(source)
  );
}

/**
 * Verify a strict env var is actually WIRED in a workflow source: it must
 * appear as a YAML mapping key (`ENV: '1'`) or an inline assignment (`ENV=1`)
 * on a non-comment line. Raw substring presence is not enough — the env name
 * legitimately appears in workflow comments, which would stale-green the claim
 * if the real `env:` line were ever removed (Phase 6 review F3, tightened
 * string-check variant; full step-level binding deliberately not parsed — no
 * YAML semantics in this gate).
 */
export function strictEnvWiredInWorkflow(workflowSource: string, strictEnv: string): boolean {
  const escaped = strictEnv.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const wiredForm = new RegExp(`(^|[\\s{])${escaped}\\s*[:=]`);
  for (const line of workflowSource.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('#')) continue; // comment-only line
    if (wiredForm.test(trimmed)) return true;
  }
  return false;
}

export interface MetaGateInputs {
  /** Authoritative validate:fast gate-script paths (repo-relative). */
  readonly validateFastScripts: readonly string[];
  /** Reads a repo-relative file; returns null if it does not exist. */
  readonly readFile: (relPath: string) => string | null;
  readonly strict: readonly StrictSkipCapableGate[];
  readonly excluded: readonly ExcludedSkipCapableGate[];
  /**
   * Scripts the scan must ignore (the meta-gate's own script + manifest — see
   * SELF_SCRIPTS). They are neither scanned for the SKIP pattern nor permitted
   * as manifest entries. Defaults to empty for tests that don't need it.
   */
  readonly selfScripts?: ReadonlySet<string>;
}

/**
 * Pure core — exported for unit tests
 * (scripts/__tests__/check-skip-capable-gate-strictness.test.ts).
 * Returns the list of human-readable problems (empty = pass).
 */
export function checkSkipCapableGateStrictness(inputs: MetaGateInputs): string[] {
  const { validateFastScripts, readFile, strict, excluded } = inputs;
  const selfScripts = inputs.selfScripts ?? new Set<string>();
  const errors: string[] = [];

  const declared = new Map<string, 'strict' | 'excluded'>();
  for (const e of strict) {
    if (selfScripts.has(e.script)) {
      errors.push(
        `${MANIFEST_FILE}: ${e.script} is the meta-gate's own script/manifest and must not be ` +
          `declared (it is excluded from the scan by construction, not via the manifest).`,
      );
    }
    if (declared.has(e.script)) {
      errors.push(`${MANIFEST_FILE}: ${e.script} is declared more than once.`);
    }
    declared.set(e.script, 'strict');
  }
  for (const e of excluded) {
    if (selfScripts.has(e.script)) {
      // Phase 6 review F2: mirror the strict-loop rejection — a self-script
      // exclusion would pass staleness (file exists + matches the detector).
      errors.push(
        `${MANIFEST_FILE}: ${e.script} is the meta-gate's own script/manifest and must not be ` +
          `declared (it is excluded from the scan by construction, not via the manifest).`,
      );
    }
    if (declared.has(e.script)) {
      errors.push(
        `${MANIFEST_FILE}: ${e.script} is in both STRICT and EXCLUDED (or listed twice). ` +
          `Pick one — a gate either has a strict CI leg or is an accepted skip, not both.`,
      );
    }
    declared.set(e.script, 'excluded');
  }

  const skipCapable = new Set<string>();
  for (const scriptPath of validateFastScripts) {
    if (selfScripts.has(scriptPath)) continue; // the scanner doesn't scan itself
    const src = readFile(scriptPath);
    if (src === null) continue; // not our concern — a missing step script fails elsewhere
    if (isSkipCapable(src)) skipCapable.add(scriptPath);
  }

  // (a) UNDECLARED: a SKIP-capable validate:fast script not in the manifest.
  for (const scriptPath of [...skipCapable].sort()) {
    if (!declared.has(scriptPath)) {
      errors.push(
        `${scriptPath} looks SKIP-capable (it can exit 0 on a missing-environment precondition) but is ` +
          `not declared in ${MANIFEST_FILE}. Add it as a STRICT entry (naming the REQUIRE_* env var + the ` +
          `workflow that sets it) if it must run strict in CI, or as an EXCLUDED entry with an honest reason ` +
          `if its skip is acceptable-by-design (a detector false-positive counts — say so).`,
      );
    }
  }

  // (b) STALE: a manifest entry whose script is missing, no longer skip-capable,
  // or no longer wired into validate:fast (Phase 6 review F4 — the manifest is
  // documented as the list of SKIP-capable *validate:fast* gates, so an entry
  // for a script dropped from STEPS is dead config).
  const wired = new Set(validateFastScripts);
  for (const [scriptPath] of declared) {
    const src = readFile(scriptPath);
    if (src === null) {
      errors.push(
        `${MANIFEST_FILE} declares ${scriptPath}, but no such file exists. Remove the stale entry ` +
          `(or fix the path if the script moved).`,
      );
      continue;
    }
    if (!wired.has(scriptPath)) {
      errors.push(
        `${MANIFEST_FILE} declares ${scriptPath}, but it is not wired into validate:fast ` +
          `(not reachable from scripts/run-validate-fast.ts STEPS). Remove the stale entry — this ` +
          `manifest only classifies gates that actually run in validate:fast.`,
      );
    }
    if (!isSkipCapable(src)) {
      errors.push(
        `${MANIFEST_FILE} declares ${scriptPath} as SKIP-capable, but it no longer matches the SKIP ` +
          `pattern (its skip path was removed?). Remove the stale entry so the manifest only lists gates ` +
          `that can actually skip.`,
      );
    }
  }

  // STRICT entries: the named env var must literally appear in the named workflow.
  for (const entry of strict) {
    const workflow = readFile(entry.ciLocation);
    if (workflow === null) {
      errors.push(
        `${MANIFEST_FILE}: STRICT entry ${entry.script} names ciLocation '${entry.ciLocation}', ` +
          `which does not exist. Fix the workflow path.`,
      );
      continue;
    }
    if (!strictEnvWiredInWorkflow(workflow, entry.strictEnv)) {
      errors.push(
        `${MANIFEST_FILE}: STRICT entry ${entry.script} claims it runs strict via '${entry.strictEnv}' ` +
          `in ${entry.ciLocation}, but that env var is not wired there (no non-comment ` +
          `'${entry.strictEnv}:' mapping key or '${entry.strictEnv}=' assignment — a mention in a ` +
          `comment does not count). Wire the strict leg (set ${entry.strictEnv} on the validate step) ` +
          `or reclassify as EXCLUDED.`,
      );
    }
    if (entry.note.trim().length < MIN_REASON_LEN) {
      errors.push(
        `${MANIFEST_FILE}: STRICT entry ${entry.script} has a blank or trivial note. ` +
          `State how/where it runs strict.`,
      );
    }
  }

  // EXCLUSIONS: reject blank/trivial reasons.
  for (const entry of excluded) {
    if (entry.reason.trim().length < MIN_REASON_LEN) {
      errors.push(
        `${MANIFEST_FILE}: EXCLUDED entry ${entry.script} has a blank or trivial reason. ` +
          `Document WHY its skip is acceptable-by-design (or honestly: "no strict leg today — candidate for one").`,
      );
    }
  }

  return errors;
}

function readRepoFile(relPath: string): string | null {
  const abs = path.join(ROOT, relPath);
  try {
    return fs.readFileSync(abs, 'utf8');
  } catch {
    return null;
  }
}

function loadPackageJsonScripts(): Record<string, string | undefined> {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    return parsed.scripts ?? {};
  } catch {
    return {};
  }
}

function main(): number {
  const validateFastScripts = resolveValidateFastScripts(STEPS, loadPackageJsonScripts());
  if (validateFastScripts.length === 0) {
    process.stderr.write(
      'check-skip-capable-gate-strictness: FAIL — resolved ZERO gate scripts from ' +
        'scripts/run-validate-fast.ts STEPS (parser drift?).\n',
    );
    return 1;
  }

  const errors = checkSkipCapableGateStrictness({
    validateFastScripts,
    readFile: readRepoFile,
    strict: STRICT_SKIP_CAPABLE_GATES,
    excluded: EXCLUDED_SKIP_CAPABLE_GATES,
    selfScripts: SELF_SCRIPTS,
  });

  if (errors.length === 0) {
    process.stdout.write(
      `check-skip-capable-gate-strictness: OK — ${STRICT_SKIP_CAPABLE_GATES.length} strict + ` +
        `${EXCLUDED_SKIP_CAPABLE_GATES.length} excluded entry/entries cover every SKIP-capable ` +
        `gate wired into validate:fast (${validateFastScripts.length} gate scripts scanned).\n`,
    );
    return 0;
  }

  process.stderr.write(
    `check-skip-capable-gate-strictness: FAIL — ${errors.length} problem(s) with ${MANIFEST_FILE}:\n\n`,
  );
  for (const error of errors) {
    process.stderr.write(`  - ${error}\n`);
  }
  process.stderr.write(
    '\nSee docs/plans/260611_fix-mcp-equivalence-gate/PLAN.md Stage 4 and the postmortem\n' +
      'docs-private/postmortems/260612_inert_atomic_helper_equivalence_gate_postmortem.md for the policy.\n',
  );
  return 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main());
}
