import { execFileSync, execSync } from 'node:child_process';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_GIT_MAXBUFFER, gitCapture, gitCaptureShell } from '../git-exec.js';

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
  execSync: vi.fn(),
}));

beforeEach(() => {
  vi.mocked(execFileSync).mockReset();
  vi.mocked(execSync).mockReset();
});

describe('gitCapture', () => {
  it('applies the default git maxBuffer and utf8 encoding', () => {
    vi.mocked(execFileSync).mockReturnValue('tracked-file.ts\n');

    const output = gitCapture(['ls-files'], { cwd: '/repo' });

    expect(output).toBe('tracked-file.ts\n');
    expect(execFileSync).toHaveBeenCalledWith('git', ['ls-files'], {
      cwd: '/repo',
      encoding: 'utf8',
      maxBuffer: DEFAULT_GIT_MAXBUFFER,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  });

  it('respects explicit maxBuffer and encoding overrides', () => {
    vi.mocked(execFileSync).mockReturnValue('abc123\n');

    const output = gitCapture(['log', '--format=%H'], {
      cwd: '/repo',
      encoding: 'utf-8',
      maxBuffer: 4096,
    });

    expect(output).toBe('abc123\n');
    expect(execFileSync).toHaveBeenCalledWith('git', ['log', '--format=%H'], {
      cwd: '/repo',
      encoding: 'utf-8',
      maxBuffer: 4096,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  });

  it('passes the args array through to git verbatim', () => {
    const args = ['diff', '--name-only', 'HEAD', '--', 'path with spaces.ts'];
    vi.mocked(execFileSync).mockReturnValue('');

    gitCapture(args);

    expect(execFileSync).toHaveBeenCalledWith('git', args, {
      cwd: undefined,
      encoding: 'utf8',
      maxBuffer: DEFAULT_GIT_MAXBUFFER,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  });
});

describe('gitCaptureShell', () => {
  it('applies the shared maxBuffer to string git commands', () => {
    vi.mocked(execSync).mockReturnValue('subject\n');

    const output = gitCaptureShell('git log --format=%s HEAD~1...HEAD', { cwd: '/repo' });

    expect(output).toBe('subject\n');
    expect(execSync).toHaveBeenCalledWith('git log --format=%s HEAD~1...HEAD', {
      cwd: '/repo',
      encoding: 'utf8',
      maxBuffer: DEFAULT_GIT_MAXBUFFER,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  });
});
