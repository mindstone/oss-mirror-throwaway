/**
 * Quip Generator Service
 *
 * Generates contextual, witty status quips using Claude Haiku.
 * Designed for long-running agent turns (30s+) to keep the UI fresh.
 */

import axios from 'axios';
import type { AppSettings } from '@shared/types';
import { createScopedLogger } from '@core/logger';
import { captureKnownCondition } from '@core/sentry/captureKnownCondition';
import { callBehindTheScenesWithAuth, getEffectiveModelName } from './behindTheScenesClient';
import { hasValidAuth } from '../utils/authEnvUtils';
import { getPrompt, PROMPT_IDS } from '@core/services/promptFileService';
import { resolveCodexConnectivity } from '@core/rebelCore/codexConnectivity';

const logger = createScopedLogger({ service: 'quipGenerator' });

const QUIP_GENERATION_TIMEOUT_MS = 8000;
export const QUIPS_PER_REQUEST = 5;

export const STYLE_PROMPT = `You are a witty copywriter generating brief status messages for an AI assistant's loading screen.

The messages should be:
- 6-12 words max, under 80 characters including spaces and punctuation
- Wry, self-aware, slightly dry humor
- Sound like a capable colleague, not a comedian performing bits
- Match the stage in the provided context:
  - processing stage = investigating, sorting, mapping, weighing, cross-referencing
  - generation stage = drafting, writing, editing, revising
  - do not mix stage language (no drafting/writing verbs for processing-stage quips; no thinking/analyzing verbs for generation-stage quips)
- Ground at least some quips in concrete nouns from the user's request
- For broad or complex requests, zoom in on specific subproblems instead of vague phrases like "the complexity" or "multiple angles"
- Vary sentence openings and rhythm across the set; do not make most lines start with the same "-ing" verb
- Every line should include either a concrete image or a dry aside; if it sounds like a plain status update, rewrite it
- Avoid stock metaphors, corporate-war language, or anything edgy/try-hard
- No mystery/investigation/detective framing at all — no clues, cases, suspects, crime scenes, culprits, trails, or "getting to the bottom of" anything. For technical tasks (debugging, errors, fixes), use mechanical/craft metaphors (tightening bolts, tracing wires, reading blueprints) instead
- For sprawling or multi-part requests, do NOT summarize or earnestly describe the workload. Instead pick ONE quirky concrete detail from the request and make a dry observation about it
- For very short or minimal requests (greetings, single words), keep it light and breezy — don't overthink it or treat the input as unexpectedly profound. A casual, low-key quip beats a clever riff on brevity
- Avoid explicit AI/robot self-reference (circuits, neurons, algorithms, etc.)
- No emojis
- Use concrete metaphors and imagery
- Acknowledge the wait without being apologetic
- Can reference thinking, working, processing, but creatively
- NEVER use these words or phrases: sorry, apologize, apologies, apology, please wait, bear with, forgive me

Examples of the style we want:
- "Building Rome. Give me a minute."
- "This one has layers—like an onion, or a well-structured codebase."
- "Running calculations that would make a spreadsheet weep with joy."
- "Consulting my inner committee. They are thorough."
- "Some say I am still thinking. They are right."
- "Polishing every sentence like it owes me money."
- "Drafting. Editing. Questioning my life choices. Drafting again."

Generate ${QUIPS_PER_REQUEST} unique status messages. Each on its own line, no numbering or bullets.`;

export interface QuipGenerationRequest {
  userMessage: string;
  turnId: string;
  stage: 'processing' | 'generation';
}

export interface QuipGenerationResult {
  success: boolean;
  quips?: string[];
  error?: string;
}

// Cache: turnId -> generated quips (so we don't regenerate for the same turn)
const turnQuipCache = new Map<string, string[]>();

/**
 * Clear the quip cache for a turn (call when turn ends)
 */
export function clearTurnQuipCache(turnId: string): void {
  turnQuipCache.delete(turnId);
}

/**
 * Generate contextual quips for a long-running turn.
 * Uses Haiku by default for fast, cheap generation.
 */
export async function generateDynamicQuips(
  request: QuipGenerationRequest,
  settings: AppSettings,
  signal?: AbortSignal
): Promise<QuipGenerationResult> {
  const { userMessage, turnId, stage } = request;

  // Efficiency Mode (260524_performance_mode): when the user has explicitly
  // disabled persona quip flavour text — typically because Efficiency Mode is
  // on — return success with no quips so the static rotation is used instead.
  // Default (undefined) is true (quips on), preserving prior behaviour.
  if (settings.personaQuipsEnabled === false) {
    logger.debug({ turnId }, 'Persona quips disabled (Efficiency Mode); skipping LLM call');
    return { success: true, quips: [] };
  }

  // Check cache first
  const cached = turnQuipCache.get(turnId);
  if (cached && cached.length > 0) {
    logger.debug({ turnId, cachedCount: cached.length }, 'Returning cached quips');
    return { success: true, quips: cached };
  }

  if (!hasValidAuth(settings)) {
    return { success: false, error: 'No valid auth available' };
  }

  // Build context-aware prompt
  const contextSnippet = userMessage.slice(0, 200);
  const stageContext = stage === 'generation' 
    ? 'The AI is currently writing/generating a response.'
    : 'The AI is currently thinking/processing the request.';

  const prompt = `${getPrompt(PROMPT_IDS.UTILITY_QUIP_STYLE, { quips_per_request: QUIPS_PER_REQUEST })}

Context for these messages:
- User asked: "${contextSnippet}${userMessage.length > 200 ? '...' : ''}"
- ${stageContext}
- These will show during a longer wait (30+ seconds)

Generate the messages now:`;

  try {
    logger.debug({ model: getEffectiveModelName(settings) }, 'Calling LLM for quips');

    const response = await callBehindTheScenesWithAuth(settings, {
      codexConnectivity: resolveCodexConnectivity(),
      messages: [{ role: 'user', content: prompt }],
      maxTokens: 512,
      timeout: QUIP_GENERATION_TIMEOUT_MS,
      signal,
    }, { category: 'quip', turnId, outcomePolicy: 'turn_bearing' });

    const content = response.content?.[0];
    if (content?.type === 'text') {
      const quips = (content.text ?? '')
        .split('\n')
        .map((line: string) => line.trim())
        .filter((line: string) => line.length > 0 && line.length < 100)
        .slice(0, QUIPS_PER_REQUEST);

      if (quips.length > 0) {
        turnQuipCache.set(turnId, quips);
        logger.info({ turnId, count: quips.length }, 'Generated dynamic quips');
        return { success: true, quips };
      }
    }

    logger.warn({ turnId }, 'No valid quips in response');
    return { success: false, error: 'No valid quips generated' };
  } catch (error: unknown) {
    if (axios.isCancel(error) || (error instanceof Error && error.name === 'AbortError')) {
      logger.debug({ turnId }, 'Quip generation aborted');
      return { success: false, error: 'Aborted' };
    }

    const axiosError = error as { response?: { status?: number }; message?: string };
    logger.error(
      { turnId, message: axiosError.message, status: axiosError.response?.status },
      'Quip generation failed'
    );
    captureKnownCondition(
      'bts_quip_failure',
      { turnId },
      error instanceof Error ? error : undefined,
    );
    return { success: false, error: axiosError.message || 'Generation failed' };
  }
}
