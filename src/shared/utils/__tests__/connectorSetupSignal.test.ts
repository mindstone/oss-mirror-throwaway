/**
 * Tests for structured connector setup signal detection.
 *
 * Validates that MCPSetupOfferCard rendering is triggered ONLY by structured
 * mechanisms — tool results from `suggest_connector_setup` OR structured response
 * payloads with `action: 'suggest_connector_setup'` — not by plain-text matching.
 *
 * Validation contract assertions covered:
 *   VAL-OFFER-005: Structured signal triggers card rendering
 */
import { describe, it, expect } from 'vitest';
import type { AgentEvent } from '@shared/types';
import {
  parseConnectorSetupSignal,
  extractConnectorSetupSuggestions,
  buildConnectorSetupKey,
  SUGGEST_CONNECTOR_SETUP_TOOL,
  SUGGEST_CONNECTOR_SETUP_ACTION,
} from '../connectorSetupSignal';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Creates a tool event with the given properties. */
function makeToolEvent(
  overrides: Partial<Extract<AgentEvent, { type: 'tool' }>> = {},
): AgentEvent {
  return {
    type: 'tool',
    toolName: SUGGEST_CONNECTOR_SETUP_TOOL,
    stage: 'end',
    detail: JSON.stringify({ connectorName: 'Zendesk' }),
    timestamp: Date.now(),
    ...overrides,
  } as AgentEvent;
}

/** Creates a structured response (result) event with the given text payload. */
function makeStructuredResponseEvent(
  payload: Record<string, unknown>,
  overrides: Partial<Extract<AgentEvent, { type: 'result' }>> = {},
): AgentEvent {
  return {
    type: 'result',
    text: JSON.stringify(payload),
    timestamp: Date.now(),
    ...overrides,
  } as AgentEvent;
}

// ---------------------------------------------------------------------------
// parseConnectorSetupSignal
// ---------------------------------------------------------------------------

describe('parseConnectorSetupSignal', () => {
  it('extracts connectorName from a valid suggest_connector_setup end event', () => {
    const event = makeToolEvent({
      detail: JSON.stringify({ connectorName: 'Zendesk', reason: 'Missing connector' }),
    });
    const result = parseConnectorSetupSignal(event, 'turn-1');

    expect(result).toEqual({
      connectorName: 'Zendesk',
      intent: 'build',
      turnId: 'turn-1',
      reason: 'Missing connector',
    });
  });

  it('accepts connector_name (snake_case) as an alternative key', () => {
    const event = makeToolEvent({
      detail: JSON.stringify({ connector_name: 'Freshdesk' }),
    });
    const result = parseConnectorSetupSignal(event, 'turn-2');

    expect(result).toEqual({
      connectorName: 'Freshdesk',
      intent: 'build',
      turnId: 'turn-2',
      reason: undefined,
    });
  });

  it('extracts extend intent and connectorId when provided', () => {
    const event = makeToolEvent({
      detail: JSON.stringify({
        connectorName: 'Zendesk',
        intent: 'extend',
        connectorId: 'catalog:bundled-zendesk',
      }),
    });

    const result = parseConnectorSetupSignal(event, 'turn-2b');

    expect(result).toEqual({
      connectorName: 'Zendesk',
      intent: 'extend',
      connectorId: 'catalog:bundled-zendesk',
      turnId: 'turn-2b',
      reason: undefined,
    });
  });

  it('trims whitespace from connectorName', () => {
    const event = makeToolEvent({
      detail: JSON.stringify({ connectorName: '  HubSpot  ' }),
    });
    const result = parseConnectorSetupSignal(event, 'turn-3');

    expect(result?.connectorName).toBe('HubSpot');
  });

  // VAL-OFFER-005: Only structured triggers — not plain text
  it('returns null for non-tool events (plain text assistant message)', () => {
    const assistantEvent: AgentEvent = {
      type: 'assistant',
      text: 'I noticed you need a Zendesk connector. I can set one up for you.',
      timestamp: Date.now(),
    };
    expect(parseConnectorSetupSignal(assistantEvent, 'turn-4')).toBeNull();
  });

  it('returns null for a tool event with wrong tool name', () => {
    const event = makeToolEvent({ toolName: 'other_tool' });
    expect(parseConnectorSetupSignal(event, 'turn-5')).toBeNull();
  });

  it('returns null for tool start events (only end events have results)', () => {
    const event = makeToolEvent({ stage: 'start' });
    expect(parseConnectorSetupSignal(event, 'turn-6')).toBeNull();
  });

  it('returns null for subagent tool events', () => {
    const event = makeToolEvent({ parentToolUseId: 'parent-tu-1' });
    expect(parseConnectorSetupSignal(event, 'turn-6b')).toBeNull();
  });

  it('returns null for empty detail string', () => {
    const event = makeToolEvent({ detail: '' });
    expect(parseConnectorSetupSignal(event, 'turn-7')).toBeNull();
  });

  it('returns null for invalid JSON in detail', () => {
    const event = makeToolEvent({ detail: 'not valid json' });
    expect(parseConnectorSetupSignal(event, 'turn-8')).toBeNull();
  });

  it('returns null for invalid intent values instead of coercing to build', () => {
    const event = makeToolEvent({
      detail: JSON.stringify({ connectorName: 'Zendesk', intent: 'add' }),
    });
    expect(parseConnectorSetupSignal(event, 'turn-8b')).toBeNull();
  });

  it('returns null when connectorName is missing from parsed JSON', () => {
    const event = makeToolEvent({ detail: JSON.stringify({ reason: 'test' }) });
    expect(parseConnectorSetupSignal(event, 'turn-9')).toBeNull();
  });

  it('returns null when connectorName is empty string', () => {
    const event = makeToolEvent({ detail: JSON.stringify({ connectorName: '' }) });
    expect(parseConnectorSetupSignal(event, 'turn-10')).toBeNull();
  });

  it('returns null when connectorName is whitespace only', () => {
    const event = makeToolEvent({ detail: JSON.stringify({ connectorName: '   ' }) });
    expect(parseConnectorSetupSignal(event, 'turn-11')).toBeNull();
  });

  it('returns null for status events', () => {
    const event: AgentEvent = { type: 'status', message: 'suggest_connector_setup starting', timestamp: Date.now() };
    expect(parseConnectorSetupSignal(event, 'turn-12')).toBeNull();
  });

  it('returns null for plain-text result events (no JSON)', () => {
    const event: AgentEvent = { type: 'result', text: 'suggest_connector_setup', timestamp: Date.now() };
    expect(parseConnectorSetupSignal(event, 'turn-13')).toBeNull();
  });

  it('returns null for result events with JSON but missing action field', () => {
    const event = makeStructuredResponseEvent({ connectorName: 'Zendesk' });
    expect(parseConnectorSetupSignal(event, 'turn-14')).toBeNull();
  });

  it('returns null for result events with wrong action value', () => {
    const event = makeStructuredResponseEvent({ action: 'other_action', connectorName: 'Zendesk' });
    expect(parseConnectorSetupSignal(event, 'turn-15')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// parseConnectorSetupSignal — structured response pathway
// ---------------------------------------------------------------------------

describe('parseConnectorSetupSignal (structured response)', () => {
  it('extracts connectorName from a valid structured response with action marker', () => {
    const event = makeStructuredResponseEvent({
      action: SUGGEST_CONNECTOR_SETUP_ACTION,
      connectorName: 'Zendesk',
      reason: 'Missing connector for ticket lookup',
    });
    const result = parseConnectorSetupSignal(event, 'turn-1');

    expect(result).toEqual({
      connectorName: 'Zendesk',
      intent: 'build',
      turnId: 'turn-1',
      reason: 'Missing connector for ticket lookup',
    });
  });

  it('accepts connector_name (snake_case) in structured response', () => {
    const event = makeStructuredResponseEvent({
      action: SUGGEST_CONNECTOR_SETUP_ACTION,
      connector_name: 'Freshdesk',
    });
    const result = parseConnectorSetupSignal(event, 'turn-2');

    expect(result).toEqual({
      connectorName: 'Freshdesk',
      intent: 'build',
      turnId: 'turn-2',
      reason: undefined,
    });
  });

  it('trims whitespace from connectorName in structured response', () => {
    const event = makeStructuredResponseEvent({
      action: SUGGEST_CONNECTOR_SETUP_ACTION,
      connectorName: '  HubSpot  ',
    });
    const result = parseConnectorSetupSignal(event, 'turn-3');

    expect(result?.connectorName).toBe('HubSpot');
  });

  it('returns null when structured response has empty connectorName', () => {
    const event = makeStructuredResponseEvent({
      action: SUGGEST_CONNECTOR_SETUP_ACTION,
      connectorName: '',
    });
    expect(parseConnectorSetupSignal(event, 'turn-4')).toBeNull();
  });

  it('returns null when structured response has whitespace-only connectorName', () => {
    const event = makeStructuredResponseEvent({
      action: SUGGEST_CONNECTOR_SETUP_ACTION,
      connectorName: '   ',
    });
    expect(parseConnectorSetupSignal(event, 'turn-5')).toBeNull();
  });

  it('returns null when structured response is missing connectorName entirely', () => {
    const event = makeStructuredResponseEvent({
      action: SUGGEST_CONNECTOR_SETUP_ACTION,
      reason: 'Some reason',
    });
    expect(parseConnectorSetupSignal(event, 'turn-6')).toBeNull();
  });

  it('returns null for result event with empty text', () => {
    const event: AgentEvent = { type: 'result', text: '', timestamp: Date.now() };
    expect(parseConnectorSetupSignal(event, 'turn-7')).toBeNull();
  });

  it('returns null for result event with non-object JSON (array)', () => {
    const event: AgentEvent = {
      type: 'result',
      text: JSON.stringify([{ action: SUGGEST_CONNECTOR_SETUP_ACTION, connectorName: 'Zendesk' }]),
      timestamp: Date.now(),
    };
    expect(parseConnectorSetupSignal(event, 'turn-8')).toBeNull();
  });

  it('returns null for result event with non-object JSON (string)', () => {
    const event: AgentEvent = {
      type: 'result',
      text: JSON.stringify('suggest_connector_setup'),
      timestamp: Date.now(),
    };
    expect(parseConnectorSetupSignal(event, 'turn-9')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// extractConnectorSetupSuggestions
// ---------------------------------------------------------------------------

describe('extractConnectorSetupSuggestions', () => {
  it('extracts suggestions from eventsByTurn', () => {
    const eventsByTurn: Record<string, AgentEvent[]> = {
      'turn-a': [
        { type: 'status', message: 'Checking connectors...', timestamp: Date.now() },
        makeToolEvent({ detail: JSON.stringify({ connectorName: 'Slack' }) }),
      ],
      'turn-b': [
        { type: 'assistant', text: 'Hello!', timestamp: Date.now() },
      ],
    };

    const suggestions = extractConnectorSetupSuggestions(eventsByTurn);
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]).toEqual({
      connectorName: 'Slack',
      intent: 'build',
      turnId: 'turn-a',
      reason: undefined,
    });
  });

  it('returns one suggestion per turn (first match)', () => {
    const eventsByTurn: Record<string, AgentEvent[]> = {
      'turn-a': [
        makeToolEvent({ detail: JSON.stringify({ connectorName: 'Zendesk' }) }),
        makeToolEvent({ detail: JSON.stringify({ connectorName: 'Freshdesk' }) }),
      ],
    };

    const suggestions = extractConnectorSetupSuggestions(eventsByTurn);
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0].connectorName).toBe('Zendesk');
  });

  it('returns empty array when no suggestions found', () => {
    const eventsByTurn: Record<string, AgentEvent[]> = {
      'turn-a': [
        { type: 'assistant', text: 'I can help set up a connector', timestamp: Date.now() },
      ],
    };

    expect(extractConnectorSetupSuggestions(eventsByTurn)).toEqual([]);
  });

  it('returns empty array for empty eventsByTurn', () => {
    expect(extractConnectorSetupSuggestions({})).toEqual([]);
  });

  it('handles multiple turns with suggestions', () => {
    const eventsByTurn: Record<string, AgentEvent[]> = {
      'turn-a': [makeToolEvent({ detail: JSON.stringify({ connectorName: 'Zendesk' }) })],
      'turn-b': [makeToolEvent({ detail: JSON.stringify({ connectorName: 'Slack' }) })],
    };

    const suggestions = extractConnectorSetupSuggestions(eventsByTurn);
    expect(suggestions).toHaveLength(2);
    const names = suggestions.map(s => s.connectorName);
    expect(names).toContain('Zendesk');
    expect(names).toContain('Slack');
  });

  // VAL-OFFER-005: plain text does not trigger
  it('does not extract suggestions from plain text mentioning connector names', () => {
    const eventsByTurn: Record<string, AgentEvent[]> = {
      'turn-a': [
        { type: 'assistant', text: 'You should set up Zendesk. suggest_connector_setup Zendesk', timestamp: Date.now() },
        { type: 'tool', toolName: 'research', stage: 'end', detail: JSON.stringify({ connectorName: 'Zendesk' }), timestamp: Date.now() } as AgentEvent,
      ],
    };

    // The tool event has the wrong tool name ('research'), so it shouldn't match
    expect(extractConnectorSetupSuggestions(eventsByTurn)).toEqual([]);
  });

  // VAL-OFFER-005: structured response triggers card rendering
  it('extracts suggestion from structured response event', () => {
    const eventsByTurn: Record<string, AgentEvent[]> = {
      'turn-a': [
        makeStructuredResponseEvent({
          action: SUGGEST_CONNECTOR_SETUP_ACTION,
          connectorName: 'Zendesk',
          reason: 'Missing connector',
        }),
      ],
    };

    const suggestions = extractConnectorSetupSuggestions(eventsByTurn);
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]).toEqual({
      connectorName: 'Zendesk',
      intent: 'build',
      turnId: 'turn-a',
      reason: 'Missing connector',
    });
  });

  it('extracts suggestion from mixed tool event and structured response across turns', () => {
    const eventsByTurn: Record<string, AgentEvent[]> = {
      'turn-a': [makeToolEvent({ detail: JSON.stringify({ connectorName: 'Zendesk' }) })],
      'turn-b': [
        makeStructuredResponseEvent({
          action: SUGGEST_CONNECTOR_SETUP_ACTION,
          connectorName: 'Slack',
        }),
      ],
    };

    const suggestions = extractConnectorSetupSuggestions(eventsByTurn);
    expect(suggestions).toHaveLength(2);
    const names = suggestions.map(s => s.connectorName);
    expect(names).toContain('Zendesk');
    expect(names).toContain('Slack');
  });

  it('does not extract from result event without action marker', () => {
    const eventsByTurn: Record<string, AgentEvent[]> = {
      'turn-a': [
        {
          type: 'result',
          text: JSON.stringify({ connectorName: 'Zendesk' }),
          timestamp: Date.now(),
        } as AgentEvent,
      ],
    };

    expect(extractConnectorSetupSuggestions(eventsByTurn)).toEqual([]);
  });

  it('prefers first match in a turn (tool event before structured response)', () => {
    const eventsByTurn: Record<string, AgentEvent[]> = {
      'turn-a': [
        makeToolEvent({ detail: JSON.stringify({ connectorName: 'Zendesk' }) }),
        makeStructuredResponseEvent({
          action: SUGGEST_CONNECTOR_SETUP_ACTION,
          connectorName: 'Freshdesk',
        }),
      ],
    };

    const suggestions = extractConnectorSetupSuggestions(eventsByTurn);
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0].connectorName).toBe('Zendesk');
  });
});

// ---------------------------------------------------------------------------
// buildConnectorSetupKey: stable suppression key for the answered registry
// See docs-private/investigations/260416_duplicate_connector_setup_card.md
// ---------------------------------------------------------------------------
describe('buildConnectorSetupKey', () => {
  it('prefers connectorId over connectorName when present', () => {
    const keyA = buildConnectorSetupKey({
      intent: 'extend',
      connectorId: 'catalog:bundled-zendesk',
      connectorName: 'Zendesk',
    });
    const keyB = buildConnectorSetupKey({
      intent: 'extend',
      connectorId: 'catalog:bundled-zendesk',
      connectorName: 'zendesk',
    });
    expect(keyA).toBe(keyB);
    expect(keyA).toBe('extend:catalog:bundled-zendesk');
  });

  it('falls back to normalized connectorName when connectorId is missing', () => {
    const key = buildConnectorSetupKey({ intent: 'build', connectorName: '  Zendesk  ' });
    expect(key).toBe('build:zendesk');
  });

  it('treats empty/whitespace connectorId as missing and falls back to name', () => {
    const key = buildConnectorSetupKey({
      intent: 'build',
      connectorId: '   ',
      connectorName: 'Slack',
    });
    expect(key).toBe('build:slack');
  });

  it('produces different keys for different intents with the same name', () => {
    const build = buildConnectorSetupKey({ intent: 'build', connectorName: 'Zendesk' });
    const extend = buildConnectorSetupKey({ intent: 'extend', connectorName: 'Zendesk' });
    expect(build).not.toBe(extend);
  });

  it('produces the same key for case/whitespace variants of connectorName (no id)', () => {
    const a = buildConnectorSetupKey({ intent: 'build', connectorName: 'ZenDesk' });
    const b = buildConnectorSetupKey({ intent: 'build', connectorName: '  zendesk ' });
    const c = buildConnectorSetupKey({ intent: 'build', connectorName: 'ZENDESK' });
    expect(a).toBe(b);
    expect(b).toBe(c);
  });
});
