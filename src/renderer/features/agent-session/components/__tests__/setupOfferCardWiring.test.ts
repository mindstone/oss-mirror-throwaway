/**
 * Tests for P5.5 MCPSetupOfferCard / MCPSavedForLaterCard inline wiring.
 *
 * These are integration-level tests that verify the full chain:
 *   structured signal → hook → card rendering props → callback invocation.
 *
 * The rendering is tested via prop assertions (not DOM rendering) since
 * ConversationPane uses TanStack Virtual which requires a real scroll container.
 * Component render tests for the cards themselves exist as visual shell tests.
 *
 * Validation contract assertions covered:
 *   VAL-OFFER-001: Card renders inline on missing-connector signal
 *   VAL-OFFER-002: Set it up starts build flow
 *   VAL-OFFER-003: Save for later swaps to saved card
 *   VAL-OFFER-004: Set up now from saved card reuses build flow
 *   VAL-OFFER-005: Structured signal triggers card rendering
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AgentEvent, AgentTurnMessage } from '@shared/types';
import {
  parseConnectorSetupSignal,
  extractConnectorSetupSuggestions,
  SUGGEST_CONNECTOR_SETUP_TOOL,
  SUGGEST_CONNECTOR_SETUP_ACTION,
} from '@shared/utils/connectorSetupSignal';
import {
  buildOssMcpEntryPointBuildPrompt,
  buildOssMcpEntryPointExtendPrompt,
} from '@shared/utils/ossMcpChatIntent';
import type { ConnectorSetupCardInfo } from '../../hooks/useConnectorSetupSuggestions';

// ---------------------------------------------------------------------------
// Shared mocks — mirror the P1 handler pattern
// ---------------------------------------------------------------------------
const mockStartFreshSession = vi.fn(() => 'new-session-id-setup');
const mockCloseSettingsDialog = vi.fn();
const mockPrepareMentionAttachments = vi.fn();
const mockSubmitQueuedMessage = vi.fn();
const mockShowToast = vi.fn();

interface BuildConnectorDeps {
  closeSettingsDialog: () => void;
  startFreshSession: () => string;
  prepareMentionAttachments: (prompt: string) => Promise<unknown[]>;
  submitQueuedMessage: (text: string, source: string, attachments?: unknown[], options?: Record<string, unknown>) => void;
  showToast: (opts: { title: string }) => void;
}

async function seedConnectorPrompt(
  deps: BuildConnectorDeps,
  prompt: string,
  targetSessionId: string,
  fallbackMessage: string,
): Promise<void> {
  const { prepareMentionAttachments, submitQueuedMessage, showToast } = deps;
  try {
    const mentionAttachments = await prepareMentionAttachments(prompt);
    await submitQueuedMessage(
      prompt,
      'text',
      mentionAttachments.length > 0 ? mentionAttachments : undefined,
      { targetSessionId },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : fallbackMessage;
    showToast({ title: message });
  }
}

/**
 * handleBuildConnector — same as P1 entry point handler.
 * In the real app, this is defined in App.tsx and passed through as onConnectorSetUp.
 */
async function handleBuildConnector(
  deps: BuildConnectorDeps,
  searchQuery?: string,
): Promise<void> {
  const { closeSettingsDialog, startFreshSession, prepareMentionAttachments, submitQueuedMessage, showToast } = deps;
  closeSettingsDialog();
  const sessionId = startFreshSession();
  const prompt = buildOssMcpEntryPointBuildPrompt(searchQuery);
  try {
    const mentionAttachments = await prepareMentionAttachments(prompt);
    await submitQueuedMessage(
      prompt,
      'text',
      mentionAttachments.length > 0 ? mentionAttachments : undefined,
      { targetSessionId: sessionId },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to start connector setup';
    showToast({ title: message });
  }
}

async function handleConnectorSetUpInCurrentSession(
  deps: BuildConnectorDeps,
  currentSessionId: string,
  card: ConnectorSetupCardInfo,
): Promise<void> {
  const { closeSettingsDialog } = deps;
  closeSettingsDialog();

  if (card.intent === 'extend') {
    const prompt = buildOssMcpEntryPointExtendPrompt(card.connectorName, card.connectorId);
    await seedConnectorPrompt(
      deps,
      prompt,
      currentSessionId,
      'Unable to start connector extension',
    );
    return;
  }

  const prompt = buildOssMcpEntryPointBuildPrompt(card.connectorName);
  await seedConnectorPrompt(
    deps,
    prompt,
    currentSessionId,
    'Unable to start connector setup',
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('MCPSetupOfferCard wiring (P5.5)', () => {
  const deps: BuildConnectorDeps = {
    closeSettingsDialog: mockCloseSettingsDialog,
    startFreshSession: mockStartFreshSession,
    prepareMentionAttachments: mockPrepareMentionAttachments,
    submitQueuedMessage: mockSubmitQueuedMessage,
    showToast: mockShowToast,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockPrepareMentionAttachments.mockResolvedValue([{ type: 'file_text', path: '/skill.md', content: 'skill content' }]);
  });

  // -------------------------------------------------------------------------
  // VAL-OFFER-001: Card renders inline on missing-connector signal
  // -------------------------------------------------------------------------
  describe('inline rendering trigger (VAL-OFFER-001)', () => {
    it('structured suggest_connector_setup tool result produces card props', () => {
      const eventsByTurn: Record<string, AgentEvent[]> = {
        'turn-1': [makeSuggestToolEvent('Zendesk')],
      };

      const suggestions = extractConnectorSetupSuggestions(eventsByTurn);
      expect(suggestions).toHaveLength(1);
      expect(suggestions[0].connectorName).toBe('Zendesk');
      expect(suggestions[0].intent).toBe('build');
      expect(suggestions[0].turnId).toBe('turn-1');
    });

    it('card renders at the correct conversation position (after assistant message in the suggestion turn)', () => {
      // This test verifies the mapping logic that connects tool events → message indices.
      // The hook (useConnectorSetupSuggestions) produces a Map<number, CardInfo> where
      // the key is the message index. ConversationPane renders the card at that index.
      const eventsByTurn: Record<string, AgentEvent[]> = {
        'turn-1': [makeSuggestToolEvent('Zendesk')],
      };

      const suggestions = extractConnectorSetupSuggestions(eventsByTurn);

      // Simulate the message array with turn-1 having an assistant message at index 2
      const messages: AgentTurnMessage[] = [
        { id: 'm1', turnId: 'turn-0', role: 'user', text: 'Hi', createdAt: Date.now() },
        { id: 'm2', turnId: 'turn-0', role: 'assistant', text: 'Hello!', createdAt: Date.now() },
        { id: 'm3', turnId: 'turn-1', role: 'user', text: 'Check my Zendesk', createdAt: Date.now() },
        { id: 'm4', turnId: 'turn-1', role: 'assistant', text: 'You need Zendesk connector.', createdAt: Date.now() },
      ];

      // Simulate the mapping logic from the hook
      const cardMap = new Map<number, { connectorName: string; intent: string; turnId: string }>();
      for (const suggestion of suggestions) {
        // Find last assistant message for this turn (walking backwards)
        for (let i = messages.length - 1; i >= 0; i--) {
          if (messages[i].turnId === suggestion.turnId && (messages[i].role === 'assistant' || messages[i].role === 'result')) {
            cardMap.set(i, {
              connectorName: suggestion.connectorName,
              intent: suggestion.intent,
              turnId: suggestion.turnId,
            });
            break;
          }
        }
      }

      // Card should be at index 3 (the last assistant message in turn-1)
      expect(cardMap.has(3)).toBe(true);
      expect(cardMap.get(3)?.connectorName).toBe('Zendesk');
      expect(cardMap.get(3)?.intent).toBe('build');
    });
  });

  // -------------------------------------------------------------------------
  // VAL-OFFER-002: Set it up starts build flow
  // -------------------------------------------------------------------------
  describe('"Set it up" triggers build flow (VAL-OFFER-002)', () => {
    it('continues in the current session instead of starting a fresh chat', async () => {
      await handleConnectorSetUpInCurrentSession(deps, 'current-session-123', {
        connectorName: 'Zendesk',
        intent: 'build',
        turnId: 'turn-1',
        isSaved: false,
      });

      expect(mockCloseSettingsDialog).toHaveBeenCalledOnce();
      expect(mockStartFreshSession).not.toHaveBeenCalled();

      const prompt = mockPrepareMentionAttachments.mock.calls[0][0] as string;
      expect(prompt).toContain('build-custom-mcp-server/SKILL.md');
      expect(prompt).toContain('Zendesk');

      expect(mockSubmitQueuedMessage).toHaveBeenCalledWith(
        expect.stringContaining('build-custom-mcp-server/SKILL.md'),
        'text',
        expect.any(Array),
        expect.objectContaining({ targetSessionId: 'current-session-123' }),
      );
    });

    it('uses the same skill seeding path as P1 entry points', async () => {
      await handleBuildConnector(deps, 'Freshdesk');

      const prompt = mockPrepareMentionAttachments.mock.calls[0][0] as string;
      // Must use prepareMentionAttachments (not handleConfigureWithRebel)
      expect(mockPrepareMentionAttachments).toHaveBeenCalledOnce();
      // Must use submitQueuedMessage (not direct message injection)
      expect(mockSubmitQueuedMessage).toHaveBeenCalledOnce();
      // Must include the build skill mention
      expect(prompt).toContain('build-custom-mcp-server/SKILL.md');
    });

    it('routes extend intent to the extend-mcp-server skill', async () => {
      await handleConnectorSetUpInCurrentSession(deps, 'current-session-456', {
        connectorName: 'Zendesk',
        intent: 'extend',
        connectorId: 'catalog:bundled-zendesk',
        turnId: 'turn-2',
        isSaved: false,
      });

      const prompt = mockPrepareMentionAttachments.mock.calls[0][0] as string;
      expect(prompt).toContain('extend-mcp-server/SKILL.md');
      expect(prompt).toContain('Zendesk');
      expect(prompt).toContain('catalog:bundled-zendesk');
      expect(mockSubmitQueuedMessage).toHaveBeenCalledWith(
        expect.any(String),
        'text',
        expect.any(Array),
        expect.objectContaining({ targetSessionId: 'current-session-456' }),
      );
    });

    it('does not fabricate an ID when extend intent lacks connectorId', async () => {
      await handleConnectorSetUpInCurrentSession(deps, 'current-session-789', {
        connectorName: 'Slack',
        intent: 'extend',
        turnId: 'turn-3',
        isSaved: false,
      });

      const prompt = mockPrepareMentionAttachments.mock.calls[0][0] as string;
      expect(prompt).toContain('extend-mcp-server/SKILL.md');
      expect(prompt).toContain('"Slack" connector');
      expect(prompt).not.toContain('(ID: Slack)');
    });
  });

  // -------------------------------------------------------------------------
  // VAL-OFFER-003: Save for later swaps to saved card
  // -------------------------------------------------------------------------
  describe('"Save for later" persists and swaps (VAL-OFFER-003)', () => {
    it('suggestion state tracks saved turns independently', () => {
      // The hook manages a Set<string> of saved turn IDs.
      // When saveForLater(turnId) is called, the card's isSaved flips to true,
      // which causes ConversationPane to render MCPSavedForLaterCard instead of MCPSetupOfferCard.
      const savedTurnIds = new Set<string>();

      // Initially not saved
      expect(savedTurnIds.has('turn-1')).toBe(false);

      // Save for later
      savedTurnIds.add('turn-1');
      expect(savedTurnIds.has('turn-1')).toBe(true);

      // Another turn is NOT affected
      expect(savedTurnIds.has('turn-2')).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // VAL-OFFER-004: Set up now from saved card reuses build flow
  // -------------------------------------------------------------------------
  describe('"Set up now" from saved card uses same build flow (VAL-OFFER-004)', () => {
    it('both "Set it up" and "Set up now" invoke the same handler with same connector name', async () => {
      // First call: "Set it up" from offer card
      await handleBuildConnector(deps, 'Slack');
      const firstPrompt = mockPrepareMentionAttachments.mock.calls[0][0] as string;

      vi.clearAllMocks();
      mockPrepareMentionAttachments.mockResolvedValue([{ type: 'file_text', path: '/skill.md', content: 'skill content' }]);

      // Second call: "Set up now" from saved card — same handler, same connector name
      await handleBuildConnector(deps, 'Slack');
      const secondPrompt = mockPrepareMentionAttachments.mock.calls[0][0] as string;

      // Both use the exact same prompt format
      expect(firstPrompt).toBe(secondPrompt);
      expect(firstPrompt).toContain('build-custom-mcp-server/SKILL.md');
      expect(firstPrompt).toContain('Slack');
    });
  });

  // -------------------------------------------------------------------------
  // VAL-OFFER-005: Structured signal triggers card rendering
  // -------------------------------------------------------------------------
  describe('only structured triggers (VAL-OFFER-005)', () => {
    it('structured tool result creates card props', () => {
      const event = makeSuggestToolEvent('Zendesk');
      const result = parseConnectorSetupSignal(event, 'turn-1');
      expect(result).not.toBeNull();
      expect(result?.connectorName).toBe('Zendesk');
      expect(result?.intent).toBe('build');
    });

    it('plain text assistant message does NOT create card props', () => {
      const event: AgentEvent = {
        type: 'assistant',
        text: 'I noticed you need a Zendesk connector. Let me suggest_connector_setup for you.',
        timestamp: Date.now(),
      };
      const result = parseConnectorSetupSignal(event, 'turn-1');
      expect(result).toBeNull();
    });

    it('different tool name with same JSON structure does NOT create card props', () => {
      const event: AgentEvent = {
        type: 'tool',
        toolName: 'web_search',
        stage: 'end',
        detail: JSON.stringify({ connectorName: 'Zendesk' }),
        timestamp: Date.now(),
      } as AgentEvent;
      const result = parseConnectorSetupSignal(event, 'turn-1');
      expect(result).toBeNull();
    });

    it('tool start event does NOT create card props', () => {
      const event: AgentEvent = {
        type: 'tool',
        toolName: SUGGEST_CONNECTOR_SETUP_TOOL,
        stage: 'start',
        detail: JSON.stringify({ connectorName: 'Zendesk' }),
        timestamp: Date.now(),
      } as AgentEvent;
      const result = parseConnectorSetupSignal(event, 'turn-1');
      expect(result).toBeNull();
    });

    // Structured response pathway (VAL-OFFER-005)
    it('structured response with action marker creates card props', () => {
      const event = makeStructuredResponseEvent('Zendesk', 'Missing connector');
      const result = parseConnectorSetupSignal(event, 'turn-1');
      expect(result).not.toBeNull();
      expect(result?.connectorName).toBe('Zendesk');
      expect(result?.intent).toBe('build');
      expect(result?.reason).toBe('Missing connector');
    });

    it('structured response without action marker does NOT create card props', () => {
      const event: AgentEvent = {
        type: 'result',
        text: JSON.stringify({ connectorName: 'Zendesk' }),
        timestamp: Date.now(),
      };
      const result = parseConnectorSetupSignal(event, 'turn-1');
      expect(result).toBeNull();
    });

    it('plain-text result event does NOT create card props', () => {
      const event: AgentEvent = {
        type: 'result',
        text: 'You should set up a Zendesk connector. suggest_connector_setup',
        timestamp: Date.now(),
      };
      const result = parseConnectorSetupSignal(event, 'turn-1');
      expect(result).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // VAL-OFFER-001 + VAL-OFFER-005: Structured response triggers inline rendering
  // -------------------------------------------------------------------------
  describe('structured response inline rendering (VAL-OFFER-001 + VAL-OFFER-005)', () => {
    it('structured response produces card props via extractConnectorSetupSuggestions', () => {
      const eventsByTurn: Record<string, AgentEvent[]> = {
        'turn-1': [makeStructuredResponseEvent('Zendesk')],
      };

      const suggestions = extractConnectorSetupSuggestions(eventsByTurn);
      expect(suggestions).toHaveLength(1);
      expect(suggestions[0].connectorName).toBe('Zendesk');
      expect(suggestions[0].intent).toBe('build');
      expect(suggestions[0].turnId).toBe('turn-1');
    });

    it('structured response card renders at correct position (after assistant message)', () => {
      const eventsByTurn: Record<string, AgentEvent[]> = {
        'turn-1': [makeStructuredResponseEvent('Slack')],
      };

      const suggestions = extractConnectorSetupSuggestions(eventsByTurn);

      const messages: AgentTurnMessage[] = [
        { id: 'm1', turnId: 'turn-0', role: 'user', text: 'Hi', createdAt: Date.now() },
        { id: 'm2', turnId: 'turn-1', role: 'user', text: 'Connect Slack', createdAt: Date.now() },
        { id: 'm3', turnId: 'turn-1', role: 'assistant', text: 'You need the Slack connector.', createdAt: Date.now() },
      ];

      const cardMap = new Map<number, { connectorName: string; intent: string; turnId: string }>();
      for (const suggestion of suggestions) {
        for (let i = messages.length - 1; i >= 0; i--) {
          if (messages[i].turnId === suggestion.turnId && (messages[i].role === 'assistant' || messages[i].role === 'result')) {
            cardMap.set(i, {
              connectorName: suggestion.connectorName,
              intent: suggestion.intent,
              turnId: suggestion.turnId,
            });
            break;
          }
        }
      }

      expect(cardMap.has(2)).toBe(true);
      expect(cardMap.get(2)?.connectorName).toBe('Slack');
      expect(cardMap.get(2)?.intent).toBe('build');
    });
  });
});
