/**
 * Step-registry baseline + cheap-spawn classifier tests for
 * scripts/run-validate-fast.ts (Stage 1, docs/plans/260611_prepush-gate-speedup).
 *
 * Two protections:
 * 1. SET-EQUALITY of the live step identities (STEPS × package.json ×
 *    consolidated-group members) against the committed baseline
 *    scripts/validate-fast-step-baseline.json. This is the
 *    kill-by-construction safety net: a guard silently dropped, renamed, or
 *    repointed fails this test; intentional changes must edit the baseline
 *    in the SAME commit so reviewers see the diff line.
 * 2. The conservative argv-token classifier behind resolveStepCommand:
 *    every real package.json script is classified (snapshot), plus explicit
 *    transform/fallback cases.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  STEPS,
  STEP_BASELINE_PATH,
  classifyCommand,
  computeStepIdentities,
  loadGroupExpansions,
  resolveStepCommand,
  spawnEnvWithLocalBin,
  type Step,
  type StepIdentity,
} from '../run-validate-fast';
import { GUARDS } from '../check-testing-guards';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

function loadRealPkgScripts(): Record<string, string> {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  };
  return pkg.scripts;
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

describe('validate:fast step-registry baseline', () => {
  it('live step identities are set-equal to the committed baseline', async () => {
    const live = computeStepIdentities(STEPS, loadRealPkgScripts(), await loadGroupExpansions());
    const baseline = JSON.parse(fs.readFileSync(STEP_BASELINE_PATH, 'utf8')) as StepIdentity[];

    const liveKeys = live.map(identityKey);
    const baselineKeys = baseline.map(identityKey);
    const liveSet = new Set(liveKeys);
    const baselineSet = new Set(baselineKeys);

    // Duplicate identities would let two protection units silently merge.
    expect(liveKeys.length, 'duplicate live step identities detected').toBe(liveSet.size);

    const removed = [...baselineSet].filter((k) => !liveSet.has(k));
    const added = [...liveSet].filter((k) => !baselineSet.has(k));
    const explainer = [
      'validate:fast step registry drifted from scripts/validate-fast-step-baseline.json.',
      '',
      removed.length > 0
        ? `REMOVED from the live gate (a guard that ran yesterday no longer runs — this is the exact class this test exists to stop):\n  - ${removed.join('\n  - ')}`
        : '',
      added.length > 0 ? `ADDED to the live gate (not yet in the baseline):\n  - ${added.join('\n  - ')}` : '',
      '',
      'If this change is INTENTIONAL, regenerate the baseline in the SAME commit so reviewers',
      'see the identity diff line and can judge the protection change:',
      '  npx tsx scripts/run-validate-fast.ts --write-step-baseline',
      '',
      'If you ADDED or RENAMED a package.json script, the classifier baseline also drifts —',
      'regenerate it in the SAME commit, or the next push fails on a stale baseline:',
      '  npx tsx scripts/run-validate-fast.ts --write-classifier-baseline',
      '',
      'Never delete a guard identity without explicit reviewer sign-off — removing a line here',
      'means an invariant that was checked on every push is checked no longer.',
    ]
      .filter((line) => line !== '')
      .join('\n');

    expect(removed, explainer).toEqual([]);
    expect(added, explainer).toEqual([]);
  });

  it('flattens validate:testing-guards into one group-member identity per registered guard', async () => {
    const live = computeStepIdentities(STEPS, loadRealPkgScripts(), await loadGroupExpansions());
    const members = live
      .filter((i): i is Extract<StepIdentity, { kind: 'group-member' }> => i.kind === 'group-member')
      .filter((i) => i.group === 'validate:testing-guards')
      .map((i) => i.member);
    expect(new Set(members)).toEqual(new Set(GUARDS.map((g) => g.name)));
    expect(members.length).toBeGreaterThanOrEqual(2);
  });
});

describe('classifyCommand (exact argv-token classifier)', () => {
  // NOTE: the whole-package.json "classifies every real script" snapshot was
  // removed (2026-06-22). It required a manual `-u` regen on every package.json
  // change and was unreachable by `vitest related` (fs.readFileSync, no static
  // import edge). The protection is now live inside validate:fast via
  // `validate:step-registry` (--check-step-baseline) + the committed
  // scripts/validate-fast-classifier-baseline.json — always-on, no .snap,
  // fails loud on drift by construction. Regenerate with:
  //   npx tsx scripts/run-validate-fast.ts --write-classifier-baseline

  it('transforms the large majority of validate/check scripts and never a test/lint/build tool', () => {
    const scripts = loadRealPkgScripts();
    let transformable = 0;
    for (const [name, command] of Object.entries(scripts)) {
      const c = classifyCommand(command);
      if (c.transformable) transformable += 1;
      const firstToken = command.trim().split(/\s+/)[0];
      if (['vitest', 'eslint', 'stylelint', 'playwright', 'cross-env'].includes(firstToken)) {
        expect(c.transformable, `${name} (${firstToken}) must never transform`).toBe(false);
      }
      if (/--tsconfig|--require/.test(command)) {
        expect(c.transformable, `${name} carries loader/config flags and must never transform`).toBe(false);
      }
    }
    // The planner census found 82 transformable validate:*/check:* wrappers;
    // assert a floor so a classifier regression to "nothing transforms" is loud.
    expect(transformable).toBeGreaterThanOrEqual(70);
  });

  it.each([
    ['npx tsx --tsconfig tsconfig.node.json scripts/validate-ipc.ts', '--tsconfig'],
    ['npx tsx --tsconfig tsconfig.node.json --require tsconfig-paths/register scripts/check-host-tool-contracts.ts', '--require'],
    ['node --import tsx --require tsconfig-paths/register scripts/check-oss-build-smoke.ts', '--require after --import'],
    ['cross-env FOO=1 tsx scripts/check-store-versions.ts', 'cross-env prefix'],
    ['FOO=1 tsx scripts/check-store-versions.ts', 'bare env-var prefix'],
    ['npx tsx scripts/a.ts && npx tsx scripts/b.ts', 'compound &&'],
    ['npx tsx scripts/a.ts | tee log.txt', 'pipe'],
    ['npx tsx scripts/a.ts; echo done', 'semicolon'],
    ['cd super-mcp && npm install && npm run build', 'cd + compound'],
    ['vitest run --project=desktop scripts/__tests__/mcp-release-parity.test.ts', 'vitest'],
    ['npx vitest run tests/parity', 'npx vitest'],
    ['eslint src/ --cache', 'eslint'],
    ['stylelint "src/**/*.css"', 'stylelint'],
    ['npm --prefix packages/browser-extension run build', 'npm build'],
    ['node scripts/bundle-node.mjs', 'plain node without --import tsx'],
    ['node -e "console.log(1)"', 'node -e'],
    ['npx tsx evals/run.ts', 'non-scripts path'],
    ['npx tsx "scripts/my file.ts"', 'quoted path'],
    ['npx tsx scripts/../evals/run.ts', 'path traversal via ..'],
    ['npx tsx scripts/checks/../../evals/run.ts', 'nested path traversal'],
  ])('falls back for %s (%s)', (command) => {
    expect(classifyCommand(command).transformable).toBe(false);
  });

  it.each([
    ['npx tsx scripts/check-store-versions.ts', 'scripts/check-store-versions.ts', []],
    ['tsx scripts/check-startup-ipc-ordering.ts', 'scripts/check-startup-ipc-ordering.ts', []],
    ['node --import tsx scripts/check-migration-classification.ts', 'scripts/check-migration-classification.ts', []],
    ['npx tsx scripts/check-cross-surface-imports.ts --expected-count=6', 'scripts/check-cross-surface-imports.ts', ['--expected-count=6']],
    ['npx tsx scripts/generate-super-mcp-version.ts --check', 'scripts/generate-super-mcp-version.ts', ['--check']],
    ['npx tsx scripts/check-boundary-contract-coverage.ts --enforce', 'scripts/check-boundary-contract-coverage.ts', ['--enforce']],
    ['npx tsx scripts/deferred-cleanup.ts list', 'scripts/deferred-cleanup.ts', ['list']],
  ])('transforms %s', (command, expectedScript, expectedArgs) => {
    const c = classifyCommand(command);
    expect(c.transformable).toBe(true);
    expect(c.script).toBe(expectedScript);
    expect(c.args).toEqual(expectedArgs);
  });
});

describe('resolveStepCommand', () => {
  const pkgScripts = {
    'validate:store-versions': 'npx tsx scripts/check-store-versions.ts',
    'validate:ipc': 'npx tsx --tsconfig tsconfig.node.json scripts/validate-ipc.ts',
    'validate:super-mcp-build': 'cd super-mcp && npm install && npm run build',
    'validate:hooked': 'npx tsx scripts/check-hooked.ts',
    'prevalidate:hooked': 'echo pre-hook',
  };

  function step(command: string): Step {
    return { name: 'test-step', command };
  }

  it('transforms npm run <name> wrapping a simple tsx script, preserving args', () => {
    const resolved = resolveStepCommand(step('npm run validate:store-versions'), pkgScripts);
    expect(resolved.kind).toBe('transformed');
    expect(resolved.argv).toEqual(['node', '--import', 'tsx', 'scripts/check-store-versions.ts']);
    expect(resolved.display).toBe('node --import tsx scripts/check-store-versions.ts');
  });

  it('transforms literal npx tsx step commands the same way', () => {
    const resolved = resolveStepCommand(step('npx tsx scripts/check-core-bare.ts --strict'), pkgScripts);
    expect(resolved.kind).toBe('transformed');
    expect(resolved.argv).toEqual(['node', '--import', 'tsx', 'scripts/check-core-bare.ts', '--strict']);
  });

  it('falls back verbatim for flagged, compound, unknown, and hooked npm scripts', () => {
    for (const command of [
      'npm run validate:ipc', // --tsconfig
      'npm run validate:super-mcp-build', // compound shell
      'npm run validate:does-not-exist', // unknown script
      'npm run validate:hooked', // has a pre-hook npm would run
      'npm run lint -- --fix', // extra args after the script name
      'fake command',
    ]) {
      const resolved = resolveStepCommand(step(command), pkgScripts);
      expect(resolved.kind, command).toBe('verbatim');
      expect(resolved.display, command).toBe(command);
      expect(resolved.argv, command).toBeUndefined();
    }
  });
});

describe('spawnEnvWithLocalBin', () => {
  it('prepends <repo>/node_modules/.bin to PATH with the platform delimiter', () => {
    const env = spawnEnvWithLocalBin({ PATH: '/usr/bin', HOME: '/home/x' });
    const binDir = path.join(REPO_ROOT, 'node_modules', '.bin');
    expect(env.PATH).toBe(`${binDir}${path.delimiter}/usr/bin`);
    expect(env.HOME).toBe('/home/x');
  });

  it('handles alternate PATH key casing (Windows-style Path) without duplicating keys', () => {
    const env = spawnEnvWithLocalBin({ Path: 'C:\\Windows' });
    const binDir = path.join(REPO_ROOT, 'node_modules', '.bin');
    expect(env.Path).toBe(`${binDir}${path.delimiter}C:\\Windows`);
    expect(Object.keys(env)).toEqual(['Path']);
  });

  it('sets PATH outright when the base env has none', () => {
    const env = spawnEnvWithLocalBin({});
    expect(env.PATH).toBe(path.join(REPO_ROOT, 'node_modules', '.bin'));
  });
});
