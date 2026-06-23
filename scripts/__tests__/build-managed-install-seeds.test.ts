/**
 * Integration test for `scripts/build-managed-install-seeds.mjs`.
 *
 * Runs the actual script with a stubbed `npm` on PATH so we can validate the
 * end-to-end pipeline behavior — packing a tarball, copying it into the
 * output dir, idempotent skip, and stale-tarball pruning — without touching
 * the real npm registry.
 *
 * Why this matters:
 *   The seed pipeline is the only thing that lets first-launch Office
 *   installs work offline. If the script silently broke (renamed output
 *   path, skipped pruning, accepted wrong filename), the bundle would
 *   ship without seeds and we'd silently fall back to the npm registry on
 *   first launch — exactly the failure mode this whole stage prevents.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  OFFICE_MCP_SEED_TARBALL_FILENAME,
} from '@shared/sidecar/officePackage';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SCRIPT_PATH = path.join(REPO_ROOT, 'scripts', 'build-managed-install-seeds.mjs');
const SEEDS_OUTPUT_DIR = path.join(REPO_ROOT, 'dist', 'managed-install-seeds');

interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Spawn `node <script>` with a minimal PATH that points at our shim dir
 * first. The shim produces a deterministic tarball matching the expected
 * filename so we can assert the script's downstream copy/prune behavior.
 */
function runScript(args: readonly string[], shimDir: string): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      PATH: `${shimDir}${path.delimiter}${process.env['PATH'] ?? ''}`,
    };
    const child = spawn(process.execPath, [SCRIPT_PATH, ...args], {
      cwd: REPO_ROOT,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += String(c)));
    child.stderr.on('data', (c) => (stderr += String(c)));
    child.on('error', reject);
    child.on('exit', (code) => resolve({ exitCode: code ?? -1, stdout, stderr }));
  });
}

/**
 * Write a fake npm shim to `<shimDir>/npm` (or npm.cmd on Windows) that
 * implements just enough of `npm pack <spec> --silent` to return an
 * expected tarball name and create a non-empty file at that name.
 */
async function writeNpmShim(opts: {
  shimDir: string;
  expectedFilename: string;
  bytes: number;
}): Promise<void> {
  await fs.mkdir(opts.shimDir, { recursive: true });
  if (process.platform === 'win32') {
    // Windows: write a .cmd shim. The script invokes `npm.cmd` on win32.
    const cmd = [
      '@echo off',
      'setlocal',
      'if "%1"=="pack" (',
      `  fsutil file createnew "%CD%\\${opts.expectedFilename}" ${opts.bytes} >nul 2>&1`,
      `  echo ${opts.expectedFilename}`,
      '  exit /b 0',
      ')',
      'exit /b 1',
    ].join('\r\n');
    await fs.writeFile(path.join(opts.shimDir, 'npm.cmd'), cmd, 'utf8');
  } else {
    const sh = [
      '#!/usr/bin/env bash',
      'set -e',
      'if [ "$1" = "pack" ]; then',
      // Create a non-empty file with the expected name in cwd.
      `  head -c ${opts.bytes} </dev/urandom > "${opts.expectedFilename}"`,
      `  echo "${opts.expectedFilename}"`,
      '  exit 0',
      'fi',
      'echo "shim: unsupported npm subcommand: $1" >&2',
      'exit 1',
    ].join('\n');
    const shimPath = path.join(opts.shimDir, 'npm');
    await fs.writeFile(shimPath, sh, 'utf8');
    await fs.chmod(shimPath, 0o755);
  }
}

describe('scripts/build-managed-install-seeds.mjs (integration)', () => {
  let tmpRoot: string;
  let shimDir: string;
  let backupDir: string | null;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'seed-script-test-'));
    shimDir = path.join(tmpRoot, 'shim');
    // Preserve any existing seeds the dev environment may have built so the
    // test never destroys real artifacts.
    if (existsSync(SEEDS_OUTPUT_DIR)) {
      backupDir = path.join(tmpRoot, 'backup');
      await fs.cp(SEEDS_OUTPUT_DIR, backupDir, { recursive: true });
      await fs.rm(SEEDS_OUTPUT_DIR, { recursive: true, force: true });
    } else {
      backupDir = null;
    }
  });

  afterEach(async () => {
    // Restore the dev-environment seeds we backed up.
    await fs.rm(SEEDS_OUTPUT_DIR, { recursive: true, force: true });
    if (backupDir) {
      await fs.cp(backupDir, SEEDS_OUTPUT_DIR, { recursive: true });
    }
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it('packs the Office tarball and writes it to dist/managed-install-seeds/', async () => {
    await writeNpmShim({
      shimDir,
      expectedFilename: OFFICE_MCP_SEED_TARBALL_FILENAME,
      bytes: 1024,
    });

    const result = await runScript([], shimDir);
    expect(result.exitCode).toBe(0);

    const written = path.join(SEEDS_OUTPUT_DIR, OFFICE_MCP_SEED_TARBALL_FILENAME);
    const stat = await fs.stat(written);
    expect(stat.isFile()).toBe(true);
    expect(stat.size).toBe(1024);
  });

  it('is idempotent — second run skips the existing tarball without re-packing', async () => {
    await writeNpmShim({
      shimDir,
      expectedFilename: OFFICE_MCP_SEED_TARBALL_FILENAME,
      bytes: 1024,
    });

    const first = await runScript([], shimDir);
    expect(first.exitCode).toBe(0);

    // Replace the shim with one that fails — proves the second run never
    // calls `npm pack`. If the script were not idempotent, this would
    // surface a non-zero exit and a "shim: unsupported" error.
    await fs.rm(path.join(shimDir, process.platform === 'win32' ? 'npm.cmd' : 'npm'));
    await fs.mkdir(shimDir, { recursive: true });
    if (process.platform === 'win32') {
      await fs.writeFile(
        path.join(shimDir, 'npm.cmd'),
        '@echo off\r\necho shim should not be invoked >&2\r\nexit /b 1\r\n',
        'utf8',
      );
    } else {
      const failShim = path.join(shimDir, 'npm');
      await fs.writeFile(
        failShim,
        '#!/usr/bin/env bash\necho "shim should not be invoked" >&2\nexit 1\n',
        'utf8',
      );
      await fs.chmod(failShim, 0o755);
    }

    const second = await runScript([], shimDir);
    expect(second.exitCode).toBe(0);
    expect(second.stdout).toMatch(/already present.*skipping/i);
  });

  it('--force re-packs even when the tarball is already present', async () => {
    await writeNpmShim({
      shimDir,
      expectedFilename: OFFICE_MCP_SEED_TARBALL_FILENAME,
      bytes: 64,
    });
    const first = await runScript([], shimDir);
    expect(first.exitCode).toBe(0);

    // Write a different-sized shim so we can verify a re-pack happened.
    await writeNpmShim({
      shimDir,
      expectedFilename: OFFICE_MCP_SEED_TARBALL_FILENAME,
      bytes: 256,
    });
    const second = await runScript(['--force'], shimDir);
    expect(second.exitCode).toBe(0);

    const stat = await fs.stat(
      path.join(SEEDS_OUTPUT_DIR, OFFICE_MCP_SEED_TARBALL_FILENAME),
    );
    expect(stat.size).toBe(256);
  });

  it('prunes stale tarballs from prior versions', async () => {
    // Pre-seed the output dir with a stale tarball that wouldn't appear in
    // SEED_TARGETS — simulating a version bump that the script must clean up.
    await fs.mkdir(SEEDS_OUTPUT_DIR, { recursive: true });
    const stalePath = path.join(
      SEEDS_OUTPUT_DIR,
      'mindstone-engineering-mcp-server-office-0.0.1-stale.tgz',
    );
    await fs.writeFile(stalePath, 'stale-bytes');

    await writeNpmShim({
      shimDir,
      expectedFilename: OFFICE_MCP_SEED_TARBALL_FILENAME,
      bytes: 1024,
    });

    const result = await runScript([], shimDir);
    expect(result.exitCode).toBe(0);
    expect(existsSync(stalePath)).toBe(false);
    expect(
      existsSync(path.join(SEEDS_OUTPUT_DIR, OFFICE_MCP_SEED_TARBALL_FILENAME)),
    ).toBe(true);
  });

  it('fails loudly when npm produces a tarball with the wrong filename', async () => {
    // Filename mismatch is the exact bug the in-script assertion exists to
    // catch — it surfaces when someone bumps the catalog version but
    // forgets to update OFFICE_MCP_SEED_TARBALL_FILENAME.
    await writeNpmShim({
      shimDir,
      expectedFilename: 'mindstone-engineering-mcp-server-office-99.99.99.tgz',
      bytes: 64,
    });

    const result = await runScript([], shimDir);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/seed config expects/i);
  });
});
