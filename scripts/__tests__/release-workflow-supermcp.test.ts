import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

type YamlRecord = Record<string, unknown>;

function asRecord(value: unknown): YamlRecord {
  expect(value).toBeTruthy();
  expect(typeof value).toBe('object');
  expect(Array.isArray(value)).toBe(false);
  return value as YamlRecord;
}

function readWorkflow(relativePath: string): YamlRecord {
  return asRecord(parseYaml(readFileSync(resolve(repoRoot, relativePath), 'utf8')));
}

function needsAsArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === 'string') return [value];
  return [];
}

function stepsForJob(job: YamlRecord): YamlRecord[] {
  expect(Array.isArray(job.steps)).toBe(true);
  return (job.steps as unknown[]).map(asRecord);
}

describe('release workflow super-mcp publish wiring', () => {
  it('keeps super-mcp npm publish stable-gated, submodule-aware, and non-blocking for GCS publish', () => {
    const releaseWorkflow = readWorkflow('.github/workflows/release.yml');
    const jobs = asRecord(releaseWorkflow.jobs);
    const publishJob = asRecord(jobs['publish-super-mcp-npm']);

    expect(publishJob.needs).toEqual(['setup', 'verify-submodules', 'validate-and-test']);
    expect(String(publishJob.if)).toContain("needs.setup.outputs.channel == 'stable'");
    expect(String(publishJob.if)).not.toContain('github.ref');

    const checkoutStep = stepsForJob(publishJob).find((step) => step.uses === 'actions/checkout@v4');
    expect(checkoutStep).toBeTruthy();
    expect(asRecord(checkoutStep?.with).submodules).toBe(true);

    // Auth is npm Trusted Publishing (OIDC): id-token permission + npm >= 11.5,
    // configured on npmjs.com for super-mcp-router. NO long-lived token on purpose.
    expect(asRecord(publishJob.permissions)['id-token']).toBe('write');
    const npmUpgradeStep = stepsForJob(publishJob).find(
      (step) => typeof step.run === 'string' && (step.run as string).includes('npm install -g npm@'),
    );
    expect(npmUpgradeStep, 'OIDC trusted publishing needs npm >= 11.5.1 (Node 20 bundles npm 10)').toBeTruthy();
    const publishStep = stepsForJob(publishJob).find(
      (step) => typeof step.name === 'string' && (step.name as string).startsWith('Publish super-mcp-router'),
    );
    expect(publishStep?.run).toBe('npm run publish:super-mcp -- --verify');
    expect(publishStep?.env, 'no NODE_AUTH_TOKEN — auth comes from OIDC trusted publishing').toBeUndefined();

    const publishToGcs = asRecord(jobs['publish-to-gcs']);
    expect(needsAsArray(publishToGcs.needs)).not.toContain('publish-super-mcp-npm');
    expect(publishToGcs.if).toBeUndefined();
  });

  it('runs super-mcp publish preflight only when validate-release is enabled', () => {
    const reusableWorkflow = readWorkflow('.github/workflows/reusable-validation.yml');
    const jobs = asRecord(reusableWorkflow.jobs);
    const validateJob = asRecord(jobs.validate);
    const preflightStep = stepsForJob(validateJob).find(
      (step) => step.name === 'Validate super-mcp npm publish preflight',
    );

    expect(preflightStep).toBeTruthy();
    expect(preflightStep?.if).toBe('inputs.validate-release');
    expect(preflightStep?.run).toBe('npm run validate:super-mcp-publish-preflight');
  });
});
