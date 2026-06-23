/**
 * Unit + integration coverage for the orphaned-tests guard
 * (scripts/checks/checkOrphanedTests.ts, Stage 3 of
 * docs/plans/260610_testing-recs-drain).
 *
 * Matcher semantics are tested two ways:
 *  - pure: findOrphans with synthetic runners/universe;
 *  - real topology: resolveRunners against the actual registry (real vitest /
 *    playwright configs), asserting known-covered files match, the mcp-project
 *    delegation holds, and the forced-RED probe location (tests/probe/) is
 *    matched by NOTHING — which is what makes the probe a valid RED.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import {
  ORPHAN_ALLOWLIST,
  RUNNER_TOPOLOGY_REGISTRY,
  TEST_FILE_RE,
  collectTestFileUniverse,
  findOrphans,
  resolveRunners,
  runOrphanedTestsCheck,
  type ResolvedRunner,
  type RunnerRegistryEntry,
} from '../checks/checkOrphanedTests';

function syntheticRunner(name: string, rootRel: string, matched: readonly string[]): ResolvedRunner {
  const set = new Set(matched);
  return { name, rootRel, matches: (file) => set.has(file) };
}

describe('TEST_FILE_RE (universe filter)', () => {
  it.each([
    ['src/foo.test.ts', true],
    ['src/foo.spec.tsx', true],
    ['scripts/__tests__/rewrite-session-images.test.mjs', true],
    ['a/b.test.cts', true],
    ['scripts/__tests__/__snapshots__/ci-investigate.test.ts.snap', false],
    ['src/foo.ts', false],
    ['docs/testing.md', false],
  ])('%s -> %s', (file, expected) => {
    expect(TEST_FILE_RE.test(file)).toBe(expected);
  });
});

describe('findOrphans (pure matcher semantics)', () => {
  const runners = [
    syntheticRunner('root', '', ['covered/a.test.ts']),
    syntheticRunner('deep', 'pkg/sub', ['pkg/sub/b.test.ts']),
  ];

  it('does not flag files matched by a runner', () => {
    const outcome = findOrphans({
      universe: ['covered/a.test.ts', 'pkg/sub/b.test.ts'],
      runners,
      allowlist: [],
    });
    expect(outcome.orphans).toEqual([]);
    expect(outcome.scanned).toBe(2);
  });

  it('flags unmatched files with the nearest (deepest-root) runner hint', () => {
    const outcome = findOrphans({
      universe: ['pkg/sub/orphan.test.ts'],
      runners,
      allowlist: [],
    });
    expect(outcome.orphans).toHaveLength(1);
    expect(outcome.orphans[0].file).toBe('pkg/sub/orphan.test.ts');
    expect(outcome.orphans[0].hint).toContain('deep');
    expect(outcome.orphans[0].hint).toContain('pkg/sub');
  });

  it('allowlisted unmatched files are not orphans', () => {
    const outcome = findOrphans({
      universe: ['stray.test.ts'],
      runners,
      allowlist: [{ path: 'stray.test.ts', rationale: 'intentional' }],
    });
    expect(outcome.orphans).toEqual([]);
    expect(outcome.staleAllowlist).toEqual([]);
  });

  it('an allowlist entry whose file is now matched is reported stale', () => {
    const outcome = findOrphans({
      universe: ['covered/a.test.ts'],
      runners,
      allowlist: [{ path: 'covered/a.test.ts', rationale: 'was an orphan once' }],
    });
    expect(outcome.staleAllowlist).toEqual(['covered/a.test.ts']);
  });

  it('an allowlist entry for an absent file is tolerated (uninitialized submodule)', () => {
    const outcome = findOrphans({
      universe: [],
      runners,
      allowlist: [{ path: 'rebel-system/somewhere.test.mjs', rationale: 'template' }],
    });
    expect(outcome.orphans).toEqual([]);
    expect(outcome.staleAllowlist).toEqual([]);
  });
});

describe('resolveRunners (strategy semantics, synthetic registry)', () => {
  it('static-globs applies include globs and ignore regexes (mobile jest mirror)', async () => {
    const registry: RunnerRegistryEntry[] = [
      {
        name: 'jest-mirror',
        strategy: {
          kind: 'static-globs',
          root: 'mobile',
          include: ['**/*.{test,spec}.{js,jsx,ts,tsx}'],
          ignoreRegexes: ['__tests__/e2e\\.'],
        },
      },
    ];
    const [runner] = await resolveRunners(process.cwd(), registry);
    expect(runner.matches('mobile/src/__tests__/meetingHealthIndicator.test.ts')).toBe(true);
    // e2ePairRoute does NOT match the `__tests__/e2e\.` ignore (no dot after e2e).
    expect(runner.matches('mobile/src/__tests__/e2ePairRoute.test.tsx')).toBe(true);
    expect(runner.matches('mobile/src/__tests__/e2e.integration.test.ts')).toBe(false);
    expect(runner.matches('outside/mobile-ish.test.ts')).toBe(false);
  });

  it('enumerated-files matches exactly the listed files', async () => {
    const registry: RunnerRegistryEntry[] = [
      {
        name: 'wrapper',
        strategy: { kind: 'enumerated-files', files: ['mobile/src/__tests__/e2e.integration.test.ts'] },
      },
    ];
    const [runner] = await resolveRunners(process.cwd(), registry);
    expect(runner.matches('mobile/src/__tests__/e2e.integration.test.ts')).toBe(true);
    expect(runner.matches('mobile/src/__tests__/e2e.other.test.ts')).toBe(false);
  });

  it('vitest-package-default covers package-rooted test files and excludes node_modules', async () => {
    const registry: RunnerRegistryEntry[] = [
      { name: 'pkg-default', strategy: { kind: 'vitest-package-default', packageDir: 'packages/browser-extension' } },
    ];
    const [runner] = await resolveRunners(process.cwd(), registry);
    expect(runner.matches('packages/browser-extension/tests/unit/popup.test.tsx')).toBe(true);
    expect(runner.matches('packages/browser-extension/__tests__/intents-migration.test.ts')).toBe(true);
    expect(runner.matches('packages/browser-extension/node_modules/dep/x.test.ts')).toBe(false);
    expect(runner.matches('src/elsewhere.test.ts')).toBe(false);
  });
});

describe('resolveRunners (real runner-topology registry)', () => {
  // Resolving imports the real vitest configs (via vite's loader) and spawns a
  // subprocess per playwright config — do it once for all assertions.
  let runners: ResolvedRunner[];
  const matchedBy = (file: string): string[] =>
    runners.filter((runner) => runner.matches(file)).map((runner) => runner.name);

  beforeAll(async () => {
    runners = await resolveRunners(process.cwd(), RUNNER_TOPOLOGY_REGISTRY);
  }, 120_000);

  it('the desktop scripts/__tests__ glob covers this very test file (new guard tests auto-included)', () => {
    expect(matchedBy('scripts/__tests__/checkOrphanedTests.test.ts')).toContain('root-vitest');
  });

  it('mcp-project suites are covered (desktop excludes them, mcp project includes them)', () => {
    expect(matchedBy('scripts/__tests__/mcp-smoke.test.ts')).toContain('root-vitest');
  });

  it('sub-package delegation: connector vitest configs cover their test trees', () => {
    expect(matchedBy('mcp-servers/connectors/xero/test/synthetic.test.ts').join(',')).toContain(
      'mcp-servers-vitest:mcp-servers/connectors/xero',
    );
    expect(matchedBy('super-mcp/test/synthetic.test.ts')).toContain('super-mcp-vitest');
  });

  it('playwright owns tests/e2e specs', () => {
    expect(matchedBy('tests/e2e/synthetic.spec.ts').some((name) => name.startsWith('root-playwright'))).toBe(true);
    expect(matchedBy('web-companion/tests/synthetic.spec.ts').some((name) => name.startsWith('web-companion-playwright'))).toBe(true);
  });

  it('forced-RED probe topology: tests/probe/ is matched by NO runner', () => {
    // This is what makes tests/probe/orphan-probe.test.ts a valid forced-RED
    // location for the guard. If a runner ever starts matching tests/probe/,
    // pick a new probe location.
    expect(matchedBy('tests/probe/orphan-probe.test.ts')).toEqual([]);
  });
});

describe('runOrphanedTestsCheck (whole-repo invariant)', () => {
  it('current tree has zero orphans and no stale allowlist entries', async () => {
    const result = await runOrphanedTestsCheck();
    expect(result.failures).toEqual([]);
    expect(result.ok).toBe(true);
  }, 120_000);

  it('every allowlist entry carries a non-empty rationale', () => {
    for (const entry of ORPHAN_ALLOWLIST) {
      expect(entry.rationale.trim().length, `allowlist entry ${entry.path}`).toBeGreaterThan(20);
    }
  });

  it('the universe walker sees the repo (sanity floor) and excludes node_modules', () => {
    const universe = collectTestFileUniverse();
    expect(universe.length).toBeGreaterThan(2000);
    expect(universe.every((file) => !file.includes('node_modules/'))).toBe(true);
    expect(universe.every((file) => TEST_FILE_RE.test(file))).toBe(true);
  });
});
