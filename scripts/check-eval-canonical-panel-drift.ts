#!/usr/bin/env npx tsx

import fs from 'node:fs';
import path from 'node:path';
import { loadCanonicalPanel } from '../evals/canonicalPanel';
import { computePolicySignature } from '../evals/knowledge-work-judge-adequacy';

const REPO_ROOT = path.resolve(__dirname, '..');
const DEFAULT_CONFIG_PATH = path.join(REPO_ROOT, 'evals', 'configs', 'default.json');
const DEFAULT_POLICY_SOURCE_PATH = path.join(REPO_ROOT, 'evals', 'knowledge-work-judge-adequacy.ts');
const DEFAULT_BASELINE_PATH = path.join(REPO_ROOT, 'evals', '.policy-baseline.json');
const ADEQUACY_POLICY_VERSION_RE = /export\s+const\s+ADEQUACY_POLICY_VERSION\s*=\s*(\d+)\s*;?/;

export interface PolicyState {
  policySignature: string;
  policyVersion: number;
}

export interface PolicyBaseline extends PolicyState {
  lastUpdated: string;
}

export interface CanonicalPanelDriftCheckOptions {
  configPath?: string;
  policySourcePath?: string;
  baselinePath?: string;
  updateBaseline?: boolean;
  now?: Date;
}

export interface CanonicalPanelDriftCheckResult {
  exitCode: 0 | 1;
  message: string;
  current: PolicyState;
  baseline: PolicyBaseline | null;
  baselinePath: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function readAdequacyPolicyVersion(policySourcePath: string = DEFAULT_POLICY_SOURCE_PATH): number {
  const source = fs.readFileSync(policySourcePath, 'utf8');
  const uncommented = source
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
  const match = uncommented.match(ADEQUACY_POLICY_VERSION_RE);
  if (!match) {
    throw new Error(
      `Could not parse ADEQUACY_POLICY_VERSION from ${policySourcePath}. `
      + 'Expected: export const ADEQUACY_POLICY_VERSION = <number>;',
    );
  }

  const value = Number(match[1]);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`Invalid ADEQUACY_POLICY_VERSION value "${match[1]}" in ${policySourcePath}.`);
  }
  return value;
}

export function computeCurrentPolicyState(input: {
  configPath?: string;
  policySourcePath?: string;
} = {}): PolicyState {
  const canonicalPanel = loadCanonicalPanel(input.configPath ?? DEFAULT_CONFIG_PATH);
  return {
    policySignature: computePolicySignature(canonicalPanel),
    policyVersion: readAdequacyPolicyVersion(input.policySourcePath ?? DEFAULT_POLICY_SOURCE_PATH),
  };
}

export function readPolicyBaseline(baselinePath: string = DEFAULT_BASELINE_PATH): PolicyBaseline {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(baselinePath, 'utf8')) as unknown;
  } catch (error) {
    throw new Error(
      `Failed to read policy baseline at ${baselinePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!isRecord(parsed)) {
    throw new Error(`Invalid policy baseline at ${baselinePath}: expected top-level object.`);
  }

  const policySignature = parsed.policySignature;
  const policyVersion = parsed.policyVersion;
  const lastUpdated = parsed.lastUpdated;

  if (typeof policySignature !== 'string' || policySignature.trim().length === 0) {
    throw new Error(`Invalid policy baseline at ${baselinePath}: policySignature must be a non-empty string.`);
  }
  if (typeof policyVersion !== 'number' || !Number.isInteger(policyVersion) || policyVersion < 1) {
    throw new Error(`Invalid policy baseline at ${baselinePath}: policyVersion must be an integer >= 1.`);
  }
  if (typeof lastUpdated !== 'string' || Number.isNaN(Date.parse(lastUpdated))) {
    throw new Error(`Invalid policy baseline at ${baselinePath}: lastUpdated must be an ISO-like date string.`);
  }

  return {
    policySignature,
    policyVersion,
    lastUpdated,
  };
}

export function writePolicyBaseline(
  baselinePath: string,
  policy: PolicyState,
  now: Date = new Date(),
): PolicyBaseline {
  const baseline: PolicyBaseline = {
    policySignature: policy.policySignature,
    policyVersion: policy.policyVersion,
    lastUpdated: now.toISOString(),
  };
  fs.writeFileSync(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`, 'utf8');
  return baseline;
}

function formatPolicyTag(policy: PolicyState): string {
  return `${policy.policySignature}@v${policy.policyVersion}`;
}

export function formatDriftMessage(current: PolicyState, baseline: PolicyBaseline): string {
  return [
    '❌ Canonical judge panel or ADEQUACY_POLICY_VERSION has changed.',
    '',
    `Baseline: ${formatPolicyTag(baseline)}`,
    `Current:  ${formatPolicyTag(current)}`,
    '',
    'REQUIRED ACTION before merging:',
    '1. Run the migration: `npm run eval:remediate-inadequate report`',
    '2. Review costs, then `apply --cost-cap-usd <approved> --epoch <slug>`',
    '3. After successful migration, regenerate the baseline:',
    '   `npx tsx scripts/check-eval-canonical-panel-drift.ts --update-baseline`',
    '4. Commit the updated evals/.policy-baseline.json in the SAME PR',
    '   that changed the policy/panel.',
  ].join('\n');
}

export function runEvalCanonicalPanelDriftCheck(
  options: CanonicalPanelDriftCheckOptions = {},
): CanonicalPanelDriftCheckResult {
  const baselinePath = path.resolve(options.baselinePath ?? DEFAULT_BASELINE_PATH);
  const current = computeCurrentPolicyState({
    ...(options.configPath ? { configPath: path.resolve(options.configPath) } : {}),
    ...(options.policySourcePath ? { policySourcePath: path.resolve(options.policySourcePath) } : {}),
  });

  if (options.updateBaseline === true) {
    const baseline = writePolicyBaseline(baselinePath, current, options.now);
    return {
      exitCode: 0,
      message:
        `✅ Updated policy baseline at ${baselinePath}\n`
        + `Current baseline: ${formatPolicyTag(current)}`,
      current,
      baseline,
      baselinePath,
    };
  }

  const baseline = readPolicyBaseline(baselinePath);
  const drifted = baseline.policySignature !== current.policySignature
    || baseline.policyVersion !== current.policyVersion;

  if (!drifted) {
    return {
      exitCode: 0,
      message: `✅ Canonical panel policy baseline matches (${formatPolicyTag(current)})`,
      current,
      baseline,
      baselinePath,
    };
  }

  return {
    exitCode: 1,
    message: formatDriftMessage(current, baseline),
    current,
    baseline,
    baselinePath,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const result = runEvalCanonicalPanelDriftCheck({
      updateBaseline: process.argv.includes('--update-baseline'),
    });
    if (result.exitCode === 0) {
      console.log(result.message);
    } else {
      console.error(result.message);
    }
    process.exit(result.exitCode);
  } catch (error) {
    console.error(
      `[check-eval-canonical-panel-drift] ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
}
