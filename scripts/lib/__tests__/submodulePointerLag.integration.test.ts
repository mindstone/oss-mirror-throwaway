import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { gitIsolatedEnv, type EnvLike } from '../git-env-isolation';

/**
 * End-to-end fixture test for git-safe-sync's Stage-6 submodule pointer-lag
 * auto-align phase (docs/plans/260611_prepush-gate-speedup/PLAN.md):
 * reproduces today's friction — a MANUAL merge commit moves a submodule pin
 * while the checkout lags — and proves the sync's pre-safety alignment phase
 * aligns the checkout and proceeds past the safety check, while the unsafe
 * variant (pin not reachable from the tracked remote branch — GPT F2's exact
 * scenario) aborts with the new pointer-lag copy and moves NOTHING.
 *
 * Real git, temp dirs, GIT_* location env scrubbed per repo policy (see
 * scripts/lib/git-env-isolation.ts; vitest.setup.ts scrubs process.env, and we
 * additionally pass an explicit hermetic env to every child). The spawned
 * sync runs with --no-push and a stub validator: nothing is ever pushed.
 */

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const tsxBin = resolve(repoRoot, 'node_modules/.bin/tsx');
const syncScript = resolve(repoRoot, 'scripts/git-safe-sync.ts');

describe('git-safe-sync pointer-lag auto-align (integration, real git)', () => {
  const cleanup: string[] = [];
  const tmp = (prefix: string): string => {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    cleanup.push(dir);
    return dir;
  };
  afterEach(() => {
    for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  /** Hermetic env: location vars scrubbed, identity + file-protocol via a temp global config. */
  const makeEnv = (): EnvLike => {
    const cfgDir = tmp('ptr-lag-cfg-');
    const cfg = join(cfgDir, 'gitconfig');
    writeFileSync(
      cfg,
      [
        '[protocol "file"]',
        '\tallow = always',
        '[user]',
        '\tname = Fixture',
        '\temail = fixture@example.com',
        '[init]',
        '\tdefaultBranch = main',
      ].join('\n') + '\n',
    );
    return {
      ...gitIsolatedEnv(),
      GIT_CONFIG_GLOBAL: cfg,
      GIT_CONFIG_SYSTEM: '/dev/null',
      GIT_SAFE_SYNC_NO_LOCK: '1',
    };
  };

  const git = (args: string[], cwd: string, env: EnvLike): string =>
    execFileSync('git', args, { cwd, encoding: 'utf8', env: env as NodeJS.ProcessEnv }).trim();

  /**
   * Builds: subUpstream (commit A on main) → originSuper (pins A) → super
   * (clone of originSuper with sub initialized at A, tracking origin/main).
   * Returns the paths plus commit A's sha.
   */
  function buildFixture(
    env: EnvLike,
    trackedBranch?: string,
  ): {
    subUpstream: string;
    superDir: string;
    shaA: string;
  } {
    const subUpstream = tmp('ptr-lag-sub-');
    git(['init', '-q'], subUpstream, env);
    writeFileSync(join(subUpstream, 'file.txt'), 'v1\n');
    git(['add', 'file.txt'], subUpstream, env);
    git(['commit', '-q', '-m', 'A'], subUpstream, env);
    const shaA = git(['rev-parse', 'HEAD'], subUpstream, env);

    const originSuper = tmp('ptr-lag-origin-');
    git(['init', '-q'], originSuper, env);
    writeFileSync(join(originSuper, 'README.md'), 'super\n');
    git(['add', 'README.md'], originSuper, env);
    git(['commit', '-q', '-m', 'init'], originSuper, env);
    git(['submodule', 'add', subUpstream, 'sub'], originSuper, env);
    if (trackedBranch) {
      // Point the tracked branch somewhere that doesn't exist upstream — the
      // pin-reachability classifier then returns 'skip' (unverifiable).
      git(['config', '-f', '.gitmodules', 'submodule.sub.branch', trackedBranch], originSuper, env);
      git(['add', '.gitmodules'], originSuper, env);
    }
    git(['commit', '-q', '-m', 'add sub @ A'], originSuper, env);

    const cloneParent = tmp('ptr-lag-clone-');
    const superDir = join(cloneParent, 'super');
    git(['clone', '-q', originSuper, superDir], cloneParent, env);
    git(['submodule', 'update', '--init'], superDir, env);

    return { subUpstream, superDir, shaA };
  }

  /** Commits pin `sha` for sub in super WITHOUT moving the checkout (the manual-merge signature). */
  function commitLaggingPin(superDir: string, sha: string, env: EnvLike): void {
    git(['update-index', '--cacheinfo', `160000,${sha},sub`], superDir, env);
    git(['commit', '-q', '-m', 'manual merge moves sub pin'], superDir, env);
  }

  /** Runs the real sync script against the fixture (never pushes). */
  function runSync(superDir: string, env: EnvLike): { status: number; output: string } {
    const r = spawnSync(
      tsxBin,
      [
        syncScript,
        '--no-push',
        '--no-lock',
        '--no-log',
        '--no-advance-submodules',
        '--validator-command',
        'true',
      ],
      { cwd: superDir, encoding: 'utf8', env: env as NodeJS.ProcessEnv, timeout: 120_000 },
    );
    return { status: r.status ?? -1, output: `${r.stdout ?? ''}\n${r.stderr ?? ''}` };
  }

  it(
    'aligns a provably-safe lagging checkout and proceeds past the safety check',
    { timeout: 120_000 },
    () => {
      const env = makeEnv();
      const { subUpstream, superDir, shaA } = buildFixture(env);

      // Upstream advances to B; super's sub fetches it (origin/main → B)
      // but its checkout stays at A.
      writeFileSync(join(subUpstream, 'file.txt'), 'v2\n');
      git(['add', 'file.txt'], subUpstream, env);
      git(['commit', '-q', '-m', 'B'], subUpstream, env);
      const shaB = git(['rev-parse', 'HEAD'], subUpstream, env);
      const subDir = join(superDir, 'sub');
      git(['fetch', '-q', 'origin'], subDir, env);

      commitLaggingPin(superDir, shaB, env);
      // (the git() helper trims, so the porcelain ' M' leading space is gone)
      expect(git(['status', '--porcelain'], superDir, env)).toBe('M sub');
      expect(git(['rev-parse', 'HEAD'], subDir, env)).toBe(shaA);

      const { status, output } = runSync(superDir, env);

      expect(output).toContain('Aligning Submodule Pointer-Lag');
      expect(output).toContain('checkout aligned to committed pin');
      expect(output).toContain('All safety checks passed');
      expect(status).toBe(0);

      // The checkout moved forward to the committed pin; nothing else changed.
      expect(git(['rev-parse', 'HEAD'], subDir, env)).toBe(shaB);
      expect(git(['status', '--porcelain'], superDir, env)).toBe('');
    },
  );

  it(
    'aborts (nothing moved) when the committed pin is not reachable from the tracked remote branch',
    { timeout: 120_000 },
    () => {
      const env = makeEnv();
      const { superDir, shaA } = buildFixture(env);
      const subDir = join(superDir, 'sub');

      // GPT F2's exact scenario: a LOCAL pin — commit C exists only inside
      // super's submodule clone, never reached subUpstream's main.
      git(['commit', '-q', '--allow-empty', '-m', 'C (local only)'], subDir, env);
      const shaC = git(['rev-parse', 'HEAD'], subDir, env);
      git(['checkout', '-q', shaA], subDir, env);
      commitLaggingPin(superDir, shaC, env);

      const { status, output } = runSync(superDir, env);

      expect(status).not.toBe(0);
      expect(output).toContain('SAFETY CHECK FAILED');
      expect(output).toContain('not verifiably reachable from the tracked remote branch');
      // The pin-regression footgun copy must NOT appear for pointer-shaped entries.
      expect(output).not.toContain('Commit your changes, or use --autostash');
      // And the checkout must not have been touched.
      expect(git(['rev-parse', 'HEAD'], subDir, env)).toBe(shaA);
    },
  );

  it(
    "aborts fail-closed when pin reachability is UNVERIFIABLE (classifier 'skip', not 'fail')",
    { timeout: 120_000 },
    () => {
      // Exec-review F3: mutation M1 (skip ⇒ align) stayed green under the
      // integration suite because its unsafe scenario classifies 'fail'. This
      // case pins the 'skip' branch end-to-end: the tracked branch points at
      // a ref that doesn't exist upstream, so `origin/<branch>` is absent in
      // the sub clone and classifyPin returns 'skip' (unverifiable) — which
      // must block alignment exactly like 'fail'.
      const env = makeEnv();
      const { subUpstream, superDir, shaA } = buildFixture(env, 'release');
      const subDir = join(superDir, 'sub');

      // A perfectly clean lag-behind shape otherwise: upstream advances to B,
      // the sub clone fetches it, the pin moves, the checkout lags.
      writeFileSync(join(subUpstream, 'file.txt'), 'v2\n');
      git(['add', 'file.txt'], subUpstream, env);
      git(['commit', '-q', '-m', 'B'], subUpstream, env);
      const shaB = git(['rev-parse', 'HEAD'], subUpstream, env);
      git(['fetch', '-q', 'origin'], subDir, env);
      commitLaggingPin(superDir, shaB, env);

      const { status, output } = runSync(superDir, env);

      expect(status).not.toBe(0);
      expect(output).toContain('SAFETY CHECK FAILED');
      expect(output).toContain('not verifiably reachable from the tracked remote branch');
      // Skip-specific wording (distinguishes this from the 'fail' scenario above).
      expect(output).toContain('origin/release');
      expect(output).not.toContain('Commit your changes, or use --autostash');
      // Nothing moved.
      expect(git(['rev-parse', 'HEAD'], subDir, env)).toBe(shaA);
    },
  );
});
