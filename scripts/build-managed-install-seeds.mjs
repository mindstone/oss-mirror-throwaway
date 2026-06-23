#!/usr/bin/env node
/**
 * scripts/build-managed-install-seeds.mjs
 *
 * Pre-fetches npm tarballs for desktop-only `provider: rebel-oss` MCP
 * connectors so they can be shipped inside the app bundle and installed
 * without a network round-trip on first launch.
 *
 * Why a seed and not a full bundle?
 *
 *   The Office add-in only works on desktop and is useless without the in-app
 *   sidecar process. Paying the npm fetch cost on first launch is pure
 *   overhead. By packing the published tarball at build time and copying it
 *   into `resources/managed-install-seeds/`, `managedMcpInstallService` can
 *   point npm at `file:<seed-path>` instead of the registry — instant install,
 *   offline-capable, identical resulting layout.
 *
 * Why not just generic-bundle every rebel-oss connector?
 *
 *   `connector-catalog.json` does not yet have a `surfaces` field, so we
 *   cannot programmatically tell which OSS connectors are desktop-only. The
 *   plan (`docs/plans/260503_office_seed_and_permission_replay.md`) explicitly
 *   narrows v1 to **Office only**. Generic seeding is a future extension when
 *   we add `surfaces: ['desktop']` to the catalog schema.
 *
 * Output:
 *   - `dist/managed-install-seeds/mindstone-engineering-mcp-server-office-<version>.tgz`
 *   - `dist/managed-install-seeds/seeds-manifest.json`
 *
 * The filename matches what npm pack produces for a scoped package and is
 * exposed as `OFFICE_MCP_SEED_TARBALL_FILENAME` from `src/shared/sidecar/officePackage.ts`.
 *
 * Idempotent: skips re-downloading when the same version already exists in
 * the output directory (use `--force` to re-fetch).
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { copyFile, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp } from 'node:fs/promises';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = join(__dirname, '..');
const OUTPUT_DIR = join(REPO_ROOT, 'dist', 'managed-install-seeds');
const OFFICE_PACKAGE_CONSTANTS_PATH = join(REPO_ROOT, 'src', 'shared', 'sidecar', 'officePackage.ts');
const SEEDS_MANIFEST_FILENAME = 'seeds-manifest.json';

const force = process.argv.includes('--force');

async function loadOfficeSeedTarget() {
  // Keep the Node-only seed builder sourced from the TypeScript SSOT without
  // requiring tsx in this script's direct `node ...` execution path. This
  // mirrors scripts/check-office-package-version.ts and means bumping
  // OFFICE_MCP_PACKAGE_VERSION updates the seed target automatically.
  const source = await readFile(OFFICE_PACKAGE_CONSTANTS_PATH, 'utf8');
  const nameMatch = source.match(/OFFICE_MCP_PACKAGE_NAME\s*=\s*'([^']+)'/);
  const versionMatch = source.match(/OFFICE_MCP_PACKAGE_VERSION\s*=\s*'([^']+)'/);
  if (!nameMatch || !versionMatch) {
    throw new Error(`Could not extract Office package constants from ${OFFICE_PACKAGE_CONSTANTS_PATH}`);
  }
  const packageName = nameMatch[1];
  const version = versionMatch[1];
  return {
    spec: `${packageName}@${version}`,
    filename: `${packageName.replace(/^@/, '').replace(/\//g, '-')}-${version}.tgz`,
  };
}

async function fileExists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

function runNpm(args, options) {
  return new Promise((resolve, reject) => {
    const npmBin = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const child = spawn(npmBin, args, {
      stdio: ['ignore', 'pipe', 'inherit'],
      shell: process.platform === 'win32',
      env: process.env,
      ...options,
    });
    let stdout = '';
    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.on('exit', (code, signal) => {
      if (code === 0) {
        resolve(stdout.trim());
        return;
      }
      reject(
        new Error(
          `npm ${args.join(' ')} failed (exit=${code ?? 'null'}, signal=${signal ?? 'null'})`,
        ),
      );
    });
    child.on('error', reject);
  });
}

async function packTo(spec, expectedFilename) {
  // npm pack <spec> downloads the registry tarball into the cwd and prints
  // the filename to stdout. We pack into a temp dir to avoid polluting the
  // repo root, then copy the artifact to OUTPUT_DIR with a verified name.
  const tempDir = await mkdtemp(join(tmpdir(), 'rebel-seed-'));
  try {
    const out = await runNpm(['pack', spec, '--silent'], { cwd: tempDir });
    // npm pack emits the filename last on stdout. With --silent it should be
    // the only output, but we still take the last non-empty line to be safe.
    const lines = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const actual = lines[lines.length - 1];
    if (!actual) {
      throw new Error(`npm pack produced no filename for ${spec}`);
    }
    if (actual !== expectedFilename) {
      throw new Error(
        `npm pack produced "${actual}" but seed config expects "${expectedFilename}". ` +
          `Update OFFICE_MCP_SEED_TARBALL_FILENAME in src/shared/sidecar/officePackage.ts ` +
          `to match what npm actually emits.`,
      );
    }
    const src = join(tempDir, actual);
    const dest = join(OUTPUT_DIR, actual);
    await copyFile(src, dest);
    return dest;
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function buildManifest(targets) {
  const seeds = [];
  for (const target of targets) {
    const tarballPath = join(OUTPUT_DIR, target.filename);
    const bytes = await readFile(tarballPath);
    seeds.push({
      filename: target.filename,
      packageSpec: target.spec,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      sizeBytes: bytes.byteLength,
    });
  }

  return {
    version: 1,
    seeds,
  };
}

async function writeManifestAtomically(manifest) {
  const manifestPath = join(OUTPUT_DIR, SEEDS_MANIFEST_FILENAME);
  const tempPath = join(
    OUTPUT_DIR,
    `${SEEDS_MANIFEST_FILENAME}.tmp-${process.pid}-${Date.now()}`,
  );
  await writeFile(tempPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  await rename(tempPath, manifestPath);
  return manifestPath;
}

async function main() {
  // Targets: kept in lockstep with the Office spec/filename constants in
  // `src/shared/sidecar/officePackage.ts`. When the catalog grows a real
  // `surfaces` field, replace this static list with a catalog-driven filter.
  const SEED_TARGETS = [await loadOfficeSeedTarget()];

  if (!existsSync(OUTPUT_DIR)) {
    mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  // Prune stale tarballs (other versions of the same package). This keeps the
  // packaged resources folder lean and avoids confusion when the seed config
  // bumps a version.
  const expectedFilenames = new Set(SEED_TARGETS.map((t) => t.filename));
  const existing = await readdir(OUTPUT_DIR);
  for (const name of existing) {
    if (!name.endsWith('.tgz')) continue;
    if (!expectedFilenames.has(name)) {
      const stalePath = join(OUTPUT_DIR, name);
      console.log(`[seeds] removing stale tarball ${name}`);
      await rm(stalePath, { force: true });
    }
  }

  for (const target of SEED_TARGETS) {
    const dest = join(OUTPUT_DIR, target.filename);
    if (!force && (await fileExists(dest))) {
      console.log(`[seeds] ${target.filename} already present — skipping (use --force to re-fetch)`);
      continue;
    }
    console.log(`[seeds] packing ${target.spec} → ${target.filename}`);
    const written = await packTo(target.spec, target.filename);
    const sz = (await stat(written)).size;
    console.log(`[seeds] wrote ${written} (${sz} bytes)`);
  }

  const manifest = await buildManifest(SEED_TARGETS);
  const manifestPath = await writeManifestAtomically(manifest);
  console.log(`[seeds] wrote ${manifestPath} (${manifest.seeds.length} entries)`);
  console.log(`[seeds] done. output=${OUTPUT_DIR}`);
}

main().catch((err) => {
  console.error('[seeds] failed:', err);
  process.exitCode = 1;
});
