import type { PlatformConfig } from '../platform';
import { defaultCapabilities } from '../platform';
import { TestMemoryStore } from './TestMemoryStore';
import { buildSettings } from './builders';

const TEST_PLATFORM_CONFIG: PlatformConfig = {
  userDataPath: '/tmp/test-user-data',
  appPath: '/tmp/test-app',
  tempPath: '/tmp/test-temp',
  logsPath: '/tmp/test-logs',
  homePath: '/tmp/test-home',
  documentsPath: '/tmp/test-documents',
  desktopPath: '/tmp/test-desktop',
  appDataPath: '/tmp/test-appData',
  version: '0.0.0-test',
  isPackaged: false,
  platform: process.platform,
  totalMemoryBytes: 36 * 1024 * 1024 * 1024, // 36 GB
  arch: process.arch,
  surface: 'desktop',
  isOss: false,
  capabilities: defaultCapabilities('desktop'),
};

/**
 * Re-initialize all core boundary interfaces after vi.resetModules() clears singleton state.
 * Uses dynamic import to always target the current module cache instance.
 * Values match the global vitest.setup.ts configuration.
 *
 * @param overrides - Optional partial overrides for test-specific paths.
 */
export async function initTestPlatformConfig(
  overrides?: Partial<PlatformConfig>,
): Promise<void> {
  const { setPlatformConfig } = await import('../platform');
  setPlatformConfig({ ...TEST_PLATFORM_CONFIG, ...overrides });

  const { setStoreFactory } = await import('../storeFactory');
  setStoreFactory((opts) => new TestMemoryStore(opts) as any);

  const { setErrorReporter } = await import('../errorReporter');
  setErrorReporter({
    captureException: () => {},
    captureMessage: () => {},
    addBreadcrumb: () => {},
  });

  const { setTracker } = await import('../tracking');
  setTracker({ track: () => {}, identify: () => {}, getAnonymousId: () => '', isAvailable: () => false });

  const { setBroadcastService } = await import('../broadcastService');
  setBroadcastService({
    sendToAllWindows: () => {},
    sendToFocusedWindow: () => {},
  });

  const { setSettingsStoreAdapter } = await import('../services/settingsStore');
  setSettingsStoreAdapter({
    getSettings: () => buildSettings(),
    updateSettings: () => {},
    updateSettingsAtomic: () => {},
  });
}
