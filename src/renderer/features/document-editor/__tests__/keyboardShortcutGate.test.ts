import { describe, expect, it } from 'vitest';
import { shouldHandleEditorShortcut } from '../utils/keyboardShortcutGate';

describe('shouldHandleEditorShortcut', () => {
  it('returns true when no dialog is open (editor owns the event)', () => {
    expect(
      shouldHandleEditorShortcut({
        showGoToHeading: false,
        showSkillHistory: false,
      }),
    ).toBe(true);
  });

  it('returns false when GoToHeading dialog is open (dialog owns Escape/Cmd+S)', () => {
    expect(
      shouldHandleEditorShortcut({
        showGoToHeading: true,
        showSkillHistory: false,
      }),
    ).toBe(false);
  });

  it('returns false when SkillHistory dialog is open', () => {
    expect(
      shouldHandleEditorShortcut({
        showGoToHeading: false,
        showSkillHistory: true,
      }),
    ).toBe(false);
  });

  it('returns false when any dialog combination is open', () => {
    expect(
      shouldHandleEditorShortcut({
        showGoToHeading: true,
        showSkillHistory: true,
      }),
    ).toBe(false);
  });
});
