// @vitest-environment happy-dom
/**
 * Options-contract test for `useGlobalHotkey`.
 *
 * Scope: this test mocks `react-hotkeys-hook` and verifies the wrapper passes
 * the canonical options object through, plus `keys`, `callback`, and `deps`.
 *
 * NOT in scope: real-DOM contenteditable dispatch behavior. Verifying that
 * pressing Cmd+N from inside a TipTap contenteditable actually fires the
 * handler requires the real library + a real DOM (or an MCP smoke test
 * against the running app). The library version (`react-hotkeys-hook@^5.2.3`)
 * was independently confirmed to gate `enableOnFormTags` and
 * `enableOnContentEditable` independently — see the planning doc at
 * `docs/plans/260505_hotkeys_contenteditable_regression_fix.md`.
 *
 * The point of this test is to lock the wrapper's options-contract so a future
 * refactor cannot drift either option to `false` (or omit one) without a
 * deliberate, visible test failure.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const useHotkeysMock = vi.fn();

 
vi.mock('react-hotkeys-hook', () => ({
  useHotkeys: (...args: unknown[]) => useHotkeysMock(...args),
}));

import { renderHook } from '../../test-utils/hookTestHarness';
import { useGlobalHotkey } from '../useGlobalHotkey';

describe('useGlobalHotkey', () => {
  beforeEach(() => {
    useHotkeysMock.mockReset();
  });

  it('passes the canonical global-hotkey options through to react-hotkeys-hook', () => {
    const callback = vi.fn();
    renderHook(() => useGlobalHotkey('mod+n', callback, []));

    expect(useHotkeysMock).toHaveBeenCalledTimes(1);
    const [keys, cb, options, deps] = useHotkeysMock.mock.calls[0] ?? [];
    expect(keys).toBe('mod+n');
    expect(cb).toBe(callback);
    expect(options).toEqual({
      preventDefault: true,
      enableOnFormTags: true,
      enableOnContentEditable: true,
    });
    expect(deps).toEqual([]);
  });

  it('forwards the deps array unchanged', () => {
    const callback = vi.fn();
    const deps = [1, 'two', { three: 3 }];
    renderHook(() => useGlobalHotkey('ctrl+tab', callback, deps));

    const forwardedDeps = useHotkeysMock.mock.calls[0]?.[3];
    expect(forwardedDeps).toBe(deps);
  });

  it('forwards different key combinations verbatim', () => {
    const callback = vi.fn();
    const cases = ['mod+n', 'mod+shift+n', 'mod+o', 'mod+shift+a', 'ctrl+tab', 'ctrl+shift+tab'];
    for (const keys of cases) {
      useHotkeysMock.mockReset();
      renderHook(() => useGlobalHotkey(keys, callback, []));
      expect(useHotkeysMock.mock.calls[0]?.[0]).toBe(keys);
    }
  });

  it('always passes preventDefault: true (locks regression of browser default behavior)', () => {
    renderHook(() => useGlobalHotkey('mod+n', vi.fn(), []));
    const options = useHotkeysMock.mock.calls[0]?.[2] as Record<string, unknown> | undefined;
    expect(options?.preventDefault).toBe(true);
  });

  it('always passes enableOnContentEditable: true (regression guard for TipTap composer)', () => {
    renderHook(() => useGlobalHotkey('mod+n', vi.fn(), []));
    const options = useHotkeysMock.mock.calls[0]?.[2] as Record<string, unknown> | undefined;
    expect(options?.enableOnContentEditable).toBe(true);
  });

  it('always passes enableOnFormTags: true (preserves textarea/input behavior)', () => {
    renderHook(() => useGlobalHotkey('mod+n', vi.fn(), []));
    const options = useHotkeysMock.mock.calls[0]?.[2] as Record<string, unknown> | undefined;
    expect(options?.enableOnFormTags).toBe(true);
  });
});
