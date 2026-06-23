/**
 * scripts/build-browser-extension.ts
 *
 * Builds the Rebel browser extension (`packages/browser-extension/`) and zips
 * the bundled `dist/` directory into `dist/browser-extension.zip` at the repo
 * root so Playwright E2E (via `--load-extension=<path>`) and human side-load
 * installation share the same artifact.
 *
 * Why a dedicated script (and not just `npm --prefix packages/browser-extension run build`)?
 *   1. We need a deterministic output path at the repo root so Playwright, CI,
 *      and manual testers can all find the ZIP in the same place.
 *   2. We want a single entry point we can wire into `package.json` and CI —
 *      adding steps later (signing, version bumping) is then a local change.
 *   3. Cross-platform zip: we reuse `adm-zip` (already a prod dependency via
 *      other MCP bundling scripts) so we don't need a system `zip` binary.
 *
 * The script is intentionally linear and fail-loud:
 *   - If the extension build fails, we surface stderr and exit non-zero.
 *   - If no dist files are produced (e.g. a vite misconfiguration), we fail
 *     before zipping rather than shipping an empty artifact.
 *
 * Output:
 *   - `packages/browser-extension/dist/**`
 *   - `dist/browser-extension.zip` (also echoed in stdout)
 *
 * @see docs/plans/260418_rebel_app_bridge_and_browser_extension.md (Stage 9 §A)
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import AdmZip from 'adm-zip';

const REPO_ROOT = path.resolve(__dirname, '..');
const EXTENSION_DIR = path.join(REPO_ROOT, 'packages', 'browser-extension');
const EXTENSION_DIST_DIR = path.join(EXTENSION_DIR, 'dist');
const EXTENSION_NODE_MODULES = path.join(EXTENSION_DIR, 'node_modules');
const EXTENSION_LOCKFILE = path.join(EXTENSION_DIR, 'package-lock.json');
const EXTENSION_HASH_FILE = path.join(EXTENSION_NODE_MODULES, '.package-lock-hash');
const OUTPUT_DIR = path.join(REPO_ROOT, 'dist');
const OUTPUT_ZIP = path.join(OUTPUT_DIR, 'browser-extension.zip');

async function exists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

async function hashFile(filePath: string): Promise<string> {
  const buf = await fs.readFile(filePath);
  return createHash('sha256').update(buf).digest('hex');
}

/**
 * Install `packages/browser-extension/node_modules` iff missing or stale.
 *
 * Mirrors the root-level pattern in `scripts/check-deps-freshness.js`: store a
 * SHA-256 hash of `package-lock.json` inside `node_modules/.package-lock-hash`
 * after install; compare on every run; re-install via `npm ci` when they differ.
 * Fast path on warm machines (just two file reads); safe across branch switches
 * and git pulls that bump the extension's lockfile.
 */
async function ensureExtensionDeps(): Promise<void> {
  if (!(await exists(EXTENSION_LOCKFILE))) {
    throw new Error(
      `Expected extension lockfile at ${EXTENSION_LOCKFILE} — cannot verify or install deps`,
    );
  }

  const currentHash = await hashFile(EXTENSION_LOCKFILE);

  if (await exists(EXTENSION_NODE_MODULES)) {
    if (await exists(EXTENSION_HASH_FILE)) {
      const storedHash = (await fs.readFile(EXTENSION_HASH_FILE, 'utf8')).trim();
      if (storedHash === currentHash) {
        return;
      }
      console.log(
        '[build-browser-extension] extension lockfile changed — running npm ci...',
      );
    } else {
      console.log(
        '[build-browser-extension] extension deps hash missing — running npm ci...',
      );
    }
  } else {
    console.log(
      '[build-browser-extension] extension node_modules missing — running npm ci...',
    );
  }

  await runNpmCi();

  // npm ci wipes and recreates node_modules, so write the hash *after* install.
  await fs.writeFile(EXTENSION_HASH_FILE, currentHash, 'utf8');
}

async function runNpmCi(): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const npmBin = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const child = spawn(npmBin, ['ci'], {
      cwd: EXTENSION_DIR,
      stdio: 'inherit',
      shell: process.platform === 'win32',
      env: process.env,
    });
    child.on('exit', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `npm ci failed in ${EXTENSION_DIR} (exit=${code ?? 'null'}, signal=${signal ?? 'null'})`,
        ),
      );
    });
    child.on('error', (err) => reject(err));
  });
}

async function runExtensionBuild(): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const npmBin = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const child = spawn(npmBin, ['run', 'build'], {
      cwd: EXTENSION_DIR,
      stdio: 'inherit',
      shell: process.platform === 'win32',
      env: process.env,
    });
    child.on('exit', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `browser extension build failed (exit=${code ?? 'null'}, signal=${signal ?? 'null'})`,
        ),
      );
    });
    child.on('error', (err) => reject(err));
  });
}

async function zipDist(): Promise<void> {
  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  if (await exists(OUTPUT_ZIP)) {
    await fs.unlink(OUTPUT_ZIP);
  }
  const zip = new AdmZip();
  zip.addLocalFolder(EXTENSION_DIST_DIR);
  zip.writeZip(OUTPUT_ZIP);
}

async function runDistBundleCheck(): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const npxBin = process.platform === 'win32' ? 'npx.cmd' : 'npx';
    const child = spawn(npxBin, ['tsx', 'scripts/check-extension-dist-bundled.ts'], {
      cwd: REPO_ROOT,
      stdio: 'inherit',
      // shell: true required on Windows to spawn .cmd files since Node's
      // post-CVE-2024-27980 child_process hardening rejects .cmd/.bat without
      // it (returns EINVAL). Matches the pattern used by runNpmCi and
      // runExtensionBuild above.
      shell: process.platform === 'win32',
      env: process.env,
    });
    child.on('exit', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `extension dist bundle check failed (exit=${code ?? 'null'}, signal=${signal ?? 'null'})`,
        ),
      );
    });
    child.on('error', (err) => reject(err));
  });
}

async function verifyArtifact(): Promise<void> {
  const manifestPath = path.join(EXTENSION_DIST_DIR, 'manifest.json');
  if (!(await exists(manifestPath))) {
    throw new Error(
      `Extension build produced no manifest.json at ${manifestPath}. Aborting zip.`,
    );
  }
  await runDistBundleCheck();
  // Sanity-check the zip too.
  const stats = await fs.stat(OUTPUT_ZIP);
  if (stats.size < 1024) {
    throw new Error(
      `Browser extension zip looks suspiciously small (${stats.size} bytes): ${OUTPUT_ZIP}`,
    );
  }
}

async function main(): Promise<void> {
  await ensureExtensionDeps();

  console.log(`[build-browser-extension] building extension in ${EXTENSION_DIR}`);
  await runExtensionBuild();

  console.log(`[build-browser-extension] zipping ${EXTENSION_DIST_DIR} → ${OUTPUT_ZIP}`);
  await zipDist();

  await verifyArtifact();

  const stats = await fs.stat(OUTPUT_ZIP);
  console.log(
    `[build-browser-extension] done. dist=${EXTENSION_DIST_DIR} zip=${OUTPUT_ZIP} size=${stats.size}B`,
  );
}

main().catch((err) => {
  console.error('[build-browser-extension] failed:', err);
  process.exitCode = 1;
});
