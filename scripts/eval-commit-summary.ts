#!/usr/bin/env -S npx tsx --tsconfig tsconfig.node.json

/**
 * Commit the most recent trend-summary snapshot + index.csv update to git.
 *
 * Run via `npm run eval:commit-summary` after a knowledge-work eval finishes
 * with `--summary-trend evals/results/long-form-trend/`. The harness writes
 * the JSON snapshot and appends to `index.csv` but stops short of committing
 * — this script is the deliberate "yes, commit it" step.
 *
 * Behaviour:
 *   1. Find the newest *.summary.json file under evals/results/long-form-trend/
 *   2. Read totals from it (passed/failed/errored/composite/cost)
 *   3. Verify index.csv exists and has trailing rows for that snapshot's gitHash
 *   4. Stage both files and commit with a descriptive message
 *   5. Print the commit hash and a summary of what got committed
 *
 * The script never pushes. Pushing remains an explicit user action per
 * AGENTS.md (push authorisation is per-turn).
 */

import { execSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '..');
const TREND_DIR = path.join(REPO_ROOT, 'evals', 'results', 'long-form-trend');
const INDEX_CSV = path.join(TREND_DIR, 'index.csv');

interface TrendSummaryFile {
  schemaVersion: string;
  runStartedAt: string;
  gitHash: string;
  gitShortHash: string;
  gitBranch: string;
  modelTriplet: { working: string; thinking: string | null; background: string | null };
  fixtureSet: string;
  personaOverlay: string;
  totals: {
    fixtures: number;
    passed: number;
    failed: number;
    errored: number;
    meanComposite: number | null;
    meanCostUsd: number | null;
  };
}

async function findNewestSummary(): Promise<string> {
  let entries: import('fs').Dirent[];
  try {
    entries = await fs.readdir(TREND_DIR, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(
        `Trend directory does not exist: ${TREND_DIR}. Run an eval with --summary-trend first.`,
      );
    }
    throw err;
  }
  const candidates = entries
    .filter((e) => e.isFile() && e.name.endsWith('.summary.json'))
    .map((e) => path.join(TREND_DIR, e.name));
  if (candidates.length === 0) {
    throw new Error(`No *.summary.json files under ${TREND_DIR}. Run an eval with --summary-trend first.`);
  }
  const withStats = await Promise.all(
    candidates.map(async (file) => ({ file, mtimeMs: (await fs.stat(file)).mtimeMs })),
  );
  withStats.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return withStats[0].file;
}

function buildCommitMessage(summary: TrendSummaryFile, snapshotFilename: string): string {
  const { totals, modelTriplet, gitShortHash, fixtureSet, personaOverlay } = summary;
  const tripletStr = `${modelTriplet.working}/${modelTriplet.thinking ?? 'same'}/${modelTriplet.background ?? 'default'}`;
  const compositeStr = totals.meanComposite !== null ? totals.meanComposite.toFixed(2) : 'n/a';
  const costStr = totals.meanCostUsd !== null ? `$${totals.meanCostUsd.toFixed(2)}` : 'n/a';
  const personaStr = personaOverlay === 'none' ? '' : ` persona=${personaOverlay}`;
  const subject = `eval(trend): ${fixtureSet} @ ${gitShortHash} — ${totals.passed}/${totals.fixtures} pass, composite ${compositeStr}, mean ${costStr}${personaStr}`;
  const body = [
    '',
    `Snapshot: ${snapshotFilename}`,
    `Model triplet: ${tripletStr}`,
    `Run started: ${summary.runStartedAt}`,
    `Branch: ${summary.gitBranch}`,
    `Totals: ${totals.passed} pass, ${totals.failed} fail, ${totals.errored} error (of ${totals.fixtures})`,
    totals.meanComposite !== null ? `Mean composite: ${totals.meanComposite.toFixed(3)}` : null,
    totals.meanCostUsd !== null ? `Mean cost/run: $${totals.meanCostUsd.toFixed(2)}` : null,
    '',
    'See evals/results/long-form-trend/README.md for the trend system rationale.',
  ]
    .filter((line) => line !== null)
    .join('\n');
  return `${subject}\n${body}`;
}

async function main(): Promise<void> {
  const snapshotPath = await findNewestSummary();
  const snapshotRel = path.relative(REPO_ROOT, snapshotPath);
  const summary = JSON.parse(await fs.readFile(snapshotPath, 'utf8')) as TrendSummaryFile;

  const indexExists = await fs
    .access(INDEX_CSV)
    .then(() => true)
    .catch(() => false);
  if (!indexExists) {
    throw new Error(`index.csv not found at ${INDEX_CSV} — the harness should have appended to it. Aborting.`);
  }

  const indexCsv = await fs.readFile(INDEX_CSV, 'utf8');
  if (!indexCsv.includes(summary.gitHash)) {
    throw new Error(
      `index.csv does not contain a row for gitHash ${summary.gitHash}. Either the harness skipped the append step or you're trying to commit an old snapshot. Inspect ${INDEX_CSV} manually.`,
    );
  }

  console.log(`[eval-commit-summary] newest snapshot: ${snapshotRel}`);
  console.log(`[eval-commit-summary] gitHash: ${summary.gitHash} (branch ${summary.gitBranch})`);
  console.log(
    `[eval-commit-summary] totals: ${summary.totals.passed}/${summary.totals.fixtures} pass, composite ${summary.totals.meanComposite ?? 'n/a'}, cost ${summary.totals.meanCostUsd ?? 'n/a'}`,
  );

  const message = buildCommitMessage(summary, path.basename(snapshotPath));

  // Stage both: the new snapshot file AND the (modified) index.csv. Never use
  // `git add -A` — only the specific paths we care about, per AGENTS.md.
  // git-exec-allow: git add inherits stdio and captures no output in this eval helper
  execSync(`git add "${snapshotRel}" "${path.relative(REPO_ROOT, INDEX_CSV)}"`, {
    cwd: REPO_ROOT,
    stdio: 'inherit',
  });

  // Verify there's actually something to commit (otherwise git fails noisily).
  // git-exec-allow: cached diff name list is bounded to staged eval artifacts
  const staged = execSync('git diff --cached --name-only', { cwd: REPO_ROOT }).toString().trim();
  if (!staged) {
    console.log('[eval-commit-summary] Nothing staged — snapshot may already be committed. Nothing to do.');
    return;
  }
  console.log(`[eval-commit-summary] staged files:\n${staged}`);

  // Use --file to pass the multi-line message safely without shell quoting.
  const tmpMsgFile = path.join(REPO_ROOT, '.git', 'EVAL_COMMIT_SUMMARY_MSG');
  await fs.writeFile(tmpMsgFile, message, 'utf8');
  try {
    // git-exec-allow: git commit inherits stdio and captures no output in this eval helper
    execSync(`git commit -F "${tmpMsgFile}"`, { cwd: REPO_ROOT, stdio: 'inherit' });
  } finally {
    await fs.unlink(tmpMsgFile).catch(() => undefined);
  }

  // git-exec-allow: short commit hash lookup returns one bounded identifier
  const commitHash = execSync('git rev-parse --short HEAD', { cwd: REPO_ROOT }).toString().trim();
  console.log(`[eval-commit-summary] committed as ${commitHash}`);
  console.log('[eval-commit-summary] (not pushed — push manually when ready)');
}

main().catch((err: unknown) => {
  console.error(`[eval-commit-summary] FAILED: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
