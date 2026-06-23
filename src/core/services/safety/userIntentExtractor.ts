/**
 * User Intent Extractor
 *
 * One-shot LLM classifier that reads the user's most-recent message and
 * decides whether it is an unambiguous imperative or confirmation directed at
 * the imminent tool family. Successful (medium/high confidence, non-`none`)
 * classifications are surfaced to the safety evaluator via the
 * `<user_intent_explicit>` fence as a SALIENCE signal — never authorisation.
 *
 * Behavioural contract:
 * - Empty/whitespace/short messages short-circuit to `null` (no LLM call).
 * - Caller-supplied closure-scoped cache keyed on `sha256(userMessage|toolFamily)`
 *   collapses repeat calls within the turn to one LLM round-trip.
 * - Any classifier error (timeout, non-2xx, abort, parse failure) returns
 *   `null` and emits a structured warn log. NEVER fail-closes to a fence.
 * - Only `signal !== 'none'` AND `confidence in ('medium', 'high')` are
 *   forwarded; everything else becomes `null`.
 *
 * @see docs/plans/260526_safety_eval_context_completeness.md (Stage 3, P0.5)
 * @see rebel-system/prompts/safety/user-intent-classifier.md
 */

import crypto from 'node:crypto';
import { createScopedLogger } from '@core/logger';
import { getSafetyEvaluationService } from '@core/safetyEvaluationService';
import { getPrompt, PROMPT_IDS } from '@core/services/promptFileService';
import type { CoarseToolFamily } from '@core/services/safety/toolNormalizationKeys';
import { ignoreBestEffortCleanup } from '@shared/utils/intentionalSwallow';

const log = createScopedLogger({ service: 'userIntentExtractor' });

const CLASSIFIER_MAX_TOKENS = 200;
const CLASSIFIER_TIMEOUT_MS = 10_000;
const MIN_USER_MESSAGE_LENGTH = 3;

const CLASSIFIER_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    signal: { type: 'string', enum: ['imperative', 'confirmation', 'negation', 'none'] },
    triggerPhrase: { type: 'string' },
    confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
  },
  required: ['signal', 'triggerPhrase', 'confidence'],
  additionalProperties: false,
};

export type UserIntentSignal = 'imperative' | 'confirmation' | 'negation' | 'none';
export type UserIntentConfidence = 'low' | 'medium' | 'high';

export interface UserIntentExtractionResult {
  signal: UserIntentSignal;
  triggerPhrase: string;
  confidence: UserIntentConfidence;
}

export type UserIntentExtractorCache = Map<
  string,
  Promise<UserIntentExtractionResult | null>
>;

export interface UserIntentExtractorArgs {
  /** The user's most-recent message text (untrusted, raw). */
  userMessage: string | undefined;
  /** Effective tool identifier (for telemetry only). */
  toolId: string;
  /** Coarse tool family used to scope the classifier. */
  toolFamily: CoarseToolFamily;
  /** Optional session id for telemetry. */
  sessionId?: string;
  /** Caller-owned cache for the lifetime of the turn (closure-scoped). */
  cache?: UserIntentExtractorCache;
  /** Abort signal — propagated to the underlying LLM call. */
  signal?: AbortSignal;
}

function fenceUserMessage(userMessage: string): string {
  const trimmed = userMessage.length > 1500 ? userMessage.slice(0, 1500) + '…' : userMessage;
  const escaped = trimmed
    .replace(/<\/user_message>/gi, '&lt;/user_message&gt;')
    .replace(/<!\[CDATA\[/gi, '&lt;![CDATA[');
  return `<user_message>\n${escaped}\n</user_message>`;
}

function buildClassifierUserMessage(userMessage: string, toolFamily: CoarseToolFamily): string {
  return [
    fenceUserMessage(userMessage),
    `<tool_family>${toolFamily}</tool_family>`,
    'Classify the user message per the rules in the system prompt and return only the JSON object.',
  ].join('\n\n');
}

function tryParseClassifierResponse(text: string): UserIntentExtractionResult | null {
  if (!text || typeof text !== 'string') return null;

  const tryParse = (candidate: string): unknown => {
    try {
      return JSON.parse(candidate);
    } catch (err) {
      ignoreBestEffortCleanup(err, {
        operation: 'safety.user_intent_classifier.parse_attempt',
        reason: 'Best-effort attempt to parse classifier candidate JSON; non-JSON falls through to next strategy.',
        severity: 'debug',
      });
      return null;
    }
  };

  let parsed: unknown = tryParse(text.trim());
  if (parsed === null) {
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced?.[1]) parsed = tryParse(fenced[1].trim());
  }
  if (parsed === null) {
    const firstBrace = text.indexOf('{');
    const lastBrace = text.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      parsed = tryParse(text.slice(firstBrace, lastBrace + 1));
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

  const obj = parsed as Record<string, unknown>;
  const signal = obj.signal;
  const triggerPhrase = obj.triggerPhrase;
  const confidence = obj.confidence;

  if (
    signal !== 'imperative' &&
    signal !== 'confirmation' &&
    signal !== 'negation' &&
    signal !== 'none'
  ) {
    return null;
  }
  if (typeof triggerPhrase !== 'string') return null;
  if (confidence !== 'low' && confidence !== 'medium' && confidence !== 'high') return null;

  return { signal, triggerPhrase: triggerPhrase.trim(), confidence };
}

function cacheKey(userMessage: string, toolFamily: CoarseToolFamily): string {
  return crypto.createHash('sha256').update(`${userMessage}|${toolFamily}`).digest('hex');
}

/**
 * Deterministic short hash for telemetry on user/LLM-derived strings. We log
 * the first 16 hex chars of sha256 so operators can correlate identical
 * payloads across log lines without ever putting the raw text in the log.
 */
function hashForLog(value: string): string {
  if (!value) return '';
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 16);
}

async function classifyOnce(
  userMessage: string,
  toolFamily: CoarseToolFamily,
  signal: AbortSignal | undefined,
): Promise<UserIntentExtractionResult | null> {
  const service = getSafetyEvaluationService();
  let systemPrompt: string;
  try {
    systemPrompt = getPrompt(PROMPT_IDS.SAFETY_USER_INTENT_CLASSIFIER);
  } catch (err) {
    log.warn(
      {
        event: 'safety.user_intent_classifier_error',
        phase: 'prompt_load',
        err: err instanceof Error ? err.message : String(err),
      },
      'Failed to load user-intent classifier prompt — proceeding without fence',
    );
    ignoreBestEffortCleanup(err, {
      operation: 'safety.user_intent_classifier.prompt_load',
      reason: 'User-intent classifier prompt unavailable; safety eval continues without the fence.',
      severity: 'warn',
    });
    return null;
  }

  const userPrompt = buildClassifierUserMessage(userMessage, toolFamily);

  let response: { text: string };
  try {
    response = await service.callLlm({
      system: systemPrompt,
      userMessage: userPrompt,
      maxTokens: CLASSIFIER_MAX_TOKENS,
      outputSchema: CLASSIFIER_OUTPUT_SCHEMA,
      timeout: CLASSIFIER_TIMEOUT_MS,
      signal,
    });
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      log.debug(
        { event: 'safety.user_intent_classifier_aborted' },
        'User-intent classifier aborted',
      );
      ignoreBestEffortCleanup(err, {
        operation: 'safety.user_intent_classifier.aborted',
        reason: 'Caller aborted the in-flight user-intent classifier call.',
        severity: 'debug',
      });
      return null;
    }
    log.warn(
      {
        event: 'safety.user_intent_classifier_error',
        phase: 'llm_call',
        err: err instanceof Error ? err.message : String(err),
      },
      'User-intent classifier LLM call failed — proceeding without fence',
    );
    ignoreBestEffortCleanup(err, {
      operation: 'safety.user_intent_classifier.llm_call',
      reason: 'User-intent classifier LLM call failed; safety eval continues without the fence.',
      severity: 'warn',
    });
    return null;
  }

  const parsed = tryParseClassifierResponse(response.text);
  if (!parsed) {
    log.warn(
      {
        event: 'safety.user_intent_classifier_parse_error',
        textLength: response.text?.length ?? 0,
        textHash: hashForLog(response.text ?? ''),
      },
      'User-intent classifier returned unparseable JSON — proceeding without fence',
    );
    return null;
  }

  return parsed;
}

export async function extractUserIntent(
  args: UserIntentExtractorArgs,
): Promise<UserIntentExtractionResult | null> {
  const { userMessage, toolId, toolFamily, sessionId, cache, signal } = args;

  const trimmed = typeof userMessage === 'string' ? userMessage.trim() : '';
  if (trimmed.length < MIN_USER_MESSAGE_LENGTH) return null;

  const key = cacheKey(trimmed, toolFamily);
  if (cache) {
    const existing = cache.get(key);
    if (existing) return existing;
  }

  const pending = (async (): Promise<UserIntentExtractionResult | null> => {
    const result = await classifyOnce(trimmed, toolFamily, signal);
    if (!result) return null;
    if (result.signal === 'none') return null;
    if (result.confidence !== 'medium' && result.confidence !== 'high') return null;
    if (result.triggerPhrase.length === 0) return null;

    log.info(
      {
        event:
          result.signal === 'negation'
            ? 'safety.user_intent_negation_detected'
            : 'safety.user_intent_fence_injected',
        sessionId,
        toolId,
        toolFamily,
        intentSignal: result.signal,
        triggerPhraseHash: hashForLog(result.triggerPhrase),
        triggerPhraseLength: result.triggerPhrase.length,
        confidence: result.confidence,
      },
      result.signal === 'negation'
        ? 'User-intent classified as negation — caller should invalidate matching cache'
        : 'User-intent fence injected',
    );

    return result;
  })();

  if (cache) {
    cache.set(key, pending);
    pending.catch(() => {
      cache.delete(key);
    });
  }

  return pending;
}

/** Test helper to construct a fresh classifier cache. */
export function createUserIntentExtractorCache(): UserIntentExtractorCache {
  return new Map();
}
