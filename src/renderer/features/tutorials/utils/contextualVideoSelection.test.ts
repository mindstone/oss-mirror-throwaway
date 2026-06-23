import { describe, expect, it } from 'vitest';
import { TUTORIAL_VIDEOS } from '@shared/config/tutorialVideos';
import {
  getContextualNextVideo,
  type ContextualVideoProfile,
} from './contextualVideoSelection';

/**
 * A baseline profile where every feature is already configured. Tests flip
 * individual flags to exercise specific priority rules.
 */
function makeProfile(overrides: Partial<ContextualVideoProfile> = {}): ContextualVideoProfile {
  return {
    voiceConfigured: true,
    hasConnections: true,
    hasAutomations: true,
    hasSpaces: true,
    meetingBotConfigured: true,
    privacyModeUsed: true,
    loading: false,
    ...overrides,
  };
}

describe('getContextualNextVideo', () => {
  it('returns the voice video for a user who has not configured voice', () => {
    const profile = makeProfile({ voiceConfigured: false });
    const result = getContextualNextVideo(profile, new Set());
    expect(result?.id).toBe('voice');
  });

  it('returns the connected-tools video for a user with no connections', () => {
    const profile = makeProfile({ hasConnections: false });
    const result = getContextualNextVideo(profile, new Set());
    expect(result?.id).toBe('connected-tools');
  });

  it('skips already-watched contextual videos and falls back to the next priority', () => {
    // Both connections and voice are missing; connections would normally win,
    // but it has already been watched — voice should be picked instead.
    const profile = makeProfile({ hasConnections: false, voiceConfigured: false });
    const result = getContextualNextVideo(profile, new Set(['connected-tools']));
    expect(result?.id).toBe('voice');
  });

  it('falls back to catalog order when all contextual candidates are already watched', () => {
    // Every feature is missing, so every contextual video is a candidate —
    // but all six have been watched. The catalog-order fallback should kick in
    // and return the first unwatched video from the "new-here" path.
    const profile = makeProfile({
      voiceConfigured: false,
      hasConnections: false,
      hasAutomations: false,
      hasSpaces: false,
      meetingBotConfigured: false,
      privacyModeUsed: false,
    });
    const watched = new Set([
      'connected-tools',
      'voice',
      'automations',
      'spaces',
      'meeting-prep',
      'privacy-local-first',
    ]);
    const result = getContextualNextVideo(profile, watched);
    expect(result?.id).toBe('why-rebel');
    expect(result?.path).toBe('new-here');
  });

  it('returns null when every video has been watched', () => {
    const allIds = new Set(TUTORIAL_VIDEOS.map((v) => v.id));
    const profile = makeProfile({
      voiceConfigured: false,
      hasConnections: false,
      hasAutomations: false,
      hasSpaces: false,
      meetingBotConfigured: false,
      privacyModeUsed: false,
    });
    const result = getContextualNextVideo(profile, allIds);
    expect(result).toBeNull();
  });

  it('falls back to catalog order when profile.loading is true', () => {
    // Even though connections are "missing" in the loading profile, the
    // loading flag forces catalog-order selection so we never render a
    // contextual pick based on half-loaded data.
    const profile = makeProfile({
      loading: true,
      hasConnections: false,
      voiceConfigured: false,
    });
    const result = getContextualNextVideo(profile, new Set());
    expect(result?.id).toBe('why-rebel');
    expect(result?.path).toBe('new-here');
  });

  it('prioritizes connections over voice when both are missing', () => {
    const profile = makeProfile({ hasConnections: false, voiceConfigured: false });
    const result = getContextualNextVideo(profile, new Set());
    expect(result?.id).toBe('connected-tools');
  });

  it('handles an empty watchedVideoIds set', () => {
    const profile = makeProfile({ hasConnections: false });
    const result = getContextualNextVideo(profile, new Set());
    expect(result?.id).toBe('connected-tools');
  });
});
