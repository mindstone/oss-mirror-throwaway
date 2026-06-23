import type { AppSettings, ModelProfile } from '../types';
import { isCodexSubscriptionProfile } from './providerKeys';
import { toBillingFamily } from './modelIdClassifier';

export type BillingSource = 'subscription' | 'pool' | 'pay-per-use' | 'local';

function decodeOptionValue(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Provider/route-conditional inputs the bare/slash-id billing flip keys on. These
 * are exactly the fields `resolveBillingSourceForOption` reads from `AppSettings`
 * for the bare/slash path — extracted so a pure caller (e.g. the model
 * recommendation engine in `src/core/`) can resolve effective cost per route-aware
 * candidate row WITHOUT manufacturing a partial `AppSettings`.
 */
export interface BillingSourceModelContext {
  /** The option-value string the user reaches the model by (bare id or slash-id). */
  readonly optionValue: string;
  readonly activeProvider: AppSettings['activeProvider'];
  /** Whether the user has a personal OpenRouter OAuth token (`openRouter.oauthToken`). */
  readonly hasOpenRouterOAuth: boolean;
  readonly codexConnected: boolean;
}

/**
 * PURE billing-source resolution for a single route-aware model option value.
 *
 * Carries the bare/slash-id flip logic ONLY. It does NOT handle the `profile:` or
 * `model:` wrapper prefixes (those need the full `AppSettings` to resolve a
 * profile / recurse) — those stay in {@link resolveBillingSourceForOption}, which
 * delegates the bare/slash tail here.
 *
 * Pre-processing ORDER (must match the historical `resolveBillingSourceForOption`
 * tail): trim/empty → local `ollama:` prefix → slash-id → bare `gpt-` → bare
 * `claude-` → fallback `pay-per-use`.
 */
export function resolveBillingSourceForModel(
  context: BillingSourceModelContext
): BillingSource | undefined {
  const { optionValue, activeProvider, hasOpenRouterOAuth, codexConnected } = context;
  // PARTIAL delegation: the model-id SYNTAX family classification (trim/empty →
  // local → slash → gpt → pay-per-use, in billing's order) moves to the
  // centralized `toBillingFamily`. The provider/route-conditional FLIPS
  // (mindstone→subscription, OAuth→pool, codex→subscription) STAY here — billing
  // must not inherit route-dialect semantics.
  switch (toBillingFamily(optionValue)) {
    case 'empty':
      return undefined;
    case 'local':
      return 'local';
    case 'slash':
      if (activeProvider === 'mindstone') {
        return 'subscription';
      }
      return hasOpenRouterOAuth ? 'pool' : 'pay-per-use';
    case 'gpt':
      return codexConnected ? 'subscription' : 'pay-per-use';
    case 'pay-per-use':
      // Both bare `claude-` and any other bare id collapse here (billing does
      // not distinguish them).
      return 'pay-per-use';
  }
}

/**
 * Thin adapter over {@link resolveBillingSourceForModel}. Resolves the `profile:`
 * and `model:` wrapper prefixes (which need the full `AppSettings`), then delegates
 * the bare/slash-id tail to the pure helper. Signature + behaviour preserved.
 *
 * The `profile:` / `model:` prefix stripping below is NOT consolidated onto the
 * canonical `@shared/utils/btsModelValueNormalization` decoders (`decodePrefixed`
 * et al.) because this site's decode DIVERGES from them in load-bearing ways
 * (pinned by `btsStoragePrefixParsers.truthTable.test.ts`):
 *  - It URI-DECODES the stripped payload (`decodeOptionValue`, e.g. `'profile:a%20b'`
 *    → profile id `'a b'`, `'model:gpt%2F5'` → recurses on `'gpt/5'`). The canonical
 *    decoders never URI-decode, so swapping them in would break slash-id billing.
 *  - The payload is NOT trimmed (URI-decode only) and a `model:` prefix RECURSES so
 *    the bare/slash tail re-runs the full flip — not a single decode step.
 *  - Empty/unknown handling is billing-specific (`profile:` with no matching profile
 *    → `'pay-per-use'`; bare/unknown → the model flip), not the decoders' null/kinded result.
 */
export function resolveBillingSourceForOption(
  optionValue: string,
  settings: AppSettings,
  codexConnected: boolean
): BillingSource | undefined {
  const normalizedValue = optionValue.trim();
  if (!normalizedValue) {
    return undefined;
  }

  if (normalizedValue.startsWith('profile:')) {
    const profileId = decodeOptionValue(normalizedValue.slice('profile:'.length));
    const profile = settings.localModel?.profiles?.find((candidate) => candidate.id === profileId);
    return profile ? resolveBillingSourceForProfile(profile, settings, codexConnected) : 'pay-per-use';
  }

  if (normalizedValue.startsWith('model:')) {
    return resolveBillingSourceForOption(
      decodeOptionValue(normalizedValue.slice('model:'.length)),
      settings,
      codexConnected
    );
  }

  return resolveBillingSourceForModel({
    optionValue: normalizedValue,
    activeProvider: settings.activeProvider,
    hasOpenRouterOAuth: !!settings.openRouter?.oauthToken,
    codexConnected,
  });
}

export function resolveBillingSourceForProfile(
  profile: ModelProfile,
  settings: AppSettings,
  codexConnected: boolean
): BillingSource {
  if (profile.routeSurface === 'local' || profile.providerType === 'local') {
    return 'local';
  }

  if (profile.providerType === 'openrouter') {
    return settings.activeProvider === 'mindstone' ? 'subscription' : 'pool';
  }

  if (isCodexSubscriptionProfile(profile)) {
    return codexConnected ? 'subscription' : 'pay-per-use';
  }

  return 'pay-per-use';
}

export function billingSourceLabelSuffix(source: BillingSource | undefined): string {
  switch (source) {
    case 'subscription':
      return ' — Subscription';
    case 'pool':
      return ' — Credits';
    case 'pay-per-use':
      return ' — Pay-per-use';
    case 'local':
      return ' — Local';
    default:
      return '';
  }
}
