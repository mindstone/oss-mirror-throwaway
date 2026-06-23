/**
 * Service-level coverage for `runAppInstallIntegrityCheck`'s Sentry gating: a
 * same-bundle-id duplicate must report to Sentry for a REAL install but must NOT
 * for a local developer build running from the forge `out/` tree (`package:run`),
 * while still persisting the diagnostic JSON in both cases. Drives the real scan
 * against a fully mocked filesystem + `plutil` (no real bundles touched).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  exePath: '',
  // plutil -convert json output; every bundle reports the same id so the
  // running app + the /Applications candidate are classified as duplicates.
  plistJson: JSON.stringify({
    CFBundleIdentifier: 'com.mindstone.rebel',
    CFBundleShortVersionString: '0.4.49',
  }),
  appsEntries: ['Other.app'] as string[],
  captureMessage: vi.fn(),
  addBreadcrumb: vi.fn(),
  writeFile: vi.fn<(...a: unknown[]) => Promise<void>>(() => Promise.resolve()),
}));

vi.mock('electron', () => ({
  app: { getPath: (n: string) => (n === 'exe' ? mocks.exePath : ''), whenReady: () => Promise.resolve() },
  dialog: { showMessageBox: vi.fn() },
  shell: { openPath: vi.fn() },
}));
vi.mock('node:child_process', async () => {
  const util = await import('node:util');
  // execFile is consumed via promisify(execFile); define the custom promisified
  // form so `const { stdout } = await execFileAsync(...)` resolves correctly.
  const execFile = Object.assign(() => undefined, {
    [util.promisify.custom]: async () => ({ stdout: mocks.plistJson, stderr: '' }),
  });
  return { execFile };
});
vi.mock('node:fs/promises', () => ({
  default: {
    realpath: (p: string) => Promise.resolve(p),
    readdir: (dir: string) =>
      dir === '/Applications' ? Promise.resolve(mocks.appsEntries) : Promise.reject(new Error('ENOENT')),
    writeFile: (...a: unknown[]) => mocks.writeFile(...a),
    rename: () => Promise.resolve(),
    readFile: () => Promise.reject(new Error('ENOENT')),
  },
}));
vi.mock('node:os', () => ({ default: { homedir: () => '/nonexistent-home' } }));
vi.mock('@core/logger', () => ({ createScopedLogger: () => ({ info: vi.fn(), warn: vi.fn() }) }));
vi.mock('@core/errorReporter', () => ({
  getErrorReporter: () => ({ addBreadcrumb: mocks.addBreadcrumb, captureMessage: mocks.captureMessage }),
  setErrorReporter: vi.fn(),
}));
vi.mock('@core/utils/dataPaths', () => ({ getDataPath: () => '/nonexistent-data' }));
vi.mock('@shared/utils/intentionalSwallow', () => ({ ignoreBestEffortCleanup: vi.fn() }));

import { runAppInstallIntegrityCheck } from '../appInstallIntegrityService';

const originalPlatform = process.platform;
const FORGE_EXE = `/Users/dev/rebel-app/out/Mindstone Rebel-darwin-${process.arch}/Mindstone Rebel.app/Contents/MacOS/Mindstone Rebel`;
const REAL_EXE = '/Applications/Mindstone Rebel.app/Contents/MacOS/Mindstone Rebel';

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
  mocks.appsEntries = ['Other.app'];
});

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
});

describe('runAppInstallIntegrityCheck — Sentry gating', () => {
  it('reports a duplicate to Sentry for a real /Applications install', async () => {
    mocks.exePath = REAL_EXE;
    const result = await runAppInstallIntegrityCheck();
    expect(result?.status).toBe('duplicates');
    expect(result?.duplicateCount).toBe(1);
    expect(mocks.captureMessage).toHaveBeenCalledTimes(1);
    // Diagnostic JSON is still persisted.
    expect(mocks.writeFile).toHaveBeenCalled();
  });

  it('does NOT report to Sentry for a local dev build (package:run) but still persists JSON', async () => {
    mocks.exePath = FORGE_EXE;
    const result = await runAppInstallIntegrityCheck();
    expect(result?.status).toBe('duplicates'); // detection still runs
    expect(result?.duplicateCount).toBe(1);
    expect(mocks.captureMessage).not.toHaveBeenCalled();
    expect(mocks.addBreadcrumb).not.toHaveBeenCalled();
    // Diagnostics retained.
    expect(mocks.writeFile).toHaveBeenCalled();
  });
});
