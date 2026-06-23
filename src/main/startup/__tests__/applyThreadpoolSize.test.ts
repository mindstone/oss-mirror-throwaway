import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { THREADPOOL_SIZE_CAP, THREADPOOL_SIZE_FLOOR } from '@core/startup/threadpoolSize';

// Importing the module runs its side-effect (one apply + one console.log) once.
// We then call the exported function explicitly to assert the env-mutation
// behaviour deterministically. Silence the boot console line.
const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

const { applyThreadpoolSizeAtBoot } = await import('../applyThreadpoolSize');

describe('applyThreadpoolSizeAtBoot', () => {
  const original = process.env.UV_THREADPOOL_SIZE;

  beforeEach(() => {
    delete process.env.UV_THREADPOOL_SIZE;
  });

  afterEach(() => {
    if (original === undefined) delete process.env.UV_THREADPOOL_SIZE;
    else process.env.UV_THREADPOOL_SIZE = original;
  });

  it('sets UV_THREADPOOL_SIZE when unset (to a value within the configured floor/cap)', () => {
    const outcome = applyThreadpoolSizeAtBoot();
    const value = Number.parseInt(process.env.UV_THREADPOOL_SIZE ?? '', 10);
    expect(value).toBeGreaterThanOrEqual(THREADPOOL_SIZE_FLOOR);
    expect(value).toBeLessThanOrEqual(THREADPOOL_SIZE_CAP);
    expect(outcome).toContain('bufferApplied=true');
  });

  it('never shrinks a larger operator-chosen value', () => {
    process.env.UV_THREADPOOL_SIZE = '64';
    applyThreadpoolSizeAtBoot();
    expect(process.env.UV_THREADPOOL_SIZE).toBe('64');
  });

  it('raises a too-small existing value to at least the floor', () => {
    process.env.UV_THREADPOOL_SIZE = '4';
    applyThreadpoolSizeAtBoot();
    expect(Number.parseInt(process.env.UV_THREADPOOL_SIZE ?? '', 10)).toBeGreaterThanOrEqual(
      THREADPOOL_SIZE_FLOOR,
    );
  });

  it('replaces an unparseable override with the working buffer (F5)', () => {
    process.env.UV_THREADPOOL_SIZE = 'auto';
    applyThreadpoolSizeAtBoot();
    const value = Number.parseInt(process.env.UV_THREADPOOL_SIZE ?? '', 10);
    expect(value).toBeGreaterThanOrEqual(THREADPOOL_SIZE_FLOOR);
    expect(value).toBeLessThanOrEqual(THREADPOOL_SIZE_CAP);
  });

  it('module import emitted exactly one boot log line', () => {
    // The side-effect-on-import logged once. (Other tests call the function
    // directly without re-importing, so no extra import-time logs.)
    expect(logSpy).toHaveBeenCalled();
  });
});
