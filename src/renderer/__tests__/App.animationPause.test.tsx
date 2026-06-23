// @vitest-environment happy-dom

/**
 * Animation-pause focus/visibility wiring (FOX-3438).
 *
 * Animations are paused (via the `app-hidden` / `app-unfocused` body classes) when the
 * window is hidden/minimized OR visible-but-unfocused, and run only when visible AND
 * focused. On macOS a visible-but-unfocused window keeps document.hidden === false, so
 * the focus (blur/focus) path is the one that stops always-mounted infinite animations
 * from pegging the GPU while the user has tabbed away.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installAnimationPauseControls } from '../animationPauseControls';

describe('installAnimationPauseControls — focus + visibility (FOX-3438)', () => {
  let cleanup: (() => void) | null = null;
  let hidden = false;
  let focused = true;

  beforeEach(() => {
    hidden = false;
    focused = true;
    Object.defineProperty(document, 'hidden', {
      configurable: true,
      get: () => hidden,
    });
    vi.spyOn(document, 'hasFocus').mockImplementation(() => focused);
    document.body.className = '';
  });

  afterEach(() => {
    cleanup?.();
    cleanup = null;
    vi.restoreAllMocks();
    document.body.className = '';
  });

  it('starts unpaused when visible AND focused', () => {
    cleanup = installAnimationPauseControls(document, window);
    expect(document.body.classList.contains('app-hidden')).toBe(false);
    expect(document.body.classList.contains('app-unfocused')).toBe(false);
  });

  it('adds app-unfocused on window blur and removes it on focus (visible-but-unfocused path)', () => {
    cleanup = installAnimationPauseControls(document, window);

    window.dispatchEvent(new Event('blur'));
    expect(document.body.classList.contains('app-unfocused')).toBe(true);
    // document.hidden stays false — this is the macOS visible-but-unfocused case.
    expect(document.body.classList.contains('app-hidden')).toBe(false);

    window.dispatchEvent(new Event('focus'));
    expect(document.body.classList.contains('app-unfocused')).toBe(false);
  });

  it('still pauses via app-hidden on visibilitychange (existing behavior preserved)', () => {
    cleanup = installAnimationPauseControls(document, window);

    hidden = true;
    document.dispatchEvent(new Event('visibilitychange'));
    expect(document.body.classList.contains('app-hidden')).toBe(true);

    hidden = false;
    document.dispatchEvent(new Event('visibilitychange'));
    expect(document.body.classList.contains('app-hidden')).toBe(false);
  });

  it('starts paused (app-unfocused) when the app launches unfocused', () => {
    focused = false;
    cleanup = installAnimationPauseControls(document, window);
    expect(document.body.classList.contains('app-unfocused')).toBe(true);
  });

  it('removes both classes and listeners on cleanup', () => {
    cleanup = installAnimationPauseControls(document, window);
    window.dispatchEvent(new Event('blur'));
    expect(document.body.classList.contains('app-unfocused')).toBe(true);

    cleanup();
    cleanup = null;
    expect(document.body.classList.contains('app-hidden')).toBe(false);
    expect(document.body.classList.contains('app-unfocused')).toBe(false);

    // Listeners removed: a subsequent blur must not re-add the class.
    window.dispatchEvent(new Event('blur'));
    expect(document.body.classList.contains('app-unfocused')).toBe(false);
  });
});
