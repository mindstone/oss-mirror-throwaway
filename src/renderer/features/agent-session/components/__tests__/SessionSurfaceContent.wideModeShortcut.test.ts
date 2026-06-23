import { describe, expect, it, vi } from 'vitest';
import { handleSessionWideModeShortcut } from '../SessionSurfaceContent';

describe('handleSessionWideModeShortcut', () => {
  it('does not toggle wide mode when active surface is library', () => {
    let isWideMode = false;
    const toggleWideMode = () => {
      isWideMode = !isWideMode;
    };
    const preventDefault = vi.fn();
    const event = {
      key: 'f',
      shiftKey: true,
      metaKey: true,
      ctrlKey: false,
      repeat: false,
      preventDefault,
    } as const;

    const handled = handleSessionWideModeShortcut(event, 'library', toggleWideMode);

    expect(handled).toBe(false);
    expect(isWideMode).toBe(false);
    expect(preventDefault).not.toHaveBeenCalled();
  });

  it('toggles wide mode when active surface is sessions', () => {
    let isWideMode = false;
    const toggleWideMode = () => {
      isWideMode = !isWideMode;
    };
    const preventDefault = vi.fn();
    const event = {
      key: 'f',
      shiftKey: true,
      metaKey: true,
      ctrlKey: false,
      repeat: false,
      preventDefault,
    } as const;

    const handled = handleSessionWideModeShortcut(event, 'sessions', toggleWideMode);

    expect(handled).toBe(true);
    expect(isWideMode).toBe(true);
    expect(preventDefault).toHaveBeenCalledTimes(1);
  });
});
