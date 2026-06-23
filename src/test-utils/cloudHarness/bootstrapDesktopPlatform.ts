import os from 'node:os';
import path from 'node:path';
import { getPlatformConfig, setPlatformConfig } from '@core/platform';
import { setStoreFactory } from '@core/storeFactory';
import { TestMemoryStore } from '@core/__tests__/TestMemoryStore';
import { ignoreBestEffortCleanup } from '@shared/utils/intentionalSwallow';

/**
 * Initialize a `desktop`-surface PlatformConfig for STANDALONE (non-Vitest) harness
 * contexts — the interactive CLI spike and the smoke script run via `node --import tsx`,
 * which (unlike Vitest) never loads `vitest.setup.ts`, so core modules that call
 * `getPlatformConfig()` (logger → `getDataPath()`, `CloudServiceClient`'s client-id store,
 * etc.) throw "PlatformConfig not initialized" the moment the real desktop sync code is
 * imported. This is a harness-bootstrap requirement, NOT a production gap — the real app
 * and the Vitest suite each initialize platform config at startup.
 *
 * Idempotent: if platform config is already initialized (e.g. running inside Vitest where
 * `vitest.setup.ts` set it), this is a no-op so it never clobbers the test config.
 */
let bootstrapped = false;

export function bootstrapDesktopPlatform(opts?: { userDataPath?: string }): void {
  if (bootstrapped) return;
  try {
    getPlatformConfig();
    bootstrapped = true;
    return; // already initialized (Vitest, or a prior call)
  } catch (err) {
    // Expected when running standalone (non-Vitest): platform config is not set yet, so we set it below.
    ignoreBestEffortCleanup(err, {
      operation: 'cloudHarness.bootstrapDesktopPlatform.probe',
      reason: 'platform-config-not-yet-initialized-standalone',
      severity: 'debug',
      owner: 'test-utils.cloudHarness',
    });
  }

  const base = opts?.userDataPath ?? path.join(os.tmpdir(), 'rebel-cloud-harness-platform');
  setPlatformConfig({
    userDataPath: base,
    appPath: process.cwd(),
    tempPath: os.tmpdir(),
    logsPath: path.join(base, 'logs'),
    homePath: os.homedir(),
    documentsPath: path.join(os.homedir(), 'Documents'),
    desktopPath: path.join(os.homedir(), 'Desktop'),
    appDataPath: base,
    version: '0.0.0-harness',
    isPackaged: false,
    platform: process.platform,
    totalMemoryBytes: os.totalmem(),
    arch: process.arch,
    surface: 'desktop',
    isOss: false,
  });

  // In-memory stores (same SSOT as vitest.setup.ts) so store-backed helpers
  // (driveAwareSyncNoticeStore, the client-id store, etc.) work instead of
  // noisily degrading to a swallowed "StoreFactory not initialized" fallback.
  setStoreFactory((opts) => new TestMemoryStore(opts) as never);

  bootstrapped = true;
}
