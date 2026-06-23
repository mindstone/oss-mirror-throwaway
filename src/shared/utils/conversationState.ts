import type { AgentEvent, AgentTurnMessage, TurnEndReason } from '@shared/types';
import { createId } from './id';
import { formatUsage } from './usageFormatters';
import { isAssistantProcessNarration } from './assistantNarration';
import { hashSessionIdForBreadcrumb } from './hashSessionIdForBreadcrumb';
import { assertNever } from './assertNever';

// C-lite (2026-04): state.activeTurnId is the processing turn (shared reducer contract).
// See docs/tutorials/260430_isbusy_dual_id_state_machine_and_c_lite_fix.html and
// docs/project/UI_CONVERSATIONS.md § Dual Turn ID Model.

/**
 * Brief quips shown when a turn did behind-the-scenes work but ended because
 * it needed user input (e.g. AskUserQuestion pause). Without these, the turn
 * is invisible — the activity card has no message to anchor to.
 *
 * Voice: dry, self-aware, brief. Matches Rebel brand voice.
 */
const QUESTION_PAUSE_QUIPS = [
  'Did some digging. Had a question.',
  'Reviewed the situation. Needed your take.',
  'Looked into it. One thing needed your call.',
  'Assessed the options. Your turn.',
  'Did the homework. Found a decision point.',
  'Processed everything. Had a follow-up for you.',
] as const;

/** Deterministic quip selection based on turnId hash (stable across re-renders). */
const pickQuestionPauseQuip = (turnId: string): string => {
  let hash = 0;
  for (let i = 0; i < turnId.length; i++) {
    hash = ((hash << 5) - hash + turnId.charCodeAt(i)) | 0;
  }
  return QUESTION_PAUSE_QUIPS[Math.abs(hash) % QUESTION_PAUSE_QUIPS.length];
};

type EmptyNoAnchorResultClassification =
  | { kind: 'drop' }
  | { kind: 'placeholder-quip' }
  | { kind: 'placeholder-anchor' };

const hasTurnUserQuestion = (turnEvents?: readonly AgentEvent[]): boolean =>
  turnEvents?.some(e => e.type === 'user_question') ?? false;

const hasAnchorableTurnActivity = (turnEvents?: readonly AgentEvent[]): boolean =>
  turnEvents?.some(e => e.type === 'tool' || e.type === 'status' || e.type === 'assistant') ?? false;

const classifyEmptyNoAnchorResult = (
  event: Extract<AgentEvent, { type: 'result' }>,
  turnEvents?: readonly AgentEvent[]
): EmptyNoAnchorResultClassification => {
  if (hasTurnUserQuestion(turnEvents)) {
    return { kind: 'placeholder-quip' };
  }

  const turnEndReason: TurnEndReason | undefined = event.turnEndReason;
  if (turnEndReason === undefined) {
    return { kind: 'drop' };
  }

  switch (turnEndReason) {
    case 'awaiting_user':
      return { kind: 'placeholder-quip' };
    case 'superseded':
      return ('isSynthetic' in event && event.isSynthetic === true) && hasAnchorableTurnActivity(turnEvents)
        ? { kind: 'placeholder-anchor' }
        : { kind: 'drop' };
    case 'completed':
    case 'user_stopped':
    case 'error':
      return { kind: 'drop' };
    default:
      // Type-level assurance: a new TurnEndReason must choose drop/quip/anchor here.
      return assertNever(turnEndReason, 'TurnEndReason');
  }
};

/** Maximum number of terminated turn IDs to track. Prevents unbounded Set growth
 *  during long sessions while being generous enough for concurrent turn scenarios. */
const MAX_TERMINATED_TURN_IDS = 50;

export const cloneAgentTurnMessages = (messages: AgentTurnMessage[]): AgentTurnMessage[] =>
  messages.map((message) => ({ ...message }));

export const conversationHasContent = (
  messages: AgentTurnMessage[],
  events: Record<string, AgentEvent[]>
): boolean => {
  if (messages.length > 0) return true;
  if (Object.keys(events).length > 0) return true;
  return Object.values(events).some((list) => list.length > 0);
};

export const getLastMessageTimestamp = (messageList: AgentTurnMessage[]): number | null => {
  if (messageList.length === 0) {
    return null;
  }
  const lastMessage = messageList[messageList.length - 1];
  return typeof lastMessage.createdAt === 'number' ? lastMessage.createdAt : null;
};

export const deriveInteractionTimestamp = (
  messageList: AgentTurnMessage[],
  fallback: number
): number => {
  const lastMessageTimestamp = getLastMessageTimestamp(messageList);
  return lastMessageTimestamp ?? fallback;
};

/**
 * Derive a session's `updatedAt` from its content timestamps.
 *
 * Returns the latest of: last message timestamp, draft timestamp, or
 * `createdAt`. This is the single source of truth for when a session
 * was last meaningfully modified — immune to clock-skew contamination
 * from cloud sync round-trips or stale `updatedAt` values.
 *
 * Used by cloud merge functions and self-healing on sync to prevent
 * the "old conversation jumps to top of sidebar" bug caused by a
 * previous server-side bug that overwrote `updatedAt` with `Date.now()`.
 */
export const deriveSessionUpdatedAt = (session: {
  messages?: { createdAt: number }[];
  createdAt?: number;
  draft?: { updatedAt?: number } | null;
  annotations?: { createdAt: number }[] | null;
  isBusy?: boolean;
  updatedAt?: number;
}): number => {
  const messages = session.messages ?? [];
  const lastMsgTs = messages.length > 0 ? messages[messages.length - 1].createdAt : 0;
  const draftTs = session.draft?.updatedAt ?? 0;
  const annotationTs = session.annotations?.length
    ? Math.max(...session.annotations.map((annotation) => annotation.createdAt))
    : 0;
  const baseTs = session.createdAt ?? 0;
  // For sessions with an active turn, preserve the existing updatedAt — the
  // turn is actively producing events and the current value is legitimate.
  if (session.isBusy && session.updatedAt) {
    return session.updatedAt;
  }
  return Math.max(lastMsgTs, draftTs, annotationTs, baseTs);
};

export type ConversationUpdateOptions = {
  /** When true, skip removing thinking-style assistant messages on tool-start events.
   *  Used for replay/flush paths where events are batched retroactively. */
  skipThinkingPrune?: boolean;
};

/** Pre-built options for replay/flush paths to avoid per-event object allocation. */
export const REPLAY_OPTIONS: ConversationUpdateOptions = { skipThinkingPrune: true } as const;

export type ConversationStateShape = {
  messages: AgentTurnMessage[];
  eventsByTurn: Record<string, AgentEvent[]>;
  activeTurnId: string | null;
  focusedTurnId: string | null;
  isBusy: boolean;
  lastError: string | null;
  /** Which process originated the last error — used to deduplicate Sentry captures */
  lastErrorSource: 'main' | 'renderer' | null;
  /** Set of turn IDs that have received error/result events. Prevents post-terminal
   *  self-heal from re-activating isBusy when late status/tool/assistant events arrive
   *  for turns that have already terminated. Bounded to MAX_TERMINATED_TURN_IDS entries
   *  to prevent unbounded growth during long sessions. */
  terminatedTurnIds: Set<string>;
};

/**
 * Anchor copy shown when a turn ended with a transient terminal error AND no
 * substantive prior text could be recovered for that turn. Surfaces the
 * dropped-connection state; the activity card directly above the message
 * carries the cause + step counter, so this anchor doesn't point anywhere.
 *
 * See docs/plans/260503_turn_error_trajectory_preservation.md and
 * docs/plans/260527_transient-error-ux-cleanup/PLAN.md (Stage 3).
 */
const TRANSIENT_ERROR_ANCHOR_TEXT =
  'The connection dropped before Rebel could wrap up.';

/**
 * Minimum trimmed length for an `assistant` message or event to count as
 * "substantive" trajectory worth preserving as a `result`-role anchor when a
 * turn ends with a transient error. Below this we treat the text as too thin
 * to ship and fall through to the next recovery tier.
 */
const TRANSIENT_RECOVERY_MIN_TEXT_LENGTH = 10;

/**
 * Conservative pre-tool-chatter narration matcher used by trajectory recovery
 * only. Deliberately narrower than `isAssistantProcessNarration` (which treats
 * any unstructured text under 300 chars as narration) — for recovery we want
 * to preserve genuine short answers like "Found three relevant patterns." and
 * only filter out obvious first-person process talk like "I'll check that for
 * you." that has no informational value once the connection has dropped.
 */
const OBVIOUS_RECOVERY_NARRATION_OPENERS =
  /^(?:let me\b|i['\u2019]?ll\b|i will\b|i['\u2019]?m going to\b|i need to\b|i['\u2019]?m about to\b|now i\b|good[.,!\s]|excellent\b|alright\b|okay\b|got it\b|sure\b|first[,]?\s+i\b)/i;

/** True when text is substantive enough to anchor a recovered turn result. */
const isSubstantiveAssistantText = (text: string): boolean => {
  const trimmed = text.trim();
  if (trimmed.length <= TRANSIENT_RECOVERY_MIN_TEXT_LENGTH) return false;
  if (OBVIOUS_RECOVERY_NARRATION_OPENERS.test(trimmed)) return false;
  return true;
};

/**
 * Detect if text is a leaked planning document (JSON with goal/assumptions/steps).
 * These are internal planner output that should never be shown to users.
 */
const isLeakedPlanningJson = (text: string): boolean => {
  const trimmed = text.trim();
  // Strip markdown code fences (```json ... ```)
  const stripped = trimmed.startsWith('```')
    ? trimmed.replace(/^```\w*\n?/, '').replace(/\n?```$/, '').trim()
    : trimmed;
  if (!stripped.startsWith('{')) return false;
  try {
    const parsed = JSON.parse(stripped);
    return (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof parsed.goal === 'string' &&
      Array.isArray(parsed.steps)
    );
  } catch {
    return false;
  }
};

export const mergeResultMessage = (
  messages: AgentTurnMessage[],
  turnId: string,
  event: Extract<AgentEvent, { type: 'result' }>,
  turnEvents?: readonly AgentEvent[]
): AgentTurnMessage[] => {
  // Safety net: suppress leaked planning JSON from becoming user-visible text.
  // The adapter should prevent this, but if planning output slips through,
  // treat it as empty so the existing assistant message (if any) takes precedence.
  const rawResultText = event.text.trim();
  const resultText = isLeakedPlanningJson(rawResultText) ? '' : rawResultText;
  const usageDetail = formatUsage(event) || undefined;

  // Find last non-user message for this turn (scan from end for efficiency)
  let matchIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const candidate = messages[index];
    if (candidate.turnId === turnId && candidate.role !== 'user') {
      matchIndex = index;
      break;
    }
  }

  if (matchIndex < 0) {
    // No existing message to promote - create new result if we have text
    if (resultText.length === 0) {
      // If this turn did meaningful work before ending, keep an anchor message
      // so its activity card remains visible in the conversation.
      const emptyNoAnchorResult = classifyEmptyNoAnchorResult(event, turnEvents);

      switch (emptyNoAnchorResult.kind) {
        case 'placeholder-quip':
          return [
            ...messages,
            {
              id: createId(),
              turnId,
              role: 'result',
              text: pickQuestionPauseQuip(turnId),
              usage: usageDetail,
              createdAt: event.timestamp
            }
          ];
        case 'placeholder-anchor':
          return [
            ...messages,
            {
              id: createId(),
              turnId,
              role: 'result',
              text: 'Interrupted before I could finish.',
              usage: usageDetail,
              createdAt: event.timestamp,
              endedWith: 'superseded',
            }
          ];
        case 'drop':
          return messages;
        default:
          return assertNever(emptyNoAnchorResult, 'EmptyNoAnchorResultClassification');
      }
    }
    return [
      ...messages,
      {
        id: createId(),
        turnId,
        role: 'result',
        text: resultText,
        usage: usageDetail,
        createdAt: event.timestamp
      }
    ];
  }

  const existing = messages[matchIndex];
  const existingText = existing.text.trim();

  // When the runtime returns no result text, check if existing assistant message is
  // internal process narration (reasoning/self-talk). If so, the turn produced
  // no user-visible output — remove the narration rather than promoting it.
  // NOTE: On user-stopped turns, the renderer commits streaming buffer as an
  // assistant message before the synthetic empty result arrives. Short unstructured
  // partial responses could theoretically be classified as narration here, but
  // isAssistantProcessNarration checks for narration-specific patterns (first-person
  // process statements, meta-reasoning), not just length — so substantive partial
  // content like "I found the file you mentioned" is preserved.
  //
  // EXCEPTION (FOX-3148): When the user explicitly pressed Stop, preserve the
  // narration message even if classified as process narration. The user wants to
  // see what was happening when they stopped the turn — silently erasing the last
  // "Let me check X..." is a clear UX regression. Keep the message as `assistant`
  // (not promoted to `result`) because the turn never produced a result.
  if (resultText.length === 0 && isAssistantProcessNarration(existingText)) {
    if (event.turnEndReason === 'user_stopped') {
      // Preserve narration — user stopped, they deserve to see what was happening.
      return messages;
    }
    if (existing.endedWith === 'transient_error') {
      // Preserve transient-error recovery anchors — the message was
      // intentionally promoted by `mergeErrorMessage` (often the minimal
      // anchor copy, which is by definition < 300 chars and unstructured).
      // A late empty result must not erase it.
      return messages;
    }
    return [
      ...messages.slice(0, matchIndex),
      ...messages.slice(matchIndex + 1)
    ];
  }

  const next = [...messages];

  // Determine final text with robust handling:
  // 1. Empty result: use existing aggregated content
  // 2. Result is superset of existing: use result (runtime returned full response)
  // 3. Result contains graceful degradation note: append only the note
  // 4. Default: use existing aggregated content (result is partial)
  let finalText = existing.text;

  if (resultText.length > 0) {
    if (resultText.includes(existingText) && resultText.length > existingText.length) {
      // Result is superset - runtime returned full response, use it
      finalText = resultText;
    } else if (resultText.includes('[Note:') && !existingText.includes('[Note:')) {
      // Graceful degradation note - append only the note portion
      const noteStart = resultText.indexOf('[Note:');
      finalText = existing.text + '\n\n' + resultText.slice(noteStart);
    }
    // Otherwise keep existing.text (aggregated content is the complete response)
  }

  // Out-of-order recovery: if we previously promoted to a transient-error
  // anchor (mergeErrorMessage tier 4) and a real result text now arrives for
  // the same turn, drop the anchor copy + clear the marker so the conversation
  // shows the actual model output.
  const supersedingTransientErrorRecovery =
    existing.endedWith === 'transient_error' && resultText.length > 0;
  if (supersedingTransientErrorRecovery) {
    finalText = resultText;
  }

  // Promote to result - KEEP existing ID (new ID causes React remounting)
  next[matchIndex] = {
    ...existing,
    role: 'result',
    text: finalText,
    usage: usageDetail ?? existing.usage,
    createdAt: event.timestamp,
    ...(supersedingTransientErrorRecovery ? { endedWith: undefined } : {}),
  };

  return next;
};

/**
 * Recover trajectory when a turn ends with a transient terminal error.
 *
 * Promotes whatever in-progress text we have for the turn to a `result`-role
 * message stamped with `endedWith: 'transient_error'`, so the conversation
 * stays coherent (subsequent turns can build on it) and the renderer can
 * surface a quiet "Connection dropped" status marker on that message.
 *
 * Four-tier fallback (in priority order):
 *   1. Existing `result`-role message for `turnId` → stamp `endedWith` and
 *      keep its text untouched (idempotent if already stamped).
 *   2. Existing substantive `assistant`-role message for `turnId` (passes
 *      `isSubstantiveAssistantText`) → promote to `result` and stamp.
 *   3. Substantive `assistant` event in `turnEvents` (most recent first) →
 *      create a new `result`-role message anchored on that text and stamp.
 *   4. No recoverable text → append a minimal anchor `result`-role message
 *      with `TRANSIENT_ERROR_ANCHOR_TEXT` and stamp.
 *
 * NOTE: `assistant_delta` events are NOT consulted — they are dropped at the
 * dispatcher (`agentEventDispatcher.ts`), the renderer hook
 * (`useAgentSessionEngine.ts`), and the policy manifest
 * (`agentEventPolicyManifest.ts`). Recovery uses the rolled-up `assistant`
 * events, which is what the dispatcher promotes to `eventsForTurn`.
 *
 * Related: docs/plans/260503_turn_error_trajectory_preservation.md.
 */
export const mergeErrorMessage = (
  messages: AgentTurnMessage[],
  turnId: string,
  event: Extract<AgentEvent, { type: 'error' }>,
  turnEvents: readonly AgentEvent[]
): AgentTurnMessage[] => {
  // Scan once for the most-recent result + assistant message for the turn.
  let resultIndex = -1;
  let assistantIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.turnId !== turnId) continue;
    if (m.role === 'result' && resultIndex < 0) {
      resultIndex = i;
      break;
    }
    if (m.role === 'assistant' && assistantIndex < 0) {
      assistantIndex = i;
    }
  }

  // Tier 1: existing result message — stamp marker (idempotent).
  if (resultIndex >= 0) {
    const existing = messages[resultIndex];
    if (existing.endedWith === 'transient_error') {
      return messages;
    }
    return [
      ...messages.slice(0, resultIndex),
      { ...existing, endedWith: 'transient_error' as const },
      ...messages.slice(resultIndex + 1),
    ];
  }

  // Tier 2: substantive assistant message — promote to result + stamp.
  if (assistantIndex >= 0) {
    const existing = messages[assistantIndex];
    if (isSubstantiveAssistantText(existing.text)) {
      return [
        ...messages.slice(0, assistantIndex),
        {
          ...existing,
          role: 'result' as const,
          endedWith: 'transient_error' as const,
          createdAt: event.timestamp,
        },
        ...messages.slice(assistantIndex + 1),
      ];
    }
  }

  // Tier 3: substantive assistant event in eventsForTurn — anchor new result.
  for (let i = turnEvents.length - 1; i >= 0; i--) {
    const e = turnEvents[i];
    if (e.type !== 'assistant') continue;
    if (!isSubstantiveAssistantText(e.text)) continue;
    return [
      ...messages,
      {
        id: createId(),
        turnId,
        role: 'result',
        text: e.text.trim(),
        endedWith: 'transient_error',
        createdAt: event.timestamp,
      },
    ];
  }

  // Tier 4: no recoverable text — minimal anchor.
  return [
    ...messages,
    {
      id: createId(),
      turnId,
      role: 'result',
      text: TRANSIENT_ERROR_ANCHOR_TEXT,
      endedWith: 'transient_error',
      createdAt: event.timestamp,
    },
  ];
};

export const updateConversationWithEvent = (
  state: ConversationStateShape,
  turnId: string,
  event: AgentEvent,
  options: ConversationUpdateOptions = {}
): ConversationStateShape => {
  const eventsForTurn = state.eventsByTurn[turnId] ?? [];
  const nextEventsByTurn = {
    ...state.eventsByTurn,
    [turnId]: [...eventsForTurn, event]
  };

  let nextMessages = state.messages;
  let nextIsBusy = state.isBusy;
  let nextActiveTurnId = state.activeTurnId;
  let nextError = state.lastError;
  let nextErrorSource = state.lastErrorSource;

  // Terminal guard: prevent post-terminal self-heal from re-activating isBusy.
  // When error/result already fired for this turn, late status/tool/assistant events
  // must NOT flip isBusy back to true. Two detection strategies:
  // 1. O(1) Set lookup: terminatedTurnIds (works on live path where eventsByTurn is {})
  // 2. Event history scan: eventsForTurn (works on history/replay path where eventsByTurn is populated)
  const turnAlreadyTerminated = state.terminatedTurnIds.has(turnId)
    || eventsForTurn.some(e => e.type === 'result' || e.type === 'error');
  let nextTerminatedTurnIds = state.terminatedTurnIds;

  if (event.type === 'assistant') {
    const text = event.text.trim();
    if (text.length > 0) {
      // Check if result already exists for this turn (guard against late/out-of-order events)
      // Scan from END for O(1) typical case (active turn is last)
      let resultIndex = -1;
      let existingAssistantIndex = -1;
      for (let i = state.messages.length - 1; i >= 0; i--) {
        const m = state.messages[i];
        if (m.turnId === turnId) {
          if (m.role === 'result' && resultIndex < 0) {
            resultIndex = i;
            break; // Result exists, no need to find assistant
          }
          if (m.role === 'assistant' && existingAssistantIndex < 0) {
            existingAssistantIndex = i;
          }
        }
      }

      if (resultIndex >= 0) {
        // Late assistant after result. A surviving duplicate event here used
        // to silently double the user-visible text (see
        // docs-private/investigations/260513_duplicate_result_text_in_message_bubble.md).
        // Exact-equality guard: if the late assistant is byte-identical to
        // the result text, treat it as the upstream-dedup miss it is and
        // leave the message unmodified. Genuine new late content (extremely
        // rare under the Anthropic protocol) still appends.
        // Do NOT set isBusy (turn is already complete).
        const existing = state.messages[resultIndex];
        const isExactDuplicate = text.trim() === existing.text.trim();
        console.warn(
          '[conversationState] Late assistant event after result',
          {
            turnIdHash: hashSessionIdForBreadcrumb(turnId),
            existingTextLength: existing.text.length,
            incomingTextLength: text.length,
            isExactDuplicate,
          },
        );
        if (!isExactDuplicate) {
          nextMessages = [
            ...state.messages.slice(0, resultIndex),
            { ...existing, text: existing.text + '\n\n' + text },
            ...state.messages.slice(resultIndex + 1)
          ];
        }
      } else if (existingAssistantIndex >= 0) {
        // AGGREGATE: append to existing assistant
        const existing = state.messages[existingAssistantIndex];
        nextMessages = [
          ...state.messages.slice(0, existingAssistantIndex),
          { ...existing, text: existing.text + '\n\n' + text, createdAt: event.timestamp },
          ...state.messages.slice(existingAssistantIndex + 1)
        ];
        if (!turnAlreadyTerminated) nextIsBusy = true;
      } else {
        // First assistant for this turn - create new
        nextMessages = [
          ...state.messages,
          {
            id: createId(),
            turnId,
            role: 'assistant',
            text,
            createdAt: event.timestamp
          }
        ];
        if (!turnAlreadyTerminated) nextIsBusy = true;
      }
    } else {
      // Empty text - still mark busy but don't create message
      if (!turnAlreadyTerminated) nextIsBusy = true;
    }
  } else if (event.type === 'tool' && 'stage' in event && event.stage === 'start') {
    // Self-heal: if isBusy is incorrectly false but a tool is starting for this turn,
    // the turn is clearly still active. This fixes state desync caused by the persisted
    // activeTurnId pointing to a completed "focus" turn rather than the processing turn.
    // Skip for turns that already terminated (error/result already processed).
    if (!nextIsBusy && !turnAlreadyTerminated) {
      nextIsBusy = true;
      nextActiveTurnId = turnId;
    }

    // On tool start, check if current assistant message is "thinking-style"
    // If so, remove it to prevent pre-tool chatter from appearing in final message
    if (!options.skipThinkingPrune) {
      let existingAssistantIndex = -1;
      for (let i = state.messages.length - 1; i >= 0; i--) {
        const m = state.messages[i];
        if (m.turnId === turnId && m.role === 'assistant') {
          existingAssistantIndex = i;
          break;
        }
      }

      if (existingAssistantIndex >= 0) {
        const existing = state.messages[existingAssistantIndex];
        if (isAssistantProcessNarration(existing.text)) {
          // Remove the thinking-style message
          nextMessages = [
            ...state.messages.slice(0, existingAssistantIndex),
            ...state.messages.slice(existingAssistantIndex + 1)
          ];
        }
        // If substantive, keep it (nextMessages unchanged)
      }
    }
  } else if (event.type === 'status') {
    // Self-heal: if isBusy is incorrectly false but we're receiving status events
    // for this turn, the turn is still active.
    // Skip for turns that already terminated (error/result already processed).
    if (!nextIsBusy && !turnAlreadyTerminated) {
      nextIsBusy = true;
      nextActiveTurnId = turnId;
    }
  } else if (event.type === 'result') {
    nextMessages = mergeResultMessage(state.messages, turnId, event, eventsForTurn);
    // C-lite invariant: `activeTurnId` is processing-only for this shared reducer.
    // Renderer focus lives in `state.focusedTurnId` and must not influence terminal clears.
    // Context: docs-private/postmortems/260414_user_question_continuation_stall_recurring_postmortem.md
    // Only clear busy state if this result is for the currently active turn.
    // A late result from a previous turn (e.g., deny-and-retry AskUserQuestion)
    // must NOT clear busy state or error from a newer turn. The activeTurnId===null
    // case (session idle) is handled by the isBusy/error already being in their
    // correct terminal state from the turn that set them.
    if (state.activeTurnId === turnId) {
      nextIsBusy = false;
      nextActiveTurnId = null;
      nextError = null;
      nextErrorSource = null;
    }
    nextTerminatedTurnIds = new Set(state.terminatedTurnIds);
    nextTerminatedTurnIds.add(turnId);
    if (nextTerminatedTurnIds.size > MAX_TERMINATED_TURN_IDS) {
      const oldest = nextTerminatedTurnIds.values().next().value;
      if (oldest !== undefined) nextTerminatedTurnIds.delete(oldest);
    }
  } else if (event.type === 'error') {
    // Two cases where we update lastError:
    //  1. Standard: turn is the currently active one — first terminal event.
    //  2. Classified-supersede: this turn has already been terminated by an
    //     earlier (unclassified) error event, and the incoming event carries
    //     a structural `errorKind`. The main process can fan out two error
    //     events for the same upstream failure — first the runtime-result
    //     error path (agentMessageHandler) emits the raw inner message
    //     ("Provider returned error" for OpenRouter 429s, no errorKind), then
    //     the SDK throw path lands in turnErrorRecovery (handleRateLimitFallback
    //     etc.) and dispatches the properly-classified copy ~16ms later.
    //     Without case 2 the renderer stays stuck on the raw upstream string.
    //
    // Strict guards on the supersede (each protects a different regression):
    //  - `event.errorKind !== undefined` — only allow upgrades; an unclassified
    //    follow-on must never downgrade a classified prior.
    //  - `state.lastError !== null` — supersede is strictly an "upgrade in
    //    place" operation. Prevents resurrection of a cleared error after a
    //    newer turn has run cleanly (which clears lastError to null).
    //  - `Array.from(terminatedTurnIds).at(-1) === turnId` — cross-turn
    //    safety. Only the most-recently-terminated turn can supersede. JS Set
    //    preserves insertion order, so the last-inserted entry is the
    //    most-recently-terminated turn (and remains so after FIFO eviction
    //    above MAX_TERMINATED_TURN_IDS, since eviction removes from the
    //    front). This rejects "Turn A late classified follow-on after Turn B
    //    has already terminated."
    //
    // We deliberately do NOT supersede on the rehydrated-from-disk path
    // (terminatedTurnIds.size === 0 because the field is stripped by
    // incrementalSessionStore on save/load). The persistence layer already
    // captures the final lastError directly; the supersede only matters for
    // the live IPC path where two error events arrive ~16ms apart in the
    // same process.
    // C-lite invariant (same as result branch): `activeTurnId` is processing-only.
    // Focus is renderer-only (`state.focusedTurnId`) and never used for terminal guards.
    // Context: docs-private/postmortems/260414_user_question_continuation_stall_recurring_postmortem.md
    const turnIsActive = state.activeTurnId === turnId;
    const isMostRecentlyTerminated =
      state.terminatedTurnIds.size > 0
      && Array.from(state.terminatedTurnIds).at(-1) === turnId;
    const isFollowOnClassifiedError =
      !turnIsActive
      && isMostRecentlyTerminated
      && event.errorKind !== undefined
      && state.lastError !== null;
    if (turnIsActive || isFollowOnClassifiedError) {
      nextIsBusy = false;
      nextActiveTurnId = null;
      nextError = event.error;
      nextErrorSource = event.errorSource ?? null;
    }
    // Trajectory preservation: when a turn ends in a transient terminal
    // error, promote whatever in-progress text we have to a `result`-role
    // message stamped with `endedWith: 'transient_error'`. The renderer
    // surfaces a quiet "Connection dropped" status marker so the user sees
    // the work that was completed before the connection dropped, and
    // subsequent turns can continue from coherent state.
    //
    // Runs on BOTH terminal branches for the turn:
    //  - `turnIsActive` — the standard single-emit happy path (one transient
    //    error arrives while the turn is active).
    //  - `isFollowOnClassifiedError` — the production dual-emit ordering. The
    //    main process fans out two error events: a generic, unclassified one
    //    (no `isTransient`) that terminates the turn, then ~36ms later the
    //    typed/transient copy that arrives after the turn is already inactive
    //    and takes the supersede branch. Without stamping here, the generic
    //    event skips the stamp (no `isTransient`) and the typed event used to
    //    skip it too (this branch deliberately didn't promote) — so
    //    `endedWith: 'transient_error'` never landed for the dual-emit ordering
    //    (F3). The typed copy carries the authoritative `isTransient: true`, so
    //    stamping it here repairs the trajectory exactly where the
    //    classification arrives. `mergeErrorMessage` is idempotent on Tier 1, so
    //    re-running it on a turn that was already stamped is a no-op; the only
    //    added cost on the supersede branch is one assistant-event scan, paid
    //    once per transient dual-emit.
    //
    // Non-transient classified follow-ons (auth/billing/invalid_request) still
    // upgrade `lastError` in place above but do NOT stamp (guarded by
    // `event.isTransient === true`), preserving their behaviour.
    //
    // Related: docs/plans/260503_turn_error_trajectory_preservation.md;
    //   docs/plans/260528_terminal-state-presentation-health/PLAN.md (Stage 1 / F3).
    if (
      (turnIsActive || isFollowOnClassifiedError)
      && event.isTransient === true
    ) {
      nextMessages = mergeErrorMessage(nextMessages, turnId, event, eventsForTurn);
    }
    nextTerminatedTurnIds = new Set(state.terminatedTurnIds);
    nextTerminatedTurnIds.add(turnId);
    if (nextTerminatedTurnIds.size > MAX_TERMINATED_TURN_IDS) {
      const oldest = nextTerminatedTurnIds.values().next().value;
      if (oldest !== undefined) nextTerminatedTurnIds.delete(oldest);
    }
  } else if (event.type === 'warning') {
    // Non-blocking inline warning — uses synthetic turnId (receipt pattern)
    // to avoid message merging, thinking pruning, and visibility filter issues.
    // Deduplicate: skip if the immediately preceding message is the same warning.
    const lastMessage = state.messages[state.messages.length - 1];
    if (lastMessage?.isWarning && lastMessage.text === event.message) {
      // Duplicate warning — skip
    } else {
      nextMessages = [
        ...state.messages,
        {
          id: createId(),
          turnId: createId(),  // Synthetic — detached from active turn
          role: 'assistant' as const,
          text: event.message,
          isWarning: true,
          createdAt: event.timestamp,
        },
      ];
    }
    // Do NOT set isBusy — turn continues normally
  } else if (event.type === 'user_message') {
    // User message injected from main process (e.g., proactive coaching checks)
    nextMessages = [
      ...state.messages,
      {
        id: createId(),
        turnId,
        role: 'user',
        text: event.text,
        createdAt: event.timestamp,
        isHidden: event.isHidden
      }
    ];
    nextIsBusy = true;
    nextActiveTurnId = turnId;
  } else if (event.type === 'turn_started') {
    // Explicit turn lifecycle initialization. Respects terminal guard
    // to prevent late/stale turn_started from re-activating completed turns.
    if (!turnAlreadyTerminated) {
      nextIsBusy = true;
      nextActiveTurnId = turnId;
      nextError = null;
      nextErrorSource = null;
    }
  }

  return {
    messages: nextMessages,
    eventsByTurn: nextEventsByTurn,
    activeTurnId: nextActiveTurnId,
    focusedTurnId: state.focusedTurnId,
    isBusy: nextIsBusy,
    lastError: nextError,
    lastErrorSource: nextErrorSource,
    terminatedTurnIds: nextTerminatedTurnIds
  };
};
