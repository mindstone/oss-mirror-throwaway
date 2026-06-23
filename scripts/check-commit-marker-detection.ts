#!/usr/bin/env npx tsx
/**
 * Anti-rot guard: commit-message marker detection must read the SUBJECT line only.
 *
 * The `[deploy-beta]` / `[skip-tests]` markers are intentional directives placed in
 * a commit SUBJECT (`<type>(scope): … [deploy-beta]`). They were historically matched
 * as a substring over the FULL commit message, so a prose MENTION of the token in a
 * commit BODY silently triggered the behaviour — a real footgun:
 *   - `.husky/pre-push`: a body mention made the hook skip tests / pick the wrong tier.
 *   - `.github/workflows/beta-deploy-trigger.yml`: a body mention could trigger a real
 *     beta DEPLOY (this one is the dangerous instance).
 * Fixed (260619) by reading the subject line only. This guard locks that in: the two
 * gating sites are EASY to "simplify" back to whole-message matching, and the failure
 * is near-invisible until it fires. A deliberate change to marker detection must update
 * this guard in the same commit (which forces a re-review of the footgun).
 *
 * Pure evaluators are exported for unit tests; `main()` reads the real files.
 * Companion: scripts/check-husky-pre-push-fast-tier.ts (VITEST_FAST invariant on the
 * same hook). Run via `npx tsx scripts/check-commit-marker-detection.ts`; batched into
 * `validate:fast` via scripts/groups/anti-rot-source-checks.ts.
 *
 * See docs/plans/260619_knip-prepush-parallel/PLAN.md (Stage 4) and
 * docs/project/DEAD_CODE_DETECTION_AND_REMOVAL.md is unrelated — the marker rationale
 * lives in the hook + workflow comments.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOOK_PATH = path.join(ROOT, '.husky', 'pre-push');
const WORKFLOW_PATH = path.join(ROOT, '.github', 'workflows', 'beta-deploy-trigger.yml');

export interface MarkerCheckResult {
  ok: boolean;
  errors: readonly string[];
}

const MARKER_ALT = '(?:deploy-beta|skip-tests)';

/**
 * `.husky/pre-push`: the shell variable switched on by the marker `case` statements
 * MUST be assigned from `git log … --pretty=%s` (subject), never `%B`/`%b` (the body).
 *
 * Strategy: collect every variable used in a non-comment
 * `case "$VAR" in *"[deploy-beta]"*` / `*"[skip-tests]"*` line, then for each, find its
 * `VAR=$(git log … --pretty=%X …)` assignment and require `X === 's'`.
 */
export function checkHookMarkerDetection(source: string): MarkerCheckResult {
  const errors: string[] = [];
  const lines = source.split('\n');

  const markerVars = new Set<string>();
  const caseRe = new RegExp(`case\\s+"\\$(\\w+)"\\s+in\\s+\\*"\\[${MARKER_ALT}\\]"\\*`);
  for (const raw of lines) {
    const line = raw.trimStart();
    if (line.startsWith('#')) continue;
    const m = line.match(caseRe);
    if (m) markerVars.add(m[1]);
  }

  if (markerVars.size === 0) {
    errors.push(
      '.husky/pre-push: no `case "$VAR" in *"[deploy-beta]"*` / *"[skip-tests]"* marker detection found — tier selection may have moved or broken. Update this guard if intentional.',
    );
    return { ok: false, errors };
  }

  for (const v of markerVars) {
    // VAR=$(git log … --pretty=%s …)  (also accept --format=, an optional quote)
    const assignRe = new RegExp(
      `${v}=\\$\\(\\s*git log[^)]*--(?:pretty|format)=['"]?%(\\w)`,
    );
    const am = source.match(assignRe);
    if (!am) {
      errors.push(
        `.husky/pre-push: marker variable '${v}' is matched but no \`${v}=$(git log … --pretty=%…)\` assignment was found — cannot confirm it reads the SUBJECT only.`,
      );
      continue;
    }
    if (am[1] !== 's') {
      errors.push(
        `.husky/pre-push: marker variable '${v}' is assigned from \`git log --pretty=%${am[1]}\` — must be %s (subject only). %B/%b include the body, so a prose mention of a [deploy-beta]/[skip-tests] token in the commit BODY would falsely trigger the behaviour (the footgun this guard prevents).`,
      );
    }
  }

  return { ok: errors.length === 0, errors };
}

/**
 * `.github/workflows/beta-deploy-trigger.yml`: the `[deploy-beta]` detection must match
 * the commit SUBJECT only. The detection greps jq output of `.commits[].message` for the
 * marker; that jq MUST extract the first line (`split("\n")[0]`) so a body mention can't
 * trigger a deploy. We require every non-comment line that pipes jq-over-`.commits` into
 * `grep … [deploy-beta]` to contain `split("\n")[0]`.
 */
export function checkWorkflowMarkerDetection(source: string): MarkerCheckResult {
  const errors: string[] = [];
  const lines = source.split('\n');
  let detectionLines = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trimStart().startsWith('#')) continue;
    const isDetection =
      /\bjq\b/.test(line) &&
      /\.commits\b/.test(line) &&
      /\bgrep\b/.test(line) &&
      /\[deploy-beta\]/.test(line);
    if (!isDetection) continue;
    detectionLines++;
    // The file stores the jq string with a literal backslash-n, i.e. split("\n")[0].
    if (!line.includes('split("\\n")[0]')) {
      errors.push(
        `beta-deploy-trigger.yml:${i + 1}: [deploy-beta] is detected over the full commit message — pipe the jq through \`split("\\n")[0]\` first so only the SUBJECT line is matched. Otherwise a prose mention of [deploy-beta] in a commit BODY triggers a real beta deploy (the footgun this guard prevents).`,
      );
    }
  }

  if (detectionLines === 0) {
    errors.push(
      "beta-deploy-trigger.yml: no `jq` over `.commits` piped to `grep … [deploy-beta]` detection line found — the beta-deploy trigger detection may have moved or changed shape. Update this guard if intentional.",
    );
  }

  return { ok: errors.length === 0, errors };
}

function readOrFail(filePath: string, label: string): string {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    console.error(`❌ Failed to read ${label} at ${filePath}`);
    console.error(`   ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
}

export function main(): void {
  console.log('🏷️  Commit-message marker detection (subject-only) check');
  console.log('========================================================\n');

  const hookResult = checkHookMarkerDetection(readOrFail(HOOK_PATH, '.husky/pre-push'));
  const workflowResult = checkWorkflowMarkerDetection(
    readOrFail(WORKFLOW_PATH, '.github/workflows/beta-deploy-trigger.yml'),
  );

  const errors = [...hookResult.errors, ...workflowResult.errors];
  if (errors.length > 0) {
    for (const e of errors) console.error(`❌ ${e}`);
    console.error('');
    console.error('   Commit-message markers ([deploy-beta]/[skip-tests]) must be detected');
    console.error('   from the SUBJECT line only, at BOTH gating sites, so a prose mention');
    console.error('   in a commit body cannot trigger a test-skip or a real beta deploy.');
    process.exit(1);
  }

  console.log('✅ Marker detection reads the subject line only in .husky/pre-push and beta-deploy-trigger.yml.');
}

const invokedDirectly = process.argv[1] === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main();
}
