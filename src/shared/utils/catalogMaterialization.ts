import {
  normalizeCatalogModelId,
  type CatalogEntry,
} from '../data/providerCatalogs';
import { isAlwaysOnThinkingCatalogModel } from '../data/modelCatalog';
import { PROVIDER_PRESETS } from '../data/modelProviderPresets';
import type {
  ModelProfile,
  RouteSurface,
  ThinkingEffort,
} from '../types';
import { isConnectionManagedProfile } from './profileHelpers';

export type ConnectorCatalogEntry = CatalogEntry;

const CATALOG_PROVIDER_TYPES = ['anthropic', 'openai', 'openrouter', 'google'] as const;

export interface MaterializeOptions {
  /** Optional deterministic ID for tests or future transactional callers. */
  id?: string;
  /** User-facing profile name override. Defaults to the catalog row label. */
  displayName?: string;
  /** Optional timestamp override for deterministic tests. Defaults to Date.now(). */
  createdAt?: number;
  /** Council remains opt-in; true stamps the profile as a council member. */
  councilEnabled?: boolean;
  /**
   * Smart picking membership defaults on per the Model-team catalog-add spec —
   * EXCEPT premium always-on-thinking catalog rows (e.g. Claude Fable 5),
   * which default OFF so adding one to the team can't silently route work
   * onto the 2x-cost class (GPT stage-12 review F3; the user can still chip
   * it on in ModelTeamSection). New-materialization default only: persisted
   * profiles are never migrated.
   */
  routingEligible?: boolean;
  /** Optional reasoning-effort override for reasoning-capable catalog rows. */
  reasoningEffort?: ThinkingEffort;
}

function assertKnownCatalogProviderType(
  providerType: string,
): asserts providerType is ConnectorCatalogEntry['providerType'] {
  if (!(CATALOG_PROVIDER_TYPES as readonly string[]).includes(providerType)) {
    throw new Error(`materializeCatalogProfile: unknown providerType '${providerType}'`);
  }
}

function inferRouteSurface(profile: ModelProfile): RouteSurface {
  if (profile.routeSurface) return profile.routeSurface;
  if (profile.providerType === 'local') return 'local';
  if (profile.providerType === 'openrouter') return 'pool';
  if (profile.authSource === 'codex-subscription') return 'subscription';
  return 'api-key';
}

function catalogServerUrl(entry: ConnectorCatalogEntry): string {
  switch (entry.providerType) {
    case 'anthropic':
      return 'https://api.anthropic.com/v1';
    case 'openai':
      return PROVIDER_PRESETS.openai.serverUrl;
    case 'openrouter':
      return PROVIDER_PRESETS.openrouter.serverUrl;
    case 'google':
      return PROVIDER_PRESETS.google.serverUrl;
  }
}

function mintProfileId(): string {
  return `profile-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * Find an already-materialised catalog profile by the billing-aware route key.
 * The composite key intentionally includes `routeSurface` so a subscription row
 * and a direct API-key row for the same model remain separate team members.
 * Connection-managed profiles and system-managed auto profiles both count:
 * either one means the user already has a managed profile for this catalog row.
 */
export function findExistingManagedProfile(
  profiles: readonly ModelProfile[],
  entry: ConnectorCatalogEntry,
): ModelProfile | undefined {
  const entryModelId = normalizeCatalogModelId(entry.model);
  return profiles.find((profile) => {
    if (!isConnectionManagedProfile(profile) && profile.profileSource !== 'auto') return false;
    return (
      profile.providerType === entry.providerType &&
      inferRouteSurface(profile) === entry.routeSurface &&
      normalizeCatalogModelId(profile.model ?? '') === entryModelId
    );
  });
}

/**
 * Materialise a curated catalog row into a real ModelProfile.
 *
 * This helper is pure settings-shape plumbing: no IPC, no writes, no mutation.
 * If an existing connection-managed profile owns the same
 * `(providerType, routeSurface, normalized model)` tuple, the existing object is
 * returned unchanged so rapid add attempts stay idempotent.
 */
export function materializeCatalogProfile(
  entry: ConnectorCatalogEntry,
  options?: MaterializeOptions,
  existingProfiles?: readonly ModelProfile[],
): ModelProfile {
  assertKnownCatalogProviderType(entry.providerType);

  const existing = existingProfiles
    ? findExistingManagedProfile(existingProfiles, entry)
    : undefined;
  if (existing) return existing;

  const supportsReasoning = entry.reasoning ?? entry.supportsReasoning ?? false;
  const displayName = options?.displayName?.trim() || entry.label;
  const profile: ModelProfile = {
    id: options?.id ?? mintProfileId(),
    name: displayName,
    providerType: entry.providerType,
    routeSurface: entry.routeSurface,
    serverUrl: catalogServerUrl(entry),
    model: entry.model,
    createdAt: options?.createdAt ?? Date.now(),
    profileSource: 'connection',
    // Premium always-on rows default OFF — see MaterializeOptions.routingEligible.
    routingEligible: options?.routingEligible ?? !isAlwaysOnThinkingCatalogModel(entry.model),
    enabled: true,
    chatCompatibility: 'compatible',
  };

  if (entry.providerType === 'openai' && entry.routeSurface === 'subscription') {
    profile.authSource = 'codex-subscription';
  }
  if (options?.councilEnabled) {
    profile.councilEnabled = true;
  }
  if (supportsReasoning) {
    profile.reasoningEffort = options?.reasoningEffort ?? 'medium';
    profile.thinkingCompatibility = 'compatible';
  } else if (entry.reasoning === false || entry.supportsReasoning === false) {
    profile.thinkingCompatibility = 'incompatible';
  }
  if (entry.contextWindow !== undefined) {
    profile.contextWindow = entry.contextWindow;
  }
  if (entry.maxOutputTokens !== undefined) {
    profile.maxOutputTokens = entry.maxOutputTokens;
  }
  if (entry.jsonSupport !== undefined) {
    profile.jsonCompatibility = entry.jsonSupport;
  }
  if (entry.toolUseSupport !== undefined) {
    profile.toolUseCompatibility = entry.toolUseSupport;
  }

  return profile;
}
