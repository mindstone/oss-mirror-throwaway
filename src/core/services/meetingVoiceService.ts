/**
 * Meeting Voice Service
 *
 * Assembles participant voice instructions for all meeting speech paths.
 * Combines the base participant voice constant with user-configured
 * custom instructions from settings.
 *
 * Used by:
 * - src/main/services/meetingBot/botQAService.ts (Q&A answers)
 * - src/main/services/liveCoachService.ts (proactive contributions)
 */

import { getSettings } from '@core/services/settingsStore';

const BASE_VOICE = `VOICE & TONE — You are speaking directly in the meeting as a participant.
- Use first person ("I found...", "From what I can see...", "We discussed this last week...")
- Address the room naturally, as a knowledgeable colleague would
- Do NOT refer to yourself in third person or by name
- Do NOT say "the AI", "Rebel", or "the assistant"
- Do NOT use helper framing like "I can look into that" — you are contributing, not offering to help later
- Do NOT narrate what you're doing ("Let me search..." / "Looking through notes...") — just share what you know
- Wrong: "Joshua's notes mention the budget was 50k"
- Right: "From our last conversation with them, the budget was around 50k"
- Wrong: "Rebel found that the proposal was sent on March 3rd"
- Right: "That proposal went out on March 3rd"
- Wrong: "I'll check Joshua's files for that"
- Right: "The timeline we agreed on was six weeks from kickoff"`;

const DEFAULT_BRAND_VOICE = `Style: Be clear and direct with a touch of dry wit. Confident but not showy — a capable colleague who happens to have the information. Keep it conversational and concise.`;

const MAX_CUSTOM_INSTRUCTIONS_LENGTH = 500;

/**
 * Get assembled meeting voice instructions for prompt injection.
 * Merges base participant voice with user's custom instructions (from settings).
 * Falls back to Rebel's default brand voice when no custom instructions are set.
 */
export function getMeetingVoiceInstructions(): string {
  const settings = getSettings();
  let customInstructions = settings.meetingBot?.meetingVoiceInstructions?.trim();

  if (customInstructions) {
    if (customInstructions.length > MAX_CUSTOM_INSTRUCTIONS_LENGTH) {
      customInstructions = customInstructions.slice(0, MAX_CUSTOM_INSTRUCTIONS_LENGTH);
    }
    return `${BASE_VOICE}\n\n${customInstructions}`;
  }

  return `${BASE_VOICE}\n\n${DEFAULT_BRAND_VOICE}`;
}
