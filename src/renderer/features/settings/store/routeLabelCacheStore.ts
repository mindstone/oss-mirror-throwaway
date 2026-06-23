import { create } from 'zustand';
import type { TurnAuthLabel } from '@shared/agentEvents';

export type RouteStatusLabel = TurnAuthLabel;

export interface RouteLabelCacheEntry {
  sessionId: string;
  turnAuthLabel: TurnAuthLabel;
  observedAt: number;
  profileName?: string;
}

interface RouteLabelCacheState {
  bySession: Record<string, RouteLabelCacheEntry>;
  lastObserved: RouteLabelCacheEntry | null;
  inflight: Record<string, boolean>;
  set: (entry: RouteLabelCacheEntry) => void;
  setInflight: (sessionId: string) => void;
  clearInflight: (sessionId: string) => void;
  clearForSession: (sessionId: string) => void;
  clearAll: () => void;
}

function findLatestEntry(
  bySession: Record<string, RouteLabelCacheEntry>,
): RouteLabelCacheEntry | null {
  const entries = Object.values(bySession);
  if (entries.length === 0) return null;
  let latest = entries[0];
  for (const entry of entries) {
    if (entry.observedAt > latest.observedAt) {
      latest = entry;
    }
  }
  return latest;
}

export const useRouteLabelCacheStore = create<RouteLabelCacheState>((set) => ({
  // In-memory only by design; app restarts naturally clear this cache.
  bySession: {},
  lastObserved: null,
  inflight: {},
  set: (entry) =>
    set((state) => {
      const { [entry.sessionId]: _wasInflight, ...remainingInflight } = state.inflight;
      return {
        bySession: {
          ...state.bySession,
          [entry.sessionId]: entry,
        },
        lastObserved: entry,
        inflight: remainingInflight,
      };
    }),
  setInflight: (sessionId) =>
    set((state) => ({
      inflight: { ...state.inflight, [sessionId]: true },
    })),
  clearInflight: (sessionId) =>
    set((state) => {
      if (!(sessionId in state.inflight)) {
        return state;
      }
      const { [sessionId]: _removed, ...remaining } = state.inflight;
      return { inflight: remaining };
    }),
  clearForSession: (sessionId) =>
    set((state) => {
      const hadEntry = sessionId in state.bySession;
      const hadInflight = sessionId in state.inflight;
      if (!hadEntry && !hadInflight) {
        return state;
      }
      const { [sessionId]: _removed, ...remaining } = state.bySession;
      const { [sessionId]: _removedInflight, ...remainingInflight } = state.inflight;
      const nextLastObserved =
        state.lastObserved?.sessionId === sessionId
          ? findLatestEntry(remaining)
          : state.lastObserved;
      return {
        bySession: remaining,
        lastObserved: nextLastObserved,
        inflight: remainingInflight,
      };
    }),
  clearAll: () =>
    set({
      bySession: {},
      lastObserved: null,
      inflight: {},
    }),
}));
