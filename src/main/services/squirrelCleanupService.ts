/**
 * Squirrel Cleanup Service
 *
 * Automatically cleans up old Squirrel installations after users migrate to NSIS.
 * Runs silently in the background - no user interaction required.
 *
 * SUNSET: This entire file should be removed once NSIS migration is complete.
 * Target removal date: 2026-10-01 (or when <5% of users remain on Squirrel)
 *
 * @see docs/plans/finished/260130_squirrel-cleanup-after-nsis-migration.md
 * @see docs/project/WINDOWS_ANTIVIRUS_AND_TRUST.md (AV resilience patterns)
 */

import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { logger } from '@core/logger';
import { getPlatformConfig } from '@core/platform';
import { getErrorReporter } from '@core/errorReporter';
import { trackMainEvent, getOrGenerateAnonymousId } from '../analytics';
import { getBuildChannel } from '../utils/buildChannel';

const execAsync = promisify(exec);

// Configuration
const CLEANUP_CONFIG = {
  maxRetries: 3,
  baseDelayMs: 1000, // Exponential backoff: 1s, 2s, 4s
  totalTimeoutMs: 60000, // Abandon after 60s
  startupDelayMs: 60000, // 60s delay after window creation
} as const;

// Squirrel directory and registry names per channel
const SQUIRREL_CONFIG = {
  beta: {
    dirName: 'MindstoneRebelBeta',
    regKey: 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\MindstoneRebelBeta',
    shortcutName: 'Mindstone Rebel Beta.lnk',
    exeName: 'Mindstone Rebel Beta.exe',
  },
  stable: {
    dirName: 'MindstoneRebel',
    regKey: 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\MindstoneRebel',
    shortcutName: 'Mindstone Rebel.lnk',
    exeName: 'Mindstone Rebel.exe',
  },
} as const;

/**
 * Get base LOCALAPPDATA path safely.
 */
const getLocalAppDataPath = (): string => {
  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) {
    return path.join(getPlatformConfig().homePath, 'AppData', 'Local');
  }
  return localAppData;
};

/**
 * Get potential Squirrel install directory under C:\ProgramData\{username}\.
 * Some Windows environments (folder redirection, enterprise group policy) can cause
 * Squirrel to install under ProgramData instead of LOCALAPPDATA. This produces
 * orphaned Update.exe files that trigger AV false positives (e.g., Avast IDP.Generic).
 */
const getProgramDataSquirrelDir = (): string | null => {
  const programData = process.env.ProgramData;
  if (!programData) return null;

  const username = path.basename(getPlatformConfig().homePath);
  if (!username) return null;

  const config = getSquirrelConfig();
  return path.join(programData, username, config.dirName);
};

/**
 * Get Squirrel config for current build channel.
 */
function getSquirrelConfig() {
  const channel = getBuildChannel();
  // Dev builds should clean up stable (since dev is essentially stable in development)
  return channel === 'beta' ? SQUIRREL_CONFIG.beta : SQUIRREL_CONFIG.stable;
}

/**
 * Get the Squirrel install directory for the current channel.
 */
const getSquirrelDir = (): string => {
  const config = getSquirrelConfig();
  return path.join(getLocalAppDataPath(), config.dirName);
};

/**
 * Check if Squirrel's registry uninstall entry exists for the given config/channel.
 * This detects orphaned registry entries even when the folder is gone.
 */
async function isSquirrelRegistryEntryPresent(
  config?: typeof SQUIRREL_CONFIG[keyof typeof SQUIRREL_CONFIG]
): Promise<boolean> {
  if (process.platform !== 'win32') return false;

  const effectiveConfig = config || getSquirrelConfig();
  try {
    // No /ve flag — check key existence regardless of default value
    // (Squirrel keys may not have a default value set)
    await execAsync(`reg query "${effectiveConfig.regKey}"`, { timeout: 5000 });
    return true;
  } catch (err: unknown) {
    const execErr = err as { code?: number; stderr?: string };
    if (execErr.code === 1) return false; // Key not found — expected
    // Unexpected error — log but treat as "not present" (fail-open for detection)
    logger.warn({ errorCode: execErr.code }, '[SQUIRREL-CLEANUP] Registry query failed unexpectedly');
    return false;
  }
}

/**
 * Check if a directory contains Squirrel markers (Update.exe or app-* folders).
 */
async function hasSquirrelMarkers(dir: string): Promise<boolean> {
  try {
    const updateExe = path.join(dir, 'Update.exe');
    await fs.promises.access(updateExe, fs.constants.F_OK);
    return true;
  } catch {
    try {
      const contents = await fs.promises.readdir(dir);
      return contents.some((name) => name.startsWith('app-'));
    } catch {
      return false;
    }
  }
}

/**
 * Check if old Squirrel installation exists for current channel.
 * Checks both the standard LOCALAPPDATA path and a ProgramData fallback
 * (for environments with folder redirection).
 */
async function isSquirrelInstallationPresent(): Promise<boolean> {
  if (process.platform !== 'win32') return false;

  // Primary: standard LOCALAPPDATA path
  if (await hasSquirrelMarkers(getSquirrelDir())) return true;

  // Secondary: ProgramData path (folder redirection / enterprise environments)
  const programDataDir = getProgramDataSquirrelDir();
  if (programDataDir && await hasSquirrelMarkers(programDataDir)) return true;

  // Tertiary: orphaned registry entry
  return isSquirrelRegistryEntryPresent();
}

/**
 * Check if current app is running from NSIS installation.
 * Uses inverted logic: if NOT running from Squirrel path, assume NSIS.
 * This handles custom NSIS install paths.
 */
function isRunningFromNSIS(): boolean {
  if (process.platform !== 'win32') return false;

  const execPath = process.execPath.toLowerCase();
  const config = getSquirrelConfig();

  // If running from this channel's Squirrel install location, definitely NOT NSIS
  // Pattern: %LOCALAPPDATA%\{dirName}\app-X.Y.Z\
  const squirrelPattern = new RegExp(
    `\\\\${config.dirName.toLowerCase()}\\\\app-[\\d.]+\\\\`,
    'i'
  );
  if (squirrelPattern.test(execPath)) {
    return false;
  }

  // If running from dev environment, NOT NSIS
  if (execPath.includes('electron.exe') || execPath.includes('node_modules')) {
    return false;
  }

  // If not Squirrel and not dev, assume NSIS (handles custom install paths)
  return true;
}

/**
 * Check if old Squirrel process is currently running for this channel.
 * Uses PowerShell Get-CimInstance (supported long-term, replaces deprecated wmic).
 */
async function isSquirrelAppRunning(): Promise<boolean> {
  try {
    const config = getSquirrelConfig();
    const squirrelDir = getSquirrelDir().toLowerCase();

    // Use PowerShell Get-CimInstance to check for this channel's exe
    const { stdout } = await execAsync(
      `powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name='${config.exeName}'\\" | Select-Object -ExpandProperty ExecutablePath"`,
      { timeout: 10000 }
    );

    // Check if any running instance is from the Squirrel directory
    return stdout.toLowerCase().includes(squirrelDir);
  } catch {
    // If we can't check, assume not running (fail-open for cleanup)
    return false;
  }
}

/**
 * Sleep helper for retry delays.
 */
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Get paths for Squirrel-created shortcuts for this channel.
 * Squirrel creates shortcuts at:
 * - Desktop: User's desktop folder (handles OneDrive redirection)
 * - Start Menu: %APPDATA%\Microsoft\Windows\Start Menu\Programs\{shortcutName}
 */
function getSquirrelShortcutPaths(): { desktop: string; startMenu: string } {
  const config = getSquirrelConfig();
  // Use getPlatformConfig().desktopPath to handle OneDrive-redirected desktops
  const desktopPath = getPlatformConfig().desktopPath;
  const appDataPath = getPlatformConfig().appDataPath; // %APPDATA% (Roaming)

  return {
    desktop: path.join(desktopPath, config.shortcutName),
    startMenu: path.join(appDataPath, 'Microsoft', 'Windows', 'Start Menu', 'Programs', config.shortcutName),
  };
}

/**
 * Check if a shortcut (.lnk file) points to the old Squirrel installation.
 * Uses PowerShell to read the shortcut target path.
 * Returns true if the shortcut points to Squirrel path, false otherwise.
 */
async function isShortcutPointingToSquirrel(shortcutPath: string): Promise<boolean> {
  try {
    // Check if shortcut exists first
    await fs.promises.access(shortcutPath, fs.constants.F_OK);

    // Use PowerShell to read shortcut target (WScript.Shell COM object)
    const psCommand = `
      $shell = New-Object -ComObject WScript.Shell
      $shortcut = $shell.CreateShortcut('${shortcutPath.replace(/'/g, "''")}')
      $shortcut.TargetPath
    `.trim();

    const { stdout } = await execAsync(`powershell -NoProfile -Command "${psCommand}"`, { timeout: 10000 });

    const targetPath = stdout.trim().toLowerCase();
    const squirrelDir = getSquirrelDir().toLowerCase();

    // Check if target points to this channel's Squirrel installation
    return targetPath.includes(squirrelDir);
  } catch {
    // If we can't read the shortcut, assume it's not a Squirrel shortcut
    return false;
  }
}

/**
 * Remove Squirrel shortcuts from Desktop and Start Menu for this channel.
 * Only removes shortcuts that actually point to the old Squirrel installation path.
 * This prevents accidentally removing NSIS shortcuts.
 *
 * Returns object with results for each shortcut location.
 */
async function removeSquirrelShortcuts(): Promise<{ desktop: boolean; startMenu: boolean }> {
  const shortcuts = getSquirrelShortcutPaths();
  const results = { desktop: false, startMenu: false };

  // Check and remove Desktop shortcut
  try {
    if (await isShortcutPointingToSquirrel(shortcuts.desktop)) {
      await fs.promises.unlink(shortcuts.desktop);
      results.desktop = true;
      logger.info('[SQUIRREL-CLEANUP] Desktop shortcut removed');
    }
  } catch (err: unknown) {
    const nodeErr = err as NodeJS.ErrnoException;
    if (nodeErr.code !== 'ENOENT') {
      logger.warn({ errorCode: nodeErr.code }, '[SQUIRREL-CLEANUP] Failed to remove Desktop shortcut');
    }
  }

  // Check and remove Start Menu shortcut
  try {
    if (await isShortcutPointingToSquirrel(shortcuts.startMenu)) {
      await fs.promises.unlink(shortcuts.startMenu);
      results.startMenu = true;
      logger.info('[SQUIRREL-CLEANUP] Start Menu shortcut removed');
    }
  } catch (err: unknown) {
    const nodeErr = err as NodeJS.ErrnoException;
    if (nodeErr.code !== 'ENOENT') {
      logger.warn({ errorCode: nodeErr.code }, '[SQUIRREL-CLEANUP] Failed to remove Start Menu shortcut');
    }
  }

  return results;
}

/**
 * Remove Squirrel's registry uninstall entry for this channel.
 * Returns true if successful or key didn't exist.
 */
async function removeSquirrelRegistryEntry(): Promise<boolean> {
  const config = getSquirrelConfig();
  const regKey = config.regKey;

  try {
    await execAsync(`reg delete "${regKey}" /f`, { timeout: 10000 });
    logger.info('[SQUIRREL-CLEANUP] Registry entry removed');
    return true;
  } catch (err: unknown) {
    // Exit code 1 typically means key not found - that's success for us
    const execErr = err as { code?: number; stderr?: string };
    const stderr = execErr.stderr || '';
    const isNotFound = execErr.code === 1 || /not found|does not exist|cannot find/i.test(stderr);

    if (isNotFound) {
      return true; // Key didn't exist, that's fine
    }
    throw err;
  }
}

/**
 * Delete folder with retry logic for AV-induced locks.
 * Uses fs.rm directly (no shell.trashItem to avoid recycle bin sound).
 */
async function deleteFolderWithRetry(folderPath: string): Promise<boolean> {
  for (let attempt = 1; attempt <= CLEANUP_CONFIG.maxRetries; attempt++) {
    try {
      await fs.promises.rm(folderPath, {
        recursive: true,
        force: true,
        maxRetries: 2,
        retryDelay: 500,
      });

      // Verify deletion with brief delay (filesystem can be async)
      await sleep(200);
      const stillExists = await fs.promises.stat(folderPath).catch(() => null);

      if (!stillExists) {
        logger.info('[SQUIRREL-CLEANUP] Folder deleted successfully');
        return true;
      }

      throw new Error('Folder still exists after deletion');
    } catch (rmErr: unknown) {
      // Check for lock errors by error code (more reliable than message parsing)
      const nodeErr = rmErr as NodeJS.ErrnoException;
      const isLockError = ['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY'].includes(nodeErr.code || '');

      if (isLockError && attempt < CLEANUP_CONFIG.maxRetries) {
        const delay = CLEANUP_CONFIG.baseDelayMs * Math.pow(2, attempt - 1);
        logger.warn({ attempt, delay, errorCode: nodeErr.code }, '[SQUIRREL-CLEANUP] File locked, retrying');
        await sleep(delay);
        continue;
      }

      throw rmErr;
    }
  }
  return false;
}

// Track cleanup state in memory
let cleanupAttempted = false;

/**
 * Run automatic Squirrel cleanup.
 *
 * This is the main entry point - call from app startup.
 * Runs silently in background, reports failures to Sentry.
 */
export async function runAutomaticSquirrelCleanup(): Promise<void> {
  // Only run once per app session
  if (cleanupAttempted) return;
  cleanupAttempted = true;

  // Platform gate
  if (process.platform !== 'win32') return;

  // NSIS gate - don't cleanup if running from Squirrel
  if (!isRunningFromNSIS()) {
    logger.debug('[SQUIRREL-CLEANUP] Not running from NSIS, skipping');
    return;
  }

  // Check if Squirrel exists
  const hasSquirrel = await isSquirrelInstallationPresent();
  if (!hasSquirrel) {
    logger.debug('[SQUIRREL-CLEANUP] No Squirrel installation found');
    return;
  }

  // Check if old app is running
  const isRunning = await isSquirrelAppRunning();
  if (isRunning) {
    logger.info('[SQUIRREL-CLEANUP] Old Squirrel app is running, skipping cleanup');
    return;
  }

  const squirrelDir = getSquirrelDir();
  const config = getSquirrelConfig();
  // Log channel and target dir name only (not full path with username)
  logger.info({ channel: getBuildChannel(), targetDir: config.dirName }, '[SQUIRREL-CLEANUP] Starting automatic cleanup');

  // Track cleanup attempt
  trackMainEvent({
    anonymousId: getOrGenerateAnonymousId(),
    event: 'squirrel_cleanup_attempted',
    properties: { channel: getBuildChannel() },
  });

  const startTime = Date.now();
  let folderExisted = false;
  let folderDeleted = false;
  let registryCleaned = false;
  let shortcutsRemoved = { desktop: false, startMenu: false };
  let errorCode: string | undefined;

  try {
    // Step 1: Remove shortcuts (before folder deletion so we can verify targets)
    try {
      shortcutsRemoved = await removeSquirrelShortcuts();
      if (shortcutsRemoved.desktop || shortcutsRemoved.startMenu) {
        logger.info({ ...shortcutsRemoved }, '[SQUIRREL-CLEANUP] Shortcuts removed');
      }
    } catch (shortcutErr: unknown) {
      const nodeErr = shortcutErr as NodeJS.ErrnoException;
      logger.warn({ errorCode: nodeErr.code }, '[SQUIRREL-CLEANUP] Shortcut cleanup failed');
    }

    // Step 2: Delete Squirrel folder (skip if already gone — registry-only cleanup)
    try {
      await fs.promises.access(squirrelDir, fs.constants.F_OK);
      folderExisted = true;
    } catch (accessErr: unknown) {
      const nodeErr = accessErr as NodeJS.ErrnoException;
      if (nodeErr.code === 'ENOENT') {
        // Folder doesn't exist — registry-only cleanup
        logger.debug('[SQUIRREL-CLEANUP] Folder already gone, skipping deletion');
      } else {
        // Non-ENOENT error (e.g. EACCES) — folder may still exist, attempt deletion
        folderExisted = true;
        logger.warn({ errorCode: nodeErr.code }, '[SQUIRREL-CLEANUP] Folder access check failed, attempting deletion anyway');
      }
    }

    if (folderExisted) {
      try {
        folderDeleted = await deleteFolderWithRetry(squirrelDir);
        if (folderDeleted) {
          logger.info('[SQUIRREL-CLEANUP] Folder deleted');
        }
      } catch (err: unknown) {
        const nodeErr = err as NodeJS.ErrnoException;
        errorCode = nodeErr.code || 'UNKNOWN';
        logger.error({ errorCode }, '[SQUIRREL-CLEANUP] Folder deletion failed');
      }
    }

    // Step 2b: Clean ProgramData Squirrel remnant (folder redirection / enterprise environments)
    // Some Windows configurations cause Squirrel to install under C:\ProgramData\{username}\,
    // leaving orphaned Update.exe files that trigger AV false positives (e.g., Avast IDP.Generic).
    const programDataDir = getProgramDataSquirrelDir();
    if (programDataDir && programDataDir !== squirrelDir) {
      try {
        if (await hasSquirrelMarkers(programDataDir)) {
          logger.info('[SQUIRREL-CLEANUP] Found Squirrel remnant in ProgramData, cleaning');
          const pdDeleted = await deleteFolderWithRetry(programDataDir);
          if (pdDeleted) {
            logger.info('[SQUIRREL-CLEANUP] ProgramData Squirrel remnant deleted');
          }
        }
      } catch (err: unknown) {
        const nodeErr = err as NodeJS.ErrnoException;
        logger.warn({ errorCode: nodeErr.code }, '[SQUIRREL-CLEANUP] ProgramData cleanup failed (non-fatal)');
      }
    }

    // Step 3: Clean registry entry (even if folder deletion failed)
    try {
      registryCleaned = await removeSquirrelRegistryEntry();
      if (registryCleaned) {
        logger.info('[SQUIRREL-CLEANUP] Registry entry removed');
      }
    } catch (regErr: unknown) {
      const nodeErr = regErr as NodeJS.ErrnoException;
      logger.warn({ errorCode: nodeErr.code }, '[SQUIRREL-CLEANUP] Registry cleanup failed');
    }
  } catch (err: unknown) {
    const nodeErr = err as NodeJS.ErrnoException;
    errorCode = nodeErr.code || 'UNKNOWN';
    logger.error({ errorCode }, '[SQUIRREL-CLEANUP] Cleanup failed');
  }

  const duration = Date.now() - startTime;
  const folderOk = !folderExisted || folderDeleted;
  const success = folderOk && registryCleaned;

  if (success) {
    // Track successful cleanup
    trackMainEvent({
      anonymousId: getOrGenerateAnonymousId(),
      event: 'squirrel_cleanup_succeeded',
      properties: {
        durationMs: duration,
        registryCleaned,
        registryOnly: !folderExisted,
        folderExisted,
        shortcutsRemovedDesktop: shortcutsRemoved.desktop,
        shortcutsRemovedStartMenu: shortcutsRemoved.startMenu,
      },
    });
    logger.info({ duration }, '[SQUIRREL-CLEANUP] Cleanup completed successfully');
  } else {
    // Track failed cleanup
    trackMainEvent({
      anonymousId: getOrGenerateAnonymousId(),
      event: 'squirrel_cleanup_failed',
      properties: {
        durationMs: duration,
        folderExisted,
        folderDeleted,
        registryCleaned,
        registryOnly: !folderExisted,
        shortcutsRemovedDesktop: shortcutsRemoved.desktop,
        shortcutsRemovedStartMenu: shortcutsRemoved.startMenu,
        errorCode,
      },
    });

    // Report to Sentry (with redacted paths)
    getErrorReporter().captureMessage('Squirrel cleanup failed', {
      level: 'error',
      tags: {
        component: 'squirrel-cleanup',
        errorCode: errorCode || 'unknown',
      },
      extra: {
        folderExisted,
        folderDeleted,
        registryCleaned,
        registryOnly: !folderExisted,
        shortcutsRemovedDesktop: shortcutsRemoved.desktop,
        shortcutsRemovedStartMenu: shortcutsRemoved.startMenu,
        duration,
      },
    });
  }
}

/**
 * Schedule cleanup to run in the background.
 * Call this from main process startup (after createWindow()).
 *
 * Timing rationale (per reviewer-gpt5.2-high):
 * - Call AFTER `await createWindow()` to avoid competing with critical startup
 * - 60s delay ensures app is fully initialized and user is actively using it
 * - Consistent with existing "avoid contention" patterns (e.g., conversationIndexService)
 *
 * Uses setImmediate to not block the event loop.
 * Timer is unref'd so it doesn't keep the app alive.
 */
export function scheduleSquirrelCleanup(): void {
  // SUNSET: Remove this entire function after 2026-10-01
  if (process.platform !== 'win32') return;

  // Runtime sunset warning
  if (Date.now() > new Date('2026-10-01').getTime()) {
    logger.warn('[SQUIRREL-CLEANUP] This code is past its sunset date and should be removed');
  }

  logger.debug('[SQUIRREL-CLEANUP] Scheduling cleanup in 60s');

  // Run cleanup 60s after window is ready - well after startup completes
  // .unref() ensures this timer doesn't keep the app alive if user closes quickly
  const timer = setTimeout(() => {
    setImmediate(() => {
      runAutomaticSquirrelCleanup().catch((err) => {
        const nodeErr = err as NodeJS.ErrnoException;
        logger.error({ errorCode: nodeErr.code || 'UNKNOWN' }, '[SQUIRREL-CLEANUP] Unexpected error');
        getErrorReporter().captureException(err, {
          tags: { component: 'squirrel-cleanup' },
        });
      });
    });
  }, CLEANUP_CONFIG.startupDelayMs);

  // Don't keep app alive just for cleanup
  timer.unref();
}

/**
 * DEV ONLY: Run cleanup immediately for testing, bypassing NSIS check.
 * WARNING: This is for development testing only. It bypasses the normal
 * channel detection and NSIS check, but still uses the safe shortcut
 * verification to avoid deleting NSIS shortcuts.
 *
 * @param forceChannel - Override the channel detection ('beta' or 'stable')
 */
export async function runSquirrelCleanupNow(forceChannel?: 'beta' | 'stable'): Promise<void> {
  logger.info({ forceChannel }, '[SQUIRREL-CLEANUP] Running immediate cleanup (dev mode, bypassing NSIS check)');

  if (process.platform !== 'win32') {
    logger.info('[SQUIRREL-CLEANUP] Not Windows, skipping');
    return;
  }

  // Use forced channel or detect from build
  const effectiveChannel = forceChannel || (getBuildChannel() === 'beta' ? 'beta' : 'stable');
  const config = effectiveChannel === 'beta' ? SQUIRREL_CONFIG.beta : SQUIRREL_CONFIG.stable;
  const squirrelDir = path.join(getLocalAppDataPath(), config.dirName);

  // Check if exists
  let squirrelExists = false;
  try {
    const updateExe = path.join(squirrelDir, 'Update.exe');
    await fs.promises.access(updateExe, fs.constants.F_OK);
    squirrelExists = true;
  } catch {
    try {
      const contents = await fs.promises.readdir(squirrelDir);
      squirrelExists = contents.some((name) => name.startsWith('app-'));
    } catch {
      squirrelExists = false;
    }
  }

  // Fallback: check for orphaned registry entry if no filesystem artifacts found
  if (!squirrelExists) {
    squirrelExists = await isSquirrelRegistryEntryPresent(config);
    if (squirrelExists) {
      logger.info('[SQUIRREL-CLEANUP] Found orphaned registry entry (no folder)');
    }
  }

  logger.info(
    { effectiveChannel, targetDir: config.dirName, squirrelExists },
    '[SQUIRREL-CLEANUP] Dev cleanup starting'
  );

  if (!squirrelExists) {
    logger.info('[SQUIRREL-CLEANUP] No Squirrel installation found at target path');
    return;
  }

  // Check if old app running
  try {
    const { stdout } = await execAsync(
      `powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name='${config.exeName}'\\" | Select-Object -ExpandProperty ExecutablePath"`,
      { timeout: 10000 }
    );
    if (stdout.toLowerCase().includes(squirrelDir.toLowerCase())) {
      logger.info('[SQUIRREL-CLEANUP] Old Squirrel app is running, cannot clean');
      return;
    }
  } catch {
    // Assume not running
  }

  // Remove shortcuts (with target verification for safety)
  const desktopPath = getPlatformConfig().desktopPath;
  const appDataPath = getPlatformConfig().appDataPath;
  const shortcuts = {
    desktop: path.join(desktopPath, config.shortcutName),
    startMenu: path.join(appDataPath, 'Microsoft', 'Windows', 'Start Menu', 'Programs', config.shortcutName),
  };

  for (const [loc, shortcutPath] of Object.entries(shortcuts)) {
    try {
      // Verify shortcut points to Squirrel dir before deleting (safety check)
      if (await isShortcutPointingToSquirrelDir(shortcutPath, squirrelDir)) {
        await fs.promises.unlink(shortcutPath);
        logger.info({ loc }, '[SQUIRREL-CLEANUP] Shortcut removed');
      }
    } catch (err: unknown) {
      const nodeErr = err as NodeJS.ErrnoException;
      if (nodeErr.code !== 'ENOENT') {
        logger.warn({ loc, errorCode: nodeErr.code }, '[SQUIRREL-CLEANUP] Failed to remove shortcut');
      }
    }
  }

  // Delete folder (skip if already gone)
  let folderExists = false;
  try {
    await fs.promises.access(squirrelDir, fs.constants.F_OK);
    folderExists = true;
  } catch {
    // Folder already gone
  }

  if (folderExists) {
    try {
      await fs.promises.rm(squirrelDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 1000 });
      logger.info('[SQUIRREL-CLEANUP] Folder deleted successfully');
    } catch (err) {
      logger.error({ err }, '[SQUIRREL-CLEANUP] Folder deletion failed');
    }
  } else {
    logger.info('[SQUIRREL-CLEANUP] Folder already gone, skipping deletion');
  }

  // Clean registry
  try {
    await execAsync(`reg delete "${config.regKey}" /f`, { timeout: 10000 });
    logger.info('[SQUIRREL-CLEANUP] Registry entry removed');
  } catch (err: unknown) {
    const execErr = err as { code?: number; stderr?: string };
    const isNotFound = execErr.code === 1 || /not found|does not exist/i.test(execErr.stderr || '');
    if (!isNotFound) {
      logger.warn({ err }, '[SQUIRREL-CLEANUP] Registry cleanup issue');
    }
  }

  logger.info('[SQUIRREL-CLEANUP] Dev cleanup complete');
}

/**
 * Helper: Check if shortcut points to a specific Squirrel directory.
 * Used by runSquirrelCleanupNow for forced channel cleanup.
 */
async function isShortcutPointingToSquirrelDir(shortcutPath: string, squirrelDir: string): Promise<boolean> {
  try {
    await fs.promises.access(shortcutPath, fs.constants.F_OK);

    const psCommand = `
      $shell = New-Object -ComObject WScript.Shell
      $shortcut = $shell.CreateShortcut('${shortcutPath.replace(/'/g, "''")}')
      $shortcut.TargetPath
    `.trim();

    const { stdout } = await execAsync(`powershell -NoProfile -Command "${psCommand}"`, { timeout: 10000 });
    const targetPath = stdout.trim().toLowerCase();

    return targetPath.includes(squirrelDir.toLowerCase());
  } catch {
    return false;
  }
}

/**
 * DEV ONLY: Check what would be cleaned up without actually cleaning.
 */
export async function diagnoseSquirrelInstallations(): Promise<{
  channel: string;
  isNSIS: boolean;
  targetDir: string;
  squirrelExists: boolean;
  registryExists: boolean;
  isOldAppRunning: boolean;
  programDataRemnant: boolean;
}> {
  const channel = getBuildChannel();
  const config = getSquirrelConfig();
  const isNSIS = isRunningFromNSIS();
  const squirrelExists = await isSquirrelInstallationPresent();
  const registryExists = await isSquirrelRegistryEntryPresent();
  const isOldAppRunning = await isSquirrelAppRunning();

  const programDataDir = getProgramDataSquirrelDir();
  const programDataRemnant = programDataDir ? await hasSquirrelMarkers(programDataDir) : false;

  logger.info(
    { channel, isNSIS, targetDir: config.dirName, squirrelExists, registryExists, isOldAppRunning, programDataRemnant },
    '[SQUIRREL-CLEANUP] Diagnostic results'
  );

  return { channel, isNSIS, targetDir: config.dirName, squirrelExists, registryExists, isOldAppRunning, programDataRemnant };
}
