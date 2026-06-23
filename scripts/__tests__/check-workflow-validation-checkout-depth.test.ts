import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  checkWorkflowValidationCheckoutDepth,
  formatWorkflowCheckoutViolations,
} from '../check-workflow-validation-checkout-depth';

const fixturesDir = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures/workflow-checkout-depth');

function checkFixture(entryWorkflowFiles: string[]) {
  return checkWorkflowValidationCheckoutDepth({
    repoRoot: fixturesDir,
    workflowDirectory: fixturesDir,
    entryWorkflowFiles,
  });
}

const tempDirs: string[] = [];

function makeTempWorkflowDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'workflow-checkout-depth-'));
  tempDirs.push(dir);
  return dir;
}

describe('checkWorkflowValidationCheckoutDepth', () => {
  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });

  it('passes direct validate:fast jobs with fetch-depth: 0', async () => {
    const result = await checkFixture(['compliant.yml']);

    expect(result.violations).toEqual([]);
    expect(result.verifiedJobs).toEqual([{ workflowPath: 'compliant.yml', jobId: 'validate' }]);
  });

  it('fails direct validate:fast jobs that omit fetch-depth', async () => {
    const result = await checkFixture(['offending.yml']);

    expect(result.violations).toEqual([
      {
        workflowPath: 'offending.yml',
        jobId: 'validate',
        reason: 'job runs validate:fast but its first actions/checkout@v* step does not declare with.fetch-depth: 0',
      },
    ]);
    expect(formatWorkflowCheckoutViolations(result.violations)).toContain('fetch-depth: 0');
  });

  it('fails direct validate:fast jobs that declare fetch-depth: 1', async () => {
    const result = await checkFixture(['offending-depth-1.yml']);

    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toMatchObject({
      workflowPath: 'offending-depth-1.yml',
      jobId: 'validate',
    });
  });

  it('follows one local reusable workflow level and reports callee violations', async () => {
    const result = await checkFixture(['reusable-caller.yml']);

    expect(result.violations).toEqual([
      {
        workflowPath: 'reusable-callee-offending.yml',
        jobId: 'validate',
        reason: 'job runs validate:fast but its first actions/checkout@v* step does not declare with.fetch-depth: 0',
      },
    ]);
  });

  it('detects validate:fast inside multi-line && chained run blocks', async () => {
    const workflowDirectory = makeTempWorkflowDir();
    writeFileSync(
      join(workflowDirectory, 'multiline.yml'),
      [
        'name: Multiline',
        'on:',
        '  push:',
        'jobs:',
        '  validate:',
        '    runs-on: ubuntu-latest',
        '    steps:',
        '      - uses: actions/checkout@v4',
        '      - run: |',
        '          npm ci',
        '          npm run validate:fast',
        '          echo "done"',
      ].join('\n'),
    );

    const result = await checkWorkflowValidationCheckoutDepth({
      repoRoot: workflowDirectory,
      workflowDirectory,
      entryWorkflowFiles: ['multiline.yml'],
    });

    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toMatchObject({ workflowPath: 'multiline.yml', jobId: 'validate' });
  });

  it('accepts a SHA-pinned actions/checkout with fetch-depth: 0', async () => {
    const workflowDirectory = makeTempWorkflowDir();
    writeFileSync(
      join(workflowDirectory, 'sha-pinned.yml'),
      [
        'name: Sha Pinned',
        'on:',
        '  push:',
        'jobs:',
        '  validate:',
        '    runs-on: ubuntu-latest',
        '    steps:',
        '      - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4.2.2',
        '        with:',
        '          fetch-depth: 0',
        '      - run: npm run validate:fast',
      ].join('\n'),
    );

    const result = await checkWorkflowValidationCheckoutDepth({
      repoRoot: workflowDirectory,
      workflowDirectory,
      entryWorkflowFiles: ['sha-pinned.yml'],
    });

    expect(result.violations).toEqual([]);
    expect(result.verifiedJobs).toEqual([{ workflowPath: 'sha-pinned.yml', jobId: 'validate' }]);
  });

  it('still enforces fetch-depth on a SHA-pinned actions/checkout', async () => {
    const workflowDirectory = makeTempWorkflowDir();
    writeFileSync(
      join(workflowDirectory, 'sha-pinned-shallow.yml'),
      [
        'name: Sha Pinned Shallow',
        'on:',
        '  push:',
        'jobs:',
        '  validate:',
        '    runs-on: ubuntu-latest',
        '    steps:',
        '      - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4.2.2',
        '      - run: npm run validate:fast',
      ].join('\n'),
    );

    const result = await checkWorkflowValidationCheckoutDepth({
      repoRoot: workflowDirectory,
      workflowDirectory,
      entryWorkflowFiles: ['sha-pinned-shallow.yml'],
    });

    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toMatchObject({ workflowPath: 'sha-pinned-shallow.yml', jobId: 'validate' });
  });

  it('also globs *.yaml workflow files (GitHub Actions accepts both extensions)', async () => {
    const workflowDirectory = makeTempWorkflowDir();
    writeFileSync(
      join(workflowDirectory, 'offending.yaml'),
      [
        'name: Yaml Extension',
        'on:',
        '  push:',
        'jobs:',
        '  validate:',
        '    runs-on: ubuntu-latest',
        '    steps:',
        '      - uses: actions/checkout@v4',
        '      - run: npm run validate:fast',
      ].join('\n'),
    );

    const result = await checkWorkflowValidationCheckoutDepth({
      repoRoot: workflowDirectory,
      workflowDirectory,
    });

    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toMatchObject({ workflowPath: 'offending.yaml', jobId: 'validate' });
  });

  it('skips cross-repo reusable workflow references without failing', async () => {
    const workflowDirectory = makeTempWorkflowDir();
    writeFileSync(
      join(workflowDirectory, 'cross-repo.yml'),
      [
        'name: Cross Repo Reusable Caller',
        'on:',
        '  push:',
        'jobs:',
        '  validate:',
        '    uses: owner/repo/.github/workflows/reusable-validation.yml@v1',
      ].join('\n'),
    );

    const result = await checkWorkflowValidationCheckoutDepth({
      repoRoot: workflowDirectory,
      workflowDirectory,
      entryWorkflowFiles: ['cross-repo.yml'],
    });

    expect(result.violations).toEqual([]);
    expect(result.verifiedJobs).toEqual([]);
    expect(result.skippedExternalUses).toEqual([
      {
        workflowPath: 'cross-repo.yml',
        jobId: 'validate',
        uses: 'owner/repo/.github/workflows/reusable-validation.yml@v1',
      },
    ]);
  });
});
