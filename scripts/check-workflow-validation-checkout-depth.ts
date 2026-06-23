#!/usr/bin/env npx tsx
// 260511 release pipeline hardening (H4'). Plan: docs/plans/260511_release_pipeline_hardening_post_v0.4.40.md
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import fg from 'fast-glob';
import { parse as parseYaml } from 'yaml';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_WORKFLOW_DIRECTORY = join(repoRoot, '.github/workflows');
const CHECK_NAME = 'validate-workflow-checkout-depth';
// Accept both the version-tagged form (actions/checkout@v4) and the
// commit-SHA-pinned form (actions/checkout@<40-hex> # v4.2.2). SHA-pinning is
// the more secure form (it can't be re-pointed by a tag move) and is required
// for third-party actions in the mirror-publish workflows — the linter must
// recognise it so validate:fast doesn't reject the hardened pin.
const CHECKOUT_ACTION_REGEX = /^actions\/checkout@(v\d+|[0-9a-f]{40})\b/;

export const VALIDATE_FAST_INVOCATION_REGEX =
  /\b(npm run validate:fast|yarn validate:fast|pnpm (?:run )?validate:fast)\b/;

export interface WorkflowCheckoutViolation {
  workflowPath: string;
  jobId: string;
  reason: string;
}

export interface VerifiedWorkflowJob {
  workflowPath: string;
  jobId: string;
}

export interface SkippedWorkflowUse {
  workflowPath: string;
  jobId: string;
  uses: string;
}

export interface WorkflowCheckoutDepthResult {
  violations: WorkflowCheckoutViolation[];
  verifiedJobs: VerifiedWorkflowJob[];
  skippedExternalUses: SkippedWorkflowUse[];
}

export interface CheckWorkflowCheckoutDepthOptions {
  repoRoot?: string;
  workflowDirectory?: string;
  entryWorkflowFiles?: string[];
}

interface AnalysisState {
  repoRoot: string;
  workflowDirectory: string;
  visitedWorkflowFiles: Set<string>;
  result: WorkflowCheckoutDepthResult;
}

type YamlRecord = Record<string, unknown>;

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/');
}

function asRecord(value: unknown): YamlRecord | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as YamlRecord;
}

function displayPath(absolutePath: string, root: string): string {
  const rel = normalizePath(relative(root, absolutePath));
  return rel && !rel.startsWith('..') ? rel : normalizePath(absolutePath);
}

function resolveEntryWorkflowFile(workflowDirectory: string, workflowFile: string): string {
  return resolve(workflowDirectory, workflowFile);
}

function resolveLocalReusableWorkflow(usesValue: string, workflowDirectory: string): string | undefined {
  const localPrefix = './.github/workflows/';
  if (!usesValue.startsWith(localPrefix)) return undefined;
  const workflowFile = usesValue.slice(localPrefix.length).split('@')[0];
  if (!workflowFile) return undefined;
  return resolve(workflowDirectory, workflowFile);
}

function isExternalReusableWorkflow(usesValue: string): boolean {
  return !usesValue.startsWith('./') && /\.github\/workflows\/[^@\s]+\.ya?ml@[^@\s]+/.test(usesValue);
}

function jobInvokesValidateFast(job: YamlRecord): boolean {
  const steps = Array.isArray(job.steps) ? job.steps : [];
  return steps.some((rawStep) => {
    const step = asRecord(rawStep);
    return typeof step?.run === 'string' && VALIDATE_FAST_INVOCATION_REGEX.test(step.run);
  });
}

function firstCheckoutStep(job: YamlRecord): YamlRecord | undefined {
  const steps = Array.isArray(job.steps) ? job.steps : [];
  for (const rawStep of steps) {
    const step = asRecord(rawStep);
    if (!step || typeof step.uses !== 'string') continue;
    if (CHECKOUT_ACTION_REGEX.test(step.uses.trim())) return step;
  }
  return undefined;
}

function checkoutHasFetchDepthZero(checkoutStep: YamlRecord | undefined): boolean {
  const withConfig = asRecord(checkoutStep?.with);
  const fetchDepth = withConfig?.['fetch-depth'];
  return fetchDepth === 0 || fetchDepth === '0';
}

function validateCheckoutDepth(workflowPath: string, jobId: string, job: YamlRecord): WorkflowCheckoutViolation | undefined {
  const checkoutStep = firstCheckoutStep(job);
  if (!checkoutStep) {
    return {
      workflowPath,
      jobId,
      reason: 'job runs validate:fast but has no actions/checkout@v* step',
    };
  }
  if (!checkoutHasFetchDepthZero(checkoutStep)) {
    return {
      workflowPath,
      jobId,
      reason: 'job runs validate:fast but its first actions/checkout@v* step does not declare with.fetch-depth: 0',
    };
  }
  return undefined;
}

function readWorkflowDocument(absolutePath: string, workflowPath: string): YamlRecord {
  if (!existsSync(absolutePath)) {
    throw new Error(`Referenced workflow not found: ${workflowPath}`);
  }
  try {
    const parsed = parseYaml(readFileSync(absolutePath, 'utf8'));
    const root = asRecord(parsed);
    if (!root) throw new Error('top-level YAML document is not an object');
    return root;
  } catch (err) {
    throw new Error(`Failed to parse ${workflowPath}: ${(err as Error).message}`);
  }
}

async function analyzeWorkflowFile(state: AnalysisState, absolutePath: string, depth: number): Promise<void> {
  const normalizedAbsolutePath = resolve(absolutePath);
  if (state.visitedWorkflowFiles.has(normalizedAbsolutePath)) return;
  state.visitedWorkflowFiles.add(normalizedAbsolutePath);

  const workflowPath = displayPath(normalizedAbsolutePath, state.repoRoot);
  const document = readWorkflowDocument(normalizedAbsolutePath, workflowPath);
  const jobs = asRecord(document.jobs);
  if (!jobs) return;

  for (const [jobId, rawJob] of Object.entries(jobs)) {
    const job = asRecord(rawJob);
    if (!job) continue;

    if (typeof job.uses === 'string') {
      const localReusableWorkflow = resolveLocalReusableWorkflow(job.uses, state.workflowDirectory);
      if (localReusableWorkflow && depth < 1) {
        await analyzeWorkflowFile(state, localReusableWorkflow, depth + 1);
      } else if (!localReusableWorkflow && isExternalReusableWorkflow(job.uses)) {
        state.result.skippedExternalUses.push({ workflowPath, jobId, uses: job.uses });
      }
    }

    if (!jobInvokesValidateFast(job)) continue;

    const violation = validateCheckoutDepth(workflowPath, jobId, job);
    if (violation) {
      state.result.violations.push(violation);
    } else {
      state.result.verifiedJobs.push({ workflowPath, jobId });
    }
  }
}

export async function checkWorkflowValidationCheckoutDepth(
  options: CheckWorkflowCheckoutDepthOptions = {},
): Promise<WorkflowCheckoutDepthResult> {
  const root = resolve(options.repoRoot ?? repoRoot);
  const workflowDirectory = resolve(options.workflowDirectory ?? DEFAULT_WORKFLOW_DIRECTORY);
  const entryWorkflowFiles =
    options.entryWorkflowFiles ??
    (await fg(['*.yml', '*.yaml'], {
      cwd: workflowDirectory,
      onlyFiles: true,
      absolute: false,
    }));

  const state: AnalysisState = {
    repoRoot: root,
    workflowDirectory,
    visitedWorkflowFiles: new Set<string>(),
    result: {
      violations: [],
      verifiedJobs: [],
      skippedExternalUses: [],
    },
  };

  for (const workflowFile of entryWorkflowFiles) {
    await analyzeWorkflowFile(state, resolveEntryWorkflowFile(workflowDirectory, workflowFile), 0);
  }

  state.result.violations.sort((a, b) => `${a.workflowPath}:${a.jobId}`.localeCompare(`${b.workflowPath}:${b.jobId}`));
  state.result.verifiedJobs.sort((a, b) => `${a.workflowPath}:${a.jobId}`.localeCompare(`${b.workflowPath}:${b.jobId}`));
  state.result.skippedExternalUses.sort((a, b) =>
    `${a.workflowPath}:${a.jobId}:${a.uses}`.localeCompare(`${b.workflowPath}:${b.jobId}:${b.uses}`)
  );
  return state.result;
}

export function formatWorkflowCheckoutViolations(violations: WorkflowCheckoutViolation[]): string {
  const remediationSnippet = [
    '      - uses: actions/checkout@v4',
    '        with:',
    '          fetch-depth: 0',
  ].join('\n');

  const entries = violations
    .map(
      (violation) =>
        `- ${violation.workflowPath} :: jobs.${violation.jobId}\n` +
        `  Reason: ${violation.reason}\n` +
        '  Remediation:\n' +
        '```yaml\n' +
        `${remediationSnippet}\n` +
        '```',
    )
    .join('\n\n');

  return [
    `[${CHECK_NAME}] ERROR: ${violations.length} workflow job(s) run validate:fast without a full-depth checkout.`,
    '',
    entries,
    '',
    'If the job intentionally unshallows after checkout, keep the checkout explicit with fetch-depth: 0 so validate:fast remains safe by default.',
    '',
    'See docs-private/investigations/260510_paul_christensen_stale_update_lag.md for context — this lint exists because a shallow CI checkout caused 11 days of silent stable-release failures.',
  ].join('\n');
}

async function main(): Promise<void> {
  try {
    const result = await checkWorkflowValidationCheckoutDepth();
    for (const skipped of result.skippedExternalUses) {
      console.log(
        `[${CHECK_NAME}] [skipped] ${skipped.workflowPath} :: jobs.${skipped.jobId} uses external reusable workflow ${skipped.uses}`,
      );
    }
    if (result.violations.length > 0) {
      console.error(formatWorkflowCheckoutViolations(result.violations));
      process.exit(1);
    }
    console.log(`[${CHECK_NAME}] OK — ${result.verifiedJobs.length} jobs verified`);
  } catch (err) {
    console.error(`[${CHECK_NAME}] ERROR: ${(err as Error).message}`);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main();
}
