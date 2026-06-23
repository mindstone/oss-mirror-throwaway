#!/usr/bin/env npx tsx
/**
 * CI Validation: Newly-added/modified postmortems are parseable.
 *
 * Detects postmortem files added or modified in the current outgoing push
 * (committed-but-unpushed vs `@{upstream}`) and verifies each one ends with
 * a single parseable `[BUG-POSTMORTEM] {...}` JSON line containing a non-empty
 * `bug_id` field. This is the **minimum viable contract** that downstream
 * corpus aggregators (CHIEF_PATHOLOGIST analysis, validate_postmortem_corpus.py
 * in the coding-agent-instructions submodule) depend on.
 *
 * ## Why parse-only and not the full corpus validator?
 *
 * The full validator at `coding-agent-instructions/scripts/validate_postmortem_corpus.py`
 * also catches body/JSON field drift (severity, origin_type, review_miss),
 * `design_gap` paired with concrete commits, missing module paths, and
 * docs-only introducers for runtime bugs. Running it with `--fail-on-warn`
 * against the current corpus produces ~15 hits on accumulated debt that
 * nobody has signed up to remediate. Wiring those into pre-push would block
 * every push immediately — including by agents who never touched the
 * affected postmortem.
 *
 * The parse-only check is a strictly narrower contract that catches the
 * unambiguously-broken class (no [BUG-POSTMORTEM] line, malformed JSON,
 * missing bug_id) without dragging in the corpus debt. Body/JSON drift
 * remains a real issue but is best handled by a separate corpus-health
 * sweep, not a per-push gate.
 *
 * ## Detection scope
 *
 *   - Committed changes vs `@{upstream}` matching `--diff-filter=AM` and
 *     `docs-private/postmortems/*_postmortem.md`. Untracked / unstaged working-tree
 *     edits by concurrent agents are deliberately ignored — only what's
 *     about to be pushed gets validated.
 *
 * ## Soft-skip conditions (exit 0 silently)
 *
 *   - No upstream branch (fresh branch, detached HEAD, no remote).
 *   - No new/changed postmortems detected.
 *   - A file carrying the `<!-- not-a-postmortem ... -->` marker. Such a file
 *     lives in `docs/postmortems/` but is intentionally NOT a counted
 *     postmortem (e.g. a planning hallucination caught before shipping, a
 *     triage stub) — it has no shipped bug, so a `[BUG-POSTMORTEM]` line is not
 *     required of it. See CHIEF_PATHOLOGIST.md (`[BUG-POSTMORTEM]`-is-mandatory
 *     STOP note) for the convention.
 *
 * ## Hard-fail conditions (exit 1)
 *
 *   - Any new/changed postmortem has no parseable `[BUG-POSTMORTEM]` line.
 *   - The line's JSON does not parse, or lacks a non-empty `bug_id`.
 *   - Unexpected `git` failure once an upstream has been resolved (so the
 *     gate fails closed rather than silently no-op-ing on a broken checkout).
 *
 * Run: `npx tsx scripts/validate-new-postmortems.ts`
 * Wired into: `npm run validate:fast`
 *
 * Closes follow-up I6 from
 * `docs/plans/260430_eval_harness_recovery_and_anthropic_auth_fix.md`
 * (cluster-level prevention for the 260430_evals_s5b bug cluster).
 */

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { DEFAULT_GIT_MAXBUFFER } from './lib/git-exec.js';

const REPO_ROOT = path.resolve(__dirname, '..');
const POSTMORTEM_GLOB = "docs-private/postmortems/*_postmortem.md";
const LEGACY_POSTMORTEM_GLOB = path.posix.join('docs', 'postmortems', '*_postmortem.md');
const BUG_POSTMORTEM_RE = /^\[BUG-POSTMORTEM\]\s+(\{.+\})\s*$/m;
// A file containing this HTML-comment marker (case-insensitive, anywhere) is an
// intentional non-postmortem (e.g. a caught-pre-ship hallucination, a triage
// stub) and is exempt from the [BUG-POSTMORTEM]-line requirement.
const NOT_A_POSTMORTEM_RE = /<!--\s*not-a-postmortem/i;

function tryGitOutput(args: string[]): string | null {
  // Soft-skip variant: returns null on non-zero exit. Use only for commands
  // whose failure means "this gate doesn't apply" (e.g. no-upstream lookup).
  // git-exec-allow: postmortem soft-skip wrapper preserves status with shared buffer cap
  const result = spawnSync('git', args, {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
    maxBuffer: DEFAULT_GIT_MAXBUFFER,
  });
  if (result.status !== 0) return null;
  return result.stdout.trim();
}

function gitOutputOrThrow(args: string[]): string {
  // Hard-fail variant: throws on non-zero exit so unexpected git failures
  // surface instead of silently no-op'ing the gate.
  // git-exec-allow: postmortem hard-fail wrapper preserves stderr with shared buffer cap
  const result = spawnSync('git', args, {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
    maxBuffer: DEFAULT_GIT_MAXBUFFER,
  });
  if (result.status !== 0) {
    const stderr = result.stderr?.trim() ?? '';
    throw new Error(
      `git ${args.join(' ')} failed (exit=${result.status})` +
        (stderr ? `: ${stderr}` : '')
    );
  }
  return result.stdout.trim();
}

function detectChangedPostmortems(): string[] | 'no-upstream' {
  // Resolve upstream via merge-base (matches .husky/pre-push convention).
  // No-upstream is a legitimate soft-skip (fresh branch, detached HEAD,
  // shallow clones in some CI configurations).
  const mergeBase = tryGitOutput(['merge-base', 'HEAD', '@{upstream}']);
  if (!mergeBase) return 'no-upstream';

  // Once we have an upstream, any `git diff` failure is unexpected — let it
  // throw rather than silently masquerade as "nothing to validate".
  const range = `${mergeBase}..HEAD`;
  const out = gitOutputOrThrow([
    'diff',
    '--name-only',
    '--find-renames=50%',
    '-l0',
    '--diff-filter=AM',
    range,
    '--',
    POSTMORTEM_GLOB,
    LEGACY_POSTMORTEM_GLOB,
  ]);
  if (!out) return [];

  return out.split('\n').filter(Boolean);
}

interface ParseFailure {
  file: string;
  reason: 'no-bug-postmortem-line' | 'unparseable-json' | 'missing-bug-id' | 'read-error';
  detail?: string;
}

/**
 * Pure content check — given the file's text, return a ParseFailure or null.
 * Split out from disk I/O so the marker/parse contract is unit-testable
 * without a temp git repo. `read-error` is reported by the disk wrapper.
 */
export function checkPostmortemContent(
  filePath: string,
  text: string,
): ParseFailure | null {
  // Intentional non-postmortem: carries the `<!-- not-a-postmortem -->` marker.
  // It is NOT a counted postmortem (no shipped bug), so the [BUG-POSTMORTEM]
  // line is not required of it — skip it as an exempt file.
  if (NOT_A_POSTMORTEM_RE.test(text)) {
    return null;
  }
  const match = text.match(BUG_POSTMORTEM_RE);
  if (!match) {
    return { file: filePath, reason: 'no-bug-postmortem-line' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[1]);
  } catch (err) {
    return {
      file: filePath,
      reason: 'unparseable-json',
      detail: err instanceof Error ? err.message : String(err),
    };
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof (parsed as { bug_id?: unknown }).bug_id !== 'string' ||
    (parsed as { bug_id: string }).bug_id.trim().length === 0
  ) {
    return { file: filePath, reason: 'missing-bug-id' };
  }
  return null;
}

function checkPostmortem(filePath: string): ParseFailure | null {
  const abs = path.join(REPO_ROOT, filePath);
  let text: string;
  try {
    text = fs.readFileSync(abs, 'utf-8');
  } catch (err) {
    return {
      file: filePath,
      reason: 'read-error',
      detail: err instanceof Error ? err.message : String(err),
    };
  }
  return checkPostmortemContent(filePath, text);
}

function main(): number {
  const changed = detectChangedPostmortems();
  if (changed === 'no-upstream' || changed.length === 0) {
    return 0; // silent success
  }

  const failures: ParseFailure[] = [];
  for (const f of changed) {
    const failure = checkPostmortem(f);
    if (failure) failures.push(failure);
  }

  if (failures.length === 0) {
    // No output on success; this script must stay quiet on no-op runs to
    // avoid noise in the validate:fast chain.
    return 0;
  }

  console.error(
    `\n[validate-new-postmortems] FAIL: ${failures.length} of ${changed.length} ` +
      `outgoing postmortem(s) failed parse-only validation:\n`
  );
  for (const fail of failures) {
    const detail = fail.detail ? ` (${fail.detail})` : '';
    console.error(`  - ${fail.file}: ${fail.reason}${detail}`);
  }
  console.error(
    `\nEvery postmortem MUST end with a line of the form:\n` +
      `  [BUG-POSTMORTEM] {"bug_id":"...","severity":"...",...}\n` +
      `where the JSON is parseable and bug_id is a non-empty string. ` +
      `Downstream corpus aggregators depend on this contract.\n` +
      `\nDon't hand-author the [BUG-*] lines — regenerate them correct-by-construction:\n` +
      `  npx tsx coding-agent-instructions/scripts/stamp_postmortem.py --doc <file> --from-doc\n` +
      `(append a <<<BUG_JUDGMENT {…} BUG_JUDGMENT>>> block to the doc first; the stamper validates\n` +
      `it against the vocab SSOT and writes the [BUG-*] lines). If the doc is intentionally NOT a\n` +
      `counted postmortem (e.g. a hallucination caught pre-ship), add a top-of-file\n` +
      `'<!-- not-a-postmortem: <reason> -->' marker and it will be exempt.\n`
  );
  return 1;
}

// Only run the gate when invoked as a script — guarded so the module can be
// imported by tests (which exercise checkPostmortemContent directly) without
// triggering the git diff + process.exit side effects.
if (import.meta.url === `file://${process.argv[1]}`) {
try {
  process.exit(main());
} catch (err) {
  console.error(
    `\n[validate-new-postmortems] FAIL (unexpected): ${err instanceof Error ? err.message : String(err)}`
  );
  process.exit(1);
}
}
