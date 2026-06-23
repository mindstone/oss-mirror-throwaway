/**
 * One-time migrations for the learned-limits unification (Stage 2) plus the
 * learned-context-window poison reset (Part C).
 *
 * Three parts run independently and idempotently:
 *
 * Part A — Provenance disambiguation. For each non-virtual profile with
 * `contextWindow` set and `contextWindowSource` undefined, decide whether
 * the value came from the registry (clear) or was a manual entry (stamp
 * `'user'`). Gated on `localModel.registryStampMigratedAt`.
 *
 * Part B — Legacy learned-store import. Read the legacy
 * `rebel-core-learned-model-limits` store, drop TTL-expired entries, and
 * write fresh entries onto the relevant profiles as `'auto'`. CATALOGUED
 * models are skipped entirely (registry wins — Stage 5): importing a legacy
 * learned context window for a catalogued model would re-mint the same poison
 * the writer-guard + Part C eliminate. Gated on
 * `localModel.learnedLimitsMigratedAt`.
 *
 * Part C — Learned context-window poison reset. For each profile whose model
 * is CATALOGUED (registry/preset context window non-null), clear the poisoned
 * `source:'auto'` learned context-window sidecar so resolution falls back to
 * the registry; on `source:'user'` catalogued profiles, clear only the stray
 * learned-sidecar provenance while preserving the user's actual contextWindow.
 * Genuinely-unknown models (no registry entry) are left untouched. Gated on
 * `localModel.learnedContextWindowPoisonResetAt`. See
 * docs/plans/260529_fix-learned-context-window/PLAN.md — Stage 2.
 *
 * All parts run in order each boot, but each is no-op once its timestamp
 * is set. Failure in any part is logged and migration retries on the
 * next boot. See docs/plans/260503_unify_learned_limits_into_profiles.md
 * — Migration.
 */
import { createScopedLogger } from '@core/logger';
import { createStore } from '@core/storeFactory';
import { getSettings, updateSettingsAtomic } from '@core/services/settingsStore';
import type { ModelProfile } from '@shared/types';
import {
  getKnownContextWindowForModel,
  getRegistryContextWindowForModel,
} from '@shared/data/modelProviderPresets';
import { normalizeForCapabilityCheck } from './modelLimits';

const log = createScopedLogger({ service: 'learnedLimitsMigration' });

const LEGACY_TTL_MS = 24 * 60 * 60 * 1000;

interface LegacyLimitEntry {
  contextWindow: number;
  learnedAt: number;
  overflowCount: number;
}

interface LegacyState extends Record<string, unknown> {
  limits: Record<string, LegacyLimitEntry>;
}

interface PartAStats {
  registryDisambiguated: number;
  registryStamped: number;
  skippedVirtual: number;
}

interface PartBStats {
  migrated: number;
  skippedExpired: number;
  skippedUserOverride: number;
  /** Catalogued models whose legacy auto context-window was NOT imported (registry wins). */
  skippedCatalogued: number;
  created: number;
}

interface PartCStats {
  /** Catalogued `source:'auto'` profiles whose learned sidecar was fully cleared. */
  autoCleared: number;
  /** Catalogued `source:'user'` profiles whose stray learned sidecar was cleared (value preserved). */
  userSidecarCleared: number;
}

/**
 * Whether `model` is catalogued — i.e. its context window is known to the
 * Anthropic registry or the cross-provider presets. Uses the normalized id so
 * provider-prefixed / dotted / `[1m]`-suffixed variants resolve identically to
 * the writer's registry guard (Stage 1). Genuinely-unknown models return false.
 */
function isCataloguedContextWindowModel(model: string | undefined): boolean {
  if (!model) return false;
  const normalized = normalizeForCapabilityCheck(model);
  const registry =
    getRegistryContextWindowForModel(normalized) ??
    getKnownContextWindowForModel(normalized);
  return registry !== null;
}

/**
 * Strip the learned context-window sidecar provenance fields from a profile.
 * Returns a new profile object only when something actually changed (so callers
 * can decide whether the migration did work). Never touches output-cap sidecar
 * fields (maxOutputTokens / outputTokensSource / lastLearnedOutputTokens) or any
 * non-context-window field.
 *
 * @param clearValue when true, also clears `contextWindow` + `contextWindowSource`
 *        (the `source:'auto'` case — the value itself is the poison). When false,
 *        preserves `contextWindow` + `contextWindowSource` (the `source:'user'`
 *        case — only strip stray learned provenance).
 */
function stripLearnedContextWindowSidecar(
  profile: ModelProfile,
  clearValue: boolean,
): ModelProfile | null {
  const next: Record<string, unknown> = { ...profile };
  let changed = false;
  const drop = (key: keyof ModelProfile) => {
    if (next[key] !== undefined) {
      delete next[key];
      changed = true;
    }
  };

  if (clearValue) {
    drop('contextWindow');
    drop('contextWindowSource');
  }
  drop('contextWindowOverflowCount');
  drop('contextWindowLearnedAt');
  drop('lastLearnedContextWindow');

  return changed ? (next as unknown as ModelProfile) : null;
}

/**
 * Part C — Reset already-persisted poisoned learned context windows on
 * catalogued models so resolution falls back to the registry.
 *
 * Idempotent: gated on `localModel.learnedContextWindowPoisonResetAt`. Atomic +
 * synced so cloud/mobile copies are repaired. Returns null when the migration
 * has already run (no work); otherwise the stats for the run that just executed.
 */
function runLearnedContextWindowPoisonReset(): PartCStats | null {
  const stats: PartCStats = {
    autoCleared: 0,
    userSidecarCleared: 0,
  };
  let didWork = false;

  updateSettingsAtomic((current) => {
    if (current.localModel?.learnedContextWindowPoisonResetAt) {
      return {};
    }
    const profiles = current.localModel?.profiles ?? [];
    const next: ModelProfile[] = profiles.map((profile) => {
      if (!isCataloguedContextWindowModel(profile.model)) {
        // Genuinely-unknown model: preserve the legit auto value.
        return profile;
      }
      if (profile.contextWindowSource === 'auto') {
        const cleared = stripLearnedContextWindowSidecar(profile, true);
        if (cleared) {
          stats.autoCleared += 1;
          return cleared;
        }
        return profile;
      }
      if (profile.contextWindowSource === 'user') {
        // Preserve the user's intentional contextWindow + source; only strip
        // stray learned-sidecar provenance that a prior migration/learn left.
        const cleared = stripLearnedContextWindowSidecar(profile, false);
        if (cleared) {
          stats.userSidecarCleared += 1;
          return cleared;
        }
        return profile;
      }
      return profile;
    });

    didWork = true;
    const localModel = current.localModel ?? { profiles: [], activeProfileId: null };
    return {
      localModel: {
        ...localModel,
        profiles: next,
        learnedContextWindowPoisonResetAt: Date.now(),
      },
    };
  }, { sync: true });

  return didWork ? stats : null;
}

function runRegistryDisambiguation(): PartAStats | null {
  const stats: PartAStats = {
    registryDisambiguated: 0,
    registryStamped: 0,
    skippedVirtual: 0,
  };
  let didWork = false;

  updateSettingsAtomic((current) => {
    if (current.localModel?.registryStampMigratedAt) {
      return {};
    }
    const profiles = current.localModel?.profiles ?? [];
    const next: ModelProfile[] = profiles.map((profile) => {
      if (profile.contextWindowSource !== undefined) return profile;
      if (profile.contextWindow === undefined) return profile;
      if (profile.isVirtual) {
        stats.skippedVirtual += 1;
        return profile;
      }
      const registry = getRegistryContextWindowForModel(profile.model);
      if (registry !== null && profile.contextWindow === registry) {
        const { contextWindow: _drop, ...rest } = profile;
        stats.registryDisambiguated += 1;
        return rest as ModelProfile;
      }
      stats.registryStamped += 1;
      return { ...profile, contextWindowSource: 'user' as const };
    });

    didWork = true;
    const localModel = current.localModel ?? { profiles: [], activeProfileId: null };
    return {
      localModel: {
        ...localModel,
        profiles: next,
        registryStampMigratedAt: Date.now(),
      },
    };
  }, { sync: true });

  return didWork ? stats : null;
}

interface LegacyReadResult {
  /** Defined when the read succeeded (possibly with no entries). */
  limits?: Record<string, LegacyLimitEntry>;
  /** Defined when the read failed; migration must NOT mark itself complete. */
  error?: unknown;
}

function readLegacyStore(): LegacyReadResult {
  try {
    const store = createStore<LegacyState>({
      name: 'rebel-core-learned-model-limits',
      defaults: { limits: {} },
    });
    return { limits: { ...(store.get('limits') ?? {}) } };
  } catch (err) {
    log.warn(
      { err },
      '[migration] Part B: legacy store unreadable; will retry next boot',
    );
    return { error: err };
  }
}

function clearLegacyStore(): void {
  try {
    const store = createStore<LegacyState>({
      name: 'rebel-core-learned-model-limits',
      defaults: { limits: {} },
    });
    store.set('limits', {});
  } catch (err) {
    log.warn({ err }, '[migration] failed to clear legacy learned-limits store');
  }
}

function runLegacyImport(): PartBStats | null {
  if (getSettings().localModel?.learnedLimitsMigratedAt) {
    return null;
  }

  const legacyResult = readLegacyStore();
  if (legacyResult.error) {
    return null;
  }
  const legacy = legacyResult.limits ?? {};
  const now = Date.now();
  const stats: PartBStats = {
    migrated: 0,
    skippedExpired: 0,
    skippedUserOverride: 0,
    skippedCatalogued: 0,
    created: 0,
  };

  updateSettingsAtomic((current) => {
    if (current.localModel?.learnedLimitsMigratedAt) {
      return {};
    }

    const startProfiles = current.localModel?.profiles ?? [];
    let profiles: ModelProfile[] = startProfiles.slice();

    for (const [rawModel, entry] of Object.entries(legacy)) {
      if (!entry || typeof entry.contextWindow !== 'number' || typeof entry.learnedAt !== 'number') {
        continue;
      }
      if (entry.learnedAt + LEGACY_TTL_MS < now) {
        stats.skippedExpired += 1;
        continue;
      }

      // Registry-authoritative (Stage 5): a legacy entry carries ONLY a learned
      // context-window value. For a CATALOGUED model the registry wins, so
      // importing it as `source:'auto'` would re-mint exactly the poison Stage 1's
      // writer-guard + Stage 2's Part-C reset eliminate. Skip the entire entry —
      // do not create the auto sidecar and do not mint a new profile for it.
      // Genuinely-unknown models still import as before. This mirrors the
      // registry guard in the writer (Stage 1) and Part C's catalogued check.
      if (isCataloguedContextWindowModel(rawModel)) {
        stats.skippedCatalogued += 1;
        continue;
      }

      const normalized = normalizeForCapabilityCheck(rawModel);
      const idx = profiles.findIndex((p) => {
        if (p.isVirtual) return false;
        if (!p.model) return false;
        return normalizeForCapabilityCheck(p.model) === normalized;
      });

      let target: ModelProfile;
      if (idx === -1) {
        target = {
          id: `auto:${normalized}`,
          name: `${normalized} (auto-detected)`,
          model: normalized,
          providerType: 'other',
          serverUrl: '',
          enabled: false,
          isVirtual: false,
          createdAt: now,
        };
        stats.created += 1;
      } else {
        target = profiles[idx];
        if (target.contextWindowSource === 'user') {
          stats.skippedUserOverride += 1;
          continue;
        }
      }

      const next: ModelProfile = {
        ...target,
        contextWindow: entry.contextWindow,
        contextWindowSource: 'auto',
        contextWindowOverflowCount: entry.overflowCount,
        contextWindowLearnedAt: entry.learnedAt,
        lastLearnedContextWindow: entry.contextWindow,
      };

      if (idx === -1) {
        profiles = profiles.concat(next);
      } else {
        profiles = profiles.map((p, i) => (i === idx ? next : p));
      }
      stats.migrated += 1;
    }

    const localModel = current.localModel ?? { profiles: [], activeProfileId: null };
    return {
      localModel: {
        ...localModel,
        profiles,
        learnedLimitsMigratedAt: Date.now(),
      },
    };
  }, { sync: true });

  if (Object.keys(legacy).length > 0) {
    clearLegacyStore();
  }
  return stats;
}

/**
 * Run both parts of the learned-limits migration. Idempotent: each part is
 * gated on its own timestamp and is a no-op once that timestamp is set.
 *
 * Errors are caught and logged; the runtime continues either way (the next
 * boot retries the missing part).
 */
export function migrateLearnedLimitsIfNeeded(): void {
  let partA: PartAStats | null = null;
  try {
    partA = runRegistryDisambiguation();
  } catch (err) {
    log.error({ err }, '[migration] learned-limits Part A failed; will retry on next boot');
  }

  let partB: PartBStats | null = null;
  try {
    partB = runLegacyImport();
  } catch (err) {
    log.error({ err }, '[migration] learned-limits Part B failed; will retry on next boot');
  }

  let partC: PartCStats | null = null;
  try {
    partC = runLearnedContextWindowPoisonReset();
  } catch (err) {
    log.error({ err }, '[migration] learned-limits Part C failed; will retry on next boot');
  }

  if (partA || partB || partC) {
    log.info({
      registryDisambiguated: partA?.registryDisambiguated ?? 0,
      registryStamped: partA?.registryStamped ?? 0,
      skippedVirtual: partA?.skippedVirtual ?? 0,
      migrated: partB?.migrated ?? 0,
      skippedExpired: partB?.skippedExpired ?? 0,
      skippedUserOverride: partB?.skippedUserOverride ?? 0,
      skippedCatalogued: partB?.skippedCatalogued ?? 0,
      created: partB?.created ?? 0,
      contextWindowPoisonAutoCleared: partC?.autoCleared ?? 0,
      contextWindowPoisonUserSidecarCleared: partC?.userSidecarCleared ?? 0,
    }, '[migration] learned-limits unified');
  }
}
