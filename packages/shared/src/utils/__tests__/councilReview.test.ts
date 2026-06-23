import { describe, it, expect } from 'vitest';
import {
  COUNCIL_REVIEW_PROMPT,
  isCouncilReviewAvailable,
} from '../councilReview';

describe('COUNCIL_REVIEW_PROMPT', () => {
  it('is a non-empty string', () => {
    expect(typeof COUNCIL_REVIEW_PROMPT).toBe('string');
    expect(COUNCIL_REVIEW_PROMPT.length).toBeGreaterThan(0);
  });
});

describe('isCouncilReviewAvailable', () => {
  it('returns false for null settings', () => {
    expect(isCouncilReviewAvailable(null)).toBe(false);
  });

  it('returns false for undefined settings', () => {
    expect(isCouncilReviewAvailable(undefined)).toBe(false);
  });

  it('returns false when no profiles have councilEnabled', () => {
    expect(isCouncilReviewAvailable({
      localModel: { profiles: [{ councilEnabled: false, model: 'gpt-4' }, { model: 'gemini' }] },
    })).toBe(false);
  });

  it('returns false when councilEnabled but no model', () => {
    expect(isCouncilReviewAvailable({
      localModel: { profiles: [{ councilEnabled: true }] },
    })).toBe(false);
  });

  it('returns false when profiles array is empty', () => {
    expect(isCouncilReviewAvailable({
      localModel: { profiles: [] },
    })).toBe(false);
  });

  it('returns false when localModel is missing', () => {
    expect(isCouncilReviewAvailable({})).toBe(false);
  });

  it('returns true when at least one profile has councilEnabled with model', () => {
    expect(isCouncilReviewAvailable({
      localModel: { profiles: [{ councilEnabled: false, model: 'gpt-4' }, { councilEnabled: true, model: 'gemini-pro' }] },
    })).toBe(true);
  });

  it('returns true with only a council-enabled profile (no experimental flag required)', () => {
    expect(isCouncilReviewAvailable({
      localModel: { profiles: [{ councilEnabled: true, model: 'gpt-5.2' }] },
    })).toBe(true);
  });

  it('returns false when council-enabled profile is disabled', () => {
    expect(isCouncilReviewAvailable({
      localModel: { profiles: [{ councilEnabled: true, model: 'gpt-5.5', enabled: false }] },
    })).toBe(false);
  });

  it('returns true when council-enabled profile has enabled undefined (backward compat)', () => {
    expect(isCouncilReviewAvailable({
      localModel: { profiles: [{ councilEnabled: true, model: 'gpt-5.5' }] },
    })).toBe(true);
  });

  it('returns true when council-enabled profile has enabled explicitly true', () => {
    expect(isCouncilReviewAvailable({
      localModel: { profiles: [{ councilEnabled: true, model: 'gpt-5.5', enabled: true }] },
    })).toBe(true);
  });

  it('returns false when the only council profile is disconnected', () => {
    expect(isCouncilReviewAvailable({
      localModel: {
        profiles: [{ councilEnabled: true, model: 'openai/gpt-5.5', enabled: true, id: 'dead' }],
      },
    }, {
      isProfileLive: (profile) => profile.id !== 'dead',
    })).toBe(false);
  });

  it('returns true when another council profile is live', () => {
    expect(isCouncilReviewAvailable({
      localModel: {
        profiles: [
          { councilEnabled: true, model: 'openai/gpt-5.5', enabled: true, id: 'dead' },
          { councilEnabled: true, model: 'gemini-2.5-pro', enabled: true, id: 'live' },
        ],
      },
    }, {
      isProfileLive: (profile) => profile.id === 'live',
    })).toBe(true);
  });
});
