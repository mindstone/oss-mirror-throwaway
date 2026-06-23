#!/usr/bin/env npx tsx
/**
 * CI tripwire: R1 ↔ R2 file-overlap detector
 *
 * Two parallel refactor tracks (R1: `turnAdmission` extraction from
 * `agentTurnExecutor.ts`; R2: `agentEventManifest` contract module under
 * `src/shared/contracts/*`) ship Stage 2 concurrently in 2026-04. Their
 * file scopes are mostly disjoint, but a small set of "high-contention"
 * files are touched by BOTH plans (or by-shape conflict-prone). Editing
 * any of these without coordinating risks merge conflicts at best,
 * silent semantic regressions at worst (e.g., R1 adding a turnPhase log
 * line + R2 adding a sanitization rule that drops it).
 *
 * This script is the Class-of-problem-elimination defence (parent plan
 * § C6 mechanical tripwire — `docs/plans/260427_refactor_contract_manifest.md`):
 *
 *   1. Watchlist of high-contention paths (with optional line ranges for
 *      narrowly-scoped sections of larger files like cloud-service
 *      bootstrap).
 *   2. On every PR (and every `validate:fast`), inspect the diff between
 *      the merge base and HEAD.
 *   3. If any watchlist touch is present AND the PR title (or any commit
 *      subject in the range, locally) doesn't carry `[r1-r2-overlap-ack]`,
 *      FAIL exit code with a remediation message.
 *   4. Authors who legitimately need to touch a watchlist file ack the
 *      coordination by adding the token — this is documentation-of-intent,
 *      not a "bad" marker. The ack signals: "I have read the parallel
 *      plan's § A file-scope and confirmed this edit doesn't introduce a
 *      conflict."
 *
 * Wired into: `npm run validate:fast` and standalone
 * `npm run validate:r1-r2-overlap`.
 *
 * **Important**: this tripwire is intentionally crude. False-positive
 * tolerance is high (an author can ack at zero cost); false-negative
 * cost is high (silent merge conflict between two parallel agents). The
 * watchlist is therefore broader than strictly necessary.
 *
 * @see docs/plans/260427_refactor_contract_manifest.md (R2 Stage 2 sub-plan)
 * @see docs/plans/260429_r2_stage2_chunked_implementation_plan.md (chunk S2-PRE-A)
 * @see docs/plans/260429_r1_stage2_turnadmission_extraction_plan.md (R1 Stage 2)
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { gitCapture } from './lib/git-exec.js';

// ---------------------------------------------------------------------------
// Watchlist
// ---------------------------------------------------------------------------

export interface WatchlistEntry {
  /** Repo-relative path (forward slashes on all platforms). */
  readonly path: string;
  /**
   * Inclusive 1-based line range to narrow the watchlist to a section of a
   * larger file. If omitted, ANY touch on the file fires. Bounds are
   * applied to the *new file* line numbers in the diff (the +Z,W side of
   * `@@ -X,Y +Z,W @@` headers).
   */
  readonly lineRange?: readonly [number, number];
  /** One-line human-readable reason this file is on the list. */
  readonly reason: string;
}

export const WATCHLIST: readonly WatchlistEntry[] = [
  {
    path: 'src/shared/utils/eventCompaction.ts',
    reason:
      'R2 derives COMPACTION_POLICY from manifest; R1 may add turnPhase entries that affect compaction; coordinate before edit.',
  },
  {
    path: 'src/shared/utils/eventSanitization.ts',
    reason:
      'R2 derives SANITIZATION_POLICY from manifest; R1 may add turnPhase entries that affect sanitization; coordinate before edit.',
  },
  {
    path: 'cloud-service/src/bootstrap.ts',
    lineRange: [589, 650],
    reason:
      'R2 cloud-service handler-registration block (parent plan § C8 closure); R1 admission-phase wires parallel handlers in the same surface. Refreshed 2026-05-02 at R2 Stage 3a-PRE: outer setUserQuestionAnsweredPersister registration block now closes at line 650 (Stage-7 persister added at 260420 grew the block by ~28 lines).',
  },
  {
    path: 'src/main/services/__tests__/turnPipelineReplay.canonicalizer.ts',
    reason:
      "R2 S2-G instrumentation may need fixture-canonicalizer hooks; R1's admission-phase fixture regen edits the canonicalizer too. Concurrent edits = conflict.",
  },
];

/** Token in PR title or commit subject that bypasses the tripwire. */
export const ACK_TOKEN = '[r1-r2-overlap-ack]';

/** Env var override that bypasses the tripwire (for emergency local dev). */
const ENV_OVERRIDE = 'R1_R2_OVERLAP_ACK';

// ---------------------------------------------------------------------------
// Diff parsing — pure functions, exported for testing
// ---------------------------------------------------------------------------

export interface DiffHunk {
  /** Old-file starting line (1-based, inclusive). */
  readonly oldStart: number;
  /** Old-file line count for this hunk (0 = pure addition). */
  readonly oldCount: number;
  /** New-file starting line (1-based, inclusive). */
  readonly newStart: number;
  /** New-file line count for this hunk (0 = pure deletion). */
  readonly newCount: number;
}

export interface FileDiff {
  /** Repo-relative path (forward slashes). */
  readonly path: string;
  /** Hunks parsed from `@@` headers. */
  readonly hunks: readonly DiffHunk[];
  /**
   * True if the file was deleted in this diff (`+++ /dev/null`).
   * For line-ranged watchlist entries, deletion is an automatic match
   * (the file no longer exists, so any guarded line range is gone).
   */
  readonly deleted: boolean;
}

/**
 * Parse a unified-diff string (output of `git diff ... -U0 --no-color`)
 * into per-file hunk lists. Tolerates renames, mode changes, binary
 * markers, and pathological cases (CRLF line endings, deletion-only
 * hunks, full-file deletions).
 *
 * Format expected (simplified):
 *   diff --git a/path b/path
 *   --- a/path
 *   +++ b/path  (or `+++ /dev/null` for deletion)
 *   @@ -X,Y +Z,W @@ context
 *   ...
 *
 * Lines without explicit Y or W default to 1 (per unified-diff spec).
 *
 * Splits on `/\r?\n/` to tolerate CRLF (Windows fixtures, future cross-
 * platform CI).
 */
export function parseDiff(diffText: string): readonly FileDiff[] {
  const files: { path: string; hunks: DiffHunk[]; deleted: boolean }[] = [];
  let currentEntry: { path: string; hunks: DiffHunk[]; deleted: boolean } | null = null;

  const flush = (): void => {
    if (currentEntry !== null) {
      files.push(currentEntry);
    }
  };

  // Split on CRLF or LF. Strip any trailing \r that survives (defensive).
  const lines = diffText.split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, '');

    // `diff --git a/<path> b/<path>` — start of a new file block
    const fileMatch = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
    if (fileMatch !== null) {
      flush();
      // Use the b/ path (post-image), normalised to forward slashes
      currentEntry = {
        path: fileMatch[2].replace(/\\/g, '/'),
        hunks: [],
        deleted: false,
      };
      continue;
    }

    // `+++ /dev/null` — file deletion marker
    if (currentEntry !== null && line === '+++ /dev/null') {
      currentEntry.deleted = true;
      continue;
    }

    // `@@ -X[,Y] +Z[,W] @@` — hunk header
    const hunkMatch = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunkMatch !== null && currentEntry !== null) {
      const oldStart = Number.parseInt(hunkMatch[1], 10);
      const oldCount = hunkMatch[2] !== undefined ? Number.parseInt(hunkMatch[2], 10) : 1;
      const newStart = Number.parseInt(hunkMatch[3], 10);
      const newCount = hunkMatch[4] !== undefined ? Number.parseInt(hunkMatch[4], 10) : 1;
      currentEntry.hunks.push({ oldStart, oldCount, newStart, newCount });
    }
  }

  flush();
  return files;
}

/**
 * Compute hunk's effective overlap range on a given side (old or new file).
 *
 * Empty-side hunks (count === 0) are treated as "anchored at start, span 1
 * line" so they still register as a touch point on that side. The git
 * convention for pure additions is `-X,0 +Y,M` (old anchor X — the line
 * before insertion); for pure deletions, `-X,M +Y,0`. Treating the
 * empty side's anchor as a 1-line touch correctly registers either case.
 */
function hunkRange(hunk: DiffHunk, side: 'old' | 'new'): readonly [number, number] {
  const start = side === 'old' ? hunk.oldStart : hunk.newStart;
  const count = side === 'old' ? hunk.oldCount : hunk.newCount;
  if (count === 0) return [start, start];
  return [start, start + count - 1];
}

function rangesOverlap(a: readonly [number, number], b: readonly [number, number]): boolean {
  return a[0] <= b[1] && b[0] <= a[1];
}

/**
 * For watchlist entries WITH `lineRange`, returns true iff any hunk
 * overlaps the range on EITHER the old-file side or the new-file side.
 * Old-side coverage catches deletions inside the guarded range
 * (Gemini-3.1-pro reviewer MUST #3, 2026-04-29). New-side coverage
 * catches additions and modifications.
 *
 * For entries without lineRange, returns true iff the file appears in
 * the diff at all (even with zero hunks — handles mode-changes and
 * renames conservatively).
 *
 * For deleted files with line-ranged entries: automatic match. The file
 * no longer exists, so the guarded line range is by-definition gone.
 */
export function diffMatchesEntry(file: FileDiff, entry: WatchlistEntry): boolean {
  if (file.path !== entry.path) return false;
  if (entry.lineRange === undefined) return true;
  if (file.deleted) return true;
  for (const hunk of file.hunks) {
    if (rangesOverlap(hunkRange(hunk, 'old'), entry.lineRange)) return true;
    if (rangesOverlap(hunkRange(hunk, 'new'), entry.lineRange)) return true;
  }
  return false;
}

export interface WatchlistViolation {
  readonly entry: WatchlistEntry;
  readonly hunks: readonly DiffHunk[];
}

/** Compute violations: for each watchlist entry, the matching file's hunks. */
export function evaluateWatchlist(
  files: readonly FileDiff[],
  watchlist: readonly WatchlistEntry[],
): readonly WatchlistViolation[] {
  const violations: WatchlistViolation[] = [];
  for (const entry of watchlist) {
    const matchingFile = files.find((f) => diffMatchesEntry(f, entry));
    if (matchingFile !== undefined) {
      violations.push({ entry, hunks: matchingFile.hunks });
    }
  }
  return violations;
}

// ---------------------------------------------------------------------------
// Ack-flag detection — pure
// ---------------------------------------------------------------------------

/** Returns true if `text` contains the ack token (case-sensitive). */
export function hasAckToken(text: string): boolean {
  return text.includes(ACK_TOKEN);
}

// ---------------------------------------------------------------------------
// CI/local context resolution
// ---------------------------------------------------------------------------

interface DiffContext {
  /** Refs used: e.g., 'origin/dev...HEAD'. */
  readonly refSpec: string;
  /** Source of ack-flag truth: 'pr-title', 'commit-subjects', or 'env-override'. */
  readonly ackSource: 'pr-title' | 'commit-subjects' | 'env-override' | 'none';
  /** The title or concatenated commit subjects (or empty string for env-override/none). */
  readonly ackText: string;
  /**
   * Full diff text on success; null if `git diff` itself failed (e.g.,
   * shallow clone, missing ref). main() fails closed when null.
   */
  readonly diffText: string | null;
}

/**
 * Resolve diff context based on environment.
 *
 * - In CI on a PR (GITHUB_EVENT_PATH set, event is pull_request): use the
 *   PR's base/head refs and read PR title.
 * - In CI on push (no PR context): compare HEAD~1..HEAD; ack from commit
 *   subject. Returns 'none' for ackSource if not applicable.
 * - Locally: compare merge-base(origin/dev, HEAD)..HEAD; ack from any
 *   commit subject in the range.
 * - If env var R1_R2_OVERLAP_ACK is set (any non-empty value), bypass.
 */
function resolveContext(repoRoot: string): DiffContext {
  // Env-override bypass
  if (process.env[ENV_OVERRIDE] !== undefined && process.env[ENV_OVERRIDE] !== '') {
    return {
      refSpec: 'env-override (no diff inspected)',
      ackSource: 'env-override',
      ackText: '',
      diffText: '',
    };
  }

  // CI PR mode: GITHUB_EVENT_PATH points to event JSON with pull_request.title
  const eventPath = process.env.GITHUB_EVENT_PATH;
  const eventName = process.env.GITHUB_EVENT_NAME;
  if (eventPath !== undefined && eventName === 'pull_request' && fs.existsSync(eventPath)) {
    try {
      const eventRaw = fs.readFileSync(eventPath, 'utf8');
      const event = JSON.parse(eventRaw) as {
        pull_request?: {
          title?: string;
          base?: { sha?: string };
          head?: { sha?: string };
        };
      };
      const baseSha = event.pull_request?.base?.sha;
      const headSha = event.pull_request?.head?.sha ?? 'HEAD';
      const title = event.pull_request?.title ?? '';
      if (typeof baseSha === 'string' && baseSha.length > 0) {
        const refSpec = `${baseSha}...${headSha}`;
        const diffText = runGitDiff(repoRoot, refSpec);
        return { refSpec, ackSource: 'pr-title', ackText: title, diffText };
      }
    } catch (err) {
      console.warn(`[r1-r2-overlap] WARN: failed to parse GITHUB_EVENT_PATH (${(err as Error).message}); falling through to default mode`);
    }
  }

  // Default mode (local dev or CI push): compare merge-base(origin/dev, HEAD)..HEAD.
  // If origin/dev is unknown (e.g., shallow clone), fall back to HEAD~1..HEAD.
  let refSpec: string;
  try {
    // git-exec-allow: merge-base lookup is single SHA and preserves fallback behavior
    const mergeBase = execSync('git merge-base origin/dev HEAD', { cwd: repoRoot, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    refSpec = `${mergeBase}...HEAD`;
  } catch {
    // Fallback for environments without origin/dev
    refSpec = 'HEAD~1...HEAD';
  }
  const diffText = runGitDiff(repoRoot, refSpec);
  const ackText = readCommitSubjectsInRange(repoRoot, refSpec);
  return { refSpec, ackSource: 'commit-subjects', ackText, diffText };
}

function runGitDiff(repoRoot: string, refSpec: string): string | null {
  try {
    return gitCapture(['diff', refSpec, '-U0', '--no-color'], { cwd: repoRoot });
  } catch (err) {
    // FAIL CLOSED: do NOT swallow git errors. A shallow clone, a missing
    // base SHA, or a git invocation failure means we cannot evaluate the
    // tripwire. Return null and let main() exit non-zero with a clear
    // remediation message. (Reviewer-flagged silent-failure-as-bug —
    // gpt-5.5 MUST #1 + gemini-3.1-pro MUST #2 + completeness Gap #1,
    // 2026-04-29.)
    console.error(`[r1-r2-overlap] ERROR: \`git diff ${refSpec}\` failed: ${(err as Error).message}`);
    return null;
  }
}

function readCommitSubjectsInRange(repoRoot: string, refSpec: string): string {
  try {
    return gitCapture(['log', '--format=%s', refSpec], { cwd: repoRoot });
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// CLI runner — skipped under Vitest
// ---------------------------------------------------------------------------

function main(): void {
  const repoRoot = path.resolve(__dirname, '..');

  console.log('[r1-r2-overlap] R1 ↔ R2 file-overlap tripwire');
  console.log(`[r1-r2-overlap] Watchlist size: ${WATCHLIST.length}`);

  const ctx = resolveContext(repoRoot);
  console.log(`[r1-r2-overlap] Mode: ${ctx.ackSource}, ref: ${ctx.refSpec}`);

  if (ctx.ackSource === 'env-override') {
    console.log(`[r1-r2-overlap] Bypassed via ${ENV_OVERRIDE} env var. Exiting OK.`);
    return;
  }

  if (ctx.diffText === null) {
    // git diff itself failed — fail closed. Don't pretend the diff is empty.
    console.error('');
    console.error('[r1-r2-overlap] FAIL — `git diff` failed. Cannot evaluate R1↔R2 overlap.');
    console.error('');
    console.error('  Likely causes:');
    console.error('  - Shallow clone (CI without sufficient fetch depth)');
    console.error('  - Missing base ref (`origin/dev` or PR base SHA not in local history)');
    console.error('');
    console.error('  Remediation:');
    console.error('  - In CI: ensure `actions/checkout` uses `fetch-depth: 0` (or sufficient depth) and that base ref is fetched.');
    console.error(`  - Locally: \`git fetch origin dev\` then re-run, OR use \`${ENV_OVERRIDE}=1\` for emergency bypass.`);
    console.error('');
    process.exit(1);
  }

  if (ctx.diffText === '') {
    console.log('[r1-r2-overlap] No diff detected. Exiting OK.');
    return;
  }

  const files = parseDiff(ctx.diffText);
  const violations = evaluateWatchlist(files, WATCHLIST);

  if (violations.length === 0) {
    console.log(`[r1-r2-overlap] OK — diff covers ${files.length} file(s); zero watchlist matches.`);
    return;
  }

  console.log(
    `[r1-r2-overlap] Watchlist matches detected (${violations.length} of ${WATCHLIST.length} entries fired):`,
  );
  for (const v of violations) {
    const range = v.entry.lineRange !== undefined ? `:${v.entry.lineRange[0]}-${v.entry.lineRange[1]}` : '';
    console.log(`  - ${v.entry.path}${range}`);
    console.log(`      reason: ${v.entry.reason}`);
    if (v.hunks.length > 0) {
      const hunkSummary = v.hunks
        .slice(0, 5)
        .map((h) => `+${h.newStart},${h.newCount}`)
        .join(' ');
      const more = v.hunks.length > 5 ? ` (+${v.hunks.length - 5} more)` : '';
      console.log(`      hunks: ${hunkSummary}${more}`);
    }
  }

  if (hasAckToken(ctx.ackText)) {
    console.log(`[r1-r2-overlap] OK — ${ACK_TOKEN} present in ${ctx.ackSource}. Author has acknowledged R1↔R2 coordination.`);
    return;
  }

  console.error('');
  console.error(`[r1-r2-overlap] FAIL — watchlist matches present but ${ACK_TOKEN} absent.`);
  console.error('');
  console.error('  Remediation:');
  console.error(`  1. Confirm your edit is compatible with the parallel R${ctx.ackSource === 'pr-title' ? '1/R2' : '1↔R2'} plan:`);
  console.error('     - R1 Stage 2 plan: docs/plans/260429_r1_stage2_turnadmission_extraction_plan.md');
  console.error('     - R2 Stage 2 plan: docs/plans/260429_r2_stage2_chunked_implementation_plan.md');
  console.error(`  2. Add the token \`${ACK_TOKEN}\` to your PR title (or any commit subject in the range, locally).`);
  console.error(`  3. Or, if this is a one-off override on a non-conflicting edit, re-run with \`${ENV_OVERRIDE}=1\`.`);
  console.error('');
  process.exit(1);
}

// Run only when this file is the entry point (NOT when imported by another
// tsx script or under vitest). The `require.main === module` check is the
// canonical CJS pattern (tsx compiles to CJS by default in this repo).
if (require.main === module) {
  main();
}
