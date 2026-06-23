import { CODEX_AUXILIARY_MODEL_OPTIONS, CODEX_MAIN_MODEL_OPTIONS } from '@shared/data/codexModels';
import {
  normalizeCatalogModelId,
  PROVIDER_CATALOGS,
  type CatalogEntry,
} from '@shared/data/providerCatalogs';
import { OR_ALL_MODEL_OPTIONS, OR_AUXILIARY_MODEL_OPTIONS, OR_MAIN_MODEL_OPTIONS } from '@shared/data/openRouterModels';
import type { ActiveProvider, AppSettings, ModelProfile } from '@shared/types';
import type { RoleId } from '@shared/types/modelChoice';
import type { BtsTaskGroup } from '@shared/utils/btsModelResolver';
import { isCodexAutoProfile } from '@shared/utils/codexDefaults';
import { modelSupportsExtendedContext, MODEL_OPTIONS } from '@shared/utils/modelNormalization';
import {
  isAutoProfileShadowedBySibling,
  isConnectionManagedProfile,
} from '@shared/utils/profileHelpers';
import { dedupCatalogAgainstProfiles } from '../components/models/dedupCatalog';

export interface ModelChoiceOption {
  value: string;
  label: string;
  group?: string;
}

export interface ModelChoiceOptionGroup {
  label: string;
  options: Array<{ value: string; label: string }>;
}

export interface ModelChoiceOptions {
  catalogModels: ModelChoiceOption[];
  additionalModelGroups?: ModelChoiceOptionGroup[];
  fallbackCatalogModels: ModelChoiceOption[];
  additionalFallbackGroups?: ModelChoiceOptionGroup[];
  profiles: ModelProfile[];
}

type CatalogKind = 'main' | 'auxiliary' | 'all' | 'long-context' | 'none';
type CatalogMode = 'active-provider' | 'connected-providers';
type CatalogKeyProviderType = CatalogEntry['providerType'] | ModelProfile['providerType'];

export function buildModelChoiceOptions(args: {
  role: RoleId;
  taskGroup?: BtsTaskGroup;
  settings: AppSettings;
  activeProvider: ActiveProvider | undefined;
  hasAnthropicCredentials: boolean;
  hasOpenRouterCredentials: boolean;
  hasCodexCredentials?: boolean;
  hasGeminiCredentials?: boolean;
  catalogMode?: CatalogMode;
  profileFilter?: (profile: ModelProfile) => boolean;
  /**
   * Managed-subscription allow-list (Stage G1). When populated AND
   * activeProvider === 'mindstone', the OR/Mindstone catalog is filtered down to
   * these IDs only. Source: ManagedProviderInfo.defaultModels via useManagedDefaults().
   */
  managedAllowedModels?: string[];
}): ModelChoiceOptions {
  const allProfiles = args.settings.localModel?.profiles ?? [];
  // Two-pass filter so the shadowing check evaluates against the full
  // profile set (including currently-hidden ones), not the user's caller
  // filter — that filter typically removes broken/disconnected profiles, and
  // we still want shadow detection to see the connection-managed sibling.
  const callerProfileFilter = args.profileFilter ?? (() => true);
  const profiles = allProfiles
    .filter(callerProfileFilter)
    .filter((profile) => !isAutoProfileShadowedBySibling(profile, allProfiles));

  if (args.catalogMode === 'connected-providers') {
    const catalogModels = buildConnectedProviderCatalogModels(args);
    const result: ModelChoiceOptions = {
      catalogModels,
      fallbackCatalogModels: catalogModels,
      profiles,
    };
    assertSameMainCatalog(result, {
      activeProvider: args.activeProvider,
      role: args.role,
      taskGroup: args.taskGroup,
    });
    return result;
  }

  const primaryKind = catalogKindForRole(args.role, args.taskGroup);
  const fallbackKind = fallbackCatalogKindForRole(args.role, args.taskGroup);

  const activeCatalogContext = activeProviderCatalogContext(args.activeProvider);

  const result: ModelChoiceOptions = {
    catalogModels: suppressCatalogModelsShadowedByProfiles(
      buildActiveProviderCatalogModels(args.activeProvider, primaryKind, args.managedAllowedModels),
      allProfiles,
      callerProfileFilter,
      activeCatalogContext,
    ),
    additionalModelGroups: buildClaudeFallbackGroups(args, primaryKind),
    fallbackCatalogModels: suppressCatalogModelsShadowedByProfiles(
      buildActiveProviderCatalogModels(args.activeProvider, fallbackKind, args.managedAllowedModels),
      allProfiles,
      callerProfileFilter,
      activeCatalogContext,
    ),
    additionalFallbackGroups: buildClaudeFallbackGroups(args, fallbackKind),
    profiles,
  };

  assertSameMainCatalog(result, {
    activeProvider: args.activeProvider,
    role: args.role,
    taskGroup: args.taskGroup,
  });

  return result;
}

interface CatalogProviderContext {
  providerType: CatalogKeyProviderType;
  routeSurface: CatalogEntry['routeSurface'];
}

function activeProviderCatalogContext(
  activeProvider: ActiveProvider | undefined,
): CatalogProviderContext {
  if (activeProvider === 'codex') {
    return { providerType: 'openai', routeSurface: 'subscription' };
  }
  if (activeProvider === 'openrouter') {
    return { providerType: 'openrouter', routeSurface: 'pool' };
  }
  return { providerType: 'anthropic', routeSurface: 'api-key' };
}

/**
 * Active-provider catalog options (e.g. CODEX_AUXILIARY_MODEL_OPTIONS) are
 * `{ value, label }` literals — they aren't CatalogEntry rows, so the
 * connected-provider mode's `dedupCatalogAgainstProfiles` doesn't reach them.
 * Suppress catalog values that share a `(providerType, routeSurface, model)`
 * key with any *user-visible* profile so the picker doesn't render the
 * catalog row alongside the materialised profile (260521 BTS Haiku-fallback
 * A2 fix). Same-key constraint is the rule of record across
 * `LocalModelSection` and the connected-provider catalog dedup, so an
 * unrelated direct/custom OpenRouter profile cannot suppress a ChatGPT Pro
 * catalog row that shares only the model id.
 *
 * Hidden / disabled / non-Codex auto-managed profiles are excluded from the
 * suppression keyset (260603 opus-4-8 working-dropdown fix): they are not
 * rendered in the picker, so suppressing the catalog row would leave the
 * model unreachable. Codex auto-profiles ARE intentionally user-visible in
 * the active-Codex picker when no connection-managed sibling exists, so they
 * stay in the keyset. The caller's `profileFilter` is also honoured (e.g.
 * BTS task groups filter `jsonCompatibility === 'incompatible'`), so a
 * caller-hidden profile can't suppress its catalog row.
 *
 * Connection-managed enabled profiles ARE always in the keyset, even when a
 * caller filter would exclude them (e.g. connection currently down) — that's
 * the BTS Haiku-fallback A2 invariant the 22ca6d90ce fix pinned.
 */
function suppressCatalogModelsShadowedByProfiles(
  catalog: ModelChoiceOption[],
  profiles: readonly ModelProfile[],
  callerProfileFilter: (profile: ModelProfile) => boolean,
  catalogContext: CatalogProviderContext,
): ModelChoiceOption[] {
  if (catalog.length === 0) return catalog;
  const profileKeys = new Set<string>();
  for (const profile of profiles) {
    if (!shouldShadowCatalog(profile, callerProfileFilter)) continue;
    const model = profile.model?.trim();
    if (!model) continue;
    profileKeys.add(profileCatalogKey(profile));
  }
  if (profileKeys.size === 0) return catalog;
  return catalog.filter((option) => {
    const optionKey = catalogKey(
      catalogContext.providerType,
      catalogContext.routeSurface,
      option.value,
    );
    return !profileKeys.has(optionKey);
  });
}

/**
 * Profile classes that NEVER render in the picker, regardless of caller
 * filter. Hidden settings-normalisation glue (`isVirtual`), disabled
 * profiles, and learnedLimitsMigration-style auto profiles all fall here.
 * Codex auto-profiles are intentionally excluded from this list — they're
 * user-visible in the active-Codex picker when no connection-managed sibling
 * exists, and must shadow the matching ChatGPT Pro catalog row to avoid
 * duplicate picker entries.
 */
function isPickerHiddenProfile(profile: ModelProfile): boolean {
  if (profile.isVirtual === true) return true;
  if (profile.enabled === false) return true;
  if (profile.profileSource === 'auto' && !isCodexAutoProfile(profile)) return true;
  return false;
}

/**
 * Decide whether a profile should shadow its matching catalog row in the
 * active-provider picker. Honours the caller's `profileFilter` (e.g. BTS
 * JSON-incompatible) so caller-hidden profiles don't silently remove catalog
 * options. Connection-managed enabled profiles are an exception — they
 * always shadow (preserves the 22ca6d90ce A2 BTS Haiku-fallback invariant).
 */
function shouldShadowCatalog(
  profile: ModelProfile,
  callerProfileFilter: (profile: ModelProfile) => boolean,
): boolean {
  if (isPickerHiddenProfile(profile)) return false;
  if (callerProfileFilter(profile)) return true;
  return isConnectionManagedProfile(profile) && profile.enabled !== false;
}

function catalogKindForRole(role: RoleId, taskGroup?: BtsTaskGroup): CatalogKind {
  if (taskGroup) return 'auxiliary';

  switch (role) {
    case 'background':
      return 'auxiliary';
    case 'recovery':
      return 'long-context';
    case 'thinking':
    case 'working':
      return 'main';
  }
}

function fallbackCatalogKindForRole(role: RoleId, taskGroup?: BtsTaskGroup): CatalogKind {
  if (taskGroup) return 'auxiliary';

  switch (role) {
    case 'background':
      return 'auxiliary';
    case 'recovery':
      return 'none';
    case 'thinking':
    case 'working':
      return 'all';
  }
}

function buildActiveProviderCatalogModels(
  activeProvider: ActiveProvider | undefined,
  kind: CatalogKind,
  managedAllowedModels?: string[],
): ModelChoiceOption[] {
  if (kind === 'none') return [];
  if (kind === 'long-context') return buildAnthropicCatalogModels(kind);

  if (activeProvider === 'codex') {
    switch (kind) {
      case 'main':
        return CODEX_MAIN_MODEL_OPTIONS.map(toModelChoiceOption);
      case 'auxiliary':
        return CODEX_AUXILIARY_MODEL_OPTIONS.map(toModelChoiceOption);
      case 'all':
        return [...CODEX_MAIN_MODEL_OPTIONS, ...CODEX_AUXILIARY_MODEL_OPTIONS].map(toModelChoiceOption);
    }
  }

  if (activeProvider === 'openrouter' || activeProvider === 'mindstone') {
    const baseOptions = (() => {
      switch (kind) {
        case 'main':
          return OR_MAIN_MODEL_OPTIONS.map(toModelChoiceOption);
        case 'auxiliary':
          return OR_AUXILIARY_MODEL_OPTIONS.map(toModelChoiceOption);
        case 'all':
          return OR_ALL_MODEL_OPTIONS.map(toModelChoiceOption);
      }
    })();
    return applyManagedAllowList(baseOptions, activeProvider, managedAllowedModels);
  }

  return buildAnthropicCatalogModels(kind);
}

/**
 * Stage G1 — UI lockdown.
 *
 * When the active provider is the managed Mindstone subscription AND the server
 * has supplied a tier default-models allow-list, the OpenRouter catalog is
 * narrowed to that allow-list. BYOK OpenRouter usage is untouched.
 *
 * This is one of three defence layers (UI here, proxy in Stage G2, error
 * humanizer in Stage G3). Empty allow-lists are treated as "no restriction"
 * (older servers / managed configs without defaultModels still surface the
 * full catalog rather than blanking the picker).
 */
function applyManagedAllowList(
  options: ModelChoiceOption[],
  activeProvider: ActiveProvider | undefined,
  managedAllowedModels: string[] | undefined,
): ModelChoiceOption[] {
  if (activeProvider !== 'mindstone') return options;
  if (!managedAllowedModels || managedAllowedModels.length === 0) return options;
  const allowed = new Set(managedAllowedModels);
  return options.filter((option) => allowed.has(option.value));
}

function buildAnthropicCatalogModels(kind: CatalogKind): ModelChoiceOption[] {
  switch (kind) {
    case 'main':
      return MODEL_OPTIONS
        .filter((model) => model.isMainModel)
        .map(toModelChoiceOption);
    case 'auxiliary':
      return MODEL_OPTIONS
        .filter((model) => model.isAuxiliaryModel)
        .map(toAnthropicAuxiliaryOption);
    case 'all':
      return MODEL_OPTIONS.map(toModelChoiceOption);
    case 'long-context':
      return MODEL_OPTIONS
        .filter((model) => modelSupportsExtendedContext(model.value))
        .map(toModelChoiceOption);
    case 'none':
      return [];
  }
}

function buildClaudeFallbackGroups(
  args: {
    activeProvider: ActiveProvider | undefined;
    hasAnthropicCredentials: boolean;
    hasOpenRouterCredentials: boolean;
  },
  kind: CatalogKind,
): ModelChoiceOptionGroup[] {
  if (kind === 'none' || kind === 'long-context') return [];

  const canReachAnthropicViaFallback =
    args.activeProvider !== 'anthropic' && (args.hasAnthropicCredentials || args.hasOpenRouterCredentials);

  if (!canReachAnthropicViaFallback) return [];

  return [{
    label: 'Claude (API key)',
    options: buildAnthropicCatalogModels(kind).map(({ value, label }) => ({ value, label })),
  }];
}

function buildConnectedProviderCatalogModels(args: {
  role: RoleId;
  settings: AppSettings;
  hasAnthropicCredentials: boolean;
  hasOpenRouterCredentials: boolean;
  hasCodexCredentials?: boolean;
  hasGeminiCredentials?: boolean;
}): ModelChoiceOption[] {
  const profiles = args.settings.localModel?.profiles ?? [];
  const kind = catalogKindForRole(args.role);
  const groups: Array<{ label: string; catalog: readonly CatalogEntry[] }> = [];

  if (args.hasCodexCredentials) {
    groups.push({ label: 'ChatGPT Pro', catalog: PROVIDER_CATALOGS.openai });
  }
  if (args.hasOpenRouterCredentials) {
    groups.push({ label: 'OpenRouter', catalog: PROVIDER_CATALOGS.openrouter });
  }
  if (args.hasAnthropicCredentials) {
    groups.push({ label: 'Anthropic', catalog: PROVIDER_CATALOGS.anthropic });
  }
  if (args.hasGeminiCredentials) {
    groups.push({ label: 'Gemini', catalog: PROVIDER_CATALOGS.google });
  }

  return groups.flatMap((group) =>
    catalogEntriesToOptions(
      suppressMaterializedConnectionCatalogEntries(
        dedupCatalogAgainstProfiles(group.catalog, profiles, {
          excludeDisabledFromSuppression: true,
        }),
        profiles,
      ),
      kind,
    )
      .map((option) => ({
        ...option,
        group: group.label,
      })),
  );
}

function inferRouteSurface(profile: ModelProfile): CatalogEntry['routeSurface'] {
  if (profile.routeSurface) return profile.routeSurface;
  if (profile.providerType === 'local') return 'local';
  if (profile.providerType === 'openrouter') return 'pool';
  if (profile.authSource === 'codex-subscription') return 'subscription';
  return 'api-key';
}

function catalogKey(
  providerType: CatalogKeyProviderType,
  routeSurface: CatalogEntry['routeSurface'],
  model: string | undefined,
): string {
  return `${providerType ?? 'other'}:${routeSurface}:${normalizeCatalogModelId(model ?? '')}`;
}

function profileCatalogKey(profile: ModelProfile): string {
  return catalogKey(profile.providerType, inferRouteSurface(profile), profile.model);
}

function entryCatalogKey(entry: CatalogEntry): string {
  return catalogKey(entry.providerType, entry.routeSurface, entry.model);
}

function suppressMaterializedConnectionCatalogEntries(
  entries: readonly CatalogEntry[],
  profiles: readonly ModelProfile[],
): readonly CatalogEntry[] {
  // Settings keeps connection-managed catalog rows visible so they can show
  // "On your team"; pickers use the materialised profile as the canonical row,
  // so the raw catalog option would be a duplicate.
  const materializedConnectionKeys = new Set(
    profiles
      .filter(isConnectionManagedProfile)
      .map(profileCatalogKey),
  );
  return entries.filter((entry) => !materializedConnectionKeys.has(entryCatalogKey(entry)));
}

function catalogEntriesToOptions(
  entries: readonly CatalogEntry[],
  kind: CatalogKind,
): Array<{ value: string; label: string }> {
  return entries
    .filter((entry) => catalogEntryMatchesKind(entry, kind))
    .map((entry) => ({
      value: entry.model,
      label: entry.label,
    }));
}

function catalogEntryMatchesKind(entry: CatalogEntry, kind: CatalogKind): boolean {
  switch (kind) {
    case 'main':
    case 'long-context':
      return entry.isMainModel;
    case 'auxiliary':
      return entry.isAuxiliaryModel;
    case 'all':
      return entry.isMainModel || entry.isAuxiliaryModel;
    case 'none':
      return false;
  }
}

function toModelChoiceOption(model: { value: string; label: string }): ModelChoiceOption {
  return {
    value: model.value,
    label: model.label,
  };
}

function toAnthropicAuxiliaryOption(model: { value: string; label: string; auxiliaryHint?: string }): ModelChoiceOption {
  return {
    value: model.value,
    label: model.auxiliaryHint ? `${model.label} ${model.auxiliaryHint}` : model.label,
  };
}

/**
 * Recurrence backstop for the 260603 opus-4-8 working-dropdown bug class.
 *
 * Working and Thinking roles share `catalogKindForRole === 'main'` for every
 * provider supported today, so each call to `buildModelChoiceOptions` for the
 * same `(activeProvider, kind=main)` MUST produce the same `catalogModels`
 * model-id set across roles. If a future change re-introduces a
 * role-asymmetric suppression bug (e.g. another `allProfiles` keyset
 * mistake), this surfaces it as a Sentry-visible warning instead of silently
 * dropping a model from one dropdown.
 *
 * Observational only — never throws. Logs once per session per
 * `(activeProvider, kind)` fingerprint to avoid spamming on every Settings
 * re-render. Skipped for non-main kinds, single-role contexts (e.g.
 * `background`, `recovery`), and providers whose Working/Thinking kinds
 * legitimately differ.
 */
type AssertableRole = Extract<RoleId, 'working' | 'thinking'>;

const mainCatalogByFingerprint = new Map<string, Partial<Record<AssertableRole, string[]>>>();
const warnedFingerprints = new Set<string>();

interface AssertSameMainCatalogContext {
  activeProvider: ActiveProvider | undefined;
  role: RoleId;
  taskGroup?: BtsTaskGroup;
}

export function assertSameMainCatalog(
  result: ModelChoiceOptions,
  ctx: AssertSameMainCatalogContext,
): void {
  if (ctx.role !== 'working' && ctx.role !== 'thinking') return;
  const kind = catalogKindForRole(ctx.role, ctx.taskGroup);
  if (kind !== 'main') return;

  const fingerprint = `${ctx.activeProvider ?? 'unknown'}:${kind}`;
  const ids = result.catalogModels.map((option) => option.value).sort();
  const cached = mainCatalogByFingerprint.get(fingerprint) ?? {};
  cached[ctx.role] = ids;
  mainCatalogByFingerprint.set(fingerprint, cached);

  const working = cached.working;
  const thinking = cached.thinking;
  if (!working || !thinking) return;

  const workingSet = new Set(working);
  const thinkingSet = new Set(thinking);
  const workingOnly = working.filter((id) => !thinkingSet.has(id));
  const thinkingOnly = thinking.filter((id) => !workingSet.has(id));
  if (workingOnly.length === 0 && thinkingOnly.length === 0) return;

  if (warnedFingerprints.has(fingerprint)) return;
  warnedFingerprints.add(fingerprint);

  console.warn('[buildModelChoiceOptions] role-asymmetric catalog divergence', {
    workingOnly,
    thinkingOnly,
    activeProvider: ctx.activeProvider ?? 'unknown',
    kind,
  });
}

export function resetAssertSameMainCatalogStateForTests(): void {
  mainCatalogByFingerprint.clear();
  warnedFingerprints.clear();
}
