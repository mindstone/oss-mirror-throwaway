// @vitest-environment happy-dom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_LENS } from '../../types/lens';
import {
  LIBRARY_LENS_STORAGE_KEY,
  LIBRARY_LENS_TIP_DISMISSED_KEY,
  useLibraryLens,
} from '../useLibraryLens';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const LEGACY_PLACEHOLDER_CHAR = String.fromCharCode(42);
const LEGACY_LIBRARY_LENS_STORAGE_KEY = LEGACY_PLACEHOLDER_CHAR.repeat(15);
const LEGACY_LIBRARY_LENS_TIP_DISMISSED_KEY = LEGACY_PLACEHOLDER_CHAR.repeat(39);

type HookValue = ReturnType<typeof useLibraryLens>;

let latestHookValue: HookValue;
let root: Root | null = null;
let container: HTMLDivElement | null = null;

function Probe() {
  latestHookValue = useLibraryLens();
  return null;
}

function mountHook() {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root?.render(<Probe />);
  });
}

function unmountHook() {
  if (root) {
    act(() => {
      root?.unmount();
    });
  }
  root = null;
  container?.remove();
  container = null;
}

describe('useLibraryLens', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    unmountHook();
    localStorage.clear();
  });

  it('defaults to DEFAULT_LENS on first run', () => {
    mountHook();
    expect(latestHookValue.browseLens).toEqual(DEFAULT_LENS);
    expect(latestHookValue.effectiveLens).toEqual(DEFAULT_LENS);
  });

  it('persists browse lens when setBrowseLens is called', () => {
    mountHook();

    act(() => {
      latestHookValue.setBrowseLens({ filter: 'memory', view: 'cards' });
    });

    expect(latestHookValue.browseLens).toEqual({ filter: 'memory', view: 'cards' });
    expect(localStorage.getItem(LIBRARY_LENS_STORAGE_KEY)).toBe(JSON.stringify({ filter: 'memory', view: 'cards' }));
  });

  it('persists and hydrates facet on browse lens', () => {
    mountHook();

    act(() => {
      latestHookValue.setBrowseLens({ filter: 'skills', view: 'cards', facet: 'communication' });
    });

    expect(latestHookValue.browseLens).toEqual({
      filter: 'skills',
      view: 'cards',
      facet: 'communication',
    });
    expect(localStorage.getItem(LIBRARY_LENS_STORAGE_KEY)).toBe(
      JSON.stringify({ filter: 'skills', view: 'cards', facet: 'communication' }),
    );

    unmountHook();
    mountHook();
    expect(latestHookValue.browseLens).toEqual({
      filter: 'skills',
      view: 'cards',
      facet: 'communication',
    });
  });

  it('hydrates browse lens from localStorage', () => {
    localStorage.setItem(LIBRARY_LENS_STORAGE_KEY, JSON.stringify({ filter: 'skills', view: 'cards' }));
    mountHook();

    expect(latestHookValue.browseLens).toEqual({ filter: 'skills', view: 'cards' });
  });

  it('migrates legacy placeholder storage keys on initial mount', () => {
    localStorage.setItem(
      LEGACY_LIBRARY_LENS_STORAGE_KEY,
      JSON.stringify({ filter: 'skills', view: 'cards' }),
    );
    localStorage.setItem(LEGACY_LIBRARY_LENS_TIP_DISMISSED_KEY, '1');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    mountHook();

    expect(latestHookValue.browseLens).toEqual({ filter: 'skills', view: 'cards' });
    expect(latestHookValue.orientationTipDismissed).toBe(true);
    expect(localStorage.getItem(LIBRARY_LENS_STORAGE_KEY)).toBe(
      JSON.stringify({ filter: 'skills', view: 'cards' }),
    );
    expect(localStorage.getItem(LIBRARY_LENS_TIP_DISMISSED_KEY)).toBe('1');
    expect(localStorage.getItem(LEGACY_LIBRARY_LENS_STORAGE_KEY)).toBeNull();
    expect(localStorage.getItem(LEGACY_LIBRARY_LENS_TIP_DISMISSED_KEY)).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(
      '[lens] Migrated persisted preference from legacy placeholder key',
      expect.objectContaining({
        from: LEGACY_LIBRARY_LENS_STORAGE_KEY,
        to: LIBRARY_LENS_STORAGE_KEY,
      }),
    );
    expect(warnSpy).toHaveBeenCalledWith(
      '[lens] Migrated persisted preference from legacy placeholder key',
      expect.objectContaining({
        from: LEGACY_LIBRARY_LENS_TIP_DISMISSED_KEY,
        to: LIBRARY_LENS_TIP_DISMISSED_KEY,
      }),
    );

    warnSpy.mockRestore();
  });

  it('keeps canonical values when canonical and legacy lens keys both exist', () => {
    localStorage.setItem(
      LIBRARY_LENS_STORAGE_KEY,
      JSON.stringify({ filter: 'memory', view: 'atlas' }),
    );
    localStorage.setItem(
      LEGACY_LIBRARY_LENS_STORAGE_KEY,
      JSON.stringify({ filter: 'skills', view: 'cards' }),
    );
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    mountHook();

    expect(latestHookValue.browseLens).toEqual({ filter: 'memory', view: 'atlas' });
    expect(localStorage.getItem(LIBRARY_LENS_STORAGE_KEY)).toBe(
      JSON.stringify({ filter: 'memory', view: 'atlas' }),
    );
    expect(localStorage.getItem(LEGACY_LIBRARY_LENS_STORAGE_KEY)).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(
      '[lens] Removed stale legacy placeholder key because canonical key already exists',
      expect.objectContaining({
        from: LEGACY_LIBRARY_LENS_STORAGE_KEY,
        to: LIBRARY_LENS_STORAGE_KEY,
      }),
    );

    warnSpy.mockRestore();
  });

  it('migrates persisted list view to cards and writes back', () => {
    localStorage.setItem(LIBRARY_LENS_STORAGE_KEY, JSON.stringify({ filter: 'skills', view: 'list' }));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    mountHook();

    expect(latestHookValue.browseLens).toEqual({ filter: 'skills', view: 'cards' });
    expect(localStorage.getItem(LIBRARY_LENS_STORAGE_KEY)).toBe(
      JSON.stringify({ filter: 'skills', view: 'cards' }),
    );
    expect(warnSpy).toHaveBeenCalledWith(
      "[lens] Migrated persisted view 'list' -> 'cards'",
      expect.objectContaining({ from: 'list', to: 'cards' }),
    );

    warnSpy.mockRestore();
  });

  it('falls back to DEFAULT_LENS, logs, and removes corrupt stored preference', () => {
    localStorage.setItem(LIBRARY_LENS_STORAGE_KEY, '{not-json');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    mountHook();

    expect(latestHookValue.browseLens).toEqual(DEFAULT_LENS);
    expect(localStorage.getItem(LIBRARY_LENS_STORAGE_KEY)).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[lens] Invalid persisted lens preference'),
      expect.objectContaining({ reason: 'invalid-json' }),
    );

    warnSpy.mockRestore();
  });

  it('rejects prototype-derived enum values without crashing', () => {
    localStorage.setItem(
      LIBRARY_LENS_STORAGE_KEY,
      JSON.stringify({ filter: 'toString', view: 'folders' }),
    );
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    mountHook();

    expect(latestHookValue.browseLens).toEqual(DEFAULT_LENS);
    expect(localStorage.getItem(LIBRARY_LENS_STORAGE_KEY)).toBeNull();
    expect(warnSpy).toHaveBeenCalled();

    warnSpy.mockRestore();
  });

  it('uses editorLensOverride over browseLens for effectiveLens', () => {
    mountHook();

    act(() => {
      latestHookValue.setBrowseLens({ filter: 'skills', view: 'folders' });
      latestHookValue.setEditorLensOverride({ filter: 'everything', view: 'atlas' });
    });

    expect(latestHookValue.browseLens).toEqual({ filter: 'skills', view: 'folders' });
    expect(latestHookValue.effectiveLens).toEqual({ filter: 'everything', view: 'atlas' });
  });

  it('clears editorLensOverride when the user clicks a chip (setBrowseLens)', () => {
    // Per Lens Transition State Machine: chip click while override is active
    // must clear the override and update browseLens.
    mountHook();

    act(() => {
      latestHookValue.setBrowseLens({ filter: 'skills', view: 'folders' });
      latestHookValue.setEditorLensOverride({ filter: 'everything', view: 'folders' });
    });

    expect(latestHookValue.editorLensOverride).toEqual({ filter: 'everything', view: 'folders' });
    expect(latestHookValue.effectiveLens).toEqual({ filter: 'everything', view: 'folders' });

    act(() => {
      latestHookValue.setBrowseLens({ filter: 'memory', view: 'cards' });
    });

    expect(latestHookValue.editorLensOverride).toBeNull();
    expect(latestHookValue.browseLens).toEqual({ filter: 'memory', view: 'cards' });
    expect(latestHookValue.effectiveLens).toEqual({ filter: 'memory', view: 'cards' });
  });

  it('persists orientation tip dismissal', () => {
    mountHook();

    act(() => {
      latestHookValue.dismissOrientationTip();
    });

    expect(latestHookValue.orientationTipDismissed).toBe(true);
    expect(localStorage.getItem(LIBRARY_LENS_TIP_DISMISSED_KEY)).toBe('1');
  });

  it('updates browse lens from storage events', () => {
    mountHook();

    act(() => {
      window.dispatchEvent(new StorageEvent('storage', {
        key: LIBRARY_LENS_STORAGE_KEY,
        newValue: JSON.stringify({ filter: 'everything', view: 'cards' }),
      }));
    });

    expect(latestHookValue.browseLens).toEqual({ filter: 'everything', view: 'cards' });
  });

  it('ignores corrupt cross-window storage events while staying observable', () => {
    mountHook();
    const initial = latestHookValue.browseLens;
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    act(() => {
      window.dispatchEvent(new StorageEvent('storage', {
        key: LIBRARY_LENS_STORAGE_KEY,
        newValue: '{not-json',
      }));
    });

    expect(latestHookValue.browseLens).toEqual(initial);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Cross-window storage event carried invalid lens'),
      expect.objectContaining({ reason: 'invalid-json' }),
    );

    warnSpy.mockRestore();
  });

  it('returns a stable hook value object when nothing changed', () => {
    mountHook();
    const first = latestHookValue;

    act(() => {
      // Setting same browse lens should not change identity
      latestHookValue.setBrowseLens(first.browseLens);
    });

    // Memoized output: setters keep the same identity, and overall API object should
    // remain referentially stable when no underlying value changed.
    expect(latestHookValue.setBrowseLens).toBe(first.setBrowseLens);
    expect(latestHookValue.setEditorLensOverride).toBe(first.setEditorLensOverride);
    expect(latestHookValue.dismissOrientationTip).toBe(first.dismissOrientationTip);
    expect(latestHookValue.browseLens).toBe(first.browseLens);
  });
});
