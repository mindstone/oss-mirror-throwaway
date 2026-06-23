import type { CatalogEntry } from '@shared/data/providerCatalogs';
import { normalizeCatalogModelId } from '@shared/data/providerCatalogs';
import type { ModelProfile, ModelProviderType, RouteSurface } from '@shared/types';
import { isCodexAutoProfile } from '@shared/utils/codexDefaults';
import { isConnectionManagedProfile } from '@shared/utils/profileHelpers';

type DedupProviderType = CatalogEntry['providerType'] | ModelProviderType | undefined;

function inferRouteSurface(profile: ModelProfile): RouteSurface {
  if (profile.routeSurface) return profile.routeSurface;
  if (profile.providerType === 'local') return 'local';
  if (profile.providerType === 'openrouter') return 'pool';
  if (profile.authSource === 'codex-subscription') return 'subscription';
  return 'api-key';
}

function dedupKey(
  providerType: DedupProviderType,
  routeSurface: RouteSurface,
  model: string | undefined,
): string {
  return `${providerType ?? 'other'}:${routeSurface}:${normalizeCatalogModelId(model ?? '')}`;
}

function profileDedupKey(profile: ModelProfile): string {
  return dedupKey(profile.providerType, inferRouteSurface(profile), profile.model);
}

function catalogDedupKey(entry: CatalogEntry): string {
  return dedupKey(entry.providerType, entry.routeSurface, entry.model);
}

export interface DedupCatalogOptions {
  /**
   * When `true`, profiles with `enabled === false` are excluded from the
   * suppression keyset. Picker callers (which hide disabled profiles in the
   * dropdown) should opt-in so a disabled profile cannot leave its catalog
   * row unreachable. The default `false` preserves LocalModelSection
   * semantics, where disabled user profiles still render in the "Available"
   * bucket and therefore own the matching catalog row.
   */
  excludeDisabledFromSuppression?: boolean;
}

/**
 * Remove curated catalog rows whose full billing route is already owned by a
 * user profile. User profile keys displace curated rows entirely — capability
 * flags and defaults are not inherited from the catalog.
 *
 * Codex auto-profiles (system plumbing for clientFactory routing — see
 * `codexDefaults.ts`) and connection-managed profiles are NOT user profiles
 * for dedup purposes. Hidden settings-normalisation glue (`isVirtual`) and
 * `profileSource === 'auto'` profiles are also excluded (260603 opus-4-8
 * working-dropdown fix): they aren't rendered to users in either
 * LocalModelSection or the role pickers, so suppressing their catalog row
 * would leave the model unreachable.
 *
 * Disabled profiles are surface-dependent: LocalModelSection still renders
 * them in the "Available" bucket (default behaviour), while role pickers
 * hide them. Picker callers must pass `excludeDisabledFromSuppression: true`
 * so a disabled user profile cannot remove a catalog row the picker won't
 * replace.
 */
export function dedupCatalogAgainstProfiles(
  catalog: readonly CatalogEntry[],
  userProfiles: readonly ModelProfile[] | null | undefined,
  options: DedupCatalogOptions = {},
): readonly CatalogEntry[] {
  const excludeDisabled = options.excludeDisabledFromSuppression ?? false;
  const userKeys = new Set(
    (userProfiles ?? [])
      .filter((profile) => !isCodexAutoProfile(profile))
      .filter((profile) => !isConnectionManagedProfile(profile))
      .filter((profile) => profile.isVirtual !== true)
      .filter((profile) => profile.profileSource !== 'auto')
      .filter((profile) => (excludeDisabled ? profile.enabled !== false : true))
      .map(profileDedupKey),
  );
  return catalog.filter((entry) => !userKeys.has(catalogDedupKey(entry)));
}
