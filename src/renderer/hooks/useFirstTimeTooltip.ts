/**
 * useFirstTimeTooltip — fires a toast exactly once per tooltip key.
 *
 * Persists "shown" state in `settings.firstTimeTooltips` so each tooltip
 * appears only the first time a feature is used, even across app restarts.
 *
 * Usage:
 *   const { shouldShow, markShown } = useFirstTimeTooltip('memoryFirstSave');
 *   useEffect(() => {
 *     if (triggerCondition && shouldShow) {
 *       showToast({ title: '...', description: '...' });
 *       markShown();
 *     }
 *   }, [triggerCondition, shouldShow, markShown]);
 */

import { useCallback, useMemo, useState } from 'react';
import type { AppSettings } from '@shared/types';
import { useSettingsSafe } from '@renderer/features/settings/SettingsProvider';

export type FirstTimeTooltipKey =
  | 'memoryFirstSave'
  | 'permissionFirstPrompt'
  | 'skillFirstUse'
  | 'mentionFirstUse'
  | 'automationFirstRun'
  | 'spacesFirstUse';

interface UseFirstTimeTooltipResult {
  /** True if this tooltip has never been shown. */
  shouldShow: boolean;
  /** Persist that this tooltip has been shown (idempotent). */
  markShown: () => void;
}

type SaveSettingsWith = (
  updater?: (draft: AppSettings) => AppSettings,
  options?: { keepOpen?: boolean }
) => Promise<void>;

interface UseFirstTimeTooltipOptions {
  /**
   * Optional injected settings dependencies for places where SettingsProvider
   * is mounted lower in the tree (e.g. App.tsx root orchestration).
   */
  settings?: AppSettings | null;
  saveSettingsWith?: SaveSettingsWith;
}

export function useFirstTimeTooltip(
  key: FirstTimeTooltipKey,
  options?: UseFirstTimeTooltipOptions
): UseFirstTimeTooltipResult {
  const settingsContext = useSettingsSafe();
  const settings = options?.settings ?? settingsContext?.settings;
  const saveSettingsWith = options?.saveSettingsWith ?? settingsContext?.saveSettingsWith;

  // Synchronous local guard that flips to true the instant markShown() is
  // called, closing the async gap before saveSettingsWith round-trips back.
  const [locallyMarked, setLocallyMarked] = useState(false);

  const shouldShow = useMemo(() => {
    if (!settings || locallyMarked) {
      return false;
    }
    return !settings.firstTimeTooltips?.[key];
  }, [settings, key, locallyMarked]);

  const markShown = useCallback(() => {
    if (locallyMarked || !settings || !saveSettingsWith) {
      return;
    }
    setLocallyMarked(true);
    void saveSettingsWith((draft) => ({
      ...draft,
      firstTimeTooltips: {
        ...draft.firstTimeTooltips,
        [key]: true,
      },
    }));
  }, [key, locallyMarked, saveSettingsWith, settings]);

  return { shouldShow, markShown };
}
