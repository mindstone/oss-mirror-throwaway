/**
 * Community Share Evaluation Service
 *
 * Evaluates post-session eligibility for community win sharing and composes
 * anonymized Discourse posts for the Rebels Show & Tell category.
 *
 * Two-phase design:
 * 1. `checkSessionEligibility()` — pure function, no LLM call. Checks time + impact thresholds.
 * 2. `composeCommunitySharePost()` — called ON DEMAND when user clicks "Preview & Share".
 *    Uses behind-the-scenes LLM to compose an anonymized first-person post.
 */

import type { AgentSession, AppSettings, CommunityShareEligibility, CommunitySharePreview, ImpactLevel } from '@shared/types';
import type { AgentErrorKind } from '@shared/utils/agentErrorCatalog';
import { getErrorKind } from '@shared/utils/agentErrorCatalog';
import { createScopedLogger } from '@core/logger';
import { callBehindTheScenesWithAuth } from './behindTheScenesClient';
import { safeJsonParseFromModelText } from '@shared/utils/safeJsonParse';
import { getSessionTimeSavedSummary } from './timeSavedStore';
import { humanizeAgentError } from '@rebel/shared';
import { ModelError } from '@core/rebelCore/modelErrors';
import { resolveCodexConnectivity } from '@core/rebelCore/codexConnectivity';

const log = createScopedLogger({ service: 'communityShare' });

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const COMMUNITY_SHARE_THRESHOLD_MINUTES = 300; // 5 hours
const COMMUNITY_SHARE_COMPOSITION_TIMEOUT_MS = 60000;
const DISCOURSE_BASE_URL = 'https://rebels.mindstone.com';
const SHOW_AND_TELL_CATEGORY_ID = 6;

// ─────────────────────────────────────────────────────────────────────────────
// Celebration Quips
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Pool of celebration quips shown in the community win card header.
 * Rebel's voice: dry, witty, understated.
 * Quips containing `{time}` get the actual time saved substituted in.
 */
const CELEBRATION_QUIPS = [
  '{time}. Not bad for a Tuesday.',
  'You got {time} back. The universe rarely offers refunds.',
  "That was worth more than most meetings. And I attend all of them.",
  "{time} of your life, reclaimed. You're welcome.",
  "{time} saved. That's practically a half-day sabbatical.",
  "The ROI on that one? Let's just say it's favourable.",
  'Some things are worth celebrating quietly. This is one of them.',
  'That just freed up enough time for a proper lunch.',
  'Consider that a down payment on your weekend.',
  'If time is money, you just got a raise.',
  '{time} saved. Smugness: optional but deserved.',
  'Your future self just sent a thank-you note.',
];

/**
 * Pick a random quip and substitute the formatted time saved value.
 */
export function getRandomQuip(timeSavedFormatted: string): string {
  const index = Math.floor(Math.random() * CELEBRATION_QUIPS.length);
  return CELEBRATION_QUIPS[index].replace(/\{time\}/g, timeSavedFormatted);
}

// ─────────────────────────────────────────────────────────────────────────────
// Time Formatting
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Format minutes into a human-readable string.
 * Follows the same pattern as `formatEstimateForDisplay` in timeSavedService.
 */
function formatMinutesForDisplay(totalMinutes: number): string {
  const rounded = Math.round(totalMinutes);
  if (rounded < 60) {
    return `${rounded} min`;
  }
  const hours = rounded / 60;
  if (hours < 10) {
    return `${hours.toFixed(1)}h`;
  }
  return `${Math.round(hours)}h`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Eligibility Check (pure, no LLM)
// ─────────────────────────────────────────────────────────────────────────────

const ELIGIBLE_IMPACT_LEVELS: ImpactLevel[] = ['high', 'critical'];

/**
 * Check whether a session qualifies for a community share prompt.
 * Returns eligibility with a quip if qualified, null otherwise.
 *
 * Criteria:
 * - Weighted midpoint time saved >= 300 minutes (5 hours)
 * - Highest impact is 'high' or 'critical'
 */
export function checkSessionEligibility(sessionId: string): CommunityShareEligibility | null {
  const summary = getSessionTimeSavedSummary(sessionId);

  if (summary.totalMinutes < COMMUNITY_SHARE_THRESHOLD_MINUTES) {
    log.debug({ sessionId, totalMinutes: summary.totalMinutes }, 'Session below time threshold for community share');
    return null;
  }

  if (!summary.highestImpact || !ELIGIBLE_IMPACT_LEVELS.includes(summary.highestImpact)) {
    log.debug({ sessionId, impact: summary.highestImpact }, 'Session impact below threshold for community share');
    return null;
  }

  const timeSavedFormatted = formatMinutesForDisplay(summary.totalMinutes);
  const quip = getRandomQuip(timeSavedFormatted);

  log.info(
    { sessionId, totalMinutes: summary.totalMinutes, impact: summary.highestImpact },
    'Session eligible for community share'
  );

  return {
    sessionId,
    timeSavedMinutes: summary.totalMinutes,
    timeSavedFormatted,
    impact: summary.highestImpact,
    quip,
    evaluatedAt: Date.now(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// PII Scrubbing (deterministic safety net)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Deterministic regex pass to strip PII as a safety net after LLM anonymization.
 *
 * Philosophy: the LLM is the primary anonymizer. This pass only catches identifiers
 * that could deanonymize the user, their company, or their clients. It deliberately
 * does NOT strip impact context (hours saved, deal size, scope) — that's the story
 * the user is sharing.
 */
export function scrubPII(text: string): string {
  let scrubbed = text;

  scrubbed = scrubbed.replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, '[redacted]');

  scrubbed = scrubbed.replace(/(?:\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/g, '[redacted]');

  // Unix file paths. Tilde branch requires a `/` after `~` so it doesn't eat
  // the `~5h`-style time figure in titles like "How I saved ~5h on meeting prep".
  scrubbed = scrubbed.replace(/(?:~\/|\/(?:Users|home|var|tmp|opt|etc)\/)\S+/g, '[redacted]');

  scrubbed = scrubbed.replace(/[A-Z]:\\(?:Users|Documents|Downloads)\\\S+/gi, '[redacted]');

  scrubbed = scrubbed.replace(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, '[redacted]');

  scrubbed = scrubbed.replace(/https?:\/\/\S+/g, '[redacted]');

  scrubbed = scrubbed.replace(/\b\d+\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?\s+(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Drive|Dr|Lane|Ln|Way|Court|Ct|Place|Pl)\b/gi, '[redacted]');

  return scrubbed;
}

// ─────────────────────────────────────────────────────────────────────────────
// Post Composition (on-demand LLM call)
// ─────────────────────────────────────────────────────────────────────────────

export const COMMUNITY_SHARE_JSON_SCHEMA = {
  type: 'object',
  properties: {
    title: {
      type: 'string',
      description: 'Post title, 50-100 chars, starts with "How I saved ~Xh on..."',
    },
    body: {
      type: 'string',
      description: 'Post body, 80-800 chars, markdown, first-person from user, matter-of-fact',
    },
  },
  required: ['title', 'body'],
  additionalProperties: false,
};

interface CommunityShareLLMResponse {
  title: string;
  body: string;
}

export type CommunityShareComposeResult =
  | { success: true; preview: CommunitySharePreview }
  | { success: false; error: string; errorKind: AgentErrorKind };

/** Maximum transcript size for community share composition (~12k chars).
 *  The LLM only produces a 200-800 char anonymized post, so a small context window suffices. */
const MAX_COMMUNITY_TRANSCRIPT_CHARS = 12_000;

/** Portion of the budget reserved for the start of the conversation (initial context). */
const INITIAL_CONTEXT_CHARS = 3_000;

const TRUNCATION_MARKER = '\n\n[...middle of conversation truncated...]\n\n';

function buildTranscript(session: AgentSession): string {
  let transcript = session.messages
    .map(m => `[${m.role}]: ${m.text?.slice(0, 1000) ?? ''}`)
    .join('\n\n');

  // Tail-biased truncation: keep initial context + recent messages (most representative for post)
  if (transcript.length > MAX_COMMUNITY_TRANSCRIPT_CHARS) {
    const tailBudget = MAX_COMMUNITY_TRANSCRIPT_CHARS - INITIAL_CONTEXT_CHARS - TRUNCATION_MARKER.length;

    log.info(
      { sessionId: session.id, originalLength: transcript.length },
      'Community share transcript exceeds cap, using tail-biased truncation'
    );

    const head = transcript.slice(0, INITIAL_CONTEXT_CHARS);
    const tail = transcript.slice(-tailBudget);
    transcript = head + TRUNCATION_MARKER + tail;
  }

  return transcript;
}

export function buildCompositionPrompt(transcript: string, timeSavedFormatted: string): string {
  return `You are composing a short community forum post for a user who just had a productive session with their AI assistant. Write as if you ARE the user sharing their experience.

## OUTPUT REQUIREMENTS
- title: 50-100 characters, starts with "How I saved ~${timeSavedFormatted} on..."
- body: 80-800 characters, markdown, first-person, matter-of-fact tone
- End the body with: "\\n\\n---\\n*Shared via Rebel. Details anonymized.*"

## TIME-SAVED FIGURE
The time saved amount (~${timeSavedFormatted}) comes from session metadata and is authoritative.
- Use it exactly as provided in the title. Do NOT substitute your own estimate.
- In the body, you may reference this figure but do NOT invent additional time claims (e.g., "spent 2 hours", "took 30 minutes") unless the transcript explicitly states them.

## ANONYMIZATION (critical)
Only strip things that could identify the user, their company, or their clients.
The point of the post is to describe the activity and impact — keep that intact.

You MUST strip:
- Personal names (people, contacts, colleagues)
- Company, client, organization, and brand names
- Email addresses, phone numbers, physical addresses
- File paths, URLs, IP addresses
- Specific account / invoice / reference numbers (e.g., ACC-12345, INV-789)
- Identifying project codenames (anything that would let someone Google the company)

You MUST preserve:
- The time saved figure (~${timeSavedFormatted})
- The activity / use case (e.g., "meeting prep", "research synthesis", "email triage", "board deck draft")
- The domain context (e.g., "client meeting", "quarterly review", "vendor evaluation", "fundraise update")
- Impact figures and outcomes (deal size, headcount, scope, dollar figures, dates) when they don't directly identify a specific party
- Generic role / industry references (e.g., "our CFO", "the design team", "a SaaS prospect")
- The texture of what made the session valuable

## ACCURACY RULES (critical — violation = failure)
- Describe ONLY what actually happened in the transcript. Do NOT invent interactions, outcomes, details, or numbers.
- If anonymization strips away most specifics, write a shorter but honest post. 80 chars is fine — brevity beats fabrication.
- NEVER pad with invented details to reach a target length. A 100-char truthful post is better than a 300-char fabricated one.
- If the transcript mentions a specific tool, feature, or workflow step, you may reference it. If it does not, do not invent one.

## TASK SCOPE GUARD
If the transcript shows a SINGLE task (one email, one document, one query), describe ONLY that task. Do NOT inflate it into "a series of emails", "multiple iterations", or "workflow development".

## LOW-CONTENT FALLBACK
If anonymization strips away most of the transcript content, use this safe template as a starting point:
"I used my AI assistant for [task type]. Saved ~[time]. The assistant handled [brief action] efficiently."
Do NOT pad with invented specifics. A short, honest post is always better than a long, fabricated one.

## TONE
- ALWAYS use first-person pronouns (I, my, me) — even for technical content.
- Matter-of-fact, professional tone with optional dry appreciation.
- Keep it concise. This is a forum post, not a tutorial or testimonial.

## BANNED PHRASES (never use any of these in the output)
amazing, incredible, revolutionary, game-changer, blown away, absolutely love, highly recommend

## SESSION TRANSCRIPT
${transcript}

Write the post now.`;
}

/**
 * Compose an anonymized community share post using behind-the-scenes LLM.
 * Called on demand when the user clicks "Preview & Share".
 */
export async function composeCommunitySharePost(
  session: AgentSession,
  settings: AppSettings
): Promise<CommunityShareComposeResult> {
  const sessionId = session.id;

  const summary = getSessionTimeSavedSummary(sessionId);
  const timeSavedFormatted = formatMinutesForDisplay(summary.totalMinutes);

  log.info({ sessionId, timeSavedFormatted }, 'Composing community share post');

  try {
    const transcript = buildTranscript(session);
    const prompt = buildCompositionPrompt(transcript, timeSavedFormatted);

    const response = await callBehindTheScenesWithAuth(settings, {
      codexConnectivity: resolveCodexConnectivity(),
      messages: [{ role: 'user', content: prompt }],
      maxTokens: 1024,
      outputFormat: {
        type: 'json_schema',
        schema: COMMUNITY_SHARE_JSON_SCHEMA,
      },
      timeout: COMMUNITY_SHARE_COMPOSITION_TIMEOUT_MS,
    }, { category: 'communityShare', sessionId });

    const textBlock = response.content.find((block) => block.type === 'text');
    if (!textBlock?.text) {
      log.warn({ sessionId }, 'Empty response from community share composition');
      return {
        success: false,
        error: 'Could not compose the post. Try again?',
        errorKind: 'invalid_request',
      };
    }

    const parsed = safeJsonParseFromModelText<CommunityShareLLMResponse>(
      textBlock.text,
      'communityShare.compose',
      log
    );
    if (!parsed) {
      return {
        success: false,
        error: 'Could not compose the post. Try again?',
        errorKind: 'invalid_request',
      };
    }

    if (!parsed.title || !parsed.body) {
      log.warn({ sessionId }, 'Community share response missing title or body');
      return {
        success: false,
        error: 'Could not compose the post. Try again?',
        errorKind: 'invalid_request',
      };
    }

    // Deterministic PII scrubbing as safety net
    const scrubbedTitle = scrubPII(parsed.title);
    const scrubbedBody = scrubPII(parsed.body);

    log.info({ sessionId }, 'Community share post composed successfully');

    return {
      success: true,
      preview: {
        sessionId,
        title: scrubbedTitle,
        body: scrubbedBody,
        timeSavedMinutes: summary.totalMinutes,
        timeSavedFormatted,
        impact: summary.highestImpact ?? 'high',
        quip: getRandomQuip(timeSavedFormatted),
        composedAt: Date.now(),
      },
    };
  } catch (error) {
    const rawError = error instanceof Error ? error.message : String(error);
    // Stage 6b migration: classification-first humanization.
    // See docs/plans/260421_classification_driven_error_humanizer.md.
    const humanized = humanizeAgentError(
      error instanceof ModelError
        ? {
            kind: 'classified',
            errorKind: error.__agentErrorKind,
            rawMessage: error.__rawMessage,
            provider: error.provider,
            upstreamProviderName: error.upstreamProvider,
          }
        : { kind: 'unclassified', rawMessage: rawError },
    );
    const errorKind = getErrorKind(error);
    log.error({ sessionId, error: humanized }, 'Community share post composition failed');
    return {
      success: false,
      error: humanized,
      errorKind,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Discourse URL Builder
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build a Discourse new-topic URL with pre-filled title.
 * Body is handled via clipboard (URL length limits).
 */
export function buildDiscourseNewTopicUrl(title: string): string {
  const encodedTitle = encodeURIComponent(title);
  return `${DISCOURSE_BASE_URL}/new-topic?title=${encodedTitle}&category_id=${SHOW_AND_TELL_CATEGORY_ID}`;
}
