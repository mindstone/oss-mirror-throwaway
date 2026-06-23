#!/usr/bin/env node
/**
 * build-oss-mirror-bundle — produce a FAITHFUL OSS mirror FORGE bundle for the boot smoke.
 *
 * WHY THIS EXISTS
 * ---------------
 * The launch gate (`scripts/check-oss-boot-smoke.ts`) needs a built main bundle to launch.
 * The faithful public-build target is the TRANSFORMED MIRROR tree — the exact source that
 * ships to the public OSS repo — NOT the canonical checkout with `private/` detached
 * (`mv private`). They differ in subtle, boot-relevant ways:
 *   - The mirror runs `mirror/transform.ts`: content substitutions, dependency stripping
 *     (e.g. rudderstack removed from package.json), path deletions, and the `private/` →
 *     stub replacement. `mv private` only hides the directory — it skips every other
 *     transform, so a crash introduced by (or masked by) a substitution would be invisible.
 *   - In the mirror, `private/` contains only the stub `README.md`; `private/mindstone/src/
 *     bootstrap.ts` is GONE. So `vite.main.config.mjs`'s `existsSync(privateMindstoneBootstrapPath)`
 *     is false and `@private/mindstone` resolves to `src/main/oss/private-mindstone-stub` —
 *     exactly the public-build code path. This reproduces the real OSS boot graph faithfully.
 *
 * WHAT IT DOES
 * ------------
 *   1. Picks a gitignored workdir: `.local/oss-boot-mirror/` under the repo root.
 *   2. Transforms the canonical repo into a FRESH EMPTY temp dir (the transform requires an
 *      empty/nonexistent output — see mirror/transform.ts ensureWritableOutputRoot), then
 *      syncs that transformed SOURCE into the workdir, preserving the cached `node_modules`.
 *   3. Provides `node_modules` cheaply: a hardlink clone (`cp -al`) from the repo's existing
 *      node_modules (fast, same filesystem). Hash-gated on package-lock.json so repeat runs
 *      skip re-cloning. Falls back to `npm ci` only if the hardlink clone fails. Extra modules
 *      present (e.g. rudderstack, which the mirror strips from package.json) are harmless for a
 *      boot test — we only care that the bundle boots past bootstrap.
 *   4. Builds the FORGE bundle: spawns `electron-forge start` (which builds `.vite/build/*`
 *      via the Vite plugin, then launches), polls for `<workdir>/.vite/build/bootstrap.js`,
 *      then kills the spawned Electron. This is the lightest reliable path — `npm run package`
 *      runs a heavy `prebuild` (bundle:node, super-mcp, bundled-mcps) that the boot crash lives
 *      far in front of.
 *   5. Prints the absolute bundle path on the LAST line as `OSS_MIRROR_BUNDLE=<path>`.
 *
 * USAGE
 *   node scripts/build-oss-mirror-bundle.mjs [--force-deps] [--keep-build]
 *   (normally invoked via `npm run validate:oss-boot-smoke`)
 */

import { spawn, spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const WORKDIR = path.join(REPO_ROOT, '.local', 'oss-boot-mirror');
const WORK_SOURCE = path.join(WORKDIR, 'source');
const WORK_NODE_MODULES = path.join(WORK_SOURCE, 'node_modules');
const DEPS_STAMP = path.join(WORKDIR, '.node_modules.lockhash');
const BUNDLE_PATH = path.join(WORK_SOURCE, '.vite', 'build', 'bootstrap.js');

const argv = process.argv.slice(2);
const FORCE_DEPS = argv.includes('--force-deps');
const KEEP_BUILD = argv.includes('--keep-build');

const log = (msg) => console.error(`[oss-mirror-build] ${msg}`);
const fail = (msg) => {
  console.error(`[oss-mirror-build] FATAL: ${msg}`);
  process.exit(1);
};

// Phase timeouts (ms). The forge build has its own BUILD_TIMEOUT_MS (below); these bound the
// two unbounded spawnSync phases so a hung transform / npm-ci can't silently consume the whole
// CI job budget. A spawnSync that hits its `timeout` returns with `.signal` set (SIGTERM) — we
// treat that as a hard fail with a distinct message so a hang is attributable, not silent.
const TRANSFORM_TIMEOUT_MS = 8 * 60_000;
const NPM_CI_TIMEOUT_MS = 8 * 60_000;

function lockHash() {
  const lockPath = path.join(REPO_ROOT, 'package-lock.json');
  if (!existsSync(lockPath)) return 'no-lockfile';
  return createHash('sha256').update(readFileSync(lockPath)).digest('hex');
}

/** Step 1+2: regenerate the transformed mirror SOURCE into the workdir. */
function regenerateMirrorSource() {
  // Transform requires an EMPTY/nonexistent output dir. Transform into a fresh temp dir,
  // then sync into the workdir's `source` while preserving cached node_modules.
  const tmpOut = mkdtempSync(path.join(os.tmpdir(), 'oss-mirror-transform-'));
  rmSync(tmpOut, { recursive: true, force: true }); // transform wants it absent or empty

  log(`transforming canonical repo → ${tmpOut}`);
  const transform = spawnSync(
    'npx',
    ['tsx', path.join(REPO_ROOT, 'mirror', 'transform.ts'), '--source', REPO_ROOT, '--output', tmpOut],
    { cwd: REPO_ROOT, stdio: ['ignore', 'inherit', 'inherit'], env: process.env, timeout: TRANSFORM_TIMEOUT_MS },
  );
  if (transform.signal) {
    rmSync(tmpOut, { recursive: true, force: true });
    fail(`mirror/transform.ts killed by signal ${transform.signal} (likely the ${TRANSFORM_TIMEOUT_MS}ms timeout)`);
  }
  if (transform.status !== 0) {
    rmSync(tmpOut, { recursive: true, force: true });
    fail(`mirror/transform.ts exited with code ${transform.status}`);
  }
  if (!existsSync(path.join(tmpOut, 'package.json'))) {
    rmSync(tmpOut, { recursive: true, force: true });
    fail('transform produced no package.json — output looks empty');
  }

  // Replace the workdir's transformed SOURCE (but keep cached node_modules + deps stamp).
  // We move node_modules aside, wipe source, restore node_modules, then copy the fresh tree
  // over the top (excluding any node_modules in the transform output — there isn't one, but
  // be defensive). Simpler + robust: remove everything in WORK_SOURCE except node_modules.
  mkdirSync(WORKDIR, { recursive: true });
  if (existsSync(WORK_SOURCE)) {
    for (const entry of readdirSync(WORK_SOURCE)) {
      if (entry === 'node_modules') continue;
      rmSync(path.join(WORK_SOURCE, entry), { recursive: true, force: true });
    }
  } else {
    mkdirSync(WORK_SOURCE, { recursive: true });
  }

  log(`syncing transformed source → ${WORK_SOURCE}`);
  // Copy transform output into WORK_SOURCE. The transform output has no node_modules, so this
  // won't clobber the cached one.
  cpSync(tmpOut, WORK_SOURCE, { recursive: true });
  rmSync(tmpOut, { recursive: true, force: true });
}

/** Step 3: ensure node_modules exists in the workdir (hardlink clone, hash-gated). */
function ensureNodeModules() {
  const want = lockHash();
  const have = existsSync(DEPS_STAMP) ? readFileSync(DEPS_STAMP, 'utf-8').trim() : null;

  if (!FORCE_DEPS && existsSync(WORK_NODE_MODULES) && have === want) {
    log('node_modules cache hit (lockfile unchanged) — reusing');
    return;
  }

  if (existsSync(WORK_NODE_MODULES)) {
    log('node_modules stale or forced — removing cached copy');
    rmSync(WORK_NODE_MODULES, { recursive: true, force: true });
  }

  const repoNodeModules = path.join(REPO_ROOT, 'node_modules');
  let cloned = false;
  if (existsSync(repoNodeModules)) {
    log('hardlink-cloning node_modules from repo (cp -al)');
    // BSD (macOS) and GNU cp both support -a (archive) and -l (hardlink). cp -al copies the
    // tree as hardlinks — near-instant, same inodes, same filesystem. Symlinks in .bin are
    // preserved by -a.
    const clone = spawnSync('cp', ['-al', repoNodeModules, WORK_NODE_MODULES], {
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    if (clone.status === 0 && existsSync(WORK_NODE_MODULES)) {
      cloned = true;
    } else {
      log(`hardlink clone failed (status ${clone.status}) — falling back to npm ci`);
      rmSync(WORK_NODE_MODULES, { recursive: true, force: true });
    }
  } else {
    log('repo node_modules missing — falling back to npm ci');
  }

  if (!cloned) {
    log('running `npm ci` in workdir source (slow path)');
    const ci = spawnSync('npm', ['ci'], {
      cwd: WORK_SOURCE,
      stdio: ['ignore', 'inherit', 'inherit'],
      env: process.env,
      timeout: NPM_CI_TIMEOUT_MS,
    });
    if (ci.signal) fail(`npm ci in workdir killed by signal ${ci.signal} (likely the ${NPM_CI_TIMEOUT_MS}ms timeout)`);
    if (ci.status !== 0) fail(`npm ci in workdir exited with code ${ci.status}`);
  }

  writeFileSync(DEPS_STAMP, want, 'utf-8');
}

/** Step 4: build the FORGE bundle by spawning electron-forge start, then killing once built. */
async function buildForgeBundle() {
  if (KEEP_BUILD && existsSync(BUNDLE_PATH)) {
    log('--keep-build and bundle already present — skipping forge build');
    return;
  }
  // Clear any prior bundle so the poll detects THIS build's output, not a stale one.
  rmSync(path.join(WORK_SOURCE, '.vite'), { recursive: true, force: true });

  const forgeBin = path.join(WORK_NODE_MODULES, '.bin', 'electron-forge');
  if (!existsSync(forgeBin)) fail(`electron-forge not found at ${forgeBin}`);

  log('spawning `electron-forge start` to build .vite/build (will kill once bootstrap.js exists)');
  const child = spawn(forgeBin, ['start'], {
    cwd: WORK_SOURCE,
    // Heap bump matches forge.config.cjs / run-electron-vite-build-with-heap-bump for the
    // main-process module graph (Rollup can OOM on the default heap).
    env: { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --max-old-space-size=8192`.trim() },
    stdio: ['ignore', 'pipe', 'pipe'],
    // detached:true puts the child in its OWN process group so we can SIGKILL the WHOLE TREE
    // (forge parent + the Electron it launches + the renderer dev server), not just the parent.
    // CRITICAL on headless Linux/xvfb: `electron-forge start` launches a real, long-lived
    // Electron + a Vite renderer dev server. Killing only the forge parent (the old
    // `child.kill()`) orphaned those grandchildren — they kept holding this step's inherited
    // stderr fd through the CI `2> >(tee …)` process-substitution, so `tee` never saw EOF and
    // the bash step blocked for ~38 min until the job-level cancel reaped the orphans. Killing
    // the process group (`process.kill(-pgid, 'SIGKILL')`) closes their fds and lets the step
    // finish immediately. (On macOS forge usually exits on its own once Electron quits, so the
    // orphan path doesn't manifest there — but the group-kill is correct on every platform.)
    detached: true,
  });

  let out = '';
  child.stdout?.on('data', (b) => {
    out += b.toString();
  });
  child.stderr?.on('data', (b) => {
    out += b.toString();
  });

  const BUILD_TIMEOUT_MS = 8 * 60_000; // 8 min — the vite main build can be slow cold.
  const startedAt = Date.now();

  const killChild = () => {
    // Kill the whole process GROUP (negative pid), so forge's Electron + renderer-devserver
    // grandchildren die too and release this process's inherited stderr fd. Fall back to a
    // direct child kill if the group kill can't apply.
    if (child.pid !== undefined) {
      try {
        process.kill(-child.pid, 'SIGKILL');
        return;
      } catch (err) {
        // ESRCH = group already gone; anything else (e.g. EPERM) → fall back to child kill.
        if (err && err.code === 'ESRCH') return;
      }
    }
    try {
      child.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  };

  return await new Promise((resolve) => {
    let settled = false;
    const done = (ok, reason) => {
      if (settled) return;
      settled = true;
      killChild();
      if (ok) {
        log(`forge build complete: ${reason}`);
        resolve();
      } else {
        const tail = out.split('\n').slice(-40).join('\n');
        console.error('--- electron-forge output tail ---\n' + tail);
        fail(reason);
      }
    };

    let exited = false;
    child.on('exit', (code) => {
      exited = true;
      // If the bundle exists by exit, treat as success regardless of code (we may have killed it).
      if (existsSync(BUNDLE_PATH)) done(true, 'bundle present at child exit');
      else if (!settled) done(false, `electron-forge start exited (code ${code}) before bundle appeared`);
    });

    const poll = () => {
      if (settled) return;
      if (existsSync(BUNDLE_PATH)) {
        // Give the writer a beat to flush, then accept.
        setTimeout(() => done(true, `bootstrap.js appeared after ${Math.round((Date.now() - startedAt) / 1000)}s`), 1500);
        return;
      }
      if (exited) return; // exit handler will settle
      if (Date.now() - startedAt >= BUILD_TIMEOUT_MS) {
        done(false, `timed out after ${BUILD_TIMEOUT_MS}ms waiting for ${path.relative(WORK_SOURCE, BUNDLE_PATH)}`);
        return;
      }
      setTimeout(poll, 1000);
    };
    setTimeout(poll, 1000);
  });
}

async function main() {
  // Confirm .local/ is gitignored (it is per repo .gitignore) — workdir lives there.
  log(`workdir: ${WORKDIR}`);
  regenerateMirrorSource();
  ensureNodeModules();
  await buildForgeBundle();

  if (!existsSync(BUNDLE_PATH)) fail(`expected bundle missing after build: ${BUNDLE_PATH}`);
  log('OK — faithful OSS mirror bundle built.');
  // LAST line, machine-parseable contract for callers.
  console.log(`OSS_MIRROR_BUNDLE=${BUNDLE_PATH}`);
}

main().catch((err) => fail(err?.stack || String(err)));
