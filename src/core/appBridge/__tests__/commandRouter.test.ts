/**
 * Stage 3 CommandRouter coverage.
 *
 * The Stage 1 stubs are gone; dispatch now actually sends JSON over the
 * socket, tracks pending correlations, times out, and maintains a
 * recent-history cache to back the `prevCommandId` idempotency guard
 * (R19 / D22).
 *
 * @see docs/plans/260418_rebel_app_bridge_and_browser_extension.md
 */

import { describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { CommandRouter } from '@core/appBridge/server/commandRouter';
import { ConnectionManager } from '@core/appBridge/server/connectionManager';
import { ErrorCode } from '@core/appBridge/shared/errors';

interface FakeSocket {
  readyState: number;
  close: () => void;
  terminate: () => void;
  send: ReturnType<typeof vi.fn>;
}

function mockSocket(): FakeSocket & WebSocket {
  const send = vi.fn((_payload: string, cb?: (err?: Error | null) => void) => {
    if (typeof cb === 'function') cb(null);
  });
  return {
    readyState: WebSocket.OPEN,
    close: vi.fn(),
    terminate: vi.fn(),
    send,
  } as unknown as FakeSocket & WebSocket;
}

function lastSentPayload(socket: FakeSocket & WebSocket): Record<string, unknown> {
  const call = socket.send.mock.calls.at(-1);
  if (!call) throw new Error('send() was not called');
  const payload = call[0] as string;
  return JSON.parse(payload) as Record<string, unknown>;
}

describe('appBridge/server/commandRouter', () => {
  it('dispatch throws APP_NOT_CONNECTED when no connection exists for the app', async () => {
    const cm = new ConnectionManager();
    const router = new CommandRouter(cm);

    await expect(
      router.dispatch({ appId: 'browser-extension', capability: 'read_page', payload: {} }),
    ).rejects.toMatchObject({
      code: ErrorCode.APP_NOT_CONNECTED,
      status: 503,
    });
  });

  it('legacy routeCommand() throws APP_NOT_CONNECTED when no connection exists', async () => {
    const cm = new ConnectionManager();
    const router = new CommandRouter(cm);

    await expect(
      router.routeCommand('browser-extension', 'read_page', {}),
    ).rejects.toMatchObject({ code: ErrorCode.APP_NOT_CONNECTED });
  });

  it('dispatch sends a well-formed command frame over the socket', async () => {
    const cm = new ConnectionManager();
    const socket = mockSocket();
    cm.register('browser-extension', '0.1.0', socket);
    const router = new CommandRouter(cm);

    const promise = router.dispatch({
      appId: 'browser-extension',
      capability: 'read_page',
      payload: { url: 'https://example.com' },
    });

    expect(socket.send).toHaveBeenCalledTimes(1);
    const payload = lastSentPayload(socket);
    expect(payload['type']).toBe('command');
    expect(payload['action']).toBe('read_page');
    expect(payload['params']).toEqual({ url: 'https://example.com' });
    expect(typeof payload['id']).toBe('string');

    router.handleResponse({
      type: 'response',
      id: payload['id'] as string,
      success: true,
      data: { ok: true },
    });
    await expect(promise).resolves.toMatchObject({ success: true, data: { ok: true } });
  });

  it('handleResponse resolves the matching pending command', async () => {
    const cm = new ConnectionManager();
    const socket = mockSocket();
    cm.register('browser-extension', '0.1.0', socket);
    const router = new CommandRouter(cm);

    const promise = router.dispatch({
      appId: 'browser-extension',
      capability: 'read_page',
      payload: {},
    });
    const commandId = lastSentPayload(socket)['id'] as string;

    router.handleResponse({ type: 'response', id: commandId, success: true, data: { page: 'x' } });
    await expect(promise).resolves.toEqual({ success: true, data: { page: 'x' }, commandId });
  });

  it('dispatch rejects with COMMAND_TIMEOUT when no response arrives within timeoutMs', async () => {
    vi.useFakeTimers();
    try {
      const cm = new ConnectionManager();
      const socket = mockSocket();
      cm.register('browser-extension', '0.1.0', socket);
      const router = new CommandRouter(cm, { timeoutMs: 50 });

      const promise = router.dispatch({
        appId: 'browser-extension',
        capability: 'read_page',
        payload: {},
      });
      // Attach the rejection handler BEFORE advancing fake timers so the
      // rejection is synchronous-handled and doesn't print an unhandled-
      // rejection warning.
      const assertion = expect(promise).rejects.toMatchObject({
        code: ErrorCode.COMMAND_TIMEOUT,
      });

      await vi.advanceTimersByTimeAsync(100);
      await assertion;
      expect(router.getPendingCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('handleResponse after timeout is logged as a late response and marks history', async () => {
    vi.useFakeTimers();
    try {
      const cm = new ConnectionManager();
      const socket = mockSocket();
      cm.register('browser-extension', '0.1.0', socket);
      const router = new CommandRouter(cm, { timeoutMs: 50, recentHistoryTtlMs: 10_000 });

      const promise = router.dispatch({
        appId: 'browser-extension',
        capability: 'read_page',
        payload: {},
      });
      const commandId = lastSentPayload(socket)['id'] as string;
      const assertion = expect(promise).rejects.toMatchObject({
        code: ErrorCode.COMMAND_TIMEOUT,
      });

      // Let the timeout fire.
      await vi.advanceTimersByTimeAsync(100);
      await assertion;

      // Late response arrives. Should be silently consumed + history updated.
      router.handleResponse({ type: 'response', id: commandId, success: true, data: { late: true } });

      const lookup = router.lookupRecent(commandId);
      expect(lookup.kind).toBe('expired');
      if (lookup.kind === 'expired') {
        expect(lookup.wasLateResponse).toBe(true);
        expect(lookup.appId).toBe('browser-extension');
        expect(lookup.capability).toBe('read_page');
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('dispatch with prevCommandId=<late-response-id> rejects with IDEMPOTENT_DROP', async () => {
    vi.useFakeTimers();
    try {
      const cm = new ConnectionManager();
      const socket = mockSocket();
      cm.register('browser-extension', '0.1.0', socket);
      const router = new CommandRouter(cm, { timeoutMs: 50, recentHistoryTtlMs: 10_000 });

      const firstPromise = router.dispatch({
        appId: 'browser-extension',
        capability: 'read_page',
        payload: {},
      });
      const firstId = lastSentPayload(socket)['id'] as string;
      const firstAssertion = expect(firstPromise).rejects.toMatchObject({
        code: ErrorCode.COMMAND_TIMEOUT,
      });

      await vi.advanceTimersByTimeAsync(100);
      await firstAssertion;

      router.handleResponse({ type: 'response', id: firstId, success: true, data: { late: true } });

      await expect(
        router.dispatch({
          appId: 'browser-extension',
          capability: 'read_page',
          payload: {},
          prevCommandId: firstId,
        }),
      ).rejects.toMatchObject({ code: ErrorCode.IDEMPOTENT_DROP, status: 409 });
    } finally {
      vi.useRealTimers();
    }
  });

  it('dispatch with prevCommandId referencing an unknown id goes through normally', async () => {
    const cm = new ConnectionManager();
    const socket = mockSocket();
    cm.register('browser-extension', '0.1.0', socket);
    const router = new CommandRouter(cm);

    const promise = router.dispatch({
      appId: 'browser-extension',
      capability: 'read_page',
      payload: {},
      prevCommandId: 'does-not-exist-id',
    });

    // The command frame should have been sent and include the prevCommandId.
    const payload = lastSentPayload(socket);
    expect(payload['prevCommandId']).toBe('does-not-exist-id');

    router.handleResponse({
      type: 'response',
      id: payload['id'] as string,
      success: true,
      data: { ok: true },
    });
    await expect(promise).resolves.toMatchObject({ success: true });
  });

  it('rejectPending(appId, ADDIN_DISCONNECTED) rejects outstanding commands for that app', async () => {
    const cm = new ConnectionManager();
    const socket = mockSocket();
    cm.register('browser-extension', '0.1.0', socket);
    const router = new CommandRouter(cm, { timeoutMs: 10_000 });

    const p1 = router.dispatch({
      appId: 'browser-extension',
      capability: 'read_page',
      payload: {},
    });

    router.rejectPending('browser-extension', ErrorCode.ADDIN_DISCONNECTED);

    await expect(p1).rejects.toMatchObject({ code: ErrorCode.ADDIN_DISCONNECTED });
    expect(router.getPendingCount()).toBe(0);
  });

  it('legacy rejectPendingForApp(app) rejects outstanding commands with ADDIN_DISCONNECTED', async () => {
    const cm = new ConnectionManager();
    const socket = mockSocket();
    cm.register('browser-extension', '0.1.0', socket);
    const router = new CommandRouter(cm, { timeoutMs: 10_000 });

    const p1 = router.dispatch({
      appId: 'browser-extension',
      capability: 'read_page',
      payload: {},
    });

    router.rejectPendingForApp('browser-extension');
    await expect(p1).rejects.toMatchObject({ code: ErrorCode.ADDIN_DISCONNECTED });
  });

  it('recent-history TTL defaults to 2× timeoutMs and can be overridden', () => {
    const cm = new ConnectionManager();
    const router1 = new CommandRouter(cm, { timeoutMs: 5_000 });
    expect(router1.getRecentHistoryTtlMs()).toBe(10_000);

    const router2 = new CommandRouter(cm, { timeoutMs: 5_000, recentHistoryTtlMs: 99 });
    expect(router2.getRecentHistoryTtlMs()).toBe(99);
  });

  it('recent-history entries expire after the TTL', async () => {
    vi.useFakeTimers();
    try {
      const cm = new ConnectionManager();
      const socket = mockSocket();
      cm.register('browser-extension', '0.1.0', socket);
      const router = new CommandRouter(cm, { timeoutMs: 50, recentHistoryTtlMs: 100 });

      const promise = router.dispatch({
        appId: 'browser-extension',
        capability: 'read_page',
        payload: {},
      });
      const commandId = lastSentPayload(socket)['id'] as string;
      const assertion = expect(promise).rejects.toMatchObject({
        code: ErrorCode.COMMAND_TIMEOUT,
      });

      await vi.advanceTimersByTimeAsync(70);
      await assertion;

      // Immediately after timeout, cache holds the entry.
      expect(router.lookupRecent(commandId).kind).toBe('expired');

      // After TTL expiry window, entry is gone.
      await vi.advanceTimersByTimeAsync(500);
      expect(router.lookupRecent(commandId).kind).toBe('unknown');
    } finally {
      vi.useRealTimers();
    }
  });

  it('handleResponse with unknown commandId is a no-op (no throw)', () => {
    const cm = new ConnectionManager();
    const router = new CommandRouter(cm);
    expect(() =>
      router.handleResponse({ type: 'response', id: 'unknown-id', success: true, data: {} }),
    ).not.toThrow();
  });

  it('dispose rejects outstanding commands and then refuses further dispatch', async () => {
    const cm = new ConnectionManager();
    const socket = mockSocket();
    cm.register('browser-extension', '0.1.0', socket);
    const router = new CommandRouter(cm, { timeoutMs: 10_000 });

    const p1 = router.dispatch({
      appId: 'browser-extension',
      capability: 'read_page',
      payload: {},
    });

    router.dispose();
    await expect(p1).rejects.toMatchObject({ code: ErrorCode.INTERNAL_ERROR });
    await expect(
      router.dispatch({
        appId: 'browser-extension',
        capability: 'read_page',
        payload: {},
      }),
    ).rejects.toMatchObject({ code: ErrorCode.INTERNAL_ERROR });
  });

  it('stores the configured timeout for Stage 3 consumption', () => {
    const cm = new ConnectionManager();
    const router = new CommandRouter(cm, { timeoutMs: 1234 });
    expect(router.getTimeoutMs()).toBe(1234);
  });

  it('defaults timeoutMs to 30_000 when unspecified', () => {
    const cm = new ConnectionManager();
    const router = new CommandRouter(cm);
    expect(router.getTimeoutMs()).toBe(30_000);
  });

  // -------------------------------------------------------------------------
  // Stage 6c — tabContext forwarding + TAB_CONTEXT_GONE surfacing (R18 / D21)
  // -------------------------------------------------------------------------

  it('dispatch forwards tabContext on the command frame verbatim (R18)', async () => {
    const cm = new ConnectionManager();
    const socket = mockSocket();
    cm.register('browser-extension', '0.1.0', socket);
    const router = new CommandRouter(cm);

    const promise = router.dispatch({
      appId: 'browser-extension',
      capability: 'read_page',
      payload: { maxChars: 10_000 },
      tabContext: {
        tabId: 42,
        windowId: 1,
        url: 'https://example.com/a',
        title: 'A',
      },
    });
    const payload = lastSentPayload(socket);
    expect(payload['tabContext']).toEqual({
      tabId: 42,
      windowId: 1,
      url: 'https://example.com/a',
      title: 'A',
    });
    expect(payload['action']).toBe('read_page');

    // Settle the promise so the test doesn't leave a pending request.
    router.handleResponse({
      type: 'response',
      id: payload['id'] as string,
      success: true,
      data: {},
    });
    await expect(promise).resolves.toMatchObject({ success: true });
  });

  it('dispatch omits tabContext from the command frame when the caller did not pass one', async () => {
    const cm = new ConnectionManager();
    const socket = mockSocket();
    cm.register('browser-extension', '0.1.0', socket);
    const router = new CommandRouter(cm);

    const promise = router.dispatch({
      appId: 'browser-extension',
      capability: 'status',
      payload: {},
    });
    const payload = lastSentPayload(socket);
    expect('tabContext' in payload).toBe(false);
    router.handleResponse({
      type: 'response',
      id: payload['id'] as string,
      success: true,
      data: {},
    });
    await promise;
  });

  it('extension TAB_CONTEXT_GONE response → dispatch rejects with AppBridgeError (no silent retry) (R18)', async () => {
    const cm = new ConnectionManager();
    const socket = mockSocket();
    cm.register('browser-extension', '0.1.0', socket);
    const router = new CommandRouter(cm);

    const promise = router.dispatch({
      appId: 'browser-extension',
      capability: 'read_page',
      payload: {},
      tabContext: { tabId: 99 },
    });
    const commandId = lastSentPayload(socket)['id'] as string;

    router.handleResponse({
      type: 'response',
      id: commandId,
      success: false,
      error: 'Tab 99 not found',
      code: 'TAB_CONTEXT_GONE',
    });

    await expect(promise).rejects.toMatchObject({
      code: ErrorCode.TAB_CONTEXT_GONE,
      status: 410,
    });
    // The dispatcher must NOT automatically retry on another tab — the
    // failure is exposed to the caller.
    expect(socket.send).toHaveBeenCalledTimes(1);
  });

  it('non-TAB_CONTEXT_GONE extension errors still resolve the promise with success=false (unchanged behaviour)', async () => {
    const cm = new ConnectionManager();
    const socket = mockSocket();
    cm.register('browser-extension', '0.1.0', socket);
    const router = new CommandRouter(cm);

    const promise = router.dispatch({
      appId: 'browser-extension',
      capability: 'fill_form',
      payload: {},
    });
    const commandId = lastSentPayload(socket)['id'] as string;
    router.handleResponse({
      type: 'response',
      id: commandId,
      success: false,
      error: 'field missing',
      code: 'BAD_REQUEST',
    });
    const resolved = await promise;
    expect(resolved.success).toBe(false);
    if (!resolved.success) {
      expect(resolved.code).toBe('BAD_REQUEST');
    }
  });

  it('preserves response details on non-success command responses', async () => {
    const cm = new ConnectionManager();
    const socket = mockSocket();
    cm.register('browser-extension', '0.1.0', socket);
    const router = new CommandRouter(cm);

    const promise = router.dispatch({
      appId: 'browser-extension',
      capability: 'read_page',
      payload: {},
    });
    const commandId = lastSentPayload(socket)['id'] as string;
    router.handleResponse({
      type: 'response',
      id: commandId,
      success: false,
      error: 'injection refused',
      code: 'INJECTION_REFUSED',
      details: { reason: 'no-host-permission' },
    });

    const resolved = await promise;
    expect(resolved.success).toBe(false);
    if (!resolved.success) {
      expect(resolved.details).toEqual({ reason: 'no-host-permission' });
    }
  });
});
