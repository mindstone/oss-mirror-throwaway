/**
 * F-R3-9 — Preload bridge test for safetyPromptSubscriptions.
 *
 * Tests the actual `createSafetyPromptSubscriptions` factory (extracted in
 * F-R3-9) with a mock ipcRenderer. Replaces the old test that copied the
 * preload implementation inline.
 */

import { describe, it, expect, vi } from 'vitest';
import { createSafetyPromptSubscriptions, type IpcRendererLike } from '../safetyPromptSubscriptionFactory';

function createMockIpcRenderer(): IpcRendererLike & {
  mockOn: ReturnType<typeof vi.fn>;
  mockRemoveListener: ReturnType<typeof vi.fn>;
} {
  const mockOn = vi.fn();
  const mockRemoveListener = vi.fn();
  return {
    on: mockOn,
    removeListener: mockRemoveListener,
    mockOn,
    mockRemoveListener,
  };
}

describe('createSafetyPromptSubscriptions (F-R3-9)', () => {
  it('exposes onSafetyPromptUpdated method', () => {
    const ipc = createMockIpcRenderer();
    const subs = createSafetyPromptSubscriptions(ipc);
    expect(typeof subs.onSafetyPromptUpdated).toBe('function');
    expect(typeof subs.onSafetyPromptRulePersisted).toBe('function');
  });

  it('registers ipcRenderer.on with the correct channel', () => {
    const ipc = createMockIpcRenderer();
    const subs = createSafetyPromptSubscriptions(ipc);
    const callback = vi.fn();
    subs.onSafetyPromptUpdated(callback);

    expect(ipc.mockOn).toHaveBeenCalledOnce();
    expect(ipc.mockOn).toHaveBeenCalledWith('safety-prompt:updated', expect.any(Function));
  });

  it('returns an unsubscribe function that calls ipcRenderer.removeListener', () => {
    const ipc = createMockIpcRenderer();
    const subs = createSafetyPromptSubscriptions(ipc);
    const unsub = subs.onSafetyPromptUpdated(vi.fn());

    expect(typeof unsub).toBe('function');
    unsub();

    expect(ipc.mockRemoveListener).toHaveBeenCalledOnce();
    expect(ipc.mockRemoveListener).toHaveBeenCalledWith('safety-prompt:updated', expect.any(Function));
  });

  it('forwards payload from ipcRenderer event to callback', () => {
    const ipc = createMockIpcRenderer();
    const subs = createSafetyPromptSubscriptions(ipc);
    const callback = vi.fn();
    subs.onSafetyPromptUpdated(callback);

    // Simulate ipcRenderer event
    const registeredListener = ipc.mockOn.mock.calls[0]![1] as (...args: unknown[]) => void;
    const payload = { version: 5, lastUpdatedAt: 1713200000000, lastUpdatedBy: 'user' as const };
    registeredListener({}, payload);

    expect(callback).toHaveBeenCalledOnce();
    expect(callback).toHaveBeenCalledWith(payload);
  });

  it('multiple subscribers do not interfere', () => {
    const ipc = createMockIpcRenderer();
    const subs = createSafetyPromptSubscriptions(ipc);
    const callback1 = vi.fn();
    const callback2 = vi.fn();

    const unsub1 = subs.onSafetyPromptUpdated(callback1);
    subs.onSafetyPromptUpdated(callback2);

    expect(ipc.mockOn).toHaveBeenCalledTimes(2);

    // Unsubscribe first — second should remain unaffected
    unsub1();
    expect(ipc.mockRemoveListener).toHaveBeenCalledOnce();

    // The listener removed should be the one from the first subscription, not the second
    const removedListener = ipc.mockRemoveListener.mock.calls[0]![1];
    const firstListener = ipc.mockOn.mock.calls[0]![1];
    const secondListener = ipc.mockOn.mock.calls[1]![1];
    expect(removedListener).toBe(firstListener);
    expect(removedListener).not.toBe(secondListener);
  });

  it('subscribes to rule-persisted events', () => {
    const ipc = createMockIpcRenderer();
    const subs = createSafetyPromptSubscriptions(ipc);
    const callback = vi.fn();
    const unsub = subs.onSafetyPromptRulePersisted(callback);

    expect(ipc.mockOn).toHaveBeenCalledWith('safety-prompt:rule-persisted', expect.any(Function));

    const registeredListener = ipc.mockOn.mock.calls[0]![1] as (...args: unknown[]) => void;
    const payload = {
      version: 7,
      lastUpdatedAt: 1713200000000,
      source: 'chat-intent' as const,
      summary: 'Rule added',
      proposedPrinciple: '- You may send weekly status updates.',
    };
    registeredListener({}, payload);

    expect(callback).toHaveBeenCalledWith(payload);
    unsub();
    expect(ipc.mockRemoveListener).toHaveBeenCalledWith('safety-prompt:rule-persisted', expect.any(Function));
  });
});
