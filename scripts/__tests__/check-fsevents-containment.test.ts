/**
 * Anti-rot + non-vacuity tests for the fsevents containment guard
 * (scripts/check-fsevents-containment.ts — PLAN.md 260611_fsevents-shutdown-crash
 * Stage 3b). Fixture lockfile fragments lock the production-graph semantics:
 *   - happy shape (root → chokidar@3 → optional fsevents) passes;
 *   - dev-only fsevents paths (playwright et al.) are invisible by construction;
 *   - a NEW prod consumer of fsevents (direct or nested copy) is a violation;
 *   - a chokidar major bump is a violation (deliberate-revisit forcing);
 *   - fsevents absence is tolerated (optional dep / off-darwin lockfile prune);
 *   - unknown lockfile shape fails CLOSED;
 *   - wrapper-present half: module missing / bootstrap not importing+calling reds.
 */
import { describe, expect, it } from 'vitest';
import {
  analyzeFseventsContainment,
  checkWrapperPresence,
  packageNameFromKey,
  resolveDependencyKey,
  type LockfileLike,
} from '../check-fsevents-containment';
import { STEPS } from '../run-validate-fast';
import { GUARD_NAMES as SOURCE_POLICY_GUARDS } from '../groups/source-policy-chokepoints';

function happyLockfile(): LockfileLike {
  return {
    lockfileVersion: 3,
    packages: {
      '': {
        dependencies: { chokidar: '^3.6.0', express: '^4.0.0' },
        devDependencies: { playwright: '^1.0.0' } as never,
      },
      'node_modules/chokidar': {
        version: '3.6.0',
        dependencies: { anymatch: '~3.1.2' },
        optionalDependencies: { fsevents: '~2.3.2' },
      },
      'node_modules/anymatch': { version: '3.1.3' },
      'node_modules/express': { version: '4.19.0' },
      'node_modules/fsevents': { version: '2.3.3', optional: true },
      // Dev-only nested copy (playwright pattern) — must never be walked.
      'node_modules/playwright': {
        version: '1.40.0',
        dev: true,
        optionalDependencies: { fsevents: '2.3.2' },
      },
      'node_modules/playwright/node_modules/fsevents': { version: '2.3.2', dev: true, optional: true },
    },
  };
}

const GOOD_BOOTSTRAP = `
import { installFseventsLeakGuard } from './services/fseventsLeakGuard';
async function startApp() {
  const guardResult = installFseventsLeakGuard();
  await import('./index');
}
`;

describe('resolveDependencyKey (npm nested resolution)', () => {
  const packages = happyLockfile().packages as NonNullable<LockfileLike['packages']>;

  it('resolves a root dep to the top-level node_modules entry', () => {
    expect(resolveDependencyKey('', 'chokidar', packages)).toBe('node_modules/chokidar');
  });

  it('prefers the nearest nested copy, falling back to hoisted', () => {
    expect(resolveDependencyKey('node_modules/playwright', 'fsevents', packages)).toBe(
      'node_modules/playwright/node_modules/fsevents',
    );
    // chokidar has no nested copy → hoists to root fsevents.
    expect(resolveDependencyKey('node_modules/chokidar', 'fsevents', packages)).toBe('node_modules/fsevents');
  });

  it('returns null for a pruned/absent optional dep', () => {
    expect(resolveDependencyKey('node_modules/chokidar', 'not-a-package', packages)).toBeNull();
  });

  it('extracts scoped package names from keys', () => {
    expect(packageNameFromKey('node_modules/@scope/pkg')).toBe('@scope/pkg');
    expect(packageNameFromKey('node_modules/a/node_modules/@scope/pkg')).toBe('@scope/pkg');
  });
});

describe('analyzeFseventsContainment', () => {
  it('passes the happy shape: root -> chokidar@3 -> optional fsevents, dev paths invisible', () => {
    const analysis = analyzeFseventsContainment(happyLockfile());
    expect(analysis.violations).toEqual([]);
    expect(analysis.chokidarVersion).toBe('3.6.0');
    // Exactly the chokidar edge — the dev playwright edge must NOT appear.
    expect(analysis.fseventsEdges).toHaveLength(1);
    expect(analysis.fseventsEdges[0]).toMatchObject({
      fromName: 'chokidar',
      toKey: 'node_modules/fsevents',
    });
  });

  it('REDs on a new direct prod consumer of fsevents', () => {
    const lock = happyLockfile();
    const packages = lock.packages as NonNullable<LockfileLike['packages']>;
    packages[''] = { ...packages[''], dependencies: { ...packages[''].dependencies, fsevents: '^2.3.3' } };
    const analysis = analyzeFseventsContainment(lock);
    expect(analysis.violations.some((v) => v.includes('(root)') && v.includes('only chokidar@3.x'))).toBe(true);
  });

  it('REDs on a transitive prod consumer reaching a separate nested fsevents copy', () => {
    const lock = happyLockfile();
    const packages = lock.packages as NonNullable<LockfileLike['packages']>;
    packages[''].dependencies = { ...packages[''].dependencies, 'some-watcher': '^1.0.0' };
    packages['node_modules/some-watcher'] = {
      version: '1.0.0',
      optionalDependencies: { fsevents: '^2.3.0' },
    };
    packages['node_modules/some-watcher/node_modules/fsevents'] = { version: '2.3.1', optional: true };
    const analysis = analyzeFseventsContainment(lock);
    expect(
      analysis.violations.some(
        (v) => v.includes('some-watcher@1.0.0') && v.includes('node_modules/some-watcher/node_modules/fsevents'),
      ),
    ).toBe(true);
    // Both edges recorded: the legitimate chokidar one + the rogue one.
    expect(analysis.fseventsEdges).toHaveLength(2);
  });

  it('REDs on a chokidar major bump (forces deliberate revisit)', () => {
    const lock = happyLockfile();
    const packages = lock.packages as NonNullable<LockfileLike['packages']>;
    packages['node_modules/chokidar'] = { version: '4.0.3', dependencies: { readdirp: '^4.0.1' } };
    const analysis = analyzeFseventsContainment(lock);
    expect(analysis.violations.some((v) => v.includes('expected major 3') && v.includes('deliberate revisit'))).toBe(
      true,
    );
  });

  it('REDs when chokidar leaves the root prod deps entirely', () => {
    const lock = happyLockfile();
    const packages = lock.packages as NonNullable<LockfileLike['packages']>;
    packages[''] = { dependencies: { express: '^4.0.0' } };
    const analysis = analyzeFseventsContainment(lock);
    expect(analysis.violations.some((v) => v.includes('no longer a root production dependency'))).toBe(true);
  });

  it('tolerates fsevents absence (optional dep pruned, e.g. off-darwin lockfile)', () => {
    const lock = happyLockfile();
    const packages = lock.packages as NonNullable<LockfileLike['packages']>;
    delete packages['node_modules/fsevents'];
    delete packages['node_modules/playwright/node_modules/fsevents'];
    const analysis = analyzeFseventsContainment(lock);
    expect(analysis.violations).toEqual([]);
    expect(analysis.fseventsEdges).toEqual([]);
  });

  it('fails CLOSED on an unknown lockfile shape (no packages map)', () => {
    const analysis = analyzeFseventsContainment({ lockfileVersion: 1 });
    expect(analysis.violations).toHaveLength(1);
    expect(analysis.violations[0]).toContain('not the v2/v3 shape');
  });
});

describe('checkWrapperPresence', () => {
  it('passes when the wrapper exists and bootstrap imports + calls the installer', () => {
    expect(checkWrapperPresence({ wrapperExists: true, bootstrapSource: GOOD_BOOTSTRAP })).toEqual([]);
  });

  it('REDs when the wrapper module is missing', () => {
    const violations = checkWrapperPresence({ wrapperExists: false, bootstrapSource: GOOD_BOOTSTRAP });
    expect(violations.some((v) => v.includes('fseventsLeakGuard.ts is missing'))).toBe(true);
  });

  it('REDs when bootstrap stops importing the installer', () => {
    const violations = checkWrapperPresence({
      wrapperExists: true,
      bootstrapSource: 'async function startApp() { await import("./index"); }',
    });
    expect(violations.some((v) => v.includes('installFseventsLeakGuard'))).toBe(true);
  });

  it('REDs when bootstrap imports but never calls the installer', () => {
    const violations = checkWrapperPresence({
      wrapperExists: true,
      bootstrapSource: "import { installFseventsLeakGuard } from './services/fseventsLeakGuard';\n",
    });
    expect(violations.some((v) => v.includes('no longer calls installFseventsLeakGuard'))).toBe(true);
  });

  it('REDs when bootstrap is unreadable', () => {
    const violations = checkWrapperPresence({ wrapperExists: true, bootstrapSource: null });
    expect(violations.some((v) => v.includes('missing/unreadable'))).toBe(true);
  });

  it('REDs when import + call exist only in comments (stage-3 review F2: executed code only)', () => {
    const commentedOut = [
      "// import { installFseventsLeakGuard } from './services/fseventsLeakGuard';",
      '/*',
      '  const guardResult = installFseventsLeakGuard();',
      '*/',
      "async function startApp() { await import('./index'); }",
    ].join('\n');
    const violations = checkWrapperPresence({ wrapperExists: true, bootstrapSource: commentedOut });
    expect(violations.some((v) => v.includes('installFseventsLeakGuard'))).toBe(true);
  });

  it('REDs when only the CALL is commented out (live import, dead call)', () => {
    const deadCall =
      "import { installFseventsLeakGuard } from './services/fseventsLeakGuard';\n" +
      '// installFseventsLeakGuard();\n' +
      "async function startApp() { await import('./index'); }\n";
    const violations = checkWrapperPresence({ wrapperExists: true, bootstrapSource: deadCall });
    expect(violations.some((v) => v.includes('no longer calls installFseventsLeakGuard'))).toBe(true);
  });
});

describe('validate-chain wiring', () => {
  it('is wired into validate:fast via the source-policy-chokepoints group', () => {
    expect(STEPS.map((step) => step.name)).toContain('validate:source-policy-chokepoints');
    expect(SOURCE_POLICY_GUARDS).toContain('check-fsevents-containment');
  });
});
