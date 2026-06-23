#!/usr/bin/env tsx
/**
 * Conditional worker esbuild smoke.
 *
 * `npm run validate:fast` does not run the custom esbuild path used by
 * scripts/build-worker.mjs. This gate keeps the common no-op path cheap, but
 * runs the real worker build when worker/startup inputs or worker alias config
 * changed. If the changed-file set cannot be resolved, it fails closed by
 * running the smoke instead of silently skipping.
 */

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_GIT_MAXBUFFER } from './lib/git-exec.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Known limitation: these triggers are path-based, not import-graph-based. A
// shared @core/@shared module imported transitively by a worker (but living
// outside these prefixes), or an esbuild/dependency bump in package.json, will
// NOT trigger the smoke when the base is known. The fail-safe (run-on-unknown)
// + the cheap sub-second build recover a lot of incidental coverage, and any
// such break also surfaces in the full `build`/`package`. Scoped intentionally
// to the rec's named worker/startup dirs + worker alias/build config.
const TRIGGER_PREFIXES = [
  'src/main/workers/',
  'src/main/gpu-worker/',
  'src/main/startup/',
  'src/core/startup/',
] as const;

const TRIGGER_FILES = new Set([
  'scripts/build-worker.mjs',
  'tsconfig.base.json',
  'tsconfig.node.json',
  'tsconfig.json',
  'electron.vite.config.ts',
]);

export interface ChangedFilesKnown {
  readonly status: 'known';
  readonly files: readonly string[];
  readonly source: string;
}

export interface ChangedFilesUnknown {
  readonly status: 'unknown';
  readonly reason: string;
}

export type ChangedFilesResult = ChangedFilesKnown | ChangedFilesUnknown;

export interface WorkerBuildResult {
  readonly exitCode: number;
  readonly signal?: NodeJS.Signals | null;
}

export interface WorkerBuildSmokeOptions {
  readonly repoRoot?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly detectChangedFiles?: () => ChangedFilesResult;
  readonly runWorkerBuild?: () => WorkerBuildResult;
  readonly log?: (message: string) => void;
  readonly error?: (message: string) => void;
}

interface GitResult {
  readonly ok: boolean;
  readonly stdout: string;
  readonly stderr: string;
  readonly status: number | null;
}

function normalisePath(filePath: string): string {
  return filePath.trim().replace(/\\/g, '/').replace(/^\.\/+/, '');
}

function nonEmptyLines(output: string): string[] {
  return output
    .split(/\r?\n/)
    .map(normalisePath)
    .filter(Boolean);
}

function unique(files: readonly string[]): string[] {
  return Array.from(new Set(files.map(normalisePath).filter(Boolean)));
}

function git(args: readonly string[], repoRoot: string): GitResult {
  // git-exec-allow: worker smoke git wrapper preserves status and stderr with shared buffer cap
  const result = spawnSync('git', [...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: DEFAULT_GIT_MAXBUFFER,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return {
    ok: result.status === 0,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    status: result.status,
  };
}

function gitOutput(args: readonly string[], repoRoot: string): string | null {
  const result = git(args, repoRoot);
  if (!result.ok) return null;
  return result.stdout.trim();
}

function firstResolvedBase(repoRoot: string, env: NodeJS.ProcessEnv): { base: string; source: string } | null {
  const explicitBase = env.WORKER_BUILD_SMOKE_BASE?.trim();
  if (explicitBase) {
    const resolved = gitOutput(['rev-parse', '--verify', explicitBase], repoRoot);
    if (!resolved) {
      return null;
    }
    return { base: resolved, source: `WORKER_BUILD_SMOKE_BASE=${explicitBase}` };
  }

  const githubBaseRef = env.GITHUB_BASE_REF?.trim();
  if (githubBaseRef) {
    const resolved = gitOutput(['merge-base', 'HEAD', `origin/${githubBaseRef}`], repoRoot);
    if (resolved) {
      return { base: resolved, source: `merge-base HEAD origin/${githubBaseRef}` };
    }
  }

  const beforeSha = env.GITHUB_EVENT_BEFORE?.trim();
  if (beforeSha && !/^0+$/.test(beforeSha)) {
    const resolved = gitOutput(['rev-parse', '--verify', beforeSha], repoRoot);
    if (resolved) {
      return { base: resolved, source: 'GITHUB_EVENT_BEFORE' };
    }
  }

  for (const ref of ['origin/main', 'origin/dev']) {
    const resolved = gitOutput(['merge-base', 'HEAD', ref], repoRoot);
    if (resolved) {
      return { base: resolved, source: `merge-base HEAD ${ref}` };
    }
  }

  const previousCommit = gitOutput(['rev-parse', '--verify', 'HEAD~1'], repoRoot);
  if (previousCommit) {
    return { base: previousCommit, source: 'HEAD~1' };
  }

  return null;
}

function collectLocalChangedFiles(repoRoot: string): string[] | null {
  const commands: readonly (readonly string[])[] = [
    ['diff', '--name-only'],
    ['diff', '--cached', '--name-only'],
    ['ls-files', '--others', '--exclude-standard'],
  ];
  const files: string[] = [];
  for (const args of commands) {
    const result = git(args, repoRoot);
    if (!result.ok) {
      return null;
    }
    files.push(...nonEmptyLines(result.stdout));
  }
  return files;
}

export function detectChangedFiles(repoRoot: string = REPO_ROOT, env: NodeJS.ProcessEnv = process.env): ChangedFilesResult {
  const explicitFiles = env.WORKER_BUILD_SMOKE_CHANGED_FILES;
  if (explicitFiles !== undefined) {
    return {
      status: 'known',
      files: unique(nonEmptyLines(explicitFiles)),
      source: 'WORKER_BUILD_SMOKE_CHANGED_FILES',
    };
  }

  const base = firstResolvedBase(repoRoot, env);
  if (!base) {
    return {
      status: 'unknown',
      reason: 'could not resolve a git base from env, origin/main, origin/dev, or HEAD~1',
    };
  }

  const committed = git(['diff', '--name-only', `${base.base}..HEAD`], repoRoot);
  if (!committed.ok) {
    const detail = committed.stderr.trim() || `exit ${committed.status ?? 'unknown'}`;
    return {
      status: 'unknown',
      reason: `git diff from ${base.source} failed: ${detail}`,
    };
  }

  const local = collectLocalChangedFiles(repoRoot);
  if (!local) {
    return {
      status: 'unknown',
      reason: 'could not collect local unstaged, staged, or untracked files',
    };
  }

  return {
    status: 'known',
    files: unique([...nonEmptyLines(committed.stdout), ...local]),
    source: `${base.source} plus local working tree`,
  };
}

export function isWorkerBuildRelevantFile(filePath: string): boolean {
  const normalised = normalisePath(filePath);
  return (
    TRIGGER_FILES.has(normalised) ||
    TRIGGER_PREFIXES.some((prefix) => normalised.startsWith(prefix))
  );
}

export function findWorkerBuildTrigger(files: readonly string[]): string | null {
  return unique(files).find(isWorkerBuildRelevantFile) ?? null;
}

function defaultRunWorkerBuild(repoRoot: string): WorkerBuildResult {
  const result = spawnSync('node', ['scripts/build-worker.mjs'], {
    cwd: repoRoot,
    stdio: 'inherit',
  });
  if (result.error) {
    return { exitCode: 1, signal: null };
  }
  return {
    exitCode: result.status ?? (result.signal ? 1 : 1),
    signal: result.signal,
  };
}

function formatBuildFailure(result: WorkerBuildResult): string {
  const exitDescription = result.signal ? `signal ${result.signal}` : `exit ${result.exitCode}`;
  return [
    '',
    '[worker-build-smoke] FAIL: worker esbuild smoke failed.',
    `[worker-build-smoke] ${exitDescription}`,
    '[worker-build-smoke] Reproduce: npm run build:worker',
    '',
  ].join('\n');
}

export function runWorkerBuildSmoke(options: WorkerBuildSmokeOptions = {}): number {
  const repoRoot = options.repoRoot ?? REPO_ROOT;
  const env = options.env ?? process.env;
  const log = options.log ?? console.log;
  const error = options.error ?? console.error;
  const runWorkerBuild = options.runWorkerBuild ?? (() => defaultRunWorkerBuild(repoRoot));

  const mode = env.WORKER_BUILD_SMOKE?.trim().toLowerCase();
  if (mode === '0' || mode === 'false' || mode === 'skip') {
    log('[worker-build-smoke] skip: WORKER_BUILD_SMOKE requested force-skip');
    return 0;
  }

  let reason: string;
  if (mode === '1' || mode === 'true' || mode === 'force') {
    reason = 'WORKER_BUILD_SMOKE requested force-run';
  } else {
    const changed = (options.detectChangedFiles ?? (() => detectChangedFiles(repoRoot, env)))();
    if (changed.status === 'unknown') {
      reason = `fail-safe: ${changed.reason}`;
    } else {
      const trigger = findWorkerBuildTrigger(changed.files);
      if (!trigger) {
        log(
          `[worker-build-smoke] skip: no worker-relevant files changed ` +
            `(${changed.files.length} changed file(s) checked from ${changed.source})`,
        );
        return 0;
      }
      reason = `${trigger} changed`;
    }
  }

  log(`[worker-build-smoke] running: ${reason}`);
  const result = runWorkerBuild();
  if (result.exitCode !== 0 || result.signal) {
    error(formatBuildFailure(result));
    return result.exitCode === 0 ? 1 : result.exitCode;
  }

  log('[worker-build-smoke] pass: scripts/build-worker.mjs completed successfully');
  return 0;
}

const invokedDirectly = process.argv[1] === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  process.exitCode = runWorkerBuildSmoke();
}
