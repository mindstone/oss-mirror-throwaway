/**
 * Shared Drive Health Service
 *
 * Detects whether cloud storage desktop apps (Google Drive, OneDrive, Dropbox)
 * are running and whether linked folders are available offline,
 * to warn users whose spaces depend on them.
 *
 * Two trigger points:
 * 1. After reconcileSharedDriveSpaces() completes at startup (with retry)
 * 2. After manual space creation via library:create-space (no retry)
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createScopedLogger } from '@core/logger';
import { toPortablePath } from '@core/utils/portablePath';
import { broadcastToAllWindows } from '../utils/broadcastHelpers';
import type { SpaceConfig, SpaceStorageProvider } from '@shared/types';

const log = createScopedLogger({ service: 'shared-drive-health' });

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DriveAppStatus = 'running' | 'not_running' | 'unknown';
export type OfflineStatus = 'available' | 'online-only' | 'unknown';

export interface SharedDriveHealthResult {
  provider: SpaceStorageProvider;
  appStatus: DriveAppStatus;
  offlineStatus: OfflineStatus;
  spacePaths: string[];
}

// ---------------------------------------------------------------------------
// Process name mapping per provider + platform
// ---------------------------------------------------------------------------

const PROCESS_NAMES: Record<string, { darwin: string; win32: string }> = {
  google_drive: { darwin: 'Google Drive', win32: 'GoogleDriveFS.exe' },
  // OneDrive on macOS keeps StandaloneUpdaterDaemon running permanently (not syncing).
  // Match only the main app or Sync Service — not the updater.
  onedrive: { darwin: 'OneDrive.app/Contents/MacOS/OneDrive|OneDrive Sync Service', win32: 'OneDrive.exe' },
  dropbox: { darwin: 'Dropbox', win32: 'Dropbox.exe' },
};

/** Cloud providers that warrant a health check (excludes local, box, icloud, other) */
const CLOUD_PROVIDERS_WITH_HEALTH_CHECK = new Set<SpaceStorageProvider>([
  'google_drive',
  'onedrive',
  'dropbox',
]);

const EXEC_TIMEOUT_MS = 5000;
const RETRY_DELAY_MS = 10000;

// ---------------------------------------------------------------------------
// Storage provider detection from path (fallback when storageProvider missing)
// ---------------------------------------------------------------------------

/**
 * Detect cloud storage provider from a source path.
 * Used as a fallback when spaces don't have storageProvider persisted
 * (e.g., manually-created symlink spaces).
 */
function detectProviderFromPath(sourcePath: string): SpaceStorageProvider | null {
  const normalized = toPortablePath(sourcePath);
  if (
    /\/Library\/CloudStorage\/GoogleDrive-[^/]+(\/|$)/.test(normalized) ||
    /\/Google Drive(\/|$)/i.test(normalized)
  ) {
    return 'google_drive';
  }
  if (/\/OneDrive[^/]*(\/|$)/i.test(normalized)) {
    return 'onedrive';
  }
  if (/\/Dropbox(\/|$)/i.test(normalized)) {
    return 'dropbox';
  }
  return null;
}

// ---------------------------------------------------------------------------
// Process detection
// ---------------------------------------------------------------------------

/**
 * Check whether a cloud storage desktop app is running.
 *
 * - macOS: `pgrep -f <pattern>` — exit 0 = running, exit 1 = not found
 * - Windows: `tasklist /FI "IMAGENAME eq <exe>" /FO CSV /NH` — parse CSV
 * - Linux / unsupported: returns 'unknown'
 *
 * On ANY error (ENOENT, EPERM, timeout) returns 'unknown' rather than
 * a false 'not_running' to avoid misleading warnings.
 */
export function checkDriveAppRunning(
  provider: SpaceStorageProvider,
): Promise<DriveAppStatus> {
  const platform = process.platform;

  if (platform !== 'darwin' && platform !== 'win32') {
    return Promise.resolve('unknown');
  }

  const names = PROCESS_NAMES[provider];
  if (!names) {
    return Promise.resolve('unknown');
  }

  if (platform === 'darwin') {
    return checkDriveAppDarwin(names.darwin);
  }
  return checkDriveAppWin32(names.win32);
}

function checkDriveAppDarwin(pattern: string): Promise<DriveAppStatus> {
  return new Promise((resolve) => {
    execFile('pgrep', ['-f', pattern], { timeout: EXEC_TIMEOUT_MS }, (error, _stdout) => {
      if (!error) {
        resolve('running');
        return;
      }

      if (error.killed || error.signal) {
        // Process was killed (timeout or signal)
        log.warn({ pattern }, 'pgrep timed out or was killed');
        resolve('unknown');
        return;
      }

      const exitCode = (error as { code?: string | number }).code;

      // pgrep: exit 1 means no match (not_running), exit 2+ is an error
      if (exitCode === 1) {
        resolve('not_running');
        return;
      }

      // ENOENT (pgrep binary missing), EPERM, or other spawn errors
      if (typeof exitCode === 'string') {
        log.warn({ pattern, code: exitCode }, 'pgrep spawn error');
        resolve('unknown');
        return;
      }

      // Any other numeric exit code
      log.warn({ pattern, exitCode }, 'pgrep returned unexpected exit code');
      resolve('unknown');
    });
  });
}

function checkDriveAppWin32(exeName: string): Promise<DriveAppStatus> {
  return new Promise((resolve) => {
    execFile(
      'tasklist',
      ['/FI', `IMAGENAME eq ${exeName}`, '/FO', 'CSV', '/NH'],
      { timeout: EXEC_TIMEOUT_MS },
      (error, stdout) => {
        if (error) {
          if (error.killed || error.signal) {
            log.warn({ exeName }, 'tasklist timed out or was killed');
            resolve('unknown');
            return;
          }
          const code = (error as NodeJS.ErrnoException).code;
          log.warn({ exeName, code }, 'tasklist error');
          resolve('unknown');
          return;
        }

        // tasklist CSV output: "ImageName","PID","SessionName","Session#","MemUsage"
        // When no match: 'INFO: No tasks are running which match the specified criteria.'
        const output = (stdout || '').trim();

        if (!output) {
          resolve('unknown');
          return;
        }

        // Case-insensitive check for the exe name in output (locale-safe)
        if (output.toLowerCase().includes(exeName.toLowerCase())) {
          resolve('running');
        } else {
          resolve('not_running');
        }
      },
    );
  });
}

// ---------------------------------------------------------------------------
// Offline availability detection
// ---------------------------------------------------------------------------

/** Providers where offline detection is meaningful (excludes Google Drive — virtual FS) */
const OFFLINE_CHECK_PROVIDERS = new Set<SpaceStorageProvider>(['onedrive', 'dropbox']);

/**
 * Check offline availability for a single source path on a given provider.
 *
 * - Google Drive: always returns 'unknown' (virtual FS, can't detect offline status)
 * - macOS (OneDrive/Dropbox): uses fs.stat blocks check (File Provider dataless placeholders)
 * - Windows (OneDrive/Dropbox): use checkOfflineAvailabilityWin32 for batched checking
 * - Linux / unsupported: returns 'unknown'
 */
export async function checkOfflineAvailability(
  sourcePath: string,
  provider: SpaceStorageProvider,
): Promise<OfflineStatus> {
  if (!OFFLINE_CHECK_PROVIDERS.has(provider)) {
    return 'unknown';
  }

  const platform = process.platform;

  if (platform === 'darwin') {
    return checkOfflineAvailabilityDarwin(sourcePath);
  }

  // Windows uses batched approach via checkOfflineAvailabilityWin32 — called from orchestration
  // Single-path callers on Windows still go through the batch function with one path
  if (platform === 'win32') {
    const results = await checkOfflineAvailabilityWin32([sourcePath]);
    return results.get(sourcePath) ?? 'unknown';
  }

  return 'unknown';
}

/**
 * macOS offline detection via fs.stat blocks check.
 *
 * Apple File Provider (used by OneDrive, Dropbox) represents online-only files
 * as "dataless placeholders": stat.size > 0 but stat.blocks === 0 because no
 * disk space is allocated. If any sampled file is dataless, the folder is not
 * fully available offline.
 */
async function checkOfflineAvailabilityDarwin(sourcePath: string): Promise<OfflineStatus> {
  try {
    const entries = await fs.readdir(sourcePath);
    // Filter to non-hidden files, sample first 5
    const candidates = entries.filter((e) => !e.startsWith('.'));

    if (candidates.length === 0) {
      return 'unknown';
    }

    let sampledFiles = 0;

    for (const candidate of candidates.slice(0, 5)) {
      const fullPath = path.join(sourcePath, candidate);
      const stat = await fs.stat(fullPath);

      if (!stat.isFile()) continue;

      sampledFiles++;

      // Dataless placeholder: has logical size but no allocated disk blocks
      if (stat.size > 0 && stat.blocks === 0) {
        log.debug(
          { file: candidate, size: stat.size },
          'Detected online-only placeholder (blocks=0)',
        );
        return 'online-only';
      }
    }

    // No files sampled (all entries were directories) → unknown
    if (sampledFiles === 0) {
      return 'unknown';
    }

    // All sampled files have blocks > 0 → available offline
    return 'available';
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    log.debug({ sourcePath, code }, 'Offline check failed, returning unknown');
    return 'unknown';
  }
}

/**
 * Windows offline detection via batched PowerShell invocation.
 *
 * Checks FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS (0x00400000) on sample files
 * inside each source path. This attribute is set on "online-only" cloud
 * placeholders by OneDrive and Dropbox (Windows Cloud Files API).
 *
 * Uses -LiteralPath for injection-safe path handling.
 * Returns a Map from sourcePath → OfflineStatus.
 */
async function checkOfflineAvailabilityWin32(
  sourcePaths: string[],
): Promise<Map<string, OfflineStatus>> {
  const resultMap = new Map<string, OfflineStatus>();

  if (sourcePaths.length === 0) {
    return resultMap;
  }

  // Escape single quotes in paths for PowerShell string literals
  const escapedPaths = sourcePaths.map((p) => p.replace(/'/g, "''"));
  const pathArray = escapedPaths.map((p) => `'${p}'`).join(',');

  const script = [
    `$paths = @(${pathArray})`,
    '$results = @{}',
    'foreach ($p in $paths) {',
    '  $files = Get-ChildItem -LiteralPath $p -File -ErrorAction SilentlyContinue | Select-Object -First 3',
    '  $online = $false',
    '  foreach ($f in $files) {',
    '    $a = [int](Get-Item -LiteralPath $f.FullName -Force).Attributes',
    '    if (($a -band 0x00400000) -ne 0) { $online = $true; break }',
    '  }',
    '  $results[$p] = $online',
    '}',
    'ConvertTo-Json $results -Compress',
  ].join('\n');

  return new Promise((resolve) => {
    execFile(
      'powershell',
      ['-NoProfile', '-Command', script],
      { timeout: EXEC_TIMEOUT_MS },
      (error, stdout) => {
        if (error) {
          log.warn(
            { error: error.message, killed: error.killed },
            'PowerShell offline check failed',
          );
          // Fail open: unknown for all paths
          for (const p of sourcePaths) {
            resultMap.set(p, 'unknown');
          }
          resolve(resultMap);
          return;
        }

        try {
          const parsed = JSON.parse((stdout || '').trim()) as Record<string, boolean>;
          for (const p of sourcePaths) {
            // PowerShell may have escaped paths differently — try both original and escaped
            const escaped = p.replace(/'/g, "''");
            const value = parsed[p] ?? parsed[escaped];
            if (value === true) {
              resultMap.set(p, 'online-only');
            } else if (value === false) {
              resultMap.set(p, 'available');
            } else {
              resultMap.set(p, 'unknown');
            }
          }
        } catch {
          log.warn('Failed to parse PowerShell offline check output');
          for (const p of sourcePaths) {
            resultMap.set(p, 'unknown');
          }
        }
        resolve(resultMap);
      },
    );
  });
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export interface HealthCheckOptions {
  /** If true, retry once after a 10s delay when a provider is not_running */
  retry?: boolean;
}

/**
 * Run shared drive health checks for the given spaces.
 *
 * 1. Filters to symlink spaces with a cloud storageProvider
 * 2. Deduplicates by provider (one check per provider)
 * 3. Checks if each provider's desktop app is running
 * 4. Optionally retries once after 10s for not_running providers
 * 5. Broadcasts warnings for actionable results
 */
export async function runSharedDriveHealthChecks(
  spaces: SpaceConfig[],
  options?: HealthCheckOptions,
): Promise<void> {
  // 1. Filter to relevant spaces, using path-based detection as fallback
  //    when storageProvider isn't persisted (e.g., manually-created symlinks)
  const relevantSpaces: Array<SpaceConfig & { resolvedProvider: SpaceStorageProvider }> = [];
  for (const s of spaces) {
    if (s.isSymlink !== true) continue;
    const provider =
      (s.storageProvider && CLOUD_PROVIDERS_WITH_HEALTH_CHECK.has(s.storageProvider))
        ? s.storageProvider
        : (s.sourcePath ? detectProviderFromPath(s.sourcePath) : null);
    if (provider && CLOUD_PROVIDERS_WITH_HEALTH_CHECK.has(provider)) {
      relevantSpaces.push({ ...s, resolvedProvider: provider });
    }
  }

  if (relevantSpaces.length === 0) {
    log.debug('No cloud-synced symlink spaces found, skipping health checks');
    return;
  }

  // 2. Deduplicate by provider, collecting space paths and source paths per provider
  const providerSpaces = new Map<
    SpaceStorageProvider,
    { spacePaths: string[]; sourcePaths: string[] }
  >();
  for (const space of relevantSpaces) {
    const provider = space.resolvedProvider;
    const entry = providerSpaces.get(provider) ?? { spacePaths: [], sourcePaths: [] };
    entry.spacePaths.push(space.path);
    if (space.sourcePath) {
      entry.sourcePaths.push(space.sourcePath);
    }
    providerSpaces.set(provider, entry);
  }

  log.info(
    { providers: [...providerSpaces.keys()], spaceCount: relevantSpaces.length },
    'Starting shared drive health checks',
  );

  // 3. Run process checks
  const results: SharedDriveHealthResult[] = [];

  for (const [provider, { spacePaths, sourcePaths }] of providerSpaces) {
    log.debug({ provider }, 'Checking drive app status');
    let appStatus = await checkDriveAppRunning(provider);
    log.debug({ provider, appStatus }, 'Initial drive app check result');

    // 4. Retry once if not_running and retry is enabled
    if (appStatus === 'not_running' && options?.retry === true) {
      log.info({ provider }, 'Drive app not running, retrying after delay');
      await delay(RETRY_DELAY_MS);
      appStatus = await checkDriveAppRunning(provider);
      log.debug({ provider, appStatus }, 'Retry drive app check result');
    }

    // 5. Offline availability check — only when drive app IS running
    let offlineStatus: OfflineStatus = 'unknown';

    if (appStatus === 'running' && sourcePaths.length > 0) {
      offlineStatus = await checkOfflineForProvider(provider, sourcePaths);
    }

    results.push({
      provider,
      appStatus,
      offlineStatus,
      spacePaths,
    });
  }

  // 6. Filter to only confirmed problems (fail open: 'unknown' is not actionable)
  //    - appStatus === 'not_running' → warn user
  //    - offlineStatus === 'online-only' → warn user
  //    - appStatus === 'unknown' or 'running' with no offline issue → skip
  const actionableResults = results.filter(
    (r) => r.appStatus === 'not_running' || r.offlineStatus === 'online-only',
  );

  if (actionableResults.length === 0) {
    log.info('All drive apps running, no warnings to broadcast');
    return;
  }

  log.info(
    { warnings: actionableResults.map((r) => ({ provider: r.provider, appStatus: r.appStatus })) },
    'Broadcasting shared drive health warnings',
  );

  broadcastToAllWindows('shared-drive:health-warning', actionableResults);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Run offline checks for all sourcePaths of a single provider.
 *
 * macOS: checks each sourcePath individually (fs.stat is fast).
 * Windows: batches all sourcePaths into a single PowerShell invocation.
 *
 * Returns 'online-only' if ANY source path is online-only,
 * 'available' if all are available, 'unknown' otherwise.
 */
async function checkOfflineForProvider(
  provider: SpaceStorageProvider,
  sourcePaths: string[],
): Promise<OfflineStatus> {
  if (!OFFLINE_CHECK_PROVIDERS.has(provider)) {
    return 'unknown';
  }

  const platform = process.platform;

  if (platform === 'darwin') {
    let hasAvailable = false;
    for (const sp of sourcePaths) {
      const status = await checkOfflineAvailabilityDarwin(sp);
      if (status === 'online-only') {
        log.info({ provider, sourcePath: sp }, 'Online-only folder detected');
        return 'online-only';
      }
      if (status === 'available') {
        hasAvailable = true;
      }
    }
    return hasAvailable ? 'available' : 'unknown';
  }

  if (platform === 'win32') {
    const results = await checkOfflineAvailabilityWin32(sourcePaths);
    let hasAvailable = false;
    for (const [sp, status] of results) {
      if (status === 'online-only') {
        log.info({ provider, sourcePath: sp }, 'Online-only folder detected');
        return 'online-only';
      }
      if (status === 'available') {
        hasAvailable = true;
      }
    }
    return hasAvailable ? 'available' : 'unknown';
  }

  return 'unknown';
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
