import { useCallback, useEffect, useState } from 'react';

export const BTS_DETAILS_HAS_RENDERED_KEY = 'rebel.bts-details.has-rendered';
export const BTS_DETAILS_USER_PREFERENCE_KEY = 'rebel.bts-details.user-preference';

type StoredPreference = 'open' | 'closed';

type FirstRenderOpenStateOptions = {
  hasRenderedKey: string;
  userPreferenceKey: string;
};

function readInitialOpenState({
  hasRenderedKey,
  userPreferenceKey,
}: FirstRenderOpenStateOptions): boolean {
  try {
    const hasRendered = window.localStorage.getItem(hasRenderedKey) === 'true';
    if (!hasRendered) {
      return true;
    }
    return window.localStorage.getItem(userPreferenceKey) === 'open';
  } catch {
    return true;
  }
}

function writeStorageValue(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // This is a disposable UI preference. If localStorage is unavailable, keep
    // the in-memory state and avoid blocking Settings.
  }
}

export function useFirstRenderOpenState(
  options: FirstRenderOpenStateOptions,
): readonly [boolean, (next: boolean | ((current: boolean) => boolean)) => void] {
  const [open, setOpenState] = useState(() => readInitialOpenState(options));

  useEffect(() => {
    writeStorageValue(options.hasRenderedKey, 'true');
  }, [options.hasRenderedKey]);

  const setOpen = useCallback((next: boolean | ((current: boolean) => boolean)) => {
    setOpenState((current) => {
      const resolved = typeof next === 'function' ? next(current) : next;
      const preference: StoredPreference = resolved ? 'open' : 'closed';
      writeStorageValue(options.userPreferenceKey, preference);
      return resolved;
    });
  }, [options.userPreferenceKey]);

  return [open, setOpen] as const;
}
