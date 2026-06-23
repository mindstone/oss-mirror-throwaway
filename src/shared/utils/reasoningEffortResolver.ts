import type { ThinkingEffort } from '@shared/types/settings';

export type SkillReasoningEffort = 'low' | 'medium' | 'high' | 'max';

export interface ResolveReasoningEffortInputs {
  readonly envEffort?: string | undefined;
  readonly sessionEffort?: ThinkingEffort | undefined;
  readonly modelId?: string | undefined;
  readonly modelEfforts?: Partial<Record<string, ThinkingEffort>> | undefined;
  readonly globalEffort?: ThinkingEffort | undefined;
  readonly profileEffort?: string | undefined;
  readonly skillEfforts?: ReadonlyArray<SkillReasoningEffort> | undefined;
  readonly defaultEffort?: ThinkingEffort | undefined;
}

const THINKING_EFFORT_RANK: Record<ThinkingEffort, number> = {
  low: 0,
  medium: 1,
  high: 2,
  xhigh: 3,
};

const SKILL_EFFORT_TO_THINKING_EFFORT: Record<SkillReasoningEffort, ThinkingEffort> = {
  low: 'low',
  medium: 'medium',
  high: 'high',
  max: 'xhigh',
};

function normalizeThinkingEffort(value: string | undefined): ThinkingEffort | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  switch (normalized) {
    case 'low':
    case 'medium':
    case 'high':
    case 'xhigh':
      return normalized;
    default:
      // eslint-disable-next-line rebel-switch-exhaustiveness/no-bare-default-bypass -- open normalized-string input; undefined is the intended reject-unknown result.
      return undefined;
  }
}

function normalizeProfileEffort(value: string | undefined): ThinkingEffort | undefined {
  const normalized = normalizeThinkingEffort(value);
  if (normalized) return normalized;
  return value?.trim().toLowerCase() === 'max' ? 'xhigh' : undefined;
}

function maxEffort(
  left: ThinkingEffort | undefined,
  right: ThinkingEffort | undefined,
): ThinkingEffort | undefined {
  if (!left) return right;
  if (!right) return left;
  return THINKING_EFFORT_RANK[right] > THINKING_EFFORT_RANK[left] ? right : left;
}

function resolveSkillFloor(
  skillEfforts: ReadonlyArray<SkillReasoningEffort> | undefined,
): ThinkingEffort | undefined {
  return skillEfforts?.reduce<ThinkingEffort | undefined>((highest, effort) => (
    maxEffort(highest, SKILL_EFFORT_TO_THINKING_EFFORT[effort])
  ), undefined);
}

export function resolveReasoningEffort(
  inputs: ResolveReasoningEffortInputs & { readonly defaultEffort: ThinkingEffort },
): ThinkingEffort;
export function resolveReasoningEffort(
  inputs: ResolveReasoningEffortInputs,
): ThinkingEffort | undefined;
export function resolveReasoningEffort({
  envEffort,
  sessionEffort,
  modelId,
  modelEfforts,
  globalEffort,
  profileEffort,
  skillEfforts,
  defaultEffort,
}: ResolveReasoningEffortInputs): ThinkingEffort | undefined {
  const envOverride = normalizeThinkingEffort(envEffort);
  const baseEffort = (modelId ? modelEfforts?.[modelId] : undefined)
    ?? globalEffort
    ?? defaultEffort;

  // CHARACTERIZATION: this reproduces the current turn-level precedence:
  // shell env > session override > profile override > max(per-model/global/default, skill floor).
  return envOverride
    ?? sessionEffort
    ?? normalizeProfileEffort(profileEffort)
    ?? maxEffort(baseEffort, resolveSkillFloor(skillEfforts));
}
