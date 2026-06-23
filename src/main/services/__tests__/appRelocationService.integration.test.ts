/**
 * Integration smoke test for the app-relocation flow.
 *
 * Exercises the REAL `maybeOfferMoveToApplications` control flow end-to-end
 * against a mocked Electron (`app`/`dialog`/`shell`) and a throwaway temp data
 * dir. Nothing real is touched: no packaged app runs, `moveToApplicationsFolder`
 * is a spy (never moves a real bundle), and the opt-out marker is written to a
 * per-test tmp dir. This covers the orchestration that the pure-helper unit
 * tests can't (decision → dialog → move + conflict handler → opt-out persistence).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';

// A non-forge exe path so isRunningFromLocalForgeBuild() is false by default
// (existing dialog-path cases behave as before). The forge-out case overrides it.
const NON_FORGE_EXE =
  '/Applications/Mindstone Rebel.app/Contents/MacOS/Mindstone Rebel';

const mocks = vi.hoisted(() => ({
  isPackaged: true,
  isInApplicationsFolder: vi.fn<() => boolean>(() => false),
  moveToApplicationsFolder: vi.fn<(opts: unknown) => boolean>(() => true),
  whenReady: vi.fn<() => Promise<void>>(() => Promise.resolve()),
  showMessageBox: vi.fn<(opts: unknown) => Promise<{ response: number; checkboxChecked: boolean }>>(),
  openPath: vi.fn<(p: string) => Promise<string>>(() => Promise.resolve('')),
  addBreadcrumb: vi.fn(),
  dataDir: '',
  exePath: '',
}));

vi.mock('electron', () => ({
  app: {
    get isPackaged() {
      return mocks.isPackaged;
    },
    isInApplicationsFolder: () => mocks.isInApplicationsFolder(),
    moveToApplicationsFolder: (opts: unknown) => mocks.moveToApplicationsFolder(opts),
    whenReady: () => mocks.whenReady(),
    getVersion: () => '1.0.0',
    getPath: (name: string) => (name === 'exe' ? mocks.exePath : ''),
    commandLine: { hasSwitch: () => false },
  },
  dialog: { showMessageBox: (opts: unknown) => mocks.showMessageBox(opts) },
  shell: { openPath: (p: string) => mocks.openPath(p) },
}));
vi.mock('@core/logger', () => ({ createScopedLogger: () => ({ info: vi.fn(), warn: vi.fn() }) }));
vi.mock('@core/errorReporter', () => ({
  getErrorReporter: () => ({ addBreadcrumb: mocks.addBreadcrumb }),
  setErrorReporter: vi.fn(),
}));
vi.mock('@core/utils/dataPaths', () => ({ getDataPath: () => mocks.dataDir }));
vi.mock('@shared/utils/intentionalSwallow', () => ({ ignoreBestEffortCleanup: vi.fn() }));

import { maybeOfferMoveToApplications } from '../appRelocationService';

const originalPlatform = process.platform;

beforeEach(async () => {
  vi.clearAllMocks();
  // The dialog-path tests below assume we are NOT in test mode. Pin the
  // test-mode env OFF so they are deterministic regardless of how the suite
  // was launched (the guard added for the chronic-E2E launch-hang fix skips
  // the offer entirely when REBEL_TEST_MODE / REBEL_E2E_TEST_MODE is set).
  vi.stubEnv('REBEL_TEST_MODE', '');
  vi.stubEnv('REBEL_E2E_TEST_MODE', '');
  vi.stubEnv('REBEL_TEST_USER_DATA_DIR', '');
  vi.stubEnv('REBEL_HEADLESS_CLI', '');
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
  mocks.isPackaged = true;
  mocks.isInApplicationsFolder.mockReturnValue(false);
  mocks.moveToApplicationsFolder.mockReturnValue(true);
  mocks.whenReady.mockResolvedValue(undefined);
  mocks.showMessageBox.mockResolvedValue({ response: 0, checkboxChecked: false });
  mocks.openPath.mockResolvedValue('');
  mocks.exePath = NON_FORGE_EXE;
  mocks.dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'reloc-smoke-'));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
  await fsp.rm(mocks.dataDir, { recursive: true, force: true });
});

const optOutFile = () => path.join(mocks.dataDir, 'app-relocation-opted-out.json');
async function optOutExists(): Promise<boolean> {
  try {
    await fsp.access(optOutFile());
    return true;
  } catch {
    return false;
  }
}

describe('maybeOfferMoveToApplications (integration smoke)', () => {
  it('outside /Applications + accept → prompts and moves with a correct conflict handler', async () => {
    await maybeOfferMoveToApplications();

    expect(mocks.showMessageBox).toHaveBeenCalledTimes(1);
    const dialogArg = mocks.showMessageBox.mock.calls[0][0] as {
      title: string;
      checkboxLabel?: string;
      buttons: string[];
    };
    expect(dialogArg.title).toMatch(/Move Rebel to your Applications folder/);
    expect(dialogArg.checkboxLabel).toBe("Don't ask again");
    expect(dialogArg.buttons[0]).toBe('Move and Relaunch');

    expect(mocks.moveToApplicationsFolder).toHaveBeenCalledTimes(1);
    const moveOpts = mocks.moveToApplicationsFolder.mock.calls[0][0] as {
      conflictHandler: (t: 'exists' | 'existsAndRunning') => boolean;
    };
    // Consolidate a non-running duplicate; halt if the existing copy is running.
    expect(moveOpts.conflictHandler('exists')).toBe(true);
    expect(moveOpts.conflictHandler('existsAndRunning')).toBe(false);
  });

  it('already in /Applications → never prompts or moves', async () => {
    mocks.isInApplicationsFolder.mockReturnValue(true);
    await maybeOfferMoveToApplications();
    expect(mocks.showMessageBox).not.toHaveBeenCalled();
    expect(mocks.moveToApplicationsFolder).not.toHaveBeenCalled();
  });

  it('unpackaged dev bundle → never prompts or moves', async () => {
    mocks.isPackaged = false;
    await maybeOfferMoveToApplications();
    expect(mocks.showMessageBox).not.toHaveBeenCalled();
    expect(mocks.moveToApplicationsFolder).not.toHaveBeenCalled();
  });

  it('local dev build (package:run, running from forge out/) → never prompts or moves', async () => {
    // The packaged dev build runs from <repo>/out/<product>-darwin-<arch>/<product>.app
    // (always outside /Applications), so every other gate passes — only the
    // local-forge-build signal must suppress the per-launch relocation nag.
    mocks.exePath = `/Users/dev/rebel-app/out/Mindstone Rebel-darwin-${process.arch}/Mindstone Rebel.app/Contents/MacOS/Mindstone Rebel`;
    await maybeOfferMoveToApplications();
    expect(mocks.showMessageBox).not.toHaveBeenCalled();
    expect(mocks.moveToApplicationsFolder).not.toHaveBeenCalled();
  });

  it('non-macOS → no-op', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    await maybeOfferMoveToApplications();
    expect(mocks.showMessageBox).not.toHaveBeenCalled();
    expect(mocks.moveToApplicationsFolder).not.toHaveBeenCalled();
  });

  it('plain "Not Now" (no checkbox) → no move, no opt-out, re-offers next launch', async () => {
    mocks.showMessageBox.mockResolvedValue({ response: 1, checkboxChecked: false });
    await maybeOfferMoveToApplications();
    expect(mocks.moveToApplicationsFolder).not.toHaveBeenCalled();
    expect(await optOutExists()).toBe(false);

    // Not opted out → a later launch offers again.
    await maybeOfferMoveToApplications();
    expect(mocks.showMessageBox).toHaveBeenCalledTimes(2);
  });

  it('"Don\'t ask again" → persists opt-out and goes silent on later launches', async () => {
    mocks.showMessageBox.mockResolvedValue({ response: 1, checkboxChecked: true });
    await maybeOfferMoveToApplications();
    expect(await optOutExists()).toBe(true);

    await maybeOfferMoveToApplications();
    expect(mocks.showMessageBox).toHaveBeenCalledTimes(1); // not shown again
  });

  it('moveToApplicationsFolder returns false → records a breadcrumb and never throws', async () => {
    mocks.moveToApplicationsFolder.mockReturnValue(false);
    await expect(maybeOfferMoveToApplications()).resolves.toBeUndefined();
    expect(mocks.addBreadcrumb).toHaveBeenCalledTimes(1);
  });

  it('moveToApplicationsFolder throws (e.g. existsAndRunning) → swallowed, startup continues', async () => {
    mocks.moveToApplicationsFolder.mockImplementation(() => {
      throw new Error('The application is currently running.');
    });
    await expect(maybeOfferMoveToApplications()).resolves.toBeUndefined();
  });

  // Regression: the parent-less native dialog runs an APP-MODAL [NSAlert runModal]
  // nested run-loop on the shared Electron/Chromium main thread. Awaited at the top
  // of whenReady, it wedged the packaged-app launch under Playwright (chronic-E2E
  // publish gate hung at electron.launch). Test mode has no user to dismiss it, so
  // the offer must be skipped — exactly when the conditions would otherwise prompt.
  it('automation early-return happens BEFORE app.whenReady() (load-bearing ordering)', async () => {
    vi.stubEnv('REBEL_TEST_MODE', '1');
    await maybeOfferMoveToApplications();
    expect(mocks.whenReady).not.toHaveBeenCalled();
    expect(mocks.showMessageBox).not.toHaveBeenCalled();
  });

  it('REBEL_TEST_MODE=1 (would otherwise prompt) → never shows the modal', async () => {
    vi.stubEnv('REBEL_TEST_MODE', '1');
    await maybeOfferMoveToApplications();
    expect(mocks.showMessageBox).not.toHaveBeenCalled();
    expect(mocks.moveToApplicationsFolder).not.toHaveBeenCalled();
  });

  it('REBEL_E2E_TEST_MODE=1 + isolated userData (would otherwise prompt) → never shows the modal', async () => {
    vi.stubEnv('REBEL_E2E_TEST_MODE', '1');
    vi.stubEnv('REBEL_TEST_USER_DATA_DIR', '/tmp/rebel-e2e-isolated');
    await maybeOfferMoveToApplications();
    expect(mocks.showMessageBox).not.toHaveBeenCalled();
    expect(mocks.moveToApplicationsFolder).not.toHaveBeenCalled();
  });
});
