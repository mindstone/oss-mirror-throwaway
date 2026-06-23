/**
 * Shared Drive Service
 *
 * Resolves shared drive folders on disk and reconciles them as spaces.
 * Resolver functions extracted from libraryHandlers.ts for reuse.
 *
 * Two trigger points:
 * 1. After fetchAuthConfig() completes (if coreDirectory exists)
 * 2. After onboarding persists coreDirectory for the first time
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createScopedLogger } from '@core/logger';
import { isFeatureEnabled } from '@core/featureGating';
import { scanSpacesWithSideEffects, createSpace, invalidateSpaceScanCache } from './spaceService';
import type { SpaceConfig, SpaceStorageProvider } from '@shared/types';
import { getSettings } from '@core/services/settingsStore';
import { broadcastToAllWindows } from '../utils/broadcastHelpers';
import { runSharedDriveHealthChecks } from './sharedDriveHealthService';
import { libraryBroadcaster } from './libraryBroadcaster';
import { fireAndForget } from '@shared/utils/fireAndForget';

const log = createScopedLogger({ service: 'shared-drive-service' });

export type SharedDriveProvider = 'google-drive' | 'onedrive' | 'dropbox';

export interface SharedFolderInfo {
  id: string;
  name: string;
  description: string | null;
  sharing: string | null; // "private" | "restricted" | "company-wide" | "public"
}

export interface SharedDriveConfig {
  provider: SharedDriveProvider;
  folders: SharedFolderInfo[];
}

export interface ResolvedFolder {
  name: string;
  sourcePath: string;
  exists: boolean;
}

let isReconciling = false;
let pendingReconciliation: SharedDriveConfig | null = null;

// ---------------------------------------------------------------------------
// Resolver helpers (extracted from libraryHandlers.ts)
// ---------------------------------------------------------------------------

/**
 * Case-insensitive directory lookup.
 * Scans parentDir entries to find one matching targetName (ignoring case),
 * then verifies it is a directory.
 */
export async function findFolderCaseInsensitive(
  parentDir: string,
  targetName: string,
): Promise<string | null> {
  try {
    const entries = await fs.readdir(parentDir);
    const match = entries.find(
      (e) => e.toLowerCase() === targetName.toLowerCase(),
    );
    if (match) {
      const fullPath = path.join(parentDir, match);
      const stat = await fs.stat(fullPath);
      if (stat.isDirectory()) return fullPath;
    }
  } catch {
    // Parent doesn't exist or not readable
  }
  return null;
}

/**
 * Resolve a single folder name against Google Drive roots.
 * Scans all GoogleDrive-* entries in CloudStorage (macOS) or drive letters (Windows).
 */
export async function resolveGoogleDrive(
  folderName: string,
): Promise<string | null> {
  const homeDir = os.homedir();
  const platform = process.platform;

  if (platform === 'darwin') {
    const cloudStoragePath = path.join(homeDir, 'Library', 'CloudStorage');
    try {
      const entries = await fs.readdir(cloudStoragePath);
      for (const entry of entries) {
        if (!entry.startsWith('GoogleDrive')) continue;
        const gdRoot = path.join(cloudStoragePath, entry);
        // Check both "Shared Drives" and "SharedDrives" variants
        for (const sharedDrivesName of ['Shared Drives', 'SharedDrives']) {
          const sharedDrivesDir = path.join(gdRoot, sharedDrivesName);
          const found = await findFolderCaseInsensitive(
            sharedDrivesDir,
            folderName,
          );
          if (found) return found;
        }
      }
    } catch {
      // CloudStorage doesn't exist or not readable
    }
  } else if (platform === 'win32') {
    // Check DriveFS account-specific paths first (most reliable, avoids drive scan)
    const localAppData =
      process.env.LOCALAPPDATA || path.join(homeDir, 'AppData', 'Local');
    const driveFsPath = path.join(localAppData, 'Google', 'DriveFS');
    try {
      const driveFsEntries = await fs.readdir(driveFsPath);
      for (const accountEntry of driveFsEntries) {
        if (accountEntry.startsWith('.')) continue;
        const accountDir = path.join(driveFsPath, accountEntry);
        for (const sharedDrivesName of [
          'Shared drives',
          'SharedDrives',
          'Shared Drives',
        ]) {
          const sharedDrivesDir = path.join(accountDir, sharedDrivesName);
          const found = await findFolderCaseInsensitive(
            sharedDrivesDir,
            folderName,
          );
          if (found) return found;
        }
      }
    } catch {
      // DriveFS doesn't exist or not readable
    }

    // Fall back to scanning only mounted drive letters (avoids slow probes of unmounted drives)
    try {
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const execFileAsync = promisify(execFile);
      const { stdout } = await execFileAsync('wmic', ['logicaldisk', 'get', 'name'], { timeout: 5000 });
      const driveLetters = stdout.match(/[A-Z]:/g) ?? [];
      for (const drive of driveLetters) {
        const sharedDrivesDir = path.join(`${drive}\\`, 'Shared drives');
        const found = await findFolderCaseInsensitive(sharedDrivesDir, folderName);
        if (found) return found;
      }
    } catch {
      // wmic not available or timed out — skip drive letter scan
    }
  }
  return null;
}

/**
 * Resolve a single folder name against OneDrive roots.
 * Scans OneDrive-* entries in CloudStorage (macOS) or env vars (Windows).
 */
export async function resolveOneDrive(
  folderName: string,
): Promise<string | null> {
  const homeDir = os.homedir();
  const platform = process.platform;

  if (platform === 'darwin') {
    const cloudStoragePath = path.join(homeDir, 'Library', 'CloudStorage');
    try {
      const entries = await fs.readdir(cloudStoragePath);
      for (const entry of entries) {
        if (!entry.startsWith('OneDrive-')) continue;
        const oneDriveRoot = path.join(cloudStoragePath, entry);
        const found = await findFolderCaseInsensitive(oneDriveRoot, folderName);
        if (found) return found;
      }
    } catch {
      // CloudStorage doesn't exist or not readable
    }
  } else if (platform === 'win32') {
    // Check env vars for OneDrive roots
    const envVarNames = ['OneDriveCommercial', 'OneDrive'];
    for (const envVar of envVarNames) {
      const envPath = process.env[envVar];
      if (envPath && envPath.trim()) {
        const found = await findFolderCaseInsensitive(envPath, folderName);
        if (found) return found;
      }
    }
  }
  return null;
}

/**
 * Resolve a single folder name against Dropbox roots.
 * Checks legacy ~/Dropbox and newer File Provider API paths (macOS),
 * or %USERPROFILE%\Dropbox and info.json (Windows).
 */
export async function resolveDropbox(
  folderName: string,
): Promise<string | null> {
  const homeDir = os.homedir();
  const platform = process.platform;

  if (platform === 'darwin') {
    // Legacy path: ~/Dropbox
    const legacyDropbox = path.join(homeDir, 'Dropbox');
    const foundLegacy = await findFolderCaseInsensitive(
      legacyDropbox,
      folderName,
    );
    if (foundLegacy) return foundLegacy;

    // File Provider API path: ~/Library/CloudStorage/Dropbox
    const cloudStoragePath = path.join(homeDir, 'Library', 'CloudStorage');
    try {
      const entries = await fs.readdir(cloudStoragePath);
      for (const entry of entries) {
        if (entry.toLowerCase().startsWith('dropbox')) {
          const dropboxRoot = path.join(cloudStoragePath, entry);
          const found = await findFolderCaseInsensitive(dropboxRoot, folderName);
          if (found) return found;
        }
      }
    } catch {
      // CloudStorage doesn't exist or not readable
    }
  } else if (platform === 'win32') {
    // Standard path: %USERPROFILE%\Dropbox
    const standardDropbox = path.join(homeDir, 'Dropbox');
    const foundStandard = await findFolderCaseInsensitive(
      standardDropbox,
      folderName,
    );
    if (foundStandard) return foundStandard;

    // Check info.json for custom Dropbox location
    const appData =
      process.env.APPDATA || path.join(homeDir, 'AppData', 'Roaming');
    const infoJsonPath = path.join(appData, 'Dropbox', 'info.json');
    try {
      const infoContent = await fs.readFile(infoJsonPath, 'utf-8');
      const info = JSON.parse(infoContent);
      // info.json has "personal" and/or "business" keys, each with a "path" field
      for (const accountType of ['business', 'personal']) {
        const accountPath = info?.[accountType]?.path;
        if (typeof accountPath === 'string' && accountPath.trim()) {
          const found = await findFolderCaseInsensitive(
            accountPath,
            folderName,
          );
          if (found) return found;
        }
      }
    } catch {
      // info.json doesn't exist or can't be parsed
    }
  }
  return null;
}

/**
 * Resolve shared folder names to absolute paths on disk.
 * Selects the correct resolver based on cloud storage provider.
 */
export async function resolveSharedFolders(
  provider: string,
  folderNames: string[],
): Promise<ResolvedFolder[]> {
  const resolvers: Record<string, (folderName: string) => Promise<string | null>> = {
    'google-drive': resolveGoogleDrive,
    'onedrive': resolveOneDrive,
    'dropbox': resolveDropbox,
  };

  const resolve = resolvers[provider];
  if (!resolve) {
    log.warn({ provider }, 'Unknown shared drive provider');
    return folderNames.map((name) => ({ name, sourcePath: '', exists: false }));
  }

  const folders = await Promise.all(
    folderNames.map(async (name) => {
      const resolvedPath = await resolve(name);
      return {
        name,
        sourcePath: resolvedPath ?? '',
        exists: resolvedPath !== null,
      };
    }),
  );

  return folders;
}

// ---------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------

/**
 * Sanitize a server-provided folder name to prevent path traversal
 * and filesystem issues.
 */
function sanitizeFolderName(name: string): string {
  const sanitized = name
    .replace(/[/\\]/g, '')              // Remove path separators
    .replace(/\.\./g, '')              // Remove traversal attempts
    .replace(/[\x00-\x1f\x7f]/g, '')  // Remove control characters
    .replace(/[\u202e\u200e\u200f]/g, '') // Remove bidirectional overrides
    .replace(/[<>:"|?*]/g, '')         // Remove Windows-invalid characters
    .trim()
    .slice(0, 100);                    // Limit length

  // Reject names that resolve to current/parent directory
  if (sanitized === '.' || sanitized === '..') return '';

  // Reject Windows reserved device names (CON, PRN, AUX, NUL, COM1-9, LPT1-9)
  if (/^(CON|PRN|AUX|NUL|COM\d|LPT\d)$/i.test(sanitized)) return '';

  return sanitized;
}

/** Map provider identifier to SpaceStorageProvider enum */
const STORAGE_PROVIDER_MAP: Record<SharedDriveProvider, SpaceStorageProvider> = {
  'google-drive': 'google_drive',
  'onedrive': 'onedrive',
  'dropbox': 'dropbox',
};

const VALID_PROVIDERS = new Set<SharedDriveProvider>([
  'google-drive',
  'onedrive',
  'dropbox',
]);

/**
 * Reconcile shared drive spaces from auth config.
 * Creates symlink-based spaces for shared drive folders found on disk.
 * Deduplicates against existing spaces by sourcePath (case-insensitive).
 * Fire-and-forget — does not block caller.
 *
 * Accepts config as parameter to avoid circular import with authService.
 */
/**
 * Check if two paths overlap (one is a parent/child of the other).
 * Prevents creating symlink loops when workspace is inside a cloud storage folder.
 */
function pathsOverlap(pathA: string, pathB: string): boolean {
  const a = path.resolve(pathA).toLowerCase() + path.sep;
  const b = path.resolve(pathB).toLowerCase() + path.sep;
  return a.startsWith(b) || b.startsWith(a);
}

/** Normalize a sourcePath for dedup: resolve, lowercase, strip trailing separators */
function normalizeSourcePath(sourcePath: string): string {
  return path.resolve(sourcePath).toLowerCase().replace(/[\\/]+$/, '');
}

export async function reconcileSharedDriveSpaces(
  config: SharedDriveConfig,
): Promise<void> {
  if (!isFeatureEnabled('spaces:create-additional')) {
    log.info('Skipping shared drive reconciliation: Teams license required');
    return;
  }

  if (isReconciling) {
    pendingReconciliation = config;
    log.debug('Reconciliation already in progress, queued for retry');
    return;
  }
  isReconciling = true;

  try {
    const settings = getSettings();
    if (!settings.coreDirectory) {
      log.debug('No coreDirectory set, skipping shared drive reconciliation');
      return;
    }

    // Validate provider
    if (!VALID_PROVIDERS.has(config.provider)) {
      log.debug({ provider: config.provider }, 'Unknown shared drive provider');
      return;
    }

    if (!config.folders.length) {
      log.debug('No shared folders in config');
      return;
    }

    log.info(
      { provider: config.provider, folderCount: config.folders.length },
      'Starting shared drive reconciliation',
    );

    // Build a lookup from folder name → metadata for enriching resolved results
    const folderMetadata = new Map(
      config.folders.map((f) => [f.name.toLowerCase(), f]),
    );

    // Resolve folder paths on disk (uses folder names only)
    const folderNames = config.folders.map((f) => f.name);
    const resolved = await resolveSharedFolders(config.provider, folderNames);

    log.info(
      {
        requested: folderNames,
        resolved: resolved.map((f) => ({ name: f.name, exists: f.exists })),
      },
      'Shared folder resolution results',
    );

    const existingFolders = resolved.filter((f) => f.exists);

    if (existingFolders.length === 0) {
      log.info('No matching shared folders found on disk');
      return;
    }

    // Get existing spaces for dedup (normalized paths)
    const scanResult = await scanSpacesWithSideEffects(settings.coreDirectory);
    const existingSourcePaths = new Set(
      scanResult
        .filter((s): s is typeof s & { sourcePath: string } => !!s.sourcePath)
        .map((s) => normalizeSourcePath(s.sourcePath)),
    );

    log.debug(
      { existingSourcePaths: [...existingSourcePaths], spaceCount: scanResult.length },
      'Existing spaces for dedup',
    );

    // Build set of user-dismissed sourcePaths to avoid re-creating
    const dismissedPaths = new Set(
      (settings.dismissedSharedDriveSpaces ?? []).map((p) => p.toLowerCase()),
    );

    const storageProvider = STORAGE_PROVIDER_MAP[config.provider];
    const validSharingLevels = new Set(['private', 'restricted', 'company-wide', 'public']);
    const createdSpaces: string[] = [];
    const createdSpaceEntries: { name: string; sourcePath: string }[] = [];

    for (const folder of existingFolders) {
      // Sanitize folder name from server
      const safeName = sanitizeFolderName(folder.name);
      if (!safeName) {
        log.warn(
          { originalName: folder.name },
          'Folder name empty after sanitization, skipping',
        );
        continue;
      }

      const normalizedPath = normalizeSourcePath(folder.sourcePath);

      // Dedup by sourcePath (normalized)
      if (existingSourcePaths.has(normalizedPath)) {
        log.info(
          { folder: safeName },
          'Skipping shared folder — space with same sourcePath already exists',
        );
        continue;
      }

      // Skip spaces the user has previously removed
      if (dismissedPaths.has(normalizedPath)) {
        log.debug({ folder: safeName }, 'Skipping shared folder — user previously dismissed');
        continue;
      }

      // Prevent symlink loops when workspace is inside a cloud storage folder
      if (pathsOverlap(folder.sourcePath, settings.coreDirectory)) {
        log.warn(
          { folder: safeName },
          'Skipping shared folder — path overlaps with workspace (would create symlink loop)',
        );
        continue;
      }

      // Look up rich metadata from backend config
      const metadata = folderMetadata.get(folder.name.toLowerCase());

      // Map backend sharing to SpaceSharingLevel (validate before passing)
      const sharing = metadata?.sharing && validSharingLevels.has(metadata.sharing)
        ? (metadata.sharing as import('@shared/types').SpaceSharingLevel)
        : 'restricted';

      try {
        // Use companyName for path; fall back to 'Shared' if not set
        const companyName = settings.companyName || 'Shared';

        const space = await createSpace(settings.coreDirectory, {
          name: safeName,
          type: 'team',
          location: 'symlink',
          sourcePath: folder.sourcePath,
          companyName,
          sharing,
          storageProvider,
          description: metadata?.description || undefined,
        });
        invalidateSpaceScanCache(settings.coreDirectory, 'createSpace:sharedDriveService');

        createdSpaces.push(safeName);
        createdSpaceEntries.push({ name: safeName, sourcePath: folder.sourcePath });
        // Update dedup set for subsequent iterations
        existingSourcePaths.add(normalizedPath);
        log.debug({ space: space.path }, 'Created shared drive space');
      } catch (error) {
        log.warn(
          { err: error, folder: safeName },
          'Failed to create shared drive space',
        );
      }
    }

    if (createdSpaces.length > 0) {
      log.info(
        { count: createdSpaces.length, spaces: createdSpaces },
        'Shared drive spaces created',
      );

      // Notify renderer to refresh space list
      libraryBroadcaster.broadcast({
        affectsTree: true,
        writerKind: 'cloud-sync',
      }, 'watcher');

      // Send per-space toast notifications
      for (const name of createdSpaces) {
        broadcastToAllWindows('library:shared-space-created', {
          spaceName: name,
        });
      }
    }

    // Fire-and-forget health checks for cloud-synced spaces.
    // Combine settings.spaces with any newly created spaces to ensure
    // the current provider is checked even before settings are refreshed.
    const healthCheckSpaces: SpaceConfig[] = [
      ...(settings.spaces ?? []),
      ...createdSpaceEntries.map((entry) => ({
        name: entry.name,
        path: entry.name,
        type: 'team' as const,
        isSymlink: true,
        sourcePath: entry.sourcePath,
        storageProvider,
        createdAt: Date.now(),
      })),
    ];
    fireAndForget(runSharedDriveHealthChecks(healthCheckSpaces, { retry: true }), 'sharedDriveService.line550');
  } catch (error) {
    log.error({ err: error }, 'Shared drive reconciliation failed');
  } finally {
    isReconciling = false;
    // If another trigger queued while we were running, process it now
    const pending = pendingReconciliation;
    pendingReconciliation = null;
    if (pending) {
      log.debug('Processing queued reconciliation');
      fireAndForget(reconcileSharedDriveSpaces(pending), 'sharedDriveService.line560');
    }
  }
}
