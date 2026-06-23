import { normalizeModel } from './modelNormalization';
import type { RoutingModelId } from './modelChoiceCodec';

declare const wireModelIdBrand: unique symbol;

export type WireModelId = string & { readonly [wireModelIdBrand]: true };

function mintWireModelId(value: string): WireModelId {
  return value as WireModelId;
}

export function brandRouteWireModel(value: string): WireModelId {
  // Route decisions already computed the exact wire value. Brand it without
  // trimming, prefix stripping, or alias normalization.
  return value as WireModelId;
}

declare const directAnthropicBareWireModelBrand: unique symbol;

/**
 * A WireModelId proven to be a bare direct-Anthropic wire model id (no
 * provider prefix). Minted ONLY by the direct-Anthropic route chokepoint
 * (`resolveDirectAnthropicModel`) via `brandDirectAnthropicBareWireModel`. The
 * brand lives here (the allowlisted WireModelId minter home) so the
 * `no-model-brand-casts` lint keeps brand construction at the sanctioned boundary.
 */
export type DirectAnthropicBareWireModel = WireModelId & {
  readonly [directAnthropicBareWireModelBrand]: true;
};

/**
 * Brand an already-stripped model id as a bare direct-Anthropic wire string. Strip-only by
 * contract: the caller (`resolveDirectAnthropicModel`) has already removed exactly
 * one `anthropic/` prefix; this does NOT normalize dotted/legacy aliases (unlike
 * `mintAnthropicWireModel`), preserving the historical `brandRouteWireModel(strip(...))`
 * behaviour of the direct-Anthropic route arms.
 */
export function brandDirectAnthropicBareWireModel(stripped: string): DirectAnthropicBareWireModel {
  return stripped as DirectAnthropicBareWireModel;
}

export function mintAnthropicWireModel(model: RoutingModelId): WireModelId {
  const trimmed = model.trim();
  // Preserve resolveAnthropicWireModel's original semantics exactly: normalize
  // dotted/legacy aliases (e.g. `claude-opus-4.7` -> `claude-opus-4-7`) ONLY
  // when stripping the `anthropic/` provider prefix. A bare id is sent as-is —
  // do NOT normalize it, so a bare legacy/dotted id can't be silently migrated
  // to a different model on the wire (Stage 1 is type-hardening, not a behaviour
  // change; the bare-vs-prefixed normalization asymmetry is intentional/legacy).
  if (trimmed.startsWith('anthropic/')) {
    return mintWireModelId(normalizeModel(trimmed.slice('anthropic/'.length)));
  }
  return mintWireModelId(trimmed);
}

export function mintOpenRouterPassthroughModel(model: RoutingModelId): WireModelId {
  return mintWireModelId(model.trim());
}

export function mintOpenAiWireModel(model: RoutingModelId): WireModelId {
  return mintWireModelId(model);
}
