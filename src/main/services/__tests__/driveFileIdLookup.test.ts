import { beforeEach, describe, expect, it, vi } from 'vitest';

type ExecFileCallback = (err: NodeJS.ErrnoException | null, stdout: string, stderr: string) => void;

const execFileImpl = vi.fn();

vi.mock('node:child_process', () => ({
  execFile: (
    cmd: string,
    args: readonly string[],
    options: unknown,
    cb: ExecFileCallback,
  ) => {
    execFileImpl(cmd, args, options, cb);
  },
}));

const { readDriveFileIdFromXattr } = await import('../driveFileIdLookup');

function withPlatform<T>(platform: NodeJS.Platform, run: () => Promise<T>): Promise<T> {
  const original = process.platform;
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  return run().finally(() => {
    Object.defineProperty(process, 'platform', { value: original, configurable: true });
  });
}

describe('readDriveFileIdFromXattr', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the file_id when xattr -p succeeds on macOS', async () => {
    execFileImpl.mockImplementationOnce((_cmd, _args, _options, cb: ExecFileCallback) => {
      cb(null, '1ki68M_T-dAYOrKKPk8_NKCAQfVOx2RIH\n', '');
    });

    const result = await withPlatform('darwin', () =>
      readDriveFileIdFromXattr('/path/to/skill.md'),
    );
    expect(result).toBe('1ki68M_T-dAYOrKKPk8_NKCAQfVOx2RIH');

    expect(execFileImpl).toHaveBeenCalledWith(
      'xattr',
      ['-p', 'com.google.drivefs.item-id#S', '/path/to/skill.md'],
      expect.objectContaining({ timeout: 2000 }),
      expect.any(Function),
    );
  });

  it('returns null when the xattr does not exist (exit code 1)', async () => {
    execFileImpl.mockImplementationOnce((_cmd, _args, _options, cb: ExecFileCallback) => {
      const err = Object.assign(new Error('xattr not found'), { code: 1 });
      cb(err as unknown as NodeJS.ErrnoException, '', '');
    });

    const result = await withPlatform('darwin', () =>
      readDriveFileIdFromXattr('/path/to/local-only.md'),
    );
    expect(result).toBeNull();
  });

  it('returns null on non-macOS platforms without invoking xattr', async () => {
    const result = await withPlatform('linux', () =>
      readDriveFileIdFromXattr('/path/to/skill.md'),
    );
    expect(result).toBeNull();
    expect(execFileImpl).not.toHaveBeenCalled();
  });

  it('returns null when the xattr value fails the shape check', async () => {
    execFileImpl.mockImplementationOnce((_cmd, _args, _options, cb: ExecFileCallback) => {
      cb(null, 'not a drive id with spaces', '');
    });

    const result = await withPlatform('darwin', () =>
      readDriveFileIdFromXattr('/path/to/skill.md'),
    );
    expect(result).toBeNull();
  });

  it('returns null when xattr produces empty output', async () => {
    execFileImpl.mockImplementationOnce((_cmd, _args, _options, cb: ExecFileCallback) => {
      cb(null, '', '');
    });

    const result = await withPlatform('darwin', () =>
      readDriveFileIdFromXattr('/path/to/skill.md'),
    );
    expect(result).toBeNull();
  });
});
