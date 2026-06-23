import { useSessionStore } from '@renderer/features/agent-session/store/sessionStore';
import type { TurnAuthLabel } from '@shared/agentEvents';
import {
  useRouteLabelCacheStore,
  type RouteLabelCacheEntry,
} from '../store/routeLabelCacheStore';

export function useLastResolvedRouteLabel(): TurnAuthLabel | null {
  const sessionId = useSessionStore((state) => state.currentSessionId);
  return useRouteLabelCacheStore((state) => {
    const perSession = state.bySession[sessionId];
    return perSession?.turnAuthLabel ?? state.lastObserved?.turnAuthLabel ?? null;
  });
}

export interface RouteStatusViewState {
  entry: RouteLabelCacheEntry | null;
  inflight: boolean;
}

export function useRouteStatusViewState(): RouteStatusViewState {
  const sessionId = useSessionStore((state) => state.currentSessionId);
  const entry = useRouteLabelCacheStore((state) => {
    return state.bySession[sessionId] ?? state.lastObserved ?? null;
  });
  const inflight = useRouteLabelCacheStore((state) => Boolean(state.inflight[sessionId]));
  return { entry, inflight };
}
