import { useCallback, useEffect, useMemo, useState } from 'react';
import { type LibraryLens, DEFAULT_LENS } from '../types/lens';
import { parseLibraryLensPreference } from '../utils/parseLibraryLensPreference';

// Signpost: keep lens-state transitions aligned with the "Lens Transition State Machine" in
// `docs/plans/260522_library_lens_unification.md` and the evergreen behavior notes in
// `docs/project/LIBRARY_AND_FILE_ACCESS.md`.
export const LIBRARY_LENS_STORAGE_KEY = 'library.lens.v1';
export const LIBRARY_LENS_TIP_DISMISSED_KEY = 'library.lens.tip.v1';
const LEGACY_PLACEHOLDER_CHAR = String.fromCharCode(42);
const LEGACY_LIBRARY_LENS_STORAGE_KEY = LEGACY_PLACEHOLDER_CHAR.repeat(15);
const LEGACY_LIBRARY_LENS_TIP_DISMISSED_KEY = LEGACY_PLACEHOLDER_CHAR.repeat(39);

interface LibraryLensState {
  browseLens: LibraryLens;
  editorLensOverride: LibraryLens | null;
  effectiveLens: LibraryLens;
  orientationTipDismissed: boolean;
}

interface LibraryLensApi extends LibraryLensState {
  setBrowseLens: (next: LibraryLens | ((prev: LibraryLens) => LibraryLens)) => void;
  setEditorLensOverride: (next: LibraryLens | null) => void;
  dismissOrientationTip: () => void;
}

function migrateLegacyPlaceholderKey(legacyKey: string, nextKey: string): boolean {
  try {
    const legacyValue = window.localStorage.getItem(legacyKey);
    if (legacyValue === null) return false;
    const canonicalValue = window.localStorage.getItem(nextKey);

    if (canonicalValue !== null) {
      window.localStorage.removeItem(legacyKey);
      console.warn('[lens] Removed stale legacy placeholder key because canonical key already exists', {
        from: legacyKey,
        to: nextKey,
      });
      return false;
    }

    window.localStorage.setItem(nextKey, legacyValue);
    window.localStorage.removeItem(legacyKey);
    console.warn('[lens] Migrated persisted preference from legacy placeholder key', {
      from: legacyKey,
      to: nextKey,
    });
    return true;
  } catch (error) {
    console.warn('[lens] Failed to migrate persisted preference from legacy placeholder key', {
      from: legacyKey,
      to: nextKey,
      error,
    });
    return false;
  }
}

function safeRemoveItem(key: string) {
  try {
    window.localStorage.removeItem(key);
  } catch (error) {
    console.warn('[lens] Failed to remove invalid storage entry', { key, error });
  }
}

function readBrowseLens(): LibraryLens {
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(LIBRARY_LENS_STORAGE_KEY);
  } catch (error) {
    console.warn('[lens] Failed to read persisted lens preference', { error });
    return DEFAULT_LENS;
  }

  const result = parseLibraryLensPreference(raw);
  if (result.ok) {
    if (result.migratedFromView === 'list') {
      try {
        window.localStorage.setItem(LIBRARY_LENS_STORAGE_KEY, JSON.stringify(result.lens));
        console.warn("[lens] Migrated persisted view 'list' -> 'cards'", {
          from: 'list',
          to: 'cards',
        });
      } catch (error) {
        console.warn('[lens] Failed to persist migrated lens preference', { error });
      }
    }
    return result.lens;
  }

  if (result.reason !== 'empty') {
    console.warn('[lens] Invalid persisted lens preference; falling back to default', {
      reason: result.reason,
    });
    safeRemoveItem(LIBRARY_LENS_STORAGE_KEY);
  }

  return DEFAULT_LENS;
}

function readTipDismissed(): boolean {
  try {
    return window.localStorage.getItem(LIBRARY_LENS_TIP_DISMISSED_KEY) === '1';
  } catch (error) {
    console.warn('[lens] Failed to read orientation-tip preference', { error });
    return false;
  }
}

function lensesEqual(a: LibraryLens, b: LibraryLens): boolean {
  return a.filter === b.filter && a.view === b.view && a.facet === b.facet;
}

export function useLibraryLens(): LibraryLensApi {
  const [browseLens, setBrowseLensState] = useState<LibraryLens>(() => readBrowseLens());
  const [editorLensOverride, setEditorLensOverrideState] =
    useState<LibraryLens | null>(null);
  const [orientationTipDismissed, setOrientationTipDismissed] =
    useState<boolean>(() => readTipDismissed());

  useEffect(() => {
    const lensMigrated = migrateLegacyPlaceholderKey(
      LEGACY_LIBRARY_LENS_STORAGE_KEY,
      LIBRARY_LENS_STORAGE_KEY,
    );
    const tipMigrated = migrateLegacyPlaceholderKey(
      LEGACY_LIBRARY_LENS_TIP_DISMISSED_KEY,
      LIBRARY_LENS_TIP_DISMISSED_KEY,
    );

    if (lensMigrated) {
      const migratedLens = readBrowseLens();
      setBrowseLensState((previous) => (
        lensesEqual(previous, migratedLens) ? previous : migratedLens
      ));
    }
    if (tipMigrated) {
      setOrientationTipDismissed(readTipDismissed());
    }
  }, []);

  const setBrowseLens: LibraryLensApi['setBrowseLens'] = useCallback((next) => {
    setBrowseLensState((prev) => {
      const resolved =
        typeof next === 'function'
          ? (next as (previous: LibraryLens) => LibraryLens)(prev)
          : next;
      if (lensesEqual(prev, resolved)) return prev;
      try {
        window.localStorage.setItem(LIBRARY_LENS_STORAGE_KEY, JSON.stringify(resolved));
      } catch (error) {
        console.warn('[lens] Failed to persist browse lens preference', {
          error,
          resolved,
        });
      }
      return resolved;
    });
    setEditorLensOverrideState(null);
  }, []);

  const setEditorLensOverride: LibraryLensApi['setEditorLensOverride'] = useCallback(
    (next) => {
      setEditorLensOverrideState((prev) => {
        if (prev === next) return prev;
        if (prev && next && lensesEqual(prev, next)) return prev;
        return next;
      });
    },
    [],
  );

  const dismissOrientationTip = useCallback(() => {
    setOrientationTipDismissed(true);
    try {
      window.localStorage.setItem(LIBRARY_LENS_TIP_DISMISSED_KEY, '1');
    } catch (error) {
      console.warn('[lens] Failed to persist orientation-tip dismissal', { error });
    }
  }, []);

  useEffect(() => {
    function onStorage(event: StorageEvent) {
      if (event.key !== LIBRARY_LENS_STORAGE_KEY) return;

      const result = parseLibraryLensPreference(event.newValue);
      if (result.ok) {
        if (result.migratedFromView === 'list') {
          try {
            window.localStorage.setItem(LIBRARY_LENS_STORAGE_KEY, JSON.stringify(result.lens));
            console.warn("[lens] Migrated persisted view 'list' -> 'cards'", {
              from: 'list',
              to: 'cards',
            });
          } catch (error) {
            console.warn('[lens] Failed to persist migrated lens preference', { error });
          }
        }
        setBrowseLensState((prev) => (lensesEqual(prev, result.lens) ? prev : result.lens));
        return;
      }

      if (result.reason !== 'empty') {
        console.warn('[lens] Cross-window storage event carried invalid lens; ignoring', {
          reason: result.reason,
        });
      }
    }

    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const effectiveLens = editorLensOverride ?? browseLens;

  return useMemo(
    () => ({
      browseLens,
      editorLensOverride,
      effectiveLens,
      orientationTipDismissed,
      setBrowseLens,
      setEditorLensOverride,
      dismissOrientationTip,
    }),
    [
      browseLens,
      editorLensOverride,
      effectiveLens,
      orientationTipDismissed,
      setBrowseLens,
      setEditorLensOverride,
      dismissOrientationTip,
    ],
  );
}
