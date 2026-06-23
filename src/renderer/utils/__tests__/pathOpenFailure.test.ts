/**
 * Tests for the reveal/open-path failure toast helper (FOX-3422).
 */
import { describe, expect, it, vi } from 'vitest';
import { showPathOpenFailureToast, PATH_OPEN_FAILURE_MESSAGE } from '../pathOpenFailure';

describe('showPathOpenFailureToast', () => {
  it('does not show a toast when reveal succeeds ({ ok: true })', () => {
    const showToast = vi.fn();
    const shown = showPathOpenFailureToast({ ok: true }, showToast);
    expect(shown).toBe(false);
    expect(showToast).not.toHaveBeenCalled();
  });

  it('shows a toast when reveal returns { ok: false }', () => {
    const showToast = vi.fn();
    const shown = showPathOpenFailureToast(
      { ok: false, reason: 'missing', message: 'gone' },
      showToast,
    );
    expect(shown).toBe(true);
    expect(showToast).toHaveBeenCalledWith({ title: PATH_OPEN_FAILURE_MESSAGE });
  });

  it('shows a toast when openPath rejects with an Error', () => {
    const showToast = vi.fn();
    const shown = showPathOpenFailureToast(new Error('boom'), showToast);
    expect(shown).toBe(true);
    expect(showToast).toHaveBeenCalledWith({ title: PATH_OPEN_FAILURE_MESSAGE });
  });

  it('treats permission failures the same (generic copy)', () => {
    const showToast = vi.fn();
    showPathOpenFailureToast(
      { ok: false, reason: 'permission', message: 'blocked' },
      showToast,
    );
    expect(showToast).toHaveBeenCalledWith({ title: PATH_OPEN_FAILURE_MESSAGE });
  });

  it('does not throw when showToast is undefined', () => {
    expect(() =>
      showPathOpenFailureToast({ ok: false, reason: 'system', message: 'x' }, undefined),
    ).not.toThrow();
  });
});
