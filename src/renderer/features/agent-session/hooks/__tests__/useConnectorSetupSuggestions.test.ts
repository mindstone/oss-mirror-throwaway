// @vitest-environment happy-dom
/**
 * Tests for useConnectorSetupSuggestions hook — P5.5 setup offer card wiring.
 *
 * Validates the hook that detects structured connector setup suggestions in
 * conversation events and manages saved/unsaved state for footer prompt rendering.
 *
 * Validation contract assertions covered:
 *   VAL-OFFER-001: Card renders inline on missing-connector signal
 *   VAL-OFFER-002: Set it up starts build flow
 *   VAL-OFFER-003: Save for later swaps to saved card
 *   VAL-OFFER-004: Set up now from saved card reuses build flow
 *   VAL-OFFER-005: Structured signal triggers card rendering (not plain text)
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@renderer/test-utils';
import type { AgentEvent, AgentTurnMessage } from '@shared/types';
import {
  buildConnectorSetupQuestionBatch,
  selectLatestPendingConnectorSetupCard,
  useConnectorSetupSuggestions,
} from '../useConnectorSetupSuggestions';
import {
  buildConnectorSetupKey,
  SUGGEST_CONNECTOR_SETUP_TOOL,
  SUGGEST_CONNECTOR_SETUP_ACTION,
} from '@shared/utils/connectorSetupSignal';
import { useConnectorSetupAnsweredStore } from '../../store/connectorSetupAnsweredStore';

const DEFAULT_SESSION_ID = 'session-test';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAssistantMessage(id: string, turnId: string, text = 'Response'): AgentTurnMessage {
  return {
    id,
    turnId,
    role: 'assistant',
    text,
    createdAt: Date.now(),
  };
}

function makeUserMessage(id: string, turnId: string, text = 'Hello'): AgentTurnMessage {
  return {
    id,
    turnId,
    role: 'user',
    text,
    createdAt: Date.now(),
  };
}

function makeSuggestToolEvent(
  connectorName: string,
  overrides: Record<string, unknown> = {},
): AgentEvent {
  return {
    type: 'tool',
    toolName: SUGGEST_CONNECTOR_SETUP_TOOL,
    stage: 'end',
    detail: JSON.stringify({ connectorName, ...overrides }),
    timestamp: Date.now(),
  } as AgentEvent;
}

function makeStructuredResponseEvent(connectorName: string, reason?: string): AgentEvent {
  return {
    type: 'result',
    text: JSON.stringify({
      action: SUGGEST_CONNECTOR_SETUP_ACTION,
      connectorName,
      ...(reason ? { reason } : {}),
    }),
    timestamp: Date.now(),
  } as AgentEvent;
}

const noopResolve = (msg: AgentTurnMessage) => msg.turnId;

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('useConnectorSetupSuggestions', () => {
  beforeEach(() => {
    // Answered registry is a module-scoped zustand store; isolate tests.
    useConnectorSetupAnsweredStore.getState()._reset();
  });

  // -------------------------------------------------------------------------
  // VAL-OFFER-001: Latest unsaved suggestion becomes the footer prompt
  // -------------------------------------------------------------------------
  describe('latest footer prompt selection (VAL-OFFER-001)', () => {
    it('places card info at the index of the last assistant message in the suggestion turn', () => {
      const eventsByTurn: Record<string, AgentEvent[]> = {
        'turn-1': [makeSuggestToolEvent('Zendesk')],
      };
      const messages: AgentTurnMessage[] = [
        makeUserMessage('m1', 'turn-1'),
        makeAssistantMessage('m2', 'turn-1', 'I noticed you need Zendesk.'),
      ];

      const { result } = renderHook(() =>
        useConnectorSetupSuggestions(eventsByTurn, messages, noopResolve, DEFAULT_SESSION_ID),
      );

      // Card should be at index 1 (the assistant message)
      expect(result.current.cardByMessageIndex.size).toBe(1);
      const card = result.current.cardByMessageIndex.get(1);
      expect(card).toBeDefined();
      expect(card?.connectorName).toBe('Zendesk');
      expect(card?.intent).toBe('build');
      expect(card?.turnId).toBe('turn-1');
      expect(card?.isSaved).toBe(false);
      expect(result.current.pendingFooterCard).toEqual(card);
    });

    it('preserves extend intent and connectorId for downstream routing', () => {
      const eventsByTurn: Record<string, AgentEvent[]> = {
        'turn-1': [makeSuggestToolEvent('Zendesk', {
          intent: 'extend',
          connectorId: 'catalog:bundled-zendesk',
        })],
      };
      const messages: AgentTurnMessage[] = [
        makeUserMessage('m1', 'turn-1'),
        makeAssistantMessage('m2', 'turn-1', 'I can add more tools to Zendesk.'),
      ];

      const { result } = renderHook(() =>
        useConnectorSetupSuggestions(eventsByTurn, messages, noopResolve, DEFAULT_SESSION_ID),
      );

      const card = result.current.cardByMessageIndex.get(1);
      expect(card).toMatchObject({
        connectorName: 'Zendesk',
        intent: 'extend',
        connectorId: 'catalog:bundled-zendesk',
      });
    });

    it('does not place card after user messages even if they share the suggestion turn', () => {
      const eventsByTurn: Record<string, AgentEvent[]> = {
        'turn-1': [makeSuggestToolEvent('Freshdesk')],
      };
      // Only a user message in this turn — no assistant message to attach to
      const messages: AgentTurnMessage[] = [
        makeUserMessage('m1', 'turn-1'),
      ];

      const { result } = renderHook(() =>
        useConnectorSetupSuggestions(eventsByTurn, messages, noopResolve, DEFAULT_SESSION_ID),
      );

      expect(result.current.cardByMessageIndex.size).toBe(0);
    });

    it('returns empty map when no suggestions exist', () => {
      const eventsByTurn: Record<string, AgentEvent[]> = {
        'turn-1': [{ type: 'assistant', text: 'Hello', timestamp: Date.now() }],
      };
      const messages: AgentTurnMessage[] = [
        makeAssistantMessage('m1', 'turn-1'),
      ];

      const { result } = renderHook(() =>
        useConnectorSetupSuggestions(eventsByTurn, messages, noopResolve, DEFAULT_SESSION_ID),
      );

      expect(result.current.cardByMessageIndex.size).toBe(0);
      expect(result.current.pendingFooterCard).toBeNull();
    });

    it('surfaces the latest unsaved suggestion as the footer card', () => {
      const eventsByTurn: Record<string, AgentEvent[]> = {
        'turn-1': [makeSuggestToolEvent('Zendesk')],
        'turn-2': [makeSuggestToolEvent('Slack')],
      };
      const messages: AgentTurnMessage[] = [
        makeAssistantMessage('m1', 'turn-1'),
        makeAssistantMessage('m2', 'turn-2'),
      ];

      const { result } = renderHook(() =>
        useConnectorSetupSuggestions(eventsByTurn, messages, noopResolve, DEFAULT_SESSION_ID),
      );

      expect(result.current.pendingFooterCard).toMatchObject({
        connectorName: 'Slack',
        turnId: 'turn-2',
        isSaved: false,
      });
    });

    it('falls back to the next latest unsaved suggestion after saving the newest one', () => {
      const eventsByTurn: Record<string, AgentEvent[]> = {
        'turn-1': [makeSuggestToolEvent('Zendesk')],
        'turn-2': [makeSuggestToolEvent('Slack')],
      };
      const messages: AgentTurnMessage[] = [
        makeAssistantMessage('m1', 'turn-1'),
        makeAssistantMessage('m2', 'turn-2'),
      ];

      const { result } = renderHook(() =>
        useConnectorSetupSuggestions(eventsByTurn, messages, noopResolve, DEFAULT_SESSION_ID),
      );

      act(() => {
        result.current.saveForLater('turn-2');
      });

      expect(result.current.pendingFooterCard).toMatchObject({
        connectorName: 'Zendesk',
        turnId: 'turn-1',
        isSaved: false,
      });
    });
  });

  // -------------------------------------------------------------------------
  // VAL-OFFER-003: Save for later swaps to saved card
  // -------------------------------------------------------------------------
  describe('saveForLater (VAL-OFFER-003)', () => {
    it('marks a suggestion as saved by turnId, changing isSaved to true', () => {
      const eventsByTurn: Record<string, AgentEvent[]> = {
        'turn-1': [makeSuggestToolEvent('Zendesk')],
      };
      const messages: AgentTurnMessage[] = [
        makeAssistantMessage('m1', 'turn-1'),
      ];

      const { result } = renderHook(() =>
        useConnectorSetupSuggestions(eventsByTurn, messages, noopResolve, DEFAULT_SESSION_ID),
      );

      // Initially not saved
      expect(result.current.cardByMessageIndex.get(0)?.isSaved).toBe(false);

      // Save for later
      act(() => {
        result.current.saveForLater('turn-1');
      });

      // Now it should be saved
      expect(result.current.cardByMessageIndex.get(0)?.isSaved).toBe(true);
      expect(result.current.savedTurnIds.has('turn-1')).toBe(true);
      expect(result.current.pendingFooterCard).toBeNull();
    });

    it('only saves the specified turn, not others', () => {
      const eventsByTurn: Record<string, AgentEvent[]> = {
        'turn-1': [makeSuggestToolEvent('Zendesk')],
        'turn-2': [makeSuggestToolEvent('Slack')],
      };
      const messages: AgentTurnMessage[] = [
        makeAssistantMessage('m1', 'turn-1'),
        makeAssistantMessage('m2', 'turn-2'),
      ];

      const { result } = renderHook(() =>
        useConnectorSetupSuggestions(eventsByTurn, messages, noopResolve, DEFAULT_SESSION_ID),
      );

      act(() => {
        result.current.saveForLater('turn-1');
      });

      expect(result.current.cardByMessageIndex.get(0)?.isSaved).toBe(true);
      expect(result.current.cardByMessageIndex.get(1)?.isSaved).toBe(false);
    });
  });

  describe('selectLatestPendingConnectorSetupCard', () => {
    it('ignores saved cards and picks the highest message index', () => {
      const card = selectLatestPendingConnectorSetupCard(new Map([
        [1, { connectorName: 'Zendesk', intent: 'build', turnId: 'turn-1', isSaved: false }],
        [3, { connectorName: 'Slack', intent: 'build', turnId: 'turn-2', isSaved: true }],
        [2, { connectorName: 'Notion', intent: 'extend', turnId: 'turn-3', isSaved: false }],
      ]));

      expect(card).toMatchObject({
        connectorName: 'Notion',
        turnId: 'turn-3',
        intent: 'extend',
      });
    });
  });

  describe('buildConnectorSetupQuestionBatch', () => {
    it('builds a single-question batch that matches the Ask User Questions UI contract', () => {
      const batch = buildConnectorSetupQuestionBatch(
        {
          connectorName: 'Zendesk',
          intent: 'build',
          turnId: 'turn-1',
          isSaved: false,
        },
        'session-1',
      );

      expect(batch).toMatchObject({
        batchId: 'connector-setup:turn-1',
        toolUseId: 'connector-setup:turn-1',
        turnId: 'turn-1',
        sessionId: 'session-1',
      });
      expect(batch.questions).toHaveLength(1);
      expect(batch.questions[0]).toMatchObject({
        header: 'Make a new tool',
        multiSelect: false,
        options: [
          { id: 'set-up-now', label: 'Start making it' },
          { id: 'save-for-later', label: 'Save for later' },
        ],
      });
    });
  });

  // -------------------------------------------------------------------------
  // VAL-OFFER-002 + VAL-OFFER-004: Set it up / Set up now handlers
  // -------------------------------------------------------------------------
  describe('handler callbacks (VAL-OFFER-002 + VAL-OFFER-004)', () => {
    it('card info provides connectorName for the onSetUp callback', () => {
      const eventsByTurn: Record<string, AgentEvent[]> = {
        'turn-1': [makeSuggestToolEvent('Zendesk')],
      };
      const messages: AgentTurnMessage[] = [
        makeAssistantMessage('m1', 'turn-1'),
      ];

      const { result } = renderHook(() =>
        useConnectorSetupSuggestions(eventsByTurn, messages, noopResolve, DEFAULT_SESSION_ID),
      );

      const card = result.current.cardByMessageIndex.get(0);
      expect(card?.connectorName).toBe('Zendesk');
      expect(card?.intent).toBe('build');
      // The parent component (ConversationPane) uses card.connectorName to call onConnectorSetUp
    });

    it('saved card still provides connectorName for the onSetUpNow callback (same build flow)', () => {
      const eventsByTurn: Record<string, AgentEvent[]> = {
        'turn-1': [makeSuggestToolEvent('Zendesk')],
      };
      const messages: AgentTurnMessage[] = [
        makeAssistantMessage('m1', 'turn-1'),
      ];

      const { result } = renderHook(() =>
        useConnectorSetupSuggestions(eventsByTurn, messages, noopResolve, DEFAULT_SESSION_ID),
      );

      act(() => {
        result.current.saveForLater('turn-1');
      });

      const savedCard = result.current.cardByMessageIndex.get(0);
      expect(savedCard?.isSaved).toBe(true);
      expect(savedCard?.connectorName).toBe('Zendesk');
      // ConversationPane renders MCPSavedForLaterCard with onSetUpNow calling same handler
    });
  });

  // -------------------------------------------------------------------------
  // VAL-OFFER-005: Only structured signals, not plain text
  // -------------------------------------------------------------------------
  describe('structured-only triggers (VAL-OFFER-005)', () => {
    it('does not detect plain-text mention of connector setup as a signal', () => {
      const eventsByTurn: Record<string, AgentEvent[]> = {
        'turn-1': [
          {
            type: 'assistant',
            text: 'I can help you set up a Zendesk connector. Would you like me to suggest_connector_setup?',
            timestamp: Date.now(),
          },
        ],
      };
      const messages: AgentTurnMessage[] = [
        makeAssistantMessage('m1', 'turn-1', 'I can help you set up a Zendesk connector.'),
      ];

      const { result } = renderHook(() =>
        useConnectorSetupSuggestions(eventsByTurn, messages, noopResolve, DEFAULT_SESSION_ID),
      );

      expect(result.current.cardByMessageIndex.size).toBe(0);
    });

    it('does not detect a different tool name even with matching JSON structure', () => {
      const eventsByTurn: Record<string, AgentEvent[]> = {
        'turn-1': [
          {
            type: 'tool',
            toolName: 'web_search',
            stage: 'end',
            detail: JSON.stringify({ connectorName: 'Zendesk' }),
            timestamp: Date.now(),
          } as AgentEvent,
        ],
      };
      const messages: AgentTurnMessage[] = [
        makeAssistantMessage('m1', 'turn-1'),
      ];

      const { result } = renderHook(() =>
        useConnectorSetupSuggestions(eventsByTurn, messages, noopResolve, DEFAULT_SESSION_ID),
      );

      expect(result.current.cardByMessageIndex.size).toBe(0);
    });

    it('detects only the structured suggest_connector_setup tool result', () => {
      const eventsByTurn: Record<string, AgentEvent[]> = {
        'turn-1': [
          // Plain text assistant message (should NOT trigger)
          { type: 'assistant', text: 'You need Zendesk', timestamp: Date.now() },
          // Different tool (should NOT trigger)
          { type: 'tool', toolName: 'web_search', stage: 'end', detail: '{}', timestamp: Date.now() } as AgentEvent,
          // The actual structured signal (should trigger)
          makeSuggestToolEvent('Zendesk'),
        ],
      };
      const messages: AgentTurnMessage[] = [
        makeAssistantMessage('m1', 'turn-1'),
      ];

      const { result } = renderHook(() =>
        useConnectorSetupSuggestions(eventsByTurn, messages, noopResolve, DEFAULT_SESSION_ID),
      );

      expect(result.current.cardByMessageIndex.size).toBe(1);
      expect(result.current.cardByMessageIndex.get(0)?.connectorName).toBe('Zendesk');
    });

    it('detects structured response with action marker', () => {
      const eventsByTurn: Record<string, AgentEvent[]> = {
        'turn-1': [makeStructuredResponseEvent('Zendesk', 'Missing connector')],
      };
      const messages: AgentTurnMessage[] = [
        makeAssistantMessage('m1', 'turn-1'),
      ];

      const { result } = renderHook(() =>
        useConnectorSetupSuggestions(eventsByTurn, messages, noopResolve, DEFAULT_SESSION_ID),
      );

      expect(result.current.cardByMessageIndex.size).toBe(1);
      expect(result.current.cardByMessageIndex.get(0)?.connectorName).toBe('Zendesk');
    });

    it('does not detect result event without action marker as a signal', () => {
      const eventsByTurn: Record<string, AgentEvent[]> = {
        'turn-1': [
          {
            type: 'result',
            text: JSON.stringify({ connectorName: 'Zendesk' }),
            timestamp: Date.now(),
          } as AgentEvent,
        ],
      };
      const messages: AgentTurnMessage[] = [
        makeAssistantMessage('m1', 'turn-1'),
      ];

      const { result } = renderHook(() =>
        useConnectorSetupSuggestions(eventsByTurn, messages, noopResolve, DEFAULT_SESSION_ID),
      );

      expect(result.current.cardByMessageIndex.size).toBe(0);
    });

    it('does not detect plain-text result event as a signal', () => {
      const eventsByTurn: Record<string, AgentEvent[]> = {
        'turn-1': [
          {
            type: 'result',
            text: 'You should set up the Zendesk connector. suggest_connector_setup',
            timestamp: Date.now(),
          } as AgentEvent,
        ],
      };
      const messages: AgentTurnMessage[] = [
        makeAssistantMessage('m1', 'turn-1'),
      ];

      const { result } = renderHook(() =>
        useConnectorSetupSuggestions(eventsByTurn, messages, noopResolve, DEFAULT_SESSION_ID),
      );

      expect(result.current.cardByMessageIndex.size).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Session-scoped answered registry — duplicate-card regression guard
  // Covers docs-private/investigations/260416_duplicate_connector_setup_card.md
  // -------------------------------------------------------------------------
  describe('answered registry (260416 duplicate-card regression)', () => {
    it('marking one suggestion answered suppresses a sibling suggestion with a different turnId but the same (intent, connectorName) — HARD GATE', () => {
      // Two suggestions for the same connector across two turns. Without the
      // session-scoped registry this reproduced the duplicate-card bug: answering
      // turn-1's card did not suppress turn-2's card.
      const eventsByTurn: Record<string, AgentEvent[]> = {
        'turn-1': [makeSuggestToolEvent('Fathom')],
        'turn-2': [makeSuggestToolEvent('Fathom')],
      };
      const messages: AgentTurnMessage[] = [
        makeAssistantMessage('m1', 'turn-1'),
        makeAssistantMessage('m2', 'turn-2'),
      ];

      const { result } = renderHook(() =>
        useConnectorSetupSuggestions(eventsByTurn, messages, noopResolve, DEFAULT_SESSION_ID),
      );

      expect(result.current.pendingFooterCard).toMatchObject({
        connectorName: 'Fathom',
        turnId: 'turn-2',
      });

      const key = buildConnectorSetupKey({ intent: 'build', connectorName: 'Fathom' });
      act(() => {
        result.current.markAnswered(key);
      });

      expect(result.current.pendingFooterCard).toBeNull();
      expect(result.current.cardByMessageIndex.get(0)?.isSaved).toBe(true);
      expect(result.current.cardByMessageIndex.get(1)?.isSaved).toBe(true);
    });

    it('markPending suppresses the card even before answered (immediate-click suppression)', () => {
      const eventsByTurn: Record<string, AgentEvent[]> = {
        'turn-1': [makeSuggestToolEvent('Fathom')],
      };
      const messages: AgentTurnMessage[] = [
        makeAssistantMessage('m1', 'turn-1'),
      ];

      const { result } = renderHook(() =>
        useConnectorSetupSuggestions(eventsByTurn, messages, noopResolve, DEFAULT_SESSION_ID),
      );

      const key = buildConnectorSetupKey({ intent: 'build', connectorName: 'Fathom' });
      act(() => {
        result.current.markPending(key);
      });
      expect(result.current.pendingFooterCard).toBeNull();
    });

    it('clearPending restores the card for retry after a failed enqueue', () => {
      const eventsByTurn: Record<string, AgentEvent[]> = {
        'turn-1': [makeSuggestToolEvent('Fathom')],
      };
      const messages: AgentTurnMessage[] = [
        makeAssistantMessage('m1', 'turn-1'),
      ];

      const { result } = renderHook(() =>
        useConnectorSetupSuggestions(eventsByTurn, messages, noopResolve, DEFAULT_SESSION_ID),
      );

      const key = buildConnectorSetupKey({ intent: 'build', connectorName: 'Fathom' });
      act(() => {
        result.current.markPending(key);
      });
      expect(result.current.pendingFooterCard).toBeNull();

      act(() => {
        result.current.clearPending(key);
      });
      expect(result.current.pendingFooterCard).toMatchObject({
        connectorName: 'Fathom',
        turnId: 'turn-1',
      });
    });

    it('treats build vs extend as independent keys for the same connector name', () => {
      const eventsByTurn: Record<string, AgentEvent[]> = {
        'turn-1': [makeSuggestToolEvent('Fathom', { intent: 'extend' })],
      };
      const messages: AgentTurnMessage[] = [
        makeAssistantMessage('m1', 'turn-1'),
      ];

      const { result } = renderHook(() =>
        useConnectorSetupSuggestions(eventsByTurn, messages, noopResolve, DEFAULT_SESSION_ID),
      );

      const buildKey = buildConnectorSetupKey({ intent: 'build', connectorName: 'Fathom' });
      act(() => {
        // Answering a build key should NOT affect the extend suggestion.
        result.current.markAnswered(buildKey);
      });

      expect(result.current.pendingFooterCard).toMatchObject({
        connectorName: 'Fathom',
        intent: 'extend',
      });
    });

    it('hasContributionForConnector callback suppresses the matching footer card (260427 footer-question follow-on)', () => {
      // Reproduces the user-reported screenshot: a `suggest_connector_setup`
      // suggestion for "Google Analytics" should disappear once a contribution
      // record exists for that connector — even if no answered/pending key
      // has been written, and even while the agent is still planning.
      const eventsByTurn: Record<string, AgentEvent[]> = {
        'turn-1': [makeSuggestToolEvent('Google Analytics')],
      };
      const messages: AgentTurnMessage[] = [
        makeAssistantMessage('m1', 'turn-1'),
      ];

      const hasContributionForConnector = (name: string) => name === 'Google Analytics';

      const { result } = renderHook(() =>
        useConnectorSetupSuggestions(
          eventsByTurn,
          messages,
          noopResolve,
          DEFAULT_SESSION_ID,
          hasContributionForConnector,
        ),
      );

      expect(result.current.cardByMessageIndex.get(0)?.isSaved).toBe(true);
      expect(result.current.pendingFooterCard).toBeNull();
    });

    it('hasContributionForConnector matches case-insensitively after trim (260427 footer-question follow-on)', () => {
      // The contribution store persists "Google Analytics" verbatim, but the
      // agent might emit `connectorName` with different casing or stray
      // whitespace. Suppression must hold either way; this mirrors
      // `buildConnectorSetupKey` normalization.
      const eventsByTurn: Record<string, AgentEvent[]> = {
        'turn-1': [makeSuggestToolEvent('GoogleAnalytics')],
      };
      const messages: AgentTurnMessage[] = [
        makeAssistantMessage('m1', 'turn-1'),
      ];

      const linkedNames = ['  googleanalytics  '];
      const hasContributionForConnector = (name: string) => {
        const target = name.trim().toLowerCase();
        return linkedNames.some((n) => n.trim().toLowerCase() === target);
      };

      const { result } = renderHook(() =>
        useConnectorSetupSuggestions(
          eventsByTurn,
          messages,
          noopResolve,
          DEFAULT_SESSION_ID,
          hasContributionForConnector,
        ),
      );

      expect(result.current.cardByMessageIndex.get(0)?.isSaved).toBe(true);
      expect(result.current.pendingFooterCard).toBeNull();
    });

    it('hasContributionForConnector only suppresses cards whose connector name matches (260427 footer-question follow-on)', () => {
      // A contribution for "Google Analytics" must not silence a separate
      // suggestion for "Slack" — different connectors, different cards,
      // independent suppression.
      const eventsByTurn: Record<string, AgentEvent[]> = {
        'turn-1': [makeSuggestToolEvent('Slack')],
      };
      const messages: AgentTurnMessage[] = [
        makeAssistantMessage('m1', 'turn-1'),
      ];

      const hasContributionForConnector = (name: string) => name === 'Google Analytics';

      const { result } = renderHook(() =>
        useConnectorSetupSuggestions(
          eventsByTurn,
          messages,
          noopResolve,
          DEFAULT_SESSION_ID,
          hasContributionForConnector,
        ),
      );

      expect(result.current.cardByMessageIndex.get(0)?.isSaved).toBe(false);
      expect(result.current.pendingFooterCard).toMatchObject({
        connectorName: 'Slack',
        turnId: 'turn-1',
      });
    });

    it('session A answered keys do not hide session B cards', () => {
      const eventsByTurn: Record<string, AgentEvent[]> = {
        'turn-1': [makeSuggestToolEvent('Fathom')],
      };
      const messages: AgentTurnMessage[] = [
        makeAssistantMessage('m1', 'turn-1'),
      ];

      const sessionA = 'session-A';
      const sessionB = 'session-B';

      const { result: resultA } = renderHook(() =>
        useConnectorSetupSuggestions(eventsByTurn, messages, noopResolve, sessionA),
      );
      const { result: resultB } = renderHook(() =>
        useConnectorSetupSuggestions(eventsByTurn, messages, noopResolve, sessionB),
      );

      const key = buildConnectorSetupKey({ intent: 'build', connectorName: 'Fathom' });
      act(() => {
        resultA.current.markAnswered(key);
      });

      expect(resultA.current.pendingFooterCard).toBeNull();
      expect(resultB.current.pendingFooterCard).toMatchObject({
        connectorName: 'Fathom',
        turnId: 'turn-1',
      });
    });
  });
});
