/**
 * Early Version Compatibility Check
 *
 * Runs in bootstrap.ts BEFORE import('./index') to detect when the current
 * app version is older than the one that last wrote to userData.
 *
 * If older, sets the global read-only flag so all store writes are blocked.
 * If current or newer, updates the version marker with the current epoch.
 *
 * Must run after setPlatformConfig() (needs userDataPath).
 * Must run before any electron-store or storeFactory usage.
 *
 * Bypassed in test isolation mode and demo mode (these use disposable userData).
 *
 * @see docs/plans/partway/260219_global_store_version_gate.md
 */

import { setUserDataReadOnly } from '@core/userDataWriteGate';
import { DATA_SCHEMA_EPOCH, ALL_STORE_VERSIONS } from '@core/constants';
import { checkVersionMarker, updateVersionMarker } from '../services/versionMarker';
import { isTestUserDataIsolated } from './ensureTestUserData';

// Check demo mode via the flag file (same approach as ensureDemoModeUserData.ts)
function isDemoMode(): boolean {
  try {
    const fs = require('fs');
    const path = require('path');
    const { app } = require('electron');
    const flagPath = path.join(app.getPath('appData'), 'mindstone-rebel', '.demo-mode');
    return fs.existsSync(flagPath);
  } catch {
    return false;
  }
}

export function ensureVersionCompatibility(): void {
  // Skip in test isolation and demo mode — these use disposable userData
  if (isTestUserDataIsolated || isDemoMode()) {
    return;
  }

  const sessionIndexVersion = ALL_STORE_VERSIONS.INDEX_VERSION;
  const result = checkVersionMarker(DATA_SCHEMA_EPOCH, sessionIndexVersion);

  if (result.isOlderVersion) {
    setUserDataReadOnly(
      'userData was last written by a newer app version',
      result.markerAppVersion,
    );
    console.warn(
      `[bootstrap] Version gate: read-only mode activated. ` +
      `Current epoch: ${DATA_SCHEMA_EPOCH}, newer version: ${result.markerAppVersion ?? 'unknown'}`
    );
  } else {
    // Current or newer — update the marker
    updateVersionMarker(DATA_SCHEMA_EPOCH, sessionIndexVersion);
  }
}
