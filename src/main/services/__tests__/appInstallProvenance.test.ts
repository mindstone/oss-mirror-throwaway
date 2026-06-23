/**
 * Unit coverage for the shared install-provenance resolver — now used by BOTH
 * install-hygiene suppressions, so it gets direct tests (not just indirect
 * coverage via the service tests).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  exePath: '',
  realpath: vi.fn<(p: string) => Promise<string>>((p) => Promise.resolve(p)),
}));

vi.mock('electron', () => ({
  app: { getPath: (n: string) => (n === 'exe' ? mocks.exePath : ''), commandLine: { hasSwitch: () => false } },
}));
vi.mock('node:fs/promises', () => ({ default: { realpath: (p: string) => mocks.realpath(p) } }));
vi.mock('@core/logger', () => ({ createScopedLogger: () => ({ info: vi.fn(), warn: vi.fn() }) }));
vi.mock('@shared/utils/intentionalSwallow', () => ({ ignoreBestEffortCleanup: vi.fn() }));

import { resolveRunningAppBundlePath, isRunningFromLocalForgeBuild } from '../appInstallProvenance';

const originalPlatform = process.platform;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.realpath.mockImplementation((p) => Promise.resolve(p));
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
});
afterEach(() => {
  Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
});

describe('resolveRunningAppBundlePath', () => {
  it('resolves the .app bundle from the executable path', async () => {
    mocks.exePath = '/Applications/Mindstone Rebel.app/Contents/MacOS/Mindstone Rebel';
    expect(await resolveRunningAppBundlePath()).toBe('/Applications/Mindstone Rebel.app');
  });

  it('falls back to the raw exe path when realpath throws (best-effort)', async () => {
    mocks.exePath = '/Applications/Mindstone Rebel.app/Contents/MacOS/Mindstone Rebel';
    mocks.realpath.mockRejectedValue(new Error('EACCES'));
    expect(await resolveRunningAppBundlePath()).toBe('/Applications/Mindstone Rebel.app');
  });

  it('returns null for a path with no .app bundle', async () => {
    mocks.exePath = '/usr/local/bin/some-binary';
    expect(await resolveRunningAppBundlePath()).toBeNull();
  });
});

describe('isRunningFromLocalForgeBuild', () => {
  it('is true for a build running from the forge out/ tree', async () => {
    mocks.exePath = `/Users/dev/rebel-app/out/Mindstone Rebel-darwin-${process.arch}/Mindstone Rebel.app/Contents/MacOS/Mindstone Rebel`;
    expect(await isRunningFromLocalForgeBuild()).toBe(true);
  });

  it('is false for a real /Applications install', async () => {
    mocks.exePath = '/Applications/Mindstone Rebel.app/Contents/MacOS/Mindstone Rebel';
    expect(await isRunningFromLocalForgeBuild()).toBe(false);
  });

  it('fails CLOSED (false) when bundle resolution is impossible', async () => {
    mocks.exePath = '/usr/local/bin/some-binary'; // resolves to null → not a dev build
    expect(await isRunningFromLocalForgeBuild()).toBe(false);
  });

  it('fails CLOSED (false) on a non-darwin platform', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    mocks.exePath = `/x/out/Mindstone Rebel-win32-${process.arch}/Mindstone Rebel.app/Contents/MacOS/x`;
    expect(await isRunningFromLocalForgeBuild()).toBe(false);
  });
});
