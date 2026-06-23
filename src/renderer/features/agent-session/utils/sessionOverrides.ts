import type { ModelProfile, ThinkingEffort } from '@shared/types';
import type { ModelChoice } from '@shared/types/modelChoice';

export type SessionModelOverrideStateSlice = {
  sessionWorkingModel?: string;
  sessionThinkingModel?: string;
  sessionWorkingProfileId?: string;
  sessionThinkingProfileId?: string;
  sessionThinkingEffort?: ThinkingEffort;
};

export type SessionModelOverrideOptions = {
  modelOverride?: string;
  thinkingModelOverride?: string;
  workingProfileOverrideId?: string;
  thinkingProfileOverrideId?: string;
};

export type SessionModelOverridePayload = {
  modelOverride: string | undefined;
  thinkingModelOverride: string | undefined;
  workingProfileOverrideId: string | undefined;
  thinkingProfileOverrideId: string | undefined;
  thinkingEffortOverride: ThinkingEffort | undefined;
};

export function decodeSessionModelChoice(
  model: string | undefined,
  profileId: string | undefined,
): ModelChoice {
  if (profileId) return { kind: 'profile', profileId };
  if (model) return { kind: 'model', modelId: model };
  return { kind: 'off' };
}

export function encodeSessionModelChoice(
  choice: ModelChoice,
  profiles: readonly ModelProfile[] = [],
): { model: string | undefined; profileId: string | undefined } {
  switch (choice.kind) {
    case 'profile': {
      const profile = profiles.find((candidate) => candidate.id === choice.profileId);
      return {
        model: profile?.model || undefined,
        profileId: choice.profileId,
      };
    }
    case 'model':
      return { model: choice.modelId || undefined, profileId: undefined };
    case 'auto':
    case 'inherit':
    case 'off':
      return { model: undefined, profileId: undefined };
  }
}

/**
 * IMPORTANT — DO NOT "tidy" the two branches into one.
 *
 * Sites A (compaction) and C (edit-and-resend) want `||` semantics on every field,
 * including `thinkingModelOverride`. State `''` collapses to `undefined`.
 *
 * Site B (initiateAgentTurn) wants `??` on `thinkingModelOverride` so a caller can
 * pass `''` to mean "explicitly clear thinking model for this turn." With `||`,
 * that intent would silently fall through to the session default.
 *
 * Plan 260430 owns the broader `thinkingModelOverride: ''` semantics in the executor.
 * Plan 260503 introduced this helper (no behavior change).
 *
 * Site B MUST call with `options ?? {}` (not raw `options`) to keep the options-aware
 * branch active even when the caller passes no `options`.
 */
export function buildSessionModelOverrides(
  state: SessionModelOverrideStateSlice,
  options?: SessionModelOverrideOptions,
): SessionModelOverridePayload {
  if (!options) {
    return {
      modelOverride: state.sessionWorkingModel || undefined,
      thinkingModelOverride: state.sessionThinkingModel || undefined,
      workingProfileOverrideId: state.sessionWorkingProfileId || undefined,
      thinkingProfileOverrideId: state.sessionThinkingProfileId || undefined,
      thinkingEffortOverride: state.sessionThinkingEffort || undefined,
    };
  }

  return {
    modelOverride: options.modelOverride || state.sessionWorkingModel || undefined,
    thinkingModelOverride: options.thinkingModelOverride ?? state.sessionThinkingModel ?? undefined,
    workingProfileOverrideId: options.workingProfileOverrideId || state.sessionWorkingProfileId || undefined,
    thinkingProfileOverrideId: options.thinkingProfileOverrideId || state.sessionThinkingProfileId || undefined,
    thinkingEffortOverride: state.sessionThinkingEffort || undefined,
  };
}
