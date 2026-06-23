/**
 * Shadow-busy reflip dev-assertion probes for the renderer session store.
 *
 * Extracted from `sessionStore.ts` (behavior-preserving Stage 8). When a
 * `false -> true` isBusy transition is observed for a turn that already carries
 * terminal evidence (a result/error event, or membership in the terminated-turn
 * set), these probes record a once-per-key breadcrumb + dev console warning so
 * the suspicious reflip is visible during development. They are pure observers:
 * the store's subscribe hook calls the two `maybeAssertShadowBusyReflipFor*`
 * entry points with (prevState, nextState); nothing here mutates store state.
 *
 * `sessionStore.ts` imports the two assert entry points for its dev-assertion
 * subscriber and re-exports the test-only reset so the canonical
 * .../store/sessionStore import path keeps resolving.
 *
 * @see ./sessionStore.ts — the store implementation that drives these probes
 * @see docs/tutorials/260430_isbusy_dual_id_state_machine_and_c_lite_fix.html
 * @see docs/plans/260622_refactor-session-store/PLAN.md — extraction plan
 */
import type { AgentEvent } from "@shared/types";
import { hashSessionIdForBreadcrumb } from "@shared/utils/hashSessionIdForBreadcrumb";
import { recordRendererBreadcrumb } from "@renderer/src/sentry";
import { getCurrentSessionEventsForTurn } from "./currentSessionEvents";
import type {
  ShadowBusyReflipProbe,
  SessionStoreState,
} from "./sessionStoreTypes";

const shadowBusyReflipWarningKeys = new Set<string>();

const isTerminalTurnEvent = (event: AgentEvent): boolean =>
  event.type === 'result' || event.type === 'error';

const maybeWarnShadowBusyReflip = (probe: ShadowBusyReflipProbe): void => {
  const hasTerminalEvent = probe.eventsForTurn.some(isTerminalTurnEvent);
  const isInTerminatedSet = probe.terminatedTurnIds?.has(probe.turnId) ?? false;
  if (!hasTerminalEvent && !isInTerminatedSet) {
    return;
  }

  const warningKey = [
    probe.scope,
    probe.sessionId,
    probe.turnId,
    hasTerminalEvent ? 'terminal' : 'non-terminal',
    isInTerminatedSet ? 'terminated' : 'not-terminated',
  ].join(':');
  if (shadowBusyReflipWarningKeys.has(warningKey)) {
    return;
  }
  shadowBusyReflipWarningKeys.add(warningKey);

  const data = {
    scope: probe.scope,
    sessionIdHash: hashSessionIdForBreadcrumb(probe.sessionId),
    turnIdHash: hashSessionIdForBreadcrumb(probe.turnId),
    hasTerminalEvent,
    isInTerminatedSet,
  };

  recordRendererBreadcrumb({
    category: 'shadow-busy-reflip-detected',
    message:
      'Detected suspicious false->true isBusy transition for turn with terminal evidence.',
    level: 'warning',
    data,
  });
  console.warn(
    '[sessionStore] Dev assertion: suspicious false->true isBusy transition for terminal turn',
    data,
  );
};

export const maybeAssertShadowBusyReflipForCurrentSession = (
  prevState: SessionStoreState,
  nextState: SessionStoreState,
): void => {
  if (prevState.isBusy || !nextState.isBusy) {
    return;
  }
  const turnId = nextState.activeTurnId;
  if (!turnId) {
    return;
  }

  maybeWarnShadowBusyReflip({
    scope: 'current',
    sessionId: nextState.currentSessionId,
    turnId,
    eventsForTurn: getCurrentSessionEventsForTurn(turnId),
    terminatedTurnIds: nextState.terminatedTurnIds,
  });
};

export const maybeAssertShadowBusyReflipForLoadedSessions = (
  prevState: SessionStoreState,
  nextState: SessionStoreState,
): void => {
  for (const [sessionId, nextSession] of nextState.loadedSessions.entries()) {
    const prevSession = prevState.loadedSessions.get(sessionId);
    const prevWasBusy = prevSession?.isBusy ?? false;
    if (prevWasBusy || !nextSession.isBusy) {
      continue;
    }
    const turnId = nextSession.activeTurnId;
    if (!turnId) {
      continue;
    }

    maybeWarnShadowBusyReflip({
      scope: 'loaded',
      sessionId,
      turnId,
      eventsForTurn: nextSession.eventsByTurn?.[turnId] ?? [],
      terminatedTurnIds: nextSession.terminatedTurnIds,
    });
  }
};

/** Test-only: clear once-per-key dedup for shadow busy reflip warnings. */
// eslint-disable-next-line @typescript-eslint/naming-convention -- double-underscore convention denotes test-only escape hatch
export const __resetShadowBusyReflipWarningsForTest = (): void => {
  shadowBusyReflipWarningKeys.clear();
};
