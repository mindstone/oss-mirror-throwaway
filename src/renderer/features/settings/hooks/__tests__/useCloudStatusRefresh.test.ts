// @vitest-environment happy-dom

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook, setupFakeTimers, cleanupFakeTimers } from '@renderer/test-utils';
import {
  MANAGED_CLOUD_STATUS_REFRESH_BACKOFF_MS,
  MANAGED_CLOUD_STATUS_REFRESH_MS,
  useCloudStatusRefresh,
} from '../useCloudStatusRefresh';

type HookProps = Parameters<typeof useCloudStatusRefresh>[0];

let visibilityState: DocumentVisibilityState = 'visible';

function installVisibilityMock() {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => visibilityState,
  });
}

function setVisibility(nextState: DocumentVisibilityState) {
  visibilityState = nextState;
}

function createProps(overrides: Partial<HookProps> = {}): HookProps {
  return {
    cloudUrl: 'https://managed.example.com',
    isConnected: true,
    isManaged: true,
    busy: false,
    syncInProgress: false,
    provisionBusy: false,
    switchInProgress: false,
    updateStatus: 'idle',
    refreshStatus: vi.fn().mockResolvedValue({ success: true }),
    emitLog: vi.fn(),
    ...overrides,
  };
}

async function advanceTimers(ms: number) {
  await act(async () => {
    vi.advanceTimersByTime(ms);
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('useCloudStatusRefresh', () => {
  beforeEach(() => {
    setupFakeTimers();
    setVisibility('visible');
    installVisibilityMock();
  });

  afterEach(() => {
    cleanupFakeTimers();
    vi.restoreAllMocks();
  });

  it('fires every 45 seconds under happy conditions', async () => {
    const props = createProps();
    const { unmount } = renderHook((nextProps: HookProps) => {
      useCloudStatusRefresh(nextProps);
    }, { initialProps: props });

    await advanceTimers(MANAGED_CLOUD_STATUS_REFRESH_MS - 1);
    expect(props.refreshStatus).not.toHaveBeenCalled();

    await advanceTimers(1);
    expect(props.refreshStatus).toHaveBeenCalledTimes(1);

    await advanceTimers(MANAGED_CLOUD_STATUS_REFRESH_MS);
    expect(props.refreshStatus).toHaveBeenCalledTimes(2);

    unmount();
  });

  it('keeps the original 45 second cadence when the parent rerenders with a new refreshStatus callback', async () => {
    const refresh1 = vi.fn().mockResolvedValue({ success: true });
    const refresh2 = vi.fn().mockResolvedValue({ success: true });
    const refresh3 = vi.fn().mockResolvedValue({ success: true });
    const emitLog = vi.fn();

    const { rerender, unmount } = renderHook((nextProps: HookProps) => {
      useCloudStatusRefresh(nextProps);
    }, {
      initialProps: createProps({ refreshStatus: refresh1, emitLog }),
    });

    await advanceTimers(MANAGED_CLOUD_STATUS_REFRESH_MS - 1);
    rerender(createProps({ refreshStatus: refresh2, emitLog }));
    await advanceTimers(1);
    expect(refresh1).not.toHaveBeenCalled();
    expect(refresh2).toHaveBeenCalledTimes(1);

    await advanceTimers(MANAGED_CLOUD_STATUS_REFRESH_MS - 1);
    rerender(createProps({ refreshStatus: refresh3, emitLog }));
    await advanceTimers(1);
    expect(refresh3).toHaveBeenCalledTimes(1);

    unmount();
  });

  it('does not fire while the document is hidden', async () => {
    const props = createProps();
    const { unmount } = renderHook((nextProps: HookProps) => {
      useCloudStatusRefresh(nextProps);
    }, { initialProps: props });

    setVisibility('hidden');
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
      await Promise.resolve();
    });

    await advanceTimers(MANAGED_CLOUD_STATUS_REFRESH_MS * 2);
    expect(props.refreshStatus).not.toHaveBeenCalled();

    unmount();
  });

  it('pauses while another user operation is in flight', async () => {
    const props = createProps({ busy: true });
    const { rerender, unmount } = renderHook((nextProps: HookProps) => {
      useCloudStatusRefresh(nextProps);
    }, { initialProps: props });

    await advanceTimers(MANAGED_CLOUD_STATUS_REFRESH_MS * 2);
    expect(props.refreshStatus).not.toHaveBeenCalled();

    const resumedProps = createProps({
      ...props,
      busy: false,
      refreshStatus: props.refreshStatus,
      emitLog: props.emitLog,
    });
    rerender(resumedProps);

    await advanceTimers(MANAGED_CLOUD_STATUS_REFRESH_MS);
    expect(props.refreshStatus).toHaveBeenCalledTimes(1);

    unmount();
  });

  it('pauses while a provider switch is in progress, then refreshes immediately once switching finishes', async () => {
    const refreshStatus = vi.fn().mockResolvedValue({ success: true });
    const props = createProps({ switchInProgress: true, refreshStatus });
    const { rerender, unmount } = renderHook((nextProps: HookProps) => {
      useCloudStatusRefresh(nextProps);
    }, { initialProps: props });

    await advanceTimers(MANAGED_CLOUD_STATUS_REFRESH_MS * 2);
    expect(refreshStatus).not.toHaveBeenCalled();

    rerender(createProps({
      ...props,
      switchInProgress: false,
      refreshStatus,
      emitLog: props.emitLog,
    }));

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(refreshStatus).toHaveBeenCalledTimes(1);

    unmount();
  });

  it('fires immediately when the refresh becomes enabled again', async () => {
    const refreshStatus = vi.fn().mockResolvedValue({ success: true });
    const props = createProps({ isConnected: false, refreshStatus });
    const { rerender, unmount } = renderHook((nextProps: HookProps) => {
      useCloudStatusRefresh(nextProps);
    }, { initialProps: props });

    await advanceTimers(MANAGED_CLOUD_STATUS_REFRESH_MS * 2);
    expect(refreshStatus).not.toHaveBeenCalled();

    rerender(createProps({
      ...props,
      isConnected: true,
      refreshStatus,
      emitLog: props.emitLog,
    }));

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(refreshStatus).toHaveBeenCalledTimes(1);

    await advanceTimers(MANAGED_CLOUD_STATUS_REFRESH_MS);
    expect(refreshStatus).toHaveBeenCalledTimes(2);

    unmount();
  });

  it('backs off after three consecutive failures, then resets to 45 seconds after a success', async () => {
    const refreshStatus = vi.fn()
      .mockResolvedValueOnce({ success: false, error: 'first failure' })
      .mockResolvedValueOnce({ success: false, error: 'second failure' })
      .mockResolvedValueOnce({ success: false, error: 'third failure' })
      .mockResolvedValueOnce({ success: true })
      .mockResolvedValue({ success: true });
    const emitLog = vi.fn();

    const props = createProps({ refreshStatus, emitLog });
    const { unmount } = renderHook((nextProps: HookProps) => {
      useCloudStatusRefresh(nextProps);
    }, { initialProps: props });

    await advanceTimers(MANAGED_CLOUD_STATUS_REFRESH_MS);
    await advanceTimers(MANAGED_CLOUD_STATUS_REFRESH_MS);
    await advanceTimers(MANAGED_CLOUD_STATUS_REFRESH_MS);
    expect(refreshStatus).toHaveBeenCalledTimes(3);
    expect(emitLog).toHaveBeenLastCalledWith(
      expect.objectContaining({
        level: 'warn',
        message: 'Managed cloud refresh failed',
        context: expect.objectContaining({
          failCount: 3,
          cloudUrl: 'https://managed.example.com',
          err: 'third failure',
        }),
      }),
    );

    await advanceTimers(MANAGED_CLOUD_STATUS_REFRESH_MS);
    expect(refreshStatus).toHaveBeenCalledTimes(3);

    await advanceTimers(MANAGED_CLOUD_STATUS_REFRESH_BACKOFF_MS - MANAGED_CLOUD_STATUS_REFRESH_MS);
    expect(refreshStatus).toHaveBeenCalledTimes(4);

    await advanceTimers(MANAGED_CLOUD_STATUS_REFRESH_MS);
    expect(refreshStatus).toHaveBeenCalledTimes(5);

    unmount();
  });

  it('cleans up its interval and visibility listener on unmount', async () => {
    const addEventListenerSpy = vi.spyOn(document, 'addEventListener');
    const removeEventListenerSpy = vi.spyOn(document, 'removeEventListener');
    const props = createProps();

    const { unmount } = renderHook((nextProps: HookProps) => {
      useCloudStatusRefresh(nextProps);
    }, { initialProps: props });

    expect(addEventListenerSpy).toHaveBeenCalledWith('visibilitychange', expect.any(Function));

    unmount();

    expect(removeEventListenerSpy).toHaveBeenCalledWith('visibilitychange', expect.any(Function));

    await advanceTimers(MANAGED_CLOUD_STATUS_REFRESH_MS * 3);
    expect(props.refreshStatus).not.toHaveBeenCalled();
  });
});
