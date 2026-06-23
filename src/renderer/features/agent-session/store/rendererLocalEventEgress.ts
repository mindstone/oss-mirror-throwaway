import type { AgentEvent, AgentSession } from '@shared/types';
import type { AgentSessionWithRuntime } from '../types';

const RENDERER_OPTIMISTIC_TURN_STARTED_EVENT_TAG = Symbol(
  'rendererOptimisticTurnStartedEvent',
);

const RENDERER_LOCAL_TERMINAL_EVENT_TAG = Symbol(
  'rendererLocalTerminalEvent',
);

type RendererOptimisticTurnStartedEvent = AgentEvent & {
  readonly [RENDERER_OPTIMISTIC_TURN_STARTED_EVENT_TAG]: true;
};

type RendererLocalTerminalEvent = AgentEvent & {
  readonly [RENDERER_LOCAL_TERMINAL_EVENT_TAG]: true;
};

declare const EGRESS_EVENTS_BY_TURN_TAG: unique symbol;
declare const EGRESS_SESSION_TAG: unique symbol;

export type EgressEventsByTurn = Record<string, AgentEvent[]> & {
  readonly [EGRESS_EVENTS_BY_TURN_TAG]: true;
};

export type EgressSession = AgentSession & {
  readonly [EGRESS_SESSION_TAG]: true;
};

type SessionWithEphemeralFields = (AgentSession | AgentSessionWithRuntime) & {
  runtime?: AgentSessionWithRuntime['runtime'];
  terminatedTurnIds?: Set<string>;
  focusedTurnId?: string | null;
  systemPromptPrefix?: string | null;
};

/**
 * Renderer-local synthetic turn-start marker.
 * Non-enumerable symbol branding guarantees JSON and persistence egress drop it.
 */
export const createRendererOptimisticTurnStartedEvent = (
  timestamp: number = Date.now(),
): RendererOptimisticTurnStartedEvent => {
  const event: AgentEvent = {
    type: 'turn_started',
    timestamp,
  };
  Object.defineProperty(event, RENDERER_OPTIMISTIC_TURN_STARTED_EVENT_TAG, {
    value: true,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return event as RendererOptimisticTurnStartedEvent;
};

/**
 * Renderer-local terminal marker used by stop/recovery fallbacks.
 * This is intentionally synthetic and must never leave renderer memory.
 */
export const createRendererLocalTerminalEvent = (
  timestamp: number = Date.now(),
  errorMessage: string = 'Turn interrupted locally',
): RendererLocalTerminalEvent => {
  const event: AgentEvent = {
    type: 'result',
    text: errorMessage,
    timestamp,
  };
  Object.defineProperty(event, RENDERER_LOCAL_TERMINAL_EVENT_TAG, {
    value: true,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return event as RendererLocalTerminalEvent;
};

export const isRendererOptimisticTurnStartedEvent = (
  event: AgentEvent,
): event is RendererOptimisticTurnStartedEvent => (
  event.type === 'turn_started'
  && Boolean(
    (event as RendererOptimisticTurnStartedEvent)[
      RENDERER_OPTIMISTIC_TURN_STARTED_EVENT_TAG
    ],
  )
);

export const isRendererLocalTerminalEvent = (
  event: AgentEvent,
): event is RendererLocalTerminalEvent => (
  event.type === 'result'
  && Boolean(
    (event as RendererLocalTerminalEvent)[
      RENDERER_LOCAL_TERMINAL_EVENT_TAG
    ],
  )
);

export const isRendererOnlySyntheticEvent = (event: AgentEvent): boolean =>
  isRendererOptimisticTurnStartedEvent(event)
  || isRendererLocalTerminalEvent(event);

export const stripRendererOnlyEventsForEgress = (
  turnEvents: readonly AgentEvent[],
): AgentEvent[] => turnEvents.filter(
  (event) => !isRendererOnlySyntheticEvent(event),
);

export const stripRendererOnlyEventsByTurnForEgress = (
  eventsByTurn: Record<string, AgentEvent[]>,
): EgressEventsByTurn => {
  const sanitized: Record<string, AgentEvent[]> = {};
  for (const [turnId, turnEvents] of Object.entries(eventsByTurn)) {
    sanitized[turnId] = stripRendererOnlyEventsForEgress(turnEvents);
  }
  return sanitized as EgressEventsByTurn;
};

/**
 * Canonical renderer->disk/cloud egress stripper.
 * All persistence call sites should flow through this one function.
 */
export const stripSessionForEgress = (
  session: SessionWithEphemeralFields,
): EgressSession => {
  const {
    runtime: _runtime,
    terminatedTurnIds: _terminatedTurnIds,
    focusedTurnId: _focusedTurnId,
    systemPromptPrefix: _systemPromptPrefix,
    ...rest
  } = session;
  return {
    ...rest,
    eventsByTurn: stripRendererOnlyEventsByTurnForEgress(rest.eventsByTurn ?? {}),
  } as unknown as EgressSession;
};
