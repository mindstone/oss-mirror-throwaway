/**
 * Permissions Health Checks
 */

import { getElectronModule } from '@core/lazyElectron';
import { getTeamsUrlPermissionStatus } from '../../meetingBot/desktopSdkService';
import type { AppSettings } from '@shared/types';
import type { CheckResult } from '../types';

export function checkMicrophonePermission(): CheckResult {
  const id = 'microphonePermission';
  const name = 'Microphone Access';

  if (process.platform !== 'darwin') {
    return {
      id,
      name,
      status: 'pass',
      message: 'Not required on this platform',
    };
  }

  try {
    const systemPreferences = getElectronModule()?.systemPreferences;
    if (!systemPreferences) {
      return {
        id,
        name,
        status: 'pass',
        message: 'Not applicable in cloud context',
      };
    }
    const status = systemPreferences.getMediaAccessStatus('microphone');

    if (status === 'granted') {
      return {
        id,
        name,
        status: 'pass',
        message: 'Permission granted',
      };
    }

    if (status === 'denied') {
      return {
        id,
        name,
        status: 'fail',
        message: 'Permission denied',
        remediation: 'Grant microphone access in System Settings → Privacy & Security → Microphone',
      };
    }

    if (status === 'restricted') {
      return {
        id,
        name,
        status: 'fail',
        message: 'Permission restricted by system policy',
        remediation: 'Check with your system administrator about microphone access',
      };
    }

    return {
      id,
      name,
      status: 'warn',
      message: 'Permission not yet requested',
      remediation: 'Start a voice recording to trigger the permission prompt',
    };
  } catch {
    return {
      id,
      name,
      status: 'warn',
      message: 'Could not check permission status',
    };
  }
}

export function checkScreenRecordingPermission(): CheckResult {
  const id = 'screenRecordingPermission';
  const name = 'Screen Recording (Local Meeting Recording)';

  if (process.platform !== 'darwin') {
    return { id, name, status: 'pass', message: 'Not required on this platform' };
  }

  try {
    const systemPreferences = getElectronModule()?.systemPreferences;
    if (!systemPreferences) {
      return { id, name, status: 'pass', message: 'Not applicable in cloud context' };
    }
    const status = systemPreferences.getMediaAccessStatus('screen');

    if (status === 'granted') {
      return { id, name, status: 'pass', message: 'Permission granted' };
    }

    if (status === 'denied') {
      return {
        id,
        name,
        status: 'warn',
        message: 'Permission denied — local meeting recording will not work',
        remediation: 'Grant Screen Recording in System Settings → Privacy & Security → Screen Recording',
      };
    }

    if (status === 'restricted') {
      return {
        id,
        name,
        status: 'warn',
        message: 'Permission restricted by system policy',
        remediation: 'Check with your system administrator about Screen Recording access',
      };
    }

    // 'not-determined' — this is the expected state until the user records
    // locally for the first time. Rebel requests it on-demand at that point, so
    // this is not a problem to surface to the user.
    return {
      id,
      name,
      status: 'pass',
      message: 'Permission not yet requested (requested when you first record a meeting locally)',
    };
  } catch {
    return { id, name, status: 'warn', message: 'Could not check permission status' };
  }
}

export function checkWorkspacePathIssues(settings: AppSettings): CheckResult {
  const id = 'workspacePathIssues';
  const name = 'Workspace Path Quality';

  if (!settings.coreDirectory) {
    return {
      id,
      name,
      status: 'skip',
      message: 'Skipped - Library not configured',
    };
  }

  const workspacePath = settings.coreDirectory;
  const issues: string[] = [];

  if (/[()[\]{}]/.test(workspacePath)) {
    issues.push('contains special characters (parentheses, brackets)');
  }

  if (process.platform === 'win32' && workspacePath.length > 200) {
    issues.push(`path is very long (${workspacePath.length} chars) - may hit MAX_PATH limits`);
  }

  if (issues.length === 0) {
    return {
      id,
      name,
      status: 'pass',
      message: 'No path issues detected',
      details: { path: workspacePath },
    };
  }

  return {
    id,
    name,
    status: 'warn',
    message: `Path ${issues.join('; ')}`,
    details: { path: workspacePath, issues },
    remediation: 'Consider using a simpler path without spaces or special characters',
  };
}

export function checkFullDiskAccess(settings: AppSettings): CheckResult {
  const id = 'fullDiskAccess';
  const name = 'Full Disk Access (Teams URLs)';

  if (process.platform !== 'darwin') {
    return { id, name, status: 'skip', message: 'Not required on this platform' };
  }

  const joinMode = settings.meetingBot?.joinMode ?? 'prompt';
  if (joinMode !== 'auto' || settings.meetingBot?.enabled === false) {
    return { id, name, status: 'skip', message: 'Skipped — meeting bot auto-join not enabled' };
  }

  try {
    const fdaStatus = getTeamsUrlPermissionStatus();

    if (fdaStatus.granted) {
      return { id, name, status: 'pass', message: 'Full Disk Access granted — Teams URL extraction available' };
    }

    return {
      id,
      name,
      status: 'warn',
      message: 'Full Disk Access not granted — Teams and some Meet URLs may not be detected',
      details: { required: fdaStatus.required, granted: fdaStatus.granted },
      remediation: 'Grant Full Disk Access in System Settings → Privacy & Security → Full Disk Access, then restart the app',
    };
  } catch {
    return {
      id,
      name,
      status: 'warn',
      message: 'Could not check Full Disk Access status (Desktop SDK not initialized)',
    };
  }
}
