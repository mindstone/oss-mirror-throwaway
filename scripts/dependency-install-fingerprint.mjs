#!/usr/bin/env node
// Single source of truth for "what determines a checkout's installed node_modules".
//
// `npm ci` is a function of MORE than package-lock.json (GPT review F1): package.json,
// the node/npm version, platform/arch/libc, and any repo-local lifecycle scripts that
// run during install can all change the installed tree without touching the lockfile.
// Keying a cache — or a freshness sentinel — on the lockfile alone would silently reuse
// a tree built under different conditions (e.g. an old patch-script).
//
// This module computes a single "install fingerprint" (sha256 hex) over all of those
// inputs. It is the ONE place where install-affecting inputs are enumerated, so any
// change to them is reviewed here. Two consumers:
//   1. scripts/ensure-deps-fresh.mjs  — Stage 1 freshness sentinel.
//   2. scripts/worktree-postinit.sh   — Stage 2 CoW template-cache key.
//
// Dependency-free (node builtins only) so it runs in any checkout state.

import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Repo-local scripts that run during `npm ci` (root package.json `postinstall`). Their
// CONTENT affects the installed tree (they patch files inside node_modules), so it must
// feed the fingerprint. Keep this list in sync with the root `postinstall` chain — this
// is the single reviewed chokepoint for it.
const INSTALL_AFFECTING_SCRIPTS = [
  'scripts/patch-electron-osx-sign-walkasync.mjs',
  'scripts/patch-vitest-sourcemap.mjs',
];

function hashFileInto(hash, path, label) {
  if (existsSync(path)) {
    hash.update(`\n#${label}:`);
    hash.update(readFileSync(path));
  } else {
    hash.update(`\n#${label}:<absent>`);
  }
}

function npmVersion() {
  try {
    const isWin = process.platform === 'win32';
    const r = spawnSync(isWin ? 'npm.cmd' : 'npm', ['--version'], {
      encoding: 'utf8',
      shell: isWin,
    });
    if (r.status !== 0) return 'unknown';
    // major.minor only — a patch bump almost never changes `npm ci`'s installed tree,
    // and keying on the full version would force a fleet-wide reinstall + cache rebuild
    // on every npm patch release for no benefit (review N2).
    return r.stdout.trim().split('.').slice(0, 2).join('.');
  } catch {
    return 'unknown';
  }
}

function libcTag() {
  if (process.platform !== 'linux') return 'n/a';
  try {
    // process.report exposes the runtime glibc version where present; musl reports none.
    const header = process.report?.getReport?.()?.header;
    return header?.glibcVersionRuntime ? `glibc-${header.glibcVersionRuntime}` : 'musl-or-unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * Compute the install fingerprint for a checkout directory.
 * @param {string} dir directory containing package.json + package-lock.json
 * @returns {string} sha256 hex, or throws if package-lock.json is absent (broken checkout)
 */
function computeFingerprint(dir = REPO_ROOT) {
  const lockfile = join(dir, 'package-lock.json');
  if (!existsSync(lockfile)) {
    throw new Error(`no package-lock.json in ${dir} — cannot fingerprint a checkout without a lockfile`);
  }
  const hash = createHash('sha256');
  hash.update(`node:${process.version.split('.')[0]}`); // major only — minor/patch don't change ABI
  hash.update(`;npm:${npmVersion()}`);
  hash.update(`;platform:${process.platform};arch:${process.arch};libc:${libcTag()}`);
  hashFileInto(hash, lockfile, 'package-lock.json');
  // package-lock.json already pins every dependency (and overrides/resolutions are
  // baked into its resolution — npm ci FAILS if package.json deps and the lockfile
  // disagree). So the only install-affecting parts of package.json NOT already
  // captured by the lockfile are the install lifecycle SCRIPTS. Hash just those — not
  // the whole file — so routine `version`/other-script edits don't needlessly
  // invalidate (a version bump must not trigger a reinstall on every dev launch).
  hash.update('\n#package.json-install-scripts:');
  try {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    const scripts = pkg.scripts ?? {};
    for (const key of ['preinstall', 'install', 'postinstall']) {
      hash.update(`\n${key}=${scripts[key] ?? ''}`);
    }
  } catch {
    hash.update('<no-package.json>');
  }
  // Install-affecting repo-local scripts always resolve from the repo root (they patch
  // the root tree); including them in every fingerprint is conservatively safe.
  for (const rel of INSTALL_AFFECTING_SCRIPTS) {
    hashFileInto(hash, join(REPO_ROOT, rel), rel);
  }
  // npm config (.npmrc) changes `npm ci`'s resolution/output (this repo pins
  // legacy-peer-deps; settings like omit/install-links/registry change the installed
  // tree), so it's a genuine install input (GPT review F2). Hash the repo-root .npmrc
  // and the install dir's own .npmrc when it differs.
  const rootNpmrc = join(REPO_ROOT, '.npmrc');
  hashFileInto(hash, rootNpmrc, '.npmrc');
  const dirNpmrc = join(dir, '.npmrc');
  if (resolve(dirNpmrc) !== resolve(rootNpmrc)) {
    hashFileInto(hash, dirNpmrc, 'dir/.npmrc');
  }
  return hash.digest('hex');
}

export { computeFingerprint, INSTALL_AFFECTING_SCRIPTS };

// CLI: print the fingerprint for the given dir (default repo root) so shell callers
// (worktree-postinit.sh) can capture it. Exits non-zero with a message on a broken
// checkout — never prints a bogus fingerprint.
if (resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1] ?? '')) {
  try {
    const dir = process.argv[2] ? resolve(process.argv[2]) : REPO_ROOT;
    process.stdout.write(computeFingerprint(dir) + '\n');
  } catch (err) {
    process.stderr.write(`[dependency-install-fingerprint] ${err.message}\n`);
    process.exit(1);
  }
}
