import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, it, expect } from 'vitest';

import {
  GIT_LOCATION_ENV_KEYS,
  scrubGitLocationEnv,
  gitIsolatedEnv,
  type EnvLike,
} from '../git-env-isolation';

describe('scrubGitLocationEnv', () => {
  it('deletes every git location-redirect var', () => {
    const env: EnvLike = {};
    for (const key of GIT_LOCATION_ENV_KEYS) env[key] = '/some/real/repo/.git';

    scrubGitLocationEnv(env);

    for (const key of GIT_LOCATION_ENV_KEYS) {
      expect(env[key], `${key} should be scrubbed`).toBeUndefined();
    }
  });

  it('leaves identity / config vars untouched (only location vars are scrubbed)', () => {
    const env: EnvLike = {
      GIT_DIR: '/real/.git',
      GIT_AUTHOR_NAME: 'Fixture',
      GIT_COMMITTER_EMAIL: 'fixture@example.com',
      GIT_CONFIG_GLOBAL: '/dev/null',
      PATH: '/usr/bin',
    };

    scrubGitLocationEnv(env);

    expect(env.GIT_DIR).toBeUndefined();
    expect(env.GIT_AUTHOR_NAME).toBe('Fixture');
    expect(env.GIT_COMMITTER_EMAIL).toBe('fixture@example.com');
    expect(env.GIT_CONFIG_GLOBAL).toBe('/dev/null');
    expect(env.PATH).toBe('/usr/bin');
  });

  it('mutates in place and returns the same reference', () => {
    const env: EnvLike = { GIT_DIR: '/real/.git' };
    expect(scrubGitLocationEnv(env)).toBe(env);
  });

  it('gitIsolatedEnv returns a scrubbed copy without mutating the base', () => {
    const base: EnvLike = { GIT_DIR: '/real/.git', PATH: '/usr/bin' };
    const isolated = gitIsolatedEnv(base);

    expect(isolated).not.toBe(base);
    expect(isolated.GIT_DIR).toBeUndefined();
    expect(isolated.PATH).toBe('/usr/bin');
    // base is left intact
    expect(base.GIT_DIR).toBe('/real/.git');
  });
});

// End-to-end regression test: encodes the diagnostic spike. Proves BOTH that
// the hazard is real (control) AND that gitIsolatedEnv() neutralises it (fix),
// so the test is non-vacuous — it fails if scrubGitLocationEnv ever stopped
// removing GIT_DIR. process.env is already scrubbed by vitest.setup.ts, so the
// "inherited hook env" is constructed explicitly here rather than ambiently.
describe('git isolation end-to-end (real git, temp repos)', () => {
  const cleanup: string[] = [];
  const tmp = (prefix: string): string => {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    cleanup.push(dir);
    return dir;
  };
  afterEach(() => {
    for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  // Hermetic env for our own setup/read commands: never read the dev's global
  // config, never inherit a location var (deterministic regardless of context).
  const hermetic = (extra: EnvLike = {}): EnvLike => ({
    ...gitIsolatedEnv(),
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_AUTHOR_NAME: 'T',
    GIT_AUTHOR_EMAIL: 't@t',
    GIT_COMMITTER_NAME: 'T',
    GIT_COMMITTER_EMAIL: 't@t',
    ...extra,
  });
  const git = (args: string[], cwd: string, env: EnvLike): string =>
    execFileSync('git', args, { cwd, encoding: 'utf8', env }).trim();
  const coreBareOf = (repo: string): string =>
    git(['--git-dir', join(repo, '.git'), 'config', '--get', 'core.bare'], repo, hermetic());

  it('a fixture inheriting GIT_DIR flips the REAL repo (control) but gitIsolatedEnv prevents it (fix)', () => {
    // The stand-in "real" repo a leaked fixture would corrupt.
    const realRepo = tmp('giso-real-');
    git(['init', '-q', '-b', 'main'], realRepo, hermetic());
    git(['config', 'core.bare', 'false'], realRepo, hermetic());
    expect(coreBareOf(realRepo)).toBe('false');

    // The temp repo the fixture *intends* to operate on (its cwd).
    const workRepo = tmp('giso-work-');
    git(['init', '-q', '-b', 'main'], workRepo, hermetic());

    // Simulate the pre-push hook environment: GIT_DIR points at the real repo.
    const inheritedEnv = hermetic({ GIT_DIR: join(realRepo, '.git') });

    // CONTROL — without scrubbing, `git config core.bare true` run from the
    // work repo's cwd writes to GIT_DIR == the REAL repo. This is the bug.
    git(['config', 'core.bare', 'true'], workRepo, inheritedEnv);
    expect(coreBareOf(realRepo), 'control: inherited GIT_DIR corrupts the real repo').toBe('true');

    // Reset the real repo for the fix half.
    git(['config', 'core.bare', 'false'], realRepo, hermetic());
    expect(coreBareOf(realRepo)).toBe('false');

    // FIX — gitIsolatedEnv strips GIT_DIR, so the same command falls back to
    // cwd and writes to the WORK repo. The real repo is untouched.
    git(['config', 'core.bare', 'true'], workRepo, gitIsolatedEnv(inheritedEnv));
    expect(coreBareOf(realRepo), 'fix: real repo stays clean').toBe('false');
    expect(coreBareOf(workRepo), 'fix: write landed in the intended work repo').toBe('true');
  });
});
