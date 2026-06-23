/**
 * Version Check Service
 *
 * Checks if the app is outdated by comparing the current version against
 * the latest published version from GCS. Triggers the version-outdated
 * banner when the user is 2+ minor versions behind.
 *
 * Features:
 * - Fetches latest version from GCS (24-hour cache)
 * - Compares semantic versions (2+ minor OR major difference = outdated)
 * - Graceful network error handling (returns isOutdated: false)
 * - Only runs in packaged builds to avoid dev/test noise
 *
 * @see docs/plans/finished/260129_Version_Detection_Banner.md
 */

import { getPlatformConfig } from '@core/platform';
import { createStore } from '@core/storeFactory';
import type { KeyValueStore } from '@core/store';
import semver from 'semver';
import { createScopedLogger } from '@core/logger';
import { getBuildChannel } from '@main/utils/buildChannel';

const log = createScopedLogger({ service: 'version-check' });

// ============================================================================
// Types
// ============================================================================

interface LatestVersionInfo {
  version: string;
  releaseDate: string;
  downloadUrl: string;
}

export interface VersionCheckResult {
  isOutdated: boolean;
  currentVersion: string;
  latestVersion: string | null;
  downloadUrl: string | null;
}

type VersionCheckStoreState = {
  lastCheck: number;
  lastResult: VersionCheckResult | null;
}

// ============================================================================
// Constants
// ============================================================================

/** Cache version check results for 24 hours */
const VERSION_CHECK_CACHE_HOURS = 24;

/** Fetch timeout in milliseconds */
const FETCH_TIMEOUT_MS = 10000;

/** GCS base URL for release manifests */
const GCS_BASE_URL = 'https://storage.googleapis.com/mindstone-rebel';

/** Hardcoded download URL - users go here to get the latest version */
const _DOWNLOAD_URL = 'https://rebel.mindstone.com';

/** Get the GCS URL for latest version manifest based on build channel */
function getVersionCheckUrl(): string {
  const channel = getBuildChannel();
  const releasesPath = channel === 'beta' ? 'releases-beta' : 'releases';
  return `${GCS_BASE_URL}/${releasesPath}/latest.json`;
}

// ============================================================================
// Store
// ============================================================================

let _store: KeyValueStore<VersionCheckStoreState> | null = null;
const getStore = () => _store ??= createStore<VersionCheckStoreState>({
  name: 'version-check',
  defaults: {
    lastCheck: 0,
    lastResult: null,
  },
});

// ============================================================================
// Private Functions
// ============================================================================

/**
 * Fetch latest version info from GCS with timeout.
 * Uses AbortController pattern (same as behindTheScenesClient).
 */
async function fetchLatestVersion(): Promise<LatestVersionInfo | null> {
  const timeoutController = new AbortController();
  const timeoutId = setTimeout(() => timeoutController.abort(), FETCH_TIMEOUT_MS);
  const versionCheckUrl = getVersionCheckUrl();
  log.debug({ url: versionCheckUrl }, '[VERSION-CHECK] Fetching latest version');

  try {
    const response = await fetch(versionCheckUrl, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: timeoutController.signal,
    });

    if (!response.ok) {
      log.warn({
        url: versionCheckUrl,
        status: response.status,
        statusText: response.statusText,
      }, '[VERSION-CHECK] Failed to fetch latest version');
      return null;
    }

    const data = (await response.json()) as LatestVersionInfo;

    // Validate response structure
    if (!data.version || !semver.valid(data.version)) {
      log.warn({ data }, '[VERSION-CHECK] Invalid version in response');
      return null;
    }

    return data;
  } catch (error) {
    // AbortError means timeout, other errors are network issues
    const errorMessage = error instanceof Error ? error.message : String(error);
    const isTimeout = error instanceof Error && error.name === 'AbortError';

    log.warn({
      error: errorMessage,
      isTimeout,
    }, '[VERSION-CHECK] Error fetching latest version');
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Check if current version is outdated (2+ minor versions behind or major difference).
 *
 * Returns cached result if within 24-hour window. On network errors, returns
 * isOutdated: false to avoid blocking the user.
 *
 * Only performs check in packaged builds to avoid dev/test noise.
 */
export async function checkVersion(): Promise<VersionCheckResult> {
  const { version: currentVersion, isPackaged } = getPlatformConfig();

  // Skip check in development builds
  if (!isPackaged) {
    log.debug('[VERSION-CHECK] Skipping check in development build');
    return {
      isOutdated: false,
      currentVersion,
      latestVersion: null,
      downloadUrl: null,
    };
  }

  // Check cache first
  const now = Date.now();
  const lastCheck = getStore().get('lastCheck') ?? 0;
  const cacheAge = now - lastCheck;
  const cacheValid = cacheAge < VERSION_CHECK_CACHE_HOURS * 60 * 60 * 1000;

  if (cacheValid) {
    const cachedResult = getStore().get('lastResult');
    // Only use cache if the current version matches - app updates should trigger fresh check
    if (cachedResult && cachedResult.currentVersion === currentVersion) {
      log.debug({
        cacheAgeMinutes: Math.round(cacheAge / 1000 / 60),
        result: cachedResult,
      }, '[VERSION-CHECK] Using cached result');
      return cachedResult;
    }
    // Version changed since cache was created - need fresh check
    if (cachedResult && cachedResult.currentVersion !== currentVersion) {
      log.info({
        cachedVersion: cachedResult.currentVersion,
        currentVersion,
      }, '[VERSION-CHECK] Cache invalidated - app version changed');
    }
  }

  // Fetch latest version
  const latestInfo = await fetchLatestVersion();

  if (!latestInfo) {
    // Network error or invalid response - fail gracefully
    const fallbackResult: VersionCheckResult = {
      isOutdated: false,
      currentVersion,
      latestVersion: null,
      downloadUrl: null,
    };
    return fallbackResult;
  }

  // Parse versions using semver
  const current = semver.parse(currentVersion);
  const latest = semver.parse(latestInfo.version);

  if (!current || !latest) {
    log.warn({
      currentVersion,
      latestVersion: latestInfo.version,
    }, '[VERSION-CHECK] Failed to parse versions');
    return {
      isOutdated: false,
      currentVersion,
      latestVersion: latestInfo.version,
      downloadUrl: latestInfo.downloadUrl,
    };
  }

  // Check if outdated: major version difference OR 2+ minor versions behind
  // Only consider outdated if latest is GREATER than current
  const majorDiff = latest.major - current.major;
  const minorDiff = latest.minor - current.minor;

  // isOutdated if:
  // 1. Major version is higher (e.g., current 0.x vs latest 1.x)
  // 2. Same major but 2+ minor versions behind (e.g., current 0.2.x vs latest 0.4.x)
  const isOutdated = majorDiff > 0 || (majorDiff === 0 && minorDiff >= 2);

  const result: VersionCheckResult = {
    isOutdated,
    currentVersion,
    latestVersion: latestInfo.version,
    downloadUrl: latestInfo.downloadUrl,
  };

  // Cache result
  getStore().set('lastCheck', now);
  getStore().set('lastResult', result);

  log.info({
    current: currentVersion,
    latest: latestInfo.version,
    isOutdated,
    majorDiff,
    minorDiff,
  }, '[VERSION-CHECK] Version check complete');

  return result;
}

/**
 * Clear version check cache.
 * Useful for testing or forcing a fresh check.
 */
export function clearVersionCheckCache(): void {
  getStore().set('lastCheck', 0);
  getStore().set('lastResult', null);
  log.info('[VERSION-CHECK] Cache cleared');
}
