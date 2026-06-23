import { describe, expect, it } from 'vitest';
import { TutorialNudge, shouldShowTutorialNudge, type TutorialNudgeVisibilityArgs } from './TutorialNudge';

function makeArgs(overrides: Partial<TutorialNudgeVisibilityArgs> = {}): TutorialNudgeVisibilityArgs {
  return {
    isThinking: true,
    settingsLoading: false,
    hasVideo: true,
    canShowForSession: true,
    dismissedThisSession: false,
    revealReady: true,
    ...overrides,
  };
}

describe('shouldShowTutorialNudge', () => {
  it('returns true when all visibility guards pass', () => {
    expect(shouldShowTutorialNudge(makeArgs())).toBe(true);
  });

  it('returns false when the turn is not thinking', () => {
    expect(shouldShowTutorialNudge(makeArgs({ isThinking: false }))).toBe(false);
  });

  it('returns false while settings are still loading', () => {
    expect(shouldShowTutorialNudge(makeArgs({ settingsLoading: true }))).toBe(false);
  });

  it('returns false when no tutorial video is available', () => {
    expect(shouldShowTutorialNudge(makeArgs({ hasVideo: false }))).toBe(false);
  });

  it('returns false when already shown for this session', () => {
    expect(shouldShowTutorialNudge(makeArgs({ canShowForSession: false }))).toBe(false);
  });

  it('returns false when dismissed in this session', () => {
    expect(shouldShowTutorialNudge(makeArgs({ dismissedThisSession: true }))).toBe(false);
  });

  it('returns false before the reveal delay finishes', () => {
    expect(shouldShowTutorialNudge(makeArgs({ revealReady: false }))).toBe(false);
  });
});

describe('TutorialNudge export', () => {
  it('has a displayName for debugging', () => {
    expect(TutorialNudge.displayName).toBe('TutorialNudge');
  });
});
