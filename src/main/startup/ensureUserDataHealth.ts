/**
 * Early Startup Health Check
 *
 * Runs during normal startup to detect corrupted application state.
 * This module is AV-SAFE: it only creates essential directories and
 * DETECTS issues without automatically fixing them.
 *
 * See docs/plans/finished/260120_Defensive_Windows_Install.md for design rationale.
 */

import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
/* eslint-disable no-console -- startup: runs before structured logger */

export interface UserDataHealthResult {
  healthy: boolean;
  issues: string[];
  settingsCorrupted: boolean;
  settingsPath: string;
}

/**
 * Perform early health check on userData directory.
 *
 * AV-SAFE design:
 * - Creates only `logs/` directory (essential for diagnostics, normal app behavior)
 * - Detects but does NOT delete/rename corrupted files
 * - electron-store throws SyntaxError on corrupted JSON (does NOT auto-recover)
 * - Other directories are created lazily on first use (existing pattern)
 *
 * @returns Health status, list of detected issues, and structured corruption info
 */
export function ensureUserDataHealth(): UserDataHealthResult {
  const userDataPath = app.getPath('userData');
  const issues: string[] = [];
  const settingsPath = path.join(userDataPath, 'app-settings.json');
  let settingsCorrupted = false;

  // 1. Create logs directory ONLY (essential for diagnostics, normal app behavior)
  try {
    fs.mkdirSync(path.join(userDataPath, 'logs'), { recursive: true });
  } catch (err) {
    issues.push(`Cannot create logs directory: ${(err as Error).message}`);
  }

  // 2. DETECT (but don't auto-fix) corrupted settings
  // electron-store throws SyntaxError on corrupted JSON - it does NOT auto-recover
  if (fs.existsSync(settingsPath)) {
    try {
      const content = fs.readFileSync(settingsPath, 'utf8');
      JSON.parse(content);
    } catch {
      // Log but do NOT auto-delete - app will need to show error dialog
      settingsCorrupted = true;
      issues.push('Settings file appears corrupted');
    }
  }

  // 3. DETECT missing critical directories (informational only)
  // These are created lazily on first use, so missing is not an error
  const criticalDirs = ['sessions', 'mcp'];
  for (const dir of criticalDirs) {
    if (!fs.existsSync(path.join(userDataPath, dir))) {
      issues.push(`Missing directory: ${dir} (will be created on first use)`);
    }
  }

  // 4. Log all issues for diagnostics
  if (issues.length > 0) {
    console.log('[HEALTH] Issues detected during startup:', issues);
  }

  return { healthy: issues.length === 0, issues, settingsCorrupted, settingsPath };
}
