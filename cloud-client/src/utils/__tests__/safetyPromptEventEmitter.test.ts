/**
 * F-R2-10 — safetyPromptEventEmitter tests.
 *
 * Covers: add/remove, multiple listeners fire in order, one listener throwing
 * does not block others, unsubscribe works, removeAllListeners works.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { safetyPromptEventEmitter } from '../safetyPromptEventEmitter';
import type { SafetyPromptUpdatedEvent } from '../../transport/approvalTransport';

const payload: SafetyPromptUpdatedEvent = {
  version: 5,
  lastUpdatedAt: 1713200000000,
  lastUpdatedBy: 'user',
};

describe('safetyPromptEventEmitter', () => {
  beforeEach(() => {
    safetyPromptEventEmitter.reset();
  });

  it('fires a registered listener with the correct payload', () => {
    const handler = vi.fn();
    safetyPromptEventEmitter.on('safety-prompt:updated', handler);
    safetyPromptEventEmitter.emit('safety-prompt:updated', payload);
    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith(payload);
  });

  it('fires multiple listeners in registration order', () => {
    const order: number[] = [];
    safetyPromptEventEmitter.on('safety-prompt:updated', () => order.push(1));
    safetyPromptEventEmitter.on('safety-prompt:updated', () => order.push(2));
    safetyPromptEventEmitter.on('safety-prompt:updated', () => order.push(3));
    safetyPromptEventEmitter.emit('safety-prompt:updated', payload);
    expect(order).toEqual([1, 2, 3]);
  });

  it('one listener throwing does not block others (F-R2-10)', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const before = vi.fn();
    const after = vi.fn();
    safetyPromptEventEmitter.on('safety-prompt:updated', before);
    safetyPromptEventEmitter.on('safety-prompt:updated', () => {
      throw new Error('boom');
    });
    safetyPromptEventEmitter.on('safety-prompt:updated', after);

    safetyPromptEventEmitter.emit('safety-prompt:updated', payload);

    expect(before).toHaveBeenCalledOnce();
    expect(after).toHaveBeenCalledOnce();
    expect(spy).toHaveBeenCalledWith(
      '[safetyPromptEventEmitter] listener threw:',
      expect.any(Error),
    );
    spy.mockRestore();
  });

  it('unsubscribe removes only the target listener', () => {
    const handler1 = vi.fn();
    const handler2 = vi.fn();
    const unsub = safetyPromptEventEmitter.on('safety-prompt:updated', handler1);
    safetyPromptEventEmitter.on('safety-prompt:updated', handler2);

    unsub();
    safetyPromptEventEmitter.emit('safety-prompt:updated', payload);

    expect(handler1).not.toHaveBeenCalled();
    expect(handler2).toHaveBeenCalledOnce();
  });

  it('removeAllListeners clears everything', () => {
    const handler = vi.fn();
    safetyPromptEventEmitter.on('safety-prompt:updated', handler);
    safetyPromptEventEmitter.removeAllListeners();
    safetyPromptEventEmitter.emit('safety-prompt:updated', payload);
    expect(handler).not.toHaveBeenCalled();
  });

  it('does not fire if no listeners registered', () => {
    // Should not throw.
    expect(() => safetyPromptEventEmitter.emit('safety-prompt:updated', payload)).not.toThrow();
  });

  // F-R3-6: Version-based dedup tests
  describe('version-based dedup (F-R3-6)', () => {
    it('fires once for the same version — second call is suppressed', () => {
      const handler = vi.fn();
      safetyPromptEventEmitter.on('safety-prompt:updated', handler);

      safetyPromptEventEmitter.emit('safety-prompt:updated', payload);
      safetyPromptEventEmitter.emit('safety-prompt:updated', payload);

      expect(handler).toHaveBeenCalledOnce();
    });

    it('fires for a newer (higher) version', () => {
      const handler = vi.fn();
      safetyPromptEventEmitter.on('safety-prompt:updated', handler);

      safetyPromptEventEmitter.emit('safety-prompt:updated', { ...payload, version: 5 });
      safetyPromptEventEmitter.emit('safety-prompt:updated', { ...payload, version: 6 });

      expect(handler).toHaveBeenCalledTimes(2);
    });

    it('skips stale (lower) version after a higher one', () => {
      const handler = vi.fn();
      safetyPromptEventEmitter.on('safety-prompt:updated', handler);

      safetyPromptEventEmitter.emit('safety-prompt:updated', { ...payload, version: 10 });
      safetyPromptEventEmitter.emit('safety-prompt:updated', { ...payload, version: 8 });

      expect(handler).toHaveBeenCalledOnce();
      expect(handler).toHaveBeenCalledWith(expect.objectContaining({ version: 10 }));
    });

    it('reset() clears dedup state so same version fires again', () => {
      const handler = vi.fn();
      safetyPromptEventEmitter.on('safety-prompt:updated', handler);

      safetyPromptEventEmitter.emit('safety-prompt:updated', payload);
      expect(handler).toHaveBeenCalledOnce();

      safetyPromptEventEmitter.reset();
      safetyPromptEventEmitter.on('safety-prompt:updated', handler);
      safetyPromptEventEmitter.emit('safety-prompt:updated', payload);
      expect(handler).toHaveBeenCalledTimes(2);
    });
  });
});
