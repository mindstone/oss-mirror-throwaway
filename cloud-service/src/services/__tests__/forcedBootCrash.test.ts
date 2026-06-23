import { describe, expect, it, vi } from 'vitest';
import {
  maybeInstallForcedBootCrash,
  FORCED_BOOT_CRASH_DELAY_MS,
  FORCED_BOOT_CRASH_MESSAGE,
} from '../forcedBootCrash';

describe('maybeInstallForcedBootCrash', () => {
  it('does NOT arm when both envs are unset', () => {
    const schedule = vi.fn();
    const errorOutput = vi.fn();
    const exit = vi.fn() as unknown as (code: number) => never;
    const armed = maybeInstallForcedBootCrash({
      env: {},
      schedule,
      errorOutput,
      exit,
    });
    expect(armed).toBe(false);
    expect(schedule).not.toHaveBeenCalled();
  });

  it('does NOT arm when only REBEL_FORCE_BOOT_CRASH is set', () => {
    const schedule = vi.fn();
    const armed = maybeInstallForcedBootCrash({
      env: { REBEL_FORCE_BOOT_CRASH: '1' },
      schedule,
      errorOutput: vi.fn(),
      exit: vi.fn() as unknown as (code: number) => never,
    });
    expect(armed).toBe(false);
    expect(schedule).not.toHaveBeenCalled();
  });

  it('does NOT arm when only IS_CI_SMOKE_TEST is set', () => {
    const schedule = vi.fn();
    const armed = maybeInstallForcedBootCrash({
      env: { IS_CI_SMOKE_TEST: '1' },
      schedule,
      errorOutput: vi.fn(),
      exit: vi.fn() as unknown as (code: number) => never,
    });
    expect(armed).toBe(false);
    expect(schedule).not.toHaveBeenCalled();
  });

  it('arms a 100ms delayed crash when BOTH envs are set', () => {
    const schedule = vi.fn();
    const errorOutput = vi.fn();
    const exit = vi.fn() as unknown as (code: number) => never;
    const armed = maybeInstallForcedBootCrash({
      env: { REBEL_FORCE_BOOT_CRASH: '1', IS_CI_SMOKE_TEST: '1' },
      schedule,
      errorOutput,
      exit,
    });
    expect(armed).toBe(true);
    expect(schedule).toHaveBeenCalledOnce();
    expect(schedule.mock.calls[0][1]).toBe(FORCED_BOOT_CRASH_DELAY_MS);
  });

  it('the scheduled callback writes to errorOutput and calls exit(1)', () => {
    const schedule = vi.fn() as unknown as (cb: () => void, ms: number) => unknown;
    let scheduledCb: (() => void) | undefined;
    const captureSchedule = vi.fn((cb: () => void) => {
      scheduledCb = cb;
    });
    const errorOutput = vi.fn();
    const exit = vi.fn() as unknown as (code: number) => never;

    maybeInstallForcedBootCrash({
      env: { REBEL_FORCE_BOOT_CRASH: '1', IS_CI_SMOKE_TEST: '1' },
      schedule: captureSchedule,
      errorOutput,
      exit,
    });

    expect(scheduledCb).toBeDefined();
    scheduledCb!();

    expect(errorOutput).toHaveBeenCalledWith(FORCED_BOOT_CRASH_MESSAGE);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('errorOutput line matches the 222189772 hot-fix invariant (synchronous stderr [fatal] prefix)', () => {
    // Ensures the line CI smoke step grep'd-for ([fatal]) is present, so a
    // future refactor cannot silently disable visibility on Fly logs.
    expect(FORCED_BOOT_CRASH_MESSAGE.startsWith('[fatal]')).toBe(true);
  });
});
