/**
 * Quality tier presets and matching helpers for the ConversationModelSelector slider.
 *
 * Pure functions — no React hooks, no renderer imports.
 * Used by the UI to map between outcome-oriented tiers (Quick/Balanced/Thorough/Maximum)
 * and the underlying model/profile/effort session overrides.
 * (A fifth 'frontier'/Fable-5 tier was removed when Fable was withdrawn — see the
 * CLAUDE_TIERS removal note below for rationale and the when-Fable-returns plan.)
 * Also consumed by bundledInboxBridge for the /settings/set-quality-tier MCP route,
 * ensuring the bridge and the slider stay in lockstep.
 *
 * @see docs/project/MODEL_ROLES_AND_THINKING.md — how tiers map to model roles and thinking effort
 * @see docs/project/MODEL_REGISTRIES.md — tier presets are a hand-maintained registry, not catalog-derived
 */

import type { ThinkingEffort, ModelProfile, ActiveProvider, ModelRoleTier } from '@shared/types';
import { getCatalogEntryById, getCatalogAliasMap, isAlwaysOnThinkingCatalogModel } from '@shared/data/modelCatalog';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface QualityTier {
  id: 'quick' | 'balanced' | 'thorough' | 'maximum';
  name: string;
  costIndicator: string;
  description: string;
  workingModel?: string;
  workingProfileId?: string;
  thinkingModel?: string;
  thinkingProfileId?: string;
  thinkingEffort: ThinkingEffort;
}

export type QualityTierId = QualityTier['id'];

// ---------------------------------------------------------------------------
// Static Claude-only presets
// ---------------------------------------------------------------------------

// Assumption: Claude models are always available via API key or OAuth.
// If Anthropic models become optional in the future, this will need dynamic tier building.
export const CLAUDE_TIERS: readonly QualityTier[] = [
  { id: 'quick', name: 'Quick', costIndicator: '$', description: 'Fast responses for simple tasks', workingModel: 'claude-haiku-4-5', thinkingModel: 'claude-haiku-4-5', thinkingEffort: 'low' },
  { id: 'balanced', name: 'Balanced', costIndicator: '$$', description: 'Good balance of speed and quality', workingModel: 'claude-sonnet-4-6', thinkingModel: 'claude-sonnet-4-6', thinkingEffort: 'high' },
  { id: 'thorough', name: 'Thorough', costIndicator: '$$$', description: 'Deep reasoning for complex tasks', workingModel: 'claude-sonnet-4-6', thinkingModel: 'claude-opus-4-8', thinkingEffort: 'high' },
  { id: 'maximum', name: 'Maximum', costIndicator: '$$$$', description: 'Best available quality', workingModel: 'claude-opus-4-8', thinkingModel: 'claude-opus-4-8', thinkingEffort: 'xhigh' },
  // The 'frontier' tier (Claude Fable 5) is REMOVED while Fable access is
  // withdrawn (2026-06): Anthropic pulled Fable for all keys (404 "use Opus
  // 4.8"), so a $$$$$ tier that 404s every turn would strand non-technical
  // users on the most prominent "best" option. Tier ids are never persisted
  // (selections write resolved model ids), so removing it strands no one.
  //
  // WHEN FABLE RETURNS — preferred direction (Greg, 2026-06): do NOT re-add a
  // separate 'frontier' tier. Having both 'maximum' AND 'frontier' is redundant
  // and there are already enough tiers. Instead, promote the new top model into
  // 'maximum' (working + thinking) and shift the ladder down one as needed, so
  // the slider stays a clean, small ladder rather than gaining a fifth tier.
  //
  // If a literal 'frontier' tier is ever re-added anyway, the mechanics are:
  // re-add the tier line here, re-add `| 'frontier'` to QualityTier['id'] above,
  // AND re-add the `frontier:` line to TIER_MESSAGES in
  // inboxBridgeStateMachine.ts — the `satisfies Record<QualityTierId, string>`
  // there compiler-enforces the pair. (The Maximum third-party swap stays
  // scoped to 'maximum' regardless.)
];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Compute quality tiers, optionally enhancing the Maximum tier with the best
 * third-party profile when multi-model mode is enabled.
 *
 * Uses catalog output cost for ranking. Falls back to first eligible routable
 * profile when no profile has known pricing.
 *
 * Premium always-on-thinking models (catalog `thinkingAlwaysOn`, e.g. Claude
 * Fable 5) are excluded from the swap entirely — ranking AND fallback. Users
 * opt into those explicitly via the Frontier tier; a user-added Fable profile
 * must never silently re-price the familiar Maximum click. If only excluded
 * profiles are routable, Maximum stays on its stock Claude preset.
 */
export function getQualityTiers(routableProfiles: ModelProfile[], multiModelEnabled: boolean): QualityTier[] {
  if (!multiModelEnabled || routableProfiles.length === 0) {
    return CLAUDE_TIERS.map(t => ({ ...t }));
  }

  // Find the best third-party profile by catalog output cost (alias-aware)
  const aliasMap = getCatalogAliasMap();
  let bestProfile: ModelProfile | null = null;
  let bestCost = -1;
  // Profiles eligible for the Maximum swap (premium always-on models excluded
  // from this fallback pool too, so they can't re-enter via the fallback).
  const eligibleProfiles: ModelProfile[] = [];

  for (const profile of routableProfiles) {
    const model = profile.model?.trim();
    // Alias-complete premium exclusion (GPT stage-12 review F1): the shared
    // catalog predicate normalizes `[1m]`/dated suffixes, resolves aliases AND
    // openRouter.legacyIds, and hops openRouter.sdkModel to the direct row —
    // a profile can carry any of those spellings, and a missed one would win
    // the no-pricing fallback below.
    if (model && isAlwaysOnThinkingCatalogModel(model)) continue;
    eligibleProfiles.push(profile);
    if (!model) continue;
    const canonicalId = aliasMap[model] ?? model;
    const entry = getCatalogEntryById(canonicalId);
    const cost = entry?.pricing?.output ?? -1;
    if (cost > bestCost) {
      bestCost = cost;
      bestProfile = profile;
    }
  }

  // Graceful fallback: if no eligible profile has catalog pricing, use the
  // first eligible routable profile
  if (!bestProfile) {
    bestProfile = eligibleProfiles[0] ?? null;
  }

  // Only premium always-on profiles are routable — leave the tiers stock
  // rather than reintroducing an excluded model through the fallback.
  if (!bestProfile) {
    return CLAUDE_TIERS.map(t => ({ ...t }));
  }

  // Enhance Maximum tier — swap working model to best third-party profile
  const enhancedProfile = bestProfile;
  return CLAUDE_TIERS.map(tier => {
    if (tier.id !== 'maximum') return { ...tier };
    return {
      ...tier,
      workingModel: enhancedProfile.model || undefined, // || undefined avoids empty-string suppression
      workingProfileId: enhancedProfile.id,
    };
  });
}

/**
 * Match raw session override fields against tier definitions.
 * Returns the tier ID on exact match, or `null` when no tier matches ("Custom").
 *
 * Compares all 5 fields: working model, thinking model, working profile,
 * thinking profile, and thinking effort. If effort is `undefined` (inherit
 * global), it only matches a tier whose effort is the global default.
 */
export function matchOverridesToTier(
  tiers: readonly QualityTier[],
  overrides: {
    workingModel?: string;
    thinkingModel?: string;
    workingProfileId?: string;
    thinkingProfileId?: string;
    thinkingEffort?: ThinkingEffort;
  },
): QualityTierId | null {
  for (const tier of tiers) {
    if (
      tier.workingModel === overrides.workingModel &&
      tier.thinkingModel === overrides.thinkingModel &&
      (tier.workingProfileId ?? undefined) === overrides.workingProfileId &&
      (tier.thinkingProfileId ?? undefined) === overrides.thinkingProfileId &&
      tier.thinkingEffort === overrides.thinkingEffort
    ) {
      return tier.id;
    }
  }
  return null;
}

/**
 * Check whether session overrides match the user's global default settings.
 * Used for locked-state visibility — hidden when overrides equal global.
 *
 * `undefined` overrides = "inherit global" = matches by definition.
 * Does NOT use tier matching (per design: direct field comparison avoids
 * lossy matching when global is a custom combo).
 */

/**
 * Already-resolved global default values for `overridesMatchGlobalDefault`.
 *
 * `src/shared` cannot import the core role resolver, so callers pass the
 * effective model ids they obtained from `resolveAllRoleAssignments`. This
 * helper keeps only the legacy comparison rule that Thinking inherits Working
 * when no explicit global Thinking model/profile is set.
 */
export interface QualityTierResolvedGlobalDefault {
  workingEffectiveModelId?: string | null;
  thinkingEffectiveModelId?: string | null;
  workingProfileRef?: string;
  thinkingProfileRef?: string;
  thinkingEffort?: ThinkingEffort;
}

export function overridesMatchGlobalDefault(
  overrides: {
    workingModel?: string;
    thinkingModel?: string;
    workingProfileId?: string;
    thinkingProfileId?: string;
    thinkingEffort?: ThinkingEffort;
  },
  resolvedGlobal: QualityTierResolvedGlobalDefault,
): boolean {
  const globalWorkingProfileId = resolvedGlobal.workingProfileRef || undefined;
  const globalThinkingProfileId = resolvedGlobal.thinkingProfileRef || undefined;
  const globalWorkingModel = resolvedGlobal.workingEffectiveModelId || undefined;
  const globalThinkingModel = resolvedGlobal.thinkingEffectiveModelId || undefined;

  // Single-model mode: when no explicit thinking model/profile is set, thinking inherits working
  const effectiveGlobalThinkingModel = globalThinkingModel ?? globalWorkingModel;
  const effectiveGlobalThinkingProfileId = globalThinkingProfileId ?? (globalThinkingModel ? undefined : globalWorkingProfileId);

  // undefined overrides = "inherit global" = matches by definition.
  // NOTE: these compare the per-conversation OVERRIDE object's own fields
  // against the already-resolved global default — they do NOT resolve a global
  // role's model (that's done canonically via resolveAllRoleAssignments at the
  // caller, whose result arrives as `resolvedGlobal`).
  if (overrides.workingModel !== undefined && overrides.workingModel !== globalWorkingModel) return false;
  if (overrides.thinkingModel !== undefined && overrides.thinkingModel !== effectiveGlobalThinkingModel) return false;
  if (overrides.workingProfileId !== undefined && overrides.workingProfileId !== globalWorkingProfileId) return false;
  if (overrides.thinkingProfileId !== undefined && overrides.thinkingProfileId !== effectiveGlobalThinkingProfileId) return false;

  // Thinking effort: undefined = inherit global = matches
  const globalEffort = resolvedGlobal.thinkingEffort || 'high'; // default is 'high'
  if (overrides.thinkingEffort !== undefined && overrides.thinkingEffort !== globalEffort) return false;

  return true;
}

/**
 * The model-role tier slot within a quality tier. Canonical type:
 * {@link ModelRoleTier} (single source of tier membership). Kept as a
 * domain-named alias for call-site readability.
 */
export type QualityTierRole = ModelRoleTier;

/**
 * Resolve the model string for a given quality tier, provider, and role.
 *
 * For Anthropic (direct API), use the tier's canonical model fields:
 * - 'working' role => tier.workingModel
 * - 'thinking' role => tier.thinkingModel (falls back to workingModel if not set)
 * - 'background' role => tier.workingModel (no dedicated background slot in QualityTier)
 *
 * WARNING — the 'background' mapping exists for TEST convenience only (it
 * gives test matrices a deterministic per-tier answer). Quality tiers
 * deliberately never set the behind-the-scenes (background) model in
 * production: the tier write paths (ConversationModelSelector, the
 * /settings/set-quality-tier bridge route) only touch working/thinking/effort,
 * so BTS stays on its own cheap default regardless of tier. Do NOT wire
 * production BTS model resolution through this helper — that would silently
 * repoint background work (watchdog, safety evals, consults) at the tier's
 * premium working model.
 *
 * For non-Anthropic providers (OpenRouter, etc.), use the provider's default
 * model when supplied, since tier fields are Anthropic-only canonical strings.
 * Falls back to the tier field if no provider default is provided (defensive),
 * which preserves legacy behavior at call sites that haven't yet plumbed the
 * provider default through.
 */
export function qualityTierModel(
  tier: QualityTier,
  provider: ActiveProvider,
  role: QualityTierRole,
  providerDefault?: string,
): string {
  if (provider === 'anthropic') {
    if (role === 'thinking') {
      return tier.thinkingModel ?? tier.workingModel ?? '';
    }
    return tier.workingModel ?? '';
  }
  if (role === 'thinking') {
    return providerDefault ?? tier.thinkingModel ?? '';
  }
  return providerDefault ?? tier.workingModel ?? '';
}
