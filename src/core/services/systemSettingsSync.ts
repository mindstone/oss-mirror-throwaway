/**
 * System Settings Sync Service
 *
 * Manages access to rebel-system instruction files that are bundled with the app.
 * In development: uses the local submodule at app.getAppPath()/rebel-system
 * In production: uses the bundled copy at process.resourcesPath/rebel-system
 *
 * This replaced the previous GitHub-download approach for simpler, offline-capable distribution.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { logger } from '@core/logger';
import { isPackaged, getAppRoot, getDataPath } from '@core/utils/dataPaths';

const VERSION_FILE_NAME = 'rebel-system-version.json';

const SUBMODULE_NAME = 'rebel-system';
const WORKSPACE_SYMLINK_NAME = 'rebel-system';
const AGENTS_SYMLINK_NAME = 'AGENTS.md';
const CLAUDE_SYMLINK_NAME = 'CLAUDE.md';

// Retry configuration for Windows file locking issues
const FILE_OP_MAX_RETRIES = 5;
const FILE_OP_BASE_DELAY_MS = 100;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isRetryableFileError(code: string | undefined): boolean {
  return code === 'EPERM' || code === 'EBUSY' || code === 'ENOTEMPTY' || code === 'EACCES';
}

async function safeUnlink(targetPath: string): Promise<void> {
  for (let attempt = 0; attempt < FILE_OP_MAX_RETRIES; attempt++) {
    try {
      await fs.unlink(targetPath);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (!isRetryableFileError(code) || attempt === FILE_OP_MAX_RETRIES - 1) {
        throw err;
      }
      const delayMs = FILE_OP_BASE_DELAY_MS * Math.pow(2, attempt);
      logger.debug({ code, attempt, delayMs, targetPath }, 'File unlink failed, retrying');
      await sleep(delayMs);
    }
  }
}

function isDevMode(): boolean {
  return !isPackaged();
}

function getSubmodulePath(): string {
  // In dev mode, getAppRoot() may point to out/main when running built CLI
  // Try multiple locations: app path first, then cwd (project root)
  const appPath = getAppRoot();
  const candidates = [
    path.join(appPath, SUBMODULE_NAME),
    path.join(process.cwd(), SUBMODULE_NAME),
  ];
  
  const fs = require('fs');
  for (const candidate of candidates) {
    try {
      const entries = fs.readdirSync(candidate);
      if (entries.length > 0) {
        return candidate;
      }
    } catch {
      // Try next candidate
    }
  }
  
  // Return default (will fail later with helpful error)
  return path.join(appPath, SUBMODULE_NAME);
}

async function hasSubmodule(): Promise<boolean> {
  const submodulePath = getSubmodulePath();
  try {
    const entries = await fs.readdir(submodulePath);
    return entries.length > 0;
  } catch {
    return false;
  }
}

function getBundledRebelSystemPath(): string {
  const base = process.resourcesPath ?? getAppRoot();
  return path.join(base, SUBMODULE_NAME);
}

interface SystemSettingsConfig {
  version: string;
}

function getSystemSettingsConfig(): SystemSettingsConfig {
  try {
    const appPath = getAppRoot();
    const packageJsonPath = path.join(appPath, 'package.json');
    const packageJsonContent = require('fs').readFileSync(packageJsonPath, 'utf8');
    const packageJson = JSON.parse(packageJsonContent);
    const config = packageJson.systemSettings;
    return {
      version: config?.version ?? '0.0.0',
    };
  } catch (error) {
    logger.error({ err: error }, 'Failed to read systemSettings from package.json');
    return { version: '0.0.0' };
  }
}

/**
 * Get the system settings version from package.json
 */
export function getAppSystemSettingsVersion(): string {
  return getSystemSettingsConfig().version;
}

/**
 * Verify that the bundled rebel-system exists and has content.
 * Called on app startup to ensure the bundle was created correctly.
 */
export async function verifyBundledRebelSystem(): Promise<void> {
  if (isDevMode()) {
    if (await hasSubmodule()) {
      logger.info({ submodulePath: getSubmodulePath() }, 'Dev mode: using local rebel-system submodule');
      return;
    }
    logger.warn('Dev mode: rebel-system submodule not found or empty');
    return;
  }

  const bundledPath = getBundledRebelSystemPath();
  try {
    const entries = await fs.readdir(bundledPath);
    if (entries.length === 0) {
      logger.error({ bundledPath }, 'Bundled rebel-system is empty');
      return;
    }

    const hasAgentsMd = entries.includes('AGENTS.md');
    if (!hasAgentsMd) {
      logger.error({ bundledPath, entries }, 'Bundled rebel-system missing AGENTS.md');
      return;
    }

    const version = getAppSystemSettingsVersion();
    logger.info({ bundledPath, fileCount: entries.length, version }, 'Bundled rebel-system verified');

    // Update the version file in userData to match the bundled version.
    // This ensures diagnostics show the correct version after app updates.
    // (Legacy from when rebel-system was downloaded from GitHub.)
    await updateVersionFile(version);
  } catch (error) {
    logger.error({ err: error, bundledPath }, 'Failed to verify bundled rebel-system');
  }
}

/**
 * Update the version file in userData to reflect the current bundled version.
 * This is used by health checks to verify the system files are in sync.
 */
async function updateVersionFile(version: string): Promise<void> {
  try {
    const versionFilePath = path.join(getDataPath(), VERSION_FILE_NAME);
    const versionData = {
      version,
      updatedAt: new Date().toISOString(),
      source: 'bundled',
    };
    await fs.writeFile(versionFilePath, JSON.stringify(versionData, null, 2));
    logger.debug({ versionFilePath, version }, 'Updated rebel-system version file');
  } catch (error) {
    logger.warn({ err: error }, 'Failed to update rebel-system version file');
  }
}

/**
 * Legacy alias for verifyBundledRebelSystem for backwards compatibility.
 * Previously this would download from GitHub; now it just verifies the bundle.
 */
export async function syncSystemSettingsIfNeeded(): Promise<void> {
  return verifyBundledRebelSystem();
}

/**
 * Get the path to the system settings directory.
 * In dev mode, returns the submodule path if it exists.
 * In production, returns the bundled resources path.
 */
export function getSystemSettingsPath(): string {
  if (isDevMode()) {
    const submodulePath = getSubmodulePath();
    try {
      const fs = require('fs');
      const entries = fs.readdirSync(submodulePath);
      if (entries.length > 0) {
        return submodulePath;
      }
    } catch {
      // Fall through to bundled path
    }
  }
  return getBundledRebelSystemPath();
}

/**
 * Create a symlink from the user's workspace to the system settings directory.
 * This allows the agent to access system settings through the workspace.
 */
export async function createLibrarySymlink(coreDirectory: string | null): Promise<void> {
  if (!coreDirectory) {
    logger.debug('Library symlink skipped: no coreDirectory configured');
    return;
  }

  // Check workspace directory exists (FOX-2309: prevents crash when cloud storage disconnected)
  try {
    const coreStats = await fs.stat(coreDirectory);
    if (!coreStats.isDirectory()) {
      logger.warn({ coreDirectory }, 'Library symlink skipped: workspace path is not a directory');
      return;
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    logger.warn({ coreDirectory, code }, 'Library symlink skipped: workspace directory not accessible');
    return;
  }

  const targetDir = getSystemSettingsPath();
  const symlinkPath = path.join(coreDirectory, WORKSPACE_SYMLINK_NAME);

  try {
    await fs.access(targetDir);
  } catch {
    logger.debug('Library symlink skipped: system settings not found');
    return;
  }

  try {
    const existingStat = await fs.lstat(symlinkPath).catch(() => null);
    
    if (existingStat) {
      if (existingStat.isSymbolicLink()) {
        const existingTarget = await fs.readlink(symlinkPath);
        if (existingTarget === targetDir) {
          logger.debug('Library symlink already exists and is correct');
          return;
        }
        await safeUnlink(symlinkPath);
        logger.info({ oldTarget: existingTarget }, 'Removed outdated workspace symlink');
      } else {
        logger.warn(
          { path: symlinkPath },
          'Cannot create workspace symlink: path exists and is not a symlink'
        );
        return;
      }
    }

    // On Windows, use 'junction' type for directories (doesn't require admin/developer mode)
    const symlinkType = process.platform === 'win32' ? 'junction' : 'dir';
    await fs.symlink(targetDir, symlinkPath, symlinkType);
    logger.info(
      { symlinkPath, target: targetDir, devMode: isDevMode(), symlinkType },
      'Created workspace symlink to system settings'
    );
  } catch (error) {
    logger.error({ err: error, symlinkPath }, 'Failed to create workspace symlink');
  }
}

/**
 * Create a symlink from the workspace root AGENTS.md to rebel-system/AGENTS.md.
 * This provides Cursor/external IDE fallback.
 */
export async function createAgentsMdSymlink(coreDirectory: string | null): Promise<void> {
  if (!coreDirectory) {
    logger.debug('AGENTS.md symlink skipped: no coreDirectory configured');
    return;
  }

  // Check workspace directory exists (FOX-2309: prevents crash when cloud storage disconnected)
  try {
    const coreStats = await fs.stat(coreDirectory);
    if (!coreStats.isDirectory()) {
      logger.warn({ coreDirectory }, 'AGENTS.md symlink skipped: workspace path is not a directory');
      return;
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    logger.warn({ coreDirectory, code }, 'AGENTS.md symlink skipped: workspace directory not accessible');
    return;
  }

  const symlinkPath = path.join(coreDirectory, AGENTS_SYMLINK_NAME);
  const targetRelative = path.join(WORKSPACE_SYMLINK_NAME, AGENTS_SYMLINK_NAME);
  const targetAbsolute = path.join(coreDirectory, targetRelative);

  try {
    await fs.access(targetAbsolute);
  } catch {
    logger.debug('AGENTS.md symlink skipped: rebel-system/AGENTS.md not found');
    return;
  }

  try {
    const existingStat = await fs.lstat(symlinkPath).catch(() => null);

    if (existingStat) {
      if (existingStat.isSymbolicLink()) {
        const existingTarget = await fs.readlink(symlinkPath);
        if (existingTarget === targetRelative) {
          logger.debug('AGENTS.md symlink already exists and is correct');
          return;
        }
        await safeUnlink(symlinkPath);
        logger.info({ oldTarget: existingTarget }, 'Removed outdated AGENTS.md symlink');
      } else {
        logger.warn(
          { path: symlinkPath },
          'Cannot create AGENTS.md symlink: file exists and is not a symlink. ' +
          'If you want the Cursor fallback, rename or remove the existing file.'
        );
        return;
      }
    }

    // On Windows, file symlinks require Developer Mode, so fall back to copy
    if (process.platform === 'win32') {
      await fs.copyFile(targetAbsolute, symlinkPath);
      logger.info(
        { symlinkPath, source: targetAbsolute },
        'Created AGENTS.md copy for Cursor/IDE fallback (Windows)'
      );
    } else {
      await fs.symlink(targetRelative, symlinkPath);
      logger.info(
        { symlinkPath, target: targetRelative },
        'Created AGENTS.md symlink for Cursor/IDE fallback'
      );
    }
  } catch (error) {
    logger.error({ err: error, symlinkPath }, 'Failed to create AGENTS.md symlink');
  }
}

/**
 * Create a symlink from the workspace root CLAUDE.md to AGENTS.md.
 * This provides Claude Code external-IDE fallback.
 */
export async function createClaudeMdSymlink(coreDirectory: string | null): Promise<void> {
  if (!coreDirectory) {
    logger.debug('CLAUDE.md symlink skipped: no coreDirectory configured');
    return;
  }

  // Check workspace directory exists (FOX-2309: prevents crash when cloud storage disconnected)
  try {
    const coreStats = await fs.stat(coreDirectory);
    if (!coreStats.isDirectory()) {
      logger.warn({ coreDirectory }, 'CLAUDE.md symlink skipped: workspace path is not a directory');
      return;
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    logger.warn({ coreDirectory, code }, 'CLAUDE.md symlink skipped: workspace directory not accessible');
    return;
  }

  const symlinkPath = path.join(coreDirectory, CLAUDE_SYMLINK_NAME);
  const targetRelative = AGENTS_SYMLINK_NAME;
  const targetAbsolute = path.join(coreDirectory, targetRelative);

  try {
    await fs.access(targetAbsolute);
  } catch {
    logger.debug('CLAUDE.md symlink skipped: AGENTS.md not found');
    return;
  }

  try {
    const existingStat = await fs.lstat(symlinkPath).catch(() => null);

    if (existingStat) {
      if (existingStat.isSymbolicLink()) {
        const existingTarget = await fs.readlink(symlinkPath);
        if (existingTarget === targetRelative) {
          logger.debug('CLAUDE.md symlink already exists and is correct');
          return;
        }
        await safeUnlink(symlinkPath);
        logger.info({ oldTarget: existingTarget }, 'Removed outdated CLAUDE.md symlink');
      } else {
        logger.warn(
          { path: symlinkPath },
          'Cannot create CLAUDE.md symlink: file exists and is not a symlink. ' +
          'If you want the Claude Code fallback, rename or remove the existing file.'
        );
        return;
      }
    }

    // On Windows, file symlinks require Developer Mode, so fall back to copy
    if (process.platform === 'win32') {
      await fs.copyFile(targetAbsolute, symlinkPath);
      logger.info(
        { symlinkPath, source: targetAbsolute },
        'Created CLAUDE.md copy for Claude Code fallback (Windows)'
      );
    } else {
      await fs.symlink(targetRelative, symlinkPath);
      logger.info(
        { symlinkPath, target: targetRelative },
        'Created CLAUDE.md symlink for Claude Code fallback'
      );
    }
  } catch (error) {
    logger.error({ err: error, symlinkPath }, 'Failed to create CLAUDE.md symlink/copy');
  }
}
