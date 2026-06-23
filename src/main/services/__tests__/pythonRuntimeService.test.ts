/**
 * Tests for pythonRuntimeService — focused on the macOS Command Line
 * Developer Tools (CLT) install-dialog hazard. The shim path
 * `/usr/bin/python3` triggers the OS install dialog when CLT is missing,
 * so the detection service MUST NOT execFile it in that state.
 *
 * See: docs-private/investigations/260521_macos_python3_clt_install_dialog.md
 */

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import nodePath from 'node:path';

// ---------------------------------------------------------------------------
// Hoisted mocks — must be declared before vi.mock factories
// ---------------------------------------------------------------------------

const { mockRunProbe, mockShellPath, mockExistsSync, mockRealpathNative, mockHomedir } =
  vi.hoisted(() => ({
    mockRunProbe: vi.fn(),
    mockShellPath: vi.fn(),
    mockExistsSync: vi.fn(),
    mockRealpathNative: vi.fn(),
    mockHomedir: vi.fn(),
  }));

vi.mock('../processProbe', () => ({
  runProbe: mockRunProbe,
}));

vi.mock('shell-path', () => ({
  shellPath: mockShellPath,
}));

vi.mock('@core/logger', () => ({
  createScopedLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
  }),
}));

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: mockExistsSync,
      realpathSync: Object.assign(
        (...args: unknown[]) =>
          (actual.realpathSync as unknown as (...a: unknown[]) => string)(...args),
        { native: mockRealpathNative },
      ),
    },
    existsSync: mockExistsSync,
    realpathSync: Object.assign(
      (...args: unknown[]) =>
        (actual.realpathSync as unknown as (...a: unknown[]) => string)(...args),
      { native: mockRealpathNative },
    ),
  };
});

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os');
  return {
    ...actual,
    default: { ...actual, homedir: mockHomedir },
    homedir: mockHomedir,
  };
});

// ---------------------------------------------------------------------------
// Helpers — platform override and runProbe matchers
// ---------------------------------------------------------------------------

const ORIGINAL_PLATFORM_DESCRIPTOR = Object.getOwnPropertyDescriptor(process, 'platform')!;

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', {
    configurable: true,
    enumerable: true,
    value: platform,
    writable: true,
  });
}

function restorePlatform(): void {
  Object.defineProperty(process, 'platform', ORIGINAL_PLATFORM_DESCRIPTOR);
}

interface ProbeCall {
  file: string;
  args: string[];
}

function probeCalls(mock: Mock): ProbeCall[] {
  return mock.mock.calls.map((call) => ({
    file: call[0] as string,
    args: (call[1] as string[]) ?? [],
  }));
}

function matchProbe(
  mock: Mock,
  predicate: (file: string, args: string[]) => boolean,
): ProbeCall | undefined {
  return probeCalls(mock).find((c) => predicate(c.file, c.args));
}

/**
 * Build a `runProbe` mock that dispatches by `(file, args)` to the supplied
 * handlers. Anything not matched returns ENOENT. This lets each test declare
 * only the handlers it cares about.
 */
type ProbeHandler = (
  args: string[],
) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

function buildRunProbe(handlers: Record<string, ProbeHandler>): Mock {
  return vi.fn(async (file: string, args: string[]) => {
    const handler = handlers[file];
    if (handler) {
      return handler(args);
    }
    // Default: simulate ENOENT (genuine spawn failure)
    const err = new Error(`spawn ${file} ENOENT`) as NodeJS.ErrnoException;
    err.code = 'ENOENT';
    throw err;
  });
}

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

let pythonRuntimeService: typeof import('../pythonRuntimeService');

beforeEach(async () => {
  vi.resetModules();
  mockRunProbe.mockReset();
  mockShellPath.mockReset();
  mockExistsSync.mockReset();
  mockRealpathNative.mockReset();
  mockHomedir.mockReset();

  mockShellPath.mockResolvedValue('/usr/bin:/bin');
  mockHomedir.mockReturnValue('/Users/testuser');
  // Default: mocked paths don't exist on disk (so realpath fallbacks fail safely)
  mockExistsSync.mockReturnValue(false);
  mockRealpathNative.mockImplementation((p: string) => p);

  pythonRuntimeService = await import('../pythonRuntimeService');
  pythonRuntimeService.clearPythonRuntimeCache();
});

afterEach(() => {
  restorePlatform();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('pythonRuntimeService — macOS CLT shim guard', () => {
  it('darwin + CLT missing + only /usr/bin/python3 in PATH: NEVER exec the shim', async () => {
    setPlatform('darwin');

    mockRunProbe.mockImplementation(
      buildRunProbe({
        '/usr/bin/xcode-select': async () => ({
          // CLT missing: xcode-select -p exits 2
          exitCode: 2,
          stdout: '',
          stderr: 'xcode-select: error: unable to get active developer directory',
        }),
        '/usr/bin/which': async (args) => {
          // -a flag, then cmd
          const cmd = args[args.length - 1];
          if (cmd === 'python3') {
            return { exitCode: 0, stdout: '/usr/bin/python3\n', stderr: '' };
          }
          if (cmd === 'python') {
            return { exitCode: 0, stdout: '/usr/bin/python\n', stderr: '' };
          }
          return { exitCode: 1, stdout: '', stderr: '' };
        },
      }),
    );

    const status = await pythonRuntimeService.checkPythonRuntime();

    expect(status.pythonAvailable).toBe(false);
    expect(status.pythonPath).toBeNull();

    // CRITICAL: no exec of the shim. Assert via mock that runProbe was NEVER
    // called with file 'python3', '/usr/bin/python3', 'python', or '/usr/bin/python'.
    const forbidden = ['python3', '/usr/bin/python3', 'python', '/usr/bin/python'];
    for (const f of forbidden) {
      const call = matchProbe(mockRunProbe, (file) => file === f);
      expect(call, `runProbe must NOT be invoked with file=${f}`).toBeUndefined();
    }

    // Sanity: we DID probe CLT and which.
    expect(
      matchProbe(mockRunProbe, (file) => file === '/usr/bin/xcode-select'),
    ).toBeDefined();
    expect(
      matchProbe(mockRunProbe, (file) => file === '/usr/bin/which'),
    ).toBeDefined();
  });

  it('darwin + CLT missing + which returns shim then Homebrew: skips shim, probes Homebrew', async () => {
    setPlatform('darwin');

    mockRunProbe.mockImplementation(
      buildRunProbe({
        '/usr/bin/xcode-select': async () => ({
          exitCode: 2,
          stdout: '',
          stderr: 'xcode-select: error: unable to get active developer directory',
        }),
        '/usr/bin/which': async (args) => {
          const cmd = args[args.length - 1];
          if (cmd === 'python3') {
            return {
              exitCode: 0,
              stdout: '/usr/bin/python3\n/opt/homebrew/bin/python3\n',
              stderr: '',
            };
          }
          return { exitCode: 1, stdout: '', stderr: '' };
        },
        '/opt/homebrew/bin/python3': async () => ({
          exitCode: 0,
          stdout: 'Python 3.12.4\n',
          stderr: '',
        }),
      }),
    );

    const status = await pythonRuntimeService.checkPythonRuntime();

    expect(status.pythonAvailable).toBe(true);
    expect(status.pythonPath).toBe('/opt/homebrew/bin/python3');
    expect(status.pythonVersion).toBe('3.12.4');

    // Shim must NOT have been exec'd.
    const forbidden = ['/usr/bin/python3', '/usr/bin/python', 'python3', 'python'];
    for (const f of forbidden) {
      const call = matchProbe(mockRunProbe, (file) => file === f);
      expect(call, `runProbe must NOT be invoked with file=${f}`).toBeUndefined();
    }

    // Homebrew binary WAS probed.
    expect(
      matchProbe(mockRunProbe, (file) => file === '/opt/homebrew/bin/python3'),
    ).toBeDefined();
  });

  it('darwin + CLT installed + which returns /usr/bin/python3: probes it, returns version', async () => {
    setPlatform('darwin');

    // CLT is installed: xcode-select -p returns a path that exists on disk.
    mockExistsSync.mockImplementation(
      (p: string) => p === '/Library/Developer/CommandLineTools',
    );

    mockRunProbe.mockImplementation(
      buildRunProbe({
        '/usr/bin/xcode-select': async () => ({
          exitCode: 0,
          stdout: '/Library/Developer/CommandLineTools\n',
          stderr: '',
        }),
        '/usr/bin/which': async (args) => {
          const cmd = args[args.length - 1];
          if (cmd === 'python3') {
            return { exitCode: 0, stdout: '/usr/bin/python3\n', stderr: '' };
          }
          return { exitCode: 1, stdout: '', stderr: '' };
        },
        '/usr/bin/python3': async () => ({
          exitCode: 0,
          stdout: 'Python 3.9.6\n',
          stderr: '',
        }),
      }),
    );

    const status = await pythonRuntimeService.checkPythonRuntime();

    expect(status.pythonAvailable).toBe(true);
    expect(status.pythonPath).toBe('/usr/bin/python3');
    expect(status.pythonVersion).toBe('3.9.6');

    expect(
      matchProbe(mockRunProbe, (file) => file === '/usr/bin/python3'),
    ).toBeDefined();
  });

  it('darwin + Homebrew shim symlinking to /usr/bin/python3: filtered via realpath', async () => {
    setPlatform('darwin');

    mockRunProbe.mockImplementation(
      buildRunProbe({
        '/usr/bin/xcode-select': async () => ({
          exitCode: 2,
          stdout: '',
          stderr: 'xcode-select: error: unable to get active developer directory',
        }),
        '/usr/bin/which': async (args) => {
          const cmd = args[args.length - 1];
          if (cmd === 'python3') {
            // A weirdly-configured shim path that realpaths back to /usr/bin/python3
            return {
              exitCode: 0,
              stdout: '/opt/homebrew/bin/python3\n',
              stderr: '',
            };
          }
          return { exitCode: 1, stdout: '', stderr: '' };
        },
      }),
    );

    mockRealpathNative.mockImplementation((p: string) => {
      if (p === '/opt/homebrew/bin/python3') return '/usr/bin/python3';
      return p;
    });

    const status = await pythonRuntimeService.checkPythonRuntime();

    expect(status.pythonAvailable).toBe(false);
    // We should NOT have invoked the realpath-resolved shim either.
    expect(
      matchProbe(mockRunProbe, (file) => file === '/opt/homebrew/bin/python3'),
    ).toBeUndefined();
    expect(
      matchProbe(mockRunProbe, (file) => file === '/usr/bin/python3'),
    ).toBeUndefined();
  });
});

describe('pythonRuntimeService — Linux behavior unchanged', () => {
  it('linux + which returns /usr/bin/python3: never calls xcode-select', async () => {
    setPlatform('linux');

    mockRunProbe.mockImplementation(
      buildRunProbe({
        python3: async () => ({ exitCode: 0, stdout: 'Python 3.11.5\n', stderr: '' }),
        which: async (args) => {
          const cmd = args[0];
          if (cmd === 'python3') {
            return { exitCode: 0, stdout: '/usr/bin/python3\n', stderr: '' };
          }
          return { exitCode: 1, stdout: '', stderr: '' };
        },
      }),
    );

    const status = await pythonRuntimeService.checkPythonRuntime();

    expect(status.pythonAvailable).toBe(true);
    expect(status.pythonPath).toBe('/usr/bin/python3');
    expect(status.pythonVersion).toBe('3.11.5');

    // Linux MUST NOT touch xcode-select.
    expect(
      matchProbe(mockRunProbe, (file) => file === '/usr/bin/xcode-select'),
    ).toBeUndefined();
  });
});

describe('pythonRuntimeService — Windows alias-filter still works', () => {
  it('win32 calls py -0p first and never invokes bare python3', async () => {
    setPlatform('win32');

    mockRunProbe.mockImplementation(
      buildRunProbe({
        py: async (args) => {
          if (args[0] === '-0p') {
            return {
              exitCode: 0,
              stdout: ' -V:3.12 *        C:\\Python312\\python.exe\n',
              stderr: '',
            };
          }
          return { exitCode: 1, stdout: '', stderr: '' };
        },
        'C:\\Python312\\python.exe': async () => ({
          exitCode: 0,
          stdout: 'Python 3.12.4\n',
          stderr: '',
        }),
      }),
    );

    const status = await pythonRuntimeService.checkPythonRuntime();

    expect(status.pythonAvailable).toBe(true);
    expect(status.pythonPath).toBe('C:\\Python312\\python.exe');

    // win32 MUST NOT invoke bare 'python3' (Microsoft Store stub trigger).
    expect(matchProbe(mockRunProbe, (file) => file === 'python3')).toBeUndefined();

    // py.exe was tried first.
    const pyCall = matchProbe(
      mockRunProbe,
      (file, args) => file === 'py' && args[0] === '-0p',
    );
    expect(pyCall).toBeDefined();
  });
});

describe('pythonRuntimeService — macosCommandResolvesToCltShim', () => {
  it('darwin + CLT missing + first hit /usr/bin/python3: shim_blocked, NEVER exec the shim', async () => {
    setPlatform('darwin');

    mockRunProbe.mockImplementation(
      buildRunProbe({
        '/usr/bin/xcode-select': async () => ({
          exitCode: 2,
          stdout: '',
          stderr: 'xcode-select: error: unable to get active developer directory',
        }),
        '/usr/bin/which': async (args) => {
          const cmd = args[args.length - 1];
          if (cmd === 'python3') {
            return { exitCode: 0, stdout: '/usr/bin/python3\n', stderr: '' };
          }
          return { exitCode: 1, stdout: '', stderr: '' };
        },
      }),
    );

    const result = await pythonRuntimeService.macosCommandResolvesToCltShim(
      'python3',
      '/usr/bin:/bin',
    );

    expect(result).toBe('shim_blocked');

    // CRITICAL: the shim itself must NEVER be exec'd — only `which` lookups.
    const forbidden = ['python3', '/usr/bin/python3', 'python', '/usr/bin/python'];
    for (const f of forbidden) {
      const call = matchProbe(mockRunProbe, (file) => file === f);
      expect(call, `runProbe must NOT be invoked with file=${f}`).toBeUndefined();
    }
    // which WAS used to resolve.
    expect(
      matchProbe(mockRunProbe, (file) => file === '/usr/bin/which'),
    ).toBeDefined();
  });

  it('darwin + CLT installed + first hit /usr/bin/python3: safe (shim runs real Python)', async () => {
    setPlatform('darwin');
    mockExistsSync.mockImplementation(
      (p: string) => p === '/Library/Developer/CommandLineTools',
    );

    mockRunProbe.mockImplementation(
      buildRunProbe({
        '/usr/bin/xcode-select': async () => ({
          exitCode: 0,
          stdout: '/Library/Developer/CommandLineTools\n',
          stderr: '',
        }),
        '/usr/bin/which': async (args) => {
          const cmd = args[args.length - 1];
          if (cmd === 'python3') {
            return { exitCode: 0, stdout: '/usr/bin/python3\n', stderr: '' };
          }
          return { exitCode: 1, stdout: '', stderr: '' };
        },
      }),
    );

    const result = await pythonRuntimeService.macosCommandResolvesToCltShim(
      'python3',
      '/usr/bin:/bin',
    );

    expect(result).toBe('safe');
  });

  it('darwin + first hit /opt/homebrew/bin/python3 (CLT missing): safe (real python ahead of shim)', async () => {
    setPlatform('darwin');

    mockRunProbe.mockImplementation(
      buildRunProbe({
        '/usr/bin/xcode-select': async () => ({
          exitCode: 2,
          stdout: '',
          stderr: '',
        }),
        '/usr/bin/which': async (args) => {
          const cmd = args[args.length - 1];
          if (cmd === 'python3') {
            return {
              exitCode: 0,
              stdout: '/opt/homebrew/bin/python3\n/usr/bin/python3\n',
              stderr: '',
            };
          }
          return { exitCode: 1, stdout: '', stderr: '' };
        },
      }),
    );

    const result = await pythonRuntimeService.macosCommandResolvesToCltShim(
      'python3',
      '/opt/homebrew/bin:/usr/bin',
    );

    expect(result).toBe('safe');
  });

  it('darwin + which finds nothing: not_found', async () => {
    setPlatform('darwin');

    mockRunProbe.mockImplementation(
      buildRunProbe({
        '/usr/bin/which': async () => ({ exitCode: 1, stdout: '', stderr: '' }),
      }),
    );

    const result = await pythonRuntimeService.macosCommandResolvesToCltShim(
      'python3',
      '/usr/bin:/bin',
    );

    expect(result).toBe('not_found');
    // CLT need not even be probed when nothing resolves.
  });

  it('non-darwin: not_applicable (no resolution attempted)', async () => {
    setPlatform('linux');

    mockRunProbe.mockImplementation(buildRunProbe({}));

    const result = await pythonRuntimeService.macosCommandResolvesToCltShim(
      'python3',
      '/usr/bin:/bin',
    );

    expect(result).toBe('not_applicable');
    // Off-darwin: do not even shell out.
    expect(mockRunProbe).not.toHaveBeenCalled();
  });

  it('compatibility wrapper preserves python behavior', async () => {
    setPlatform('darwin');

    mockRunProbe.mockImplementation(
      buildRunProbe({
        '/usr/bin/xcode-select': async () => ({
          exitCode: 2,
          stdout: '',
          stderr: '',
        }),
        '/usr/bin/which': async (args) => {
          const cmd = args[args.length - 1];
          if (cmd === 'python3') {
            return { exitCode: 0, stdout: '/usr/bin/python3\n', stderr: '' };
          }
          return { exitCode: 1, stdout: '', stderr: '' };
        },
      }),
    );

    await expect(
      pythonRuntimeService.macosCommandResolvesToPythonShim('python3', '/usr/bin:/bin'),
    ).resolves.toBe('shim_blocked');
  });

  it.each(['git', 'make', 'swift'] as const)(
    'darwin + CLT missing + first hit /usr/bin/%s: shim_blocked',
    async (cmd) => {
      setPlatform('darwin');

      mockRunProbe.mockImplementation(
        buildRunProbe({
          '/usr/bin/xcode-select': async () => ({
            exitCode: 2,
            stdout: '',
            stderr: 'xcode-select: error: unable to get active developer directory',
          }),
          '/usr/bin/which': async (args) => {
            const resolvedCmd = args[args.length - 1];
            if (resolvedCmd === cmd) {
              return { exitCode: 0, stdout: `/usr/bin/${cmd}\n`, stderr: '' };
            }
            return { exitCode: 1, stdout: '', stderr: '' };
          },
        }),
      );

      await expect(
        pythonRuntimeService.macosCommandResolvesToCltShim(cmd, '/usr/bin:/bin'),
      ).resolves.toBe('shim_blocked');

      expect(
        matchProbe(mockRunProbe, (file) => file === cmd || file === `/usr/bin/${cmd}`),
        `runProbe must NOT be invoked with file=${cmd} or /usr/bin/${cmd}`,
      ).toBeUndefined();
    },
  );

  it.each(['git', 'make', 'swift'] as const)(
    'darwin + CLT present + first hit /usr/bin/%s: safe',
    async (cmd) => {
      setPlatform('darwin');
      mockExistsSync.mockImplementation(
        (p: string) => p === '/Library/Developer/CommandLineTools',
      );

      mockRunProbe.mockImplementation(
        buildRunProbe({
          '/usr/bin/xcode-select': async () => ({
            exitCode: 0,
            stdout: '/Library/Developer/CommandLineTools\n',
            stderr: '',
          }),
          '/usr/bin/which': async (args) => {
            const resolvedCmd = args[args.length - 1];
            if (resolvedCmd === cmd) {
              return { exitCode: 0, stdout: `/usr/bin/${cmd}\n`, stderr: '' };
            }
            return { exitCode: 1, stdout: '', stderr: '' };
          },
        }),
      );

      await expect(
        pythonRuntimeService.macosCommandResolvesToCltShim(cmd, '/usr/bin:/bin'),
      ).resolves.toBe('safe');
    },
  );

  it.each(['git', 'make', 'swift'] as const)(
    'darwin + safe binary before shim for %s: safe without probing CLT state',
    async (cmd) => {
      setPlatform('darwin');

      mockRunProbe.mockImplementation(
        buildRunProbe({
          '/usr/bin/which': async (args) => {
            const resolvedCmd = args[args.length - 1];
            if (resolvedCmd === cmd) {
              return {
                exitCode: 0,
                stdout: `/opt/homebrew/bin/${cmd}\n/usr/bin/${cmd}\n`,
                stderr: '',
              };
            }
            return { exitCode: 1, stdout: '', stderr: '' };
          },
        }),
      );

      await expect(
        pythonRuntimeService.macosCommandResolvesToCltShim(
          cmd,
          '/opt/homebrew/bin:/usr/bin',
        ),
      ).resolves.toBe('safe');
      expect(matchProbe(mockRunProbe, (file) => file === '/usr/bin/xcode-select')).toBeUndefined();
    },
  );

  it.each(['git', 'make', 'swift'] as const)(
    'darwin + %s not found: not_found',
    async (cmd) => {
      setPlatform('darwin');

      mockRunProbe.mockImplementation(
        buildRunProbe({
          '/usr/bin/which': async () => ({ exitCode: 1, stdout: '', stderr: '' }),
        }),
      );

      await expect(
        pythonRuntimeService.macosCommandResolvesToCltShim(cmd, '/usr/local/bin'),
      ).resolves.toBe('not_found');
      expect(matchProbe(mockRunProbe, (file) => file === '/usr/bin/xcode-select')).toBeUndefined();
    },
  );
});

describe('pythonRuntimeService — CLT-missing cache invalidation', () => {
  it('checkPythonRuntime(forceRefresh: true) re-probes xcode-select CLT state', async () => {
    setPlatform('darwin');

    let xcodeSelectCallCount = 0;
    mockRunProbe.mockImplementation(
      buildRunProbe({
        '/usr/bin/xcode-select': async () => {
          xcodeSelectCallCount += 1;
          return {
            exitCode: 2,
            stdout: '',
            stderr: 'xcode-select: error: unable to get active developer directory',
          };
        },
        '/usr/bin/which': async () => ({ exitCode: 1, stdout: '', stderr: '' }),
      }),
    );

    await pythonRuntimeService.checkPythonRuntime();
    expect(xcodeSelectCallCount).toBe(1);

    await pythonRuntimeService.checkPythonRuntime(true);
    expect(xcodeSelectCallCount).toBe(2);
  });

  it('CLT missing→installed transition is picked up after the short missing-cache TTL', async () => {
    vi.useFakeTimers();
    setPlatform('darwin');

    let cltInstalled = false;
    mockRunProbe.mockImplementation(
      buildRunProbe({
        '/usr/bin/xcode-select': async () => {
          if (cltInstalled) {
            return {
              exitCode: 0,
              stdout: '/Library/Developer/CommandLineTools\n',
              stderr: '',
            };
          }
          return {
            exitCode: 2,
            stdout: '',
            stderr: 'xcode-select: error: unable to get active developer directory',
          };
        },
        '/usr/bin/which': async (args) => {
          const resolvedCmd = args[args.length - 1];
          if (resolvedCmd === 'git') {
            return { exitCode: 0, stdout: '/usr/bin/git\n', stderr: '' };
          }
          return { exitCode: 1, stdout: '', stderr: '' };
        },
      }),
    );
    mockExistsSync.mockImplementation(
      (p: string) => p === '/Library/Developer/CommandLineTools',
    );

    await expect(
      pythonRuntimeService.macosCommandResolvesToCltShim('git', '/usr/bin:/bin'),
    ).resolves.toBe('shim_blocked');

    cltInstalled = true;
    vi.advanceTimersByTime(31_000);

    await expect(
      pythonRuntimeService.macosCommandResolvesToCltShim('git', '/usr/bin:/bin'),
    ).resolves.toBe('safe');

    vi.useRealTimers();
  });
});

describe('pythonRuntimeService — concurrency smoke', () => {
  it('two simultaneous checkPythonRuntime() calls do not crash', async () => {
    setPlatform('darwin');

    mockRunProbe.mockImplementation(
      buildRunProbe({
        '/usr/bin/xcode-select': async () => ({
          exitCode: 2,
          stdout: '',
          stderr: 'xcode-select: error: unable to get active developer directory',
        }),
        '/usr/bin/which': async () => ({ exitCode: 1, stdout: '', stderr: '' }),
      }),
    );

    const [a, b] = await Promise.all([
      pythonRuntimeService.checkPythonRuntime(true),
      pythonRuntimeService.checkPythonRuntime(true),
    ]);

    expect(a.pythonAvailable).toBe(false);
    expect(b.pythonAvailable).toBe(false);
  });
});

describe('pythonRuntimeService — getExtraPaths integration', () => {
  it('derives Homebrew + ~/.local/bin candidates from os.homedir on darwin', async () => {
    setPlatform('darwin');

    mockRunProbe.mockImplementation(
      buildRunProbe({
        '/usr/bin/xcode-select': async () => ({
          exitCode: 2,
          stdout: '',
          stderr: '',
        }),
        '/usr/bin/which': async () => ({ exitCode: 1, stdout: '', stderr: '' }),
        // Simulate ~/.local/bin/python3 existing and being a real Python 3
        [nodePath.join('/Users/testuser', '.local', 'bin', 'python3')]: async () => ({
          exitCode: 0,
          stdout: 'Python 3.13.0\n',
          stderr: '',
        }),
      }),
    );

    const status = await pythonRuntimeService.checkPythonRuntime();

    expect(status.pythonAvailable).toBe(true);
    expect(status.pythonPath).toBe(
      nodePath.join('/Users/testuser', '.local', 'bin', 'python3'),
    );
    expect(status.pythonVersion).toBe('3.13.0');
  });
});
