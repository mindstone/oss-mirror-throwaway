/**
 * Architecture Mismatch Detection (macOS)
 *
 * Detects when the x64 (Intel) build is running on Apple Silicon via Rosetta 2.
 * Shows a fully blocking native dialog directing the user to download the
 * correct version, then exits.
 *
 * Suppressed in: dev mode (!app.isPackaged), headless CLI, E2E test mode,
 * demo mode.
 *
 * Must run after setPlatformConfig() (consistent with other startup checks).
 * Must run before import('./index') to prevent wasted initialization.
 *
 * @see docs/plans/finished/260312_architecture_mismatch_detection.md
 */

import { app } from 'electron';
import { getNativeArch } from '@core/utils/nativeArch';
import { isHeadlessCli } from '../utils/testIsolation';
import { showStartupErrorBox } from './startupDialog';

// Check demo mode via the flag file (same approach as ensureVersionCompatibility.ts)
function isDemoMode(): boolean {
  try {
    const fs = require('fs');
    const path = require('path');
    const flagPath = path.join(app.getPath('appData'), 'mindstone-rebel', '.demo-mode');
    return fs.existsSync(flagPath);
  } catch {
    return false;
  }
}

/**
 * Check if startup dialogs should be suppressed (headless/test/demo modes).
 * Uses the shared `isHeadlessCli()` SSOT (env+argv); keeps the raw E2E and demo
 * terms inline as before. The former `app.commandLine.hasSwitch('headless-cli')`
 * belt was retired — see src/main/utils/testIsolation.ts.
 */
function shouldSuppressCheck(): boolean {
  if (isHeadlessCli()) return true;
  if (process.env.REBEL_E2E_TEST_MODE === '1') return true;
  if (isDemoMode()) return true;
  return false;
}

export function ensureArchitectureMatch(): void {
  // Only relevant on macOS (Rosetta emulation scenario)
  if (process.platform !== 'darwin') return;

  // Skip in dev mode — developers may intentionally run either arch
  if (!app.isPackaged) return;

  // Skip in headless/test/demo modes — no UI to show or disposable environment
  if (shouldSuppressCheck()) return;

  // Explicit condition: x64 binary running on arm64 hardware (Rosetta 2)
  // Do NOT use isRunningUnderEmulation() — this explicit check avoids
  // false positives from any unexpected arch combination.
  if (!(process.arch === 'x64' && getNativeArch() === 'arm64')) return;

  // Show blocking dialog and exit
  showStartupErrorBox(
    'Wrong version for your Mac',
    'You\'re running the Intel version of Rebel on a Mac with Apple silicon. ' +
    'Please download the version built for your Mac at:' +
    '\n\nhttps://rebel.mindstone.com' +
    '\n\nRebel will now close.',
  );
  app.exit(1);
}
