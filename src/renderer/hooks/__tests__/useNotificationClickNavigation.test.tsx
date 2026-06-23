// @vitest-environment happy-dom
/**
 * Behavioral tests for useNotificationClickNavigation
 * (260610 notification-click-conversation fix, plan Stage 4).
 *
 * Contracts under guard:
 *  - Pull-based consume: on mount and on each `notification:clicked` nudge the
 *    hook pulls the pending intent via the Zod-contracted
 *    `window.appApi.consumePendingNotificationClick()` and routes it through
 *    the injected adapters. The nudge itself is payload-free — the payload
 *    ONLY travels over the invoke channel, so there is no raw-send payload
 *    drift to guard against here (it is structurally meaningless).
 *  - Coalescing + queued rerun: concurrent mount/nudge triggers share ONE
 *    in-flight pull; a nudge during an in-flight pull queues exactly one
 *    follow-up pull (so a click landing mid-pull is never dropped, and never
 *    double-fetched).
 *  - Initial-check signal: `initialNotificationCheckComplete` flips via
 *    finally OR the 3s timeout, so startup conversation restore can never
 *    deadlock on a hung IPC pull; a late-resolving intent STILL routes (warn).
 *  - Routing: filePath takes priority over sessionId; startup-restore
 *    suppression is set only when a non-null intent exists.
 *  - enabled gating: disabled → no pull, no timer, no subscription.
 *
 * NOT covered here (lives in App.tsx adapters, see App.tsx
 * openNotificationConversation): attachment-guard confirmation and the
 * "conversation is gone" toast on a failed open.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { RefObject } from 'react';
import type { PendingNotificationClickIntent } from '@shared/ipc/channels/app';
import type { RendererLogPayload } from '@shared/types';
import { act, flushAsync, renderHook } from '@renderer/test-utils';
import { useNotificationClickNavigation } from '../useNotificationClickNavigation';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type ConsumeFn = () => Promise<PendingNotificationClickIntent | null>;

interface InstalledApis {
  consumeMock: ReturnType<typeof vi.fn>;
  fireNudge: () => void;
  unsubscribe: ReturnType<typeof vi.fn>;
  onNotificationClicked: ReturnType<typeof vi.fn>;
}

function installApis(consume: ConsumeFn, { withAppApi = true } = {}): InstalledApis {
  const consumeMock = vi.fn(consume);
  if (withAppApi) {
    (window as unknown as { appApi: unknown }).appApi = {
      consumePendingNotificationClick: consumeMock,
    };
  }

  let nudgeCallbacks: Array<() => void> = [];
  const unsubscribe = vi.fn();
  const onNotificationClicked = vi.fn((cb: () => void) => {
    nudgeCallbacks.push(cb);
    return () => {
      nudgeCallbacks = nudgeCallbacks.filter((existing) => existing !== cb);
      unsubscribe();
    };
  });
  (window as unknown as { api: unknown }).api = { onNotificationClicked };

  return {
    consumeMock,
    fireNudge: () => {
      for (const cb of [...nudgeCallbacks]) cb();
    },
    unsubscribe,
    onNotificationClicked,
  };
}

type OpenAdapterMock = ReturnType<typeof vi.fn<(target: string) => void | Promise<void>>>;
type EmitLogMock = ReturnType<typeof vi.fn<(payload: RendererLogPayload) => void>>;

interface HookArgs {
  enabled: boolean;
  startupConversationRestoreSuppressedRef: RefObject<boolean>;
  openNotificationConversation: OpenAdapterMock;
  openNotificationFile: OpenAdapterMock;
  emitLog: EmitLogMock;
  initialCheckTimeoutMs?: number;
}

function makeArgs(overrides: Partial<HookArgs> = {}): HookArgs {
  return {
    enabled: true,
    startupConversationRestoreSuppressedRef: { current: false },
    openNotificationConversation: vi.fn<(target: string) => void | Promise<void>>(),
    openNotificationFile: vi.fn<(target: string) => void | Promise<void>>(),
    emitLog: vi.fn<(payload: RendererLogPayload) => void>(),
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Consume mock with real store semantics: returns the pending intent once, then null. */
function makeStoreConsume(initial: PendingNotificationClickIntent | null): ConsumeFn {
  let pending = initial;
  return async () => {
    const value = pending;
    pending = null;
    return value;
  };
}

function warnMessages(emitLog: EmitLogMock): string[] {
  return emitLog.mock.calls
    .map(([payload]) => payload)
    .filter((payload) => payload.level === 'warn')
    .map((payload) => payload.message);
}

const intentFor = (sessionId: string): PendingNotificationClickIntent => ({
  sessionId,
  clickedAt: Date.now(),
});

afterEach(() => {
  delete (window as unknown as { appApi?: unknown }).appApi;
  delete (window as unknown as { api?: unknown }).api;
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('useNotificationClickNavigation — mount pull + routing', () => {
  it('drains a pre-existing intent on mount: routes by sessionId with suppression set first, completes initial check', async () => {
    const { consumeMock } = installApis(makeStoreConsume(intentFor('session-1')));
    const args = makeArgs();
    const suppressionWhenRouted: boolean[] = [];
    args.openNotificationConversation.mockImplementation(() => {
      suppressionWhenRouted.push(args.startupConversationRestoreSuppressedRef.current);
    });

    const { result } = renderHook(() => useNotificationClickNavigation(args));
    await flushAsync();

    expect(consumeMock).toHaveBeenCalledTimes(1);
    expect(args.openNotificationConversation).toHaveBeenCalledTimes(1);
    expect(args.openNotificationConversation).toHaveBeenCalledWith('session-1');
    expect(args.openNotificationFile).not.toHaveBeenCalled();
    // Suppression must already be set when the adapter runs, so startup
    // restore cannot override the notification navigation.
    expect(suppressionWhenRouted).toEqual([true]);
    expect(result.current.initialNotificationCheckComplete).toBe(true);
  });

  it('null pull is a no-op: no navigation, NO suppression, initial check still completes', async () => {
    const { consumeMock } = installApis(makeStoreConsume(null));
    const args = makeArgs();

    const { result } = renderHook(() => useNotificationClickNavigation(args));
    await flushAsync();

    expect(consumeMock).toHaveBeenCalledTimes(1);
    expect(args.openNotificationConversation).not.toHaveBeenCalled();
    expect(args.openNotificationFile).not.toHaveBeenCalled();
    // Suppression only on a real intent — a normal reload-restore must survive.
    expect(args.startupConversationRestoreSuppressedRef.current).toBe(false);
    expect(result.current.initialNotificationCheckComplete).toBe(true);
  });

  it('filePath takes priority over sessionId when both are present', async () => {
    installApis(makeStoreConsume({ sessionId: 's-1', filePath: '/space/notes.md', clickedAt: Date.now() }));
    const args = makeArgs();

    renderHook(() => useNotificationClickNavigation(args));
    await flushAsync();

    expect(args.openNotificationFile).toHaveBeenCalledTimes(1);
    expect(args.openNotificationFile).toHaveBeenCalledWith('/space/notes.md');
    expect(args.openNotificationConversation).not.toHaveBeenCalled();
    expect(args.startupConversationRestoreSuppressedRef.current).toBe(true);
  });
});

describe('useNotificationClickNavigation — nudge path', () => {
  it('a nudge after an idle mount triggers a fresh pull and routes the intent', async () => {
    let pending: PendingNotificationClickIntent | null = null;
    const { consumeMock, fireNudge } = installApis(async () => {
      const value = pending;
      pending = null;
      return value;
    });
    const args = makeArgs();

    renderHook(() => useNotificationClickNavigation(args));
    await flushAsync();
    expect(consumeMock).toHaveBeenCalledTimes(1);
    expect(args.openNotificationConversation).not.toHaveBeenCalled();

    pending = intentFor('session-nudged');
    act(() => fireNudge());
    await flushAsync();

    expect(consumeMock).toHaveBeenCalledTimes(2);
    expect(args.openNotificationConversation).toHaveBeenCalledTimes(1);
    expect(args.openNotificationConversation).toHaveBeenCalledWith('session-nudged');
  });

  it('RACE (a): a nudge during an in-flight pull coalesces, then queues exactly ONE follow-up pull that routes the intent', async () => {
    const firstPull = deferred<PendingNotificationClickIntent | null>();
    let call = 0;
    const lateIntent = intentFor('session-late');
    const { consumeMock, fireNudge } = installApis(async () => {
      call += 1;
      if (call === 1) return firstPull.promise;
      if (call === 2) return lateIntent;
      return null;
    });
    const args = makeArgs();

    renderHook(() => useNotificationClickNavigation(args));
    await flushAsync();
    expect(consumeMock).toHaveBeenCalledTimes(1);

    // Click lands while the mount pull is still in flight (e.g. the intent
    // was recorded in main JUST after the pull read an empty store).
    act(() => fireNudge());
    await Promise.resolve();
    // Coalesced: no concurrent second invoke while the first is in flight.
    expect(consumeMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      firstPull.resolve(null);
      await Promise.resolve();
    });
    await flushAsync();

    // Exactly one queued rerun — the nudge was not dropped and not duplicated.
    expect(consumeMock).toHaveBeenCalledTimes(2);
    expect(args.openNotificationConversation).toHaveBeenCalledTimes(1);
    expect(args.openNotificationConversation).toHaveBeenCalledWith('session-late');
  });

  it('RACE (a, intent-on-first-pull): coalesced mount+nudge never double-navigates', async () => {
    const firstPull = deferred<PendingNotificationClickIntent | null>();
    let resolvedOnce = false;
    const { consumeMock, fireNudge } = installApis(async () => {
      if (!resolvedOnce) {
        resolvedOnce = true;
        return firstPull.promise;
      }
      return null; // store is consume-once: drained after the first hit
    });
    const args = makeArgs();

    renderHook(() => useNotificationClickNavigation(args));
    await flushAsync();

    act(() => fireNudge());
    await act(async () => {
      firstPull.resolve(intentFor('session-once'));
      await Promise.resolve();
    });
    await flushAsync();

    // The queued rerun ran (2 pulls) but only the hit navigated.
    expect(consumeMock).toHaveBeenCalledTimes(2);
    expect(args.openNotificationConversation).toHaveBeenCalledTimes(1);
    expect(args.openNotificationConversation).toHaveBeenCalledWith('session-once');
  });
});

describe('useNotificationClickNavigation — initial-check signal + timeout', () => {
  it('RACE (b): a hung pull times out (restore unblocked, warn), and the late intent STILL routes with a warn', async () => {
    vi.useFakeTimers();
    const hungPull = deferred<PendingNotificationClickIntent | null>();
    installApis(() => hungPull.promise);
    const args = makeArgs();

    const { result } = renderHook(() => useNotificationClickNavigation(args));
    expect(result.current.initialNotificationCheckComplete).toBe(false);

    await act(async () => {
      vi.advanceTimersByTime(3000);
      await Promise.resolve();
    });

    // Timeout unblocks startup restore even though the pull is still hung.
    expect(result.current.initialNotificationCheckComplete).toBe(true);
    expect(warnMessages(args.emitLog)).toContain('Initial notification click consume timed out');
    expect(args.openNotificationConversation).not.toHaveBeenCalled();

    // The IPC result finally arrives: deliberate late-intent semantics —
    // still route (final surface = what the user clicked), and warn.
    await act(async () => {
      hungPull.resolve(intentFor('session-slow'));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(args.openNotificationConversation).toHaveBeenCalledTimes(1);
    expect(args.openNotificationConversation).toHaveBeenCalledWith('session-slow');
    expect(warnMessages(args.emitLog)).toContain(
      'notification intent resolved after initial-check timeout; routing anyway',
    );
  });

  it('a rejected pull completes the initial check via finally, warns, and does not navigate', async () => {
    installApis(() => Promise.reject(new Error('ipc broke')));
    const args = makeArgs();

    const { result } = renderHook(() => useNotificationClickNavigation(args));
    await flushAsync();

    expect(result.current.initialNotificationCheckComplete).toBe(true);
    expect(warnMessages(args.emitLog)).toContain('Notification click consume failed');
    expect(args.openNotificationConversation).not.toHaveBeenCalled();
    expect(args.startupConversationRestoreSuppressedRef.current).toBe(false);
  });

  it('a missing appApi bridge warns, does not throw, and completes the initial check', async () => {
    installApis(makeStoreConsume(null), { withAppApi: false });
    const args = makeArgs();

    const { result } = renderHook(() => useNotificationClickNavigation(args));
    await flushAsync();

    expect(result.current.initialNotificationCheckComplete).toBe(true);
    expect(warnMessages(args.emitLog)).toContain('Notification click consume channel is unavailable');
    expect(args.openNotificationConversation).not.toHaveBeenCalled();
  });

  it('an adapter rejection still releases the in-flight pull and completes the initial check', async () => {
    installApis(makeStoreConsume(intentFor('session-bad')));
    const args = makeArgs({
      openNotificationConversation: vi.fn<(target: string) => void | Promise<void>>()
        .mockRejectedValue(new Error('open failed')),
    });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { result } = renderHook(() => useNotificationClickNavigation(args));
    await flushAsync();
    await flushAsync();

    expect(args.openNotificationConversation).toHaveBeenCalledTimes(1);
    expect(result.current.initialNotificationCheckComplete).toBe(true);
    // fireAndForget swallowed the rejection (no unhandled rejection).
    expect(consoleError).toHaveBeenCalled();
  });
});

describe('useNotificationClickNavigation — enabled gating + lifecycle', () => {
  it('enabled=false: no pull, no subscription, and no timeout ever fires', async () => {
    vi.useFakeTimers();
    const { consumeMock, onNotificationClicked } = installApis(makeStoreConsume(intentFor('session-x')));
    const args = makeArgs({ enabled: false });

    const { result } = renderHook(() => useNotificationClickNavigation(args));
    await act(async () => {
      vi.advanceTimersByTime(10_000);
      await Promise.resolve();
    });

    expect(consumeMock).not.toHaveBeenCalled();
    expect(onNotificationClicked).not.toHaveBeenCalled();
    expect(args.emitLog).not.toHaveBeenCalled();
    expect(result.current.initialNotificationCheckComplete).toBe(false);
  });

  it('pulls once enabled flips false → true (the real App.tsx shouldRenderMainApp sequence)', async () => {
    const { consumeMock } = installApis(makeStoreConsume(intentFor('session-enabled-later')));
    const args = makeArgs({ enabled: false });

    const { rerender } = renderHook(
      (props: HookArgs) => useNotificationClickNavigation(props),
      { initialProps: args },
    );
    await flushAsync();
    expect(consumeMock).not.toHaveBeenCalled();

    rerender({ ...args, enabled: true });
    await flushAsync();

    expect(consumeMock).toHaveBeenCalledTimes(1);
    expect(args.openNotificationConversation).toHaveBeenCalledWith('session-enabled-later');
  });

  it('unsubscribes from the nudge on unmount', async () => {
    const { unsubscribe } = installApis(makeStoreConsume(null));
    const args = makeArgs();

    const { unmount } = renderHook(() => useNotificationClickNavigation(args));
    await flushAsync();
    unmount();

    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('RACE (c): StrictMode double-mount coalesces to a single navigation', async () => {
    const { consumeMock } = installApis(makeStoreConsume(intentFor('session-strict')));
    const args = makeArgs();

    const TestComponent = () => {
      useNotificationClickNavigation(args);
      return null;
    };

    const container = document.createElement('div');
    document.body.appendChild(container);
    let root: Root;
    await act(async () => {
      root = createRoot(container);
      root.render(
        <React.StrictMode>
          <TestComponent />
        </React.StrictMode>,
      );
    });
    await flushAsync();
    await flushAsync();

    // StrictMode runs the mount effect twice; the in-flight coalescing plus
    // consume-once store semantics must yield exactly one navigation.
    expect(args.openNotificationConversation).toHaveBeenCalledTimes(1);
    expect(args.openNotificationConversation).toHaveBeenCalledWith('session-strict');
    // No runaway pull loop either (initial + at most one queued rerun per remount).
    expect(consumeMock.mock.calls.length).toBeLessThanOrEqual(3);

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });
});
