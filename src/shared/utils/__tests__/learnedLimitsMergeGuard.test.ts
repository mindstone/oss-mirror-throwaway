import { afterEach, describe, expect, it, vi } from 'vitest';
import { mergeIncomingProfilesPreservingLearned } from '../learnedLimitsMergeGuard';
import type { AppSettings, ModelProfile } from '@shared/types';

function withProfiles(profiles: ModelProfile[]): AppSettings {
  return {
    coreDirectory: '/tmp',
    localModel: { profiles, activeProfileId: null },
  } as unknown as AppSettings;
}

const baseProfile: ModelProfile = {
  id: 'p1',
  name: 'P1',
  model: 'gpt-test',
  providerType: 'other',
  serverUrl: 'https://example.test',
  createdAt: 1,
};

describe('mergeIncomingProfilesPreservingLearned', () => {
  it('returns incoming when local has no profiles', () => {
    const incoming = withProfiles([{ ...baseProfile, contextWindow: 100, contextWindowSource: 'auto' }]);
    expect(mergeIncomingProfilesPreservingLearned(withProfiles([]), incoming)).toBe(incoming);
  });

  it('returns incoming when incoming has no profiles AND no local recent autos to preserve', () => {
    const local = withProfiles([
      { ...baseProfile, contextWindow: 100, contextWindowSource: 'auto', contextWindowLearnedAt: 1 },
    ]);
    const incoming = withProfiles([]);
    expect(mergeIncomingProfilesPreservingLearned(local, incoming)).toBe(incoming);
  });

  it('preserves recent local-only auto profile when incoming has empty profiles array (canonical stale-sync first-overflow scenario)', () => {
    const now = 1_000_000;
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const local = withProfiles([
      {
        ...baseProfile,
        id: 'auto:newModel',
        contextWindow: 50_000,
        contextWindowSource: 'auto',
        contextWindowLearnedAt: now - 60_000,
      },
    ]);
    const incoming = withProfiles([]);
    const merged = mergeIncomingProfilesPreservingLearned(local, incoming);
    expect(merged).not.toBe(incoming);
    expect(merged.localModel!.profiles).toHaveLength(1);
    expect(merged.localModel!.profiles![0].id).toBe('auto:newModel');
    expect(merged.localModel!.profiles![0].contextWindow).toBe(50_000);
  });

  it('drops stale local-only auto profile when incoming has empty profiles array (older than 5 min)', () => {
    const now = 1_000_000;
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const local = withProfiles([
      {
        ...baseProfile,
        id: 'auto:oldModel',
        contextWindow: 50_000,
        contextWindowSource: 'auto',
        contextWindowLearnedAt: now - 10 * 60 * 1000,
      },
    ]);
    const incoming = withProfiles([]);
    const merged = mergeIncomingProfilesPreservingLearned(local, incoming);
    expect(merged).toBe(incoming);
    expect(merged.localModel!.profiles).toHaveLength(0);
  });

  it('preserves local auto when incoming auto is older', () => {
    const local = withProfiles([
      {
        ...baseProfile,
        contextWindow: 90_000,
        contextWindowSource: 'auto',
        contextWindowLearnedAt: 2_000,
      },
    ]);
    const incoming = withProfiles([
      {
        ...baseProfile,
        contextWindow: 200_000,
        contextWindowSource: 'auto',
        contextWindowLearnedAt: 1_000,
      },
    ]);
    const merged = mergeIncomingProfilesPreservingLearned(local, incoming);
    expect(merged.localModel!.profiles![0].contextWindow).toBe(90_000);
    expect(merged.localModel!.profiles![0].contextWindowLearnedAt).toBe(2_000);
  });

  it('takes incoming auto when it is newer', () => {
    const local = withProfiles([
      {
        ...baseProfile,
        contextWindow: 90_000,
        contextWindowSource: 'auto',
        contextWindowLearnedAt: 1_000,
      },
    ]);
    const incoming = withProfiles([
      {
        ...baseProfile,
        contextWindow: 80_000,
        contextWindowSource: 'auto',
        contextWindowLearnedAt: 2_000,
      },
    ]);
    const merged = mergeIncomingProfilesPreservingLearned(local, incoming);
    expect(merged.localModel!.profiles![0].contextWindow).toBe(80_000);
  });

  it('takes incoming user-set value over local auto', () => {
    const local = withProfiles([
      {
        ...baseProfile,
        contextWindow: 90_000,
        contextWindowSource: 'auto',
        contextWindowLearnedAt: 5_000,
      },
    ]);
    const incoming = withProfiles([
      {
        ...baseProfile,
        contextWindow: 200_000,
        contextWindowSource: 'user',
      },
    ]);
    const merged = mergeIncomingProfilesPreservingLearned(local, incoming);
    expect(merged.localModel!.profiles![0].contextWindow).toBe(200_000);
    expect(merged.localModel!.profiles![0].contextWindowSource).toBe('user');
  });

  it('preserves local user-set value over incoming auto', () => {
    const local = withProfiles([
      {
        ...baseProfile,
        contextWindow: 200_000,
        contextWindowSource: 'user',
      },
    ]);
    const incoming = withProfiles([
      {
        ...baseProfile,
        contextWindow: 50_000,
        contextWindowSource: 'auto',
        contextWindowLearnedAt: 9_999,
      },
    ]);
    const merged = mergeIncomingProfilesPreservingLearned(local, incoming);
    expect(merged.localModel!.profiles![0].contextWindow).toBe(200_000);
    expect(merged.localModel!.profiles![0].contextWindowSource).toBe('user');
  });

  it('passes new profiles through', () => {
    const local = withProfiles([{ ...baseProfile }]);
    const incoming = withProfiles([
      { ...baseProfile },
      { ...baseProfile, id: 'p2', name: 'P2' },
    ]);
    const merged = mergeIncomingProfilesPreservingLearned(local, incoming);
    expect(merged.localModel!.profiles).toHaveLength(2);
  });

  it('takes incoming user when both are user-set (last-write-wins)', () => {
    const local = withProfiles([
      {
        ...baseProfile,
        contextWindow: 1_500_000,
        contextWindowSource: 'user',
      },
    ]);
    const incoming = withProfiles([
      {
        ...baseProfile,
        contextWindow: 1_200_000,
        contextWindowSource: 'user',
      },
    ]);
    const merged = mergeIncomingProfilesPreservingLearned(local, incoming);
    expect(merged.localModel!.profiles![0].contextWindow).toBe(1_200_000);
    expect(merged.localModel!.profiles![0].contextWindowSource).toBe('user');
  });

  it('takes incoming user when local user value is being explicitly cleared', () => {
    const local = withProfiles([
      {
        ...baseProfile,
        contextWindow: 1_500_000,
        contextWindowSource: 'user',
      },
    ]);
    const incoming = withProfiles([
      {
        ...baseProfile,
        contextWindow: undefined,
        contextWindowSource: 'user',
      },
    ]);
    const merged = mergeIncomingProfilesPreservingLearned(local, incoming);
    expect(merged.localModel!.profiles![0].contextWindow).toBeUndefined();
    expect(merged.localModel!.profiles![0].contextWindowSource).toBe('user');
  });

  it('treats same id with a different model as a renamed profile and yields incoming as-is', () => {
    const local = withProfiles([
      {
        ...baseProfile,
        contextWindow: 90_000,
        contextWindowSource: 'auto',
        contextWindowLearnedAt: 5_000,
      },
    ]);
    const incoming = withProfiles([
      {
        ...baseProfile,
        model: 'gpt-different',
        contextWindow: 50_000,
        contextWindowSource: 'auto',
        contextWindowLearnedAt: 1_000,
      },
    ]);
    const merged = mergeIncomingProfilesPreservingLearned(local, incoming);
    const profile = merged.localModel!.profiles![0];
    expect(profile.model).toBe('gpt-different');
    expect(profile.contextWindow).toBe(50_000);
    expect(profile.contextWindowLearnedAt).toBe(1_000);
  });

  describe('local-only profile preservation (DO-NOW 1, cycle 3)', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('preserves a local-only auto profile learned within the recent window', () => {
      const now = 10_000_000;
      vi.useFakeTimers();
      vi.setSystemTime(now);

      const localOnly: ModelProfile = {
        ...baseProfile,
        id: 'auto:newModel',
        model: 'newModel',
        contextWindow: 90_000,
        contextWindowSource: 'auto',
        contextWindowLearnedAt: now - 30_000, // 30s ago — well inside 5min window
      };
      const local = withProfiles([{ ...baseProfile }, localOnly]);
      const incoming = withProfiles([{ ...baseProfile }]);

      const merged = mergeIncomingProfilesPreservingLearned(local, incoming);
      const ids = merged.localModel!.profiles!.map((p) => p.id);
      expect(ids).toContain('auto:newModel');
      const preserved = merged.localModel!.profiles!.find((p) => p.id === 'auto:newModel');
      expect(preserved?.contextWindow).toBe(90_000);
      expect(preserved?.contextWindowSource).toBe('auto');
    });

    it('drops a local-only auto profile learned outside the recent window', () => {
      const now = 10_000_000;
      vi.useFakeTimers();
      vi.setSystemTime(now);

      const stale: ModelProfile = {
        ...baseProfile,
        id: 'auto:oldModel',
        model: 'oldModel',
        contextWindow: 90_000,
        contextWindowSource: 'auto',
        contextWindowLearnedAt: now - 10 * 60 * 1000, // 10 minutes ago
      };
      const local = withProfiles([{ ...baseProfile }, stale]);
      const incoming = withProfiles([{ ...baseProfile }]);

      const merged = mergeIncomingProfilesPreservingLearned(local, incoming);
      const ids = merged.localModel!.profiles!.map((p) => p.id);
      expect(ids).not.toContain('auto:oldModel');
    });

    it('drops a local-only user-source profile (treated as a legitimate user delete)', () => {
      const local = withProfiles([
        { ...baseProfile },
        {
          ...baseProfile,
          id: 'user:userMade',
          contextWindow: 1_500_000,
          contextWindowSource: 'user',
        },
      ]);
      const incoming = withProfiles([{ ...baseProfile }]);

      const merged = mergeIncomingProfilesPreservingLearned(local, incoming);
      const ids = merged.localModel!.profiles!.map((p) => p.id);
      expect(ids).not.toContain('user:userMade');
    });

    it('handles same-id-different-model when the local profile is also recently auto-learned', () => {
      const now = 10_000_000;
      vi.useFakeTimers();
      vi.setSystemTime(now);

      const local = withProfiles([
        {
          ...baseProfile,
          id: 'shared',
          model: 'local-model',
          contextWindow: 90_000,
          contextWindowSource: 'auto',
          contextWindowLearnedAt: now - 30_000,
        },
      ]);
      const incoming = withProfiles([
        {
          ...baseProfile,
          id: 'shared',
          model: 'incoming-model',
          contextWindow: 50_000,
          contextWindowSource: 'auto',
          contextWindowLearnedAt: now - 60_000,
        },
      ]);

      const merged = mergeIncomingProfilesPreservingLearned(local, incoming);
      expect(merged.localModel!.profiles).toHaveLength(1);
      const profile = merged.localModel!.profiles![0];
      expect(profile.model).toBe('incoming-model');
      expect(profile.contextWindow).toBe(50_000);
    });
  });

  describe('output-token provenance merge (Stage 2)', () => {
    it('preserves local user-set output tokens over incoming auto', () => {
      const local = withProfiles([
        {
          ...baseProfile,
          maxOutputTokens: 16_384,
          outputTokensSource: 'user',
        },
      ]);
      const incoming = withProfiles([
        {
          ...baseProfile,
          maxOutputTokens: 8_192,
          outputTokensSource: 'auto',
          outputTokensLearnedAt: 9_000,
          outputTokensOverflowCount: 4,
          lastLearnedOutputTokens: 8_192,
        },
      ]);

      const merged = mergeIncomingProfilesPreservingLearned(local, incoming);
      const profile = merged.localModel!.profiles![0];
      expect(profile.maxOutputTokens).toBe(16_384);
      expect(profile.outputTokensSource).toBe('user');
    });

    it('takes incoming user-set output tokens over local auto', () => {
      const local = withProfiles([
        {
          ...baseProfile,
          maxOutputTokens: 8_192,
          outputTokensSource: 'auto',
          outputTokensLearnedAt: 5_000,
          outputTokensOverflowCount: 3,
          lastLearnedOutputTokens: 8_192,
        },
      ]);
      const incoming = withProfiles([
        {
          ...baseProfile,
          maxOutputTokens: 12_000,
          outputTokensSource: 'user',
        },
      ]);

      const merged = mergeIncomingProfilesPreservingLearned(local, incoming);
      const profile = merged.localModel!.profiles![0];
      expect(profile.maxOutputTokens).toBe(12_000);
      expect(profile.outputTokensSource).toBe('user');
    });

    it('preserves local newer auto output tokens over incoming older auto', () => {
      const local = withProfiles([
        {
          ...baseProfile,
          maxOutputTokens: 4_096,
          outputTokensSource: 'auto',
          outputTokensLearnedAt: 2_000,
          outputTokensOverflowCount: 2,
          lastLearnedOutputTokens: 4_096,
        },
      ]);
      const incoming = withProfiles([
        {
          ...baseProfile,
          maxOutputTokens: 8_192,
          outputTokensSource: 'auto',
          outputTokensLearnedAt: 1_000,
          outputTokensOverflowCount: 1,
          lastLearnedOutputTokens: 8_192,
        },
      ]);

      const merged = mergeIncomingProfilesPreservingLearned(local, incoming);
      const profile = merged.localModel!.profiles![0];
      expect(profile.maxOutputTokens).toBe(4_096);
      expect(profile.outputTokensLearnedAt).toBe(2_000);
      expect(profile.lastLearnedOutputTokens).toBe(4_096);
    });

    it('takes incoming newer auto output tokens over local older auto', () => {
      const local = withProfiles([
        {
          ...baseProfile,
          maxOutputTokens: 8_192,
          outputTokensSource: 'auto',
          outputTokensLearnedAt: 1_000,
          outputTokensOverflowCount: 1,
          lastLearnedOutputTokens: 8_192,
        },
      ]);
      const incoming = withProfiles([
        {
          ...baseProfile,
          maxOutputTokens: 4_096,
          outputTokensSource: 'auto',
          outputTokensLearnedAt: 2_000,
          outputTokensOverflowCount: 2,
          lastLearnedOutputTokens: 4_096,
        },
      ]);

      const merged = mergeIncomingProfilesPreservingLearned(local, incoming);
      const profile = merged.localModel!.profiles![0];
      expect(profile.maxOutputTokens).toBe(4_096);
      expect(profile.outputTokensLearnedAt).toBe(2_000);
      expect(profile.lastLearnedOutputTokens).toBe(4_096);
    });

    it('merges context-window and output-cap provenance independently', () => {
      const local = withProfiles([
        {
          ...baseProfile,
          contextWindow: 1_200_000,
          contextWindowSource: 'user',
          maxOutputTokens: 4_096,
          outputTokensSource: 'auto',
          outputTokensLearnedAt: 2_000,
          outputTokensOverflowCount: 2,
          lastLearnedOutputTokens: 4_096,
        },
      ]);
      const incoming = withProfiles([
        {
          ...baseProfile,
          contextWindow: 900_000,
          contextWindowSource: 'auto',
          contextWindowLearnedAt: 9_999,
          maxOutputTokens: 8_192,
          outputTokensSource: 'auto',
          outputTokensLearnedAt: 1_000,
          outputTokensOverflowCount: 1,
          lastLearnedOutputTokens: 8_192,
        },
      ]);

      const merged = mergeIncomingProfilesPreservingLearned(local, incoming);
      const profile = merged.localModel!.profiles![0];
      expect(profile.contextWindow).toBe(1_200_000);
      expect(profile.contextWindowSource).toBe('user');
      expect(profile.maxOutputTokens).toBe(4_096);
      expect(profile.outputTokensSource).toBe('auto');
      expect(profile.outputTokensLearnedAt).toBe(2_000);
      expect(profile.lastLearnedOutputTokens).toBe(4_096);
    });
  });

  // TDD seam for Stage 2 null-vs-undefined widening in mergeProfile().
  it('preserves local connection profileSource when incoming payload carries profileSource: null', () => {
    const local = withProfiles([
      {
        ...baseProfile,
        profileSource: 'connection',
      },
    ]);
    const incoming = withProfiles([
      {
        ...baseProfile,
        profileSource: null as unknown as ModelProfile['profileSource'],
      },
    ]);

    const merged = mergeIncomingProfilesPreservingLearned(local, incoming);
    expect(merged.localModel!.profiles![0].profileSource).toBe('connection');
  });
});
