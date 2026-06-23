import { describe, expect, it, vi } from 'vitest';
import { raiseFdLimit } from '../raiseFdLimit';

function makeLogger() {
  return { info: vi.fn(), warn: vi.fn() };
}

describe('raiseFdLimit', () => {
  it('calls setFdLimit with the target and logs success when the limit reaches the target', () => {
    const setFdLimit = vi.fn();
    const logger = makeLogger();
    let soft = 256;
    raiseFdLimit({
      setFdLimit: (n) => { setFdLimit(n); soft = n; },
      readSoftLimit: () => soft,
      logger,
      target: 10_240,
    });
    expect(setFdLimit).toHaveBeenCalledWith(10_240);
    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('does NOT lower an already-high soft limit (Linux auto-raised to hard) — F1', () => {
    const setFdLimit = vi.fn();
    const logger = makeLogger();
    raiseFdLimit({
      setFdLimit,
      readSoftLimit: () => 1_048_576, // e.g. Linux hard limit after Node auto-raise
      logger,
      target: 10_240,
    });
    expect(setFdLimit).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledTimes(1); // "already at or above target"
  });

  it('warns when the raised limit is still below target (OS cap)', () => {
    const logger = makeLogger();
    raiseFdLimit({
      setFdLimit: vi.fn(), // does not actually change the soft limit
      readSoftLimit: () => 4096, // capped below target
      logger,
      target: 10_240,
    });
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.info).not.toHaveBeenCalled();
  });

  it('warns and returns when setFdLimit throws', () => {
    const logger = makeLogger();
    raiseFdLimit({
      setFdLimit: () => { throw new Error('EPERM'); },
      readSoftLimit: () => 256,
      logger,
      target: 10_240,
    });
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.info).not.toHaveBeenCalled();
  });

  it('is a no-op when setFdLimit is unavailable (Windows / non-Electron)', () => {
    const logger = makeLogger();
    // process.setFdLimit is undefined under plain Node (vitest) — exercise the guard.
    raiseFdLimit({ logger, readSoftLimit: () => null, target: 10_240 });
    expect(logger.info).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('tolerates a null soft-limit read (logs success when it cannot read back)', () => {
    const logger = makeLogger();
    raiseFdLimit({
      setFdLimit: vi.fn(),
      readSoftLimit: () => null,
      logger,
      target: 10_240,
    });
    // after === null → not "below target", so success is logged.
    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
