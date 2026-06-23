/**
 * Provider-aware default model resolution.
 *
 * Centralises the choice of working / thinking / background model so callers
 * never silently fall back to an Anthropic default when the user has selected
 * OpenRouter or Codex. The plan-doc context for this helper is
 * `docs/plans/260514_openrouter_sonnet_bypass_remediation.md` (Stage 1).
 *
 * Defensive fallback: when `activeProvider` is `undefined` (pre-normalization
 * call site, e.g. settingsUtils fires before activeProvider derivation later
 * in the same module) or an unknown literal (forward-compat with future
 * providers), the helper returns Anthropic Sonnet defaults. Plan-doc Failure
 * Mode Matrix #12 + the unit-test contract in `getDefaultModelForProvider.test.ts`
 * (the `undefined` and malformed-cast cases) mandate this defensive behaviour.
 *
 * Implementation note: `mindstone` (managed flat-fee tier) is handled first —
 * it is OpenRouter-transport but has its OWN cheap fallback values
 * (`MINDSTONE_DEFAULT_*`) mirroring the managed tier, distinct from BYO
 * OpenRouter. The remaining providers map onto the closed
 * {anthropic, openrouter, codex} default-domain before the discriminated-union
 * `switch`: `openrouter` keeps the BYO OR defaults; `codex` stays `codex`;
 * everything else (incl. `undefined`/unknown) defaults to `'anthropic'`. The
 * shared `isOpenRouterEffectiveProvider` predicate keeps OR-effectiveness in
 * lockstep with `settingsUtils`' `isEffectivelyOpenRouter`. `assertNever` in the
 * `default` arm is the compile-time exhaustiveness guard over the default-domain.
 *
 * Additionally, Mindstone background routing is handled at the role-wrapper
 * layer (`getDefaultModelForProvider` with `role === 'background'`): rather
 * than returning the managed-tier default unconditionally, it consults
 * `resolveBtsModel(settings)` so the user's BTS preference takes precedence
 * over the managed-tier seed when one is set. See
 * `docs/plans/260527_bts-tier-aware-default-resolver/PLAN.md`.
 */

import type { AppSettings } from '@shared/types';
import {
  OR_DEFAULT_WORKING_MODEL,
  OR_DEFAULT_THINKING_MODEL,
  OR_DEFAULT_BTS_MODEL,
  CODEX_DEFAULT_MODEL,
  CODEX_DEFAULT_BTS_MODEL,
  ANTHROPIC_DEFAULT_WORKING_MODEL,
  ANTHROPIC_DEFAULT_THINKING_MODEL,
  ANTHROPIC_DEFAULT_BACKGROUND_MODEL,
  MINDSTONE_DEFAULT_WORKING_MODEL,
  MINDSTONE_DEFAULT_THINKING_MODEL,
  MINDSTONE_DEFAULT_BTS_MODEL,
  isOpenRouterEffectiveProvider,
} from './providerDefaultConstants';
import type { ModelRoleTier } from '@shared/types';
import { assertNever } from './assertNever';
import { resolveBtsModel } from './btsModelResolver';
import { DEFAULT_AUXILIARY_MODEL } from './modelNormalization';

/**
 * The model-role tier to resolve a provider default for. Canonical type:
 * {@link ModelRoleTier} (single source of tier membership). Kept as a
 * domain-named alias for call-site readability.
 */
export type ProviderRole = ModelRoleTier;

const ANTHROPIC_DEFAULTS: ProviderModelDefaults = Object.freeze({
  provider: 'anthropic',
  working: ANTHROPIC_DEFAULT_WORKING_MODEL,
  thinking: ANTHROPIC_DEFAULT_THINKING_MODEL,
  background: ANTHROPIC_DEFAULT_BACKGROUND_MODEL,
}) as ProviderModelDefaults;

interface BaseProviderModelDefaults {
  readonly working: string;
  readonly thinking: string;
  readonly background: string;
}

export type ProviderModelDefaults =
  | (BaseProviderModelDefaults & { readonly provider: 'openrouter' })
  | (BaseProviderModelDefaults & { readonly provider: 'codex' })
  | (BaseProviderModelDefaults & { readonly provider: 'anthropic' });

/**
 * Loose input shape. We deliberately accept `string | undefined` for
 * `activeProvider` (rather than the narrower `ActiveProvider | undefined`)
 * because boundary call sites — turn context, partial settings, role
 * assignment ctx — surface this value pre-normalisation. The pre-normalisation
 * step below coerces anything other than `'openrouter'` / `'codex'` to
 * `'anthropic'`, so the loose input is safe and removes the need for casts
 * at the (many) call sites.
 */
export type ProviderDefaultsInput = Pick<
  AppSettings,
  'behindTheScenesModel' | 'behindTheScenesOverrides'
> & { activeProvider?: AppSettings['activeProvider'] | string };

export function getProviderModelDefaults(
  settings: ProviderDefaultsInput,
): ProviderModelDefaults {
  // Mindstone (managed flat-fee) is OpenRouter-transport but has its OWN cheap
  // fallback values mirroring the managed tier (see MINDSTONE_DEFAULT_* — the
  // server is the real source of truth; this only fires for unseeded slots).
  // Discriminant stays 'openrouter' (transport family); only the values differ
  // from BYO OpenRouter.
  if (settings.activeProvider === 'mindstone') {
    return {
      provider: 'openrouter',
      working: MINDSTONE_DEFAULT_WORKING_MODEL,
      thinking: MINDSTONE_DEFAULT_THINKING_MODEL,
      background: MINDSTONE_DEFAULT_BTS_MODEL,
    };
  }
  const provider: 'anthropic' | 'openrouter' | 'codex' =
    isOpenRouterEffectiveProvider(settings.activeProvider)
      ? 'openrouter'
      : settings.activeProvider === 'codex'
        ? 'codex'
        : 'anthropic';
  switch (provider) {
    case 'anthropic':
      return ANTHROPIC_DEFAULTS;
    case 'openrouter':
      return {
        provider: 'openrouter',
        working: OR_DEFAULT_WORKING_MODEL,
        thinking: OR_DEFAULT_THINKING_MODEL,
        background: OR_DEFAULT_BTS_MODEL,
      };
    case 'codex':
      return {
        provider: 'codex',
        working: CODEX_DEFAULT_MODEL,
        thinking: CODEX_DEFAULT_MODEL,
        background: CODEX_DEFAULT_BTS_MODEL,
      };
    default:
      return assertNever(provider);
  }
}

export function getDefaultModelForProvider(
  settings: ProviderDefaultsInput,
  role: ProviderRole = 'working',
): string {
  if (settings.activeProvider === 'mindstone' && role === 'background') {
    const btsModel = resolveBtsModel(settings);
    if (btsModel !== DEFAULT_AUXILIARY_MODEL) {
      return btsModel;
    }
  }

  return getProviderModelDefaults(settings)[role];
}
