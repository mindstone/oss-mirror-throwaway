// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, act, flushAsync } from '../../test-utils/hookTestHarness';
import { useAsyncData } from '../useAsyncData';

describe('useAsyncData', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('auto-loads when enabled and autoLoad are true', async () => {
    const fetcher = vi.fn().mockResolvedValue('data-1');
    const { result } = renderHook(
      (props: { enabled: boolean }) =>
        useAsyncData({ fetcher, enabled: props.enabled, autoLoad: true }),
      { initialProps: { enabled: true } },
    );

    await flushAsync();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(result.current.data).toBe('data-1');
    expect(result.current.hasLoaded).toBe(true);
  });

  it('does not auto-load when disabled', async () => {
    const fetcher = vi.fn().mockResolvedValue('data-1');
    const { result } = renderHook(
      (props: { enabled: boolean }) =>
        useAsyncData({ fetcher, enabled: props.enabled, autoLoad: true }),
      { initialProps: { enabled: false } },
    );

    await flushAsync();
    expect(fetcher).not.toHaveBeenCalled();
    expect(result.current.data).toBeNull();
    expect(result.current.hasLoaded).toBe(false);
  });

  it('refetches when re-enabled after being disabled', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce('data-1')
      .mockResolvedValueOnce('data-2');

    const { result, rerender } = renderHook(
      (props: { enabled: boolean }) =>
        useAsyncData({ fetcher, enabled: props.enabled, autoLoad: true }),
      { initialProps: { enabled: true } },
    );

    // Initial load
    await flushAsync();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(result.current.data).toBe('data-1');
    expect(result.current.hasLoaded).toBe(true);

    // Disable — should clear state
    rerender({ enabled: false });
    await flushAsync();
    expect(result.current.data).toBeNull();
    expect(result.current.hasLoaded).toBe(false);

    // Re-enable — should trigger a fresh fetch
    rerender({ enabled: true });
    await flushAsync();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(result.current.data).toBe('data-2');
    expect(result.current.hasLoaded).toBe(true);
  });

  it('clears error state when disabled', async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error('fail'));

    const { result, rerender } = renderHook(
      (props: { enabled: boolean }) =>
        useAsyncData({ fetcher, enabled: props.enabled, autoLoad: true }),
      { initialProps: { enabled: true } },
    );

    await flushAsync();
    expect(result.current.error).toBe('fail');

    rerender({ enabled: false });
    await flushAsync();
    expect(result.current.error).toBeNull();
    expect(result.current.data).toBeNull();
  });
});
