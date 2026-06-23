import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChildProcess } from 'node:child_process';

type ExecFileCallback = (error: NodeJS.ErrnoException | null, stdout: string | Buffer, stderr: string | Buffer) => void;

const execFileImpl = vi.fn();

 
vi.mock('node:child_process', () => ({
  execFile: (command: string, args: readonly string[], options: unknown, callback: ExecFileCallback) =>
    execFileImpl(command, args, options, callback),
}));

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

function createMockChildProcess(): ChildProcess {
  return { kill: vi.fn() } as unknown as ChildProcess;
}

function createErrnoError(message: string, code: string): NodeJS.ErrnoException {
  const error = new Error(message) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

function createErrnoNumberError(message: string, errno: number): NodeJS.ErrnoException {
  const error = new Error(message) as NodeJS.ErrnoException;
  error.errno = errno;
  return error;
}

function buildLinuxStatLine(pid: number, comm: string, startTicks: number): string {
  const fieldsAfterComm = [
    'S',
    '1',
    '2',
    '3',
    '4',
    '5',
    '6',
    '7',
    '8',
    '9',
    '10',
    '11',
    '12',
    '13',
    '14',
    '15',
    '16',
    '17',
    '18',
    String(startTicks),
    '20',
    '21',
  ];
  return `${pid} (${comm}) ${fieldsAfterComm.join(' ')}`;
}

async function loadModuleForPlatform(platform: NodeJS.Platform): Promise<typeof import('./processStartTime')> {
  setPlatform(platform);
  vi.resetModules();
  return await import('./processStartTime');
}

const permissionDeniedErrorVariants = [
  {
    label: 'code EACCES',
    createError: () => createErrnoError('permission denied', 'EACCES'),
  },
  {
    label: 'errno -13',
    createError: () => createErrnoNumberError('permission denied', -13),
  },
] as const;

describe('getProcessStartTimeMs', () => {
  beforeEach(() => {
    execFileImpl.mockReset();
    setPlatform('darwin');
    vi.useRealTimers();
  });

  afterEach(() => {
    restorePlatform();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('macOS: parses well-formed lstart output', async () => {
    execFileImpl.mockImplementationOnce((_command, _args, _options, callback: ExecFileCallback) => {
      callback(null, 'Wed Nov 27 10:30:45 2025\n', '');
      return createMockChildProcess();
    });

    const { getProcessStartTimeMs } = await loadModuleForPlatform('darwin');
    const result = await getProcessStartTimeMs(4242);

    expect(result).toBe(new Date('Wed Nov 27 10:30:45 2025').getTime());
    expect(execFileImpl).toHaveBeenCalledWith(
      'ps',
      ['-o', 'lstart=', '-p', '4242'],
      expect.objectContaining({ timeout: 2000 }),
      expect.any(Function),
    );
  });

  it('macOS: forces C locale while preserving inherited environment', async () => {
    const originalLocaleEnv = {
      LC_ALL: process.env.LC_ALL,
      LANG: process.env.LANG,
      LC_TIME: process.env.LC_TIME,
    };
    process.env.LC_ALL = 'es_ES.UTF-8';
    process.env.LANG = 'es_ES.UTF-8';
    process.env.LC_TIME = 'es_ES.UTF-8';

    try {
      execFileImpl.mockImplementationOnce((_command, _args, _options, callback: ExecFileCallback) => {
        callback(null, 'Wed Nov 27 10:30:45 2025\n', '');
        return createMockChildProcess();
      });

      const { getProcessStartTimeMs } = await loadModuleForPlatform('darwin');
      await expect(getProcessStartTimeMs(4242)).resolves.toBe(new Date('Wed Nov 27 10:30:45 2025').getTime());

      expect(execFileImpl).toHaveBeenCalledWith(
        'ps',
        ['-o', 'lstart=', '-p', '4242'],
        expect.objectContaining({
          env: expect.objectContaining({
            LC_ALL: 'C',
            LANG: 'C',
            LC_TIME: 'C',
            PATH: process.env.PATH,
          }),
        }),
        expect.any(Function),
      );
    } finally {
      for (const [key, value] of Object.entries(originalLocaleEnv)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
  });

  it('macOS: returns null when ps exits non-zero', async () => {
    execFileImpl.mockImplementationOnce((_command, _args, _options, callback: ExecFileCallback) => {
      callback(createErrnoError('ps failed', '1'), '', 'process not found');
      return createMockChildProcess();
    });

    const { getProcessStartTimeMs } = await loadModuleForPlatform('darwin');
    await expect(getProcessStartTimeMs(99999)).resolves.toBeNull();
  });

  it('macOS: returns null on malformed lstart date', async () => {
    execFileImpl.mockImplementationOnce((_command, _args, _options, callback: ExecFileCallback) => {
      callback(null, 'totally-not-a-date', '');
      return createMockChildProcess();
    });

    const { getProcessStartTimeMs } = await loadModuleForPlatform('darwin');
    await expect(getProcessStartTimeMs(1234)).resolves.toBeNull();
  });

  it('macOS: fails closed on localized lstart output while requesting C locale', async () => {
    execFileImpl.mockImplementationOnce((_command, _args, _options, callback: ExecFileCallback) => {
      callback(null, 'mié abr 30 13:55:00 2026\n', '');
      return createMockChildProcess();
    });

    const { getProcessStartTimeMs } = await loadModuleForPlatform('darwin');
    await expect(getProcessStartTimeMs(1234)).resolves.toBeNull();

    expect(execFileImpl).toHaveBeenCalledWith(
      'ps',
      ['-o', 'lstart=', '-p', '1234'],
      expect.objectContaining({
        env: expect.objectContaining({
          LC_ALL: 'C',
          LANG: 'C',
          LC_TIME: 'C',
        }),
      }),
      expect.any(Function),
    );
  });

  it('Linux: parses starttime from /proc stat for normal, weird, and Unicode comm values', async () => {
    const fixedNowMs = 1_700_000_000_000;
    vi.spyOn(Date, 'now').mockReturnValue(fixedNowMs);

    execFileImpl.mockImplementation((command: string, args: string[], _options, callback: ExecFileCallback) => {
      if (command === 'getconf' && args[0] === 'CLK_TCK') {
        callback(null, '100\n', '');
        return createMockChildProcess();
      }
      if (command === 'cat' && args[0] === '/proc/uptime') {
        callback(null, '1000.00 0.00\n', '');
        return createMockChildProcess();
      }
      if (command === 'cat' && args[0] === '/proc/4242/stat') {
        callback(null, buildLinuxStatLine(4242, 'node', 12_345), '');
        return createMockChildProcess();
      }
      if (command === 'cat' && args[0] === '/proc/4343/stat') {
        callback(null, buildLinuxStatLine(4343, 'my (weird) comm', 54_321), '');
        return createMockChildProcess();
      }
      if (command === 'cat' && args[0] === '/proc/4444/stat') {
        callback(null, buildLinuxStatLine(4444, 'node-😀', 65_432), '');
        return createMockChildProcess();
      }
      if (command === 'cat' && args[0] === '/proc/4545/stat') {
        callback(null, buildLinuxStatLine(4545, '测试', 76_543), '');
        return createMockChildProcess();
      }

      throw new Error(`Unexpected command: ${command} ${args.join(' ')}`);
    });

    const { getProcessStartTimeMs } = await loadModuleForPlatform('linux');
    const resultNode = await getProcessStartTimeMs(4242);
    const resultWeird = await getProcessStartTimeMs(4343);
    const resultEmoji = await getProcessStartTimeMs(4444);
    const resultChinese = await getProcessStartTimeMs(4545);

    const bootEpochMs = fixedNowMs - 1_000_000;
    expect(resultNode).toBe(Math.round(bootEpochMs + (12_345 * 10)));
    expect(resultWeird).toBe(Math.round(bootEpochMs + (54_321 * 10)));
    expect(resultEmoji).toBe(Math.round(bootEpochMs + (65_432 * 10)));
    expect(resultChinese).toBe(Math.round(bootEpochMs + (76_543 * 10)));
  });

  it('Linux: passes C locale env while initializing clocks and reading /proc stat', async () => {
    const fixedNowMs = 1_700_000_000_000;
    vi.spyOn(Date, 'now').mockReturnValue(fixedNowMs);

    execFileImpl.mockImplementation((command: string, args: string[], _options, callback: ExecFileCallback) => {
      if (command === 'getconf' && args[0] === 'CLK_TCK') {
        callback(null, '100\n', '');
        return createMockChildProcess();
      }
      if (command === 'cat' && args[0] === '/proc/uptime') {
        callback(null, '1000.00 0.00\n', '');
        return createMockChildProcess();
      }
      if (command === 'cat' && args[0] === '/proc/4242/stat') {
        callback(null, buildLinuxStatLine(4242, 'node', 12_345), '');
        return createMockChildProcess();
      }

      throw new Error(`Unexpected command: ${command} ${args.join(' ')}`);
    });

    const { getProcessStartTimeMs } = await loadModuleForPlatform('linux');
    await expect(getProcessStartTimeMs(4242)).resolves.toBe(Math.round((fixedNowMs - 1_000_000) + (12_345 * 10)));

    for (const call of execFileImpl.mock.calls) {
      expect(call[2]).toEqual(expect.objectContaining({
        env: expect.objectContaining({
          LC_ALL: 'C',
          LANG: 'C',
          LC_TIME: 'C',
          PATH: process.env.PATH,
        }),
      }));
    }
  });

  it('Linux: returns null on ENOENT from /proc/<pid>/stat', async () => {
    execFileImpl.mockImplementation((command: string, args: string[], _options, callback: ExecFileCallback) => {
      if (command === 'getconf' && args[0] === 'CLK_TCK') {
        callback(null, '100\n', '');
        return createMockChildProcess();
      }
      if (command === 'cat' && args[0] === '/proc/uptime') {
        callback(null, '500.00 0.00\n', '');
        return createMockChildProcess();
      }
      if (command === 'cat' && args[0] === '/proc/5000/stat') {
        callback(createErrnoError('not found', 'ENOENT'), '', '');
        return createMockChildProcess();
      }

      throw new Error(`Unexpected command: ${command} ${args.join(' ')}`);
    });

    const { getProcessStartTimeMs } = await loadModuleForPlatform('linux');
    await expect(getProcessStartTimeMs(5000)).resolves.toBeNull();
  });

  it('Linux: returns null on malformed stat output', async () => {
    execFileImpl.mockImplementation((command: string, args: string[], _options, callback: ExecFileCallback) => {
      if (command === 'getconf' && args[0] === 'CLK_TCK') {
        callback(null, '100\n', '');
        return createMockChildProcess();
      }
      if (command === 'cat' && args[0] === '/proc/uptime') {
        callback(null, '500.00 0.00\n', '');
        return createMockChildProcess();
      }
      if (command === 'cat' && args[0] === '/proc/5100/stat') {
        callback(null, '5100 (node) S 1 2 3', '');
        return createMockChildProcess();
      }

      throw new Error(`Unexpected command: ${command} ${args.join(' ')}`);
    });

    const { getProcessStartTimeMs } = await loadModuleForPlatform('linux');
    await expect(getProcessStartTimeMs(5100)).resolves.toBeNull();
  });

  it('Linux: returns null when getconf CLK_TCK fails (fail-closed)', async () => {
    execFileImpl.mockImplementation((command: string, args: string[], _options, callback: ExecFileCallback) => {
      if (command === 'getconf' && args[0] === 'CLK_TCK') {
        callback(createErrnoError('getconf failed', 'ENOENT'), '', '');
        return createMockChildProcess();
      }

      throw new Error(`Unexpected command: ${command} ${args.join(' ')}`);
    });

    const { getProcessStartTimeMs } = await loadModuleForPlatform('linux');
    await expect(getProcessStartTimeMs(5200)).resolves.toBeNull();
  });

  it.each(permissionDeniedErrorVariants)(
    'macOS: returns null when ps is permission denied ($label)',
    async ({ createError }) => {
      execFileImpl.mockImplementationOnce((_command, _args, _options, callback: ExecFileCallback) => {
        callback(createError(), '', '');
        return createMockChildProcess();
      });

      const { getProcessStartTimeMs } = await loadModuleForPlatform('darwin');
      await expect(getProcessStartTimeMs(6100)).resolves.toBeNull();
    },
  );

  it.each(permissionDeniedErrorVariants)(
    'Linux: returns null when /proc stat read is permission denied ($label)',
    async ({ createError }) => {
      execFileImpl.mockImplementation((command: string, args: string[], _options, callback: ExecFileCallback) => {
        if (command === 'getconf' && args[0] === 'CLK_TCK') {
          callback(null, '100\n', '');
          return createMockChildProcess();
        }
        if (command === 'cat' && args[0] === '/proc/uptime') {
          callback(null, '500.00 0.00\n', '');
          return createMockChildProcess();
        }
        if (command === 'cat' && args[0] === '/proc/6200/stat') {
          callback(createError(), '', '');
          return createMockChildProcess();
        }

        throw new Error(`Unexpected command: ${command} ${args.join(' ')}`);
      });

      const { getProcessStartTimeMs } = await loadModuleForPlatform('linux');
      await expect(getProcessStartTimeMs(6200)).resolves.toBeNull();
    },
  );

  it.each(permissionDeniedErrorVariants)(
    'Windows: returns null when WMIC and PowerShell are permission denied ($label)',
    async ({ createError }) => {
      execFileImpl.mockImplementationOnce((_command, _args, _options, callback: ExecFileCallback) => {
        callback(createError(), '', '');
        return createMockChildProcess();
      });
      execFileImpl.mockImplementationOnce((_command, _args, _options, callback: ExecFileCallback) => {
        callback(createError(), '', '');
        return createMockChildProcess();
      });

      const { getProcessStartTimeMs } = await loadModuleForPlatform('win32');
      await expect(getProcessStartTimeMs(6300)).resolves.toBeNull();
    },
  );

  it('Windows: parses well-formed WMIC CreationDate output', async () => {
    execFileImpl.mockImplementationOnce((_command, _args, _options, callback: ExecFileCallback) => {
      callback(null, '\nCreationDate=20251127103045.654321+060\n\n', '');
      return createMockChildProcess();
    });

    const { getProcessStartTimeMs } = await loadModuleForPlatform('win32');
    const result = await getProcessStartTimeMs(7001);

    const expected = Date.UTC(2025, 10, 27, 10, 30, 45, 654) - (60 * 60_000);
    expect(result).toBe(expected);
  });

  it('Windows: falls back to PowerShell when WMIC fails', async () => {
    execFileImpl.mockImplementationOnce((_command, _args, _options, callback: ExecFileCallback) => {
      callback(createErrnoError('wmic missing', 'ENOENT'), '', '');
      return createMockChildProcess();
    });
    execFileImpl.mockImplementationOnce((_command, _args, _options, callback: ExecFileCallback) => {
      callback(null, '2025-11-27T10:30:45.123Z\n', '');
      return createMockChildProcess();
    });

    const { getProcessStartTimeMs } = await loadModuleForPlatform('win32');
    const result = await getProcessStartTimeMs(8001);

    expect(result).toBe(Date.parse('2025-11-27T10:30:45.123Z'));
    expect(execFileImpl).toHaveBeenCalledTimes(2);
    expect(execFileImpl.mock.calls[0]?.[0]).toBe('wmic');
    expect(execFileImpl.mock.calls[1]?.[0]).toBe('powershell');
    expect(execFileImpl.mock.calls[1]?.[2]).toEqual(expect.objectContaining({
      env: expect.objectContaining({
        LC_ALL: 'C',
        LANG: 'C',
        LC_TIME: 'C',
      }),
    }));
    expect(execFileImpl.mock.calls[1]?.[1]).toEqual([
      '-NoProfile',
      '-Command',
      "(Get-Process -Id 8001 -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o', [System.Globalization.CultureInfo]::InvariantCulture)",
    ]);
  });

  it('Windows: returns null when WMIC and PowerShell both fail', async () => {
    execFileImpl.mockImplementationOnce((_command, _args, _options, callback: ExecFileCallback) => {
      callback(createErrnoError('wmic failed', '1'), '', '');
      return createMockChildProcess();
    });
    execFileImpl.mockImplementationOnce((_command, _args, _options, callback: ExecFileCallback) => {
      callback(createErrnoError('powershell failed', '1'), '', '');
      return createMockChildProcess();
    });

    const { getProcessStartTimeMs } = await loadModuleForPlatform('win32');
    await expect(getProcessStartTimeMs(8002)).resolves.toBeNull();
  });

  it.each(['darwin', 'linux', 'win32'] as const)(
    'returns null when subprocess callback never fires on %s',
    async (platform) => {
      vi.useFakeTimers();

      execFileImpl.mockImplementation((command: string, args: string[], _options, callback: ExecFileCallback) => {
        if (platform === 'linux' && command === 'getconf' && args[0] === 'CLK_TCK') {
          callback(null, '100\n', '');
          return createMockChildProcess();
        }
        if (platform === 'linux' && command === 'cat' && args[0] === '/proc/uptime') {
          callback(null, '1200.00 0.00\n', '');
          return createMockChildProcess();
        }
        // Simulate a command that never responds.
        return createMockChildProcess();
      });

      const { getProcessStartTimeMs } = await loadModuleForPlatform(platform);
      const pending = getProcessStartTimeMs(4321);

      let settled = false;
      pending.finally(() => {
        settled = true;
      });

      await vi.advanceTimersByTimeAsync(1_900);
      expect(settled).toBe(false);

      await vi.advanceTimersByTimeAsync(200);
      await expect(pending).resolves.toBeNull();
    },
  );

  it.each(['darwin', 'linux', 'win32'] as const)(
    'returns null for invalid pid values without spawning subprocess on %s',
    async (platform) => {
      if (platform === 'linux') {
        execFileImpl.mockImplementation((command: string, args: string[], _options, callback: ExecFileCallback) => {
          if (command === 'getconf' && args[0] === 'CLK_TCK') {
            callback(null, '100\n', '');
            return createMockChildProcess();
          }
          if (command === 'cat' && args[0] === '/proc/uptime') {
            callback(null, '1000.00 0.00\n', '');
            return createMockChildProcess();
          }
          throw new Error(`Unexpected command during linux init: ${command} ${args.join(' ')}`);
        });
      }

      const { getProcessStartTimeMs } = await loadModuleForPlatform(platform);
      execFileImpl.mockClear();

      await expect(getProcessStartTimeMs(0)).resolves.toBeNull();
      await expect(getProcessStartTimeMs(-1)).resolves.toBeNull();
      await expect(getProcessStartTimeMs(Number.NaN)).resolves.toBeNull();
      await expect(getProcessStartTimeMs(1.25)).resolves.toBeNull();

      expect(execFileImpl).not.toHaveBeenCalled();
    },
  );
});
