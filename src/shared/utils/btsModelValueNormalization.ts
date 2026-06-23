/**
 * # BTS model value normalization
 *
 * Pure, dependency-free helpers and types for decoding/normalizing stored
 * BTS model values (`model:<id>` / `profile:<id>` / bare model id).
 *
 * These are extracted from `modelChoiceCodec.ts` so that low-level consumers
 * like `btsModelResolver.ts` can use them without pulling in the codec's
 * dependency on `modelSettingsResolver` (which would create a circular
 * dependency: `modelChoiceCodec → modelSettingsResolver →
 * getDefaultModelForProvider → btsModelResolver → modelChoiceCodec`).
 *
 * The codec re-exports these symbols for backward compatibility, so existing
 * `@shared/utils/modelChoiceCodec` imports keep working unchanged.
 */

export const PROFILE_PREFIX = 'profile:';
export const MODEL_PREFIX = 'model:';

declare const storedModelChoiceBrand: unique symbol;
declare const routingModelIdBrand: unique symbol;
declare const profileRefBrand: unique symbol;

export type StoredModelChoice = string & { readonly [storedModelChoiceBrand]: true };
export type RoutingModelId = string & { readonly [routingModelIdBrand]: true };
export type ProfileRef = string & { readonly [profileRefBrand]: true };

export type NormalizationRejectionReason =
  | 'invalid-type'
  | 'empty-or-whitespace'
  | 'empty-model-id'
  | 'empty-profile-id'
  | 'model-with-profile-prefix';

export type NormalizedBtsModelValue =
  | { ok: true; kind: 'model'; modelId: RoutingModelId }
  | { ok: true; kind: 'profile'; profileId: ProfileRef }
  | { ok: false; reason: NormalizationRejectionReason };

export type DecodedModelChoice =
  | { kind: 'model'; modelId: RoutingModelId }
  | { kind: 'profile'; profileId: ProfileRef }
  | { kind: 'inherit' }
  | { kind: 'auto' }
  | { kind: 'off' };

export function trim(value: string | null | undefined): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function mintStoredModelChoice(value: string): StoredModelChoice {
  return value as StoredModelChoice;
}

export function mintRoutingModelId(value: string): RoutingModelId {
  return value as RoutingModelId;
}

export function mintProfileRef(value: string): ProfileRef {
  return value as ProfileRef;
}

export function decodePrefixed(
  value: string | null | undefined,
): { kind: 'profile'; profileId: ProfileRef } | { kind: 'model'; modelId: RoutingModelId } | null {
  const trimmed = trim(value);
  if (!trimmed) return null;
  if (trimmed.startsWith(PROFILE_PREFIX)) {
    const profileId = trimmed.slice(PROFILE_PREFIX.length).trim();
    return { kind: 'profile', profileId: mintProfileRef(profileId) };
  }
  if (trimmed.startsWith(MODEL_PREFIX)) {
    const modelId = trimmed.slice(MODEL_PREFIX.length).trim();
    return modelId ? { kind: 'model', modelId: mintRoutingModelId(modelId) } : null;
  }
  // Bare (no-prefix) ids are passed through UN-trimmed by design: resolveRuntimeModels
  // routes through here, and the routing layer's contract is untrimmed passthrough
  // (pinned by modelResolution.test.ts "handles model with extra whitespace"; trailing
  // whitespace is cleaned downstream by the dialect wire minters). The prefixed branches
  // above DO trim because the prefix itself is being stripped.
  return { kind: 'model', modelId: mintRoutingModelId(value ?? '') };
}

export function decodeRoutingModelId(value: string | null | undefined): RoutingModelId | null {
  const decoded = decodePrefixed(value);
  return decoded?.kind === 'model' ? decoded.modelId : null;
}

export function unsafeAssertRoutingModelId(value: string): RoutingModelId {
  const decoded = decodeRoutingModelId(value);
  if (!decoded) {
    throw new Error(`Invalid routing model id "${value}"`);
  }
  return decoded;
}

// ESLint rule `bts-flow-shape/no-raw-bts-model-read` (configured in
// `eslint.config.mjs`) blocks new direct reads of
// `settings.behindTheScenesModel` / `settings.behindTheScenesOverrides`
// outside the S4.5 allowlist. To add a new decoded site, update that
// allowlist and route reads through this helper. See
// docs/plans/260518_bts_model_prefix_decoder_phase2a.md § S4.5.
/** Strip the `model:` storage prefix from a value that may have been written
 *  by the codec's `encodePrefixed`. Returns null when the input was non-null
 *  but stripped to empty (e.g. raw `'model:'`), so callers can fall through
 *  to their own default. A `profile:<id>` value is returned as a `ProfileRef`
 *  carrying the bare `<id>` (the `profile:` prefix is stripped); callers that
 *  need the wire/route form re-add the prefix at their boundary (e.g. BTS route
 *  reconstruction). The branded return type distinguishes the two cases.
 *
 *  This is the **canonical decoder** for `behindTheScenesModel` /
 *  `behindTheScenesOverrides[group]` reads. See
 *  docs/plans/260518_bts_model_prefix_decoder_phase2a.md.
 */
export function stripStoredModelPrefix(value: string): RoutingModelId | ProfileRef | null {
  const stored = mintStoredModelChoice(value);
  if (!stored.startsWith(MODEL_PREFIX)) {
    return stored.startsWith(PROFILE_PREFIX)
      ? mintProfileRef(stored.slice(PROFILE_PREFIX.length))
      : mintRoutingModelId(stored);
  }
  const stripped = value.slice(MODEL_PREFIX.length);
  return stripped.length > 0 ? mintRoutingModelId(stripped) : null;
}

/** Normalize a raw `behindTheScenesModel` / `behindTheScenesOverrides[group]`
 *  value into a kinded discriminator. Call sites branch on `kind` to apply
 *  per-site policy without re-classifying the string. Rejects the
 *  `model:profile:<id>` defensive collision with reason
 *  `'model-with-profile-prefix'` so that downstream sites cannot flatten it
 *  back to a bare `profile:<id>` string and leak it to the wire.
 *
 *  See docs/plans/260518_bts_profile_missing_p1_and_nits.md § MFix 8 Rev 2
 *  and § S3-refine-2.
 */
export function normalizeStoredBtsModelValue(
  rawValue: unknown,
): NormalizedBtsModelValue {
  if (typeof rawValue !== 'string') return { ok: false, reason: 'invalid-type' };
  const trimmed = rawValue.trim();
  if (!trimmed) return { ok: false, reason: 'empty-or-whitespace' };

  if (trimmed.startsWith(MODEL_PREFIX)) {
    const modelId = trimmed.slice(MODEL_PREFIX.length).trim();
    if (!modelId) return { ok: false, reason: 'empty-model-id' };
    if (modelId.startsWith(PROFILE_PREFIX)) {
      return { ok: false, reason: 'model-with-profile-prefix' };
    }
    return { ok: true, kind: 'model', modelId: mintRoutingModelId(modelId) };
  }

  if (trimmed.startsWith(PROFILE_PREFIX)) {
    const profileId = trimmed.slice(PROFILE_PREFIX.length).trim();
    return profileId
      ? { ok: true, kind: 'profile', profileId: mintProfileRef(profileId) }
      : { ok: false, reason: 'empty-profile-id' };
  }

  return { ok: true, kind: 'model', modelId: mintRoutingModelId(trimmed) };
}

export function rejectionReasonLabel(reason: NormalizationRejectionReason): string {
  switch (reason) {
    case 'invalid-type':
      return 'invalid type (not a string)';
    case 'empty-or-whitespace':
      return 'empty or whitespace input';
    case 'empty-model-id':
      return 'empty model id';
    case 'empty-profile-id':
      return 'empty profile id';
    case 'model-with-profile-prefix':
      return 'model value with profile prefix (model:profile:...)';
    default: {
      const _exhaustive: never = reason;
      return _exhaustive;
    }
  }
}
