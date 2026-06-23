import { describe, it, expect, vi } from 'vitest';
import type { Logger } from 'pino';
import { installEvent } from '../installEvent';

function makeCaptureLogger() {
  const calls: Array<{ level: string; obj: unknown; msg: unknown }> = [];
  const wrap = (level: string) => vi.fn((obj: unknown, msg: unknown) => {
    calls.push({ level, obj, msg });
  });
  return {
    log: {
      debug: wrap('debug'),
      info: wrap('info'),
      warn: wrap('warn'),
      error: wrap('error'),
      trace: wrap('trace'),
      fatal: wrap('fatal'),
    } as unknown as Logger,
    calls,
  };
}

describe('installEvent', () => {
  it('emits at the requested level with event in the object and as the message', () => {
    const { log, calls } = makeCaptureLogger();
    installEvent(log, 'info', 'app-bridge.pair.start', { appId: 'browser-extension', pairSessionId: 'abc' });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      level: 'info',
      obj: {
        event: 'app-bridge.pair.start',
        appId: 'browser-extension',
        pairSessionId: 'abc',
      },
      msg: 'app-bridge.pair.start',
    });
  });

  it('routes warn-level separately from info', () => {
    const { log, calls } = makeCaptureLogger();
    installEvent(log, 'warn', 'app-bridge.pair.claim.fail', { code: 'bad-code' });

    expect(calls).toHaveLength(1);
    expect(calls[0].level).toBe('warn');
  });

  it('supports empty data payload', () => {
    const { log, calls } = makeCaptureLogger();
    installEvent(log, 'info', 'app-bridge.pair.revoke');
    expect(calls[0].obj).toEqual({ event: 'app-bridge.pair.revoke' });
  });

  it('does not mutate the caller-supplied data object', () => {
    const { log } = makeCaptureLogger();
    const data = { a: 1, b: 2 };
    installEvent(log, 'debug', 'app-bridge.test', data);
    expect(data).toEqual({ a: 1, b: 2 });
    // no `event` field leaked back into the caller's object
    expect(Object.keys(data)).toEqual(['a', 'b']);
  });

  it('does not let a caller-supplied data.event shadow the authoritative event arg', () => {
    // Defensive: if the caller accidentally passes { event: 'wrong' },
    // it must NOT override our authoritative event argument. Spread
    // order `{ ...data, event }` guarantees our `event` wins.
    const { log, calls } = makeCaptureLogger();
    installEvent(log, 'info', 'app-bridge.authoritative', { event: 'wrong', other: 'x' } as Record<string, unknown>);
    expect(calls[0].obj).toEqual({ event: 'app-bridge.authoritative', other: 'x' });
  });
});
