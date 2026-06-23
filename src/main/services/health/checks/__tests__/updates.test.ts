/**
 * Unit tests for `checkAutoUpdateHealth`.
 *
 * Note (REBEL-53B): the previous `warn`-on-stuckInstall branch was removed
 * because the rearchitecture surfaces stuck installs through the
 * `UpdateAvailableToast` (driven by `recoveryAttempts`) rather than the
 * health check. The remaining tests confirm the surrounding branches still
 * work and that a stuckInstall record alone does NOT promote the health
 * check to warn — the toast is the user-visible signal.
 *
 * @see docs-private/investigations/260429_rebel_53b_stuck_install_false_positive.md
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@core/platform', () => ({
  getPlatformConfig: () => ({ isPackaged: true }),
}));

vi.mock('@main/utils/buildChannel', () => ({
  getBuildChannel: () => 'beta',
}));

vi.mock('@main/utils/nativeArch', () => ({
  getNativeArch: () => 'arm64',
}));

const stateMock = vi.hoisted(() => ({
  state: {
    lastCheckAt: null,
    lastCheckResult: null,
    lastCheckUrl: null,
    lastErrorAt: null,
    lastErrorMessage: null,
    lastDownloadedVersion: null,
    lastDownloadedAt: null,
    initSucceeded: true,
    appVersionAtLastEvent: null,
    watchdogLastRanAt: null,
    watchdogOldPidWaitSec: null,
    watchdogShipItWaitSec: null,
    watchdogAppAlreadyRunning: null,
    watchdogOpenFired: null,
    watchdogInstallFailedBundleVersionUnchanged: null,
    watchdogOnDiskVersion: null,
    stuckInstall: null as null | {
      updateKey: string;
      fromVersion: string;
      targetVersion: string;
      attemptedAt: number;
      platform: 'darwin' | 'win32' | 'linux';
      attemptCount: number;
      lastFailedAt: number;
    },
    pendingStuckInstallEvents: [],
  } as Record<string, unknown>,
}));

vi.mock('../../../autoUpdateStateStore', () => ({
  getAutoUpdateState: () => stateMock.state,
}));

import { checkAutoUpdateHealth } from '../updates';

describe('checkAutoUpdateHealth', () => {
  beforeEach(() => {
    stateMock.state = {
      ...stateMock.state,
      lastCheckAt: null,
      lastCheckResult: null,
      lastCheckUrl: null,
      lastErrorAt: null,
      lastErrorMessage: null,
      lastDownloadedVersion: null,
      lastDownloadedAt: null,
      initSucceeded: true,
      stuckInstall: null,
      pendingStuckInstallEvents: [],
    };
  });

  it('returns pass when nothing is wrong', () => {
    const result = checkAutoUpdateHealth();
    expect(result.status).toBe('pass');
    expect(result.message).toMatch(/Auto-updates enabled/);
  });

  it('returns pass when only stuckInstall is set (REBEL-53B: toast surfaces it, not health check)', () => {
    stateMock.state.stuckInstall = {
      updateKey: 'beta:darwin:arm64:0.4.34',
      fromVersion: '0.4.33',
      targetVersion: '0.4.34',
      attemptedAt: 1_700_000_000_000,
      platform: 'darwin',
      attemptCount: 2,
      lastFailedAt: 1_700_000_000_500,
    };
    const result = checkAutoUpdateHealth();
    expect(result.status).toBe('pass');
    expect(result.message).toMatch(/Auto-updates enabled/);
  });

  it('does not promote to warn on stuckInstall alone (no recent updater error)', () => {
    stateMock.state.lastErrorAt = null;
    stateMock.state.lastErrorMessage = null;
    stateMock.state.stuckInstall = {
      updateKey: 'beta:darwin:arm64:1.0.0',
      fromVersion: '0.9.0',
      targetVersion: '1.0.0',
      attemptedAt: 0,
      platform: 'darwin',
      attemptCount: 1,
      lastFailedAt: 0,
    };
    const result = checkAutoUpdateHealth();
    expect(result.status).toBe('pass');
  });

  it('still warns on initSucceeded=false (existing behaviour preserved)', () => {
    stateMock.state.initSucceeded = false;
    const result = checkAutoUpdateHealth();
    expect(result.status).toBe('warn');
    expect(result.message).toMatch(/failed to initialize/i);
  });
});
