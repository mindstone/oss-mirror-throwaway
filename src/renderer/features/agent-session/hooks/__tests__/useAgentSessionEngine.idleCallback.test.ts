// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type WindowWithIdleCallbacks = Window & {
  requestIdleCallback?: Window['requestIdleCallback'];
  cancelIdleCallback?: Window['cancelIdleCallback'];
};

/**
 * Contract harness for the idle-save scheduling branch inside useAgentSessionEngine.
 * The production logic currently lives inside a useEffect closure, so this pins the
 * scheduling + cleanup behavior directly.
 */
function createIdleSaveHarness(doSave: () => void) {
  let pendingIdleCallback: number | null = null;

  return {
    schedule() {
      if (pendingIdleCallback !== null) {
        if (typeof window.cancelIdleCallback === 'function') {
          window.cancelIdleCallback(pendingIdleCallback);
        } else {
          window.clearTimeout(pendingIdleCallback);
        }
      }

      if (typeof window.requestIdleCallback === 'function') {
        pendingIdleCallback = window.requestIdleCallback(doSave, { timeout: 500 });
      } else {
        pendingIdleCallback = window.setTimeout(doSave, 50) as unknown as number;
      }
    },

    cleanup() {
      if (pendingIdleCallback !== null) {
        if (typeof window.cancelIdleCallback === 'function') {
          window.cancelIdleCallback(pendingIdleCallback);
        } else {
          window.clearTimeout(pendingIdleCallback);
        }
      }
    },
  };
}

describe('useAgentSessionEngine idle callback contract', () => {
  const idleWindow = window as WindowWithIdleCallbacks;
  let originalRequestIdleCallback: WindowWithIdleCallbacks['requestIdleCallback'];
  let originalCancelIdleCallback: WindowWithIdleCallbacks['cancelIdleCallback'];

  beforeEach(() => {
    vi.restoreAllMocks();
    originalRequestIdleCallback = idleWindow.requestIdleCallback;
    originalCancelIdleCallback = idleWindow.cancelIdleCallback;
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
  });

  it('uses requestIdleCallback scheduling and cancelIdleCallback cleanup when available', () => {
    const doSave = vi.fn();
    const requestIdleCallback = vi
      .fn<Window['requestIdleCallback']>()
      .mockImplementationOnce(() => 101)
      .mockImplementationOnce(() => 202);
    const cancelIdleCallback = vi.fn<Window['cancelIdleCallback']>();

    idleWindow.requestIdleCallback = requestIdleCallback;
    idleWindow.cancelIdleCallback = cancelIdleCallback;

    const harness = createIdleSaveHarness(doSave);
    harness.schedule();
    harness.schedule();
    harness.cleanup();

    expect(requestIdleCallback).toHaveBeenCalledTimes(2);
    expect(requestIdleCallback).toHaveBeenNthCalledWith(1, doSave, { timeout: 500 });
    expect(cancelIdleCallback).toHaveBeenNthCalledWith(1, 101);
    expect(cancelIdleCallback).toHaveBeenNthCalledWith(2, 202);
    expect(doSave).not.toHaveBeenCalled();
  });

  it('falls back to setTimeout scheduling and clearTimeout cleanup when requestIdleCallback is unavailable', () => {
    const doSave = vi.fn();

    Reflect.deleteProperty(idleWindow, 'requestIdleCallback');
    Reflect.deleteProperty(idleWindow, 'cancelIdleCallback');

    const setTimeoutSpy = vi
      .spyOn(window, 'setTimeout')
      .mockImplementationOnce((() => 301) as unknown as typeof window.setTimeout)
      .mockImplementationOnce((() => 302) as unknown as typeof window.setTimeout);
    const clearTimeoutSpy = vi.spyOn(window, 'clearTimeout').mockImplementation(() => undefined);

    const harness = createIdleSaveHarness(doSave);
    harness.schedule();
    harness.schedule();
    harness.cleanup();

    expect(setTimeoutSpy).toHaveBeenCalledTimes(2);
    expect(setTimeoutSpy).toHaveBeenNthCalledWith(1, doSave, 50);
    expect(clearTimeoutSpy).toHaveBeenNthCalledWith(1, 301);
    expect(clearTimeoutSpy).toHaveBeenNthCalledWith(2, 302);
    expect(doSave).not.toHaveBeenCalled();
  });
});
