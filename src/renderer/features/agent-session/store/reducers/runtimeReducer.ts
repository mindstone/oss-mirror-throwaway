import type { AgentEvent } from '@shared/types';
import {
  applyEventToRuntime as applyEvent,
  createRuntimeState,
  cloneRuntimeState,
  primeRuntimeForTurn,
  isTurnStale,
  type SessionRuntimeState
} from '@core/services/agentTurnReducer/runtime';

export type { SessionRuntimeState };

export const createInitialRuntimeState = (): SessionRuntimeState => createRuntimeState();

export const processEvent = (
  state: SessionRuntimeState,
  turnId: string,
  event: AgentEvent
): SessionRuntimeState => applyEvent(state, turnId, event);

export const primeTurn = (turnId: string, startedAt: number): SessionRuntimeState =>
  primeRuntimeForTurn(turnId, startedAt);

export const resetRuntime = (): SessionRuntimeState => createRuntimeState();

export { cloneRuntimeState, createRuntimeState, isTurnStale };
