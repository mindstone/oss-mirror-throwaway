// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, flushAsync, renderHook } from '@renderer/test-utils';
import { useDocumentTabs } from '../useDocumentTabs';

describe('useDocumentTabs — pre-switch rejection propagation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  // -------------------------------------------------------------------------
  // T16: opening another document aborts when the pre-switch flush rejects.
  // -------------------------------------------------------------------------
  it('openDocument aborts when onBeforeTabSwitch rejects', async () => {
    const onBeforeTabSwitch = vi.fn().mockRejectedValue(new Error('flush failed'));
    const { result, unmount } = renderHook(() =>
      useDocumentTabs({ onBeforeTabSwitch }),
    );

    act(() => {
      result.current.openDocument('foo.md');
    });
    expect(onBeforeTabSwitch).not.toHaveBeenCalled();
    expect(result.current.tabs).toHaveLength(1);
    expect(result.current.activeDocumentPath).toBe('foo.md');

    act(() => {
      result.current.openDocument('bar.md');
    });
    await flushAsync();

    expect(onBeforeTabSwitch).toHaveBeenCalledTimes(1);
    expect(result.current.tabs).toHaveLength(1);
    expect(result.current.tabs[0]?.path).toBe('foo.md');
    expect(result.current.activeDocumentPath).toBe('foo.md');
    unmount();
  });

  // -------------------------------------------------------------------------
  // T17: direct active-tab switching has the same abort semantics.
  // -------------------------------------------------------------------------
  it('setActiveTab aborts when onBeforeTabSwitch rejects', async () => {
    type Props = { onBeforeTabSwitch?: () => Promise<void> };
    const { result, rerender, unmount } = renderHook<
      ReturnType<typeof useDocumentTabs>,
      Props
    >(
      ({ onBeforeTabSwitch }) => useDocumentTabs({ onBeforeTabSwitch }),
      { initialProps: {} },
    );

    act(() => {
      result.current.openDocument('foo.md');
    });
    const firstTabId = result.current.activeTabId;

    act(() => {
      result.current.openDocument('bar.md');
    });
    const secondTabId = result.current.activeTabId;
    expect(result.current.tabs).toHaveLength(2);
    expect(firstTabId).not.toBeNull();
    expect(secondTabId).not.toBeNull();
    expect(secondTabId).not.toBe(firstTabId);
    expect(result.current.activeDocumentPath).toBe('bar.md');

    const onBeforeTabSwitch = vi.fn().mockRejectedValue(new Error('flush failed'));
    rerender({ onBeforeTabSwitch });

    act(() => {
      result.current.setActiveTab(firstTabId!);
    });
    await flushAsync();

    expect(onBeforeTabSwitch).toHaveBeenCalledTimes(1);
    expect(result.current.activeTabId).toBe(secondTabId);
    expect(result.current.activeDocumentPath).toBe('bar.md');
    unmount();
  });

  it('closeActiveTab closes the current tab', () => {
    const { result, unmount } = renderHook(() => useDocumentTabs());

    act(() => {
      result.current.openDocument('one.md');
      result.current.openDocument('two.md');
    });

    expect(result.current.tabs).toHaveLength(2);
    expect(result.current.activeDocumentPath).toBe('two.md');

    act(() => {
      result.current.closeActiveTab();
    });

    expect(result.current.tabs).toHaveLength(1);
    expect(result.current.activeDocumentPath).toBe('one.md');
    unmount();
  });

  it('does not fire onTabsEmptiedByClose when closing a non-last tab', () => {
    const onTabsEmptiedByClose = vi.fn();
    const { result, unmount } = renderHook(() =>
      useDocumentTabs({ onTabsEmptiedByClose }),
    );

    act(() => {
      result.current.openDocument('one.md');
      result.current.openDocument('two.md');
    });

    expect(result.current.tabs).toHaveLength(2);
    const firstTabId = result.current.tabs[0]!.id;

    act(() => {
      result.current.closeTab(firstTabId);
    });

    expect(result.current.tabs).toHaveLength(1);
    expect(onTabsEmptiedByClose).not.toHaveBeenCalled();
    unmount();
  });

  it('fires onTabsEmptiedByClose exactly once when closing the final tab', () => {
    const onTabsEmptiedByClose = vi.fn();
    const { result, unmount } = renderHook(() =>
      useDocumentTabs({ onTabsEmptiedByClose }),
    );

    act(() => {
      result.current.openDocument('only.md');
    });

    expect(result.current.tabs).toHaveLength(1);
    const tabId = result.current.tabs[0]!.id;

    act(() => {
      result.current.closeTab(tabId);
    });

    expect(result.current.tabs).toHaveLength(0);
    expect(onTabsEmptiedByClose).toHaveBeenCalledTimes(1);
    unmount();
  });

  it('fires onTabsEmptiedByClose when the last tab is closed via closeActiveTab', () => {
    const onTabsEmptiedByClose = vi.fn();
    const { result, unmount } = renderHook(() =>
      useDocumentTabs({ onTabsEmptiedByClose }),
    );

    act(() => {
      result.current.openDocument('only.md');
    });

    act(() => {
      result.current.closeActiveTab();
    });

    expect(result.current.tabs).toHaveLength(0);
    expect(onTabsEmptiedByClose).toHaveBeenCalledTimes(1);
    unmount();
  });

  it('does not fire onTabsEmptiedByClose for an unknown tab id', () => {
    const onTabsEmptiedByClose = vi.fn();
    const { result, unmount } = renderHook(() =>
      useDocumentTabs({ onTabsEmptiedByClose }),
    );

    act(() => {
      result.current.openDocument('only.md');
    });

    act(() => {
      result.current.closeTab('tab-does-not-exist');
    });

    // No tab removed → list unchanged → callback must not fire.
    expect(result.current.tabs).toHaveLength(1);
    expect(onTabsEmptiedByClose).not.toHaveBeenCalled();
    unmount();
  });

  it('does not fire onTabsEmptiedByClose from closeAllTabs', () => {
    const onTabsEmptiedByClose = vi.fn();
    const { result, unmount } = renderHook(() =>
      useDocumentTabs({ onTabsEmptiedByClose }),
    );

    act(() => {
      result.current.openDocument('one.md');
      result.current.openDocument('two.md');
    });

    act(() => {
      result.current.closeAllTabs();
    });

    expect(result.current.tabs).toHaveLength(0);
    expect(onTabsEmptiedByClose).not.toHaveBeenCalled();
    unmount();
  });

  it('setActiveTabByIndex activates matching tab and ignores out-of-range values', () => {
    const { result, unmount } = renderHook(() => useDocumentTabs());

    act(() => {
      result.current.openDocument('one.md');
      result.current.openDocument('two.md');
      result.current.openDocument('three.md');
    });

    expect(result.current.activeDocumentPath).toBe('three.md');

    act(() => {
      result.current.setActiveTabByIndex(1);
    });
    expect(result.current.activeDocumentPath).toBe('one.md');

    act(() => {
      result.current.setActiveTabByIndex(9);
    });
    expect(result.current.activeDocumentPath).toBe('one.md');
    unmount();
  });
});
