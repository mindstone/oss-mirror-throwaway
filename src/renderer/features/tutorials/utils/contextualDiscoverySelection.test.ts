import { describe, expect, it } from 'vitest';
import type { TutorialVideo } from '@shared/config/tutorialVideos';
import type { ChangelogHighlight } from '@renderer/features/whats-new/utils/changelogParser';
import {
  hashSessionId,
  selectDiscoveryItem,
  type DiscoverySurface,
} from './contextualDiscoverySelection';

/**
 * Minimal mock `TutorialVideo` — only the shape the selection layer needs to
 * pass through is required, so we avoid coupling to the real catalog.
 */
function makeTutorial(overrides: Partial<TutorialVideo> = {}): TutorialVideo {
  return {
    id: 'mock-video',
    youtubeId: 'mockYT',
    title: 'Mock Tutorial',
    duration: '3:14',
    path: 'new-here',
    orderInPath: 1,
    quip: 'Mock quip.',
    ...overrides,
  };
}

function makeHighlight(overrides: Partial<ChangelogHighlight> = {}): ChangelogHighlight {
  return {
    title: 'Mock Changelog Highlight',
    description: 'Mock description for testing.',
    ...overrides,
  };
}

/**
 * Helper: probe both surfaces for the same session + candidates and return
 * the resulting item types. Used to assert per-surface inversion.
 */
function probeSurfaces(
  sessionId: string,
  tutorial: TutorialVideo | null,
  highlight: ChangelogHighlight | null,
): { empty: 'tutorial' | 'changelog' | null; nudge: 'tutorial' | 'changelog' | null } {
  const emptyItem = selectDiscoveryItem({
    sessionId,
    surface: 'empty-state',
    tutorialCandidate: tutorial,
    changelogCandidate: highlight,
  });
  const nudgeItem = selectDiscoveryItem({
    sessionId,
    surface: 'nudge',
    tutorialCandidate: tutorial,
    changelogCandidate: highlight,
  });
  return {
    empty: emptyItem?.type ?? null,
    nudge: nudgeItem?.type ?? null,
  };
}

describe('hashSessionId', () => {
  it('returns the same hash for the same sessionId (determinism)', () => {
    expect(hashSessionId('session-abc')).toBe(hashSessionId('session-abc'));
    expect(hashSessionId('')).toBe(hashSessionId(''));
  });

  it('returns a non-negative integer', () => {
    for (const id of ['', 'a', 'session-1', 'session-2', '00000000-1111-2222-3333-444444444444']) {
      const hash = hashSessionId(id);
      expect(hash).toBeGreaterThanOrEqual(0);
      expect(Number.isInteger(hash)).toBe(true);
    }
  });
});

describe('selectDiscoveryItem', () => {
  const tutorial = makeTutorial();
  const highlight = makeHighlight();

  it('returns tutorial when only tutorial candidate is available (regardless of preference)', () => {
    // Probe several sessionIds to make sure changelog preference never breaks
    // the fallback path.
    for (const sessionId of ['a', 'b', 'c', 'session-1', 'session-2', 'session-3']) {
      for (const surface of ['empty-state', 'nudge'] as DiscoverySurface[]) {
        const result = selectDiscoveryItem({
          sessionId,
          surface,
          tutorialCandidate: tutorial,
          changelogCandidate: null,
        });
        expect(result).toEqual({ type: 'tutorial', video: tutorial });
      }
    }
  });

  it('returns changelog when only changelog candidate is available (regardless of preference)', () => {
    for (const sessionId of ['a', 'b', 'c', 'session-1', 'session-2', 'session-3']) {
      for (const surface of ['empty-state', 'nudge'] as DiscoverySurface[]) {
        const result = selectDiscoveryItem({
          sessionId,
          surface,
          tutorialCandidate: null,
          changelogCandidate: highlight,
        });
        expect(result).toEqual({ type: 'changelog', highlight });
      }
    }
  });

  it('returns null when both candidates are null', () => {
    for (const sessionId of ['a', 'b', 'c']) {
      for (const surface of ['empty-state', 'nudge'] as DiscoverySurface[]) {
        const result = selectDiscoveryItem({
          sessionId,
          surface,
          tutorialCandidate: null,
          changelogCandidate: null,
        });
        expect(result).toBeNull();
      }
    }
  });

  it('produces the same result for the same sessionId + surface + candidates (determinism)', () => {
    const sessionId = 'deterministic-session';
    const a = selectDiscoveryItem({
      sessionId,
      surface: 'empty-state',
      tutorialCandidate: tutorial,
      changelogCandidate: highlight,
    });
    const b = selectDiscoveryItem({
      sessionId,
      surface: 'empty-state',
      tutorialCandidate: tutorial,
      changelogCandidate: highlight,
    });
    expect(a).toEqual(b);
  });

  it('picks opposite types for empty-state vs nudge when both candidates are available (same session)', () => {
    // For any given sessionId, the surface offset inverts preference: the two
    // surfaces must never agree on the same type when both candidates exist.
    for (const sessionId of ['s1', 's2', 's3', 's4', 's5', 's6']) {
      const { empty, nudge } = probeSurfaces(sessionId, tutorial, highlight);
      expect(empty).not.toBe(null);
      expect(nudge).not.toBe(null);
      expect(empty).not.toBe(nudge);
    }
  });

  it('produces different preferences across different sessionIds (at least one flips)', () => {
    // Across a pool of 10 sessionIds, at least one must produce a different
    // empty-state preference than the first — otherwise the alternation is
    // degenerate.
    const sessionIds = Array.from({ length: 10 }, (_, i) => `session-${i}`);
    const preferences = sessionIds.map((id) => {
      const item = selectDiscoveryItem({
        sessionId: id,
        surface: 'empty-state',
        tutorialCandidate: tutorial,
        changelogCandidate: highlight,
      });
      return item?.type ?? null;
    });
    const distinct = new Set(preferences);
    expect(distinct.size).toBeGreaterThan(1);
  });

  it('returns a tutorial for the even-hash + empty-state case (both candidates present)', () => {
    // Find a sessionId whose hash is even — guaranteed to prefer tutorial on
    // empty-state (hash + 0 is even).
    const evenId = ['s0', 's1', 's2', 's3', 's4', 's5'].find(
      (id) => hashSessionId(id) % 2 === 0,
    );
    expect(evenId).toBeDefined();
    const result = selectDiscoveryItem({
      sessionId: evenId as string,
      surface: 'empty-state',
      tutorialCandidate: tutorial,
      changelogCandidate: highlight,
    });
    expect(result).toEqual({ type: 'tutorial', video: tutorial });
  });

  it('returns a changelog for the odd-hash + empty-state case (both candidates present)', () => {
    // Find a sessionId whose hash is odd — prefers changelog on empty-state.
    const oddId = ['s0', 's1', 's2', 's3', 's4', 's5'].find(
      (id) => hashSessionId(id) % 2 === 1,
    );
    expect(oddId).toBeDefined();
    const result = selectDiscoveryItem({
      sessionId: oddId as string,
      surface: 'empty-state',
      tutorialCandidate: tutorial,
      changelogCandidate: highlight,
    });
    expect(result).toEqual({ type: 'changelog', highlight });
  });

  it('falls back to changelog when preferred tutorial candidate is null', () => {
    // Pick an empty-state + even-hash pairing (would prefer tutorial) but
    // supply no tutorial — must fall back to the changelog.
    const evenId = ['s0', 's1', 's2', 's3', 's4', 's5'].find(
      (id) => hashSessionId(id) % 2 === 0,
    );
    expect(evenId).toBeDefined();
    const result = selectDiscoveryItem({
      sessionId: evenId as string,
      surface: 'empty-state',
      tutorialCandidate: null,
      changelogCandidate: highlight,
    });
    expect(result).toEqual({ type: 'changelog', highlight });
  });

  it('falls back to tutorial when preferred changelog candidate is null', () => {
    // Pick an empty-state + odd-hash pairing (would prefer changelog) but
    // supply no changelog — must fall back to the tutorial.
    const oddId = ['s0', 's1', 's2', 's3', 's4', 's5'].find(
      (id) => hashSessionId(id) % 2 === 1,
    );
    expect(oddId).toBeDefined();
    const result = selectDiscoveryItem({
      sessionId: oddId as string,
      surface: 'empty-state',
      tutorialCandidate: tutorial,
      changelogCandidate: null,
    });
    expect(result).toEqual({ type: 'tutorial', video: tutorial });
  });

  it('handles an empty sessionId deterministically without throwing', () => {
    // Empty sessionId is unusual but shouldn't break the hash/selection.
    const result = selectDiscoveryItem({
      sessionId: '',
      surface: 'empty-state',
      tutorialCandidate: tutorial,
      changelogCandidate: highlight,
    });
    expect(result).not.toBeNull();
    expect(result?.type === 'tutorial' || result?.type === 'changelog').toBe(true);
  });
});
