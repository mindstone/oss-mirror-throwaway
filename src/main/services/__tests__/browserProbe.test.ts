import { describe, expect, it, vi } from 'vitest';
import { isBrowserRunning } from '../browserProbe';

describe('browserProbe', () => {
  it('returns true when macOS ps output contains the full Chrome binary path', async () => {
    const execFile = vi.fn().mockResolvedValue({
      stdout:
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --profile-directory=Default\n',
      stderr: '',
    });

    const result = await isBrowserRunning('chrome', {
      execFile,
      logger: { warn: vi.fn() },
      platform: 'darwin',
    });

    expect(result).toBe(true);
    expect(execFile).toHaveBeenCalledWith(
      'ps',
      ['-axo', 'command'],
      expect.objectContaining({
        timeout: 2_000,
      }),
    );
  });

  it('returns true for Linux browsers that only advertise a Linux binary name', async () => {
    const execFile = vi.fn().mockResolvedValue({
      stdout: '/usr/bin/google-chrome --enable-features=FooBar\n',
      stderr: '',
    });

    const result = await isBrowserRunning('chrome', {
      execFile,
      logger: { warn: vi.fn() },
      platform: 'linux',
    });

    expect(result).toBe(true);
  });

  it('rejects dia false positives from macOS system processes', async () => {
    const execFile = vi.fn().mockResolvedValue({
      stdout: '/usr/libexec/diagnosticd\n',
      stderr: '',
    });

    const result = await isBrowserRunning('dia', {
      execFile,
      logger: { warn: vi.fn() },
      platform: 'darwin',
    });

    expect(result).toBe(false);
  });

  it('rejects arc false positives from unrelated process names', async () => {
    const execFile = vi.fn().mockResolvedValue({
      stdout: '/Applications/Arctic.app/Contents/MacOS/Arctic --background\n',
      stderr: '',
    });

    const result = await isBrowserRunning('arc', {
      execFile,
      logger: { warn: vi.fn() },
      platform: 'darwin',
    });

    expect(result).toBe(false);
  });

  it('matches Windows image names exactly instead of by substring', async () => {
    const execFile = vi.fn().mockResolvedValue({
      stdout: '"chrome.exe","1234","Console","1","12,345 K"\r\n',
      stderr: '',
    });

    const result = await isBrowserRunning('yandex', {
      execFile,
      logger: { warn: vi.fn() },
      platform: 'win32',
    });

    expect(result).toBe(false);
  });

  it('returns false and logs a warning when the probe command fails', async () => {
    const warn = vi.fn();
    const execFile = vi.fn().mockRejectedValue(new Error('ps failed'));

    const result = await isBrowserRunning('chrome', {
      execFile,
      logger: { warn },
      platform: 'darwin',
    });

    expect(result).toBe(false);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        browserId: 'chrome',
        command: 'ps -axo command',
        error: 'ps failed',
      }),
      'Browser running probe failed',
    );
  });
});
