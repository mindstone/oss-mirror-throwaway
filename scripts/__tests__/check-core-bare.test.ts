import { describe, expect, it, vi } from 'vitest';

import { evaluateCoreBare, main, type GitRunner } from '../check-core-bare';

const runnerReturning = (ok: boolean, stdout: string): GitRunner => () => ({ ok, stdout });

describe('evaluateCoreBare', () => {
  it('is healthy when inside a work tree', () => {
    expect(evaluateCoreBare(runnerReturning(true, 'true')).status).toBe('healthy');
  });

  it('is corrupted when git reports not-a-work-tree on a real repo (effective core.bare true)', () => {
    const r = evaluateCoreBare(runnerReturning(true, 'false'));
    expect(r.status).toBe('corrupted');
    expect(r.detail).toContain('core.bare is effectively true');
  });

  it('skips when git is unavailable / not a repo (does not block non-git contexts)', () => {
    expect(evaluateCoreBare(runnerReturning(false, '')).status).toBe('skipped');
  });

  it('treats unexpected stdout as corrupted (fail-closed, not silently pass)', () => {
    expect(evaluateCoreBare(runnerReturning(true, '')).status).toBe('corrupted');
  });

  it('passes the exact rev-parse query', () => {
    const runGit = vi.fn(() => ({ ok: true, stdout: 'true' }));
    evaluateCoreBare(runGit);
    expect(runGit).toHaveBeenCalledWith(['rev-parse', '--is-inside-work-tree']);
  });
});

describe('main', () => {
  it('returns exit 0 when healthy', () => {
    expect(main(runnerReturning(true, 'true'))).toBe(0);
  });

  it('returns exit 0 when skipped', () => {
    expect(main(runnerReturning(false, ''))).toBe(0);
  });

  it('returns exit 1 when corrupted', () => {
    const errSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    expect(main(runnerReturning(true, 'false'))).toBe(1);
    errSpy.mockRestore();
  });
});
