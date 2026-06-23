/**
 * Hero Choice Service
 *
 * Builds the prompt, calls the LLM, and parses the response to produce
 * ranked daily recommendations. Uses dependency injection for context assembly.
 *
 * @see docs/plans/260315_spark_redesign.md
 */

import { randomUUID } from 'node:crypto';
import type { AppSettings } from '@shared/types';
import { createScopedLogger } from '@core/logger';
import {
  normalizeStoredBtsModelValue,
  rejectionReasonLabel,
} from '@shared/utils/modelChoiceCodec';
import { callWithModelAuthAware, CodexDisconnectedBtsError } from './behindTheScenesClient';
import { safeJsonParseFromModelText } from '@shared/utils/safeJsonParse';
import {
  modelSupportsExtendedContext,
  PREFERRED_PLANNING_MODEL,
} from '@shared/utils/modelNormalization';
import {
  assembleHeroChoiceContext,
  type HeroChoiceContextDeps,
} from './heroChoiceContextAssembler';
import type {
  HeroChoiceResult,
  HeroChoiceCandidate,
  HeroChoiceCandidateType,
} from '@core/heroChoiceTypes';
import { getPrompt, PROMPT_IDS } from '@core/services/promptFileService';
import { resolveCodexConnectivity } from '@core/rebelCore/codexConnectivity';
import { getThinkingModel } from '@core/rebelCore/settingsAccessors';

const log = createScopedLogger({ service: 'heroChoiceService' });

const HERO_CHOICE_TIMEOUT_MS = 90_000;

/** Context token budgets per model context window tier */
const EXTENDED_CONTEXT_BUDGET = 900_000; // 1M window minus system prompt + output headroom
const STANDARD_CONTEXT_BUDGET = 180_000; // 200K window minus headroom

const VALID_CANDIDATE_TYPES = new Set<string>([
  'meeting_prep',
  'coaching',
  'improvement',
  'use_case',
  'insight',
]);

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are Rebel's recommendation engine. Analyze the user's recent activity, goals, calendar, and available tools — then produce 3–5 ranked recommendations for what they should focus on right now.

## Your Personality
Clear, direct, slightly witty. You're a capable colleague who happens to be sharp — not corporate, not try-hard. Dry humor, not dad jokes.

## Output Format
Return valid JSON matching the schema provided. No text outside the JSON.

## Recommendation Types
- **meeting_prep**: A meeting that needs preparation. Include attendee names and meeting topic in the actionPrompt.
- **coaching**: A pattern across multiple sessions — not just one conversation. Should feel insightful, not obvious. Reference specific topics or behaviors.
- **improvement**: A concrete, actionable improvement to the user's skills, memories, or preferences. Be specific about what to change and why.
- **use_case**: A workflow the user hasn't tried that would be genuinely useful based on their actual work patterns. Don't suggest things unrelated to their real work.
- **insight**: An interesting connection or pattern across sessions — something the user probably hasn't noticed. Surface surprising links between topics, recurring themes, or emerging priorities.

## Prioritization: Impact Right Now, Not Nearest Deadline

Rank by **most impactful to act on right now** (priority 1 = highest). Urgency alone does not determine rank — urgency is only meaningful when delay causes real loss.

For each candidate, evaluate:
1. **Consequence of delay** — What's actually lost if the user doesn't act in the next 1–2 hours?
2. **Actionability** — Can they realistically do something useful about this right now?
3. **Stakes** — Does this affect revenue, decisions, reputation, or other people's work?
4. **Opportunity window** — Is there a narrow window where acting now matters?
5. **Unblocker value** — Does this unlock other work or reduce downstream risk?

CRITICAL DISTINCTION: A meeting on the calendar does not automatically deserve priority 1. Apply this logic:

| Time until meeting | Priority guidance |
|---|---|
| ≤ 90 minutes | Priority 1 IF the meeting is meaningful AND useful prep remains. Routine standups or status updates with no prep value should not be priority 1. |
| 2–4 hours | Strong candidate, but competes with other work on stakes. Only priority 1 if the meeting is high-stakes (external, presentation, decision-making) AND prep hasn't been done. |
| 4–8 hours | "Important, plan for later." Only elevate if prep requires substantial research/synthesis that benefits from an early start. |
| 8–24 hours | Rarely priority 1. Mention if relevant, but don't boost over today's impactful work. |

A coaching insight that changes how someone approaches their work, or an improvement that saves time every day, can easily outrank a routine meeting 6 hours away.

## What Makes a GREAT Recommendation (show these)
- References specific names, dates, topics, or patterns from the user's actual context
- The actionPrompt is a natural, ready-to-send message — not vague instructions
- Acting on it now produces meaningfully better outcomes than acting later
- The headline makes the user think "oh right, I should do that"

## What Makes a POOR Recommendation (do not show)
- Generic advice that could apply to anyone ("review your schedule", "stay organized")
- Meeting prep for a routine sync with no meaningful prep needed
- Suggestions the user clearly already knows or has done recently
- Anything where the user would think "why is this telling me this now?"

## Rules
1. Produce 3–5 candidates, ranked by impact-right-now (priority 1 = act on this first)
2. Each headline must be specific — reference actual names, topics, or dates from the context
3. Each actionPrompt must be a natural, ready-to-send message
4. The weekSummary should be a brief, encouraging one-liner about the user's recent activity
5. Do NOT repeat past recommendations listed in context — including semantically similar ones with different wording
6. Coaching insights must span multiple sessions — single-session observations are too shallow
7. If there's very little activity, produce fewer candidates (minimum 1) rather than padding with generic advice
8. The actionLabel should be short (2-4 words): "Prepare now", "Try this", "Explore", "Improve this"
9. If nothing genuinely valuable surfaces, produce fewer candidates — never pad with filler
10. Prefer recommendations that unlock other work or reduce downstream risk over isolated tasks
11. For meeting_prep candidates, ALWAYS include meetingStartTimeISO — the ISO 8601 datetime of the meeting start from the calendar context
12. Never use emoji characters in headlines, bodies, actionLabels, or weekSummary. The UI provides its own icons for each recommendation type.`;

// ---------------------------------------------------------------------------
// JSON output schema for the LLM
// ---------------------------------------------------------------------------

const HERO_CHOICE_JSON_SCHEMA = {
  type: 'object',
  properties: {
    candidates: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          type: {
            type: 'string',
            enum: ['meeting_prep', 'coaching', 'improvement', 'use_case', 'insight'],
          },
          headline: { type: 'string' },
          body: { type: 'string' },
          actionLabel: { type: 'string' },
          actionPrompt: { type: 'string' },
          priority: { type: 'number' },
          sourceSessionId: { type: 'string' },
          sourceSkill: { type: 'string' },
          meetingStartTimeISO: { type: 'string', description: 'ISO 8601 datetime of the meeting start (meeting_prep only)' },
        },
        required: ['type', 'headline', 'body', 'actionLabel', 'actionPrompt', 'priority'],
        additionalProperties: false,
      },
    },
    weekSummary: { type: 'string' },
  },
  required: ['candidates', 'weekSummary'],
  additionalProperties: false,
};

// ---------------------------------------------------------------------------
// Raw LLM response shape
// ---------------------------------------------------------------------------

interface RawCandidate {
  type?: string;
  headline?: string;
  body?: string;
  actionLabel?: string;
  actionPrompt?: string;
  priority?: number;
  sourceSessionId?: string;
  sourceSkill?: string;
  meetingStartTimeISO?: string;
}

interface RawHeroChoiceResponse {
  candidates?: RawCandidate[];
  weekSummary?: string;
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function isValidCandidate(raw: RawCandidate): boolean {
  return (
    typeof raw.type === 'string' &&
    VALID_CANDIDATE_TYPES.has(raw.type) &&
    typeof raw.headline === 'string' &&
    raw.headline.length > 0 &&
    typeof raw.body === 'string' &&
    raw.body.length > 0 &&
    typeof raw.actionLabel === 'string' &&
    raw.actionLabel.length > 0 &&
    typeof raw.actionPrompt === 'string' &&
    raw.actionPrompt.length > 0 &&
    typeof raw.priority === 'number' &&
    raw.priority >= 1
  );
}

function parseMeetingStartTime(raw: RawCandidate): number | undefined {
  if (raw.type !== 'meeting_prep' || !raw.meetingStartTimeISO) return undefined;
  const ms = new Date(raw.meetingStartTimeISO).getTime();
  return Number.isFinite(ms) ? ms : undefined;
}

/** Strip leading emoji characters and whitespace from a string. */
function stripLeadingEmoji(text: string): string {
  return text.replace(/^[\p{Emoji_Presentation}\p{Extended_Pictographic}\u200d\ufe0f]+\s*/gu, '').trim();
}

function toCandidate(raw: RawCandidate): HeroChoiceCandidate {
  // Fields are guaranteed non-empty strings/numbers by isValidCandidate() filter upstream.
  // Fallbacks are defensive only — they never trigger at runtime.
  return {
    id: randomUUID(),
    type: raw.type as HeroChoiceCandidateType,
    headline: stripLeadingEmoji(raw.headline ?? ''),
    body: stripLeadingEmoji(raw.body ?? ''),
    actionLabel: raw.actionLabel ?? '',
    actionPrompt: raw.actionPrompt ?? '',
    priority: raw.priority ?? 1,
    meetingStartTime: parseMeetingStartTime(raw),
    sourceSessionId: raw.sourceSessionId,
    sourceSkill: raw.sourceSkill,
  };
}

// ---------------------------------------------------------------------------
// Main service function
// ---------------------------------------------------------------------------

/**
 * Generate hero choice recommendations by calling the LLM with assembled context.
 * Returns null on any failure (caller should preserve last successful result).
 */
/**
 * Resolve the effective model for hero choice generation.
 * Priority: explicit BTS override > thinking model > preferred Opus > BTS fallback.
 * This is the homepage centrepiece — quality over cost.
 */
/** @internal Exported for testing. */
export function resolveHeroChoiceModel(settings: AppSettings): string {
  // 1. Respect explicit user override for this task group
  const btsOverride = settings.behindTheScenesOverrides?.['hero-choice'];
  const normalizedOverride = normalizeStoredBtsModelValue(btsOverride);
  if (normalizedOverride.ok) {
    if (normalizedOverride.kind === 'profile') return `profile:${normalizedOverride.profileId}`;
    return normalizedOverride.modelId;
  }
  if (typeof btsOverride === 'string' && btsOverride.length > 0) {
    log.warn({
      siteId: 'heroChoiceService:resolveHeroChoiceModel:override',
      rawTruncated: btsOverride.slice(0, 32),
      rejectionReason: normalizedOverride.reason,
    }, `[resolveHeroChoiceModel] override rejected by normalizer: ${rejectionReasonLabel(normalizedOverride.reason)}; falling through to thinking-model cascade`);
  } else if (btsOverride != null && typeof btsOverride !== 'string') {
    log.warn({
      siteId: 'heroChoiceService:resolveHeroChoiceModel:override',
      rawType: typeof btsOverride,
      rejectionReason: normalizedOverride.reason,
    }, `[resolveHeroChoiceModel] override rejected non-string input by normalizer: ${rejectionReasonLabel(normalizedOverride.reason)}; falling through to thinking-model cascade`);
  }

  // 2. Use the thinking model (defaults to Opus) — this is the quality path
  const thinkingModel = getThinkingModel(settings);
  if (thinkingModel) return thinkingModel;

  // 3. Fall back to preferred Opus model
  return PREFERRED_PLANNING_MODEL;
}

export async function generateHeroChoice(
  deps: HeroChoiceContextDeps,
  settings: AppSettings,
): Promise<HeroChoiceResult | null> {
  try {
    // 1. Resolve model and context budget
    // Strip any [1m] suffix — the raw Messages API doesn't use it; extended
    // context is achieved simply by sending more tokens (model accepts up to 1M).
    const model = resolveHeroChoiceModel(settings).replace(/\[1m\]$/i, '');
    const useExtendedContext = modelSupportsExtendedContext(model);
    const contextBudget = useExtendedContext ? EXTENDED_CONTEXT_BUDGET : STANDARD_CONTEXT_BUDGET;

    // 2. Assemble context with model-appropriate budget
    const context = await assembleHeroChoiceContext(deps, contextBudget);

    if (!context || context.trim().length === 0) {
      log.info('No context available for hero choice generation — skipping');
      return null;
    }

    // 3. Build the user message
    const userMessage = `Here is everything you know about this user. Analyze it and produce your ranked recommendations.\n\n${context}`;

    log.info({ model, contextBudget, useExtendedContext }, 'Starting hero choice generation');

    const response = await callWithModelAuthAware(
      settings,
      model,
      {
        codexConnectivity: resolveCodexConnectivity(),
        system: getPrompt(PROMPT_IDS.INTELLIGENCE_HERO_CHOICE),
        messages: [{ role: 'user', content: userMessage }],
        maxTokens: 2048,
        outputFormat: {
          type: 'json_schema',
          schema: HERO_CHOICE_JSON_SCHEMA,
        },
        timeout: HERO_CHOICE_TIMEOUT_MS,
      },
      { category: 'hero-choice' },
    );

    // 4. Extract text from response
    const textBlock = response.content.find((block) => block.type === 'text');
    if (!textBlock?.text) {
      log.warn('Empty response from hero choice generation');
      return null;
    }

    // 5. Parse JSON
    const parsed = safeJsonParseFromModelText<RawHeroChoiceResponse>(
      textBlock.text,
      'heroChoice.generate',
      log,
    );
    if (!parsed) {
      return null;
    }

    // 6. Validate and transform candidates
    if (!Array.isArray(parsed.candidates) || parsed.candidates.length === 0) {
      log.warn('Hero choice response has no candidates');
      return null;
    }

    const now = Date.now();
    const validCandidates = parsed.candidates
      .filter(isValidCandidate)
      .map(toCandidate)
      .filter((c) => {
        // Reject meeting_prep for meetings already started at generation time
        if (c.type === 'meeting_prep' && c.meetingStartTime != null && c.meetingStartTime <= now) {
          log.info({ headline: c.headline, meetingStartTime: c.meetingStartTime }, 'Filtered expired meeting_prep candidate');
          return false;
        }
        return true;
      })
      .sort((a, b) => a.priority - b.priority);

    if (validCandidates.length === 0) {
      log.warn('No valid candidates after filtering');
      return null;
    }

    const weekSummary = typeof parsed.weekSummary === 'string' && parsed.weekSummary.length > 0
      ? parsed.weekSummary
      : 'Here\'s what stood out from your recent work.';

    const result: HeroChoiceResult = {
      candidates: validCandidates,
      weekSummary,
      generatedAt: Date.now(),
      modelUsed: response.model || model,
    };

    log.info(
      { candidateCount: validCandidates.length, model: result.modelUsed },
      'Hero choice generation complete',
    );

    return result;
  } catch (error) {
    if (error instanceof CodexDisconnectedBtsError) {
      log.error(
        { reason: 'codex-profile-bts-blocked', caller: 'heroChoice' },
        'Hero choice BTS blocked'
      );
      throw error;
    }

    const errMsg = error instanceof Error ? error.message : String(error);
    log.error({ error: errMsg }, 'Hero choice generation failed');
    return null;
  }
}
