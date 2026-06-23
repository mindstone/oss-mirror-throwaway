/**
 * Behavioral CONTRACT tests for the Stage-1 cheap-spawn path of
 * scripts/run-validate-fast.ts (docs/plans/260611_prepush-gate-speedup),
 * written from the consumer's perspective (CHIEF_ENGINEER2 testing producer).
 *
 * Deliberately complementary to the existing suites:
 * - run-validate-fast.lifecycle.test.ts always INJECTS `runStep`, so the
 *   real transformed spawn path (shell-free `spawn(argv)` + env handling)
 *   has no automated coverage there.
 * - validate-fast-step-registry.test.ts unit-tests `spawnEnvWithLocalBin`
 *   in isolation, but nothing proves `runStep` actually APPLIES it — the
 *   `env:` option could be dropped from the spawn call and every existing
 *   test would stay green.
 *
 * Contracts pinned here:
 * 1. FAIL-CLOSED THROUGH A REAL SPAWN: a transformed step whose script
 *    exits non-zero propagates that exact exit code out of runValidateFast,
 *    the failure banner names the step, and the `ran:` line shows the
 *    transformed command (so a human can reproduce what the gate executed).
 * 2. ENVIRONMENTAL PARITY (PLAN.md Amendment 2 / DA F3): the transformed
 *    spawn's PATH starts with <repo>/node_modules/.bin and the rest of the
 *    environment passes through unchanged. PATH is scrubbed in the parent
 *    first — `npx vitest` already prepends .bin, so without scrubbing the
 *    assertion would be vacuously green even if the prepend were removed.
 * 3. BASELINE PROTOCOL: deleting ANY single step from STEPS is detectable
 *    against the committed baseline (every step contributes at least one
 *    identity nothing else contributes), and the committed baseline file
 *    itself flattens validate:testing-guards into the live-imported GUARDS
 *    members — so dropping the flattening AND rubber-stamp-regenerating the
 *    baseline still fails a test.
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  STEPS,
  STEP_BASELINE_PATH,
  computeStepIdentities,
  loadGroupExpansions,
  runValidateFast,
  type Step,
  type StepIdentity,
  type ValidateFastTimingArtifact,
} from '../run-validate-fast';
import { GUARDS } from '../check-testing-guards';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

const tempPaths: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-validate-fast-contract-'));
  tempPaths.push(dir);
  return dir;
}

/**
 * Write a scratch guard script INSIDE scripts/ — the classifier only
 * transforms `scripts/<path>.ts` commands, and the spawn resolves that
 * path relative to the runner's cwd (the repo root).
 */
function makeScratchScript(source: string): { absPath: string; command: string } {
  const relPath = path.posix.join(
    'scripts',
    '__tests__',
    `zz-tmp-contract-scratch-${randomUUID()}.ts`,
  );
  const absPath = path.join(REPO_ROOT, relPath);
  fs.writeFileSync(absPath, source, 'utf8');
  tempPaths.push(absPath);
  return { absPath, command: `npx tsx ${relPath}` };
}

function readArtifact(artifactPath: string): ValidateFastTimingArtifact {
  return JSON.parse(fs.readFileSync(artifactPath, 'utf8')) as ValidateFastTimingArtifact;
}

function identityKey(identity: StepIdentity): string {
  switch (identity.kind) {
    case 'script':
      return `script | ${identity.name} | ${identity.script}`;
    case 'command':
      return `command | ${identity.name} | ${identity.command}`;
    case 'group-member':
      return `group-member | ${identity.group} | ${identity.member}`;
  }
}

function loadRealPkgScripts(): Record<string, string> {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  };
  return pkg.scripts;
}

function loadCommittedBaseline(): StepIdentity[] {
  return JSON.parse(fs.readFileSync(STEP_BASELINE_PATH, 'utf8')) as StepIdentity[];
}

beforeEach(() => {
  // The transformed-spawn tests use the REAL runStep, which resolves the
  // scratch script path relative to cwd; everything in this repo runs vitest
  // from the repo root. Fail loudly with context if a future harness change
  // breaks that assumption rather than producing a confusing fallback.
  expect(
    path.relative(REPO_ROOT, process.cwd()),
    'run-validate-fast.contract.test.ts expects vitest to run from the repo root ' +
      '(the transformed spawn resolves scripts/<path>.ts against cwd)',
  ).toBe('');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  while (tempPaths.length > 0) {
    const p = tempPaths.pop();
    if (p) {
      fs.rmSync(p, { recursive: true, force: true });
    }
  }
});

describe('transformed spawn path (REAL runStep, no injection)', () => {
  it('propagates a non-zero guard exit code end-to-end and names the step + transformed command in the banner', async () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const scratch = makeScratchScript('process.exit(7);\n');
    const artifactPath = path.join(makeTempDir(), 'timings.json');
    const failingStep: Step = { name: 'contract-failing-guard', command: scratch.command };

    const code = await runValidateFast([], {
      steps: [failingStep],
      artifactPath,
      installSignalHandlers: false,
      // NO runStep injection: this drives the real shell-free spawn.
    });

    // Exit-code propagation through the NEW spawn path, not the classifier.
    expect(code).toBe(7);

    const stderr = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(stderr).toContain('validate:fast FAILED');
    expect(stderr).toContain('step:    contract-failing-guard');
    // The banner must show what was ACTUALLY executed (Ops F11/DA F9).
    const expectedRan = scratch.command.replace(/^npx tsx /, 'node --import tsx ');
    expect(stderr).toContain(`ran:     ${expectedRan}`);

    const artifact = readArtifact(artifactPath);
    expect(artifact.steps).toHaveLength(1);
    expect(artifact.steps[0].exit_code).toBe(7);
    expect(artifact.steps[0].resolved_command).toBe(expectedRan);
  });

  it('spawns transformed steps with node_modules/.bin prepended to PATH and the rest of the env passed through (DA F3 parity invariant)', async () => {
    const outPath = path.join(makeTempDir(), 'observed-env.json');
    const scratch = makeScratchScript(
      [
        "import fs from 'node:fs';",
        'fs.writeFileSync(process.env.CONTRACT_TEST_OUT as string, JSON.stringify({',
        '  path: process.env.PATH ?? null,',
        '  sentinel: process.env.CONTRACT_TEST_SENTINEL ?? null,',
        '}));',
        '',
      ].join('\n'),
    );

    // Scrub PATH down to a minimal value WITHOUT node_modules/.bin. This is
    // what makes the assertion non-vacuous: under `npx vitest`, the inherited
    // PATH already starts with .bin, so without scrubbing this test would
    // pass even if runStep stopped applying spawnEnvWithLocalBin entirely.
    // Keep node's own directory (so the spawn can find `node`) and the
    // system dirs (so the runner's git metadata read keeps working).
    const scrubbedPath = [path.dirname(process.execPath), '/usr/bin', '/bin'].join(path.delimiter);
    vi.stubEnv('PATH', scrubbedPath);
    vi.stubEnv('CONTRACT_TEST_OUT', outPath);
    vi.stubEnv('CONTRACT_TEST_SENTINEL', 'parity-sentinel-260611');

    const code = await runValidateFast([], {
      steps: [{ name: 'contract-env-probe', command: scratch.command }],
      artifactPath: path.join(makeTempDir(), 'timings.json'),
      installSignalHandlers: false,
    });
    expect(code).toBe(0);

    const observed = JSON.parse(fs.readFileSync(outPath, 'utf8')) as {
      path: string | null;
      sentinel: string | null;
    };
    const binDir = path.join(REPO_ROOT, 'node_modules', '.bin');
    expect(observed.path, 'child saw no PATH at all').not.toBeNull();
    const segments = (observed.path as string).split(path.delimiter);
    expect(
      segments[0],
      'transformed spawn must PREPEND <repo>/node_modules/.bin to PATH — exact env parity ' +
        'with the npm/npx launch paths (PLAN.md Amendment 2 / DA F3); losing this silently ' +
        'recreates the gate-fails-but-rerun-hint-passes divergence class',
    ).toBe(binDir);
    // The remainder of PATH and the wider env pass through unchanged.
    expect(segments.slice(1).join(path.delimiter)).toBe(scrubbedPath);
    expect(observed.sentinel).toBe('parity-sentinel-260611');
  });
});

describe('step-registry baseline protocol', () => {
  it('deleting ANY single step from STEPS is detectable against the committed baseline', async () => {
    const pkgScripts = loadRealPkgScripts();
    const groupExpansions = await loadGroupExpansions();
    const baselineKeys = new Set(loadCommittedBaseline().map(identityKey));

    for (const victim of STEPS) {
      const mutatedSteps = STEPS.filter((s) => s !== victim);
      const mutatedKeys = new Set(
        computeStepIdentities(mutatedSteps, pkgScripts, groupExpansions).map(identityKey),
      );
      const missing = [...baselineKeys].filter((k) => !mutatedKeys.has(k));
      expect(
        missing.length,
        `deleting step '${victim.name}' from STEPS left the identity set equal to the ` +
          'committed baseline — the set-equality test could no longer catch its removal. ' +
          'Every step must contribute at least one identity nothing else contributes.',
      ).toBeGreaterThan(0);
    }
  });

  it('the committed baseline file flattens validate:testing-guards into the live-imported GUARDS members', () => {
    // Pins that the flattening stays LIVE-IMPORTED end to end: if
    // loadGroupExpansions stopped expanding GUARDS and the baseline were
    // rubber-stamp regenerated to match, live-vs-baseline set-equality would
    // still pass — but this direct file-vs-registry comparison would not.
    const baselineMembers = new Set(
      loadCommittedBaseline()
        .filter(
          (i): i is Extract<StepIdentity, { kind: 'group-member' }> =>
            i.kind === 'group-member' && i.group === 'validate:testing-guards',
        )
        .map((i) => i.member),
    );
    expect(GUARDS.length).toBeGreaterThanOrEqual(2);
    for (const guard of GUARDS) {
      expect(
        baselineMembers.has(guard.name),
        `GUARDS member '${guard.name}' is missing from scripts/validate-fast-step-baseline.json ` +
          '— consolidated-group members must stay individually visible in the baseline ' +
          '(regenerate via: npx tsx scripts/run-validate-fast.ts --write-step-baseline)',
      ).toBe(true);
    }
  });
});
