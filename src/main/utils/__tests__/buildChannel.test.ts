/**
 * Unit tests for build channel detection utility.
 *
 * Tests the `getBuildChannel()` function which determines the release channel
 * (stable, beta, dev) based on the executable name and packaged state.
 *
 * @see src/main/utils/buildChannel.ts
 * @see docs/plans/finished/260106_fix-beta-versioning.md
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock @core/platform before importing the function
const mockPlatformConfig = {
  isPackaged: true,
  userDataPath: '/mock/userData',
  homePath: '/mock/home',
  tempPath: '/tmp',
  logsPath: '/mock/logs',
  documentsPath: '/mock/docs',
  desktopPath: '/mock/desktop',
  appDataPath: '/mock/appData',
  appPath: '/mock/app',
  version: '1.0.0',
  appName: 'Mindstone Rebel',
};

vi.mock('@core/platform', () => ({
  getPlatformConfig: () => mockPlatformConfig,
}));

// Import after mocking
import { getBuildChannel, type BuildChannel } from '../buildChannel';

describe('getBuildChannel', () => {
  // Store original execPath to restore after each test
  const originalExecPath = process.execPath;

  beforeEach(() => {
    // Reset to packaged mode for most tests
    mockPlatformConfig.isPackaged = true;
  });

  afterEach(() => {
    // Restore original execPath
    process.execPath = originalExecPath;
  });

  // =============================================================================
  // Dev mode tests
  // =============================================================================

  describe('dev mode (unpackaged)', () => {
    it('returns "dev" when app is not packaged', () => {
      mockPlatformConfig.isPackaged = false;
      process.execPath = '/usr/local/bin/electron';

      expect(getBuildChannel()).toBe('dev');
    });

    it('returns "dev" even with beta-like path in dev mode', () => {
      mockPlatformConfig.isPackaged = false;
      process.execPath = '/Users/alice/beta/node_modules/electron/dist/Electron';

      expect(getBuildChannel()).toBe('dev');
    });
  });

  // =============================================================================
  // macOS tests
  // =============================================================================

  describe('macOS executables', () => {
    it('returns "stable" for stable app', () => {
      process.execPath =
        '/Applications/Mindstone Rebel.app/Contents/MacOS/Mindstone Rebel';

      expect(getBuildChannel()).toBe('stable');
    });

    it('returns "beta" for beta app', () => {
      process.execPath =
        '/Applications/Mindstone Rebel Beta.app/Contents/MacOS/Mindstone Rebel Beta';

      expect(getBuildChannel()).toBe('beta');
    });

    it('returns "stable" for stable app installed in beta-named directory', () => {
      // This is the key test case that motivated using path.basename()
      process.execPath =
        '/Users/alice/beta-testing/Mindstone Rebel.app/Contents/MacOS/Mindstone Rebel';

      expect(getBuildChannel()).toBe('stable');
    });

    it('returns "beta" even when installed in differently-named directory', () => {
      process.execPath =
        '/Users/alice/apps/Mindstone Rebel Beta.app/Contents/MacOS/Mindstone Rebel Beta';

      expect(getBuildChannel()).toBe('beta');
    });
  });

  // =============================================================================
  // Windows tests
  // =============================================================================

  describe('Windows executables', () => {
    it('returns "stable" for stable app', () => {
      process.execPath =
        'C:\\Users\\alice\\AppData\\Local\\mindstone-rebel\\Mindstone Rebel.exe';

      expect(getBuildChannel()).toBe('stable');
    });

    it('returns "beta" for beta app', () => {
      process.execPath =
        'C:\\Users\\alice\\AppData\\Local\\mindstone-rebel-beta\\Mindstone Rebel Beta.exe';

      expect(getBuildChannel()).toBe('beta');
    });

    it('returns "stable" for stable app in beta-named directory', () => {
      // Windows version of the false-positive test
      process.execPath =
        'C:\\Users\\alice\\beta\\Mindstone Rebel.exe';

      expect(getBuildChannel()).toBe('stable');
    });
  });

  // =============================================================================
  // Linux tests
  // =============================================================================

  describe('Linux executables', () => {
    it('returns "stable" for stable app', () => {
      process.execPath = '/opt/Mindstone Rebel/mindstone-rebel';

      expect(getBuildChannel()).toBe('stable');
    });

    it('returns "beta" for beta app', () => {
      process.execPath = '/opt/Mindstone Rebel Beta/mindstone-rebel-beta';

      expect(getBuildChannel()).toBe('beta');
    });

    it('returns "stable" for stable app in beta-named directory', () => {
      process.execPath = '/home/alice/beta/mindstone-rebel';

      expect(getBuildChannel()).toBe('stable');
    });
  });

  // =============================================================================
  // Case sensitivity tests
  // =============================================================================

  describe('case sensitivity', () => {
    it('handles uppercase BETA in executable name', () => {
      process.execPath = '/Applications/Mindstone Rebel BETA.app/Contents/MacOS/Mindstone Rebel BETA';

      expect(getBuildChannel()).toBe('beta');
    });

    it('handles mixed case Beta in executable name', () => {
      process.execPath = '/Applications/Mindstone Rebel Beta.app/Contents/MacOS/Mindstone Rebel Beta';

      expect(getBuildChannel()).toBe('beta');
    });
  });

  // =============================================================================
  // Type safety
  // =============================================================================

  describe('type safety', () => {
    it('returns a valid BuildChannel type', () => {
      const validChannels: BuildChannel[] = ['stable', 'beta', 'dev'];
      const result = getBuildChannel();

      expect(validChannels).toContain(result);
    });
  });
});
