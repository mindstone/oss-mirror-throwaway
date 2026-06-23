/**
 * Guard test for the duplicate-bundle startup warning.
 *
 * `presentDuplicateBundleWarningIfNeeded` shows a parent-less native
 * `dialog.showMessageBox` → app-modal `[NSAlert runModal]` nested run-loop on
 * the shared Electron/Chromium main thread. That is the same dialog class that
 * deterministically wedged the chronic-E2E packaged-app launch (browser CDP
 * pump starved → Playwright never attaches). It must be skipped in automated /
 * test contexts, where there is no user to dismiss it. Dev/CI machines commonly
 * have multiple Rebel.app copies, so `duplicateCount > 0` is plausible there.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';
import type { AppInstallIntegrityResult } from '@core/services/diagnostics/appInstallIntegrity';

const mocks = vi.hoisted(() => ({
  whenReady: vi.fn<() => Promise<void>>(() => Promise.resolve()),
  showMessageBox: vi.fn<(opts: unknown) => Promise<{ response: number }>>(),
  openPath: vi.fn<(p: string) => Promise<string>>(() => Promise.resolve('')),
  dataDir: '',
}));

vi.mock('electron', () => ({
  app: {
    whenReady: () => mocks.whenReady(),
    getPath: () => '',
    commandLine: { hasSwitch: () => false },
  },
  dialog: { showMessageBox: (opts: unknown) => mocks.showMessageBox(opts) },
  shell: { openPath: (p: string) => mocks.openPath(p) },
}));
vi.mock('@core/logger', () => ({ createScopedLogger: () => ({ info: vi.fn(), warn: vi.fn() }) }));
vi.mock('@core/errorReporter', () => ({ getErrorReporter: () => ({ addBreadcrumb: vi.fn() }), setErrorReporter: vi.fn() }));
vi.mock('@core/utils/dataPaths', () => ({ getDataPath: () => mocks.dataDir }));

import { presentDuplicateBundleWarningIfNeeded } from '../appInstallIntegrityService';

const originalPlatform = process.platform;

const dupResult: AppInstallIntegrityResult = {
  runningBundlePath: '/Applications/Mindstone Rebel.app',
  runningBundleId: 'com.mindstone.rebel',
  isTranslocated: false,
  duplicateBundlePaths: ['/Users/x/Downloads/Mindstone Rebel.app'],
  duplicateCount: 1,
  status: 'duplicate' as AppInstallIntegrityResult['status'],
};

beforeEach(async () => {
  vi.clearAllMocks();
  vi.stubEnv('REBEL_TEST_MODE', '');
  vi.stubEnv('REBEL_E2E_TEST_MODE', '');
  vi.stubEnv('REBEL_TEST_USER_DATA_DIR', '');
  mocks.whenReady.mockResolvedValue(undefined);
  mocks.showMessageBox.mockResolvedValue({ response: 1 }); // "Not now"
  mocks.dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'integrity-guard-'));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await fsp.rm(mocks.dataDir, { recursive: true, force: true });
});

describe('presentDuplicateBundleWarningIfNeeded — test-mode dialog guard', () => {
  it('not in test mode + real duplicate → shows the modal (control)', async () => {
    await presentDuplicateBundleWarningIfNeeded(dupResult);
    expect(mocks.showMessageBox).toHaveBeenCalledTimes(1);
  });

  it('REBEL_TEST_MODE=1 (would otherwise warn) → never shows the modal', async () => {
    vi.stubEnv('REBEL_TEST_MODE', '1');
    await presentDuplicateBundleWarningIfNeeded(dupResult);
    expect(mocks.showMessageBox).not.toHaveBeenCalled();
    // Load-bearing: suppression happens BEFORE app.whenReady() (the proven
    // pre-whenReady early-return that keeps the automated boot from wedging).
    expect(mocks.whenReady).not.toHaveBeenCalled();
  });

  it('REBEL_E2E_TEST_MODE=1 + isolated userData (would otherwise warn) → never shows the modal', async () => {
    vi.stubEnv('REBEL_E2E_TEST_MODE', '1');
    vi.stubEnv('REBEL_TEST_USER_DATA_DIR', '/tmp/rebel-e2e-isolated');
    await presentDuplicateBundleWarningIfNeeded(dupResult);
    expect(mocks.showMessageBox).not.toHaveBeenCalled();
  });

  it('raw REBEL_E2E_TEST_MODE=1 WITHOUT isolated userData → still never shows the modal', async () => {
    // The upgraded guard uses the broader isAutomatedOrHeadlessContext() (raw env),
    // so a launch that set the E2E flag but not the user-data dir is still suppressed.
    vi.stubEnv('REBEL_E2E_TEST_MODE', '1');
    await presentDuplicateBundleWarningIfNeeded(dupResult);
    expect(mocks.showMessageBox).not.toHaveBeenCalled();
  });
});

describe('presentDuplicateBundleWarningIfNeeded — local dev-build (package:run) guard', () => {
  // The dev-build skip keys on the running bundle being in the forge out/ tree;
  // isForgeOutDirBundlePath is darwin-gated, so stub the platform for determinism.
  beforeEach(() => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
  });
  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
  });

  it('running from the forge out/ tree → never shows the modal (dev not nagged)', async () => {
    const forgeOut: AppInstallIntegrityResult = {
      ...dupResult,
      // Build with the running arch so it matches forge's convention on any host.
      runningBundlePath: `/Users/dev/rebel-app/out/Mindstone Rebel-darwin-${process.arch}/Mindstone Rebel.app`,
    };
    await presentDuplicateBundleWarningIfNeeded(forgeOut);
    expect(mocks.showMessageBox).not.toHaveBeenCalled();
  });

  it('running from /Applications (real install) → still shows the modal', async () => {
    await presentDuplicateBundleWarningIfNeeded(dupResult); // runningBundlePath = /Applications/...
    expect(mocks.showMessageBox).toHaveBeenCalledTimes(1);
  });
});
