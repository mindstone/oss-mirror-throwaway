// src/main/startup/ensureTestUserData.ts
//
// ╔══════════════════════════════════════════════════════════════════════════╗
// ║  CRITICAL: This module MUST be imported before ANY electron-store usage  ║
// ║  or any module that calls app.getPath('userData').                       ║
// ║                                                                          ║
// ║  If import ordering is broken, settingsStore.ts will throw an error      ║
// ║  (defense-in-depth check) rather than silently using the wrong path.     ║
// ╚══════════════════════════════════════════════════════════════════════════╝

import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { getElectronModule } from '@core/lazyElectron';
/* eslint-disable no-console -- startup: runs before structured logger */

function readTestUserDataDirFromArgv(): string | undefined {
  const argv = process.argv;
  const prefix = '--rebel-test-user-data-dir=';

  const eqArg = argv.find((arg) => arg.startsWith(prefix));
  if (eqArg) return eqArg.slice(prefix.length);

  const flagIndex = argv.findIndex((arg) => arg === '--rebel-test-user-data-dir');
  if (flagIndex !== -1) {
    const value = argv[flagIndex + 1];
    if (value && !value.startsWith('--')) return value;
  }

  return undefined;
}

const testUserDataDir = process.env.REBEL_TEST_USER_DATA_DIR ?? readTestUserDataDirFromArgv();

export let isTestUserDataIsolated = false;
export let testUserDataPath: string | null = null;

if (testUserDataDir) {
  let resolvedPath: string;

  if (testUserDataDir === 'auto') {
    // Auto-generate a unique temp directory
    resolvedPath = fs.mkdtempSync(path.join(os.tmpdir(), 'rebel-test-'));
    console.log(`[TEST] Auto-created isolated userData: ${resolvedPath}`);
  } else {
    // Use specified path (resolve to absolute)
    resolvedPath = path.resolve(testUserDataDir);

    // Ensure directory exists
    if (!fs.existsSync(resolvedPath)) {
      fs.mkdirSync(resolvedPath, { recursive: true });
    }
    console.log(`[TEST] Using isolated userData: ${resolvedPath}`);
  }

  // ╔══════════════════════════════════════════════════════════════════════════╗
  // ║  CRITICAL SAFETY CHECK: Test userData MUST be under os.tmpdir()          ║
  // ║                                                                          ║
  // ║  This is a root-cause fix that prevents test data from EVER being        ║
  // ║  written to a real user directory, even if other checks fail.            ║
  // ╚══════════════════════════════════════════════════════════════════════════╝
  const realTmpDir = fs.realpathSync(os.tmpdir());
  const realResolvedPath = fs.realpathSync(resolvedPath);

  // Allow escape hatch for debugging: REBEL_TEST_ALLOW_NON_TEMP_USERDATA=1
  const allowNonTemp = process.env.REBEL_TEST_ALLOW_NON_TEMP_USERDATA === '1';

  // Use path.relative() for proper containment check (avoids prefix tricks like /tmp-not-really)
  const relativePath = path.relative(realTmpDir, realResolvedPath);
  const isUnderTempDir = !relativePath.startsWith('..') && !path.isAbsolute(relativePath);

  if (!isUnderTempDir && !allowNonTemp) {
    throw new Error(
      `CRITICAL: Test userData path must be under system temp directory!\n` +
        `Requested: ${resolvedPath}\n` +
        `Resolved: ${realResolvedPath}\n` +
        `Temp dir: ${realTmpDir}\n` +
        `This restriction prevents tests from accidentally writing to real user data.\n` +
        `Use REBEL_TEST_USER_DATA_DIR=auto to auto-generate a safe temp directory.\n` +
        `Or set REBEL_TEST_ALLOW_NON_TEMP_USERDATA=1 if you really know what you're doing.`
    );
  }

  // Desktop-only: app.setPath() is Electron's API for redirecting userData
  const electron = getElectronModule();
  if (electron) {
    electron.app.setPath('userData', resolvedPath);
  }
  isTestUserDataIsolated = true;
  testUserDataPath = resolvedPath;
}

/**
 * Call this from any module that initializes stores to verify isolation is working.
 * Throws if REBEL_TEST_USER_DATA_DIR is set but isolation failed (import ordering broken).
 */
export function assertTestIsolationIfRequired(): void {
  const envVar = process.env.REBEL_TEST_USER_DATA_DIR;
  if (!envVar) return; // Not in test mode, nothing to check

  const electron = getElectronModule();
  if (!electron) return; // Not in Electron context (cloud)
  const actualPath = electron.app.getPath('userData');
  const expectedPath = testUserDataPath;

  // Use realpathSync for robust comparison (handles symlinks, /var vs /private/var)
  let realActual: string, realExpected: string;
  try {
    realActual = fs.realpathSync(actualPath);
    realExpected = expectedPath ? fs.realpathSync(expectedPath) : '';
  } catch {
    realActual = actualPath;
    realExpected = expectedPath ?? '';
  }

  // Strict equality check (not startsWith - that can false-negative)
  if (!realExpected || realActual !== realExpected) {
    throw new Error(
      `CRITICAL: Test isolation failed!\n` +
        `REBEL_TEST_USER_DATA_DIR is set to "${envVar}"\n` +
        `Expected userData: "${expectedPath}" (real: "${realExpected}")\n` +
        `Actual userData: "${actualPath}" (real: "${realActual}")\n` +
        `This likely means ensureTestUserData.ts was imported AFTER a module that uses app.getPath('userData').\n` +
        `Check startup import ordering in src/main/bootstrap.ts - ensureTestUserData MUST come before settingsStore.`
    );
  }

  // Cross-check: REBEL_USER_DATA env var (used by getDataPath()) must also point
  // to the isolated directory. If it doesn't, ~30 services would write to the wrong path.
  const rebelUserData = process.env.REBEL_USER_DATA;
  if (rebelUserData) {
    let realRebelUserData: string;
    try {
      realRebelUserData = fs.realpathSync(rebelUserData);
    } catch {
      realRebelUserData = rebelUserData;
    }
    if (realRebelUserData !== realExpected) {
      throw new Error(
        `CRITICAL: REBEL_USER_DATA does not match isolated test path!\n` +
          `REBEL_USER_DATA: "${rebelUserData}" (real: "${realRebelUserData}")\n` +
          `Expected: "${expectedPath}" (real: "${realExpected}")\n` +
          `getDataPath() would return the wrong directory, bypassing test isolation.\n` +
          `Ensure REBEL_USER_DATA is set to the isolated path or unset when running tests.`
      );
    }
  }
}
