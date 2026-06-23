#!/usr/bin/env node
// Ensure the current checkout's installed node_modules matches its lockfile,
// auto-running `npm ci` when they've drifted.
//
// Why this exists: package-lock.json (the "recipe") updates the instant you sync,
// but node_modules (the "cooked meal") only changes when you run `npm ci`. After a
// pull that bumped deps, a checkout silently runs against stale dependency versions
// until someone remembers to reinstall — the classic "works on my machine, breaks in
// CI" ghost. This check closes that gap for the everyday `npm run dev` /
// `npm run package:run` paths, and self-heals stale worktrees too.
//
// The signal: a sha256 INSTALL FINGERPRINT (see dependency-install-fingerprint.mjs),
// stored in node_modules/.rebel-deps-fingerprint after each successful install. We do
// NOT byte-compare node_modules/.package-lock.json against package-lock.json — npm's
// hidden lockfile legitimately differs (it omits the root entry and all cross-platform
// optional deps not installed on this OS/arch — measured: 207 such packages here), so
// that compare always reports drift. The fingerprint hashes the install *inputs*, which
// is platform-stable and correct, and is the same key Stage 2's CoW cache uses.
//
// Resolves the checkout root from this script's own location, so it works regardless
// of cwd and correctly targets a worktree when invoked from within one.
//
// Escape hatches: REBEL_SKIP_DEPS_FRESH=1 (opt out), or CI (CI manages its own deps
// deterministically — never surprise-reinstall there).

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { computeFingerprint } from './dependency-install-fingerprint.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SENTINEL = '.rebel-deps-fingerprint';
const TAG = '[ensure-deps-fresh]';

function readSentinel(dir) {
  const path = join(dir, 'node_modules', SENTINEL);
  if (!existsSync(path)) return null;
  try {
    return readFileSync(path, 'utf8').trim();
  } catch {
    return null; // unreadable → treat as missing → reinstall (fail-safe, observable below)
  }
}

function writeSentinel(dir, fingerprint) {
  try {
    writeFileSync(join(dir, 'node_modules', SENTINEL), fingerprint + '\n');
  } catch (err) {
    // Non-fatal: the install succeeded; we just couldn't memoize the fingerprint, so
    // the next launch will recompute + reinstall once. Surface it rather than hide it.
    console.warn(`${TAG} could not write ${SENTINEL}: ${err.message} (next launch will re-verify)`);
  }
}

function runNpmCi(dir) {
  console.log(`${TAG} node_modules is out of sync with package-lock.json — running \`npm ci\`...`);
  const isWin = process.platform === 'win32';
  const result = spawnSync(
    isWin ? 'npm.cmd' : 'npm',
    ['ci', '--prefer-offline', '--no-audit', '--no-fund'],
    { cwd: dir, stdio: 'inherit', shell: isWin },
  );
  if (result.error) {
    console.error(`${TAG} failed to spawn npm: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(`${TAG} \`npm ci\` exited with code ${result.status}. Resolve the failure above before continuing.`);
    process.exit(result.status ?? 1);
  }
  console.log(`${TAG} dependencies reinstalled ✓`);
}

function ensureDepsFresh(dir = REPO_ROOT) {
  if (process.env.REBEL_SKIP_DEPS_FRESH === '1') {
    console.log(`${TAG} skipped (REBEL_SKIP_DEPS_FRESH=1).`);
    return;
  }
  if (process.env.CI) {
    // CI installs deps deterministically; a surprise reinstall here would be noise
    // (and on a cache miss, slow). Stay out of its way.
    return;
  }

  let fingerprint;
  try {
    fingerprint = computeFingerprint(dir);
  } catch (err) {
    // No lockfile = broken checkout. Fail loud rather than silently skip.
    console.error(`${TAG} ${err.message}. This looks like a broken checkout.`);
    process.exit(1);
  }

  const installed = existsSync(join(dir, 'node_modules'));
  const sentinel = readSentinel(dir);

  if (installed && sentinel === fingerprint) {
    console.log(`${TAG} node_modules matches package-lock.json ✓`);
    return;
  }

  // Either never installed, no sentinel (e.g. pre-existing checkout — one-time
  // reinstall), or the install inputs changed. Reinstall, then memoize.
  runNpmCi(dir);
  writeSentinel(dir, fingerprint);
}

export { ensureDepsFresh };

// Run as CLI when invoked directly (e.g. via a `prepackage` npm hook).
if (resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1] ?? '')) {
  ensureDepsFresh();
}
