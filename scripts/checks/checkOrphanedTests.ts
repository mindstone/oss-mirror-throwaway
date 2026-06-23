/**
 * Orphaned-test detection guard (Stage 3 of docs/plans/260610_testing-recs-drain).
 *
 * Kills the silent-dead-suite class: a `*.test.*` / `*.spec.*` file that NO
 * test runner picks up (the #36 compose-card orphan shape). Every test file in
 * the repo (tracked + untracked-but-not-ignored, submodules included) must be
 * matched by at least one entry in the runner-topology registry below, or be
 * allowlisted with a rationale.
 *
 * The registry is first-class data: each entry names a runner family and a
 * matcher strategy. Vitest/Playwright configs are IMPORTED (module import via
 * tsx, not text-scraped) and their include/exclude evaluated with picomatch —
 * the same matcher vitest uses underneath. The two exceptions are documented
 * on their entries (mobile jest, package-default vitest).
 */
import { execFileSync } from 'node:child_process';

import { gitCapture } from '../lib/git-exec';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import picomatch from 'picomatch';
import type { SerializedPattern, SerializedPlaywrightConfig, SerializedPlaywrightProject } from './printPlaywrightConfig';
import type { GuardRunResult, TestingGuardModule } from './types';

/** Files we consider "test files" for orphan purposes (universe filter). */
export const TEST_FILE_RE = /\.(test|spec)\.[cm]?[jt]sx?$/;

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// ---------------------------------------------------------------------------
// Runner-topology registry (first-class data)
// ---------------------------------------------------------------------------

export type RunnerStrategy =
  /** Import a vitest config and evaluate each project's include/exclude. */
  | { readonly kind: 'vitest-config'; readonly configPath: string }
  /**
   * Discover `<parentDir>/<child>/<configFileName>` vitest configs (e.g. the
   * ~38 mcp-servers connectors) — discovered, never hardcoded, so new
   * connectors are covered automatically.
   */
  | {
      readonly kind: 'vitest-config-discover';
      readonly parentDirs: readonly string[];
      readonly configFileName: string;
    }
  /** Package runs bare `vitest run` with no config: vitest defaults rooted at the package. */
  | { readonly kind: 'vitest-package-default'; readonly packageDir: string }
  /** Import a Playwright config; evaluate testDir + per-project testMatch/testIgnore. */
  | { readonly kind: 'playwright-config'; readonly configPath: string }
  /**
   * Documented static mirror of a config we cannot safely import (e.g. mobile
   * jest.config.js requires jest-expo from mobile/node_modules, which is not
   * installed in fresh worktrees). Keep in sync with the source config named
   * in `notes`.
   */
  | {
      readonly kind: 'static-globs';
      readonly root: string;
      readonly include: readonly string[];
      readonly ignoreRegexes?: readonly string[];
    }
  /** Runner executes exactly these files (e.g. a bespoke wrapper script). */
  | { readonly kind: 'enumerated-files'; readonly files: readonly string[] };

export interface RunnerRegistryEntry {
  readonly name: string;
  readonly strategy: RunnerStrategy;
  readonly notes?: string;
}

export const RUNNER_TOPOLOGY_REGISTRY: readonly RunnerRegistryEntry[] = [
  {
    name: 'root-vitest',
    strategy: { kind: 'vitest-config', configPath: 'vitest.config.ts' },
    notes:
      'Projects: desktop, cloud-service, mcp, evals, perf. Evaluated with VITEST_FAST unset (full mode) — fast mode only ADDS excludes (**/*.integration.*), so full mode is a strict superset of matched files; the A3c regression fixture guards fast-mode behaviour separately.',
  },
  {
    name: 'root-playwright',
    strategy: { kind: 'playwright-config', configPath: 'playwright.config.ts' },
    notes: 'Projects e2e/screenshots/perf/bridge-browser jointly own tests/e2e.',
  },
  {
    name: 'web-companion-vitest',
    strategy: { kind: 'vitest-config', configPath: 'web-companion/vitest.config.ts' },
  },
  {
    name: 'web-companion-playwright',
    strategy: { kind: 'playwright-config', configPath: 'web-companion/playwright.config.ts' },
  },
  {
    name: 'cloud-client-vitest',
    strategy: { kind: 'vitest-config', configPath: 'cloud-client/vitest.config.ts' },
  },
  {
    name: 'browser-extension-vitest-default',
    strategy: { kind: 'vitest-package-default', packageDir: 'packages/browser-extension' },
    notes: 'package.json `test: vitest run` with no vitest.config — vitest default include.',
  },
  {
    name: 'apple-shortcuts-vitest-default',
    strategy: {
      kind: 'vitest-package-default',
      packageDir: 'mcp-servers/connectors/apple-shortcuts',
    },
    notes: 'Only connector without its own vitest.config.ts; runs bare `vitest run`.',
  },
  {
    name: 'mobile-jest',
    strategy: {
      kind: 'static-globs',
      root: 'mobile',
      // Jest default testMatch (`**/?(*.)+(spec|test).[jt]s?(x)`) restricted to
      // our universe shape.
      include: ['**/*.{test,spec}.{js,jsx,ts,tsx}'],
      // Mirror of mobile/jest.config.js testPathIgnorePatterns (minus
      // node_modules, which the git-based universe already excludes).
      ignoreRegexes: ['__tests__/helpers\\.ts$', '__tests__/e2e\\.'],
    },
    notes:
      'Static mirror of mobile/jest.config.js — importing it needs jest-expo from mobile/node_modules (absent in fresh worktrees). Update here if its testMatch/testPathIgnorePatterns change.',
  },
  {
    name: 'mobile-live-e2e-jest',
    strategy: {
      kind: 'enumerated-files',
      files: ['mobile/src/__tests__/e2e.integration.test.ts'],
    },
    notes:
      'mobile/scripts/run-live-e2e-jest.mjs runs exactly this file with --testPathIgnorePatterns=[] (jest-ignored in the normal mobile-jest run).',
  },
  {
    name: 'mcp-servers-vitest',
    strategy: {
      kind: 'vitest-config-discover',
      parentDirs: ['mcp-servers/connectors', 'mcp-servers/packages'],
      configFileName: 'vitest.config.ts',
    },
  },
  {
    name: 'mcp-servers-test-harness-vitest',
    strategy: { kind: 'vitest-config', configPath: 'mcp-servers/test-harness/vitest.config.ts' },
  },
  {
    name: 'super-mcp-vitest',
    strategy: { kind: 'vitest-config', configPath: 'super-mcp/vitest.config.ts' },
  },
  {
    name: 'meeting-bot-worker-vitest',
    strategy: { kind: 'vitest-config', configPath: 'meeting-bot-worker/vitest.config.ts' },
  },
];

// ---------------------------------------------------------------------------
// Allowlist (intentional non-runner test files — every entry needs a rationale)
// ---------------------------------------------------------------------------

export interface OrphanAllowlistEntry {
  readonly path: string;
  readonly rationale: string;
}

export const ORPHAN_ALLOWLIST: readonly OrphanAllowlistEntry[] = [
  {
    path: 'rebel-system/skills/coding/build-custom-mcp-server/references/starter-template/test/smoke.test.mjs',
    rationale:
      'Template scaffolding, not a repo test: shipped inside the build-custom-mcp-server skill reference and only ever run inside a project generated from the starter template.',
  },
];

// ---------------------------------------------------------------------------
// Universe collection (git-based: respects .gitignore, excludes node_modules)
// ---------------------------------------------------------------------------

function gitLines(args: readonly string[], cwd: string): string[] {
  const out = gitCapture([...args], { cwd, maxBuffer: 64 * 1024 * 1024 });
  return out.split('\0').filter((line) => line.length > 0);
}

function submodulePaths(repoRoot: string): string[] {
  const gitmodules = path.join(repoRoot, '.gitmodules');
  if (!fs.existsSync(gitmodules)) return [];
  const out = gitCapture(['config', '--file', '.gitmodules', '--get-regexp', String.raw`\.path$`], {
    cwd: repoRoot,
  });
  return out
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.split(' ').slice(1).join(' '));
}

/**
 * All test files git knows about or could know about: tracked files
 * (recursing into initialized submodules) plus untracked-but-not-ignored
 * files (root and each initialized submodule). Uninitialized submodules are
 * skipped — their contents are not present to orphan-check.
 */
export function collectTestFileUniverse(repoRoot = REPO_ROOT): string[] {
  const files = new Set<string>();
  for (const file of gitLines(['ls-files', '--recurse-submodules', '-z'], repoRoot)) {
    if (TEST_FILE_RE.test(file)) files.add(file);
  }
  for (const file of gitLines(['ls-files', '--others', '--exclude-standard', '-z'], repoRoot)) {
    if (TEST_FILE_RE.test(file)) files.add(file);
  }
  for (const sub of submodulePaths(repoRoot)) {
    const subAbs = path.join(repoRoot, sub);
    // Initialized submodules have a .git file/dir in their working tree.
    if (!fs.existsSync(path.join(subAbs, '.git'))) continue;
    for (const file of gitLines(['ls-files', '--others', '--exclude-standard', '-z'], subAbs)) {
      if (TEST_FILE_RE.test(file)) files.add(`${sub}/${file}`);
    }
  }
  return [...files].sort((a, b) => a.localeCompare(b));
}

// ---------------------------------------------------------------------------
// Runner resolution: registry entry -> concrete matchers
// ---------------------------------------------------------------------------

export interface ResolvedRunner {
  /** Registry entry name (suffixed with the config path for discovered configs). */
  readonly name: string;
  /** Repo-relative root the runner's patterns are anchored at ('' = repo root). */
  readonly rootRel: string;
  matches(repoRelPath: string): boolean;
}

const VITEST_DEFAULT_INCLUDE = ['**/*.{test,spec}.?(c|m)[jt]s?(x)'] as const;
const VITEST_DEFAULT_EXCLUDE = ['**/node_modules/**', '**/dist/**'] as const;
const PLAYWRIGHT_DEFAULT_TEST_MATCH = ['**/*.@(spec|test).?(c|m)[jt]s?(x)'] as const;

function toPosix(p: string): string {
  return p.replaceAll('\\', '/');
}

/** Path of `repoRelPath` relative to `rootRel`, or null when outside it. */
function relativeToRoot(repoRelPath: string, rootRel: string): string | null {
  if (rootRel === '' || rootRel === '.') return repoRelPath;
  const prefix = `${rootRel}/`;
  return repoRelPath.startsWith(prefix) ? repoRelPath.slice(prefix.length) : null;
}

interface GlobProjectMatcher {
  include: readonly (string | RegExp)[];
  exclude: readonly (string | RegExp)[];
}

function compilePatterns(patterns: readonly (string | RegExp)[]): ((rel: string) => boolean)[] {
  return patterns.map((pattern) => {
    if (pattern instanceof RegExp) return (rel: string) => pattern.test(rel);
    const isMatch = picomatch(pattern);
    // Bare directory excludes ('node_modules', 'dist') prune the whole
    // directory in vitest's traversal — mirror that with an appended '/**'.
    const isDirMatch = picomatch(`${pattern}/**`);
    return (rel: string) => isMatch(rel) || isDirMatch(rel);
  });
}

function makeGlobRunner(name: string, rootRel: string, projects: readonly GlobProjectMatcher[]): ResolvedRunner {
  const compiled = projects.map((project) => ({
    include: compilePatterns(project.include),
    exclude: compilePatterns(project.exclude),
  }));
  return {
    name,
    rootRel,
    matches(repoRelPath: string): boolean {
      const rel = relativeToRoot(repoRelPath, rootRel);
      if (rel === null) return false;
      return compiled.some(
        (project) =>
          project.include.some((match) => match(rel)) && !project.exclude.some((match) => match(rel)),
      );
    },
  };
}

/**
 * Evaluate a vitest config through vite's own config loader (the same
 * esbuild-based path vitest uses), which handles TS, ESM/CJS interop and
 * `__dirname` shims that a raw dynamic import does not (cloud-client's config
 * uses `__dirname` under "type":"module").
 *
 * VITEST_FAST is unset for the evaluation so the root config resolves
 * FULL-mode excludes — fast mode only ADDS excludes (`**\/*.integration.*`),
 * so full mode matches a strict superset of files and orphan coverage equals
 * the union of both modes.
 */
async function loadVitestConfigPinned(configAbs: string): Promise<unknown> {
  const savedFast = process.env.VITEST_FAST;
  delete process.env.VITEST_FAST;
  try {
    const { loadConfigFromFile } = await import('vite');
    // Cast is required because @electron-forge/plugin-vite augments vite's
    // ConfigEnv with forge-specific fields (forgeConfig, forgeConfigSelf, root)
    // that are only present at forge build time — not needed here at runtime.
    const loaded = await loadConfigFromFile(
      { command: 'serve', mode: 'test' } as Parameters<typeof loadConfigFromFile>[0],
      configAbs,
      path.dirname(configAbs),
    );
    if (!loaded) throw new Error(`could not load vitest config: ${configAbs}`);
    return loaded.config;
  } finally {
    if (savedFast === undefined) delete process.env.VITEST_FAST;
    else process.env.VITEST_FAST = savedFast;
  }
}

interface VitestProjectShape {
  test?: { include?: readonly string[]; exclude?: readonly string[] };
  include?: readonly string[];
  exclude?: readonly string[];
}

async function resolveVitestConfigRunner(name: string, configPathRel: string, repoRoot: string): Promise<ResolvedRunner> {
  const configAbs = path.join(repoRoot, configPathRel);
  const config = (await loadVitestConfigPinned(configAbs)) as {
    test?: { projects?: readonly VitestProjectShape[]; include?: readonly string[]; exclude?: readonly string[] };
  };
  const rootRel = toPosix(path.dirname(configPathRel)) === '.' ? '' : toPosix(path.dirname(configPathRel));
  const rawProjects: readonly VitestProjectShape[] = config?.test?.projects ?? [config?.test ?? {}];
  const projects = rawProjects.map((project) => {
    const test = project?.test ?? project ?? {};
    return {
      include: test.include ?? VITEST_DEFAULT_INCLUDE,
      exclude: test.exclude ?? VITEST_DEFAULT_EXCLUDE,
    };
  });
  return makeGlobRunner(name, rootRel, projects);
}

function deserializePatterns(
  value: readonly SerializedPattern[] | undefined,
  fallback: readonly (string | RegExp)[],
): readonly (string | RegExp)[] {
  if (value === undefined) return fallback;
  return value.map((pattern) =>
    typeof pattern === 'string' ? pattern : new RegExp(pattern.regexSource, pattern.regexFlags),
  );
}

/**
 * Playwright configs are evaluated in a SUBPROCESS each (via
 * printPlaywrightConfig.ts): `@playwright/test` enforces require-once per
 * process, and the root config + web-companion's config resolve two different
 * playwright copies, which would throw if imported into this process.
 */
function resolvePlaywrightConfigRunner(name: string, configPathRel: string, repoRoot: string): ResolvedRunner[] {
  const helperAbs = path.join(repoRoot, 'scripts', 'checks', 'printPlaywrightConfig.ts');
  const configAbs = path.join(repoRoot, configPathRel);
  const stdout = execFileSync('npx', ['tsx', helperAbs, configAbs], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  const config = JSON.parse(stdout) as SerializedPlaywrightConfig;
  const configDirRel = toPosix(path.dirname(configPathRel));
  const projects: readonly SerializedPlaywrightProject[] = config.projects.length ? config.projects : [{}];
  return projects.map((project, index) => {
    const testDir = toPosix(
      path.normalize(path.posix.join(configDirRel === '.' ? '' : configDirRel, project.testDir ?? config.testDir ?? '.')),
    );
    const rootRel = testDir === '.' ? '' : testDir;
    return makeGlobRunner(`${name}#${index}`, rootRel, [
      {
        include: deserializePatterns(project.testMatch ?? config.testMatch, PLAYWRIGHT_DEFAULT_TEST_MATCH),
        exclude: deserializePatterns(project.testIgnore ?? config.testIgnore, []),
      },
    ]);
  });
}

function discoverConfigPaths(parentDirs: readonly string[], configFileName: string, repoRoot: string): string[] {
  const found: string[] = [];
  for (const parent of parentDirs) {
    const parentAbs = path.join(repoRoot, parent);
    if (!fs.existsSync(parentAbs)) continue;
    for (const entry of fs.readdirSync(parentAbs, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const candidate = path.join(parentAbs, entry.name, configFileName);
      if (fs.existsSync(candidate)) found.push(`${parent}/${entry.name}/${configFileName}`);
    }
  }
  return found.sort((a, b) => a.localeCompare(b));
}

export async function resolveRunners(
  repoRoot = REPO_ROOT,
  registry: readonly RunnerRegistryEntry[] = RUNNER_TOPOLOGY_REGISTRY,
): Promise<ResolvedRunner[]> {
  const runners: ResolvedRunner[] = [];
  for (const entry of registry) {
    const { strategy } = entry;
    switch (strategy.kind) {
      case 'vitest-config':
        runners.push(await resolveVitestConfigRunner(entry.name, strategy.configPath, repoRoot));
        break;
      case 'vitest-config-discover':
        for (const configPath of discoverConfigPaths(strategy.parentDirs, strategy.configFileName, repoRoot)) {
          runners.push(await resolveVitestConfigRunner(`${entry.name}:${path.dirname(configPath)}`, configPath, repoRoot));
        }
        break;
      case 'vitest-package-default':
        runners.push(
          makeGlobRunner(entry.name, strategy.packageDir, [
            { include: VITEST_DEFAULT_INCLUDE, exclude: VITEST_DEFAULT_EXCLUDE },
          ]),
        );
        break;
      case 'playwright-config':
        runners.push(...resolvePlaywrightConfigRunner(entry.name, strategy.configPath, repoRoot));
        break;
      case 'static-globs': {
        const ignoreRegexes = (strategy.ignoreRegexes ?? []).map((source) => new RegExp(source));
        const globRunner = makeGlobRunner(entry.name, strategy.root, [
          { include: strategy.include, exclude: [] },
        ]);
        runners.push({
          name: entry.name,
          rootRel: strategy.root,
          matches: (repoRelPath) =>
            globRunner.matches(repoRelPath) && !ignoreRegexes.some((re) => re.test(repoRelPath)),
        });
        break;
      }
      case 'enumerated-files': {
        const fileSet = new Set(strategy.files);
        runners.push({
          name: entry.name,
          rootRel: '',
          matches: (repoRelPath) => fileSet.has(repoRelPath),
        });
        break;
      }
    }
  }
  return runners;
}

// ---------------------------------------------------------------------------
// Orphan detection (pure — unit-testable with synthetic inputs)
// ---------------------------------------------------------------------------

export interface OrphanFinding {
  readonly file: string;
  readonly hint: string;
}

export interface OrphanCheckOutcome {
  readonly orphans: readonly OrphanFinding[];
  readonly staleAllowlist: readonly string[];
  readonly scanned: number;
}

function nearestRunnerHint(file: string, runners: readonly ResolvedRunner[]): string {
  let best: ResolvedRunner | undefined;
  for (const runner of runners) {
    if (runner.rootRel !== '' && !file.startsWith(`${runner.rootRel}/`)) continue;
    if (!best || runner.rootRel.length > best.rootRel.length) best = runner;
  }
  if (!best) return 'no runner family covers this path at all';
  return `nearest runner: ${best.name} (root: ${best.rootRel === '' ? '<repo root>' : best.rootRel}) — extend its include patterns, or allowlist with a rationale in scripts/checks/checkOrphanedTests.ts`;
}

export function findOrphans(input: {
  universe: readonly string[];
  runners: readonly ResolvedRunner[];
  allowlist: readonly OrphanAllowlistEntry[];
}): OrphanCheckOutcome {
  const { universe, runners, allowlist } = input;
  const allowlisted = new Set(allowlist.map((entry) => entry.path));
  const orphans: OrphanFinding[] = [];
  const matchedFiles = new Set<string>();

  for (const file of universe) {
    const matched = runners.some((runner) => runner.matches(file));
    if (matched) matchedFiles.add(file);
    if (matched || allowlisted.has(file)) continue;
    orphans.push({ file, hint: nearestRunnerHint(file, runners) });
  }

  // Allowlist hygiene: an entry whose file is present AND matched by a runner
  // is stale (no longer an orphan). Entries for absent files are tolerated —
  // the file may live in an uninitialized submodule on this machine.
  const universeSet = new Set(universe);
  const staleAllowlist = allowlist
    .filter((entry) => universeSet.has(entry.path) && matchedFiles.has(entry.path))
    .map((entry) => entry.path);

  return { orphans, staleAllowlist, scanned: universe.length };
}

// ---------------------------------------------------------------------------
// Guard module
// ---------------------------------------------------------------------------

export async function runOrphanedTestsCheck(repoRoot = REPO_ROOT): Promise<GuardRunResult> {
  const failures: string[] = [];
  for (const entry of ORPHAN_ALLOWLIST) {
    if (!entry.rationale || entry.rationale.trim().length === 0) {
      failures.push(`allowlist entry '${entry.path}' has no rationale — every intentional exclusion must say why.`);
    }
  }

  const universe = collectTestFileUniverse(repoRoot);
  const runners = await resolveRunners(repoRoot);
  const outcome = findOrphans({ universe, runners, allowlist: ORPHAN_ALLOWLIST });

  for (const orphan of outcome.orphans) {
    failures.push(`ORPHANED TEST (no runner executes it): ${orphan.file}\n    ${orphan.hint}`);
  }
  for (const stale of outcome.staleAllowlist) {
    failures.push(
      `stale allowlist entry: ${stale} is now matched by a runner — remove it from ORPHAN_ALLOWLIST in scripts/checks/checkOrphanedTests.ts.`,
    );
  }

  return {
    ok: failures.length === 0,
    failures,
    summary: `scanned ${outcome.scanned} test files against ${runners.length} resolved runners (${ORPHAN_ALLOWLIST.length} allowlisted); ${outcome.orphans.length} orphan(s).`,
  };
}

export const orphanedTestsGuard: TestingGuardModule = {
  name: 'orphaned-tests',
  run: () => runOrphanedTestsCheck(),
};
