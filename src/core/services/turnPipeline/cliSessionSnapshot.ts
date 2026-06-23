import type { AgentSession, AgentTurnMessage } from '@shared/types';
import { deduplicateMessages } from '@core/services/sessionMergeUtils';
import { getMaxSeqFromSession } from '@core/services/sessionSeqIndex';
import type { agentTurnRegistry } from '@core/services/agentTurnRegistry';

export function buildCliSessionSnapshot(deps: {
  turnId: string;
  sessionId: string;
  existingSession: AgentSession | undefined;
  registry: typeof agentTurnRegistry;
  now: () => number;
}): AgentSession {
  const accumulator = deps.registry.getContextAccumulator(deps.turnId);
  if (!accumulator) {
    throw new Error(`Cannot persist CLI session ${deps.sessionId}: missing accumulator for turn ${deps.turnId}`);
  }

  const now = deps.now();
  const accumulatedMessages = ensurePromptMessage({
    turnId: deps.turnId,
    messages: accumulator.messages,
    prompt: deps.registry.getTurnPrompt(deps.turnId),
    timestamp: findTurnStartTimestamp(accumulator.eventsByTurn[deps.turnId]) ?? now,
  });
  const messages = deduplicateMessages(
    deps.existingSession?.messages ?? [],
    accumulatedMessages,
    'secondary-wins',
  );
  const eventsByTurn = {
    ...(deps.existingSession?.eventsByTurn ?? {}),
    ...accumulator.eventsByTurn,
  };
  const createdAt = deps.existingSession?.createdAt ?? messages[0]?.createdAt ?? now;
  const latestMessageAt = messages[messages.length - 1]?.createdAt ?? createdAt;
  const latestEventAt = Math.max(
    0,
    ...Object.values(eventsByTurn)
      .flat()
      .map((event) => event.timestamp)
      .filter((timestamp): timestamp is number => Number.isFinite(timestamp)),
  );
  const priorUpdatedAt = deps.existingSession?.updatedAt ?? createdAt;
  const updatedAt = Math.max(priorUpdatedAt + 1, latestMessageAt, latestEventAt, now);
  const activeTurnId = accumulator.activeTurnId ?? null;
  const lastError = accumulator.lastError ?? deps.existingSession?.lastError ?? null;
  const resolvedAt =
    findTerminalTimestamp(accumulator.eventsByTurn[deps.turnId])
    ?? deps.existingSession?.resolvedAt
    ?? null;

  const snapshot: AgentSession = {
    ...(deps.existingSession ?? {}),
    id: deps.sessionId,
    title: deps.existingSession?.title ?? createCliSessionTitle(messages),
    createdAt,
    updatedAt,
    messages,
    eventsByTurn,
    // eslint-disable-next-line rebel-liveness-scalars/no-raw-turn-liveness-scalars -- CLI snapshot is immediately persisted via upsertSessionsSyncWithReload, which re-derives/stamps canonical liveness scalars.
    activeTurnId,
    // eslint-disable-next-line rebel-liveness-scalars/no-raw-turn-liveness-scalars -- Busy scalar mirrors accumulator state in-memory; IncrementalSessionStore stamp is the persistence authority.
    isBusy: accumulator.isBusy,
    lastError,
    resolvedAt,
    origin: deps.existingSession?.origin ?? 'manual',
  };

  const maxSeq = getMaxSeqFromSession(snapshot);
  return maxSeq > 0 ? { ...snapshot, maxSeq } : snapshot;
}

function ensurePromptMessage(args: {
  turnId: string;
  messages: AgentTurnMessage[];
  prompt: string | undefined;
  timestamp: number;
}): AgentTurnMessage[] {
  if (!args.prompt || args.messages.some((message) => message.turnId === args.turnId && message.role === 'user')) {
    return args.messages;
  }
  return [
    {
      id: `cli-user-${args.turnId}`,
      turnId: args.turnId,
      role: 'user',
      text: args.prompt,
      createdAt: args.timestamp,
      messageOrigin: 'user-typed',
    },
    ...args.messages,
  ];
}

function createCliSessionTitle(messages: AgentTurnMessage[]): string {
  const firstUserMessage = messages.find((message) => message.role === 'user' && message.text.trim().length > 0);
  if (!firstUserMessage) return 'CLI Session';
  const title = firstUserMessage.text.trim().replace(/\s+/g, ' ');
  return title.length > 60 ? `${title.slice(0, 57)}…` : title;
}

function findTurnStartTimestamp(events: AgentSession['eventsByTurn'][string] | undefined): number | null {
  const started = events?.find((event) => event.type === 'turn_started');
  return started?.timestamp ?? null;
}

function findTerminalTimestamp(events: AgentSession['eventsByTurn'][string] | undefined): number | null {
  const terminal = [...(events ?? [])].reverse().find((event) => (
    event.type === 'result' || event.type === 'error'
  ));
  return terminal?.timestamp ?? null;
}
