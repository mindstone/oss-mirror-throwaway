/**
 * Demo Mode User Data Redirection
 *
 * This is a side-effect module that must be imported AFTER ensureAppIdentity
 * and BEFORE ensureTestUserData in bootstrap.ts.
 *
 * Import order in bootstrap.ts:
 *   1. ensureAppIdentity     - Sets userData to shared path
 *   2. ensureDemoModeUserData - THIS FILE - overrides if demo flag exists
 *   3. ensureTestUserData    - Test isolation takes final precedence
 *
 * The demo mode flag is stored OUTSIDE userData (in os.tmpdir()) to avoid
 * the chicken-and-egg problem of needing to read settings to know where
 * settings are stored.
 */

import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { getElectronModule } from '@core/lazyElectron';
/* eslint-disable no-console -- startup: runs before structured logger */

const DEMO_MODE_FLAG_FILENAME = 'mindstone-rebel-demo-mode.json';

export interface DemoModeFlag {
  tempDir: string;
  createdAt: number;
  /** If true, copy API keys from normal settings to demo settings after restart */
  copyApiKeys?: boolean;
  /** Path to the original app-settings.json to copy keys from */
  sourceSettingsPath?: string;
}

/**
 * Get the path to the demo mode flag file.
 * Located in os.tmpdir() so it's accessible before userData is determined.
 */
export function getDemoModeFlagPath(): string {
  return path.join(os.tmpdir(), DEMO_MODE_FLAG_FILENAME);
}

/**
 * Read the demo mode flag if it exists.
 */
export function readDemoModeFlag(): DemoModeFlag | null {
  const flagPath = getDemoModeFlagPath();
  if (!fs.existsSync(flagPath)) {
    return null;
  }
  try {
    const content = fs.readFileSync(flagPath, 'utf8');
    return JSON.parse(content) as DemoModeFlag;
  } catch {
    // Corrupted flag file - remove it
    try {
      fs.unlinkSync(flagPath);
    } catch {
      // Ignore cleanup errors
    }
    return null;
  }
}

/**
 * Write the demo mode flag file.
 */
export function writeDemoModeFlag(tempDir: string): void {
  const flagPath = getDemoModeFlagPath();
  const flag: DemoModeFlag = {
    tempDir,
    createdAt: Date.now()
  };
  fs.writeFileSync(flagPath, JSON.stringify(flag, null, 2), 'utf8');
}

/**
 * Delete the demo mode flag file.
 * Handles race conditions gracefully if file disappears between check and delete.
 */
export function clearDemoModeFlag(): void {
  const flagPath = getDemoModeFlagPath();
  try {
    fs.unlinkSync(flagPath);
  } catch (err) {
    // Ignore ENOENT (file doesn't exist) - this is fine
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw err;
    }
  }
}

// ============================================================================
// Side-effect: Check flag and redirect userData if in demo mode
// ============================================================================

const flag = readDemoModeFlag();

if (flag && flag.tempDir) {
  // Verify the temp directory exists (could have been cleaned up)
  if (fs.existsSync(flag.tempDir)) {
    // Desktop-only: app.setPath() is Electron's API for redirecting userData
    const electron = getElectronModule();
    if (electron) {
      electron.app.setPath('userData', flag.tempDir);
    }
    // Use console.log since logger isn't available yet
    console.log('[Demo Mode] userData redirected to:', flag.tempDir);
  } else {
    // Temp dir is gone - clean up the stale flag
    console.log('[Demo Mode] Temp directory no longer exists, clearing flag');
    clearDemoModeFlag();
  }
}
