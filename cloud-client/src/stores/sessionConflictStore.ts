import { create } from 'zustand';

export type SessionConflictType = 'stale-metadata' | 'concurrent-edit';

export interface SessionConflictEntry {
  sessionId: string;
  conflictType: SessionConflictType;
  fields: string[];
  detectedAt: number;
  dismissedAt: number | null;
}

interface SessionConflictStoreState {
  conflictsBySessionId: Record<string, SessionConflictEntry>;
  markSessionConflict: (payload: {
    sessionId: string;
    conflictType: SessionConflictType;
    fields?: string[];
    detectedAt?: number;
  }) => void;
  dismissSessionConflict: (sessionId: string) => void;
  clearSessionConflict: (sessionId: string) => void;
  resetSessionConflicts: () => void;
}

function initialState(): Pick<SessionConflictStoreState, 'conflictsBySessionId'> {
  return { conflictsBySessionId: {} };
}

export const useSessionConflictStore = create<SessionConflictStoreState>()((set) => ({
  ...initialState(),

  markSessionConflict: ({ sessionId, conflictType, fields, detectedAt }) => {
    if (!sessionId) return;
    const incomingDetectedAt = typeof detectedAt === 'number' ? detectedAt : Date.now();
    const nextFields = Array.isArray(fields)
      ? Array.from(new Set(fields.filter((field): field is string => typeof field === 'string' && field.length > 0)))
      : [];
    set((state) => {
      const existing = state.conflictsBySessionId[sessionId];
      const nextDetectedAt = existing ? Math.max(existing.detectedAt, incomingDetectedAt) : incomingDetectedAt;
      const shouldReopen = !existing
        || incomingDetectedAt > existing.detectedAt
        || existing.conflictType !== conflictType;

      return {
        conflictsBySessionId: {
          ...state.conflictsBySessionId,
          [sessionId]: {
            sessionId,
            conflictType,
            fields: nextFields.length > 0 ? nextFields : (existing?.fields ?? []),
            detectedAt: nextDetectedAt,
            dismissedAt: shouldReopen ? null : (existing?.dismissedAt ?? null),
          },
        },
      };
    });
  },

  dismissSessionConflict: (sessionId) => {
    if (!sessionId) return;
    set((state) => {
      const existing = state.conflictsBySessionId[sessionId];
      if (!existing || existing.dismissedAt !== null) return state;
      return {
        conflictsBySessionId: {
          ...state.conflictsBySessionId,
          [sessionId]: {
            ...existing,
            dismissedAt: Date.now(),
          },
        },
      };
    });
  },

  clearSessionConflict: (sessionId) => {
    if (!sessionId) return;
    set((state) => {
      if (!state.conflictsBySessionId[sessionId]) return state;
      const next = { ...state.conflictsBySessionId };
      delete next[sessionId];
      return { conflictsBySessionId: next };
    });
  },

  resetSessionConflicts: () => set(initialState()),
}));
