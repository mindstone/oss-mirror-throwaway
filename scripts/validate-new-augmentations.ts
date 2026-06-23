#!/usr/bin/env npx tsx
/**
 * CI Validation: Newly-added/modified postmortems carry consistent
 * `[BUG-POSTMORTEM-AUGMENT]` lines.
 *
 * Sibling of `validate-new-postmortems.ts` (which is parse-only over the
 * `[BUG-POSTMORTEM]` line). This gate covers the *augment* layer: when an
 * outgoing (committed-but-unpushed) postmortem carries a
 * `[BUG-POSTMORTEM-AUGMENT]` line, it must pass the augment validator's
 * **error** checks — chiefly the `surfaces_count` derived-from-list invariant.
 *
 * ## Why this exists
 *
 * The `260531_correct_surfaces_count_in_251224_diagnostics_03a6ccd` postmortem
 * documented a bug where an augment line stored `surfaces_count: 1` while
 * `contract_surfaces_crossed` listed two surfaces — a denormalized count that
 * silently drifted from its canonical list and poisoned the qa11 distribution.
 * The augment validator now treats `surfaces_count` as DERIVED data, but
 * `validate_augmentations.py` was wired into no hook or CI, so a malformed
 * augment backfill could still land silently. This gate closes that loop:
 * recommendation `d28ae9fac6fb4c2f` (ci_check, high) and the writer/validator
 * hardening for `61cf250383c9b85c` (type_constraint, high), both from that
 * postmortem.
 *
 * ## Error-only mode (not strict)
 *
 * We run the validator in `--mode errors`, which fails on *errors*
 * (surfaces_count drift, type errors, vocab-list element errors) but tolerates
 * open-schema vocab *warnings* (an unrecognized-but-plausible tag). Strict mode
 * would red the gate on common, non-blocking augment-vocab noise — exactly the
 * pre-existing-debt trap `validate-new-postmortems.ts` documents for the corpus
 * validator. Error-only is the narrow, unambiguously-broken class.
 *
 * ## Detection scope
 *
 *   - Committed changes vs `@{upstream}` matching `--diff-filter=AM` and
 *     `docs-private/postmortems/*_postmortem.md` (+ legacy `docs/postmortems/`).
 *     Untracked / unstaged working-tree edits by concurrent agents are ignored —
 *     only what is about to be pushed gets validated.
 *
 * ## Multiple augment lines per file
 *
 * Bundled postmortems carry one `[BUG-POSTMORTEM-AUGMENT]` line per sub-bug, so
 * this gate enumerates EVERY augment line in each changed file (not just the
 * first) and validates each one's `bug_id`.
 *
 * ## Soft-skip conditions (exit 0 silently)
 *
 *   - No upstream branch (fresh branch, detached HEAD, no remote).
 *   - No new/changed postmortems detected.
 *   - A changed postmortem has no `[BUG-POSTMORTEM-AUGMENT]` line (the augment
 *     layer is optional; the `[BUG-POSTMORTEM]` line is the mandatory contract
 *     and is gated separately by `validate-new-postmortems.ts`).
 *   - `python3` is unavailable (the augment validator is Python; degrade to a
 *     loud-but-non-blocking skip rather than failing the whole gate on a
 *     toolchain gap — the same posture as other optional Python checks).
 *
 * ## Hard-fail conditions (exit 1)
 *
 *   - A changed postmortem has a `[BUG-POSTMORTEM-AUGMENT]` line whose JSON is
 *     unparseable or whose `bug_id` is missing/empty. "Malformed augment lines
 *     can't land silently" is the whole point (recommendation `d28ae9fac6fb4c2f`)
 *     — the Python corpus reader silently skips such lines, so this gate must
 *     fail-closed on them rather than treat them as "nothing to validate".
 *   - The augment validator reports one or more *errors* for a changed
 *     postmortem's `bug_id`, OR scans zero records for an extracted `bug_id`
 *     (a present-on-disk augment line the validator couldn't see → likely a
 *     postmortems-dir resolution mismatch; fail closed rather than false-pass).
 *   - Unexpected `git` failure once an upstream has been resolved (fail closed
 *     rather than silently no-op on a broken checkout).
 *
 * Run: `npx tsx scripts/validate-new-augmentations.ts`
 * Wired into: `npm run validate:fast`
 */

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { DEFAULT_GIT_MAXBUFFER } from './lib/git-exec.js';

const REPO_ROOT = path.resolve(__dirname, '..');
const POSTMORTEM_GLOB = 'docs-private/postmortems/*_postmortem.md';
const LEGACY_POSTMORTEM_GLOB = path.posix.join('docs', 'postmortems', '*_postmortem.md');
// Match the marker plus the REST of the line (not a `{.+}` shape) so a payload
// missing its closing brace — or otherwise non-JSON — is still detected and
// flagged as malformed rather than silently slipping past the gate. The
// inter-token gap is `[ \t]*` (NOT `\s*`) so it can't consume the newline and
// swallow the *next* line's content as this marker's payload — a marker line
// with nothing after it must read as an empty (malformed) payload.
const AUGMENT_RE = /^\[BUG-POSTMORTEM-AUGMENT\][ \t]*(.*)$/gm;
const VALIDATOR = path.join(
  'coding-agent-instructions',
  'scripts',
  'validate_augmentations.py'
);

function tryGitOutput(args: string[]): string | null {
  // git-exec-allow: augment soft-skip wrapper preserves status with shared buffer cap
  const result = spawnSync('git', args, {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
    maxBuffer: DEFAULT_GIT_MAXBUFFER,
  });
  if (result.status !== 0) return null;
  return result.stdout.trim();
}

function gitOutputOrThrow(args: string[]): string {
  // git-exec-allow: augment hard-fail wrapper preserves stderr with shared buffer cap
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
  const mergeBase = tryGitOutput(['merge-base', 'HEAD', '@{upstream}']);
  if (!mergeBase) return 'no-upstream';

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

export interface AugmentLineResult {
  /** Extracted, trimmed bug_ids for every well-formed augment line. */
  bugIds: string[];
  /**
   * One message per malformed augment line (unparseable JSON or missing/empty
   * bug_id). Non-empty means the file must FAIL — "malformed augment lines
   * can't land silently" is recommendation d28ae9fac6fb4c2f.
   */
  malformed: string[];
}

/**
 * Enumerate every `[BUG-POSTMORTEM-AUGMENT]` line in a postmortem's text and
 * classify each as a well-formed bug_id or a malformed line. Bundled
 * postmortems have one augment line per sub-bug, so all are returned.
 *
 * A line is malformed if its JSON is unparseable or it lacks a non-empty
 * `bug_id`. The Python corpus reader silently skips such lines, so this gate
 * must surface them rather than treat them as "nothing to validate".
 *
 * Exported for unit testing without disk/git side effects.
 */
export function extractAugmentLines(text: string): AugmentLineResult {
  const bugIds: string[] = [];
  const malformed: string[] = [];
  AUGMENT_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = AUGMENT_RE.exec(text)) !== null) {
    const raw = match[1];
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      malformed.push(
        `unparseable JSON: ${err instanceof Error ? err.message : String(err)}`
      );
      continue;
    }
    const bugId = (parsed as { bug_id?: unknown }).bug_id;
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      typeof bugId !== 'string' ||
      bugId.trim().length === 0
    ) {
      malformed.push('augment line missing a non-empty bug_id');
      continue;
    }
    bugIds.push(bugId.trim());
  }
  return { bugIds, malformed };
}

function pythonAvailable(): boolean {
  const result = spawnSync('python3', ['--version'], {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
  });
  return result.status === 0;
}

/**
 * Probe that the augment validator's Python dependency chain actually imports.
 *
 * `python3 --version` only proves the interpreter exists. The validator does its
 * top-level imports (`chief_pathologist_v2.*` plus their transitive deps such as
 * polars / scipy / pyyaml) at module load, BEFORE argparse runs — so on a
 * present-but-incomplete Python env (interpreter without the libs) it used to
 * hard-crash with a ModuleNotFoundError that this gate surfaced as a *blocking*
 * FAIL, breaking pushes on any machine missing the deps (the documented
 * production-release pain). Running the validator with `--help` exercises that
 * exact import chain — imports run before argparse short-circuits — without doing
 * any validation work: exit 0 == imports OK; non-zero == a missing dependency we
 * can name and degrade around (loud-but-non-blocking, mirroring the missing-
 * `python3` path; CI, which has the full env, still runs the validator for real).
 */
function augmentValidatorImportsReady(): { ok: boolean; missing?: string } {
  const probe = spawnSync('python3', [VALIDATOR, '--help'], {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
  });
  if (probe.status === 0) return { ok: true };
  const out = `${probe.stdout ?? ''}${probe.stderr ?? ''}`;
  const match = out.match(/No module named '([^']+)'/);
  return {
    ok: false,
    missing: match ? match[1] : out.trim().split('\n').pop() || undefined,
  };
}

interface AugmentFailure {
  file: string;
  bugId: string;
  detail: string;
}

const RECORDS_SCANNED_RE = /^Records scanned:\s*(\d+)/m;

function validateAugment(file: string, bugId: string): AugmentFailure | null {
  const result = spawnSync(
    'python3',
    [VALIDATOR, '--only', bugId, '--mode', 'errors'],
    { cwd: REPO_ROOT, encoding: 'utf-8' }
  );
  const out = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
  // Exit 1 = validation errors. Any other non-zero (e.g. import error) is
  // unexpected — surface it. Exit 0 = no errors, BUT the validator also exits 0
  // when it scanned ZERO records: `--only <bug_id>` matching nothing is not a
  // pass, it's a "couldn't see this augment line" (usually a postmortems-dir
  // resolution mismatch). The line is present on disk — fail closed.
  if (result.status !== 0) {
    return { file, bugId, detail: out || `validator exited ${result.status}` };
  }
  const scannedMatch = out.match(RECORDS_SCANNED_RE);
  const scanned = scannedMatch ? Number(scannedMatch[1]) : 0;
  if (scanned < 1) {
    return {
      file,
      bugId,
      detail:
        `augment validator scanned 0 records for bug_id=${bugId} though the ` +
        `line is present in ${file} — likely a postmortems-dir resolution ` +
        `mismatch. Validator output:\n${out}`,
    };
  }
  return null;
}

function main(): number {
  const changed = detectChangedPostmortems();
  if (changed === 'no-upstream' || changed.length === 0) {
    return 0; // silent success
  }

  if (!pythonAvailable()) {
    // Loud-but-non-blocking: the augment validator is Python. Don't fail the
    // whole pre-push gate on a missing interpreter, but don't pretend success.
    console.warn(
      '[validate-new-augmentations] SKIP: python3 not available — augment ' +
        'lines NOT validated for this push. Install python3 to enable.'
    );
    return 0;
  }

  const importsReady = augmentValidatorImportsReady();
  if (!importsReady.ok) {
    // python3 is present but the validator's dependency chain can't import.
    // Degrade the same way as a missing interpreter: loud, non-blocking, named.
    // (Previously this hard-crashed and failed the whole push — the documented
    // production-release pain.) CI runs with the full env and still validates.
    console.warn(
      '[validate-new-augmentations] SKIP: python3 is present but the augment ' +
        'validator’s dependencies are not importable' +
        (importsReady.missing ? ` (missing: ${importsReady.missing})` : '') +
        '. Augment lines NOT validated for this push. Install the validator’s ' +
        'Python deps (e.g. polars, scipy, pyyaml) to enable. CI still validates.'
    );
    return 0;
  }

  const failures: AugmentFailure[] = [];
  for (const file of changed) {
    const abs = path.join(REPO_ROOT, file);
    let text: string;
    try {
      text = fs.readFileSync(abs, 'utf-8');
    } catch {
      // File listed as AM but unreadable now (e.g. concurrent rename). Skip —
      // validate-new-postmortems owns the existence contract.
      continue;
    }
    const { bugIds, malformed } = extractAugmentLines(text);
    // A malformed augment line (bad JSON / no bug_id) is itself a failure —
    // the Python reader would silently drop it, defeating the gate's purpose.
    for (const reason of malformed) {
      failures.push({ file, bugId: '(unparseable)', detail: reason });
    }
    // Validate every well-formed augment line (bundled postmortems have one
    // per sub-bug).
    for (const bugId of bugIds) {
      const failure = validateAugment(file, bugId);
      if (failure) failures.push(failure);
    }
  }

  if (failures.length === 0) {
    return 0; // quiet on no-op
  }

  console.error(
    `\n[validate-new-augmentations] FAIL: ${failures.length} outgoing ` +
      `postmortem augment line(s) failed validation:\n`
  );
  for (const fail of failures) {
    console.error(`  - ${fail.file} (${fail.bugId}):`);
    for (const line of fail.detail.split('\n')) {
      console.error(`      ${line}`);
    }
  }
  console.error(
    `\nThe [BUG-POSTMORTEM-AUGMENT] layer enforces derived-field invariants ` +
      `(chiefly: surfaces_count MUST equal the canonical length of ` +
      `contract_surfaces_crossed). Don't hand-edit the count — re-emit the ` +
      `augment line via the stamper/apply path so it derives correctly:\n` +
      `  python3 coding-agent-instructions/scripts/apply_augmentations.py ...\n` +
      `or run the validator locally to see the full error list:\n` +
      `  python3 ${VALIDATOR} --mode errors -v\n`
  );
  return 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    process.exit(main());
  } catch (err) {
    console.error(
      `\n[validate-new-augmentations] FAIL (unexpected): ${
        err instanceof Error ? err.message : String(err)
      }`
    );
    process.exit(1);
  }
}
