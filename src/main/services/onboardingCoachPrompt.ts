import { getPrompt, PROMPT_IDS } from '@core/services/promptFileService';

/**
 * Get the onboarding coach prompt (lazy access to externalized prompt file).
 * Prompt text is in `rebel-system/prompts/utility/onboarding-coach.md`.
 */
export function getOnboardingCoachPrompt(): string {
  return getPrompt(PROMPT_IDS.UTILITY_ONBOARDING_COACH);
}
