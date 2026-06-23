/**
 * Sync Health Checks
 */

import { getPlatformConfig } from '@core/platform';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { getSystemSettingsPath, getAppSystemSettingsVersion } from '../../systemSettingsSync';
import type { CheckResult } from '../types';

export async function checkRebelSystemPresent(): Promise<CheckResult> {
  const id = 'rebelSystemPresent';
  const name = 'System Files';

  try {
    const rebelSystemPath = getSystemSettingsPath();
    const expectedVersion = getAppSystemSettingsVersion();

    const stat = await fs.stat(rebelSystemPath);
    if (!stat.isDirectory()) {
      return {
        id,
        name,
        status: 'fail',
        message: 'System files location is not a directory',
        remediation: 'Restart the app to re-sync system files',
      };
    }

    const agentsMdPath = path.join(rebelSystemPath, 'AGENTS.md');
    try {
      await fs.access(agentsMdPath);
    } catch {
      return {
        id,
        name,
        status: 'fail',
        message: 'Critical system file missing (AGENTS.md)',
        details: { path: rebelSystemPath },
        remediation: 'Restart the app to re-sync system files',
      };
    }

    const { isPackaged, userDataPath } = getPlatformConfig();
    if (isPackaged) {
      const versionFilePath = path.join(userDataPath, 'rebel-system-version.json');
      try {
        const versionContent = await fs.readFile(versionFilePath, 'utf8');
        const versionInfo = JSON.parse(versionContent) as { version: string };
        
        if (versionInfo.version !== expectedVersion) {
          return {
            id,
            name,
            status: 'warn',
            message: `System files outdated (v${versionInfo.version} vs v${expectedVersion})`,
            details: { current: versionInfo.version, expected: expectedVersion },
            remediation: 'Restart the app to update system files',
          };
        }
      } catch {
        // Version file might not exist yet
      }
    }

    return {
      id,
      name,
      status: 'pass',
      message: isPackaged ? `Synced (v${expectedVersion})` : 'Using local submodule',
      details: { path: rebelSystemPath, version: expectedVersion, isPackaged },
    };
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    return {
      id,
      name,
      status: 'fail',
      message: `System files not found: ${err.message}`,
      remediation: 'Restart the app to sync system files. Check internet connection.',
    };
  }
}

export async function checkRebelSystemSyncStatus(): Promise<CheckResult> {
  const id = 'rebelSystemSyncStatus';
  const name = 'System Files Sync';

  const settingsDir = getSystemSettingsPath();
  const expectedVersion = getAppSystemSettingsVersion();
  const isPackagedBuild = getPlatformConfig().isPackaged;

  if (!isPackagedBuild) {
    const diagnostics: Record<string, unknown> = {
      mode: 'development',
      submodulePath: settingsDir,
      expectedVersion,
    };

    try {
      const stat = await fs.stat(settingsDir);
      if (stat.isDirectory()) {
        const files = await fs.readdir(settingsDir);
        diagnostics.fileCount = files.length;
        
        const hasAgentsMd = files.includes('AGENTS.md');
        if (!hasAgentsMd) {
          return {
            id,
            name,
            status: 'warn',
            message: 'Submodule may need initialization',
            details: diagnostics,
            remediation: 'Run: git submodule update --init --recursive',
          };
        }

        return {
          id,
          name,
          status: 'pass',
          message: `Using local submodule (${files.length} files)`,
          details: diagnostics,
        };
      }
    } catch {
      return {
        id,
        name,
        status: 'fail',
        message: 'Local submodule not found',
        details: diagnostics,
        remediation: 'Run: git submodule update --init --recursive',
      };
    }
  }

  const syncUserDataPath = getPlatformConfig().userDataPath;
  const versionFilePath = path.join(syncUserDataPath, 'rebel-system-version.json');
  
  const tempSyncDir = process.platform === 'win32'
    ? path.join(os.tmpdir(), 'rs-sync')
    : path.join(syncUserDataPath, 'rebel-system-temp');

  const diagnostics: Record<string, unknown> = {
    mode: 'production',
    versionFileExists: false,
    versionFileContent: null,
    expectedVersion,
    settingsDirExists: false,
    settingsDirFileCount: 0,
    tempDirHasArtifacts: false,
  };

  try {
    const content = await fs.readFile(versionFilePath, 'utf8');
    diagnostics.versionFileExists = true;
    diagnostics.versionFileContent = JSON.parse(content);
  } catch {
    // No version file
  }

  try {
    const stat = await fs.stat(settingsDir);
    if (stat.isDirectory()) {
      diagnostics.settingsDirExists = true;
      const files = await fs.readdir(settingsDir);
      diagnostics.settingsDirFileCount = files.length;
    }
  } catch {
    // Directory doesn't exist
  }

  try {
    await fs.access(tempSyncDir);
    const entries = await fs.readdir(tempSyncDir);
    if (entries.length > 0) {
      diagnostics.tempDirHasArtifacts = true;
      diagnostics.tempDirPath = tempSyncDir;
    }
  } catch {
    // No artifacts
  }

  if (diagnostics.tempDirHasArtifacts) {
    return {
      id,
      name,
      status: 'warn',
      message: 'Previous sync may have failed - temporary files found',
      details: diagnostics,
      remediation: `Delete the temp folder and restart the app: ${tempSyncDir}`,
    };
  }

  if (!diagnostics.versionFileExists && !diagnostics.settingsDirExists) {
    return {
      id,
      name,
      status: 'fail',
      message: 'System files not found',
      details: diagnostics,
      remediation: 'Try reinstalling the app',
    };
  }

  const versionContent = diagnostics.versionFileContent as { version?: string } | null;
  if (versionContent?.version) {
    const currentVersion = versionContent.version;
    if (currentVersion !== expectedVersion) {
      return {
        id,
        name,
        status: 'warn',
        message: `Outdated: v${currentVersion} installed, v${expectedVersion} expected`,
        details: diagnostics,
        remediation: 'Restart the app to update system files',
      };
    }
  }

  const fileCount = diagnostics.settingsDirFileCount as number;
  if (diagnostics.settingsDirExists && fileCount < 5) {
    return {
      id,
      name,
      status: 'warn',
      message: `System files directory seems incomplete (${fileCount} files)`,
      details: diagnostics,
      remediation: 'Restart the app to re-sync system files',
    };
  }

  const version = (diagnostics.versionFileContent as { version?: string })?.version ?? 'unknown';
  return {
    id,
    name,
    status: 'pass',
    message: `Synced successfully (v${version})`,
    details: diagnostics,
  };
}
