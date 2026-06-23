/**
 * User Yield Detection — shared predicates for "is the agent yielding to the user?"
 *
 * Single source of truth consulted by:
 * - `rebelCoreQuery.runWithStopHooks` task-board continuation block (FOX-3097)
 * - `autoContinueHook.createAutoContinueHook` fast-path pattern checks
 *
 * Pure functions, no LLM calls, safe on the hot path. `hasUserQuestionPending`
 * in `agentTurnRegistry` remains the fast path for structured `AskUserQuestion`;
 * this module covers plain-text "ask and wait" skills that the structured tool
 * flag does not catch.
 *
 * Design constraint (FOX-3097 DA): the helper must require ALL of
 *   (a) the last assistant message looks like a legitimate question/handoff,
 *   (b) the assistant is not mid-task (no `TaskUpdate` fired this turn),
 *   (c) no lazy "next I'll …" continuation language,
 * before exempting the turn from forced continuation — so the completion-
 * verification safety net still catches "created tasks, walked away" turns.
 */

import type { AgentEvent } from '@shared/types';
import { sideEffectPatterns } from '@rebel/shared';
import { normalizeToSnakeCase } from '@core/services/safety/toolVerbs';

// =============================================================================
// Completion indicators (imported into autoContinueHook fast path)
// =============================================================================

/**
 * Strict completion indicators. Used in BOTH default and unleashed auto-continue
 * modes. These phrases unambiguously signal "turn finished, handed off to user."
 */
export const STRICT_COMPLETION_INDICATORS: readonly RegExp[] = [
  // Explicit completion words at start of message
  /^(done|complete|finished|all set)/i,
  // Explicit success statements
  /successfully\s+(added|created|completed|updated|written|saved|finished)/i,
  /I've\s+(added|created|updated|completed|finished|written|saved)/i,
  /I have\s+(added|created|updated|completed|finished|written|saved)/i,
  // Offer for follow-up (clear completion signal)
  /let me know if you (need|have|want) anything else/i,
  /is there anything else/i,
];

/**
 * Looser completion indicators. Used only in default auto-continue mode — in
 * unleashed mode these are ambiguous enough that we still want the LLM to
 * evaluate.
 */
export const LOOSE_COMPLETION_INDICATORS: readonly RegExp[] = [
  // Generic positive words at start (could be mid-task acknowledgment)
  /^(perfect|great|excellent|success)/i,
  // Markdown bold success patterns
  /\*\*.*(?:added|created|completed|done|success|finished).*successfully/i,
  /\*\*.*successfully.*(?:added|created|completed|done|finished)/i,
  // Delivery phrases (could be partial delivery)
  /here(?:'s| is) (?:the|your)/i,
  /above is (?:the|your)/i,
  /feel free to ask/i,
];

/**
 * True when the message matches a completion indicator. In unleashed mode only
 * the strict set applies.
 */
export function matchesCompletionIndicator(
  text: string,
  unleashedMode?: boolean,
): boolean {
  if (!text) return false;
  const patterns = unleashedMode
    ? STRICT_COMPLETION_INDICATORS
    : [...STRICT_COMPLETION_INDICATORS, ...LOOSE_COMPLETION_INDICATORS];
  return patterns.some((p) => p.test(text));
}

// =============================================================================
// Pending side-effect detection (moved here from autoContinueHook so both
// layers share the same definition). Re-exported from autoContinueHook for
// backward compatibility with the existing test file.
// =============================================================================

/**
 * Intent patterns that detect when the assistant is proposing a side-effect
 * action and asking for user confirmation before executing it.
 *
 * Each pattern matches a conversational lead-in followed by a side-effect verb.
 * Deliberately conservative — only well-known English phrasings are matched.
 */
const SIDE_EFFECT_INTENT_PATTERNS: readonly RegExp[] = [
  /want me to\s+(post|send|reply|submit|publish|create|delete|remove|forward|update)\b/i,
  /shall I\s+(post|send|reply|submit|publish|forward|delete|update)\b/i,
  /should I\s+(post|send|reply|submit|publish|forward|delete|create|remove|update)\b/i,
  /would you like me to\s+(post|send|reply|submit|publish|create|delete|remove|forward|update)\b/i,
  /do you want me to\s+(post|send|reply|submit|publish|create|delete|remove|forward|update)\b/i,
  /ready to\s+(post|send|reply|submit|publish)\b/i,
  /can I (?:go ahead and\s+)?(post|send|reply|submit|publish|create|delete|remove|forward|update)\b[\s\S]*\?/i,
  /let me\s+(post|send|reply|submit|publish|forward|delete|update)\b[\s\S]*\?/i,
  /I(?:'ll| will)\s+(post|send|reply|submit|publish|forward|delete|update)\b[\s\S]*\?/i,
];

/**
 * Detect when the assistant is asking for confirmation before executing
 * a side-effect action (e.g., "Want me to post this?").
 *
 * Returns true when:
 * 1. The message contains a question mark (confirmation request)
 * 2. The message matches a side-effect intent pattern (proposing action)
 * 3. No matching side-effect tool was actually called this turn
 *
 * This is a SAFETY check — it must fire even in unleashed mode.
 * Pure function: no service dependencies, trivially testable.
 */
export function detectPendingSideEffect(
  lastMessage: string,
  currentTurnEvents: AgentEvent[],
): boolean {
  if (!lastMessage.includes('?')) return false;

  const matchesIntent = SIDE_EFFECT_INTENT_PATTERNS.some((p) => p.test(lastMessage));
  if (!matchesIntent) return false;

  for (const event of currentTurnEvents) {
    if (event.type !== 'tool') continue;
    const toolEvent = event as { toolName?: string };
    if (!toolEvent.toolName) continue;
    const normalizedName = normalizeToSnakeCase(toolEvent.toolName);
    if (sideEffectPatterns.some((p) => p.test(normalizedName))) {
      return false;
    }
  }
  return true;
}

// =============================================================================
// Plain-text question / handoff patterns
// =============================================================================

/**
 * Patterns that indicate the assistant has asked the user for information or
 * a decision and is waiting for a response. Deliberately conservative — we
 * only want to exempt turns where the handoff is unambiguous. English-only
 * by design; non-English yields fall through to the `autoContinueHook` LLM
 * slow path.
 *
 * Coverage was expanded from a seeded-connector-specific set to real skill
 * phrasings surfaced by code review (FOX-3097 Phase 7), sampled from:
 * `slack-mcp-work-with`, `space-memory-populate`, `coaching-conversation`.
 * Additions here should be paired with a unit test in
 * `userYieldDetection.test.ts`.
 */
const QUESTION_HANDOFF_PATTERNS: readonly RegExp[] = [
  // Wh-questions explicitly asking the user to supply information
  /\bwhat would you like\b/i,
  /\bwhat do you (?:want|prefer|need|think|have in mind)\b/i,
  /\bwhich (?:would|do) you (?:like|want|prefer|choose)\b/i,
  /\bwhich\b[^.?!]*\b(?:should|would|do|can|will) (?:you|i|we)\b[^.?!]*\?/i,
  /\bwhich one\b[^.?!]*\?/i,
  /\bwho (?:should|would|do) (?:you|I)\b[^.?!]*\?/i,
  /\bwhen (?:should|would) (?:you|I)\b[^.?!]*\?/i,
  // "How X do/should/would you..." — common in coaching / clarification
  // skills. Allow 0-2 intervening words between the adjective and the modal
  // verb so phrasings like "How far back should I look?" or "How much detail
  // would you like?" match too.
  /\bhow (?:much|many|direct|often|far|long|detailed|specific|deep|quickly|soon)(?:\s+\w+){0,2}\s+(?:do|would|should|can|will) (?:you|i|we)\b/i,
  // Brief approval questions — common in "propose and wait" handoffs
  /\b(?:ok|okay) (?:to|with you|for me)\b[^.?!]*\?/i,
  /\bshall I (?:proceed|continue|go ahead|move on|begin|start)\b/i,
  // Direct asks for user input
  /\bjust (?:type|say|share|tell|reply|paste|give|drop|send)\b/i,
  /\bcould you (?:tell|share|provide|give|let|paste)\b[^.?!]*(?:\?|me)/i,
  /\bcan you (?:tell|share|provide|give|let|paste)\b[^.?!]*\?/i,
  /\bplease (?:provide|share|tell|let me know|paste|type|send|confirm)\b/i,
  /\blet me know (?:what|which|if|when|once|your|the)\b/i,
  // Explicit wait-for-user handoffs
  /\bwaiting for (?:you|your)\b/i,
  /\bonce you (?:have|let me know|tell me|reply|respond|share|provide)\b/i,
];

/**
 * True when the message contains a lazy-continuation phrase that suggests the
 * assistant intends to keep working but paused. These should NOT be treated
 * as legitimate yields — the completion-verification invariant still applies.
 *
 * Mirrors the "Said it would do the next step but stopped" examples baked into
 * the auto-continue LLM evaluator prompt.
 */
const LAZY_CONTINUATION_PATTERNS: readonly RegExp[] = [
  /\bnext,?\s+I(?:'ll| will)\b/i,
  /\blet me (?:start|begin|go ahead and|set those up|handle)\b/i,
  /\bI(?:'ll| will)\s+(?:now |proceed to |start |go ahead and |take care of )/i,
  /\bI(?:'m| am) going to\b/i,
  /\bmoving on to\b/i,
  /\bnow I(?:'ll| will)\b/i,
  /\bI(?:'ll| will) start with\b/i,
];

/**
 * True when the assistant message looks like a legitimate question or handoff
 * to the user — i.e. a state where forced continuation would be wrong.
 *
 * Covers three signal families (reused from autoContinueHook fast paths):
 *  1. Completion indicators ("let me know if you need anything else", …)
 *  2. Pending side-effect confirmation ("want me to send it?")
 *  3. Explicit question/handoff patterns ("what would you like …", "just type …")
 *
 * Gated by `LAZY_CONTINUATION_PATTERNS` — if the message also says "next I'll …"
 * we treat that as a lazy stop, not a yield, so the completion-verification
 * retry still fires.
 */
export function hasLegitimateYieldSignal(
  text: string,
  turnEvents: AgentEvent[],
): boolean {
  if (!text || text.length < 2) return false;

  if (LAZY_CONTINUATION_PATTERNS.some((p) => p.test(text))) return false;

  if (matchesCompletionIndicator(text)) return true;
  if (detectPendingSideEffect(text, turnEvents)) return true;
  if (QUESTION_HANDOFF_PATTERNS.some((p) => p.test(text))) return true;

  return false;
}

// =============================================================================
// Main API: isYieldingToUser
// =============================================================================

/**
 * Minimal task shape accepted by `isYieldingToUser`. Matches `RebelCoreTask`
 * but kept local to avoid dragging rebelCore internals into `autoContinueHook`.
 */
export interface YieldDetectionTask {
  /** `undefined` means "unscoped / main"; `'main'` is the explicit canonical
   * value. Mirrors `RebelCoreTask.owner` which is `string | undefined`. */
  owner?: string;
  /** Matches `RebelCoreTaskStatus = 'pending' | 'in_progress' | 'completed' |
   * 'blocked'`. Kept as `string` locally to avoid importing rebelCore types
   * into this services-layer module. */
  status: string;
  createdAt: number;
  updatedAt: number;
}

export interface YieldDetectionInput {
  /** Last assistant message text (aggregated body) for this turn. */
  lastAssistantText: string;
  /** All tasks currently on the board (will be filtered to main-agent tasks). */
  tasks: readonly YieldDetectionTask[];
  /** Turn start timestamp (ms). */
  turnStartTime: number;
  /** All agent events emitted during this turn, used for side-effect detection. */
  turnEvents: AgentEvent[];
}

/**
 * Is the agent legitimately yielding control back to the user?
 *
 * Returns true iff ALL of:
 *   1. The last assistant message matches a yield signal (question/handoff/
 *      completion/pending side-effect confirmation). See
 *      `hasLegitimateYieldSignal`.
 *   2. No main-agent task has been actually worked on this turn
 *      (`updatedAt > createdAt` AND updated inside the turn window). Plan-
 *      seeded tasks that were never touched with `TaskUpdate` DO NOT count
 *      as "work done" — they are precisely the case we want to exempt.
 *
 * Consumers:
 * - `rebelCoreQuery.runWithStopHooks`: skip task-board forced continuation.
 * - `autoContinueHook`: reuse `hasLegitimateYieldSignal` in its fast paths.
 *
 * Non-goals:
 * - Replacing `agentTurnRegistry.hasUserQuestionPending` — that remains the
 *   structured-tool fast path and must be consulted before this predicate.
 * - Replacing the LLM slow path in `autoContinueHook` — this helper is a
 *   heuristic, not a classifier; ambiguous turns still fall through.
 */
export function isYieldingToUser(input: YieldDetectionInput): boolean {
  if (!hasLegitimateYieldSignal(input.lastAssistantText, input.turnEvents)) {
    return false;
  }

  // A task is "actually being worked on" only when it is `in_progress` AND
  // was updated inside this turn's window. Crucially, `completed` tasks DO
  // NOT count — the model calling `TaskUpdate({status: 'completed'})` is
  // progress *toward* yielding, not against it. Production evidence:
  // transcript 57a52249-078d-4696-ab8d-05f9436e4247 showed the runtime marking
  // the "Ask the user" task `completed` and then emitting the Phase 0.0
  // question; the earlier (non-status-gated) predicate treated that completion
  // as "work in progress" and kept force-continuing. `pending` tasks are
  // "not started yet" and also don't count.
  //
  // Plan-seeded tasks have `updatedAt === createdAt` until a `TaskUpdate`
  // fires — so untouched seeds never reach this branch anyway.
  //
  // Main-agent predicate kept tight on purpose: `RebelCoreTask.owner` is typed
  // `string | undefined`; `undefined` means "unscoped/main" and `'main'` is
  // the explicit canonical value. Keep in sync with the matching filter in
  // `src/core/rebelCore/rebelCoreQuery.ts` (task-board continuation block).
  const hasTaskWork = input.tasks.some((t) => {
    const isMainAgent = t.owner === undefined || t.owner === 'main';
    if (!isMainAgent) return false;
    if (t.status !== 'in_progress') return false;
    if (t.updatedAt <= t.createdAt) return false;
    return t.updatedAt >= input.turnStartTime;
  });
  if (hasTaskWork) return false;

  return true;
}
