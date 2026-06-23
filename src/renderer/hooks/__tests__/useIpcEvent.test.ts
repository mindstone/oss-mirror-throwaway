// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { renderHook, act, createMockIpcListeners } from '../../test-utils/hookTestHarness';
import { useIpcEvent } from '../useIpcEvent';

describe('useIpcEvent', () => {
  it('calls subscribe on mount and cleanup on unmount', () => {
    const cleanup = vi.fn();
    const subscribe = vi.fn((_handler: (v: number) => void) => cleanup);
    const handler = vi.fn();

    const { unmount } = renderHook(() => useIpcEvent(subscribe, handler, []));

    expect(subscribe).toHaveBeenCalledTimes(1);
    unmount();
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('does nothing when subscribe is undefined (optional API)', () => {
    const handler = vi.fn();
    const { unmount } = renderHook(() => useIpcEvent<[number]>(undefined, handler, []));

    expect(handler).not.toHaveBeenCalled();
    unmount();
  });

  it('re-subscribes when deps change', () => {
    const firstCleanup = vi.fn();
    const secondCleanup = vi.fn();
    const subscribe = vi.fn()
      .mockReturnValueOnce(firstCleanup)
      .mockReturnValueOnce(secondCleanup);
    const handler = vi.fn();

    const { rerender, unmount } = renderHook(
      ({ dep }: { dep: number }) => useIpcEvent(subscribe, handler, [dep]),
      { initialProps: { dep: 1 } },
    );

    expect(subscribe).toHaveBeenCalledTimes(1);

    rerender({ dep: 2 });
    expect(firstCleanup).toHaveBeenCalledTimes(1);
    expect(subscribe).toHaveBeenCalledTimes(2);

    unmount();
    expect(secondCleanup).toHaveBeenCalledTimes(1);
  });

  it('does NOT re-subscribe when deps are stable', () => {
    const cleanup = vi.fn();
    const subscribe = vi.fn((_handler: (v: number) => void) => cleanup);

    const { rerender, unmount } = renderHook(
      ({ handler }: { handler: (v: number) => void }) =>
        useIpcEvent(subscribe, handler, []),
      { initialProps: { handler: vi.fn() } },
    );

    rerender({ handler: vi.fn() });
    rerender({ handler: vi.fn() });

    expect(subscribe).toHaveBeenCalledTimes(1);
    unmount();
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('uses latest handler via ref (no stale closures)', () => {
    const { api, emit } = createMockIpcListeners();
    const subscribe = api.onSomeEvent as (handler: (v: number) => void) => () => void;

    const firstHandler = vi.fn();
    const secondHandler = vi.fn();

    const { rerender, unmount } = renderHook(
      ({ handler }: { handler: (v: number) => void }) =>
        useIpcEvent(subscribe, handler, []),
      { initialProps: { handler: firstHandler } },
    );

    act(() => { emit('onSomeEvent', 1); });
    expect(firstHandler).toHaveBeenCalledWith(1);
    expect(secondHandler).not.toHaveBeenCalled();

    rerender({ handler: secondHandler });

    act(() => { emit('onSomeEvent', 2); });
    expect(firstHandler).toHaveBeenCalledTimes(1);
    expect(secondHandler).toHaveBeenCalledWith(2);

    unmount();
  });

  it('handles subscribe returning undefined cleanup gracefully', () => {
    const subscribe = vi.fn(() => undefined) as unknown as
      (handler: (v: number) => void) => () => void;
    const handler = vi.fn();

    const { unmount } = renderHook(() => useIpcEvent(subscribe, handler, []));
    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(() => unmount()).not.toThrow();
  });
});
