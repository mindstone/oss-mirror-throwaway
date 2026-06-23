import { describe, expect, it } from 'vitest';
import { defaultCapabilities, setPlatformConfig, type PlatformConfig, type PlatformSurface } from '@core/platform';
import { hasLocalFilesystemAccess } from '../agentTurnExecutor';

function buildPlatformConfig(surface: PlatformSurface, overrides?: Partial<PlatformConfig['capabilities']>): PlatformConfig {
  const capabilities = overrides
    ? { ...defaultCapabilities(surface), ...overrides }
    : defaultCapabilities(surface);
  return {
    userDataPath: '/tmp/has-local-filesystem-access-test',
    appPath: '/tmp/has-local-filesystem-access-test-app',
    tempPath: '/tmp',
    logsPath: '/tmp/has-local-filesystem-access-test/logs',
    homePath: '/tmp',
    documentsPath: '/tmp/Documents',
    desktopPath: '/tmp/Desktop',
    appDataPath: '/tmp/AppData',
    version: '0.0.0-test',
    isPackaged: false,
    platform: process.platform,
    totalMemoryBytes: 8 * 1024 * 1024 * 1024,
    arch: process.arch,
    surface,
    isOss: false,
    capabilities,
  };
}

describe('hasLocalFilesystemAccess', () => {
  it('returns true on desktop surface with default capabilities', () => {
    setPlatformConfig(buildPlatformConfig('desktop'));
    expect(hasLocalFilesystemAccess()).toBe(true);
  });

  it('returns false on cloud surface with default capabilities', () => {
    setPlatformConfig(buildPlatformConfig('cloud'));
    expect(hasLocalFilesystemAccess()).toBe(false);
  });

  it('returns true on cli surface with default capabilities', () => {
    setPlatformConfig(buildPlatformConfig('cli'));
    expect(hasLocalFilesystemAccess()).toBe(true);
  });

  it('returns false on mobile surface with default capabilities', () => {
    setPlatformConfig(buildPlatformConfig('mobile'));
    expect(hasLocalFilesystemAccess()).toBe(false);
  });

  it('honours capability override regardless of surface (desktop + override false)', () => {
    setPlatformConfig(buildPlatformConfig('desktop', { localFilesystemAccess: false }));
    expect(hasLocalFilesystemAccess()).toBe(false);
  });

  it('honours capability override regardless of surface (cloud + override true)', () => {
    setPlatformConfig(buildPlatformConfig('cloud', { localFilesystemAccess: true }));
    expect(hasLocalFilesystemAccess()).toBe(true);
  });
});
