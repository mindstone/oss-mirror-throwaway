/**
 * # roleAssignment — single source of truth for role-display state
 *
 * `resolveRoleAssignment` is the canonical "what is this role currently set
 * to, and is it healthy?" extractor consumed by every UI surface that
 * presents a role's model. Built on top of the strict runtime resolver
 * (`resolveDefaultModelForRole`) so the UI never lies about what runtime
 * will actually do.
 *
 * Replaces the lenient ad-hoc renderer resolvers that previously computed
 * active-role labels separately from runtime role health.
 *
 * Recovery (long-context fallback) is NOT in `resolveDefaultModelForRole`'s
 * scope — it's resolved here directly because the runtime path is in the
 * recovery pipeline, not the role resolver.
 *
 * @see docs/plans/260509_centralize_model_role_selection.md
 * @see docs/plans/260507_model_resolver_and_output_cap_autolearn.md
 */

import type { ActiveProvider, AppSettings, ModelProfile, ModelProviderType } from '@shared/types';
import {
  type ModelChoice,
  type RoleId,
  ROLE_LABELS,
} from '@shared/types/modelChoice';
import { decodeRoleChoice, decodeRoleFallback } from '@shared/utils/modelChoiceCodec';
import {
  type BillingSource,
  resolveBillingSourceForOption,
  resolveBillingSourceForProfile,
} from '@shared/utils/billingSource';
import {
  normalizeCatalogModelId,
  PROVIDER_CATALOGS,
  type CatalogEntry,
} from '@shared/data/providerCatalogs';
import { CODEX_ALL_MODEL_OPTIONS } from '@shared/data/codexModels';
import { OR_ALL_MODEL_OPTIONS } from '@shared/data/openRouterModels';
import { isProfileSelectable } from '@shared/utils/profileHelpers';
import {
  isConnectionLive,
  type ProfileConnectivity,
} from '@shared/utils/connectivityHelpers';
import { DEFAULT_AUXILIARY_MODEL, MODEL_OPTIONS } from '@shared/utils/modelNormalization';
import { getDefaultModelForProvider } from '@shared/utils/getDefaultModelForProvider';
import { resolveModelSettings } from '@shared/utils/modelSettingsResolver';
import {
  resolveModelRolePrecedence,
  summarizeRoleResolutionFailureReason,
  type ModelRole,
  type ModelRoleResolverSettings,
} from './modelRoleResolver';
import { assertNever } from '@shared/utils/assertNever';

const PROVIDER_LABELS: Record<ModelProviderType, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  google: 'Gemini',
  together: 'Together',
  cerebras: 'Cerebras',
  openrouter: 'OpenRouter',
  other: 'Custom',
  local: 'Local',
};

function activeProviderLabel(activeProvider: ActiveProvider | string | undefined): string {
  switch (activeProvider) {
    case 'codex':
      return 'ChatGPT Pro';
    case 'mindstone':
      return 'Mindstone';
    case 'openrouter':
      return 'OpenRouter';
    case 'anthropic':
      return 'Anthropic';
    case undefined:
    default:
      return 'Unknown';
  }
}

function providerLabelForProfile(
  profile: ModelProfile,
  activeProvider: ActiveProvider | string | undefined,
): string {
  if (profile.authSource === 'codex-subscription' || profile.routeSurface === 'subscription') {
    return 'ChatGPT Pro';
  }
  if (profile.providerType) {
    return PROVIDER_LABELS[profile.providerType] ?? activeProviderLabel(activeProvider);
  }
  return activeProviderLabel(activeProvider);
}

function providerLabelForCatalog(entry: CatalogEntry): string {
  if (entry.providerType === 'openai' && entry.routeSurface === 'subscription') {
    return 'ChatGPT Pro';
  }
  return PROVIDER_LABELS[entry.providerType] ?? 'Unknown';
}

function findCatalogEntry(modelId: string): CatalogEntry | undefined {
  const normalized = normalizeCatalogModelId(modelId);
  for (const entries of Object.values(PROVIDER_CATALOGS)) {
    const match = entries.find((entry) => entry.model === normalized);
    if (match) return match;
  }
  return undefined;
}

export type RoleStatus =
  | { kind: 'ok'; source: 'profile' | 'model' }
  | { kind: 'no-selection' }
  | { kind: 'missing-profile'; profileId: string }
  | { kind: 'assigned-but-disconnected'; profileId: string; providerLabel: string }
  | { kind: 'incomplete-profile'; profileId: string }
  | { kind: 'profile-unavailable-model-active'; profileId: string }
  | { kind: 'auto' }
  | { kind: 'off' };

export interface RoleDisplay {
  modelLabel: string;
  providerLabel: string;
  billingSource: BillingSource | null;
}

export interface RoleAssignment {
  role: RoleId;
  /** Human-facing label, e.g. "Working" / "Thinking" / "Background" / "Recovery". */
  label: string;
  /** The user's choice (decoded from storage). */
  primary: ModelChoice;
  /** The user's fallback choice, or null if none. Recovery has no fallback. */
  fallback: ModelChoice | null;
  /** Health of the primary choice. */
  status: RoleStatus;
  /** Display info for the primary choice (label / provider / billing). */
  display: RoleDisplay;
  /** Display info for the fallback, or null if no fallback. */
  fallbackDisplay: RoleDisplay | null;
  /** Bare model id the runtime would use right now. Null when status is auto/off. */
  effectiveModelId: string | null;
  /**
   * True when the primary choice is a bare model id that is absent from the
   * active-provider catalog, Claude fallback group, and the configured profile
   * models. Additive UI hint only; profiles/auto/off are never catalog-checked.
   */
  isUncatalogued?: boolean;
  /** Inline warning text when status !== 'ok'. */
  warning: string | null;
  /** Inline warning CTA label when status !== 'ok'. */
  warningCta: string | null;
}

export interface RoleAssignmentContext {
  /** Profiles to look up by id. Defaults to `settings.localModel?.profiles ?? []`. */
  profiles?: readonly ModelProfile[];
  /** Active provider for fallback display labelling. */
  activeProvider?: ActiveProvider | string;
  /** Whether ChatGPT Pro auth is healthy (controls subscription billing display). */
  codexConnected?: boolean;
  /** Source-connection health for connection-managed profiles. */
  connectivity?: ProfileConnectivity;
}

const STATUS_WARNINGS: Record<
  Exclude<RoleStatus['kind'], 'ok' | 'assigned-but-disconnected' | 'profile-unavailable-model-active'>,
  { warning: string; cta: string }
> = {
  'no-selection': { warning: 'No model selected.', cta: 'Pick a model' },
  'missing-profile': {
    warning: summarizeRoleResolutionFailureReason('role-key-references-unknown-profile'),
    cta: 'Pick another model',
  },
  'incomplete-profile': { warning: 'Selected profile needs setup.', cta: 'Finish setup' },
  auto: { warning: '', cta: '' },
  off: { warning: '', cta: '' },
};

function buildDisplayFromChoice(
  choice: ModelChoice,
  ctx: {
    profiles: readonly ModelProfile[];
    activeProvider: ActiveProvider | string | undefined;
    codexConnected: boolean;
    connectivity: ProfileConnectivity | undefined;
    settings: AppSettings | Partial<AppSettings> | null | undefined;
  },
): { display: RoleDisplay; status: RoleStatus | null; effectiveModelId: string | null } {
  switch (choice.kind) {
    case 'profile': {
      const profile = ctx.profiles.find((p) => p.id === choice.profileId);
      if (!profile) {
        return {
          display: { modelLabel: 'Unknown profile', providerLabel: '', billingSource: null },
          status: { kind: 'missing-profile', profileId: choice.profileId },
          effectiveModelId: null,
        };
      }
      if (!isProfileSelectable(profile) || profile.enabled === false || !profile.model?.trim()) {
        return {
          display: {
            modelLabel: profile.name || profile.model || profile.id,
            providerLabel: providerLabelForProfile(profile, ctx.activeProvider),
            billingSource: null,
          },
          status: { kind: 'incomplete-profile', profileId: choice.profileId },
          effectiveModelId: null,
        };
      }
      const providerLabel = providerLabelForProfile(profile, ctx.activeProvider);
      if (!isConnectionLive(profile, ctx.connectivity)) {
        return {
          display: {
            modelLabel: profile.name || profile.model || profile.id,
            providerLabel,
            billingSource: null,
          },
          status: { kind: 'assigned-but-disconnected', profileId: choice.profileId, providerLabel },
          effectiveModelId: null,
        };
      }
      return {
        display: {
          modelLabel: profile.name || profile.model,
          providerLabel,
          billingSource: resolveBillingSourceForProfile(
            profile,
            (ctx.settings ?? {}) as AppSettings,
            !!ctx.codexConnected,
          ),
        },
        status: null,
        effectiveModelId: profile.model,
      };
    }
    case 'model': {
      const entry = findCatalogEntry(choice.modelId);
      if (entry) {
        const billing: BillingSource = (() => {
          switch (entry.routeSurface) {
            case 'subscription': return 'subscription';
            case 'pool': return ctx.activeProvider === 'mindstone' ? 'subscription' : 'pool';
            case 'local': return 'local';
            case 'api-key': return 'pay-per-use';
          }
        })();
        return {
          display: {
            modelLabel: entry.label,
            providerLabel: providerLabelForCatalog(entry),
            billingSource: billing,
          },
          status: null,
          effectiveModelId: entry.model,
        };
      }
      return {
        display: {
          modelLabel: choice.modelId,
          providerLabel: activeProviderLabel(ctx.activeProvider),
          billingSource: resolveBillingSourceForOption(
            choice.modelId,
            (ctx.settings ?? {}) as AppSettings,
            !!ctx.codexConnected,
          ) ?? null,
        },
        status: null,
        effectiveModelId: choice.modelId,
      };
    }
    case 'inherit':
      return {
        display: { modelLabel: 'Same as Working', providerLabel: '', billingSource: null },
        status: null,
        effectiveModelId: null,
      };
    case 'auto':
      return {
        display: { modelLabel: 'Automatic', providerLabel: '', billingSource: null },
        status: { kind: 'auto' },
        effectiveModelId: null,
      };
    case 'off':
      return {
        display: { modelLabel: 'Off', providerLabel: '', billingSource: null },
        status: { kind: 'off' },
        effectiveModelId: null,
      };
  }
}

function finalizeStatus(
  primary: ModelChoice,
  preliminary: { status: RoleStatus | null; effectiveModelId: string | null },
): { status: RoleStatus; effectiveModelId: string | null } {
  if (preliminary.status) {
    return { status: preliminary.status, effectiveModelId: preliminary.effectiveModelId };
  }
  // No preliminary failure — derive ok-source from the choice kind.
  switch (primary.kind) {
    case 'profile':
      return { status: { kind: 'ok', source: 'profile' }, effectiveModelId: preliminary.effectiveModelId };
    case 'model':
      return { status: { kind: 'ok', source: 'model' }, effectiveModelId: preliminary.effectiveModelId };
    case 'inherit':
      return { status: { kind: 'ok', source: 'model' }, effectiveModelId: preliminary.effectiveModelId };
    case 'auto':
      return { status: { kind: 'auto' }, effectiveModelId: null };
    case 'off':
      return { status: { kind: 'off' }, effectiveModelId: null };
  }
}

function roleToRuntimeRole(role: RoleId): ModelRole | null {
  switch (role) {
    case 'working':
      return 'working';
    case 'thinking':
      return 'thinking';
    case 'background':
      return 'background';
    case 'recovery':
      return null;
    default:
      return assertNever(role);
  }
}

function decorateWithRuntimePrecedence(
  role: RoleId,
  primary: ModelChoice,
  preliminary: { display: RoleDisplay; status: RoleStatus | null; effectiveModelId: string | null },
  finalized: { status: RoleStatus; effectiveModelId: string | null },
  ctx: {
    profiles: readonly ModelProfile[];
    activeProvider: ActiveProvider | string | undefined;
    codexConnected: boolean;
    connectivity: ProfileConnectivity | undefined;
    settings: AppSettings | Partial<AppSettings> | null | undefined;
  },
): { display: RoleDisplay; status: RoleStatus; effectiveModelId: string | null } {
  const runtimeRole = roleToRuntimeRole(role);
  if (!runtimeRole || primary.kind !== 'profile') {
    return { display: preliminary.display, ...finalized };
  }

  const runtime = resolveModelRolePrecedence(
    runtimeRole,
    (ctx.settings ?? {}) as ModelRoleResolverSettings,
    ctx.profiles,
  );

  if (preliminary.status?.kind === 'assigned-but-disconnected') {
    return { display: preliminary.display, ...finalized };
  }

  if (preliminary.status?.kind === 'incomplete-profile' && runtime.effectiveModelId) {
    const runtimeDisplay = buildDisplayFromChoice(
      { kind: 'model', modelId: runtime.effectiveModelId },
      ctx,
    );
    return {
      display: runtimeDisplay.display,
      status: { kind: 'profile-unavailable-model-active', profileId: primary.profileId },
      effectiveModelId: runtime.effectiveModelId,
    };
  }

  if (runtime.failureReason) {
    return { display: preliminary.display, ...finalized };
  }

  return {
    display: preliminary.display,
    status: finalized.status,
    effectiveModelId: runtime.effectiveModelId,
  };
}

function statusToWarning(
  status: RoleStatus,
  display: RoleDisplay,
): { warning: string | null; cta: string | null } {
  if (status.kind === 'ok') return { warning: null, cta: null };
  if (status.kind === 'assigned-but-disconnected') {
    return {
      warning: `Reconnect ${status.providerLabel} to use this role.`,
      cta: null,
    };
  }
  if (status.kind === 'profile-unavailable-model-active') {
    return {
      warning: `Selected profile is unavailable. Using ${display.modelLabel} for now.`,
      cta: 'Review profile',
    };
  }
  const entry = STATUS_WARNINGS[status.kind];
  return {
    warning: entry.warning || null,
    cta: entry.cta || null,
  };
}

function hasAnthropicCredentials(settings: AppSettings | Partial<AppSettings> | null | undefined): boolean {
  const models = resolveModelSettings(settings ?? undefined);
  return Boolean(
    models.apiKey?.trim() ||
      (models.authMethod === 'oauth-token' && models.oauthToken?.trim()),
  );
}

function activeProviderCatalogIds(activeProvider: ActiveProvider | string | undefined): string[] {
  switch (activeProvider) {
    case 'codex':
      return CODEX_ALL_MODEL_OPTIONS.map((option) => option.value);
    case 'mindstone':
    case 'openrouter':
      return OR_ALL_MODEL_OPTIONS.map((option) => option.value);
    case 'anthropic':
    case undefined:
      return MODEL_OPTIONS.map((option) => option.value);
    default:
      return [];
  }
}

function claudeFallbackCatalogIds(
  settings: AppSettings | Partial<AppSettings> | null | undefined,
  activeProvider: ActiveProvider | string | undefined,
): string[] {
  const hasOpenRouterCredentials = Boolean(settings?.openRouter?.oauthToken);
  const canReachAnthropicViaFallback =
    activeProvider !== 'anthropic' && (hasAnthropicCredentials(settings) || hasOpenRouterCredentials);

  return canReachAnthropicViaFallback ? MODEL_OPTIONS.map((option) => option.value) : [];
}

function isUncataloguedBareModel(
  choice: ModelChoice,
  ctx: {
    profiles: readonly ModelProfile[];
    settings: AppSettings | Partial<AppSettings> | null | undefined;
    activeProvider: ActiveProvider | string | undefined;
  },
): boolean {
  if (choice.kind !== 'model') return false;

  const knownIds = new Set<string>();
  for (const modelId of activeProviderCatalogIds(ctx.activeProvider)) {
    knownIds.add(normalizeCatalogModelId(modelId));
  }
  for (const modelId of claudeFallbackCatalogIds(ctx.settings, ctx.activeProvider)) {
    knownIds.add(normalizeCatalogModelId(modelId));
  }
  for (const profile of ctx.profiles) {
    const profileModel = profile.model?.trim();
    if (profileModel) {
      knownIds.add(normalizeCatalogModelId(profileModel));
    }
  }

  return !knownIds.has(normalizeCatalogModelId(choice.modelId));
}

/**
 * Resolve the rich UI shape for a single role from settings.
 *
 * Runtime-covered roles (working / thinking / background→fast) derive their
 * effective model from the shared role precedence helper used by the runtime
 * resolver, then decorate that outcome with UI-only states. Recovery is a
 * UI-only carve-out because long-context fallback is resolved by the recovery
 * pipeline rather than `resolveDefaultModelForRole`.
 *
 * `effectiveModelId` reports what runtime would use right now for the
 * runtime-covered roles — null when no runtime model is available or the role
 * is set to off/auto/inherit.
 */
export function resolveRoleAssignment(
  role: RoleId,
  settings: AppSettings | Partial<AppSettings> | null | undefined,
  context: RoleAssignmentContext = {},
): RoleAssignment {
  const profiles = context.profiles ?? settings?.localModel?.profiles ?? [];
  const ctx = {
    profiles,
    activeProvider: context.activeProvider ?? settings?.activeProvider,
    codexConnected: !!context.codexConnected,
    connectivity: context.connectivity,
    settings,
  };

  const primary = decodeRoleChoice(role, settings ?? undefined, {
    defaultWorkingModel: getDefaultModelForProvider(
      settings ?? { activeProvider: ctx.activeProvider },
      'working',
    ),
    defaultBackgroundModel: DEFAULT_AUXILIARY_MODEL,
  });
  const fallback = decodeRoleFallback(role, settings ?? undefined);

  const preliminary = buildDisplayFromChoice(primary, ctx);
  const finalized = finalizeStatus(primary, preliminary);
  const decorated = decorateWithRuntimePrecedence(role, primary, preliminary, finalized, ctx);
  const status: RoleStatus = decorated.status;

  const fallbackBuild = fallback ? buildDisplayFromChoice(fallback, ctx) : null;

  const warningInfo = statusToWarning(status, decorated.display);

  return {
    role,
    label: ROLE_LABELS[role],
    primary,
    fallback,
    status,
    display: decorated.display,
    fallbackDisplay: fallbackBuild?.display ?? null,
    effectiveModelId: decorated.effectiveModelId,
    isUncatalogued: isUncataloguedBareModel(primary, ctx),
    warning: warningInfo.warning,
    warningCta: warningInfo.cta,
  };
}

/**
 * Resolve all four roles in one pass. Cheaper for callers that need the full
 * picture (Settings UI, breadcrumbs, conversation override panel).
 */
export function resolveAllRoleAssignments(
  settings: AppSettings | Partial<AppSettings> | null | undefined,
  context: RoleAssignmentContext = {},
): Record<RoleId, RoleAssignment> {
  return {
    working: resolveRoleAssignment('working', settings, context),
    thinking: resolveRoleAssignment('thinking', settings, context),
    background: resolveRoleAssignment('background', settings, context),
    recovery: resolveRoleAssignment('recovery', settings, context),
  };
}
