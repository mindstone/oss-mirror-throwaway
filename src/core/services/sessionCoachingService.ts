/**
 * Session Coaching Evaluation Service
 *
 * Analyzes completed conversations to identify missed opportunities where
 * Rebel could have provided more value. Uses a direct LLM call (not full agent)
 * to evaluate transcripts and suggest follow-up actions.
 */

import type { AppSettings, SessionCoachingEvaluation, SessionCoachingInsight, SessionCoachingCategory } from '@shared/types';
import { createScopedLogger } from '@core/logger';
import { callBehindTheScenesWithAuth } from './behindTheScenesClient';
import { safeJsonParseFromModelText } from '@shared/utils/safeJsonParse';
import { randomUUID } from 'node:crypto';
import { resolveCodexConnectivity } from '@core/rebelCore/codexConnectivity';

const log = createScopedLogger({ service: 'sessionCoaching' });

const COACHING_TIMEOUT_MS = 30000;
const MIN_RATING_THRESHOLD = 85;

export interface SkillSummary {
  name: string;
  description: string;
  category: string;
}

export interface SessionCoachingContext {
  sessionId: string;
  transcript: string;
  toolsAvailable: string[];
  toolsUsed: string[];
  messageCount: number;
  availableSkills?: SkillSummary[];
  skillsUsed?: string[];
}

export const COACHING_JSON_SCHEMA = {
  type: 'object',
  properties: {
    hasInsight: {
      type: 'boolean',
      description: 'Whether a valuable insight was found'
    },
    rating: {
      type: 'number',
      description: 'Quality rating 0-100. Only insights 85+ should be shown.'
    },
    insight: {
      type: 'string',
      description: 'The insight text, written conversationally as Rebel would say it'
    },
    context: {
      type: 'string',
      description: 'Brief context about why this matters'
    },
    continuationPrompt: {
      type: 'string',
      description: 'A ready-to-send prompt the user can use to act on this insight'
    },
    category: {
      type: 'string',
      enum: ['deeper_research', 'related_context', 'document_generation', 'follow_up_action', 'cross_reference', 'skill_opportunity', 'skill_personalization_opportunity'],
      description: 'Category of the missed opportunity'
    },
    suggestedSkill: {
      type: 'string',
      description: 'For skill_opportunity category: the exact skill name to suggest (e.g., "meeting-prep")'
    },
    reason: {
      type: 'string',
      description: 'If hasInsight is false, explain why no insight was found'
    }
  },
  required: ['hasInsight'],
  additionalProperties: false
};

export interface CoachingResponse {
  hasInsight: boolean;
  rating?: number;
  insight?: string;
  context?: string;
  continuationPrompt?: string;
  category?: string;
  suggestedSkill?: string;
  reason?: string;
}

export function isValidCategory(category: string | undefined): category is SessionCoachingCategory {
  return ['deeper_research', 'related_context', 'document_generation', 'follow_up_action', 'cross_reference', 'skill_opportunity', 'skill_personalization_opportunity'].includes(category ?? '');
}

export function parseCoachingResponseModelText(text: string): CoachingResponse | null {
  return safeJsonParseFromModelText<CoachingResponse>(
    text,
    'sessionCoaching.evaluate',
    log
  );
}

export const buildCoachingPrompt = (context: SessionCoachingContext): string => {
  const skillsSection = context.availableSkills && context.availableSkills.length > 0
    ? `## AVAILABLE SKILLS (not used in this session):
${context.availableSkills.map(s => `- @${s.name}: ${s.description}`).join('\n')}
`
    : '';

  return `You are analyzing a completed conversation to find ONE high-value missed opportunity.

## CRITICAL: Quality over quantity
- Only suggest insights that are SPECIFIC to this conversation
- The insight must reference actual content from the conversation
- Generic suggestions like "could have done more research" score 0
- If nothing valuable was missed, return hasInsight: false

## What makes a GREAT insight (85+):
- References specific names, dates, topics from the conversation
- Suggests a concrete next step the user would find valuable
- The continuation prompt is ready to send, not vague

## What makes a POOR insight (<85):
- Generic advice that could apply to any conversation
- Suggestions the user likely already knows
- Vague follow-ups like "look into this more"

## CATEGORY DECISION FLOW — follow this order:
1. **skill_opportunity** — Check FIRST. If an AVAILABLE SKILL listed below could have automated or substantially improved the work done manually in this conversation, this is the correct category. The skill must be relevant AND unused.
2. **skill_personalization_opportunity** — User has used a specific skill 3+ times and would benefit from personalizing it.
3. **related_context** — Check BEFORE deeper_research. The user's calendar, files, emails, or Slack contain relevant information that was NEVER mentioned in the conversation but would have added value. Example: user drafts a proposal but their calendar shows a relevant meeting tomorrow — Rebel should have proactively flagged the timing. Example: user prioritizes features but a recent strategy document (not referenced) contains relevant data. The insight MUST reference the specific external source (calendar event, file, channel) that should have been connected.
4. **deeper_research** — A specific information source was MENTIONED or clearly referenced in the conversation, but Rebel didn't search or analyze it thoroughly. Example: user says "we've been emailing back and forth" but Rebel didn't search the email history. Example: user mentions "the #pricing Slack channel" but Rebel didn't search it. The source must have been explicitly named or clearly implied.
5. **document_generation** — Could have created a document, summary, or artifact that wasn't created.
6. **follow_up_action** — There's an obvious next step that wasn't offered.
7. **cross_reference** — Could have connected this to another recent conversation.

## IMPORTANT CATEGORY DISTINCTIONS:
- **skill_opportunity vs deeper_research/related_context**: If an available skill (listed below) directly handles the type of work done in the conversation, use skill_opportunity — even if the insight also involves research or context. The skill is the primary value.
- **related_context vs deeper_research**: related_context = Rebel should have PROACTIVELY connected information from a source the user DIDN'T mention (calendar, files, other channels). deeper_research = the user DID mention or reference a source, but Rebel didn't search it thoroughly enough.
- **related_context vs document_generation/follow_up_action**: If the main missed opportunity is that Rebel should have checked the user's calendar, files, or other data sources to surface relevant context, use related_context — even if a document or follow-up could also apply.

## SKILL_OPPORTUNITY CRITERIA:
Use this category when ALL of these are true:
1. An available skill below is clearly relevant to the work performed in the conversation
2. The skill would have meaningfully improved the outcome (better quality, faster, more thorough)
3. The skill was NOT used (not in SKILLS ALREADY USED list)
4. The user did substantive work that the skill is designed for

For skill_opportunity: set suggestedSkill to the exact skill name, and the continuationPrompt should invoke it (e.g., "Use @meeting-prep/ to prepare for my meeting with...")

## SKILL_PERSONALIZATION_OPPORTUNITY CRITERIA (only suggest if ALL are true):
1. User has used a SPECIFIC skill 3+ times (check SKILLS ALREADY USED below)
2. The skill is general-purpose (meeting-prep, research, etc.)
3. User's usage shows consistent patterns (same format preferences, recurring context)
4. Personalizing would save significant repeated effort

For skill_personalization_opportunity: set suggestedSkill to the skill name.
continuationPrompt should say: "Use @customise-and-extend-skill/ to personalize [skill-name] with your preferences"

${skillsSection}## SKILLS ALREADY USED:
${context.skillsUsed && context.skillsUsed.length > 0 ? context.skillsUsed.join(', ') : 'None'}

## CONVERSATION:
${context.transcript}

## TOOLS USED:
${context.toolsUsed.length > 0 ? context.toolsUsed.join(', ') : 'None'}

Analyze this conversation. If you find a genuinely valuable missed opportunity, describe it as Rebel would - conversationally, with dry wit, referencing specifics. If nothing valuable was missed, that's fine - return hasInsight: false.`;
};

export async function evaluateSessionForCoaching(
  context: SessionCoachingContext,
  settings: AppSettings
): Promise<SessionCoachingEvaluation | null> {
  const { sessionId, messageCount } = context;

  if (messageCount < 3) {
    log.debug({ sessionId, messageCount }, 'Skipping coaching: conversation too short');
    return null;
  }

  log.info({ sessionId }, 'Starting coaching evaluation');

  try {
    const prompt = buildCoachingPrompt(context);

    const response = await callBehindTheScenesWithAuth(settings, {
      codexConnectivity: resolveCodexConnectivity(),
      messages: [{ role: 'user', content: prompt }],
      maxTokens: 1024,
      outputFormat: {
        type: 'json_schema',
        schema: COACHING_JSON_SCHEMA
      },
      timeout: COACHING_TIMEOUT_MS
    }, { category: 'coaching', sessionId });

    const textBlock = response.content.find((block) => block.type === 'text');
    if (!textBlock?.text) {
      log.warn({ sessionId }, 'Empty response from coaching evaluation');
      return null;
    }

    // Safe parse: fail-open (skip coaching if parsing fails)
    const parsed = parseCoachingResponseModelText(textBlock.text);
    if (!parsed) {
      return null;
    }

    if (!parsed.hasInsight) {
      log.debug({ sessionId, reason: parsed.reason }, 'No coaching insight found');
      return null;
    }

    const rating = parsed.rating ?? 0;
    if (rating < MIN_RATING_THRESHOLD) {
      log.debug({ sessionId, rating }, 'Coaching insight below quality threshold');
      return null;
    }

    if (!parsed.insight || !parsed.continuationPrompt) {
      log.warn({ sessionId }, 'Coaching response missing required fields');
      return null;
    }

    const category: SessionCoachingCategory = isValidCategory(parsed.category)
      ? parsed.category
      : 'deeper_research';

    const insight: SessionCoachingInsight = {
      id: randomUUID(),
      insight: parsed.insight,
      context: parsed.context,
      continuationPrompt: parsed.continuationPrompt,
      category,
      ...(category === 'skill_opportunity' && parsed.suggestedSkill && { suggestedSkill: parsed.suggestedSkill })
    };

    log.info({ sessionId, rating, category }, 'Coaching evaluation completed with insight');

    return {
      sessionId,
      evaluatedAt: Date.now(),
      primaryInsight: insight,
      state: 'pending'
    };
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    log.error({ sessionId, error: errMsg }, 'Coaching evaluation failed');
    return null;
  }
}
