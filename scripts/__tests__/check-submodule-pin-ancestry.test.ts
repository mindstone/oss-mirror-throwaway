/**
 * Tests for scripts/check-submodule-pin-ancestry.ts — the kill-by-construction
 * guard for the "submodule pin orphan" regression class.
 *
 * Enforcement model (deliberate; STRICT after the Devil's-Advocate review): the
 * guard classifies a fully-verifiable pin (submodule clone present +
 * `origin/<branch>` ref present) as:
 *   - pin reachable from origin/<branch>            -> OK    (exit 0)
 *   - pin NOT reachable from origin/<branch>        -> FAIL  (exit 1; the
 *       submodule-pin-orphan class). Both AHEAD (origin/<branch> is an ancestor
 *       of the pin — a commit built on the branch but not yet landed/merged back,
 *       the exact shape that lost bulk_export) and DIVERGED (neither is an
 *       ancestor of the other) FAIL. "ahead" is NOT a safe final state.
 * When it genuinely cannot verify offline (submodule not initialized / pinned
 * object absent, or the tracked-branch ref not fetched here) it SKIPS that
 * submodule (exit 0) with a loud `SKIP` warning rather than false-failing. These
 * tests prove the OK, the load-bearing AHEAD-FAIL and DIVERGED-FAIL, and the two
 * unverifiable-SKIP paths against a fully hermetic, on-disk git fixture (no network).
 *
 * Fixture topology (built per-test in a temp dir):
 *   sub  (a real repo, with a bare `origin` remote so `origin/main` resolves):
 *     main:    A -> B -> D            (origin/main advances past B to D)
 *     feature: A -> B -> C            (C off B, does NOT contain D -> diverged from D)
 *     ahead:   A -> B -> D -> E       (E is a descendant of origin/main D)
 *   super (a repo with `sub` wired as a real submodule, .gitmodules branch=main)
 *
 *   OK:   gitlink pinned to B / A / D (on origin/main)         -> exit 0 (OK)
 *   FAIL: gitlink repointed to C (diverged from D, both refs present) -> exit 1 (orphan)
 *   FAIL: gitlink at E (ahead of origin/main, both refs present)-> exit 1 (AHEAD, not landed)
 *   SKIP: gitlink at a SHA absent from the clone               -> exit 0 (cannot verify)
 *   SKIP: pinned commit present but origin/<branch> ref absent -> exit 0 (fetch then retry)
 *   default-branch: a .gitmodules entry with NO branch field defaults to main.
 *
 * @see scripts/check-submodule-pin-ancestry.ts
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const PROJECT_ROOT = join(__dirname, '..', '..');
const SCRIPT_ABS = join(PROJECT_ROOT, 'scripts', 'check-submodule-pin-ancestry.ts');
// Absolute path to the tsx ESM loader in the project's node_modules. We run the
// script with cwd=<fixture super> (so its cwd-relative git calls hit the
// fixture), but `node --import tsx` resolves `tsx` from cwd — which the fixture
// temp dir doesn't have. Pointing at the loader by absolute path keeps the same
// runtime as the `validate:submodule-pin-ancestry` npm script while letting cwd
// float to the fixture.
const TSX_LOADER_ABS = join(PROJECT_ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs');

// Hermetic git env: never read the developer's ~/.gitconfig, and strip every
// inherited GIT_* var so the fixture is self-contained and deterministic.
const GIT_ENV: NodeJS.ProcessEnv = (() => {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('GIT_')) delete env[key];
  }
  env.GIT_CONFIG_GLOBAL = '/dev/null';
  env.GIT_CONFIG_SYSTEM = '/dev/null';
  env.GIT_AUTHOR_NAME = 'Fixture';
  env.GIT_AUTHOR_EMAIL = 'fixture@example.com';
  env.GIT_COMMITTER_NAME = 'Fixture';
  env.GIT_COMMITTER_EMAIL = 'fixture@example.com';
  // Deterministic timestamps -> deterministic commit SHAs.
  env.GIT_AUTHOR_DATE = '2026-01-01T00:00:00 +0000';
  env.GIT_COMMITTER_DATE = '2026-01-01T00:00:00 +0000';
  return env;
})();

function git(cwd: string, args: readonly string[]): { status: number; stdout: string; stderr: string } {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8', env: GIT_ENV });
  if (res.error) throw res.error;
  if (res.status !== 0) {
    throw new Error(
      `git ${args.join(' ')} (cwd=${cwd}) failed [${res.status}]:\n${res.stdout}\n${res.stderr}`,
    );
  }
  return { status: res.status ?? 0, stdout: res.stdout, stderr: res.stderr };
}

function commitFile(cwd: string, name: string, contents: string, message: string): string {
  writeFileSync(join(cwd, name), contents);
  git(cwd, ['add', name]);
  git(cwd, ['commit', '-m', message]);
  return git(cwd, ['rev-parse', 'HEAD']).stdout.trim();
}

interface Fixture {
  root: string;
  superPath: string;
  subPath: string;
  subRelPath: string;
  shaA: string;
  shaB: string;
  shaC: string;
  shaD: string;
  shaE: string;
}

/**
 * Build sub (with bare origin remote so origin/main resolves) and super (with a
 * real submodule). Returns paths + the five relevant SHAs. Topology:
 *   main:    A -> B -> D      (origin/main is at D)
 *   feature: A -> B -> C      (C diverges from D at B)
 *   ahead:   A -> B -> D -> E (E is a descendant of origin/main D)
 */
function buildFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'submodule-pin-ancestry-'));

  // --- bare remote for `sub` -------------------------------------------------
  const subRemote = join(root, 'sub-remote.git');
  git(root, ['init', '--bare', '--initial-branch=main', subRemote]);

  // --- sub working repo ------------------------------------------------------
  const subSrc = join(root, 'sub-src');
  git(root, ['init', '--initial-branch=main', subSrc]);
  const shaA = commitFile(subSrc, 'a.txt', 'A\n', 'A');
  const shaB = commitFile(subSrc, 'b.txt', 'B\n', 'B');
  // Divergent feature commit C off B (does NOT contain D) — branch first while
  // HEAD is still at B, so C never sees D.
  git(subSrc, ['checkout', '-b', 'feature']);
  const shaC = commitFile(subSrc, 'c.txt', 'C\n', 'C');
  // Advance main past B to D (origin/main will be D).
  git(subSrc, ['checkout', 'main']);
  const shaD = commitFile(subSrc, 'd.txt', 'D\n', 'D');
  // Ahead lineage: E is a descendant of D (origin/main is an ancestor of E).
  git(subSrc, ['checkout', '-b', 'ahead']);
  const shaE = commitFile(subSrc, 'e.txt', 'E\n', 'E');
  git(subSrc, ['checkout', 'main']);
  git(subSrc, ['remote', 'add', 'origin', subRemote]);
  git(subSrc, ['push', 'origin', 'main', 'feature', 'ahead']);

  // --- super repo with `sub` as a real submodule -----------------------------
  const superPath = join(root, 'super');
  git(root, ['init', '--initial-branch=main', superPath]);
  // Allow adding a local-path submodule (newer git blocks file:// transport by default).
  git(superPath, [
    '-c',
    'protocol.file.allow=always',
    'submodule',
    'add',
    '-b',
    'main',
    subRemote,
    'sub',
  ]);
  const subPath = join(superPath, 'sub');
  const subRelPath = 'sub';
  // Ensure origin/main, origin/feature and origin/ahead refs + all objects (C, E)
  // exist in the submodule clone (the clone may default to fetching only main).
  git(subPath, ['fetch', 'origin', 'main', 'feature', 'ahead']);
  git(superPath, ['add', '.gitmodules', 'sub']);
  git(superPath, ['commit', '-m', 'add sub submodule']);

  return { root, superPath, subPath, subRelPath, shaA, shaB, shaC, shaD, shaE };
}

/** Repoint the superproject gitlink (staged index) to a given submodule SHA. */
function repointGitlink(superPath: string, subRelPath: string, sha: string): void {
  git(superPath, ['update-index', '--cacheinfo', `160000,${sha},${subRelPath}`]);
}

/**
 * Remove the `branch = ...` field from a submodule's `.gitmodules` entry so the
 * guard must fall back to its DEFAULT_BRANCH (`main`). Mirrors a real-world
 * `.gitmodules` that omits the tracked-branch field.
 */
function stripGitmodulesBranch(superPath: string, subName: string): void {
  git(superPath, ['config', '--file', '.gitmodules', '--unset', `submodule.${subName}.branch`]);
}

/**
 * Delete the local `origin/<branch>` remote-tracking ref inside the submodule
 * clone, simulating an environment where that ref hasn't been fetched. The
 * pinned commit object itself remains present.
 */
function deleteOriginBranchRef(subPath: string, branch: string): void {
  git(subPath, ['update-ref', '-d', `refs/remotes/origin/${branch}`]);
}

function runGuard(cwd: string): { status: number | null; stdout: string; stderr: string } {
  const res = spawnSync('node', ['--import', TSX_LOADER_ABS, SCRIPT_ABS], {
    cwd,
    // Execute against the fixture's git tree via cwd; the script + tsx loader are
    // resolved by absolute path so module resolution does not depend on cwd.
    env: { ...GIT_ENV, PWD: cwd },
    encoding: 'utf8',
    timeout: 60_000,
  });
  if (res.error) throw res.error;
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

describe('check-submodule-pin-ancestry', () => {
  let fx: Fixture;

  beforeEach(() => {
    fx = buildFixture();
  });

  afterEach(() => {
    if (fx?.root) rmSync(fx.root, { recursive: true, force: true });
  });

  it('PASS: exits 0 when the gitlink is pinned to a commit on origin/main (B)', () => {
    repointGitlink(fx.superPath, fx.subRelPath, fx.shaB);
    const res = runGuard(fx.superPath);
    expect(res.stderr + res.stdout).toContain('OK');
    expect(res.status).toBe(0);
  });

  it('PASS: exits 0 when the gitlink is pinned to an older commit on origin/main (A)', () => {
    repointGitlink(fx.superPath, fx.subRelPath, fx.shaA);
    const res = runGuard(fx.superPath);
    expect(res.status).toBe(0);
  });

  it('PASS: exits 0 when the gitlink is pinned to the tip of origin/main (D)', () => {
    repointGitlink(fx.superPath, fx.subRelPath, fx.shaD);
    const res = runGuard(fx.superPath);
    expect(res.stderr + res.stdout).toContain('OK');
    expect(res.status).toBe(0);
  });

  it('FAIL: exits 1 when the gitlink is on a divergent feature commit (C) — the orphan class', () => {
    // C branched off B and never contains D; origin/main has advanced to D.
    // Neither C nor D is an ancestor of the other -> DIVERGED -> the orphan class.
    repointGitlink(fx.superPath, fx.subRelPath, fx.shaC);
    const res = runGuard(fx.superPath);
    expect(res.status).toBe(1);
    const out = res.stderr + res.stdout;
    expect(out).toContain('FAIL');
    expect(out).toMatch(/DIVERGED|submodule-pin-orphan|orphan class/);
    expect(out).toContain(fx.shaC);
  });

  it('FAIL: exits 1 when the gitlink is AHEAD of origin/main (E, a local commit not yet landed on the branch) — the orphan-prone shape', () => {
    // E is a descendant of origin/main (D): origin/main is an ancestor of E, so
    // the pin is built on main but NOT yet reachable from origin/main. Per the
    // Devil's-Advocate finding this is the exact orphan-prone shape (a commit
    // built on main but never merged back, the way bulk_export was lost), so the
    // STRICT invariant HARD-FAILS it: a pushed superproject pin that is not on
    // origin/<branch> will be silently dropped on the next pointer re-align.
    repointGitlink(fx.superPath, fx.subRelPath, fx.shaE);
    const res = runGuard(fx.superPath);
    expect(res.status).toBe(1);
    const out = res.stderr + res.stdout;
    expect(out).toContain('FAIL');
    expect(out).toMatch(/AHEAD|not .*landed|push it to|submodule-pin-orphan/i);
  });

  it('SKIP: exits 0 when the gitlink points at a SHA absent from the submodule clone (unverifiable)', () => {
    // A syntactically valid 40-hex SHA that is not a real object in the clone.
    // An absent pinned object cannot be verified offline -> SKIP, not FAIL: the
    // guard only hard-fails when it can DEFINITIVELY prove an orphan.
    const phantom = 'deadbeef'.repeat(5); // 40 chars
    repointGitlink(fx.superPath, fx.subRelPath, phantom);
    const res = runGuard(fx.superPath);
    expect(res.status).toBe(0);
    const out = res.stderr + res.stdout;
    expect(out).toContain('SKIP');
    expect(out).toMatch(/not initialized|absent|cannot verify/i);
  });

  it('SKIP: exits 0 when the pinned commit is present but origin/<branch> ref is not (unverifiable)', () => {
    // F3: pin to B (a real, present commit on main), but delete the local
    // origin/main remote-tracking ref so ancestry cannot be checked offline.
    // A missing tracked-branch ref must SKIP (fetch-then-retry), never false-fail.
    repointGitlink(fx.superPath, fx.subRelPath, fx.shaB);
    deleteOriginBranchRef(fx.subPath, 'main');
    const res = runGuard(fx.superPath);
    expect(res.status).toBe(0);
    const out = res.stderr + res.stdout;
    expect(out).toContain('SKIP');
    expect(out).toMatch(/not present|fetch origin main/i);
  });

  it('default-branch: a .gitmodules entry with no branch field defaults to main (verified against origin/main)', () => {
    // F3: omit the `branch` field entirely -> guard must default to `main`. Pin
    // to B (on origin/main): with the default applied it verifies against
    // origin/main and PASSES (OK). Pin to C (diverged from D): it must still
    // FAIL against origin/main.
    stripGitmodulesBranch(fx.superPath, 'sub');

    repointGitlink(fx.superPath, fx.subRelPath, fx.shaB);
    const pass = runGuard(fx.superPath);
    expect(pass.status).toBe(0);
    expect(pass.stderr + pass.stdout).toContain('OK');
    expect(pass.stderr + pass.stdout).toContain('origin/main');

    repointGitlink(fx.superPath, fx.subRelPath, fx.shaC);
    const fail = runGuard(fx.superPath);
    expect(fail.status).toBe(1);
    const out = fail.stderr + fail.stdout;
    expect(out).toContain('FAIL');
    expect(out).toMatch(/DIVERGED|submodule-pin-orphan|orphan class/);
  });
});
