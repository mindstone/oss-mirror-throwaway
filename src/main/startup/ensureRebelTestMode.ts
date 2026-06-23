// src/main/startup/ensureRebelTestMode.ts
//
// Composition module for --rebel-test mode. Detects the flag, creates an
// isolated temp profile directory, and sets environment variables that
// downstream startup modules already check (REBEL_E2E_TEST_MODE,
// REBEL_TEST_USER_DATA_DIR, REMOTE_DEBUGGING_PORT).
//
// MUST be imported before ALL other startup modules in bootstrap.ts.

import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
/* eslint-disable no-console -- startup: runs before structured logger */

function readCliArg(prefix: string): string | undefined {
  const eqArg = process.argv.find((arg) => arg.startsWith(`${prefix}=`));
  if (eqArg) return eqArg.slice(prefix.length + 1);

  const flagIndex = process.argv.findIndex((arg) => arg === prefix);
  if (flagIndex !== -1) {
    const value = process.argv[flagIndex + 1];
    if (value && !value.startsWith('--')) return value;
  }
  return undefined;
}

const isRebelTest =
  process.argv.includes('--rebel-test') ||
  process.env.REBEL_TEST_MODE === '1';

if (isRebelTest) {
  // 1. Mark as rebel-test mode
  process.env.REBEL_TEST_MODE = '1';

  // 2. Resolve profile directory (eagerly — downstream code reads env as abs path)
  const profileDir =
    readCliArg('--rebel-profile-dir') ??
    readCliArg('--rebel-test-user-data-dir') ??
    process.env.REBEL_TEST_USER_DATA_DIR;

  if (profileDir && profileDir !== 'auto') {
    const resolved = path.resolve(profileDir);
    if (!fs.existsSync(resolved)) {
      fs.mkdirSync(resolved, { recursive: true });
    }
    process.env.REBEL_TEST_USER_DATA_DIR = resolved;
  } else if (!profileDir || profileDir === 'auto') {
    // Create temp dir eagerly so env var is always an absolute path
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rebel-test-'));
    process.env.REBEL_TEST_USER_DATA_DIR = tmpDir;
  }

  // 3. Enable existing E2E isolation (lock skip, auth token plain storage, path redirection)
  if (!process.env.REBEL_E2E_TEST_MODE) {
    process.env.REBEL_E2E_TEST_MODE = '1';
  }

  // 4. CDP port from --cdp-port=<N>
  const cdpPort = readCliArg('--cdp-port');
  if (cdpPort) {
    const port = parseInt(cdpPort, 10);
    if (Number.isFinite(port) && port >= 1 && port <= 65535) {
      process.env.REMOTE_DEBUGGING_PORT = String(port);
    } else {
      console.error(`[rebel-test] Invalid --cdp-port value: ${cdpPort} (must be 1-65535)`);
      process.exit(1);
    }
  }

  // 5. Set CDP switches early — must happen before Chromium parses command line
  if (process.env.REMOTE_DEBUGGING_PORT) {
    try {
       
      const { app } = require('electron');
      app.commandLine.appendSwitch('remote-debugging-port', process.env.REMOTE_DEBUGGING_PORT);
      app.commandLine.appendSwitch('remote-debugging-address', '127.0.0.1');
    } catch {
      // Not in Electron context — clear port to prevent unauthenticated CDP on 0.0.0.0
      delete process.env.REMOTE_DEBUGGING_PORT;
      console.warn('[rebel-test] Could not bind CDP to localhost — CDP disabled for safety');
    }
  }

  // 6. Seed minimal settings so the app boots past onboarding
  const userDataDir = process.env.REBEL_TEST_USER_DATA_DIR;
  if (userDataDir) {
    const settingsPath = path.join(userDataDir, 'app-settings.json');
    if (!fs.existsSync(settingsPath)) {
      const seedSettings = {
        onboardingCompleted: true,
        onboardingFirstCompletedAt: Date.now(),
      };
      fs.writeFileSync(settingsPath, JSON.stringify(seedSettings, null, 2), 'utf8');
      console.log(`[rebel-test] Seeded settings at ${settingsPath}`);
    }
  }

  console.log(
    `[rebel-test] Mode activated — ` +
    `userData=${process.env.REBEL_TEST_USER_DATA_DIR}, ` +
    `cdpPort=${process.env.REMOTE_DEBUGGING_PORT ?? 'none'}`
  );
}
