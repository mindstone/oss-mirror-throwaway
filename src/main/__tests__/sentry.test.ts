import { describe, expect, it } from 'vitest';
import type { Event } from '@sentry/electron/main';

import { normalizeErrorForSentryCapture, isLoggerWriteResourceExhaustionEvent } from '../sentry';

function eventWith(value: string, frameFields: Array<Record<string, string>>): Event {
  return {
    exception: {
      values: [
        {
          type: 'Error',
          value,
          stacktrace: { frames: frameFields },
        },
      ],
    },
  } as unknown as Event;
}

describe('normalizeErrorForSentryCapture', () => {
  it('preserves Error instances unchanged', () => {
    const originalError = new Error('Real failure');

    const result = normalizeErrorForSentryCapture(originalError);

    expect(result.isNonError).toBe(false);
    expect(result.errorToCapture).toBe(originalError);
  });

  it('uses thrown strings as the captured message', () => {
    const result = normalizeErrorForSentryCapture('String failure');

    expect(result.isNonError).toBe(true);
    expect(result.errorToCapture.name).toBe('NonErrorException');
    expect(result.errorToCapture.message).toBe('String failure');
  });

  it('uses message fields from thrown objects as the captured message', () => {
    const result = normalizeErrorForSentryCapture({
      code: 'VALIDATION_ERROR',
      message: 'The provided value was invalid.',
    });

    expect(result.isNonError).toBe(true);
    expect(result.errorToCapture.name).toBe('NonErrorException');
    expect(result.errorToCapture.message).toBe('The provided value was invalid.');
  });

  it('uses nested error messages from thrown objects as the captured message', () => {
    const result = normalizeErrorForSentryCapture({
      code: 'REMOTE_ERROR',
      error: {
        message: 'Remote service rejected the request.',
      },
    });

    expect(result.isNonError).toBe(true);
    expect(result.errorToCapture.name).toBe('NonErrorException');
    expect(result.errorToCapture.message).toBe('Remote service rejected the request.');
  });

  it('falls back only when the thrown value has no readable message', () => {
    const result = normalizeErrorForSentryCapture({ code: 1234 });

    expect(result.isNonError).toBe(true);
    expect(result.errorToCapture.name).toBe('NonErrorException');
    expect(result.errorToCapture.message).toBe('Non-error exception captured');
  });
});

describe('isLoggerWriteResourceExhaustionEvent (REBEL-15G/660/69M)', () => {
  it('matches an ENOSPC write failure originating in the logger', () => {
    const event = eventWith('ENOSPC: no space left on device, write', [
      { filename: 'node:fs', function: 'Object.writeSync' },
      { filename: 'app:///src/core/logger.ts', function: 'constructor.warn' },
    ]);
    expect(isLoggerWriteResourceExhaustionEvent(event)).toBe(true);
  });

  it('matches an EMFILE failure in a pino/thread-stream transport frame', () => {
    const event = eventWith('EMFILE: too many open files, open', [
      { module: 'thread-stream', function: 'write' },
    ]);
    expect(isLoggerWriteResourceExhaustionEvent(event)).toBe(true);
  });

  it('does NOT match a genuine ENOSPC in a data-write path (e.g. storeFactory)', () => {
    const event = eventWith('ENOSPC: no space left on device, write', [
      { filename: 'app:///src/core/storeFactory.ts', function: 'set' },
      { filename: 'app:///src/main/services/assetStoreDesktop.ts', function: 'writeAsset' },
    ]);
    expect(isLoggerWriteResourceExhaustionEvent(event)).toBe(false);
  });

  it('does NOT drop a mixed stack containing a data-store frame, even with a logger frame present (F3)', () => {
    const event = eventWith('ENOSPC: no space left on device, write', [
      { filename: 'app:///src/core/storeFactory.ts', function: 'set' },
      { filename: 'app:///src/core/logger.ts', function: 'error' },
    ]);
    // A real data-write failure must surface even if logging it added a logger frame.
    expect(isLoggerWriteResourceExhaustionEvent(event)).toBe(false);
  });

  it('does NOT match a non-resource error even with a logger frame', () => {
    const event = eventWith('TypeError: cannot read properties of undefined', [
      { filename: 'app:///src/core/logger.ts', function: 'info' },
    ]);
    expect(isLoggerWriteResourceExhaustionEvent(event)).toBe(false);
  });

  it('does not match events with no exception values', () => {
    expect(isLoggerWriteResourceExhaustionEvent({} as Event)).toBe(false);
    expect(isLoggerWriteResourceExhaustionEvent({ message: 'ENOSPC: write' } as unknown as Event)).toBe(false);
  });
});
