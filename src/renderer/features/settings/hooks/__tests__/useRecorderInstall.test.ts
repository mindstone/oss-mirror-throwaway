// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, flushAsync, renderHook } from '@renderer/test-utils';
import { useRecorderInstall } from '../useRecorderInstall';

const installRecorder = vi.fn();
const cancelRecorderInstall = vi.fn();
const isRecorderInstalling = vi.fn();
const isRecorderInstalled = vi.fn();
const relaunch = vi.fn();

beforeEach(() => {
  installRecorder.mockReset();
  cancelRecorderInstall.mockReset().mockResolvedValue({ cancelled: true });
  isRecorderInstalling.mockReset().mockResolvedValue({ installing: false });
  isRecorderInstalled.mockReset().mockResolvedValue({ installed: false });
  relaunch.mockReset();
  (window as unknown as { meetingBotApi: unknown }).meetingBotApi = {
    installRecorder,
    cancelRecorderInstall,
    isRecorderInstalling,
    isRecorderInstalled,
  };
  (window as unknown as { appApi: unknown }).appApi = { relaunch };
});

afterEach(() => {
  vi.clearAllMocks();
});

async function settle(): Promise<void> {
  await act(async () => {
    await flushAsync();
  });
}

describe('useRecorderInstall', () => {
  it('transitions to success and notifies on a successful install', async () => {
    installRecorder.mockResolvedValue({ success: true });
    const onInstalled = vi.fn();
    const { result } = renderHook(() => useRecorderInstall(onInstalled));
    await settle();

    act(() => result.current.install());
    expect(result.current.phase).toBe('installing');
    await settle();

    expect(result.current.phase).toBe('success');
    expect(onInstalled).toHaveBeenCalledTimes(1);
  });

  it('surfaces a failure message', async () => {
    installRecorder.mockResolvedValue({ success: false, error: 'Boom.' });
    const { result } = renderHook(() => useRecorderInstall());
    await settle();

    act(() => result.current.install());
    await settle();

    expect(result.current.phase).toBe('failure');
    expect(result.current.errorMessage).toBe('Boom.');
    expect(result.current.unsupportedPlatform).toBe(false);
  });

  it('flags an unsupported platform', async () => {
    installRecorder.mockResolvedValue({ success: false, unsupportedPlatform: true, error: 'No Linux build.' });
    const { result } = renderHook(() => useRecorderInstall());
    await settle();

    act(() => result.current.install());
    await settle();

    expect(result.current.phase).toBe('failure');
    expect(result.current.unsupportedPlatform).toBe(true);
  });

  it('returns to idle (not failure) on an explicit cancelled result', async () => {
    installRecorder.mockResolvedValue({ success: false, cancelled: true });
    const { result } = renderHook(() => useRecorderInstall());
    await settle();

    act(() => result.current.install());
    await settle();

    expect(result.current.phase).toBe('idle');
    expect(result.current.errorMessage).toBeNull();
  });

  it('cancel() calls the main-owned cancel channel', async () => {
    // Never resolves, so the hook stays in "installing" until cancelled.
    installRecorder.mockReturnValue(new Promise(() => {}));
    const { result } = renderHook(() => useRecorderInstall());
    await settle();

    act(() => result.current.install());
    expect(result.current.phase).toBe('installing');

    act(() => result.current.cancel());
    await settle();

    expect(cancelRecorderInstall).toHaveBeenCalledTimes(1);
  });

  it('restart() relaunches the app', async () => {
    const { result } = renderHook(() => useRecorderInstall());
    await settle();

    act(() => result.current.restart());
    expect(relaunch).toHaveBeenCalledTimes(1);
  });

  it('reconnects to an install already running on mount', async () => {
    isRecorderInstalling.mockResolvedValue({ installing: true });
    const { result, unmount } = renderHook(() => useRecorderInstall());
    await settle();

    expect(result.current.phase).toBe('installing');
    unmount(); // clears the reconnect poll timer
  });
});
