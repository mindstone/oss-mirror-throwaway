import type { MeetingCompanionTriggerMeta } from '@shared/types';

export const QUICK_ASK_FALLBACK_PROMPT = 'Ask Spark about this meeting';

export type BuildCompanionTurnPromptInput = MeetingCompanionTriggerMeta;

export interface BuildCompanionTurnPromptResult {
  prompt: string;
  meta: MeetingCompanionTriggerMeta;
}

function normalizeOptionalText(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function buildCompanionTurnPrompt(
  input: BuildCompanionTurnPromptInput,
): BuildCompanionTurnPromptResult {
  const triggerExtracted = normalizeOptionalText(input.triggerExtracted);
  const prompt = triggerExtracted ?? QUICK_ASK_FALLBACK_PROMPT;

  return {
    prompt,
    meta: {
      triggerSource: input.triggerSource,
      triggerSourceSpeaker: input.triggerSourceSpeaker,
      triggeredAt: input.triggeredAt,
      ...(triggerExtracted ? { triggerExtracted } : {}),
    },
  };
}
