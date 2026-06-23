import type { ModelProfile } from '@shared/types';

export const REASONING_REPLAY_CAPABLE_MODEL_PATTERNS: readonly RegExp[] = [
  /^deepseek-/i,
];

export function computeSupportsReasoningReplay(
  profile: Pick<ModelProfile, 'presetKey'> | undefined | null,
  modelName: string | undefined,
): boolean {
  if (profile?.presetKey === 'local:ds4') return true;
  if (!modelName) return false;
  // Match against the LAST path segment so provider-prefixed ids are covered:
  // the catalogued/OpenRouter DeepSeek backends are slash-prefixed —
  // `deepseek/deepseek-v4-flash` (the OpenRouter BTS default), `deepseek/deepseek-v4-pro`,
  // `deepseek-ai/deepseek-v4-pro` — and a bare `^deepseek-` test would miss the
  // `deepseek/` forms entirely. The final segment (`deepseek-v4-flash`) matches for all
  // spellings, while non-DeepSeek ids (`openai/gpt-5.5` → `gpt-5.5`) still don't.
  const lastSegment = modelName.includes('/') ? (modelName.split('/').pop() ?? modelName) : modelName;
  if (REASONING_REPLAY_CAPABLE_MODEL_PATTERNS.some((pattern) => pattern.test(lastSegment))) {
    return true;
  }
  return false;
}

export function getThinkingRetentionTurns(supportsReasoningReplay: boolean): number {
  return supportsReasoningReplay ? 50 : 2;
}
