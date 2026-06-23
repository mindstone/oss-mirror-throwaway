#!/usr/bin/env npx tsx
/**
 * CI warn-gate: zero-test-introducing-commit detector (qa14 class)
 *
 * The "zero-test-introducing commit" class (chief_pathologist_v2 question
 * qa14: 78 commits / 94 bugs) is the single highest-frequency bug source in
 * this repo's history — a large slug of production code ships with NO
 * accompanying test change, so a regression has nothing to catch it at PR
 * time. Concrete past offenders: a 5,208-line super-mcp rewrite, a 2,309-line
 * Google OAuth, an ironic 1,133-line merge-integrity defence (which itself
 * caused two bugs). See:
 *   coding-agent-instructions/scripts/chief_pathologist_v2/analyses/qa14_zero_test_commits.py
 *   docs/plans/260526_hotspot-refactor-roadmap/PLAN.md  (Stage T1)
 *   docs/plans/260526_hotspot-refactor-roadmap/subagent_reports/260529_180001_researcher-testing-ci-e2e-gaps.md
 *
 * WHAT THIS GATE DOES
 * -------------------
 * It diffs the branch against its merge-base with the integration branch
 * (`origin/dev`) — like `scripts/check-r1-r2-overlap.ts` — so it judges THIS
 * branch's own commits, not dev work merged in. It sums added/changed lines
 * of non-test PRODUCTION code and the added/changed lines of any TEST file
 * (`*.test.ts(x)`, `*.spec.ts(x)`, `__tests__/**`, `tests/**`). If prod-LOC
 * added >= THRESHOLD and test-LOC added === 0, the commit is flagged.
 *
 * "PRODUCTION code" is defined by EXCLUSION, matching the qa14 classifier:
 * everything that is not a test file and not path-exempt (docs / markdown /
 * planning folder / lockfiles / generated / `.d.ts` / JSON config+fixtures)
 * is production. This is deliberately NOT a hand-maintained root allowlist —
 * an allowlist silently drops any prod tree not listed on it (an earlier
 * version narrowed to 5 `src` roots and so structurally COULD NOT flag a
 * zero-test commit under `super-mcp/`, `packages/<pkg>/src`, `meeting-bot-worker/`,
 * `web-companion/`, `factory/`, or top-level `scripts/` — including the
 * header's own headline offender, the 5,208-line super-mcp rewrite). Defining
 * prod by exclusion means a new surface is covered by default the day it lands.
 *
 * SOFT-LAUNCH POSTURE (warn-first — mirrors `eslint-new-warnings`)
 * ---------------------------------------------------------------
 * By default this gate is **WARN-ONLY**: it prints a clear warning and an
 * advisory `[test-coverage-delta] ADVISORY` marker, but exits 0 so it does
 * NOT fail `validate:fast` or block a commit. This is deliberate — the
 * false-positive profile of a pure-LOC heuristic is highest on legitimate
 * behaviour-preserving refactors (code extracted to a new file reads as
 * net-new prod-LOC even though existing tests already cover it), and we want
 * to measure the FP rate in the wild before promoting it to blocking.
 *
 * HOW TO FLIP IT TO BLOCKING (later)
 * ----------------------------------
 * One of two ways, no code edit required:
 *   - set env `TEST_COVERAGE_DELTA_ENFORCE=1`, OR
 *   - pass `--enforce` on the command line.
 * In enforce mode a flagged, un-acked commit exits 1 (fails the gate). The
 * intended promotion path: run warn-only across a few weeks, confirm the
 * only flags are genuine zero-test slugs or carry the ack token, then add
 * `TEST_COVERAGE_DELTA_ENFORCE=1` to the `validate:test-coverage-delta` npm
 * script (or to the CI job env) to make it blocking.
 *
 * ACK-TOKEN ESCAPE HATCH
 * ----------------------
 * A legitimately test-free change (a pure refactor verified by existing
 * tests, a generated file, a config/wiring change) is acknowledged by adding
 * a commit-message token, matching the repo's existing `[bracket-token]`
 * convention (cf. `[r1-r2-overlap-ack]`, `[skip-tests]`, `[deploy-beta]`):
 *
 *     [no-test-needed: <reason>]
 *
 * The reason must be a real sentence (>= 20 chars, no weak markers like TODO
 * / later / temp) — same discipline as `check-cross-surface-parity-gap.ts`'s
 * exemption-rationale validator, so the ack documents intent rather than
 * waving the gate through. The token may appear in ANY commit subject/body in
 * the merge-base..HEAD range (or, in CI PR mode, the PR title). It is
 * documentation-of-intent, NOT a "bad" marker.
 *
 * EXEMPTIONS (paths that never count toward prod-LOC)
 * ---------------------------------------------------
 * Docs/markdown, the planning folder, lockfiles, generated files, snapshots,
 * type-only declaration files (`*.d.ts`), and JSON (config + eval fixtures —
 * eval fixtures are test data, not prod). These keep the prod-LOC column
 * honest so a docs-only or config-only commit never surfaces as an offender.
 * NOTE: this gate is intentionally MORE lenient than the canonical qa14
 * classifier, which counts JSON / `.d.ts` / lockfiles / generated as prod.
 * The exemption set is the ONLY divergence from "everything-else = prod"; it
 * trims data/config noise rather than narrowing which code trees are policed.
 *
 * THRESHOLD (N)
 * -------------
 * N = 200 added prod-LOC. This matches the canonical qa14 classifier
 * (`PROD_LINES_THRESHOLD = 200` in qa14_zero_test_commits.py) so the gate
 * flags exactly the population the bug analysis named. Back-tested over 200
 * recent non-merge commits with the exclusion-based prod classifier, N=200
 * flags 4 commits (2.0%) — all four are behaviour-preserving extractions, an
 * eval harness, or test-infra fakes that re-use existing tests, i.e. correctly
 * ack-able. (The 4th, a `scripts/`-only smoke-fake change, was a false-NEGATIVE
 * under the prior 5-root allowlist — widening to the qa14 exclusion model is
 * what surfaces it.) Lowering N to 80 added no genuine new catch in that
 * sample (the additional band 25-79 prod-LOC was all tiny style/lint/comment
 * commits). See the Stage-T1 implementer reports for the full back-test profile.
 *
 * Wired into: `npm run validate:fast` (warn mode) and standalone
 * `npm run validate:test-coverage-delta`.
 *
 * Like `check-r1-r2-overlap.ts`, this gate FAILS CLOSED when it cannot
 * compute the diff (missing base ref / shallow clone) ONLY in enforce mode;
 * in warn mode an un-computable diff degrades to a warning + exit 0 so a
 * soft-launch gate never breaks a build on infra grounds.
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { gitCapture } from './lib/git-exec.js';

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/**
 * Added prod-LOC threshold. >= this many added non-test prod lines with zero
 * test-LOC added trips the gate. Matches qa14's PROD_LINES_THRESHOLD.
 */
export const PROD_LOC_THRESHOLD = 200;

/** Commit/PR-title token that exempts a legitimately test-free change. */
export const ACK_TOKEN_PREFIX = '[no-test-needed:';

/** Env var that promotes the gate from warn-only to blocking. */
const ENV_ENFORCE = 'TEST_COVERAGE_DELTA_ENFORCE';

/** Minimum ack-reason length, and weak markers that void an ack reason. */
const MIN_ACK_REASON_LENGTH = 20;
const WEAK_ACK_PATTERNS: readonly { pattern: RegExp; label: string }[] = [
  { pattern: /\bTODO\b/iu, label: 'TODO' },
  { pattern: /\bFIXME\b/iu, label: 'FIXME' },
  { pattern: /\bXXX\b/iu, label: 'XXX' },
  { pattern: /\bWIP\b/iu, label: 'WIP' },
  { pattern: /\btemp(orary)?\b/iu, label: 'temp/temporary' },
  { pattern: /\blater\b/iu, label: 'later' },
];

// ---------------------------------------------------------------------------
// Path classification — pure, exported for testing
// ---------------------------------------------------------------------------

/** Test-file markers: dir segment `__tests__`/`tests`/`test`, or `.test.`/`.spec.` basename. */
const TEST_DIR_RE = /(^|\/)(__tests__|tests?)(\/|$)/u;
const TEST_BASENAME_RE = /(?:\.test\.[^/]+|\.spec\.[^/]+)$/u;

/**
 * Path-exempt: never counts toward prod-LOC even under a prod root.
 *   - docs/markdown + the planning folder + changelogs
 *   - lockfiles
 *   - generated / snapshot / declaration files
 *   - JSON (config + eval fixtures are test data, not prod)
 */
const EXEMPT_RE =
  /(?:\.md$|\.mdx$|^docs\/|\/docs\/|(^|\/)CHANGELOG|(^|\/)package-lock\.json$|\.lock$|\.snap$|\.d\.ts$|\.json$|(^|\/)generated(\/|\.))/iu;

export type PathClass = 'test' | 'prod' | 'exempt';

/**
 * Classify a repo-relative path as `test` | `prod` | `exempt`.
 *
 * Production is defined by EXCLUSION (matching the qa14 classifier), NOT by a
 * root allowlist. Order matters: exempt is checked first (a generated/JSON/docs
 * file is never prod), then test (a `*.test.ts` under `src/` is a test, not
 * prod). Anything that is neither exempt nor test is `prod` — so any code tree
 * (`super-mcp/`, `packages/<pkg>/src`, `meeting-bot-worker/`, `web-companion/`,
 * `factory/`, top-level `scripts/`, `src/`, …) is policed by default, and a
 * new surface is covered the day it lands rather than waiting for an allowlist
 * edit that will inevitably drift.
 */
export function classifyPath(rawPath: string): PathClass {
  const p = rawPath.replace(/\\/g, '/');
  if (EXEMPT_RE.test(p)) return 'exempt';
  const basename = p.slice(p.lastIndexOf('/') + 1);
  if (TEST_DIR_RE.test(p) || TEST_BASENAME_RE.test(basename)) return 'test';
  return 'prod';
}

// ---------------------------------------------------------------------------
// numstat parsing — pure, exported for testing
// ---------------------------------------------------------------------------

export interface NumstatRow {
  /** Added line count (git `-` for binary becomes null). */
  readonly added: number | null;
  /** Repo-relative path (post-image; forward slashes). */
  readonly path: string;
}

/**
 * Parse `git ... --numstat` output (`<added>\t<deleted>\t<path>` per line)
 * into rows. Binary files (`-\t-\tpath`) yield `added: null`. Tolerates CRLF
 * and rename arrows (`old => new`) by keeping the raw post-image path token;
 * we run git with `--no-renames` so a rename surfaces as add+delete, which is
 * the conservative choice for an absence gate (a renamed prod file with no
 * test still reads as prod-LOC, as it should).
 */
export function parseNumstat(text: string): readonly NumstatRow[] {
  const rows: NumstatRow[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/\r$/, '').trim();
    if (line.length === 0) continue;
    const parts = line.split('\t');
    if (parts.length < 3) continue;
    const [addedRaw, , ...pathParts] = parts;
    const filePath = pathParts.join('\t').replace(/\\/g, '/');
    const added = addedRaw === '-' ? null : Number.parseInt(addedRaw, 10);
    rows.push({ added: Number.isNaN(added as number) ? null : added, path: filePath });
  }
  return rows;
}

export interface CoverageDelta {
  readonly prodLoc: number;
  readonly testLoc: number;
  readonly exemptLoc: number;
  readonly prodFiles: readonly string[];
  readonly testFiles: readonly string[];
}

/** Sum added LOC per class from numstat rows. */
export function computeDelta(rows: readonly NumstatRow[]): CoverageDelta {
  let prodLoc = 0;
  let testLoc = 0;
  let exemptLoc = 0;
  const prodFiles: string[] = [];
  const testFiles: string[] = [];
  for (const row of rows) {
    if (row.added === null) continue; // binary
    switch (classifyPath(row.path)) {
      case 'prod':
        prodLoc += row.added;
        if (row.added > 0) prodFiles.push(row.path);
        break;
      case 'test':
        testLoc += row.added;
        if (row.added > 0) testFiles.push(row.path);
        break;
      case 'exempt':
        exemptLoc += row.added;
        break;
    }
  }
  return { prodLoc, testLoc, exemptLoc, prodFiles, testFiles };
}

/** A flagged commit/range: enough prod-LOC, zero test-LOC. */
export function isFlagged(delta: CoverageDelta, threshold: number): boolean {
  return delta.prodLoc >= threshold && delta.testLoc === 0;
}

// ---------------------------------------------------------------------------
// Ack-token detection — pure, exported for testing
// ---------------------------------------------------------------------------

export interface AckVerdict {
  readonly acked: boolean;
  /** Why an ack token was rejected (present but weak/short), for messaging. */
  readonly rejectedReason?: string;
}

/**
 * Detect a valid `[no-test-needed: <reason>]` ack in `text`. The reason must
 * be >= MIN_ACK_REASON_LENGTH chars and free of weak markers, mirroring
 * check-cross-surface-parity-gap.ts's exemption-rationale discipline so the
 * ack documents intent rather than rubber-stamping the gate away.
 */
export function evaluateAck(text: string): AckVerdict {
  // Capture everything up to the matching close bracket (reasons can't nest brackets).
  const match = /\[no-test-needed:\s*([^\]]*)\]/iu.exec(text);
  if (match === null) return { acked: false };
  const reason = match[1].trim();
  if (reason.length < MIN_ACK_REASON_LENGTH) {
    return {
      acked: false,
      rejectedReason: `ack reason is ${reason.length} chars; minimum ${MIN_ACK_REASON_LENGTH} required — state the concrete reason this change needs no test (pure refactor covered by existing suite, generated file, config-only, etc.)`,
    };
  }
  for (const { pattern, label } of WEAK_ACK_PATTERNS) {
    if (pattern.test(reason)) {
      return {
        acked: false,
        rejectedReason: `ack reason contains weak marker "${label}" — explain the actual reason a test is unnecessary, not a deferral`,
      };
    }
  }
  return { acked: true };
}

// ---------------------------------------------------------------------------
// Context resolution (CI PR / CI push / local) — mirrors check-r1-r2-overlap.ts
// ---------------------------------------------------------------------------

interface DiffContext {
  readonly refSpec: string;
  readonly ackSource: 'pr-title' | 'commit-subjects' | 'none';
  readonly ackText: string;
  /** numstat text, or null if the git invocation failed. */
  readonly numstatText: string | null;
}

function runGitNumstat(repoRoot: string, refSpec: string): string | null {
  try {
    // `--no-renames` so an extract/rename surfaces as add+delete (conservative
    // for an absence gate). Diff range form `base...HEAD` so we measure the
    // branch's own changes vs the merge-base, not dev work merged in.
    return gitCapture(['diff', refSpec, '--numstat', '--no-renames', '--no-color'], {
      cwd: repoRoot,
    });
  } catch (err) {
    console.error(`[test-coverage-delta] ERROR: \`git diff ${refSpec}\` failed: ${(err as Error).message}`);
    return null;
  }
}

function readCommitMessagesInRange(repoRoot: string, refSpec: string): string {
  try {
    // %B = full message (subject + body) so an ack token in the body counts.
    return gitCapture(['log', '--format=%B', refSpec], { cwd: repoRoot });
  } catch {
    return '';
  }
}

function resolveContext(repoRoot: string): DiffContext {
  // CI PR mode: read PR base SHA + title from the GitHub event payload.
  const eventPath = process.env.GITHUB_EVENT_PATH;
  const eventName = process.env.GITHUB_EVENT_NAME;
  if (eventPath !== undefined && eventName === 'pull_request' && fs.existsSync(eventPath)) {
    try {
      const event = JSON.parse(fs.readFileSync(eventPath, 'utf8')) as {
        pull_request?: { title?: string; base?: { sha?: string }; head?: { sha?: string } };
      };
      const baseSha = event.pull_request?.base?.sha;
      const headSha = event.pull_request?.head?.sha ?? 'HEAD';
      const title = event.pull_request?.title ?? '';
      if (typeof baseSha === 'string' && baseSha.length > 0) {
        const refSpec = `${baseSha}...${headSha}`;
        // Ack can be in the PR title OR any commit message in the range.
        const ackText = `${title}\n${readCommitMessagesInRange(repoRoot, refSpec)}`;
        return { refSpec, ackSource: 'pr-title', ackText, numstatText: runGitNumstat(repoRoot, refSpec) };
      }
    } catch (err) {
      console.warn(`[test-coverage-delta] WARN: failed to parse GITHUB_EVENT_PATH (${(err as Error).message}); falling through to default mode`);
    }
  }

  // Default (local dev / CI push): merge-base(origin/dev, HEAD)..HEAD.
  let refSpec: string;
  try {
    // git-exec-allow: merge-base lookup is one SHA and preserves fallback behavior
    const mergeBase = execSync('git merge-base origin/dev HEAD', {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    refSpec = `${mergeBase}...HEAD`;
  } catch {
    refSpec = 'HEAD~1...HEAD';
  }
  return {
    refSpec,
    ackSource: 'commit-subjects',
    ackText: readCommitMessagesInRange(repoRoot, refSpec),
    numstatText: runGitNumstat(repoRoot, refSpec),
  };
}

// ---------------------------------------------------------------------------
// CLI runner — skipped under Vitest / when imported
// ---------------------------------------------------------------------------

function isEnforcing(argv: readonly string[]): boolean {
  if (argv.includes('--enforce')) return true;
  const env = process.env[ENV_ENFORCE];
  return env !== undefined && env !== '' && env !== '0' && env.toLowerCase() !== 'false';
}

function main(argv: readonly string[]): void {
  const repoRoot = path.resolve(__dirname, '..');
  const enforce = isEnforcing(argv);
  const mode = enforce ? 'ENFORCE (blocking)' : 'WARN (advisory, non-blocking)';

  console.log('[test-coverage-delta] zero-test-introducing-commit gate (qa14 class)');
  console.log(`[test-coverage-delta] Mode: ${mode}; threshold: ${PROD_LOC_THRESHOLD} added prod-LOC`);

  const ctx = resolveContext(repoRoot);
  console.log(`[test-coverage-delta] Ref: ${ctx.refSpec} (ack source: ${ctx.ackSource})`);

  if (ctx.numstatText === null) {
    // Could not compute the diff. Fail closed only in enforce mode.
    const lines = [
      '',
      '[test-coverage-delta] `git diff` failed — cannot evaluate test-coverage delta.',
      '  Likely: shallow clone or missing base ref (origin/dev / PR base SHA not in local history).',
      '  Remediation: `git fetch origin dev` (locally) or `actions/checkout` with fetch-depth: 0 (CI).',
      '',
    ];
    if (enforce) {
      console.error(lines.join('\n'));
      process.exit(1);
    }
    console.warn(lines.join('\n'));
    console.warn('[test-coverage-delta] WARN mode — not failing the build on an un-computable diff.');
    return;
  }

  if (ctx.numstatText.trim() === '') {
    console.log('[test-coverage-delta] No diff detected. OK.');
    return;
  }

  const rows = parseNumstat(ctx.numstatText);
  const delta = computeDelta(rows);
  console.log(
    `[test-coverage-delta] Added LOC — prod: ${delta.prodLoc}, test: ${delta.testLoc}, exempt: ${delta.exemptLoc} ` +
    `(${delta.prodFiles.length} prod file(s), ${delta.testFiles.length} test file(s))`,
  );

  if (!isFlagged(delta, PROD_LOC_THRESHOLD)) {
    const why =
      delta.testLoc > 0
        ? `${delta.testLoc} test-LOC accompany the change`
        : `${delta.prodLoc} added prod-LOC is below the ${PROD_LOC_THRESHOLD}-LOC threshold`;
    console.log(`[test-coverage-delta] OK — ${why}.`);
    return;
  }

  // Flagged: high prod-LOC, zero test-LOC. Check for a valid ack.
  const ack = evaluateAck(ctx.ackText);
  if (ack.acked) {
    console.log(
      `[test-coverage-delta] OK — ${ACK_TOKEN_PREFIX} …] ack present in ${ctx.ackSource}; author has documented why this change is test-free.`,
    );
    return;
  }

  // No valid ack — emit the warning/failure.
  const header =
    `${delta.prodLoc} added prod-LOC with ZERO test-LOC (threshold ${PROD_LOC_THRESHOLD}) — ` +
    'this is the zero-test-introducing-commit class (qa14: 94 bugs).';
  const detail: string[] = [
    '',
    `  Production files changed (no accompanying test change):`,
    ...delta.prodFiles.slice(0, 12).map((f) => `    - ${f}`),
    ...(delta.prodFiles.length > 12 ? [`    … (+${delta.prodFiles.length - 12} more)`] : []),
    '',
    '  If this change genuinely needs no test (pure refactor covered by the',
    '  existing suite, generated file, config/wiring only), document it by adding',
    `  a commit-message token:  ${ACK_TOKEN_PREFIX} <reason >= ${MIN_ACK_REASON_LENGTH} chars> ]`,
    '  Otherwise: add or extend a test that exercises the changed production code.',
    '',
  ];
  if (ack.rejectedReason !== undefined) {
    detail.push(`  NOTE: an ack token was present but REJECTED — ${ack.rejectedReason}.`, '');
  }

  if (enforce) {
    console.error(`[test-coverage-delta] FAIL — ${header}`);
    console.error(detail.join('\n'));
    process.exit(1);
  }

  // WARN-ONLY soft-launch: advisory, does not fail the build (exit 0).
  console.warn(`[test-coverage-delta] ADVISORY (warn-only) — ${header}`);
  console.warn(detail.join('\n'));
  console.warn(
    `[test-coverage-delta] WARN mode — not failing. Set ${ENV_ENFORCE}=1 (or pass --enforce) to make this blocking.`,
  );
  // Intentionally exit 0 so validate:fast is not failed during the soft launch.
}

// Run only as the entry point (not when imported by tsx scripts or Vitest).
if (require.main === module) {
  main(process.argv.slice(2));
}
