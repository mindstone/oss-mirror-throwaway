/**
 * Stage 2 of `260422_renderer_driven_connector_status` — preload bridge
 * test for the `connector:status-changed` subscription factory.
 *
 * `validate:ipc` only covers invoke/contract channels, so this test is
 * the canonical regression guard for:
 *   - Channel name (exactly `'connector:status-changed'`).
 *   - Payload forwarding (valid payloads reach the callback).
 *   - Payload rejection (invalid shapes are logged at warn and dropped).
 *   - Unsubscribe (no further callbacks after returned function runs).
 *
 * Pattern mirrors `safetyPromptSubscriptions.test.ts`.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  createConnectorStatusSubscriptions,
  type IpcRendererLike,
} from '../connectorStatusSubscriptionFactory';
import type { ConnectorStatusChangedPayload } from '@shared/ipc/channels/appBridge';

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

function createMockLogger() {
  return { warn: vi.fn() };
}

describe('createConnectorStatusSubscriptions', () => {
  it('exposes onConnectorStatusChanged method', () => {
    const ipc = createMockIpcRenderer();
    const subs = createConnectorStatusSubscriptions(ipc);
    expect(typeof subs.onConnectorStatusChanged).toBe('function');
  });

  it('registers ipcRenderer.on with the exact channel name "connector:status-changed"', () => {
    const ipc = createMockIpcRenderer();
    const subs = createConnectorStatusSubscriptions(ipc);
    subs.onConnectorStatusChanged(vi.fn());

    expect(ipc.mockOn).toHaveBeenCalledOnce();
    expect(ipc.mockOn).toHaveBeenCalledWith(
      'connector:status-changed',
      expect.any(Function),
    );
  });

  it('forwards a valid payload through to the callback', () => {
    const ipc = createMockIpcRenderer();
    const subs = createConnectorStatusSubscriptions(ipc);
    const callback = vi.fn();
    subs.onConnectorStatusChanged(callback);

    const listener = ipc.mockOn.mock.calls[0]![1] as (...args: unknown[]) => void;
    const payload: ConnectorStatusChangedPayload = {
      connectorId: 'bundled-app-bridge',
      status: 'connected',
      pairSessionId: 'abc-123',
      emittedAt: 1_700_000_000_000,
      eventId: 'abc-123:1700000000000:connected',
    };
    // Electron sends `(event, ...args)`. We mirror that signature here.
    listener({}, payload);

    expect(callback).toHaveBeenCalledOnce();
    expect(callback).toHaveBeenCalledWith(payload);
  });

  it('drops invalid payloads and logs a warning instead of calling back', () => {
    const ipc = createMockIpcRenderer();
    const logger = createMockLogger();
    const subs = createConnectorStatusSubscriptions(ipc, { logger });
    const callback = vi.fn();
    subs.onConnectorStatusChanged(callback);

    const listener = ipc.mockOn.mock.calls[0]![1] as (...args: unknown[]) => void;

    // Missing required fields → .strict() parse fails.
    listener({}, { connectorId: 'bundled-app-bridge', status: 'connected' });
    // Extra unexpected field → .strict() parse fails (important: keeps
    // `tokenFingerprint` from sneaking in via future schema drift).
    listener({}, {
      connectorId: 'bundled-app-bridge',
      status: 'connected',
      pairSessionId: 'abc',
      emittedAt: 1,
      eventId: 'abc:1:connected',
      tokenFingerprint: 'leak-attempt',
    });
    // Wrong type for status.
    listener({}, {
      connectorId: 'bundled-app-bridge',
      status: 'bogus',
      pairSessionId: 'abc',
      emittedAt: 1,
      eventId: 'abc:1:bogus',
    });

    expect(callback).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledTimes(3);
    for (const call of logger.warn.mock.calls) {
      expect(call[0]).toMatch(/failed validation/i);
    }
  });

  it('returns an unsubscribe function that removes the listener', () => {
    const ipc = createMockIpcRenderer();
    const subs = createConnectorStatusSubscriptions(ipc);
    const unsubscribe = subs.onConnectorStatusChanged(vi.fn());

    expect(typeof unsubscribe).toBe('function');
    unsubscribe();

    expect(ipc.mockRemoveListener).toHaveBeenCalledOnce();
    expect(ipc.mockRemoveListener).toHaveBeenCalledWith(
      'connector:status-changed',
      expect.any(Function),
    );
    // The listener removed must be the listener that was registered.
    const registeredListener = ipc.mockOn.mock.calls[0]![1];
    const removedListener = ipc.mockRemoveListener.mock.calls[0]![1];
    expect(removedListener).toBe(registeredListener);
  });

  it('does not invoke the callback after unsubscribe when the bound listener is no longer on the channel', () => {
    // Simulate a real ipcRenderer by tracking registered listeners.
    const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
    const ipc: IpcRendererLike = {
      on(channel, listener) {
        const existing = listeners.get(channel) ?? [];
        existing.push(listener);
        listeners.set(channel, existing);
      },
      removeListener(channel, listener) {
        const existing = listeners.get(channel) ?? [];
        listeners.set(
          channel,
          existing.filter((l) => l !== listener),
        );
      },
    };
    const subs = createConnectorStatusSubscriptions(ipc);
    const callback = vi.fn();
    const unsubscribe = subs.onConnectorStatusChanged(callback);
    const validPayload: ConnectorStatusChangedPayload = {
      connectorId: 'bundled-app-bridge',
      status: 'expired',
      pairSessionId: 'xyz-789',
      emittedAt: 1_700_000_001_000,
      eventId: 'xyz-789:1700000001000:expired',
    };

    // Sanity: before unsubscribe, the callback fires.
    for (const l of listeners.get('connector:status-changed') ?? []) l({}, validPayload);
    expect(callback).toHaveBeenCalledTimes(1);

    unsubscribe();

    // After unsubscribe, further "emits" must not reach the callback.
    for (const l of listeners.get('connector:status-changed') ?? []) l({}, validPayload);
    expect(callback).toHaveBeenCalledTimes(1);
  });
});
