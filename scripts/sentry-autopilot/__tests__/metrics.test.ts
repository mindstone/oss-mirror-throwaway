import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { emitCounter, errorLog, LOG_DISCRIMINATORS } from '../metrics.ts';

describe('metrics', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('emitCounter', () => {
    it('emits a tagged counter as one JSON line to stdout', () => {
      emitCounter('parseOutcome.success', { outcome: 'auto_committed' });
      expect(logSpy).toHaveBeenCalledTimes(1);
      const payload = JSON.parse(String(logSpy.mock.calls[0]?.[0]));
      expect(payload).toEqual({
        level: 'info',
        component: 'sentry-autopilot-metrics',
        metric: true,
        name: 'parseOutcome.success',
        value: 1,
        outcome: 'auto_committed',
      });
    });

    it('emits a counter with no tags when tags omitted', () => {
      emitCounter('parseOutcome.is_bug_missing');
      expect(logSpy).toHaveBeenCalledTimes(1);
      const payload = JSON.parse(String(logSpy.mock.calls[0]?.[0]));
      expect(Object.keys(payload).sort()).toEqual(
        ['component', 'level', 'metric', 'name', 'value'].sort(),
      );
    });

    it('preserves number tag values as numbers in the JSON output', () => {
      emitCounter('parseOutcome.failure', { failure_kind: 'parse_failure', attempts: 3 });
      const payload = JSON.parse(String(logSpy.mock.calls[0]?.[0]));
      expect(payload.attempts).toBe(3);
      expect(payload.failure_kind).toBe('parse_failure');
    });

    it('writes to stdout, not stderr', () => {
      emitCounter('foo');
      expect(logSpy).toHaveBeenCalledTimes(1);
      expect(errorSpy).not.toHaveBeenCalled();
    });
  });

  describe('errorLog', () => {
    it('emits a discriminated error log as one JSON line to stderr', () => {
      errorLog(
        'schema_fail',
        { sentryId: 'SENTRY-42', artifactPath: '/tmp/foo/outcome.json' },
        'parse exploded',
      );
      expect(errorSpy).toHaveBeenCalledTimes(1);
      const payload = JSON.parse(String(errorSpy.mock.calls[0]?.[0]));
      expect(payload).toEqual({
        level: 'error',
        component: 'sentry-autopilot',
        log_discriminator: 'schema_fail',
        message: 'parse exploded',
        sentryId: 'SENTRY-42',
        artifactPath: '/tmp/foo/outcome.json',
      });
    });

    it('lets data fields override the message parameter via spread precedence', () => {
      errorLog('reporter_fail', { message: 'shadow' }, 'fallback');
      const payload = JSON.parse(String(errorSpy.mock.calls[0]?.[0]));
      expect(payload.message).toBe('shadow');
    });

    it('writes to stderr, not stdout', () => {
      errorLog('bugfixer_fail', {}, 'x');
      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(logSpy).not.toHaveBeenCalled();
    });

    it('emits empty-data error log with discriminator + message only', () => {
      errorLog('supervisor_fail', {}, 'x');
      const payload = JSON.parse(String(errorSpy.mock.calls[0]?.[0]));
      expect(Object.keys(payload).sort()).toEqual(
        ['component', 'level', 'log_discriminator', 'message'].sort(),
      );
    });
  });

  describe('LOG_DISCRIMINATORS', () => {
    it('enumerates the four expected discriminator values', () => {
      expect([...LOG_DISCRIMINATORS]).toEqual([
        'schema_fail',
        'supervisor_fail',
        'bugfixer_fail',
        'reporter_fail',
      ]);
    });
  });
});
