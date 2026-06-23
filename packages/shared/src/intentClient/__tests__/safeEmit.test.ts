import { describe, expect, it, vi } from 'vitest';
import type { DiagnosticEvent, DiagnosticSink } from '../diagnostics';
import { safeEmit, safeInvoke } from '../safeEmit';

const FETCH_START_EVENT: DiagnosticEvent = {
  kind: 'fetch.start',
  op: 'sendMessage',
  url: '/intent/conversation/123/message',
  requestId: 'req-123',
  tokenLen: 12,
  ts: 1_714_209_600_000,
};

describe('safeEmit', () => {
  it('swallows synchronous DiagnosticSink throws (F31 invariant)', () => {
    const sink: DiagnosticSink = {
      emit: () => {
        throw new Error('sink exploded');
      },
    };

    expect(() => safeEmit(sink, FETCH_START_EVENT)).not.toThrow();
  });

  it('forwards events to healthy sinks', () => {
    const emit = vi.fn();
    const sink: DiagnosticSink = { emit };

    safeEmit(sink, FETCH_START_EVENT);

    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith(FETCH_START_EVENT);
  });
});

describe('safeInvoke', () => {
  it('swallows synchronous callback throws', () => {
    const callback = (): void => {
      throw new Error('callback exploded');
    };
    expect(() => safeInvoke(callback)).not.toThrow();
  });
});
