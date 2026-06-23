/**
 * Hook to detect structured connector setup suggestions in conversation events
 * and manage their saved/unsaved state.
 *
 * Scans eventsByTurn for `suggest_connector_setup` tool results and returns
 * metadata for the latest unsaved footer prompt, plus message-anchored card
 * info that tests can use to verify recency selection.
 *
 * @see src/shared/utils/connectorSetupSignal.ts
 * @see docs/plans/260410_oss_mcp_integration_forward_plan.md (P5.5)
 */

import { useMemo, useState, useCallback } from 'react';
import type { AgentEvent, AgentTurnMessage, UserQuestionBatch } from '@shared/types';
import {
  buildConnectorSetupKey,
  extractConnectorSetupSuggestions,
  type ConnectorSetupIntent,
  type ConnectorSetupSuggestion,
} from '@shared/utils/connectorSetupSignal';
import { useConnectorSetupAnsweredStore } from '../store/connectorSetupAnsweredStore';

/** Per-message rendering info for setup offer / saved-for-later cards. */
export interface ConnectorSetupCardInfo {
  /** The connector name to display. */
  connectorName: string;
  /** Whether this card should start a build flow or extend flow. */
  intent: ConnectorSetupIntent;
  /** The turn ID where the suggestion was made. */
  turnId: string;
  /** Optional connector identifier for extend flows when known. */
  connectorId?: string;
  /** Whether the user has saved this suggestion for later. */
  isSaved: boolean;
}

/**
 * Detects connector setup suggestions from structured tool events and manages
 * the saved/unsaved state for each suggestion.
 *
 * Returns a Map from message index → ConnectorSetupCardInfo and identifies the
 * latest unsaved suggestion so SessionSurfaceContent can reuse the existing
 * InteractionStrip composer override lane.
 */
export function selectLatestPendingConnectorSetupCard(
  cardByMessageIndex: ReadonlyMap<number, ConnectorSetupCardInfo>,
): ConnectorSetupCardInfo | null {
  let latestIndex = -1;
  let latestCard: ConnectorSetupCardInfo | null = null;

  for (const [messageIndex, card] of cardByMessageIndex.entries()) {
    if (card.isSaved || messageIndex < latestIndex) {
      continue;
    }
    latestIndex = messageIndex;
    latestCard = card;
  }

  return latestCard;
}

export function buildConnectorSetupQuestionBatch(
  card: ConnectorSetupCardInfo,
  sessionId: string,
): UserQuestionBatch {
  const isExtend = card.intent === 'extend';

  return {
    batchId: `connector-setup:${card.turnId}`,
    toolUseId: `connector-setup:${card.turnId}`,
    turnId: card.turnId,
    sessionId,
    timestamp: Number.MAX_SAFE_INTEGER,
    questions: [
      {
        id: 'connector-setup-question',
        header: isExtend ? 'Add more to your tool' : 'Make a new tool',
        question: isExtend
          ? `Want us to add more to your ${card.connectorName} tool?`
          : `Want us to make a ${card.connectorName} tool together?`,
        context: isExtend
          ? `We can start adding those pieces now, or save the idea for later.`
          : `We can start putting this together now, or save the idea for later.`,
        multiSelect: false,
        options: [
          {
            id: 'set-up-now',
            label: isExtend
              ? 'Add them with me'
              : 'Start making it',
            description: isExtend
              ? `We'll open a guided conversation and start adding them.`
              : `We'll open a guided conversation and start putting it together.`,
          },
          {
            id: 'save-for-later',
            label: 'Save for later',
            description: 'Keep this idea around and come back to it later.',
          },
        ],
      },
    ],
  };
}

/**
 * Footer-question suppression follow-on (260427).
 *
 * When the agent independently starts a build flow (writing a planning
 * doc, scaffolding tools) the original `suggest_connector_setup` footer
 * card has no auto-dismissal hook for the planning + early-build phases —
 * the card can't tell that the build is already underway. This callback
 * lets the caller declare a fourth suppression input alongside
 * `savedTurnIds`, the answered registry, and the pending registry: if a
 * contribution exists in this session for the same connector name (any
 * status — draft/testing/ready_to_submit/submitted/archived all suppress)
 * the card is treated as already saved.
 *
 * Matching is case-insensitive and whitespace-trimmed (mirrors
 * `buildConnectorSetupKey` normalization in `connectorSetupSignal.ts`).
 *
 * @see docs/plans/260427_contribution_flow_followon_self_block_at_registration.md
 */
export type HasContributionForConnectorFn = (connectorName: string) => boolean;

const NO_CONTRIBUTION_FOR_CONNECTOR: HasContributionForConnectorFn = () => false;

export function useConnectorSetupSuggestions(
  eventsByTurn: Record<string, AgentEvent[]>,
  visibleMessages: AgentTurnMessage[],
  resolveTurnIdForMessage: (message: AgentTurnMessage) => string | null,
  sessionId: string,
  /**
   * Optional fourth suppression input — see `HasContributionForConnectorFn`.
   * Defaults to a permanent `false` so existing callers (and the test
   * suite) don't need to opt in until they're ready.
   */
  hasContributionForConnector: HasContributionForConnectorFn = NO_CONTRIBUTION_FOR_CONNECTOR,
): {
  /** Map from message index to card info for deterministic latest-card selection. */
  cardByMessageIndex: Map<number, ConnectorSetupCardInfo>;
  /** Latest unsaved suggestion shown in the footer override lane. */
  pendingFooterCard: ConnectorSetupCardInfo | null;
  /** Marks a suggestion as saved for later (legacy turn-keyed path; still used for belt-and-suspenders). */
  saveForLater: (turnId: string) => void;
  /** Set of turn IDs currently saved for later. */
  savedTurnIds: ReadonlySet<string>;
  /**
   * Marks a stable connector key as fully answered for this session.
   * Survives component unmount/remount and cross-turn re-emission.
   * @see docs-private/investigations/260416_duplicate_connector_setup_card.md
   */
  markAnswered: (key: string) => void;
  /** Marks a key as mid-flight (set-up-now enqueue in progress). Suppresses the card. */
  markPending: (key: string) => void;
  /** Releases a pending suppression after enqueue failure so the card re-appears for retry. */
  clearPending: (key: string) => void;
} {
  // Track which suggestions the user has saved for later (by turnId)
  const [savedTurnIds, setSavedTurnIds] = useState<Set<string>>(new Set());

  // Subscribe to the session-scoped answered registry.
  // We subscribe to the outer Maps (not the boolean predicate) so we get a new
  // reference — and therefore a re-render — whenever a write happens. The
  // per-suggestion predicate is evaluated inside the memo below.
  const answeredMap = useConnectorSetupAnsweredStore((s) => s.answered);
  const pendingMap = useConnectorSetupAnsweredStore((s) => s.pending);
  const markAnsweredRaw = useConnectorSetupAnsweredStore((s) => s.markAnswered);
  const markPendingRaw = useConnectorSetupAnsweredStore((s) => s.markPending);
  const clearPendingRaw = useConnectorSetupAnsweredStore((s) => s.clearPending);

  const markAnswered = useCallback(
    (key: string) => markAnsweredRaw(sessionId, key),
    [markAnsweredRaw, sessionId],
  );
  const markPending = useCallback(
    (key: string) => markPendingRaw(sessionId, key),
    [markPendingRaw, sessionId],
  );
  const clearPending = useCallback(
    (key: string) => clearPendingRaw(sessionId, key),
    [clearPendingRaw, sessionId],
  );

  const saveForLater = useCallback((turnId: string) => {
    setSavedTurnIds((prev) => {
      const next = new Set(prev);
      next.add(turnId);
      return next;
    });
  }, []);

  // Extract suggestions from structured tool events
  const suggestions = useMemo(
    () => extractConnectorSetupSuggestions(eventsByTurn),
    [eventsByTurn],
  );

  // Build a map of message indices that should show a setup card.
  // For each suggestion, find the LAST assistant/result message whose turn
  // matches the suggestion's turnId — the card renders after that message.
  const cardByMessageIndex = useMemo(() => {
    const map = new Map<number, ConnectorSetupCardInfo>();
    if (suggestions.length === 0) return map;

    const suggestionByTurnId = new Map<string, ConnectorSetupSuggestion>();
    for (const s of suggestions) {
      suggestionByTurnId.set(s.turnId, s);
    }

    const answeredKeys = answeredMap.get(sessionId);
    const pendingKeys = pendingMap.get(sessionId);

    const remainingTurns = new Set(suggestionByTurnId.keys());
    for (let i = visibleMessages.length - 1; i >= 0; i--) {
      if (remainingTurns.size === 0) break;

      const msg = visibleMessages[i];
      if (msg.role !== 'assistant' && msg.role !== 'result') continue;

      const turnId = resolveTurnIdForMessage(msg);
      if (!turnId || !remainingTurns.has(turnId)) continue;

      const suggestion = suggestionByTurnId.get(turnId);
      if (!suggestion) continue;

      const key = buildConnectorSetupKey({
        intent: suggestion.intent,
        connectorId: suggestion.connectorId,
        connectorName: suggestion.connectorName,
      });
      const isSuppressedByRegistry =
        (answeredKeys?.has(key) ?? false) || (pendingKeys?.has(key) ?? false);
      // Footer-question suppression follow-on (260427). If a contribution
      // exists for this connector in the current session — regardless of
      // status — treat the card as already saved. Closes the visual
      // inconsistency where the "Want Rebel to build the X connector for
      // you?" card persisted alongside an active planning + early-build
      // flow when the agent independently kicked off the build.
      const isSuppressedByContribution = hasContributionForConnector(suggestion.connectorName);

      map.set(i, {
        connectorName: suggestion.connectorName,
        intent: suggestion.intent,
        turnId: suggestion.turnId,
        ...(suggestion.connectorId ? { connectorId: suggestion.connectorId } : {}),
        isSaved:
          savedTurnIds.has(suggestion.turnId)
          || isSuppressedByRegistry
          || isSuppressedByContribution,
      });
      remainingTurns.delete(turnId);
    }

    return map;
  }, [
    suggestions,
    visibleMessages,
    resolveTurnIdForMessage,
    savedTurnIds,
    answeredMap,
    pendingMap,
    sessionId,
    hasContributionForConnector,
  ]);

  const pendingFooterCard = useMemo(
    () => selectLatestPendingConnectorSetupCard(cardByMessageIndex),
    [cardByMessageIndex],
  );

  return {
    cardByMessageIndex,
    pendingFooterCard,
    saveForLater,
    savedTurnIds,
    markAnswered,
    markPending,
    clearPending,
  };
}
