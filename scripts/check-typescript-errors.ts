#!/usr/bin/env tsx
/**
 * TypeScript error ratchet — prevents new type errors from being introduced.
 *
 * Baselines represent the current error count per project. If a project exceeds
 * its baseline, the script fails. When you fix errors, lower the baseline!
 *
 * The tsc invocations are independent and run through a small concurrency pool.
 * We use all-settled aggregation (not Promise.all) so a failure on one side does
 * NOT short-circuit the others — every error count is reported every run so
 * regressions in any project are always visible.
 *
 * Usage: npx tsx scripts/check-typescript-errors.ts [--repeat=N]
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

export interface ProjectConfig {
  name: string;
  tsconfig: string;
  baseline: number;
}

export interface ProjectRunResult {
  project: ProjectConfig;
  errorCount: number;
}

export interface ProjectSummary {
  project: ProjectConfig;
  maxErrorCount: number | null;
  rejectionReasons: unknown[];
}

export interface RatchetRunResult {
  failed: boolean;
  summaries: ProjectSummary[];
}

export interface RatchetRunOptions {
  concurrency?: number;
  repeat?: number;
  report?: boolean;
  logger?: Pick<Console, 'error' | 'log' | 'warn'>;
}

// TS-RATCHET: Node debt fully paid down at sync 2026-05-22. The previous
// baseline of 17 covered ImageRef fixture drift (`mimeType`/`byteSize`
// required), `vi.Mocked` namespace usage, a 0-arity `mockSpawn` stub, two
// `OwnerKind: 'gui'` references (renamed to `'desktop'`), and four
// `hookSpecificOutput` accesses needing a `SyncHookJSONOutput` cast. All
// resolved in the test files; production types untouched. DO NOT raise this
// without understanding which class is being added.
// TS-RATCHET (2026-05-26): Node baselined-1 from `src/core/services/agentTurnService.ts:261`
// passing `activeSpacePath` to `AgentLoopOptions` (Stage 4 operators commit `2abe032865`)
// is now resolved; Node is back to 0. Evals/Cloud-service/Cloud-service-test were never
// elevated past 0 in this branch. Lowered to 0 by hotspot-refactor-roadmap follow-up.
// TS-RATCHET (2026-05-27): Renderer baseline lowered from 5 to 0 after restoring the
// missing `ATLAS_CONFIG.forces` block in `src/renderer/features/atlas/utils/atlasConfig.ts`.
// The original 5 errors were from `AtlasCanvas.tsx:1258-1270` referencing
// `ATLAS_CONFIG.forces.{linkDistance,linkStrength,chargeStrength,chargeMaxDistance,centerStrength}`,
// introduced by atlas refactor commit `31dcb56006` (file-vector materialization) which
// added the force-tuning useEffect without restoring the config block it reads. Values
// pinned to d3-force library defaults (the try/catch around the tuning code was already
// silently falling back to those defaults via `undefined` reads, so this is behavior-
// preserving on the happy path and behavior-correct in the runtime-error path).
export const NODE_ERROR_BASELINE = 0;
export const RENDERER_ERROR_BASELINE = 0;
export const EVALS_ERROR_BASELINE = 0;
export const CLOUD_SERVICE_ERROR_BASELINE = 0;
export const CLOUD_SERVICE_TEST_ERROR_BASELINE = 0;
export const CLOUD_CLIENT_ERROR_BASELINE = 0;
export const CLOUD_CLIENT_TEST_ERROR_BASELINE = 0;
export const WEB_COMPANION_ERROR_BASELINE = 0;
export const WEB_COMPANION_TEST_ERROR_BASELINE = 0;
export const PACKAGES_SHARED_ERROR_BASELINE = 0;
// packages-shared-test (260623): packages/shared TEST files were typechecked
// NOWHERE — packages/shared/tsconfig.json (the `packages-shared` project above)
// excludes all test globs, and unlike cloud-service/cloud-client/web-companion
// there was no paired `-test` project. Two errors had accumulated silently: a
// `managedModelMeta` shape-drift in humanizeAgentError.test.ts and a tsc-only
// `@shared/utils/authRequiredSignal` resolution gap (the test runs green at
// runtime via vitest.config.ts's `@shared` alias, but the prod tsconfig — kept
// strict so @rebel/shared cannot depend on desktop `src/shared` — has no such
// path). `packages/shared/tsconfig.test.json` re-includes the test globs and
// scopes a `@shared/*` path to TESTS ONLY (prod layering stays strict). The
// `packages-shared-test` project below gates that surface at baseline 0 so any
// future test type debt fails this ratchet by construction. See
// docs/plans/260623_packages-shared-typecheck-gate/PLAN.md.
export const PACKAGES_SHARED_TEST_ERROR_BASELINE = 0;
export const BROWSER_EXTENSION_ERROR_BASELINE = 0;
// mobile 2 → 0 (260614): the two strict-mode errors that arrived with
// @rudderstack/rudder-sdk-react-native (260613, mobile analytics) are both
// resolved by adding `@types/async-lock` as a mobile devDependency. The SDK's
// `react-native` field points at `./src/index.ts`, so tsc type-checks the SDK's
// OWN source (skipLibCheck doesn't cover .ts; a paths→.d.ts override doesn't
// help because index.esm.d.ts re-exports ./src). Both errors live in
// RudderClient.ts and stem from the same untyped dependency: (2,23) TS7016 was
// the missing `async-lock` declaration directly, and (119,46) TS7006 was the
// `done` callback param — implicit-any ONLY because `lock.acquire(...)` was
// untyped. Typing async-lock fixes both. Verified: tsc -p mobile/tsconfig.json
// → 0 errors. See docs/plans/260614_mobile-ts-baseline-tighten/PLAN.md.
//
// VERIFY MOBILE WITH THE ROOT COMPILER, e.g. `npx tsc -p mobile/tsconfig.json`
// (root TS is 6.x — the same compiler this ratchet spawns). `mobile`-local tsc is
// pinned `~5.9` (expo compat) and FAILS with TS5103 on mobile/tsconfig.json's
// `ignoreDeprecations: "6.0"` before reaching any real error — so don't trust
// `cd mobile && tsc`; it's a different compiler than CI/this ratchet uses.
// (No clean by-construction fix: bumping mobile's TS has expo/Metro blast radius;
// dropping ignoreDeprecations would break the root compiler. Signpost over churn.)
//
// mobile-test (260623): mobile TEST files were typechecked NOWHERE — they are
// excluded from mobile/tsconfig.json, and the `mobile` project above only checks
// the production surface. A branded-id type-error class (live-meeting ids) silently
// accumulated in the test files as a result. `mobile/tsconfig.test.json` extends
// mobile/tsconfig.json (so it INHERITS `ignoreDeprecations: "6.0"` and the same
// root-tsc 6.x requirement above) and re-includes the test globs. The `mobile-test`
// project below gates that surface at baseline 0, so any future mobile-test type
// debt fails this ratchet by construction. RUN IT FROM REPO ROOT (root tsc 6.x) —
// `cd mobile && tsc` uses mobile-local tsc ~5.9 and fails TS5103 on the inherited
// `"6.0"` value before reaching any real error. See
// docs/plans/260623_mobile-typecheck-gate/PLAN.md.
export const MOBILE_ERROR_BASELINE = 0;
export const MOBILE_TEST_ERROR_BASELINE = 0;
// scripts/ adoption (260609): type-check the standalone scripts/ CLIs that the
// tsconfig.node.json allowlist never covered. Baseline 0 — files with a
// pre-existing error backlog are quarantined in tsconfig.scripts.json's exclude
// list (a shrinking TODO), so every CHECKED script is strictly clean.
export const SCRIPTS_ERROR_BASELINE = 0;

export const PROJECTS: ProjectConfig[] = [
  {
    name: 'node',
    tsconfig: 'tsconfig.node.json',
    baseline: NODE_ERROR_BASELINE,
  },
  {
    name: 'renderer',
    tsconfig: 'tsconfig.renderer.json',
    baseline: RENDERER_ERROR_BASELINE,
  },
  {
    name: 'evals',
    tsconfig: 'tsconfig.evals.json',
    baseline: EVALS_ERROR_BASELINE,
  },
  {
    name: 'cloud-service',
    tsconfig: 'cloud-service/tsconfig.json',
    baseline: CLOUD_SERVICE_ERROR_BASELINE,
  },
  {
    name: 'cloud-service-test',
    tsconfig: 'cloud-service/tsconfig.test.json',
    baseline: CLOUD_SERVICE_TEST_ERROR_BASELINE,
  },
  {
    name: 'cloud-client',
    tsconfig: 'cloud-client/tsconfig.json',
    baseline: CLOUD_CLIENT_ERROR_BASELINE,
  },
  {
    name: 'cloud-client-test',
    tsconfig: 'cloud-client/tsconfig.test.json',
    baseline: CLOUD_CLIENT_TEST_ERROR_BASELINE,
  },
  {
    name: 'web-companion',
    tsconfig: 'web-companion/tsconfig.json',
    baseline: WEB_COMPANION_ERROR_BASELINE,
  },
  {
    name: 'web-companion-test',
    tsconfig: 'web-companion/tsconfig.test.json',
    baseline: WEB_COMPANION_TEST_ERROR_BASELINE,
  },
  {
    name: 'packages-shared',
    tsconfig: 'packages/shared/tsconfig.json',
    baseline: PACKAGES_SHARED_ERROR_BASELINE,
  },
  {
    name: 'packages-shared-test',
    tsconfig: 'packages/shared/tsconfig.test.json',
    baseline: PACKAGES_SHARED_TEST_ERROR_BASELINE,
  },
  {
    name: 'browser-extension',
    tsconfig: 'packages/browser-extension/tsconfig.json',
    baseline: BROWSER_EXTENSION_ERROR_BASELINE,
  },
  {
    name: 'mobile',
    tsconfig: 'mobile/tsconfig.json',
    baseline: MOBILE_ERROR_BASELINE,
  },
  {
    name: 'mobile-test',
    tsconfig: 'mobile/tsconfig.test.json',
    baseline: MOBILE_TEST_ERROR_BASELINE,
  },
  {
    name: 'scripts',
    tsconfig: 'tsconfig.scripts.json',
    baseline: SCRIPTS_ERROR_BASELINE,
  },
];

const MAX_ENV_CONCURRENCY = 32;
const TSC_ERROR_PATTERN = /error TS\d+:/g;

function displayName(project: ProjectConfig): string {
  return project.name.charAt(0).toUpperCase() + project.name.slice(1);
}

// The directory whose `node_modules` to reinstall for a given project's tsconfig,
// used only in the remediation hint. A tsconfig at the repo root (e.g.
// `tsconfig.scripts.json`) maps to `.`; a nested one (`mobile/tsconfig.json`,
// `packages/browser-extension/tsconfig.json`) maps to its containing directory.
export function installDirForTsconfig(tsconfig: string): string {
  const dir = path.dirname(tsconfig);
  return dir === '' || dir === '.' ? '.' : dir;
}

function chunkToString(chunk: Buffer | string): string {
  return typeof chunk === 'string' ? chunk : chunk.toString('utf8');
}

export function countTypescriptErrors(stdout: string, stderr: string): number {
  const joinedOutput = `${stdout}\n${stderr}`;
  return joinedOutput.match(TSC_ERROR_PATTERN)?.length ?? 0;
}

// TS2307 = "Cannot find module '<spec>'": the compiler could not resolve a module
// AT ALL. This is never a legitimate thing to silently count toward a baseline —
// once resolution fails, the type graph past that import diverges from what a fresh
// install / CI checks, so downstream diagnostics in that file can be SUPPRESSED and
// the error count becomes meaningless. A stale/missing sub-project `node_modules`
// (e.g. mobile lacking the rudderstack SDK) is the canonical case: it replaces a
// project's real errors with bogus module-not-found ones that can sit UNDER a
// non-zero baseline and pass locally while CI (fresh deps) sees the real count —
// the local-green/CI-red trap that drove the misleading "lower the baseline" advice
// in docs/plans/260614_mobile-ts-baseline-tighten. We flag ALL TS2307 (package,
// scoped, path-alias, AND relative): a broken relative import or path mapping masks
// follow-on diagnostics for the same reason and is equally not baseline-worthy
// (per GPT plan-critique F1/F3). We do NOT flag TS7016 ("no declaration file"): an
// untyped dependency IS a legitimately baseline-able state (cf. the async-lock case).
//
// Detection is by diagnostic CODE (`error TS2307:`), robust to message-wording or
// locale drift; specifier extraction is best-effort, only for the remediation hint.
const UNRESOLVED_MODULE_CODE_PATTERN = /error TS2307:/g;
const UNRESOLVED_MODULE_SPECIFIER_PATTERN = /error TS2307: Cannot find module '([^']+)'/g;

export function findUnresolvedModuleErrors(
  stdout: string,
  stderr: string,
): { count: number; specifiers: string[] } {
  const joinedOutput = `${stdout}\n${stderr}`;
  const count = joinedOutput.match(UNRESOLVED_MODULE_CODE_PATTERN)?.length ?? 0;
  const specifiers = new Set<string>();
  for (const match of joinedOutput.matchAll(UNRESOLVED_MODULE_SPECIFIER_PATTERN)) {
    specifiers.add(match[1]);
  }
  return { count, specifiers: [...specifiers] };
}

export function getDefaultConcurrency(): number {
  return Math.min(os.cpus().length, 4);
}

export function resolveRatchetConcurrency(
  rawValue = process.env.RATCHET_CONCURRENCY,
  defaultConcurrency = getDefaultConcurrency(),
  warn: (message: string) => void = console.error,
): number {
  if (rawValue === undefined || rawValue === '') {
    return defaultConcurrency;
  }

  const parsed = Number.parseInt(rawValue, 10);
  if (
    !Number.isFinite(parsed) ||
    Number.isNaN(parsed) ||
    parsed <= 0 ||
    parsed > MAX_ENV_CONCURRENCY
  ) {
    warn(
      `[ratchet] WARN: ignoring invalid RATCHET_CONCURRENCY=${rawValue}; falling back to ${defaultConcurrency}`,
    );
    return defaultConcurrency;
  }

  return parsed;
}

export function parseRepeatArg(args: string[]): number {
  const repeatArg = args.find((arg) => arg.startsWith('--repeat='));
  const unsupportedArg = args.find((arg) => !arg.startsWith('--repeat='));
  if (unsupportedArg) {
    throw new Error(`Unsupported argument: ${unsupportedArg}`);
  }
  if (!repeatArg) {
    return 1;
  }

  const rawRepeat = repeatArg.slice('--repeat='.length);
  const repeat = Number.parseInt(rawRepeat, 10);
  if (!Number.isFinite(repeat) || Number.isNaN(repeat) || repeat <= 0) {
    throw new Error(`Invalid --repeat value: ${rawRepeat}`);
  }
  return repeat;
}

// ---------------------------------------------------------------------------
// Incremental tsc cache (Lever B — docs/plans/260618_git-safe-sync-speedup)
// ---------------------------------------------------------------------------
//
// The ratchet ran a COLD full-project `tsc --noEmit` per project every push
// (~34s, the single largest validate:fast slice). We add a `.tsbuildinfo` cache
// so warm re-runs only re-check changed files + dependents (spike: node project
// 31.6s cold -> 4.7s warm).
//
// WHY THIS IS SAFE (this gate is part of the only pre-push safety net):
//  1. tsc records a hash of EVERY input file in the .tsbuildinfo and re-checks
//     any changed file AND its dependents. An error introduced into a changed
//     file is therefore still caught (verified: a stale-cache-can't-hide-errors
//     regression test injects an error into a previously-clean file and confirms
//     the warm run still reports it).
//  2. tsc embeds compilerOptions + its own version in the .tsbuildinfo and
//     discards an incompatible cache (cold rebuild) by construction.
//  3. DEFENSIVE KEYING (belt-and-suspenders): the cache FILE PATH is keyed on
//     {tsconfig abs path + TS version + lockfile hash}. Any of these changing
//     selects a DIFFERENT cache file ⇒ cold rebuild (correct, just slower once).
//  4. PER-WORKTREE ISOLATION: caches live under gitignored `.local/`, never
//     shared across worktrees/branches.
//  5. AUTHORITATIVE COLD BACKSTOP: CI (reusable-validation.yml) runs this exact
//     ratchet COLD on a fresh checkout every dev push — local incremental is a
//     speed optimization, never the last line of defense.
// Escape hatch: TS_RATCHET_NO_CACHE=1 forces cold (omit the flags entirely).

const TS_RATCHET_CACHE_SUBDIR = path.join('.local', 'ts-ratchet');

let cachedTsVersion: string | null = null;
function resolveTsVersion(): string {
  if (cachedTsVersion !== null) return cachedTsVersion;
  try {
    const require = createRequire(import.meta.url);
    cachedTsVersion = (require('typescript/package.json') as { version: string }).version;
  } catch {
    cachedTsVersion = 'unknown';
  }
  return cachedTsVersion;
}

const lockfileHashCache = new Map<string, string>();
function lockfileHashFor(repoRoot: string, tsconfig: string): string {
  // Hash the root lockfile plus the sub-package lockfile (if the tsconfig is
  // nested and has its own), so a dependency change in either forces a cold key.
  const candidates = [path.join(repoRoot, 'package-lock.json')];
  const dir = installDirForTsconfig(tsconfig);
  if (dir !== '.') candidates.push(path.join(repoRoot, dir, 'package-lock.json'));
  const cacheKey = candidates.join('|');
  const cached = lockfileHashCache.get(cacheKey);
  if (cached !== undefined) return cached;
  const hash = createHash('sha256');
  for (const file of candidates) {
    try {
      hash.update(fs.readFileSync(file));
    } catch {
      hash.update(`missing:${file}`);
    }
  }
  const digest = hash.digest('hex').slice(0, 16);
  lockfileHashCache.set(cacheKey, digest);
  return digest;
}

/**
 * Returns the keyed `.tsbuildinfo` path for a project, or null when caching is
 * disabled (TS_RATCHET_NO_CACHE) or the cache dir can't be created.
 */
export function tsBuildInfoPathFor(
  project: ProjectConfig,
  repoRoot: string = process.cwd(),
): string | null {
  if (process.env.TS_RATCHET_NO_CACHE) return null;
  // CI runs this ratchet ONCE on a fresh checkout and never reuses the cache,
  // so caching there only pays the one-time .tsbuildinfo write cost (~+28s) for
  // zero benefit — and CI is the authoritative COLD backstop, which must stay
  // cold. Only the LOCAL pre-push gate (repeated runs per worktree) benefits.
  if (process.env.CI || process.env.GITHUB_ACTIONS) return null;
  const key = createHash('sha256')
    .update(path.resolve(repoRoot, project.tsconfig))
    .update('\0')
    .update(resolveTsVersion())
    .update('\0')
    .update(lockfileHashFor(repoRoot, project.tsconfig))
    .digest('hex')
    .slice(0, 16);
  const cacheDir = path.join(repoRoot, TS_RATCHET_CACHE_SUBDIR);
  try {
    fs.mkdirSync(cacheDir, { recursive: true });
  } catch {
    return null; // can't cache → fall back to cold (omit flags)
  }
  // Include the project name + key so a key change orphans (not overwrites) the
  // old file, and distinct projects never collide.
  return path.join(cacheDir, `${project.name}-${key}.tsbuildinfo`);
}

export async function runOne(
  project: ProjectConfig,
): Promise<ProjectRunResult> {
  return new Promise<ProjectRunResult>((resolve, reject) => {
    const buildInfoPath = tsBuildInfoPathFor(project);
    const incrementalArgs = buildInfoPath
      ? ['--incremental', '--tsBuildInfoFile', buildInfoPath]
      : [];
    const child = spawn(
      'npx',
      ['tsc', '-p', project.tsconfig, '--noEmit', '--pretty', 'false', ...incrementalArgs],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

    if (!child.stdout || !child.stderr) {
      reject(
        new Error(
          `Unable to capture tsc output streams for ${project.tsconfig}`,
        ),
      );
      return;
    }

    let stdout = '';
    let stderr = '';
    let alreadyRejected = false;

    child.stdout.on('data', (chunk: Buffer | string) => {
      stdout += chunkToString(chunk);
    });
    child.stderr.on('data', (chunk: Buffer | string) => {
      stderr += chunkToString(chunk);
    });
    child.on('error', (error: Error) => {
      alreadyRejected = true;
      reject(error);
    });
    child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      if (alreadyRejected) {
        return;
      }

      const errorCount = countTypescriptErrors(stdout, stderr);
      if (code === null) {
        reject(
          new Error(
            `tsc terminated by signal ${signal ?? 'unknown'} for ${project.tsconfig}`,
          ),
        );
        return;
      }

      if (code !== 0 && errorCount === 0) {
        const outputPreview = (stderr || stdout).slice(0, 500);
        reject(
          new Error(
            `tsc exited with code ${code} but no error TS lines parsed; output capture likely broken: ${outputPreview}`,
          ),
        );
        return;
      }

      // Fail loud on unresolved-module (TS2307) diagnostics rather than feeding a
      // bogus count into the baseline comparison (see findUnresolvedModuleErrors).
      const unresolved = findUnresolvedModuleErrors(stdout, stderr);
      if (unresolved.count > 0) {
        const dir = installDirForTsconfig(project.tsconfig);
        const examples =
          unresolved.specifiers.length > 0
            ? ` (${unresolved.specifiers.slice(0, 5).join(', ')}${unresolved.specifiers.length > 5 ? ', …' : ''})`
            : '';
        reject(
          new Error(
            `${displayName(project)}: ${unresolved.count} unresolved-module error(s) [TS2307]${examples} ` +
              `in ${project.tsconfig}. Unresolved modules are NOT counted against the TypeScript ` +
              `baseline — they suppress downstream diagnostics, so the count would be unreliable. ` +
              `Fix resolution, then re-run. Two likely causes: (1) the sub-project's dependencies ` +
              `are stale/missing — reinstall them (e.g. \`npm ci --prefix ${dir}\`; CI installs ` +
              `fresh deps, so green CI does not protect you locally); or (2) a broken import / ` +
              `tsconfig path mapping — fix the path or the missing file.`,
          ),
        );
        return;
      }

      resolve({ project, errorCount });
    });
  });
}

export async function runWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  if (!Number.isFinite(concurrency) || concurrency <= 0) {
    throw new Error(`Invalid concurrency: ${concurrency}`);
  }
  if (items.length === 0) {
    return [];
  }

  const results: PromiseSettledResult<R>[] = new Array<PromiseSettledResult<R>>(
    items.length,
  );
  let nextIndex = 0;
  let active = 0;
  let completed = 0;

  return new Promise<PromiseSettledResult<R>[]>((resolve) => {
    const launchNext = (): void => {
      if (completed === items.length) {
        resolve(results);
        return;
      }

      while (active < concurrency && nextIndex < items.length) {
        const currentIndex = nextIndex;
        const item = items[currentIndex];
        nextIndex += 1;
        active += 1;

        Promise.resolve()
          .then(() => worker(item, currentIndex))
          .then(
            (value) => {
              results[currentIndex] = { status: 'fulfilled', value };
            },
            (reason: unknown) => {
              results[currentIndex] = { status: 'rejected', reason };
            },
          )
          .finally(() => {
            active -= 1;
            completed += 1;
            launchNext();
          });
      }
    };

    launchNext();
  });
}

function buildInitialSummaries(
  projects: readonly ProjectConfig[],
): ProjectSummary[] {
  return projects.map((project) => ({
    project,
    maxErrorCount: null,
    rejectionReasons: [],
  }));
}

function recordRunResults(
  summaries: ProjectSummary[],
  runResults: PromiseSettledResult<ProjectRunResult>[],
): void {
  for (let index = 0; index < runResults.length; index += 1) {
    const result = runResults[index];
    const summary = summaries[index];
    if (!result || !summary) {
      throw new Error('Ratchet result/project length mismatch');
    }

    if (result.status === 'fulfilled') {
      summary.maxErrorCount = Math.max(
        summary.maxErrorCount ?? 0,
        result.value.errorCount,
      );
    } else {
      summary.rejectionReasons.push(result.reason);
    }
  }
}

function reportSummaries(
  summaries: readonly ProjectSummary[],
  logger: Pick<Console, 'error' | 'log' | 'warn'>,
): boolean {
  let failed = false;

  for (const summary of summaries) {
    const name = displayName(summary.project);
    if (summary.rejectionReasons.length > 0) {
      logger.error(`✘ ${name} tsc invocation failed:`);
      for (const reason of summary.rejectionReasons) {
        logger.error(reason);
      }
      failed = true;
      continue;
    }

    const errorCount = summary.maxErrorCount ?? 0;
    const baseline = summary.project.baseline;
    if (errorCount > baseline) {
      logger.error(
        `✘ ${name}: ${errorCount} errors (baseline: ${baseline}) — new errors introduced`,
      );
      failed = true;
    } else {
      logger.log(
        `✔ ${name}: ${errorCount}/${baseline} TypeScript errors (within baseline)`,
      );
      if (errorCount < baseline) {
        logger.warn(
          `⚠ ${name}: ${errorCount} errors is below baseline ${baseline}; lower the baseline.`,
        );
      }
    }
  }

  return failed;
}

export async function runRatchet(
  projects: readonly ProjectConfig[] = PROJECTS,
  options: RatchetRunOptions = {},
): Promise<RatchetRunResult> {
  const concurrency = options.concurrency ?? resolveRatchetConcurrency();
  const repeat = options.repeat ?? 1;
  const shouldReport = options.report ?? false;
  const logger = options.logger ?? console;

  if (!Number.isFinite(repeat) || repeat <= 0) {
    throw new Error(`Invalid repeat count: ${repeat}`);
  }

  const summaries = buildInitialSummaries(projects);
  for (let runIndex = 0; runIndex < repeat; runIndex += 1) {
    const runResults = await runWithConcurrency(
      projects,
      concurrency,
      (project) => runOne(project),
    );
    recordRunResults(summaries, runResults);
  }

  const failed = shouldReport
    ? reportSummaries(summaries, logger)
    : summaries.some((summary) => {
        if (summary.rejectionReasons.length > 0) {
          return true;
        }
        return (summary.maxErrorCount ?? 0) > summary.project.baseline;
      });

  return { failed, summaries };
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  const repeat = parseRepeatArg(args);
  const concurrency = resolveRatchetConcurrency();
  const projectNames = PROJECTS.map((project) => project.name).join(' + ');
  const repeatSuffix = repeat > 1 ? `, repeat ${repeat} (max per project)` : '';
  console.log(
    `Checking TypeScript errors (${projectNames}, concurrency ${concurrency}${repeatSuffix})...`,
  );

  const result = await runRatchet(PROJECTS, {
    concurrency,
    repeat,
    report: true,
  });
  if (result.failed) {
    process.exit(1);
  }
}

const invokedDirectly = process.argv[1] === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((err: unknown) => {
    console.error('Unexpected error in check-typescript-errors:', err);
    process.exit(1);
  });
}
