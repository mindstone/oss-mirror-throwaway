// @vitest-environment happy-dom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OfficeSidecarStatusSection } from '../OfficeSidecarStatusSection';
import type {
  OfficeSidecarRetryStartResponse,
  OfficeSidecarStatusResponse,
} from '@shared/ipc/channels/officeSidecar';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface Mounted {
  container: HTMLDivElement;
  root: Root;
  unmount: () => void;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

function defer<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function mount(ui: React.ReactElement): Mounted {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(ui);
  });
  return {
    container,
    root,
    unmount: () => {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

async function flushAsyncWork(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

function setOfficeSidecarApi(api: {
  getStatus: () => Promise<OfficeSidecarStatusResponse>;
  retryStart: () => Promise<OfficeSidecarRetryStartResponse>;
}): void {
  Object.assign(window, { officeSidecarApi: api });
}

const runningStatus: OfficeSidecarStatusResponse = {
  running: true,
  port: 52100,
  adopted: false,
  skipReason: null,
  lastError: null,
  startedAt: 1_717_171_000,
};

const failedStatus: OfficeSidecarStatusResponse = {
  running: false,
  port: null,
  adopted: false,
  skipReason: null,
  lastError: {
    code: 'port-in-use',
    message: 'Port 52100 is already in use by another program.',
    at: 1_717_171_111,
  },
  startedAt: null,
};

const degradedStatus: OfficeSidecarStatusResponse = {
  running: true,
  port: 52100,
  adopted: false,
  skipReason: null,
  lastError: {
    code: 'wef-install-failed',
    message: "Couldn't register the Office add-in with the system.",
    at: 1_717_171_333,
  },
  startedAt: 1_717_171_000,
};

describe('OfficeSidecarStatusSection', () => {
  let mounted: Mounted | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
    mounted = null;
  });

  afterEach(() => {
    mounted?.unmount();
    mounted = null;
    document.body.innerHTML = '';
    vi.clearAllMocks();
    vi.useRealTimers();
    Reflect.deleteProperty(window as unknown as Record<string, unknown>, 'officeSidecarApi');
  });

  it('shows a loading state while the initial status request is pending', async () => {
    const pendingStatus = defer<OfficeSidecarStatusResponse>();
    setOfficeSidecarApi({
      getStatus: vi.fn(() => pendingStatus.promise),
      retryStart: vi.fn(async () => ({
        restarted: false,
        port: null,
        adopted: false,
        skipReason: null,
        error: null,
      })),
    });

    mounted = mount(<OfficeSidecarStatusSection />);

    expect(mounted.container.querySelector('[data-testid="office-sidecar-status-loading"]')).not.toBeNull();

    pendingStatus.resolve(runningStatus);
    await flushAsyncWork();
  });

  it('renders the connected state and polls again every 5 seconds', async () => {
    const getStatus = vi.fn(async () => runningStatus);
    setOfficeSidecarApi({
      getStatus,
      retryStart: vi.fn(async () => ({
        restarted: true,
        port: 52100,
        adopted: false,
        skipReason: null,
        error: null,
      })),
    });

    mounted = mount(<OfficeSidecarStatusSection />);
    await flushAsyncWork();

    expect(mounted.container.querySelector('[data-testid="office-sidecar-status-running"]')?.textContent).toContain('Connected');

    const advancedToggle = mounted.container.querySelector('[data-testid="office-sidecar-advanced-toggle"]') as HTMLButtonElement | null;
    expect(advancedToggle).not.toBeNull();
    act(() => {
      advancedToggle!.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    });
    expect(mounted.container.querySelector('[data-testid="office-sidecar-advanced-content"]')?.textContent).toContain('port 52100');

    await act(async () => {
      vi.advanceTimersByTime(5_000);
      await Promise.resolve();
    });
    expect(getStatus).toHaveBeenCalledTimes(2);
  });

  it('renders the startup failure state and retries when asked', async () => {
    const getStatus = vi.fn(async (): Promise<OfficeSidecarStatusResponse> => failedStatus);
    const retryStart = vi.fn(async (): Promise<OfficeSidecarRetryStartResponse> => ({
      restarted: false,
      port: null,
      adopted: false,
      skipReason: null,
      error: {
        code: 'port-in-use',
        message: 'Port 52100 is already in use by another program.',
        at: 1_717_171_222,
      },
    }));

    setOfficeSidecarApi({ getStatus, retryStart });

    mounted = mount(<OfficeSidecarStatusSection />);
    await flushAsyncWork();

    expect(mounted.container.querySelector('[data-testid="office-sidecar-status-failed"]')?.textContent)
      .toContain('Port 52100 is already in use by another program.');

    const tryAgainButton = Array.from(mounted.container.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('Try again')) as HTMLButtonElement | undefined;
    expect(tryAgainButton).toBeDefined();

    await act(async () => {
      tryAgainButton!.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(retryStart).toHaveBeenCalledTimes(1);
  });

  it('keeps the retry result when a stale poll resolves afterward', async () => {
    const stalePoll = defer<OfficeSidecarStatusResponse>();
    const getStatus = vi.fn<() => Promise<OfficeSidecarStatusResponse>>()
      .mockResolvedValueOnce(failedStatus)
      .mockImplementationOnce(() => stalePoll.promise)
      .mockResolvedValueOnce(runningStatus);
    const retryStart = vi.fn(async (): Promise<OfficeSidecarRetryStartResponse> => ({
      restarted: true,
      port: 52100,
      adopted: false,
      skipReason: null,
      error: null,
    }));

    setOfficeSidecarApi({ getStatus, retryStart });

    mounted = mount(<OfficeSidecarStatusSection />);
    await flushAsyncWork();

    await act(async () => {
      vi.advanceTimersByTime(5_000);
      await Promise.resolve();
    });
    expect(getStatus).toHaveBeenCalledTimes(2);

    const tryAgainButton = Array.from(mounted.container.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('Try again')) as HTMLButtonElement | undefined;
    expect(tryAgainButton).toBeDefined();

    await act(async () => {
      tryAgainButton!.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(retryStart).toHaveBeenCalledTimes(1);
    expect(getStatus).toHaveBeenCalledTimes(3);

    stalePoll.resolve(failedStatus);
    await flushAsyncWork();

    expect(mounted.container.querySelector('[data-testid="office-sidecar-status-running"]')?.textContent)
      .toContain('Connected');
    expect(mounted.container.querySelector('[data-testid="office-sidecar-status-failed"]')).toBeNull();
  });

  it('shows the adopted note inside Advanced details', async () => {
    setOfficeSidecarApi({
      getStatus: vi.fn(async () => ({
        running: true,
        port: 52100,
        adopted: true,
        skipReason: null,
        lastError: null,
        startedAt: 1_717_171_333,
      })),
      retryStart: vi.fn(async () => ({
        restarted: true,
        port: 52100,
        adopted: true,
        skipReason: null,
        error: null,
      })),
    });

    mounted = mount(<OfficeSidecarStatusSection />);
    await flushAsyncWork();

    const advancedToggle = mounted.container.querySelector('[data-testid="office-sidecar-advanced-toggle"]') as HTMLButtonElement | null;
    act(() => {
      advancedToggle!.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    });

    expect(mounted.container.querySelector('[data-testid="office-sidecar-advanced-content"]')?.textContent)
      .toContain("Using another Rebel instance's sidecar.");
  });

  it('renders the degraded-running state without the healthy banner or retry button', async () => {
    setOfficeSidecarApi({
      getStatus: vi.fn(async () => degradedStatus),
      retryStart: vi.fn(async () => ({
        restarted: true,
        port: 52100,
        adopted: false,
        skipReason: null,
        error: null,
      })),
    });

    mounted = mount(<OfficeSidecarStatusSection />);
    await flushAsyncWork();

    expect(mounted.container.querySelector('[data-testid="office-sidecar-status-degraded"]')?.textContent)
      .toContain("Office is running, but one setup step didn't finish.");
    expect(mounted.container.querySelector('[data-testid="office-sidecar-status-degraded"]')?.textContent)
      .toContain("Couldn't register the Office add-in with the system.");
    expect(mounted.container.querySelector('[data-testid="office-sidecar-status-running"]')).toBeNull();
    expect(Array.from(mounted.container.querySelectorAll('button'))
      .some((button) => button.textContent?.includes('Try again'))).toBe(false);
  });

  it('renders the kill-switch notice', async () => {
    setOfficeSidecarApi({
      getStatus: vi.fn(async (): Promise<OfficeSidecarStatusResponse> => ({
        running: false,
        port: null,
        adopted: false,
        skipReason: 'kill-switch',
        lastError: null,
        startedAt: null,
      })),
      retryStart: vi.fn(async (): Promise<OfficeSidecarRetryStartResponse> => ({
        restarted: false,
        port: null,
        adopted: false,
        skipReason: 'kill-switch',
        error: null,
      })),
    });

    mounted = mount(<OfficeSidecarStatusSection />);
    await flushAsyncWork();

    expect(mounted.container.querySelector('[data-testid="office-sidecar-status-kill-switch"]')?.textContent)
      .toContain('The Office connection has been turned off for this Rebel installation.');
  });

  it('renders the non-desktop notice', async () => {
    setOfficeSidecarApi({
      getStatus: vi.fn(async (): Promise<OfficeSidecarStatusResponse> => ({
        running: false,
        port: null,
        adopted: false,
        skipReason: 'surface-not-desktop',
        lastError: null,
        startedAt: null,
      })),
      retryStart: vi.fn(async (): Promise<OfficeSidecarRetryStartResponse> => ({
        restarted: false,
        port: null,
        adopted: false,
        skipReason: 'surface-not-desktop',
        error: null,
      })),
    });

    mounted = mount(<OfficeSidecarStatusSection />);
    await flushAsyncWork();

    expect(mounted.container.querySelector('[data-testid="office-sidecar-status-surface-not-desktop"]')?.textContent)
      .toContain("The Office connection isn't available here. Use Rebel on desktop to connect with Word, Excel, and PowerPoint.");
  });
});
