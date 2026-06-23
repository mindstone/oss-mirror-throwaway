// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type WindowWithIdleCallbacks = Window & {
  requestIdleCallback?: Window['requestIdleCallback'];
  cancelIdleCallback?: Window['cancelIdleCallback'];
};

/**
 * Contract harness for the visibilitychange:hidden safety-net inside
 * useAgentSessionEngine (FOX-3148 D1). Mirrors the production logic so we can
 * pin behavior without booting the full hook.
 *
 * Contract (from the planning doc):
 *  - When `visibilitychange` fires with state `hidden` AND there is a pending
 *    idle save AND sessionsLoadComplete is true → cancel the pending idle
 *    callback and invoke doSave immediately.
 *  - When no pending idle save is queued → no save.
 *  - When sessionsLoadComplete is false → no save.
 *  - When visibilityState is anything other than `hidden` → no save.
 */
function createVisibilityHarness(
  doSave: () => void,
  getSessionsLoadComplete: () => boolean
) {
  let pendingIdleCallback: number | null = null;

  const cancelPendingIdleCallback = () => {
    if (pendingIdleCallback === null) return;
    if (typeof window.cancelIdleCallback === 'function') {
      window.cancelIdleCallback(pendingIdleCallback);
    } else {
      window.clearTimeout(pendingIdleCallback);
    }
    pendingIdleCallback = null;
  };

  const scheduleIdleSave = () => {
    if (!getSessionsLoadComplete()) return;
    cancelPendingIdleCallback();
    if (typeof window.requestIdleCallback === 'function') {
      pendingIdleCallback = window.requestIdleCallback(() => {
        pendingIdleCallback = null;
        doSave();
      }, { timeout: 500 });
    } else {
      pendingIdleCallback = window.setTimeout(() => {
        pendingIdleCallback = null;
        doSave();
      }, 50) as unknown as number;
    }
  };

  const handleVisibilityChange = () => {
    if (document.visibilityState !== 'hidden') return;
    if (!getSessionsLoadComplete()) return;
    if (pendingIdleCallback === null) return;
    cancelPendingIdleCallback();
    doSave();
  };

  return {
    scheduleIdleSave,
    handleVisibilityChange,
    get hasPending() {
      return pendingIdleCallback !== null;
    },
    cleanup: cancelPendingIdleCallback,
  };
}

function setVisibilityState(state: DocumentVisibilityState) {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => state,
  });
}

describe('useAgentSessionEngine visibilitychange:hidden contract (FOX-3148 D1)', () => {
  const idleWindow = window as WindowWithIdleCallbacks;
  let originalRequestIdleCallback: WindowWithIdleCallbacks['requestIdleCallback'];
  let originalCancelIdleCallback: WindowWithIdleCallbacks['cancelIdleCallback'];

  beforeEach(() => {
    vi.restoreAllMocks();
    originalRequestIdleCallback = idleWindow.requestIdleCallback;
    originalCancelIdleCallback = idleWindow.cancelIdleCallback;
    setVisibilityState('visible');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalRequestIdleCallback) {
      idleWindow.requestIdleCallback = originalRequestIdleCallback;
    } else {
      Reflect.deleteProperty(idleWindow, 'requestIdleCallback');
    }
    if (originalCancelIdleCallback) {
      idleWindow.cancelIdleCallback = originalCancelIdleCallback;
    } else {
      Reflect.deleteProperty(idleWindow, 'cancelIdleCallback');
    }
    setVisibilityState('visible');
  });

  it('flushes a pending idle save when the document becomes hidden', () => {
    const doSave = vi.fn();
    const requestIdleCallback = vi
      .fn<Window['requestIdleCallback']>()
      .mockImplementation(() => 1001);
    const cancelIdleCallback = vi.fn<Window['cancelIdleCallback']>();

    idleWindow.requestIdleCallback = requestIdleCallback;
    idleWindow.cancelIdleCallback = cancelIdleCallback;

    const harness = createVisibilityHarness(doSave, () => true);
    harness.scheduleIdleSave();
    expect(harness.hasPending).toBe(true);
    expect(doSave).not.toHaveBeenCalled();

    setVisibilityState('hidden');
    harness.handleVisibilityChange();

    expect(cancelIdleCallback).toHaveBeenCalledWith(1001);
    expect(doSave).toHaveBeenCalledTimes(1);
    expect(harness.hasPending).toBe(false);
  });

  it('does nothing when visibilityState becomes hidden but no save is pending', () => {
    const doSave = vi.fn();
    const requestIdleCallback = vi
      .fn<Window['requestIdleCallback']>()
      .mockImplementation(() => 1002);
    const cancelIdleCallback = vi.fn<Window['cancelIdleCallback']>();

    idleWindow.requestIdleCallback = requestIdleCallback;
    idleWindow.cancelIdleCallback = cancelIdleCallback;

    const harness = createVisibilityHarness(doSave, () => true);

    setVisibilityState('hidden');
    harness.handleVisibilityChange();

    expect(doSave).not.toHaveBeenCalled();
    expect(cancelIdleCallback).not.toHaveBeenCalled();
  });

  it('does nothing when visibilityState is not hidden (re-show)', () => {
    const doSave = vi.fn();
    const requestIdleCallback = vi
      .fn<Window['requestIdleCallback']>()
      .mockImplementation(() => 1003);
    const cancelIdleCallback = vi.fn<Window['cancelIdleCallback']>();

    idleWindow.requestIdleCallback = requestIdleCallback;
    idleWindow.cancelIdleCallback = cancelIdleCallback;

    const harness = createVisibilityHarness(doSave, () => true);
    harness.scheduleIdleSave();

    setVisibilityState('visible');
    harness.handleVisibilityChange();

    expect(doSave).not.toHaveBeenCalled();
    expect(cancelIdleCallback).not.toHaveBeenCalled();
    expect(harness.hasPending).toBe(true); // still pending
  });

  it('does nothing when sessions have not loaded yet (guard)', () => {
    const doSave = vi.fn();
    const requestIdleCallback = vi
      .fn<Window['requestIdleCallback']>()
      .mockImplementation(() => 1004);
    const cancelIdleCallback = vi.fn<Window['cancelIdleCallback']>();

    idleWindow.requestIdleCallback = requestIdleCallback;
    idleWindow.cancelIdleCallback = cancelIdleCallback;

    let sessionsLoaded = false;
    const harness = createVisibilityHarness(doSave, () => sessionsLoaded);
    harness.scheduleIdleSave();
    expect(harness.hasPending).toBe(false); // schedule is gated

    // Even if somehow a pending callback existed, load-complete guard must block
    sessionsLoaded = true;
    harness.scheduleIdleSave();
    sessionsLoaded = false;
    setVisibilityState('hidden');
    harness.handleVisibilityChange();

    expect(doSave).not.toHaveBeenCalled();
  });

  it('uses setTimeout fallback when requestIdleCallback is unavailable', () => {
    Reflect.deleteProperty(idleWindow, 'requestIdleCallback');
    Reflect.deleteProperty(idleWindow, 'cancelIdleCallback');

    const doSave = vi.fn();
    const setTimeoutSpy = vi
      .spyOn(window, 'setTimeout')
      .mockImplementationOnce((() => 2001) as unknown as typeof window.setTimeout);
    const clearTimeoutSpy = vi.spyOn(window, 'clearTimeout').mockImplementation(() => undefined);

    const harness = createVisibilityHarness(doSave, () => true);
    harness.scheduleIdleSave();
    expect(setTimeoutSpy).toHaveBeenCalledTimes(1);
    expect(harness.hasPending).toBe(true);

    setVisibilityState('hidden');
    harness.handleVisibilityChange();

    expect(clearTimeoutSpy).toHaveBeenCalledWith(2001);
    expect(doSave).toHaveBeenCalledTimes(1);
  });
});
