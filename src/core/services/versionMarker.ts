/**
 * Version Marker
 *
 * Writes a version-marker.json to userData so that an older app version
 * can detect when a newer version has already written to the same directory.
 *
 * Uses DATA_SCHEMA_EPOCH (auto-derived sum of all store versions) as the
 * primary comparison. Falls back to indexVersion for markers written by
 * older app versions that don't have the epoch field.
 *
 * @see docs/plans/partway/260219_global_store_version_gate.md
 */

import * as fs from 'fs';
import * as path from 'path';
import { writeFileSync } from 'atomically';
import { createScopedLogger } from '@core/logger';
import { getDataPath, getAppVersion } from '@core/utils/dataPaths';
import { DATA_SCHEMA_EPOCH } from '@core/constants';

const log = createScopedLogger({ service: 'versionMarker' });
const VERSION_MARKER_FILENAME = 'version-marker.json';

interface VersionMarker {
  appVersion: string;
  /** @deprecated Use dataSchemaEpoch. Kept for backward compat with older markers. */
  indexVersion: number;
  /** Sum of all store version constants. Primary comparison field. */
  dataSchemaEpoch?: number;
  lastWrittenAt: number;
}

export interface VersionMarkerCheckResult {
  isOlderVersion: boolean;
  markerAppVersion?: string;
}

/**
 * Check the userData-level version marker against the current data schema epoch.
 *
 * Comparison logic:
 * - If marker has dataSchemaEpoch and it's > currentEpoch → older version
 * - If marker lacks dataSchemaEpoch, fall back to indexVersion comparison
 * - If marker is unreadable/missing → fresh install (not older)
 * - If marker is corrupted (exists but unparseable) → treat as fresh install
 *   (corrupted markers are edge cases from crashes; defaulting to read-only
 *   would lock out users who just have a corrupted file)
 */
export function checkVersionMarker(
  currentEpoch: number,
  currentIndexVersion: number,
): VersionMarkerCheckResult {
  const userDataPath = getDataPath();
  const markerPath = path.join(userDataPath, VERSION_MARKER_FILENAME);

  try {
    if (!fs.existsSync(markerPath)) {
      return { isOlderVersion: false };
    }

    const content = fs.readFileSync(markerPath, 'utf8');
    const marker = JSON.parse(content) as VersionMarker;

    // Primary check: epoch-based comparison (new markers)
    if (typeof marker.dataSchemaEpoch === 'number' && marker.dataSchemaEpoch > currentEpoch) {
      log.warn(
        {
          markerEpoch: marker.dataSchemaEpoch,
          currentEpoch,
          markerAppVersion: marker.appVersion,
        },
        'userData was last used by a newer app version (epoch check) — read-only mode'
      );
      return { isOlderVersion: true, markerAppVersion: marker.appVersion };
    }

    // Fallback: indexVersion comparison (old markers without epoch)
    if (marker.dataSchemaEpoch === undefined && marker.indexVersion > currentIndexVersion) {
      log.warn(
        {
          markerIndexVersion: marker.indexVersion,
          currentIndexVersion,
          markerAppVersion: marker.appVersion,
        },
        'userData was last used by a newer app version (legacy index check) — read-only mode'
      );
      return { isOlderVersion: true, markerAppVersion: marker.appVersion };
    }
  } catch (err) {
    log.warn({ err }, 'Failed to read version marker, treating as fresh install');
  }

  return { isOlderVersion: false };
}

/**
 * Update the version marker with current epoch and index version.
 * Only writes if current epoch >= stored epoch (monotonic).
 * Should NOT be called when in read-only mode.
 */
export function updateVersionMarker(
  currentEpoch: number,
  currentIndexVersion: number,
): void {
  const userDataPath = getDataPath();
  const markerPath = path.join(userDataPath, VERSION_MARKER_FILENAME);

  try {
    // Re-read to avoid race (monotonic check)
    let existingEpoch = 0;
    try {
      const content = fs.readFileSync(markerPath, 'utf8');
      const existing = JSON.parse(content) as VersionMarker;
      existingEpoch = existing.dataSchemaEpoch ?? existing.indexVersion ?? 0;
    } catch { /* doesn't exist yet */ }

    if (currentEpoch >= existingEpoch) {
      const marker: VersionMarker = {
        appVersion: getAppVersion(),
        indexVersion: currentIndexVersion,
        dataSchemaEpoch: currentEpoch,
        lastWrittenAt: Date.now(),
      };
      writeFileSync(markerPath, JSON.stringify(marker, null, 2), 'utf8');
    }
  } catch (err) {
    log.warn({ err }, 'Failed to write version marker');
  }
}

/**
 * @deprecated Use checkVersionMarker() + updateVersionMarker() separately.
 * Kept for backward compatibility during transition.
 */
export function checkAndUpdateVersionMarker(currentIndexVersion: number): { isOlderVersion: boolean } {
  const result = checkVersionMarker(DATA_SCHEMA_EPOCH, currentIndexVersion);
  if (!result.isOlderVersion) {
    updateVersionMarker(DATA_SCHEMA_EPOCH, currentIndexVersion);
  }
  return { isOlderVersion: result.isOlderVersion };
}
