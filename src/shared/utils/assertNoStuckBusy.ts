import type { AgentEvent, AgentSession } from '@shared/types';

export type PersistedSessionBusyShape = Pick<
  AgentSession,
  'isBusy' | 'activeTurnId' | 'eventsByTurn'
>;

const isTerminalEvent = (event: AgentEvent): boolean =>
  event.type === 'result' || event.type === 'error';

/**
 * A persisted `activeTurnId` is only "set" if it is a non-empty string.
 * Persisted JSON can carry `null`, `undefined` (absent key), or an empty
 * string; for the busy invariant all of these mean "no active turn" and so
 * violate `isBusy=true`.
 */
const hasValidActiveTurnId = (
  activeTurnId: PersistedSessionBusyShape['activeTurnId'],
): activeTurnId is string =>
  typeof activeTurnId === 'string' && activeTurnId.length > 0;

export const violatesNoStuckBusy = (
  persisted: PersistedSessionBusyShape,
): boolean => {
  if (!persisted.isBusy) {
    return false;
  }

  if (!hasValidActiveTurnId(persisted.activeTurnId)) {
    return true;
  }

  const activeTurnEvents = persisted.eventsByTurn[persisted.activeTurnId] ?? [];
  return activeTurnEvents.some(isTerminalEvent);
};

/**
 * Stage 1 / P1: persisted busy-shape invariant from postmortem 260502.
 *
 * If a persisted session reports `isBusy === true`, it must also have:
 * 1) a non-null `activeTurnId`, and
 * 2) no terminal (`result`/`error`) event for that active turn.
 */
export const assertNoStuckBusy = (persisted: PersistedSessionBusyShape): void => {
  if (!violatesNoStuckBusy(persisted)) {
    return;
  }

  if (!hasValidActiveTurnId(persisted.activeTurnId)) {
    throw new Error(
      'Persisted busy invariant violated: isBusy=true requires a non-empty activeTurnId.',
    );
  }

  throw new Error(
    `Persisted busy invariant violated: active turn "${persisted.activeTurnId}" already has terminal event.`,
  );
};
