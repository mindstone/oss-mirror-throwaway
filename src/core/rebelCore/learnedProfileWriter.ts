/**
 * Learned profile writer — records context-overflow evidence onto the
 * relevant `ModelProfile` so users can see, edit, and reset the runtime's
 * learned ceilings.
 *
 * Replaces the dedicated `rebel-core-learned-model-limits` store. See
 * docs/plans/260503_unify_learned_limits_into_profiles.md — Auto-Create
 * Policy.
 */
import { getBroadcastService } from '@core/broadcastService';
import { createScopedLogger } from '@core/logger';
import { updateSettingsAtomic } from '@core/services/settingsStore';
import type { AppSettings, ModelProfile } from '@shared/types';
import { isUserSetContextWindow, isUserSetMaxOutputTokens } from '@shared/utils/profileHelpers';
import {
  getKnownContextWindowForModel,
  getRegistryContextWindowForModel,
  getRegistryMaxOutputForModel,
} from '@shared/data/modelProviderPresets';
import { normalizeForCapabilityCheck } from './modelLimits';
import { getLearnedContextWindowEnabled } from './settingsAccessors';

const log = createScopedLogger({ service: 'learnedProfileWriter' });

const MIN_LEARNED_WINDOW = 10_000;

/**
 * Compute the safe learned context window from an overflow event.
 *
 * Margin: 10% on first event, tightening 2% per subsequent event up to a
 * cap at 5 events (margin floor 0.80). Floor: 10K tokens absolute minimum
 * to protect against spurious overflows at tiny token counts.
 */
export function computeSafeLearnedWindow(
  lastKnownInputTokens: number,
  overflowCount: number,
): number {
  const safetyMargin = 0.90 - (0.02 * Math.min(Math.max(overflowCount - 1, 0), 5));
  const learned = Math.floor(lastKnownInputTokens * safetyMargin);
  return Math.max(learned, MIN_LEARNED_WINDOW);
}

export interface RecordOverflowInput {
  /** Active execution model id at the time of the overflow. */
  model: string;
  /** Active execution profile id at the time of the overflow. Null when no profile was active. */
  profileId: string | null;
  /** Last known input token count from the overflowing iteration. */
  lastKnownInputTokens: number;
}

export interface RecordOutputCapInput {
  /** Active execution model id at the time of the invalid-request response. */
  model: string;
  /** Active execution profile id at the time of the invalid-request response. Null when no profile was active. */
  profileId: string | null;
  /** Observed max output tokens from provider error details. */
  observedCap: number;
}

export type WriteResult =
  | { ok: true; observedCap: number; profileId: string }
  | {
      ok: false;
      reason: 'user-source' | 'company-managed' | 'invalid-input' | 'persistence-failed';
    };

interface ResolvedProfileTarget {
  profile: ModelProfile;
  index: number;
  created: boolean;
}

function resolveProfileTarget(
  profiles: readonly ModelProfile[],
  input: { profileId: string | null; normalizedModel: string },
): ResolvedProfileTarget {
  if (input.profileId) {
    const idx = profiles.findIndex((p) => p.id === input.profileId);
    if (idx >= 0) return { profile: profiles[idx], index: idx, created: false };
  }

  const autoStubId = `auto:${input.normalizedModel}`;
  const autoIdx = profiles.findIndex((p) => p.id === autoStubId);
  if (autoIdx >= 0) {
    return { profile: profiles[autoIdx], index: autoIdx, created: false };
  }

  const matches = profiles
    .map((profile, index) => ({ profile, index }))
    .filter(({ profile }) => {
      if (profile.isVirtual) return false;
      if (!profile.model) return false;
      return normalizeForCapabilityCheck(profile.model) === input.normalizedModel;
    });

  if (matches.length === 1) {
    return { profile: matches[0].profile, index: matches[0].index, created: false };
  }
  if (matches.length > 1) {
    const enabled = matches.filter(
      (m) => m.profile.enabled !== false && m.profile.routingEligible,
    );
    const pool = enabled.length > 0 ? enabled : matches;
    pool.sort((a, b) => (a.profile.createdAt ?? 0) - (b.profile.createdAt ?? 0));
    return { profile: pool[0].profile, index: pool[0].index, created: false };
  }

  const stub: ModelProfile = {
    id: `auto:${input.normalizedModel}`,
    name: `${input.normalizedModel} (auto-detected)`,
    model: input.normalizedModel,
    providerType: 'other',
    serverUrl: '',
    enabled: false,
    isVirtual: true,
    createdAt: Date.now(),
  };
  return { profile: stub, index: -1, created: true };
}

function withProfileReplaced(
  profiles: readonly ModelProfile[],
  index: number,
  next: ModelProfile,
): ModelProfile[] {
  const copy = profiles.slice();
  if (index < 0) {
    copy.push(next);
  } else {
    copy[index] = next;
  }
  return copy;
}

/**
 * Record a context-overflow event on the relevant profile. Idempotent and
 * safe to call concurrently (the underlying `updateSettingsAtomic` runs the
 * read+write closure synchronously under Node's single-threaded event loop).
 *
 * Emits `options.sync = true` so the desktop adapter pushes the resulting
 * settings doc to the user's cloud instance via `cloudRouter.forward`.
 */
function buildOverflowUpdate(
  current: AppSettings,
  input: RecordOverflowInput,
  normalizedModel: string,
): Partial<AppSettings> {
  // Registry-authoritative guard (defense-in-depth, runs even when the flag is
  // on): if the model's context window is known to the registry/presets, the
  // registry wins — never persist a learned sidecar (and never mint an auto:
  // stub) for a catalogued model. The 0.9×lastKnownInputTokens heuristic below
  // survives ONLY for genuinely-unknown models. See PLAN.md Stage 1.
  const registryContextWindow =
    getRegistryContextWindowForModel(normalizedModel)
    ?? getKnownContextWindowForModel(normalizedModel);
  if (registryContextWindow != null) {
    log.info({
      model: input.model,
      normalizedModel,
      profileId: input.profileId,
      registryContextWindow,
      lastKnownInputTokens: input.lastKnownInputTokens,
    }, 'auto_learn_skipped_registry_known_context_window');
    return {};
  }

  const profiles = current.localModel?.profiles ?? [];
  const target = resolveProfileTarget(profiles, {
    profileId: input.profileId,
    normalizedModel,
  });

  if (target.profile.companyManaged) {
    log.info({
      profileId: target.profile.id,
      model: input.model,
      lastKnownInputTokens: input.lastKnownInputTokens,
    }, 'auto_learn_skipped_company_managed');
    return {};
  }

  const overflowCount = (target.profile.contextWindowOverflowCount ?? 0) + 1;
  const safeWindow = computeSafeLearnedWindow(input.lastKnownInputTokens, overflowCount);

  if (isUserSetContextWindow(target.profile)) {
    const currentValue = target.profile.contextWindow;
    const registryCeiling = getRegistryContextWindowForModel(target.profile.model)
      ?? getKnownContextWindowForModel(target.profile.model);
    const trapped = currentValue !== undefined
      && safeWindow < currentValue
      && (registryCeiling == null || currentValue > registryCeiling);

    if (trapped) {
      log.warn({
        profileId: target.profile.id,
        model: input.model,
        userValue: currentValue,
        registryCeiling,
        safeWindow,
        overflowCount,
      }, 'auto_learn_tightening_user_value');
      const next: ModelProfile = {
        ...target.profile,
        contextWindowSource: 'user',
        contextWindowOverflowCount: overflowCount,
        contextWindowLearnedAt: Date.now(),
        lastLearnedContextWindow: safeWindow,
      };
      const localModel = current.localModel ?? { profiles: [], activeProfileId: null };
      return {
        localModel: {
          ...localModel,
          profiles: withProfileReplaced(profiles, target.index, next),
        },
      };
    }

    log.info({
      profileId: target.profile.id,
      model: input.model,
      userValue: currentValue,
      safeWindow,
    }, 'auto_learn_skipped_user_value');
    return {};
  }

  const next: ModelProfile = {
    ...target.profile,
    contextWindow: safeWindow,
    contextWindowSource: 'auto',
    contextWindowOverflowCount: overflowCount,
    contextWindowLearnedAt: Date.now(),
    lastLearnedContextWindow: safeWindow,
  };

  if (target.created) {
    log.info({
      profileId: next.id,
      model: input.model,
      contextWindow: safeWindow,
    }, 'auto_learn_created_profile');
  } else {
    log.info({
      profileId: next.id,
      model: input.model,
      contextWindow: safeWindow,
      overflowCount,
    }, 'auto_learn_recorded');
  }

  const localModel = current.localModel ?? { profiles: [], activeProfileId: null };
  return {
    localModel: {
      ...localModel,
      profiles: withProfileReplaced(profiles, target.index, next),
    },
  };
}

function emitSettingsExternalUpdate(): void {
  try {
    getBroadcastService().sendToAllWindows('settings:external-update');
  } catch (err) {
    log.warn({ err }, 'auto_learn_broadcast_failed');
  }
}

export function recordContextOverflowOnProfile(input: RecordOverflowInput): void {
  if (input.lastKnownInputTokens <= 0) return;

  const normalizedModel = normalizeForCapabilityCheck(input.model);

  let didWrite = false;
  try {
    updateSettingsAtomic(
      (current: AppSettings): Partial<AppSettings> => {
        // Master kill-switch (default-off): when the flag is not explicitly
        // enabled, the context-window auto-learn writer is a complete no-op —
        // no mutation, no auto: stub, and (because didWrite stays false) no
        // settings:external-update broadcast. Read from `current` so the gate
        // is atomic with the write decision. See PLAN.md Stage 1.
        if (getLearnedContextWindowEnabled(current) !== true) {
          return {};
        }
        const patch = buildOverflowUpdate(current, input, normalizedModel);
        if (Object.keys(patch).length > 0) didWrite = true;
        return patch;
      },
      { sync: true },
    );
  } catch (err) {
    log.error({
      err,
      model: input.model,
      profileId: input.profileId,
    }, 'auto_learn_write_failed');
    return;
  }

  if (didWrite) emitSettingsExternalUpdate();
}

export function recordOutputCapOnProfile(input: RecordOutputCapInput): WriteResult {
  let observedCap = Number.isFinite(input.observedCap)
    ? Math.floor(input.observedCap)
    : NaN;
  if (observedCap <= 0) {
    return { ok: false, reason: 'invalid-input' };
  }

  const normalizedModel = normalizeForCapabilityCheck(input.model);
  if (!normalizedModel) {
    return { ok: false, reason: 'invalid-input' };
  }

  const registryMax = getRegistryMaxOutputForModel(input.model);
  if (registryMax !== undefined && observedCap > registryMax) {
    log.warn(
      { model: input.model, observedCap, registryMax },
      'auto_learn_output_cap_exceeds_registry',
    );
    observedCap = Math.min(observedCap, registryMax);
  }

  let writeResult: WriteResult = { ok: false, reason: 'invalid-input' };

  try {
    updateSettingsAtomic(
      (current: AppSettings): Partial<AppSettings> => {
        const profiles = current.localModel?.profiles ?? [];
        const target = resolveProfileTarget(profiles, {
          profileId: input.profileId,
          normalizedModel,
        });

        if (target.profile.companyManaged) {
          log.info({
            profileId: target.profile.id,
            model: input.model,
            observedCap,
          }, 'auto_learn_output_cap_skipped_company_managed');
          writeResult = { ok: false, reason: 'company-managed' };
          return {};
        }

        if (isUserSetMaxOutputTokens(target.profile)) {
          log.info({
            profileId: target.profile.id,
            model: input.model,
            observedCap,
            userValue: target.profile.maxOutputTokens,
          }, 'auto_learn_output_cap_skipped_user_value');
          writeResult = { ok: false, reason: 'user-source' };
          return {};
        }

        const nextCap = target.profile.maxOutputTokens === undefined
          ? observedCap
          : Math.min(target.profile.maxOutputTokens, observedCap);
        const next: ModelProfile = {
          ...target.profile,
          maxOutputTokens: nextCap,
          outputTokensSource: 'auto',
          outputTokensOverflowCount: (target.profile.outputTokensOverflowCount ?? 0) + 1,
          outputTokensLearnedAt: Date.now(),
          lastLearnedOutputTokens: nextCap,
        };

        if (target.created) {
          log.info({
            profileId: next.id,
            model: input.model,
            observedCap,
            recordedCap: nextCap,
          }, 'auto_learn_output_cap_created_profile');
        } else {
          log.info({
            profileId: next.id,
            model: input.model,
            observedCap,
            recordedCap: nextCap,
          }, 'auto_learn_output_cap_recorded');
        }

        writeResult = { ok: true, observedCap, profileId: next.id };

        const localModel = current.localModel ?? { profiles: [], activeProfileId: null };
        return {
          localModel: {
            ...localModel,
            profiles: withProfileReplaced(profiles, target.index, next),
          },
        };
      },
      { sync: true },
    );
  } catch (err) {
    log.error({
      err,
      model: input.model,
      profileId: input.profileId,
      observedCap,
    }, 'auto_learn_output_cap_write_failed');
    return { ok: false, reason: 'persistence-failed' };
  }

  if (writeResult.ok) emitSettingsExternalUpdate();
  return writeResult;
}
