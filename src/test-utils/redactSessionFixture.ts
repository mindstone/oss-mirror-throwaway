import type { AgentEvent, AgentSession, AgentTurnMessage } from '@shared/types';

const REDACTED_TEXT = '[REDACTED]';
const SAFE_EVENT_KEYS = new Set([
  'type',
  'timestamp',
  'seq',
  'stage',
  'turnEndReason',
  'isTransient',
  'errorSource',
  'errorKind',
]);

function redactUnknownValue<T>(value: T): T {
  if (typeof value === 'string') return REDACTED_TEXT;
  if (Array.isArray(value)) {
    return value.map((entry) => redactUnknownValue(entry)) as T;
  }
  if (!value || typeof value !== 'object') return value;

  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (SAFE_EVENT_KEYS.has(key)) {
      out[key] = entry;
      continue;
    }
    out[key] = redactUnknownValue(entry);
  }
  return out as T;
}

function redactEvent(event: AgentEvent): AgentEvent {
  // Keep event type/timestamp/seq plus structural fields while stripping all
  // human/user/tool payload strings and nested content.
  return redactUnknownValue(event);
}

function redactMessage(message: AgentTurnMessage): AgentTurnMessage {
  return {
    ...message,
    text: REDACTED_TEXT,
    displayText: undefined,
    attachments: undefined,
    attachmentTexts: undefined,
  };
}

/**
 * Redact a persisted AgentSession fixture for safe test/diagnostic sharing.
 *
 * Preserves:
 * - event ordering per turn
 * - turn partitioning (`eventsByTurn` keys)
 * - event identity anchors (`seq` and `timestamp`)
 * - structural event/message metadata
 *
 * Redacts:
 * - titles, message text, tool payload strings, error/raw strings, draft text
 * - any nested string values not explicitly allowlisted
 */
export function redactSessionFixture(session: AgentSession): AgentSession {
  const redactedEventsByTurn: Record<string, AgentEvent[]> = {};
  for (const [turnId, events] of Object.entries(session.eventsByTurn)) {
    redactedEventsByTurn[turnId] = events.map(redactEvent);
  }

  return {
    ...session,
    title: REDACTED_TEXT,
    messages: session.messages.map(redactMessage),
    eventsByTurn: redactedEventsByTurn,
    draft: session.draft
      ? { ...session.draft, text: REDACTED_TEXT }
      : session.draft,
    annotations: session.annotations?.map((annotation) => ({
      ...annotation,
      text: REDACTED_TEXT,
      comment: REDACTED_TEXT,
    })),
  };
}
