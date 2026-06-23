import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// --- Controllable dependency mocks -----------------------------------------

type ExecCallback = (error: Error | null) => void;
let execFileImpl: (file: string, args: string[], options: { signal?: AbortSignal }, cb: ExecCallback) => void;
let nativePresent: boolean;

vi.mock('node:child_process', () => ({
  execFile: (file: string, args: string[], options: { signal?: AbortSignal }, cb: ExecCallback) =>
    execFileImpl(file, args, options, cb),
}));

vi.mock('node:fs', () => ({
  // Both package.json and the native executable are treated as present/absent together.
  existsSync: () => nativePresent,
}));

const rmMock = vi.fn(async (..._args: unknown[]) => {});
vi.mock('node:fs/promises', () => ({ rm: (...args: unknown[]) => rmMock(...args) }));

const findRepoRootFromMock = vi.fn<(start: string | undefined) => string | null>();
const resolveDefaultNpmRunnerMock = vi.fn(async () => ({
  executable: '/bundle/bin/node',
  prefixArgs: ['/bundle/npm-cli.js'],
  description: 'test runner',
}));
vi.mock('../../managedMcpInstallService', () => ({
  findRepoRootFrom: (start: string | undefined) => findRepoRootFromMock(start),
  resolveDefaultNpmRunner: () => resolveDefaultNpmRunnerMock(),
}));

vi.mock('@core/platform', () => ({ getPlatformConfig: () => ({ appPath: '/repo' }) }));

const captureMessageMock = vi.fn();
vi.mock('@core/errorReporter', () => ({
  getErrorReporter: () => ({ captureMessage: captureMessageMock, captureException: vi.fn() }),
  setErrorReporter: vi.fn(),
}));

vi.mock('@core/logger', () => ({
  createScopedLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import {
  installRecorder,
  cancelRecorderInstall,
  isRecorderInstalling,
} from '../recorderInstaller';

const ORIGINAL_PLATFORM = process.platform;
function setPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value, configurable: true });
}

beforeEach(() => {
  setPlatform('darwin');
  nativePresent = false;
  findRepoRootFromMock.mockReturnValue('/repo');
  resolveDefaultNpmRunnerMock.mockResolvedValue({
    executable: '/bundle/bin/node',
    prefixArgs: ['/bundle/npm-cli.js'],
    description: 'test runner',
  });
  // Default: npm succeeds.
  execFileImpl = (_file, _args, _options, cb) => cb(null);
  rmMock.mockClear();
  captureMessageMock.mockClear();
});

afterEach(() => {
  setPlatform(ORIGINAL_PLATFORM);
  vi.clearAllMocks();
});

describe('installRecorder', () => {
  it('refuses unsupported platforms without running npm', async () => {
    setPlatform('linux');
    const execSpy = vi.fn((_f, _a, _o, cb: ExecCallback) => cb(null));
    execFileImpl = execSpy;

    const result = await installRecorder();

    expect(result).toEqual({
      success: false,
      unsupportedPlatform: true,
      error: expect.stringContaining('macOS and Windows'),
    });
    expect(execSpy).not.toHaveBeenCalled();
  });

  it('fails gracefully when no source checkout is found', async () => {
    findRepoRootFromMock.mockReturnValue(null);

    const result = await installRecorder();

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/install it yourself/i);
  });

  it('short-circuits when a usable recorder is already installed', async () => {
    nativePresent = true;
    const execSpy = vi.fn((_f, _a, _o, cb: ExecCallback) => cb(null));
    execFileImpl = execSpy;

    const result = await installRecorder();

    expect(result).toEqual({ success: true, alreadyInstalled: true });
    expect(execSpy).not.toHaveBeenCalled();
  });

  it('succeeds when npm exits 0 and the native binary is present', async () => {
    nativePresent = false; // not already installed
    execFileImpl = (_file, args, _options, cb) => {
      expect(args).toEqual(['/bundle/npm-cli.js', 'install', '--no-save', '@recallai/desktop-sdk@2.0.9']);
      nativePresent = true; // native artifact appears after install
      cb(null);
    };

    const result = await installRecorder();

    expect(result).toEqual({ success: true });
    expect(rmMock).not.toHaveBeenCalled();
  });

  it('reports failure and cleans up when npm exits 0 but the native binary is missing', async () => {
    nativePresent = false;
    execFileImpl = (_file, _args, _options, cb) => cb(null); // npm ok, but native never appears

    const result = await installRecorder();

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/download may have been interrupted/i);
    expect(rmMock).toHaveBeenCalledTimes(1);
    expect(captureMessageMock).toHaveBeenCalledTimes(1);
  });

  it('maps a permission error and cleans up when npm fails', async () => {
    const permErr = Object.assign(new Error('EACCES'), { code: 'EACCES' });
    execFileImpl = (_file, _args, _options, cb) => cb(permErr);

    const result = await installRecorder();

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/permission/i);
    expect(rmMock).toHaveBeenCalledTimes(1);
  });

  it('prepends the runner node dir to PATH so the lifecycle script finds node', async () => {
    let seenPath: string | undefined;
    execFileImpl = (_file, _args, options, cb) => {
      seenPath = (options as unknown as { env?: NodeJS.ProcessEnv }).env?.PATH;
      nativePresent = true;
      cb(null);
    };

    await installRecorder();

    expect(seenPath?.startsWith('/bundle/bin')).toBe(true);
  });
});

describe('cancelRecorderInstall / isRecorderInstalling', () => {
  it('aborts an in-flight install and resolves with a cancelled (error-free) result', async () => {
    // Hang until the AbortSignal fires. Mirror Node's execFile, which calls back
    // immediately when handed an already-aborted signal (cancel() fires while the
    // installer is still awaiting runner resolution, before execFile runs).
    execFileImpl = (_file, _args, options, cb) => {
      const abortError = Object.assign(new Error('aborted'), { code: 'ABORT_ERR' });
      if (options.signal?.aborted) {
        cb(abortError);
        return;
      }
      options.signal?.addEventListener('abort', () => cb(abortError));
    };

    const pending = installRecorder();
    expect(isRecorderInstalling()).toBe(true);

    expect(cancelRecorderInstall()).toBe(true);
    const result = await pending;

    expect(result.success).toBe(false);
    expect(result.cancelled).toBe(true); // explicit flag, not inferred from absent error
    expect(result.error).toBeUndefined(); // user-cancel is not an error to surface
    expect(rmMock).toHaveBeenCalledTimes(1); // partial install cleaned up
    expect(isRecorderInstalling()).toBe(false);
  });

  it('reports no in-flight install to cancel when idle', () => {
    expect(isRecorderInstalling()).toBe(false);
    expect(cancelRecorderInstall()).toBe(false);
  });
});
