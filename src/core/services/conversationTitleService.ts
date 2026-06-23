/**
 * Conversation Title Service
 *
 * Generates concise, high-signal titles for conversations using Claude Haiku.
 * Uses direct Anthropic API via callBehindTheScenes for fast, lightweight calls.
 */

import type {
  AppSettings,
  ConversationTitleTranscriptEntry,
  AgentEvent,
  AgentTurnMessage,
} from '@shared/types';
import { createScopedLogger } from '@core/logger';
import { callBehindTheScenesWithAuth, getEffectiveModelName } from './behindTheScenesClient';
import { hasValidAuth } from '../utils/authEnvUtils';
import { getPrompt, PROMPT_IDS } from '@core/services/promptFileService';
import { resolveCodexConnectivity } from '@core/rebelCore/codexConnectivity';
import { captureKnownCondition } from '@core/sentry/captureKnownCondition';

const log = createScopedLogger({ service: 'conversationTitle' });

const TITLE_TIMEOUT_MS = 15000;
const TITLE_MAX_WORDS = 3;
const TITLE_MAX_CHARS = 48;
const RETITLE_TURN_THRESHOLD = 5;
const TITLE_RETRY_BACKOFF_MS = 30_000;

/**
 * Maximum characters of transcript text to send for title generation.
 * Moved from renderer to centralize.
 */
const AUTO_TITLE_TEXT_LIMIT = 1500;

/**
 * Known default session titles that indicate a session has not been
 * meaningfully titled yet.
 */
export const DEFAULT_SESSION_TITLES = new Set(['New Agent Run', 'New conversation']);

/**
 * Normalize transcript text: collapse whitespace and truncate to limit.
 */
const normalizeTranscriptText = (value: string): string => {
  const normalized = value.trim().replace(/\s+/g, ' ');
  if (normalized.length <= AUTO_TITLE_TEXT_LIMIT) {
    return normalized;
  }
  return normalized.slice(0, AUTO_TITLE_TEXT_LIMIT).trim();
};

/**
 * Build the fallback title that `createSessionTitle` in the renderer would produce
 * from the first message. Used to detect fallback-titled sessions without importing
 * renderer code.
 */
const buildFallbackTitle = (messages: AgentTurnMessage[]): string | null => {
  const firstUser = messages.find((m) => m.role === 'user' && m.text.trim().length > 0);
  if (firstUser) {
    const trimmed = firstUser.text.trim().replace(/\s+/g, ' ');
    return trimmed.length > 54 ? `${trimmed.slice(0, 54).trim()}…` : trimmed;
  }

  const firstNonUser = messages.find((m) => m.role !== 'user' && m.text.trim().length > 0);
  if (firstNonUser) {
    const trimmed = firstNonUser.text.trim().replace(/\s+/g, ' ');
    return trimmed.length > 54 ? `${trimmed.slice(0, 54).trim()}…` : trimmed;
  }

  return null;
};

/**
 * Check whether a session title is a default or fallback title that should
 * be overwritten by auto-generated title.
 *
 * Returns true if:
 * - Title is in DEFAULT_SESSION_TITLES ('New Agent Run', 'New conversation')
 * - Title matches the "Conversation N" fallback pattern
 * - Title matches what createSessionTitle would produce from the first message
 */
export const isDefaultOrFallbackTitle = (title: string, messages: AgentTurnMessage[]): boolean => {
  if (DEFAULT_SESSION_TITLES.has(title)) return true;
  if (/^Conversation \d+$/.test(title)) return true;

  const fallback = buildFallbackTitle(messages);
  if (fallback && title === fallback) return true;

  // Empty/whitespace title
  if (!title.trim()) return true;

  // Title matches first user message exactly (surface didn't truncate)
  // or is a known truncation pattern (any length + optional ellipsis)
  const firstUserText = messages
    .find((m) => m.role === 'user' && m.text.trim())
    ?.text.trim()
    .replace(/\s+/g, ' ');
  if (firstUserText) {
    const normalizedTitle = title.replace(/…$/, '').trimEnd();
    const normalizedMessage = firstUserText.replace(/\s+/g, ' ');
    // Exact match (no truncation)
    if (normalizedTitle === normalizedMessage) return true;
    // Title is a truncation of the first message (message starts with the title text)
    if (normalizedTitle.length >= 20 && normalizedMessage.startsWith(normalizedTitle)) return true;
  }

  return false;
};

/** A title + its paired auto-title metadata, the unit moved together across merges. */
interface AutoTitleMetadataSide {
  title: string | undefined;
  autoTitleGeneratedAt?: number;
  autoTitleTurnCount?: number;
}

/**
 * Resolve the auto-title metadata (`autoTitleGeneratedAt` / `autoTitleTurnCount`)
 * for a session merge where the WINNING TITLE STRING has already been chosen by
 * title policy.
 *
 * The invariant: a (non-fallback) title and its auto-title metadata are ONE unit.
 * An equal-title merge must never strand metadata that some side has — otherwise a
 * later auto-retitle (the RETITLE_TURN_THRESHOLD logic in this service) breaks.
 *
 * - Titles DIFFER → metadata follows the winning title (i.e. the winning side's
 *   metadata, which is what the caller already selected by spreading the winner).
 * - Titles EQUAL → metadata = whichever side HAS `autoTitleGeneratedAt`; if both
 *   have it, the winning (title-policy) side's.
 *
 * This is shared by both merge directions (desktop push in
 * `cloudSessionMergeService`, desktop pull via `resolvePulledTitle` in
 * `cloudRouterHelpers`) so the rule can't drift. The `winning` side is the one the
 * title-policy selected; `losing` is the other side. Note: when titles are equal,
 * "winning"/"losing" are interchangeable for the title string itself — this helper
 * only governs which metadata travels with it.
 */
export const resolveAutoTitleMetadata = (
  winning: AutoTitleMetadataSide,
  losing: AutoTitleMetadataSide,
): { autoTitleGeneratedAt?: number; autoTitleTurnCount?: number } => {
  // Default: metadata follows the winning title.
  if (
    winning.autoTitleGeneratedAt == null &&
    losing.autoTitleGeneratedAt != null &&
    winning.title === losing.title
  ) {
    // Equal title strings and only the losing side carries metadata — adopt it so
    // an equal-title merge never strands the auto-title metadata.
    return {
      autoTitleGeneratedAt: losing.autoTitleGeneratedAt,
      autoTitleTurnCount: losing.autoTitleTurnCount,
    };
  }
  return {
    autoTitleGeneratedAt: winning.autoTitleGeneratedAt,
    autoTitleTurnCount: winning.autoTitleTurnCount,
  };
};

export const countCompletedTurns = (eventsByTurn: Record<string, AgentEvent[]>): number => {
  let count = 0;
  for (const events of Object.values(eventsByTurn)) {
    if (events.some((e) => e.type === 'result')) {
      count++;
      if (count >= RETITLE_TURN_THRESHOLD) break; // Early exit — we only care about the threshold
    }
  }
  return count;
};

export interface AutoTitleDeps {
  getSettings: () => AppSettings;
  /**
   * Optional async callback to re-read the latest persisted session state
   * before retrying title generation after a transient failure. If omitted,
   * the retry path is disabled (single attempt only). Closes over the
   * caller's session identifier; returns null if the session no longer
   * exists on disk.
   */
  getCurrentSession?: () => Promise<{
    title: string;
    messages: AgentTurnMessage[];
  } | null>;
}

export interface AutoTitleResult {
  title: string;
  reason: 'initial' | 'retitle';
  turnCount: number;
}

type TitleGenerationOutcome =
  | { kind: 'success'; title: string }
  | { kind: 'aborted' }
  | { kind: 'timeout' }
  | { kind: 'failed' };

interface AutoTitleAction {
  reason: 'initial' | 'retitle';
  transcript: ConversationTitleTranscriptEntry[];
  turnCount: number;
}

function decideAutoTitleAction(
  session: {
    title: string;
    messages: AgentTurnMessage[];
    eventsByTurn: Record<string, AgentEvent[]>;
    autoTitleGeneratedAt?: number;
    autoTitleTurnCount?: number;
  },
  logContext: 'first' | 'retry',
): AutoTitleAction | null {
  const completedTurns = countCompletedTurns(session.eventsByTurn);

  let reason: 'initial' | 'retitle';
  if (isDefaultOrFallbackTitle(session.title, session.messages)) {
    reason = 'initial';
  } else if (
    completedTurns >= RETITLE_TURN_THRESHOLD
    && session.autoTitleGeneratedAt != null
    && (session.autoTitleTurnCount ?? 0) < RETITLE_TURN_THRESHOLD
  ) {
    reason = 'retitle';
  } else {
    log.debug(
      {
        attempt: logContext,
        titleLength: session.title.length,
        completedTurns,
        autoTitleGeneratedAt: session.autoTitleGeneratedAt,
      },
      'Auto-title skipped: not eligible for initial or retitle',
    );
    return null;
  }

  let transcript: ConversationTitleTranscriptEntry[];
  if (reason === 'initial') {
    const firstUser = session.messages.find((m) => m.role === 'user' && m.text.trim());
    const firstAssistant = session.messages.find(
      (m) => (m.role === 'assistant' || m.role === 'result') && m.text.trim(),
    );
    if (!firstUser || !firstAssistant) {
      log.warn(
        {
          attempt: logContext,
          reason,
          messageCount: session.messages.length,
          hasUser: !!firstUser,
          hasAssistant: !!firstAssistant,
        },
        'Auto-title skipped: missing user or assistant message',
      );
      return null;
    }
    transcript = [
      { role: 'user', text: normalizeTranscriptText(firstUser.text) },
      { role: firstAssistant.role, text: normalizeTranscriptText(firstAssistant.text) },
    ];
  } else {
    transcript = session.messages
      .filter((m) => (m.role === 'user' || m.role === 'result') && m.text.trim())
      .map((m) => ({ role: m.role as 'user' | 'result', text: normalizeTranscriptText(m.text) }));
    if (transcript.length < 2) {
      log.debug(
        { attempt: logContext, reason, transcriptLength: transcript.length },
        'Auto-title skipped: insufficient transcript for retitle',
      );
      return null;
    }
  }

  return { reason, transcript, turnCount: completedTurns };
}

function emitTitleUnavailable(sessionId: string | undefined): void {
  try {
    captureKnownCondition('conversation_title_unavailable', {
      extra: {
        sessionId: sessionId ?? null,
        reason: 'second_attempt_null',
      },
    });
  } catch (emitError) {
    log.warn(
      { err: emitError instanceof Error ? emitError.message : String(emitError) },
      'Failed to emit conversation_title_unavailable known condition',
    );
  }
}

/**
 * Centralized title generation logic. Determines whether a title should be
 * generated (initial or re-title) and generates it.
 *
 * Does NOT persist or re-read the session — callers handle concurrency and
 * persistence with their own surface-specific mechanisms.
 */
export async function processAutoTitle(
  session: {
    id?: string;
    title: string;
    messages: AgentTurnMessage[];
    eventsByTurn: Record<string, AgentEvent[]>;
    autoTitleGeneratedAt?: number;
    autoTitleTurnCount?: number;
  },
  deps: AutoTitleDeps,
): Promise<AutoTitleResult | null> {
  const initialAction = decideAutoTitleAction(session, 'first');
  if (!initialAction) return null;

  const firstOutcome = await generateConversationTitleResult(deps.getSettings(), initialAction.transcript);
  if (firstOutcome.kind === 'success') {
    if (initialAction.reason === 'retitle' && firstOutcome.title === session.title) {
      log.debug({ reason: initialAction.reason }, 'Auto-title skipped: retitle produced same title');
      return null;
    }
    return { title: firstOutcome.title, reason: initialAction.reason, turnCount: initialAction.turnCount };
  }

  if (firstOutcome.kind === 'aborted') {
    return null;
  }
  // 'timeout' and 'failed' both fall through to the retry path below.

  if (!deps.getCurrentSession) {
    log.warn(
      { reason: initialAction.reason },
      'Auto-title skipped: first attempt returned null and retry is not wired by caller',
    );
    return null;
  }

  await new Promise((resolve) => setTimeout(resolve, TITLE_RETRY_BACKOFF_MS));

  const retrySettings = deps.getSettings();
  if (!hasValidAuth(retrySettings)) {
    log.debug({ reason: initialAction.reason }, 'Auto-title retry skipped: no valid auth at retry time');
    return null;
  }

  let currentSession: { title: string; messages: AgentTurnMessage[] } | null;
  try {
    currentSession = await deps.getCurrentSession();
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'Auto-title retry skipped: getCurrentSession threw',
    );
    return null;
  }
  if (!currentSession) {
    log.debug({ reason: initialAction.reason }, 'Auto-title retry skipped: session was deleted');
    return null;
  }
  if (!isDefaultOrFallbackTitle(currentSession.title, currentSession.messages)) {
    log.debug({ reason: initialAction.reason }, 'Auto-title retry skipped: title was manually renamed');
    return null;
  }

  const retryAction = decideAutoTitleAction(
    {
      ...session,
      title: currentSession.title,
      messages: currentSession.messages,
    },
    'retry',
  );
  if (!retryAction) return null;

  const secondOutcome = await generateConversationTitleResult(retrySettings, retryAction.transcript);
  if (secondOutcome.kind === 'success') {
    if (retryAction.reason === 'retitle' && secondOutcome.title === currentSession.title) {
      log.debug({ reason: retryAction.reason }, 'Auto-title retry produced same title; skipping');
      return null;
    }
    return { title: secondOutcome.title, reason: retryAction.reason, turnCount: retryAction.turnCount };
  }

  if (secondOutcome.kind === 'aborted') {
    return null;
  }

  // 'timeout' or 'failed' on the retry: emit known condition so the
  // diagnostics ledger records the unavailability.
  emitTitleUnavailable(session.id);
  return null;
}

/**
 * Conditionally generate a title for a session if it currently has a default
 * or fallback title. Returns the generated title or null if no generation
 * is needed or possible.
 *
 * This is the centralized entry point for auto-title generation, used by
 * both desktop (Electron) and cloud turn completion paths.
 */
export async function maybeGenerateSessionTitle(
  session: { title: string; messages: AgentTurnMessage[] },
  getSettings: () => AppSettings,
): Promise<string | null> {
  try {
    if (!isDefaultOrFallbackTitle(session.title, session.messages)) {
      log.debug(
        { titleLength: session.title.length },
        'maybeGenerateSessionTitle skipped: title is not default/fallback'
      );
      return null;
    }

    const firstUser = session.messages.find((m) => m.role === 'user' && m.text.trim());
    const firstAssistant = session.messages.find(
      (m) => (m.role === 'assistant' || m.role === 'result') && m.text.trim(),
    );

    if (!firstUser || !firstAssistant) {
      log.warn(
        {
          messageCount: session.messages.length,
          hasUser: !!firstUser,
          hasAssistant: !!firstAssistant,
        },
        'maybeGenerateSessionTitle skipped: missing user or assistant message'
      );
      return null;
    }

    const transcript: ConversationTitleTranscriptEntry[] = [
      { role: 'user', text: normalizeTranscriptText(firstUser.text) },
      { role: firstAssistant.role, text: normalizeTranscriptText(firstAssistant.text) },
    ];

    return await generateConversationTitle(getSettings(), transcript);
  } catch (err) {
    log.warn({ err }, 'maybeGenerateSessionTitle failed');
    return null;
  }
}

export const sanitizeGeneratedTitle = (raw: string): string => {
  if (!raw) {
    return '';
  }

  const withoutFence = raw.replace(/```/g, '');
  const firstLine =
    withoutFence
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? withoutFence.trim();

  const withoutCompositeLabel = firstLine.replace(
    /^\s*((conversation|thread|chat)\s+)?(title|name|topic|subject)\s*[:\-]+\s*/i,
    ''
  );
  const withoutConversationLabel = withoutCompositeLabel
    .replace(/^\s*(conversation|thread|chat)\s*[:\-]+\s*/i, '')
    .replace(/^\s*(conversation|thread|chat|title|name|topic|subject)\s+/i, '');
  const strippedQuotes = withoutConversationLabel.replace(/^["'`\s]+|["'`\s]+$/g, '');
  const trimmed = strippedQuotes.replace(/[–—-]+$/g, '').replace(/[.,:;!?]+$/g, '').trim();
  if (!trimmed) {
    return '';
  }

  const words = trimmed
    .split(/\s+/)
    .filter((word) => Boolean(word?.trim()))
    .slice(0, TITLE_MAX_WORDS);
  if (words.length === 0) {
    return '';
  }

  const candidate = words.join(' ');
  if (candidate.length <= TITLE_MAX_CHARS) {
    return candidate;
  }
  return candidate.slice(0, TITLE_MAX_CHARS).trim();
};

const formatTranscript = (transcript: ConversationTitleTranscriptEntry[]): string => {
  return transcript
    .map((entry) => {
      const label = entry.role === 'user' ? 'User' : entry.role === 'result' ? 'Summary' : 'Assistant';
      return `${label}:\n${entry.text.trim()}`;
    })
    .join('\n\n');
};

/**
 * Internal: run a single title generation attempt and return a rich outcome.
 *
 * Outcome kinds:
 * - `success`: title generated; use it.
 * - `timeout`: our 15s budget elapsed before the BTS call resolved.
 *   Retry-eligible — likely a transient backend/proxy hiccup.
 * - `aborted`: an external caller's `AbortSignal` (not threaded today) caused
 *   the call to reject with `AbortError`. Treated as intentional cancel —
 *   no retry, no known-condition emit.
 * - `failed`: non-abort error or empty/invalid response. Retry-eligible.
 */
async function generateConversationTitleResult(
  settings: AppSettings,
  transcript: ConversationTitleTranscriptEntry[],
): Promise<TitleGenerationOutcome> {
  if (!Array.isArray(transcript) || transcript.length === 0) {
    throw new Error('Transcript is required to rename the conversation.');
  }

  if (!hasValidAuth(settings)) {
    log.debug('No valid auth available for title generation, skipping');
    return { kind: 'failed' };
  }

  const transcriptBlock = formatTranscript(transcript);
  const prompt = [
    'Conversation excerpt (first exchange):',
    transcriptBlock,
    '',
    'Write a concise, high-signal title suited for a chat history sidebar where only the first ~3 words may be visible.',
  ].join('\n');

  // Own the timeout timer so we can distinguish "we hit our 15s budget"
  // (kind: 'timeout' — retry-eligible) from "an external caller aborted us"
  // (kind: 'aborted' — intentional cancel, stays silent). Without this
  // discrimination, both shapes collapsed onto AbortError and the silent
  // return swallowed observability for the timeout case.
  // See docs-private/investigations/260514_cloud_bts_codex_proxy_unwired_auto_title.md § Bug 3.
  const timeoutController = new AbortController();
  let timedOut = false;
  const timeoutHandle = setTimeout(() => {
    timedOut = true;
    timeoutController.abort();
  }, TITLE_TIMEOUT_MS);

  try {
    log.debug({ model: getEffectiveModelName(settings) }, 'Generating conversation title');

    const response = await callBehindTheScenesWithAuth(
      settings,
      {
        codexConnectivity: resolveCodexConnectivity(),
        messages: [{ role: 'user', content: prompt }],
        system: getPrompt(PROMPT_IDS.CONVERSATION_TITLE),
        maxTokens: 24,
        signal: timeoutController.signal,
      },
      { category: 'metadata' },
    );

    const content = response.content?.[0];
    if (content?.type === 'text' && content.text) {
      const sanitized = sanitizeGeneratedTitle(content.text);
      if (sanitized) {
        log.debug({ title: sanitized }, 'Generated conversation title');
        return { kind: 'success', title: sanitized };
      }
      log.warn(
        { raw: content.text.slice(0, 50) },
        'Title generation returned text but sanitization produced empty result',
      );
      return { kind: 'failed' };
    }

    log.warn({ response }, 'Claude returned an empty or invalid conversation title');
    return { kind: 'failed' };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      if (timedOut) {
        log.warn('Conversation title generation timed out');
        return { kind: 'timeout' };
      }
      log.debug('Conversation title generation aborted by caller signal');
      return { kind: 'aborted' };
    }

    log.error({ err: error }, 'Failed to generate conversation title');
    return { kind: 'failed' };
  } finally {
    clearTimeout(timeoutHandle);
  }
}

/**
 * Generate a concise title for a conversation.
 *
 * Uses the direct Anthropic API via callBehindTheScenes for fast execution.
 * Requires an API key (OAuth-only users will get null gracefully).
 *
 * @returns The generated title, or null if generation fails or no API key
 */
export async function generateConversationTitle(
  settings: AppSettings,
  transcript: ConversationTitleTranscriptEntry[],
): Promise<string | null> {
  const outcome = await generateConversationTitleResult(settings, transcript);
  return outcome.kind === 'success' ? outcome.title : null;
}
