import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SafeLogLevel } from '../safeLog';
import { safeLog } from '../safeLog';

describe('safeLog (REBEL-5RT cascade guard, generalised for fatal + error)', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  for (const level of ['fatal', 'error'] as const satisfies readonly SafeLogLevel[]) {
    describe(`level=${level}`, () => {
      it(`forwards to logger.${level} on the happy path and does not touch console.error`, () => {
        const sink = { fatal: vi.fn(), error: vi.fn() };
        const payload = { err: new Error('boom') };

        safeLog(sink, level, payload, `Uncaught ${level}`);

        expect(sink[level]).toHaveBeenCalledTimes(1);
        expect(sink[level]).toHaveBeenCalledWith(payload, `Uncaught ${level}`);
        const otherLevel = level === 'fatal' ? 'error' : 'fatal';
        expect(sink[otherLevel]).not.toHaveBeenCalled();
        expect(consoleSpy).not.toHaveBeenCalled();
      });

      it(`falls back to console.error when logger.${level} throws and never re-throws`, () => {
        const sink = {
          fatal: vi.fn(() => {
            throw new Error('the worker has exited');
          }),
          error: vi.fn(() => {
            throw new Error('the worker has exited');
          }),
        };
        const payload = { err: new Error('original boom') };

        expect(() => safeLog(sink, level, payload, `Crash via ${level}`)).not.toThrow();

        expect(sink[level]).toHaveBeenCalledTimes(1);
        expect(consoleSpy).toHaveBeenCalledTimes(1);
        const [prefix, message, loggedPayload, loggerError] = consoleSpy.mock.calls[0]!;
        expect(prefix).toBe(`[main] logger.${level} failed; falling back to console:`);
        expect(message).toBe(`Crash via ${level}`);
        expect(loggedPayload).toBe(payload);
        expect((loggerError as Error).message).toBe('the worker has exited');
      });

      it(`swallows even a console.error failure rather than resurrect the cascade`, () => {
        const sink = {
          fatal: vi.fn(() => {
            throw new Error('the worker has exited');
          }),
          error: vi.fn(() => {
            throw new Error('the worker has exited');
          }),
        };
        consoleSpy.mockImplementation(() => {
          throw new Error('console.error also broken');
        });

        expect(() =>
          safeLog(sink, level, { err: new Error('original') }, `Crash via ${level}`),
        ).not.toThrow();
        expect(sink[level]).toHaveBeenCalledTimes(1);
        expect(consoleSpy).toHaveBeenCalledTimes(1);
      });
    });
  }

  it('routes between fatal and error correctly when both are available', () => {
    const sink = { fatal: vi.fn(), error: vi.fn() };
    safeLog(sink, 'fatal', { a: 1 }, 'one');
    safeLog(sink, 'error', { b: 2 }, 'two');
    expect(sink.fatal).toHaveBeenCalledWith({ a: 1 }, 'one');
    expect(sink.error).toHaveBeenCalledWith({ b: 2 }, 'two');
    expect(sink.fatal).toHaveBeenCalledTimes(1);
    expect(sink.error).toHaveBeenCalledTimes(1);
  });
});
