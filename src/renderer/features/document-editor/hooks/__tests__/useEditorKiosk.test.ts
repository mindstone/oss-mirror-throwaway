// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { act, renderHook } from '@renderer/test-utils';
import { useEditorKiosk } from '../useEditorKiosk';

describe('useEditorKiosk', () => {
  it('cycles off → wide → zen → off', () => {
    const { result, unmount } = renderHook(() => useEditorKiosk({
      editorOpen: true,
      librarySurfaceActive: true,
    }));

    expect(result.current.level).toBe('off');

    act(() => result.current.cycleLevel());
    expect(result.current.level).toBe('wide');

    act(() => result.current.cycleLevel());
    expect(result.current.level).toBe('zen');

    act(() => result.current.cycleLevel());
    expect(result.current.level).toBe('off');
    unmount();
  });

  it('clearLevel always exits kiosk to off (Escape / lens interaction)', () => {
    const { result, unmount } = renderHook(() => useEditorKiosk({
      editorOpen: true,
      librarySurfaceActive: true,
    }));

    act(() => result.current.cycleLevel());
    expect(result.current.level).toBe('wide');

    act(() => result.current.clearLevel());
    expect(result.current.level).toBe('off');
    unmount();
  });

  it('clears kiosk when editor closes', () => {
    const { result, rerender, unmount } = renderHook(
      ({ editorOpen, librarySurfaceActive }: { editorOpen: boolean; librarySurfaceActive: boolean }) => useEditorKiosk({
        editorOpen,
        librarySurfaceActive,
      }),
      { initialProps: { editorOpen: true, librarySurfaceActive: true } },
    );

    act(() => result.current.cycleLevel());
    expect(result.current.level).toBe('wide');

    rerender({ editorOpen: false, librarySurfaceActive: true });
    expect(result.current.level).toBe('off');
    unmount();
  });

  it('clears kiosk when active surface leaves library', () => {
    const { result, rerender, unmount } = renderHook(
      ({ editorOpen, librarySurfaceActive }: { editorOpen: boolean; librarySurfaceActive: boolean }) => useEditorKiosk({
        editorOpen,
        librarySurfaceActive,
      }),
      { initialProps: { editorOpen: true, librarySurfaceActive: true } },
    );

    act(() => result.current.cycleLevel());
    act(() => result.current.cycleLevel());
    expect(result.current.level).toBe('zen');

    rerender({ editorOpen: true, librarySurfaceActive: false });
    expect(result.current.level).toBe('off');
    unmount();
  });
});
