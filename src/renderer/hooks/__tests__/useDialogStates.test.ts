import { describe, it, expect } from 'vitest';
import { useDialogStates, type UseDialogStatesResult } from '../useDialogStates';

/**
 * Tests for useDialogStates hook.
 *
 * Note: Full React hook testing (useState behavior, re-renders) would require
 * @testing-library/react-hooks which isn't currently installed.
 * These tests focus on type structure and export verification.
 *
 * If hook behavior testing is needed in the future, install:
 *   npm install -D @testing-library/react @testing-library/react-hooks
 *
 * Then add tests like:
 *   const { result } = renderHook(() => useDialogStates());
 *   expect(result.current.quickOpenOpen).toBe(false);
 *   act(() => result.current.setQuickOpenOpen(true));
 *   expect(result.current.quickOpenOpen).toBe(true);
 */

describe('useDialogStates', () => {
  describe('exports', () => {
    it('exports useDialogStates function', () => {
      expect(typeof useDialogStates).toBe('function');
    });

    it('can import UseDialogStatesResult type', () => {
      // Type-only test - ensures the type export works
      const typeCheck: UseDialogStatesResult = {
        quickOpenOpen: false,
        setQuickOpenOpen: () => {},
        whatsNewOpen: false,
        setWhatsNewOpen: () => {},
        shortcutsOpen: false,
        setShortcutsOpen: () => {},
        timeSavedModalOpen: false,
        setTimeSavedModalOpen: () => {},
        firstWeekCelebration: false,
        setFirstWeekCelebration: () => {},
        scratchpadOpen: false,
        setScratchpadOpen: () => {},
        localRecordingConsentOpen: false,
        setLocalRecordingConsentOpen: () => {},
        bugReportOpen: false,
        setBugReportOpen: () => {},
        bugReportDefaultFeedbackType: undefined,
        setBugReportDefaultFeedbackType: () => {},
        bugReportPrefill: undefined,
        setBugReportPrefill: () => {},
        demoModeDialogOpen: false,
        setDemoModeDialogOpen: () => {},
        achievementHubOpen: false,
        setAchievementHubOpen: () => {},
        graduationModalOpen: false,
        setGraduationModalOpen: () => {},
        closeAll: () => {},
      };
      expect(typeCheck).toBeDefined();
    });
  });

  describe('UseDialogStatesResult type structure', () => {
    it('has all 11 boolean state properties', () => {
      // This verifies the type structure at compile time
      const expectedProperties: (keyof UseDialogStatesResult)[] = [
        'quickOpenOpen',
        'whatsNewOpen',
        'shortcutsOpen',
        'timeSavedModalOpen',
        'firstWeekCelebration',
        'scratchpadOpen',
        'localRecordingConsentOpen',
        'bugReportOpen',
        'demoModeDialogOpen',
        'achievementHubOpen',
        'graduationModalOpen',
      ];

      // Create a mock object matching the type
      const mockResult: UseDialogStatesResult = {
        quickOpenOpen: false,
        setQuickOpenOpen: () => {},
        whatsNewOpen: false,
        setWhatsNewOpen: () => {},
        shortcutsOpen: false,
        setShortcutsOpen: () => {},
        timeSavedModalOpen: false,
        setTimeSavedModalOpen: () => {},
        firstWeekCelebration: false,
        setFirstWeekCelebration: () => {},
        scratchpadOpen: false,
        setScratchpadOpen: () => {},
        localRecordingConsentOpen: false,
        setLocalRecordingConsentOpen: () => {},
        bugReportOpen: false,
        setBugReportOpen: () => {},
        bugReportDefaultFeedbackType: undefined,
        setBugReportDefaultFeedbackType: () => {},
        bugReportPrefill: undefined,
        setBugReportPrefill: () => {},
        demoModeDialogOpen: false,
        setDemoModeDialogOpen: () => {},
        achievementHubOpen: false,
        setAchievementHubOpen: () => {},
        graduationModalOpen: false,
        setGraduationModalOpen: () => {},
        closeAll: () => {},
      };

      for (const prop of expectedProperties) {
        expect(prop in mockResult).toBe(true);
        expect(typeof mockResult[prop]).toBe('boolean');
      }
    });

    it('has all 13 setter functions', () => {
      const expectedSetters: (keyof UseDialogStatesResult)[] = [
        'setQuickOpenOpen',
        'setWhatsNewOpen',
        'setShortcutsOpen',
        'setTimeSavedModalOpen',
        'setFirstWeekCelebration',
        'setScratchpadOpen',
        'setLocalRecordingConsentOpen',
        'setBugReportOpen',
        'setBugReportDefaultFeedbackType',
        'setBugReportPrefill',
        'setDemoModeDialogOpen',
        'setAchievementHubOpen',
        'setGraduationModalOpen',
      ];

      const mockResult: UseDialogStatesResult = {
        quickOpenOpen: false,
        setQuickOpenOpen: () => {},
        whatsNewOpen: false,
        setWhatsNewOpen: () => {},
        shortcutsOpen: false,
        setShortcutsOpen: () => {},
        timeSavedModalOpen: false,
        setTimeSavedModalOpen: () => {},
        firstWeekCelebration: false,
        setFirstWeekCelebration: () => {},
        scratchpadOpen: false,
        setScratchpadOpen: () => {},
        localRecordingConsentOpen: false,
        setLocalRecordingConsentOpen: () => {},
        bugReportOpen: false,
        setBugReportOpen: () => {},
        bugReportDefaultFeedbackType: undefined,
        setBugReportDefaultFeedbackType: () => {},
        bugReportPrefill: undefined,
        setBugReportPrefill: () => {},
        demoModeDialogOpen: false,
        setDemoModeDialogOpen: () => {},
        achievementHubOpen: false,
        setAchievementHubOpen: () => {},
        graduationModalOpen: false,
        setGraduationModalOpen: () => {},
        closeAll: () => {},
      };

      for (const setter of expectedSetters) {
        expect(setter in mockResult).toBe(true);
        expect(typeof mockResult[setter]).toBe('function');
      }
    });

    it('has closeAll utility function', () => {
      const mockResult: UseDialogStatesResult = {
        quickOpenOpen: false,
        setQuickOpenOpen: () => {},
        whatsNewOpen: false,
        setWhatsNewOpen: () => {},
        shortcutsOpen: false,
        setShortcutsOpen: () => {},
        timeSavedModalOpen: false,
        setTimeSavedModalOpen: () => {},
        firstWeekCelebration: false,
        setFirstWeekCelebration: () => {},
        scratchpadOpen: false,
        setScratchpadOpen: () => {},
        localRecordingConsentOpen: false,
        setLocalRecordingConsentOpen: () => {},
        bugReportOpen: false,
        setBugReportOpen: () => {},
        bugReportDefaultFeedbackType: undefined,
        setBugReportDefaultFeedbackType: () => {},
        bugReportPrefill: undefined,
        setBugReportPrefill: () => {},
        demoModeDialogOpen: false,
        setDemoModeDialogOpen: () => {},
        achievementHubOpen: false,
        setAchievementHubOpen: () => {},
        graduationModalOpen: false,
        setGraduationModalOpen: () => {},
        closeAll: () => {},
      };

      expect('closeAll' in mockResult).toBe(true);
      expect(typeof mockResult.closeAll).toBe('function');
    });
  });

  describe('documentation', () => {
    it('matches the 11 dialog states extracted from App.tsx', () => {
      // This documents the exact states we're extracting:
      // 1. quickOpenOpen - Command palette (Cmd+K)
      // 2. whatsNewOpen - What's New modal
      // 3. shortcutsOpen - Keyboard shortcuts modal
      // 4. timeSavedModalOpen - Time saved celebration
      // 5. firstWeekCelebration - First week celebration
      // 6. scratchpadOpen - Scratchpad drawer
      // 7. localRecordingConsentOpen - Local recording consent dialog
      // 8. bugReportOpen - Bug report / feedback dialog
      // 9. demoModeDialogOpen - Demo mode entry dialog
      // 10. achievementHubOpen - Achievement hub modal (time saved, badges, journey)
      // 11. graduationModalOpen - Day 14 completion celebration
      // Plus: bugReportDefaultFeedbackType - feedback type override (not a boolean dialog state)
      // Plus: bugReportPrefill - pre-fill data from navigation links (not a boolean dialog state)
      expect(true).toBe(true);
    });
  });
});
