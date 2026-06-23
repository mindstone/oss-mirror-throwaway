import { useCallback, useMemo, useState } from 'react';
import type { FeedbackType } from '@renderer/components/BugReportDialog/BugReportDialog';

/**
 * Return type for the useDialogStates hook.
 * Contains boolean state and setters for all dialog/modal visibility states.
 */
export interface UseDialogStatesResult {
  // Quick Open (Cmd+K command palette)
  quickOpenOpen: boolean;
  setQuickOpenOpen: React.Dispatch<React.SetStateAction<boolean>>;

  // What's New modal
  whatsNewOpen: boolean;
  setWhatsNewOpen: React.Dispatch<React.SetStateAction<boolean>>;

  // Keyboard shortcuts modal
  shortcutsOpen: boolean;
  setShortcutsOpen: React.Dispatch<React.SetStateAction<boolean>>;

  // Time saved celebration modal
  timeSavedModalOpen: boolean;
  setTimeSavedModalOpen: React.Dispatch<React.SetStateAction<boolean>>;

  // First week celebration modal
  firstWeekCelebration: boolean;
  setFirstWeekCelebration: React.Dispatch<React.SetStateAction<boolean>>;

  // Scratchpad drawer
  scratchpadOpen: boolean;
  setScratchpadOpen: React.Dispatch<React.SetStateAction<boolean>>;

  // Local recording consent dialog
  localRecordingConsentOpen: boolean;
  setLocalRecordingConsentOpen: React.Dispatch<React.SetStateAction<boolean>>;

  // Feedback dialog (renamed from bug report)
  bugReportOpen: boolean;
  setBugReportOpen: React.Dispatch<React.SetStateAction<boolean>>;

  // Default feedback type when opening bug report via specific flows (e.g. "Request a connector")
  bugReportDefaultFeedbackType: FeedbackType | undefined;
  setBugReportDefaultFeedbackType: React.Dispatch<React.SetStateAction<FeedbackType | undefined>>;

  // Pre-fill data when opening bug report via navigation links (e.g. rebel://feedback/bug?description=...&stepsToReproduce=...&expectedBehavior=...)
  bugReportPrefill: { description?: string; stepsToReproduce?: string; expectedBehavior?: string; attachContinuityDiagnostics?: boolean } | undefined;
  setBugReportPrefill: React.Dispatch<React.SetStateAction<{ description?: string; stepsToReproduce?: string; expectedBehavior?: string; attachContinuityDiagnostics?: boolean } | undefined>>;

  // Demo mode entry dialog
  demoModeDialogOpen: boolean;
  setDemoModeDialogOpen: React.Dispatch<React.SetStateAction<boolean>>;

  // Achievement hub modal
  achievementHubOpen: boolean;
  setAchievementHubOpen: React.Dispatch<React.SetStateAction<boolean>>;

  // Graduation modal (Day 14 completion celebration)
  graduationModalOpen: boolean;
  setGraduationModalOpen: React.Dispatch<React.SetStateAction<boolean>>;

  /** Close all dialogs at once */
  closeAll: () => void;
}

/**
 * Hook for managing dialog/modal visibility states.
 * Extracts purely UI toggle states that have no business logic dependencies.
 *
 * @example
 * const { quickOpenOpen, setQuickOpenOpen, closeAll } = useDialogStates();
 *
 * // Open the quick open dialog
 * setQuickOpenOpen(true);
 *
 * // Close all dialogs (e.g., on navigation)
 * closeAll();
 */
export function useDialogStates(): UseDialogStatesResult {
  const [quickOpenOpen, setQuickOpenOpen] = useState(false);
  const [whatsNewOpen, setWhatsNewOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [timeSavedModalOpen, setTimeSavedModalOpen] = useState(false);
  const [firstWeekCelebration, setFirstWeekCelebration] = useState(false);
  const [scratchpadOpen, setScratchpadOpen] = useState(false);
  const [localRecordingConsentOpen, setLocalRecordingConsentOpen] = useState(false);
  const [bugReportOpen, setBugReportOpen] = useState(false);
  const [bugReportDefaultFeedbackType, setBugReportDefaultFeedbackType] = useState<FeedbackType | undefined>(undefined);
  const [bugReportPrefill, setBugReportPrefill] = useState<{ description?: string; stepsToReproduce?: string; expectedBehavior?: string; attachContinuityDiagnostics?: boolean } | undefined>(undefined);
  const [demoModeDialogOpen, setDemoModeDialogOpen] = useState(false);
  const [achievementHubOpen, setAchievementHubOpen] = useState(false);
  const [graduationModalOpen, setGraduationModalOpen] = useState(false);
  const [notificationsVisible, setNotificationsVisible] = useState(false); // Driven by pending approval count — auto-opens when notifications arrive

  const closeAll = useCallback(() => {
    setQuickOpenOpen(false);
    setWhatsNewOpen(false);
    setShortcutsOpen(false);
    setTimeSavedModalOpen(false);
    setFirstWeekCelebration(false);
    setScratchpadOpen(false);
    setLocalRecordingConsentOpen(false);
    setBugReportOpen(false);
    setBugReportDefaultFeedbackType(undefined);
    setBugReportPrefill(undefined);
    setDemoModeDialogOpen(false);
    setAchievementHubOpen(false);
    setGraduationModalOpen(false);
  }, []);

  // Return a stable object to avoid re-render cascades
  return useMemo(
    () => ({
      quickOpenOpen,
      setQuickOpenOpen,
      whatsNewOpen,
      setWhatsNewOpen,
      shortcutsOpen,
      setShortcutsOpen,
      timeSavedModalOpen,
      setTimeSavedModalOpen,
      firstWeekCelebration,
      setFirstWeekCelebration,
      scratchpadOpen,
      setScratchpadOpen,
      localRecordingConsentOpen,
      setLocalRecordingConsentOpen,
      bugReportOpen,
      setBugReportOpen,
      bugReportDefaultFeedbackType,
      setBugReportDefaultFeedbackType,
      bugReportPrefill,
      setBugReportPrefill,
      demoModeDialogOpen,
      setDemoModeDialogOpen,
      achievementHubOpen,
      setAchievementHubOpen,
      graduationModalOpen,
      setGraduationModalOpen,
      notificationsVisible,
      setNotificationsVisible,
      closeAll,
    }),
    [
      quickOpenOpen,
      whatsNewOpen,
      shortcutsOpen,
      timeSavedModalOpen,
      firstWeekCelebration,
      scratchpadOpen,
      localRecordingConsentOpen,
      bugReportOpen,
      bugReportDefaultFeedbackType,
      bugReportPrefill,
      demoModeDialogOpen,
      achievementHubOpen,
      graduationModalOpen,
      notificationsVisible,
      closeAll,
    ]
  );
}
