import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { gitIsolatedEnv, type EnvLike } from '../git-env-isolation';

/**
 * End-to-end manufactured-race test for git-safe-sync's Stage-7 auto-retry
 * (docs/plans/260611_prepush-gate-speedup/PLAN.md, Decision Log 2026-06-11
 * 18:15): a temp bare remote moves BETWEEN the sync's fetch and its push —
 * via the in-script validator seam, which runs exactly in that window — so
 * `git push` fails with the genuine wild-race shape
 * (` ! [rejected] main -> main (fetch first)`, remote tip moved). The script
 * must classify the race, respawn itself once with `--retry-leg`, and the
 * retry leg (an ordinary fresh sync) merges the racing winner's commit and
 * pushes successfully — parent exits with the child's exit code 0.
 *
 * The pre-push-hook seam was deliberately NOT used to manufacture the race:
 * a hook fires after git has already fetched the remote's ref advertisement,
 * which produces a `[remote rejected]`-style compare-and-swap (CAS) ref-lock
 * failure. As of the CAS-classifier slice (260614) that shape is ITS OWN race
 * path (`cannot lock ref … is at X but expected Y` on a `[remote rejected]`
 * line), so the hook seam is no longer a clean non-race counterexample — but
 * the validator seam still reproduces the plain non-FF race this test targets.
 *
 * Real git, temp dirs only — nothing ever touches a real remote. GIT_*
 * location env scrubbed per repo policy (scripts/lib/git-env-isolation.ts).
 */

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const tsxBin = resolve(repoRoot, 'node_modules/.bin/tsx');
const syncScript = resolve(repoRoot, 'scripts/git-safe-sync.ts');

describe('git-safe-sync push-race auto-retry (integration, real git)', () => {
  const cleanup: string[] = [];
  const tmp = (prefix: string): string => {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    cleanup.push(dir);
    return dir;
  };
  afterEach(() => {
    for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  /** Hermetic env: location vars scrubbed, identity via a temp global config. */
  const makeEnv = (): EnvLike => {
    const cfgDir = tmp('push-race-cfg-');
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
   * Builds: bare origin (one seed commit on main) + syncer clone (one local
   * commit, ahead 1) + racer clone, plus a one-shot race script that pushes a
   * racing commit from the racer the first time it runs (marker-guarded) and
   * is a no-op afterwards. The race script doubles as the sync's validator,
   * so the remote moves exactly between the sync's fetch and its push.
   */
  function buildFixture(env: EnvLike): {
    originDir: string;
    syncerDir: string;
    racerDir: string;
    raceScript: string;
  } {
    const originDir = join(tmp('push-race-origin-'), 'origin.git');
    git(['init', '-q', '--bare', originDir], tmpdir(), env);

    const seedDir = join(tmp('push-race-seed-'), 'seed');
    git(['clone', '-q', originDir, seedDir], tmpdir(), env);
    writeFileSync(join(seedDir, 'README.md'), 'seed\n');
    git(['add', 'README.md'], seedDir, env);
    git(['commit', '-q', '-m', 'seed'], seedDir, env);
    git(['push', '-q', '-u', 'origin', 'main'], seedDir, env);

    const syncerDir = join(tmp('push-race-syncer-'), 'syncer');
    git(['clone', '-q', originDir, syncerDir], tmpdir(), env);
    writeFileSync(join(syncerDir, 'local.txt'), 'local change\n');
    git(['add', 'local.txt'], syncerDir, env);
    git(['commit', '-q', '-m', 'local commit (to be raced)'], syncerDir, env);

    const racerDir = join(tmp('push-race-racer-'), 'racer');
    git(['clone', '-q', originDir, racerDir], tmpdir(), env);

    const scriptDir = tmp('push-race-script-');
    const marker = join(scriptDir, 'raced.marker');
    const raceScript = join(scriptDir, 'race.sh');
    writeFileSync(
      raceScript,
      [
        '#!/bin/sh',
        '# One-shot manufactured race: the first invocation pushes a racing',
        '# commit from the peer clone; later invocations are no-ops.',
        'unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_PREFIX',
        `if [ ! -e "${marker}" ]; then`,
        `  touch "${marker}"`,
        `  cd "${racerDir}" || exit 1`,
        '  echo race >> race.txt',
        '  git add race.txt',
        '  git commit -q -m "racing commit"',
        '  git push -q origin main',
        'fi',
        'exit 0',
      ].join('\n') + '\n',
    );
    chmodSync(raceScript, 0o755);

    return { originDir, syncerDir, racerDir, raceScript };
  }

  function runSync(
    syncerDir: string,
    raceScript: string,
    env: EnvLike,
    extraArgs: string[] = [],
  ): { status: number; output: string } {
    const r = spawnSync(
      tsxBin,
      [
        syncScript,
        '--no-lock',
        '--no-log',
        // The fixture has no pre-push hook, so the script falls back to the
        // in-script validator — which is our race manufacturer, running
        // exactly between the fetch and the push.
        '--validator-command',
        `sh ${raceScript}`,
        ...extraArgs,
      ],
      { cwd: syncerDir, encoding: 'utf8', env: env as NodeJS.ProcessEnv, timeout: 180_000 },
    );
    return { status: r.status ?? -1, output: `${r.stdout ?? ''}\n${r.stderr ?? ''}` };
  }

  it(
    'loses the manufactured race, respawns exactly one retry leg, and the retry wins',
    { timeout: 180_000 },
    () => {
      const env = makeEnv();
      const { originDir, syncerDir, raceScript } = buildFixture(env);

      const { status, output } = runSync(syncerDir, raceScript, env);

      // Leg 1 lost the race and announced the respawn.
      expect(output).toContain('Another push landed on the remote between fetch and push');
      expect(output).toContain('LOST PUSH RACE — RETRYING ONCE IN A FRESH RUN');
      // Exactly one respawn banner (single-retry bound).
      expect(output.match(/LOST PUSH RACE/g)).toHaveLength(1);

      // Leg 2 (the ordinary fresh sync) merged the racing winner and pushed.
      expect(output).toContain('Sync Complete!');
      expect(status).toBe(0);

      // Origin's main contains BOTH the racing commit and our local commit.
      expect(git(['show', 'main:race.txt'], originDir, env)).toBe('race');
      expect(git(['show', 'main:local.txt'], originDir, env)).toBe('local change');
    },
  );

  it(
    'with --no-retry: classifies the race, skips the retry, exits 40 with today\'s guidance',
    { timeout: 180_000 },
    () => {
      const env = makeEnv();
      const { originDir, syncerDir, raceScript } = buildFixture(env);

      const { status, output } = runSync(syncerDir, raceScript, env, ['--no-retry']);

      expect(status).toBe(40);
      expect(output).toContain('Another push landed on the remote between fetch and push');
      expect(output).toContain('Auto-retry skipped (--no-retry)');
      expect(output).toContain('Re-run this command to fetch, re-merge, and push');
      expect(output).not.toContain('LOST PUSH RACE');

      // The racing commit landed; ours did not.
      expect(git(['show', 'main:race.txt'], originDir, env)).toBe('race');
      expect(existsSync(join(originDir, 'nonexistent'))).toBe(false); // bare-repo sanity
      const originFiles = git(['ls-tree', '--name-only', 'main'], originDir, env);
      expect(originFiles).not.toContain('local.txt');
    },
  );
});
