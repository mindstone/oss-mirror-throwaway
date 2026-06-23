import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AppSettings } from '@shared/types';
import { tracking } from '../src/tracking';

type SaveSettingsWith = (updater: (current: AppSettings) => AppSettings) => Promise<void>;

const PROMPT_DELAY_DAYS = 3;
const PROMPT_ID = 'desktop-notification-prompt';
const days = (n: number) => n * 24 * 60 * 60 * 1000;

export type UseDesktopNotificationPromptOptions = {
  settings: AppSettings | null;
  saveSettingsWith: SaveSettingsWith;
  blocked?: boolean;
};

export type UseDesktopNotificationPromptResult = {
  showPrompt: boolean;
  handleEnable: () => Promise<void>;
  handleDismiss: (source?: 'secondary_button' | 'dialog_close') => Promise<void>;
};

export const useDesktopNotificationPrompt = ({
  settings,
  saveSettingsWith,
  blocked,
}: UseDesktopNotificationPromptOptions): UseDesktopNotificationPromptResult => {
  const [open, setOpen] = useState(false);
  const mountTimeRef = useRef(Date.now());
  const daysSinceOnboarding = useMemo(() => {
    if (!settings?.onboardingFirstCompletedAt) return null;
    return (mountTimeRef.current - settings.onboardingFirstCompletedAt) / days(1);
  }, [settings?.onboardingFirstCompletedAt]);

  const isEligible = useMemo(() => {
    if (!settings) return false;
    if (settings.notifications?.enabled === true) return false;
    if (settings.dismissedAnnouncements?.[PROMPT_ID]) return false;
    if (!settings.onboardingCompleted || !settings.onboardingFirstCompletedAt) return false;
    if (daysSinceOnboarding === null) return false;
    return daysSinceOnboarding >= PROMPT_DELAY_DAYS;
  }, [daysSinceOnboarding, settings]);

  const shouldShow = isEligible && !blocked;

  useEffect(() => {
    if (shouldShow && !open) {
      tracking.notificationsPrompt.shown(Math.floor(daysSinceOnboarding ?? 0));
      setOpen(true);
    } else if (!shouldShow && open) {
      setOpen(false);
    }
  }, [daysSinceOnboarding, open, shouldShow]);

  const handleDismiss = useCallback(async (source: 'secondary_button' | 'dialog_close' = 'dialog_close') => {
    setOpen(false);
    tracking.notificationsPrompt.dismissed(source, Math.floor(daysSinceOnboarding ?? 0));
    await saveSettingsWith((current) => ({
      ...current,
      dismissedAnnouncements: {
        ...current.dismissedAnnouncements,
        [PROMPT_ID]: true,
      },
    }));
  }, [daysSinceOnboarding, saveSettingsWith]);

  const handleEnable = useCallback(async () => {
    setOpen(false);
    tracking.notificationsPrompt.enabled(Math.floor(daysSinceOnboarding ?? 0));
    await saveSettingsWith((current) => ({
      ...current,
      notifications: {
        ...current.notifications,
        enabled: true,
        automationComplete: true,
        conversationComplete: true,
      },
      dismissedAnnouncements: {
        ...current.dismissedAnnouncements,
        [PROMPT_ID]: true,
      },
    }));
  }, [daysSinceOnboarding, saveSettingsWith]);

  return {
    showPrompt: open,
    handleEnable,
    handleDismiss,
  };
};
