import { beforeEach, describe, expect, it } from 'vitest';
import type { TurnAuthLabel } from '@shared/agentEvents';
import { useRouteLabelCacheStore, type RouteLabelCacheEntry } from '../routeLabelCacheStore';

function makeEntry(
  sessionId: string,
  turnAuthLabel: TurnAuthLabel,
  observedAt: number,
): RouteLabelCacheEntry {
  return { sessionId, turnAuthLabel, observedAt };
}

describe('useRouteLabelCacheStore', () => {
  beforeEach(() => {
    useRouteLabelCacheStore.getState().clearAll();
  });

  it('stores route labels per session and tracks lastObserved', () => {
    const entry = makeEntry('session-1', 'openrouter', 101);
    useRouteLabelCacheStore.getState().set(entry);

    const next = useRouteLabelCacheStore.getState();
    expect(next.bySession['session-1']).toEqual(entry);
    expect(next.lastObserved).toEqual(entry);
  });

  it('clearForSession removes the session entry and recomputes fallback lastObserved', () => {
    const first = makeEntry('session-a', 'api-key', 200);
    const second = makeEntry('session-b', 'codex-subscription', 300);
    useRouteLabelCacheStore.getState().set(first);
    useRouteLabelCacheStore.getState().set(second);

    useRouteLabelCacheStore.getState().clearForSession('session-b');
    const next = useRouteLabelCacheStore.getState();

    expect(next.bySession['session-b']).toBeUndefined();
    expect(next.bySession['session-a']).toEqual(first);
    expect(next.lastObserved).toEqual(first);
  });

  it('clearAll wipes the in-memory cache', () => {
    useRouteLabelCacheStore.getState().set(makeEntry('session-1', 'profile-direct', 10));
    useRouteLabelCacheStore.getState().set(makeEntry('session-2', 'local', 11));

    useRouteLabelCacheStore.getState().clearAll();
    const next = useRouteLabelCacheStore.getState();

    expect(next.bySession).toEqual({});
    expect(next.lastObserved).toBeNull();
    expect(next.inflight).toEqual({});
  });

  it('tracks per-session inflight state independently of cached entries', () => {
    useRouteLabelCacheStore.getState().setInflight('session-1');
    expect(useRouteLabelCacheStore.getState().inflight['session-1']).toBe(true);

    useRouteLabelCacheStore.getState().clearInflight('session-1');
    expect(useRouteLabelCacheStore.getState().inflight['session-1']).toBeUndefined();
  });

  it('clears the inflight flag for a session as soon as a route entry is set', () => {
    useRouteLabelCacheStore.getState().setInflight('session-1');
    useRouteLabelCacheStore.getState().set(makeEntry('session-1', 'api-key', 999));

    expect(useRouteLabelCacheStore.getState().inflight['session-1']).toBeUndefined();
    expect(useRouteLabelCacheStore.getState().bySession['session-1']?.turnAuthLabel).toBe('api-key');
  });

  it('persists profileName on entries when supplied', () => {
    useRouteLabelCacheStore.getState().set({
      sessionId: 'session-p',
      turnAuthLabel: 'profile-direct',
      observedAt: 42,
      profileName: 'Mistral Large',
    });

    expect(useRouteLabelCacheStore.getState().bySession['session-p']?.profileName).toBe(
      'Mistral Large',
    );
  });
});
