/**
 * Parser for structured `suggest_connector_setup` signals from agent events.
 *
 * The agent signals a missing connector via two approved mechanisms:
 *   1. **Tool event** — the agent calls the `suggest_connector_setup` tool, producing
 *      a tool event with structured JSON in its `detail` field.
 *   2. **Structured response** — the agent emits a `result` event whose `text` field
 *      contains JSON with `action: 'suggest_connector_setup'` and a `connectorName`.
 *
 * This module extracts those signals so the renderer can render MCPSetupOfferCard inline.
 *
 * IMPORTANT: Only the two structured mechanisms above trigger card rendering —
 * plain-text matching is explicitly excluded to prevent false positives
 * (see forward plan P5.5, VAL-OFFER-005).
 *
 * @see docs/plans/260410_oss_mcp_integration_forward_plan.md (P5.5)
 */

import type { AgentEvent } from '@shared/types';
import { safeParseDetail } from '@shared/utils/safeParseDetail';

/** The exact tool name that signals a missing connector suggestion. */
export const SUGGEST_CONNECTOR_SETUP_TOOL = 'suggest_connector_setup' as const;

/** The action value in structured response payloads that signals a connector setup suggestion. */
export const SUGGEST_CONNECTOR_SETUP_ACTION = 'suggest_connector_setup' as const;

export type ConnectorSetupIntent = 'build' | 'extend';

/** Parsed connector setup suggestion extracted from a tool event. */
export interface ConnectorSetupSuggestion {
  /** Name of the connector the agent suggests setting up. */
  connectorName: string;
  /** Whether the flow should build a new connector or extend an existing one. */
  intent: ConnectorSetupIntent;
  /** The turn ID where the suggestion was made. */
  turnId: string;
  /** Optional connector identifier for extend flows when known. */
  connectorId?: string;
  /** Optional reason the agent provided for suggesting the connector. */
  reason?: string;
}

/**
 * Attempts to parse a connector setup suggestion from a single agent event.
 *
 * Two structured trigger mechanisms are supported (VAL-OFFER-005):
 *
 *   1. **Tool event** — a completed `suggest_connector_setup` tool call
 *      (`type: 'tool'`, `toolName: 'suggest_connector_setup'`, `stage: 'end'`)
 *      with valid JSON in `detail` containing a `connectorName`.
 *
 *   2. **Structured response** — a `result` event whose `text` contains valid JSON
 *      with `action: 'suggest_connector_setup'` and a `connectorName`.
 *
 * Returns the parsed suggestion or null if the event doesn't match either format.
 * Plain-text events never trigger a suggestion.
 */
export function parseConnectorSetupSignal(
  event: AgentEvent,
  turnId: string,
): ConnectorSetupSuggestion | null {
  if (event.type === 'tool') {
    return parseToolEventSignal(event, turnId);
  }
  if (event.type === 'result') {
    return parseStructuredResponseSignal(event, turnId);
  }
  return null;
}

/**
 * Parses a connector setup suggestion from a `suggest_connector_setup` tool event.
 * Only `stage: 'end'` events are considered (the tool result, not the invocation).
 */
function parseToolEventSignal(
  event: Extract<AgentEvent, { type: 'tool' }>,
  turnId: string,
): ConnectorSetupSuggestion | null {
  if (event.toolName !== SUGGEST_CONNECTOR_SETUP_TOOL) return null;
  if (event.stage !== 'end') return null;
  if (event.parentToolUseId) return null;

  return extractSuggestionFromJson(event.detail, turnId);
}

/**
 * Parses a connector setup suggestion from a structured `result` event.
 * The `text` field must contain JSON with `action: 'suggest_connector_setup'`
 * and a valid `connectorName`.
 */
function parseStructuredResponseSignal(
  event: Extract<AgentEvent, { type: 'result' }>,
  turnId: string,
): ConnectorSetupSuggestion | null {
  const { text } = event;
  if (typeof text !== 'string' || text.trim() === '') return null;

  // BOUNDED via safeParseDetail: malformed OR over-budget text is ignored
  // (plain-text result events are intentionally ignored).
  const result = safeParseDetail(text);
  if (!result.ok) return null;
  const parsed = result.value;
  if (typeof parsed !== 'object' || parsed === null) return null;

  const record = parsed as Record<string, unknown>;
  // Must have the explicit action marker to distinguish from arbitrary JSON results
  if (record.action !== SUGGEST_CONNECTOR_SETUP_ACTION) return null;

  return extractSuggestionFromJson(text, turnId);
}

/**
 * Shared JSON extraction for both tool event detail and structured response text.
 * Expects a JSON string containing `connectorName` (or `connector_name`).
 */
function extractSuggestionFromJson(
  jsonStr: string,
  turnId: string,
): ConnectorSetupSuggestion | null {
  if (typeof jsonStr !== 'string' || jsonStr.trim() === '') return null;

  // BOUNDED via safeParseDetail: malformed OR over-budget input yields null.
  const result = safeParseDetail(jsonStr);
  if (!result.ok) return null;
  const parsed = result.value;
  if (typeof parsed !== 'object' || parsed === null) return null;

  const record = parsed as Record<string, unknown>;
  const connectorName = record.connectorName ?? record.connector_name;
  if (typeof connectorName !== 'string' || connectorName.trim() === '') return null;
  const intent = record.intent;
  if (intent !== undefined && intent !== 'build' && intent !== 'extend') {
    return null;
  }
  const normalizedIntent: ConnectorSetupIntent = intent === 'extend' ? 'extend' : 'build';
  const connectorId = record.connectorId ?? record.connector_id;

  return {
    connectorName: connectorName.trim(),
    intent: normalizedIntent,
    turnId,
    ...(typeof connectorId === 'string' && connectorId.trim() ? { connectorId: connectorId.trim() } : {}),
    reason: typeof record.reason === 'string' ? record.reason : undefined,
  };
}

/**
 * Builds a stable suppression key for a connector setup suggestion.
 *
 * The key combines intent (build vs extend) with connector identity,
 * preferring `connectorId` when present and otherwise falling back to
 * a normalized `connectorName` (trimmed + lowercased). This lets the
 * renderer track "user already answered this" across different turnIds
 * for the same connector — surviving cross-turn re-emission and
 * component unmount/remount.
 *
 * Format: `${intent}:${connectorId ?? normalizedName}`
 *
 * @see docs-private/investigations/260416_duplicate_connector_setup_card.md
 */
export function buildConnectorSetupKey(input: {
  intent: ConnectorSetupIntent;
  connectorId?: string;
  connectorName: string;
}): string {
  const id = input.connectorId?.trim();
  const fallback = input.connectorName.trim().toLowerCase();
  return `${input.intent}:${id && id.length > 0 ? id : fallback}`;
}

/**
 * Scans all events across turns to extract connector setup suggestions.
 *
 * Returns an array of suggestions, one per unique turn that contains a
 * `suggest_connector_setup` tool result or a structured response with
 * `action: 'suggest_connector_setup'`. Only the first suggestion per turn
 * is returned (agent shouldn't suggest the same connector twice in one turn).
 */
export function extractConnectorSetupSuggestions(
  eventsByTurn: Record<string, AgentEvent[]>,
): ConnectorSetupSuggestion[] {
  const suggestions: ConnectorSetupSuggestion[] = [];
  const seenTurns = new Set<string>();

  for (const [turnId, events] of Object.entries(eventsByTurn)) {
    if (seenTurns.has(turnId)) continue;
    for (const event of events) {
      const suggestion = parseConnectorSetupSignal(event, turnId);
      if (suggestion) {
        suggestions.push(suggestion);
        seenTurns.add(turnId);
        break; // One suggestion per turn
      }
    }
  }

  return suggestions;
}
