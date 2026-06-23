#!/usr/bin/env -S npx tsx --tsconfig tsconfig.node.json

/**
 * CI Validation: BotQA transcript privacy CI gate (anti-rot)
 *
 * The 260504 botqa privacy design-gap postmortem asks us to "confirm the
 * botqa-transcript privacy category is gated in CI at >=95% threshold." The
 * genuine enforcement already exists and is STRICTER than 95%:
 *
 *   - evals/botqa-transcript.ts hard-exits (`process.exit(1)`) on ANY privacy
 *     violation (`privacyViolations > 0`) — a 0-tolerance privacy gate.
 *   - .github/workflows/eval.yml runs that harness on a path-filtered
 *     pull_request trigger that fires when botqa-transcript code or fixtures
 *     change (the regression surface), plus a scheduled cron.
 *   - The privacy category has 6 dedicated fixtures.
 *
 * The real risk is SILENT ROT: nothing prevents the privacy hard-exit guard,
 * the PR-path coverage, or the privacy fixtures from being quietly removed —
 * exactly the "a guard rots to inert and nobody notices" class. This gate is
 * a static structural assertion (no API key, no eval run) that locks the
 * existing enforcement in place so it fails validate:fast the moment any leg
 * is removed.
 *
 * NOTE — deliberately NOT done here: adding a per-push (push: [dev,main])
 * full-matrix eval trigger. That would run all ~23 evals on every push with
 * unmanaged API cost; the path-filtered PR trigger already runs
 * botqa-transcript on its own changes. Recorded as a deferred cost decision in
 * the planning doc, not an open gap.
 *
 * Run: npx tsx scripts/check-botqa-privacy-ci-gate.ts
 * Wired into: npm run validate:fast (validate:botqa-privacy-ci-gate)
 *
 * @see docs/plans/260614_recs8-ci-gates/PLAN.md
 * @see docs-private/postmortems/260504_botqa_transcript_privacy_guard_design_gap_postmortem.md
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as ts from 'typescript';
import { parse as parseYaml } from 'yaml';

const REPO_ROOT = path.resolve(__dirname, '..');
const EVAL_WORKFLOW_PATH = path.join(REPO_ROOT, '.github/workflows/eval.yml');
const EVAL_HARNESS_PATH = path.join(REPO_ROOT, 'evals/botqa-transcript.ts');
const FIXTURE_DIR = path.join(REPO_ROOT, 'evals/fixtures/botqa-transcript');

/** The path-filtered PR trigger MUST keep watching these so botqa runs on its own changes. */
export const REQUIRED_PR_PATHS = [
  'evals/botqa-transcript.ts',
  'evals/fixtures/botqa-transcript/**',
] as const;

export interface PrivacyCiGateResult {
  readonly exitCode: 0 | 1;
  readonly errors: readonly string[];
  readonly output: readonly string[];
}

export interface PrivacyCiGateDeps {
  /** Raw eval.yml text (parsed as YAML internally). */
  workflowYaml: string;
  /** Raw evals/botqa-transcript.ts source. */
  harnessSource: string;
  /** Category strings of the botqa-transcript fixtures (one per fixture file). */
  fixtureCategories: readonly string[];
}

interface MatrixEntry {
  eval?: { key?: string; script?: string };
}

interface ParsedWorkflow {
  on?: {
    pull_request?: { paths?: string[] };
  };
  jobs?: {
    eval?: {
      strategy?: { matrix?: { include?: MatrixEntry[] } };
    };
  };
}

/**
 * Count privacy-violation→`process.exit(1)` guard blocks in the harness via the
 * TS AST. A guard counts when an `if` statement's then-branch exits with
 * `process.exit(1)` AND its condition is privacy-derived — either directly
 * (the condition references `privacyViolations`) or via a flag variable whose
 * initializer references `privacyViolations` (the multi-run path computes
 * `const anyCritical = ...privacyViolations > 0...; if (anyCritical) exit`).
 *
 * The harness has two such guards (multi-run + single-run paths); removing
 * either drops the count below 2 and fails the gate, so an unrelated
 * `process.exit(1)` elsewhere cannot mask a removed privacy guard — the
 * co-location the earlier independent-regex check could not prove.
 */
export function countPrivacyExitBlocks(harnessSource: string): number {
  const sf = ts.createSourceFile('harness.ts', harnessSource, ts.ScriptTarget.Latest, true);

  // Map flag-variable name → whether its initializer references privacyViolations.
  const privacyFlags = new Set<string>();
  const collectFlags = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      identifierAppears(node.initializer, 'privacyViolations')
    ) {
      privacyFlags.add(node.name.text);
    }
    ts.forEachChild(node, collectFlags);
  };
  collectFlags(sf);

  const conditionIsPrivacyDerived = (cond: ts.Expression): boolean => {
    if (identifierAppears(cond, 'privacyViolations')) return true;
    // condition is (or contains) a privacy-derived flag variable
    let hit = false;
    const walk = (n: ts.Node): void => {
      if (ts.isIdentifier(n) && privacyFlags.has(n.text)) hit = true;
      else ts.forEachChild(n, walk);
    };
    walk(cond);
    return hit;
  };

  let count = 0;
  const visit = (node: ts.Node): void => {
    if (
      ts.isIfStatement(node) &&
      conditionIsPrivacyDerived(node.expression) &&
      branchCallsProcessExit1(node.thenStatement)
    ) {
      count += 1;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return count;
}

function identifierAppears(node: ts.Node, name: string): boolean {
  let hit = false;
  const walk = (n: ts.Node): void => {
    if (ts.isIdentifier(n) && n.text === name) hit = true;
    else ts.forEachChild(n, walk);
  };
  walk(node);
  return hit;
}

function branchCallsProcessExit1(node: ts.Node): boolean {
  let hit = false;
  const walk = (n: ts.Node): void => {
    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      n.expression.name.text === 'exit'
    ) {
      const arg = n.arguments[0];
      if (arg && ts.isNumericLiteral(arg) && arg.text === '1') hit = true;
    }
    ts.forEachChild(n, walk);
  };
  walk(node);
  return hit;
}

export function analyzePrivacyCiGate(deps: PrivacyCiGateDeps): PrivacyCiGateResult {
  const errors: string[] = [];
  const output: string[] = [];

  // 1. The pull_request trigger watches the botqa-transcript code + fixtures.
  let workflow: ParsedWorkflow;
  try {
    workflow = (parseYaml(deps.workflowYaml) ?? {}) as ParsedWorkflow;
  } catch (error) {
    errors.push(`Could not parse eval.yml as YAML: ${error instanceof Error ? error.message : String(error)}`);
    workflow = {};
  }
  // `on` is a reserved YAML keyword that some parsers coerce to boolean `true`
  // as a key; the `yaml` lib keeps it as the string "on". Read defensively.
  const prPaths: string[] =
    workflow.on?.pull_request?.paths ??
    (workflow as { true?: { pull_request?: { paths?: string[] } } }).true?.pull_request?.paths ??
    [];
  for (const required of REQUIRED_PR_PATHS) {
    if (!prPaths.includes(required)) {
      errors.push(
        `eval.yml pull_request.paths is missing "${required}". Without it, the botqa-transcript privacy eval does not run when its code/fixtures change — the privacy regression surface is no longer gated.`,
      );
    }
  }

  // 1b. The eval matrix still contains the botqa-transcript entry — otherwise the
  // PR trigger fires but the privacy eval never runs (removing the matrix entry
  // would otherwise silently pass this gate).
  const matrixInclude = workflow.jobs?.eval?.strategy?.matrix?.include ?? [];
  const hasBotqaEntry = matrixInclude.some(
    (m) => m?.eval?.key === 'botqa-transcript' || m?.eval?.script === 'botqa-transcript.ts',
  );
  if (!hasBotqaEntry) {
    errors.push(
      'eval.yml jobs.eval.strategy.matrix.include no longer has a botqa-transcript entry (key "botqa-transcript" / script "botqa-transcript.ts"). The PR trigger fires but the privacy eval would never run.',
    );
  }

  // 2. The harness retains the 0-tolerance privacy hard-exit guard — in BOTH the
  //    multi-run and single-run code paths. We require a privacy-violation
  //    condition CO-LOCATED with a process.exit(1) in each path (an `if`/branch
  //    whose condition mentions privacyViolations and whose body exits), so a
  //    refactor that leaves an unrelated process.exit(1) elsewhere cannot pass.
  const privacyExitBlocks = countPrivacyExitBlocks(deps.harnessSource);
  if (privacyExitBlocks < 2) {
    errors.push(
      `evals/botqa-transcript.ts has ${privacyExitBlocks} privacy-violation→process.exit(1) guard(s); expected >=2 (the multi-run and single-run paths). This 0-tolerance guard is the privacy CI gate — stricter than the postmortem's 95% ask. Do not weaken it.`,
    );
  }

  // 3. The harness declares an aggregate accuracy floor (documents the threshold intent).
  if (!/summary\.accuracy\s*>=\s*0\.\d+/.test(deps.harnessSource)) {
    errors.push(
      'evals/botqa-transcript.ts no longer declares an aggregate accuracy floor (`summary.accuracy >= 0.NN`). The privacy gate relies on the harness failing below threshold.',
    );
  }

  // 4. At least one privacy-category fixture exists.
  const privacyFixtures = deps.fixtureCategories.filter((c) => c === 'privacy').length;
  if (privacyFixtures === 0) {
    errors.push(
      'No botqa-transcript fixture has "category": "privacy". The privacy category is the load-bearing safety coverage — at least one fixture must exist.',
    );
  }

  if (errors.length > 0) {
    output.push(`✗ BotQA privacy CI gate: ${errors.length} error(s)`);
    for (const e of errors) output.push(`  - ${e}`);
    return { exitCode: 1, errors, output };
  }

  output.push(
    `✓ BotQA privacy CI gate: PR-path coverage present, 0-tolerance privacy hard-exit intact, ${privacyFixtures} privacy fixture(s)`,
  );
  return { exitCode: 0, errors, output };
}

function readFixtureCategories(): string[] {
  const categories: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(FIXTURE_DIR, { withFileTypes: true });
  } catch {
    return categories;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json') || entry.name.startsWith('_')) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, entry.name), 'utf8')) as {
        category?: unknown;
      };
      if (typeof parsed.category === 'string') categories.push(parsed.category);
    } catch {
      // Skip malformed fixture JSON — the harness surfaces those separately.
    }
  }
  return categories;
}

function createFsDeps(): PrivacyCiGateDeps {
  return {
    workflowYaml: fs.readFileSync(EVAL_WORKFLOW_PATH, 'utf8'),
    harnessSource: fs.readFileSync(EVAL_HARNESS_PATH, 'utf8'),
    fixtureCategories: readFixtureCategories(),
  };
}

if (!process.env.VITEST) {
  let result: PrivacyCiGateResult;
  try {
    result = analyzePrivacyCiGate(createFsDeps());
  } catch (error) {
    console.error('[check-botqa-privacy-ci-gate] fatal:', error);
    process.exit(1);
  }
  for (const line of result.output) {
    if (result.exitCode === 0) console.log(line);
    else console.error(line);
  }
  process.exit(result.exitCode);
}
