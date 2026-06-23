/**
 * Request Classification for the Local Model Proxy (Stage 12)
 *
 * Part of the CHIEF_ENGINEER2 hotspot-refactor roadmap
 * (`docs/plans/260526_hotspot-refactor-roadmap/PLAN.md`, Stage 12).
 *
 * This module splits "request classification" from "upstream execution".
 * `handleMessagesRequest` previously decided the OpenRouter / Codex /
 * route-table / profile branch, rewrote models, AND constructed the upstream
 * request in one nested flow — the exact shape that produced the recurring
 * "omitted-axis" matrix bugs (PMs 260429 Anthropic-native-under-Codex, 260504
 * Codex passthrough Claude leak, 260507 lead-agent transport×routeScope; live
 * production signal REBEL-540 "Claude model leaked to Codex proxy").
 *
 * `classifyRequest` returns a typed {@link RequestClassification} with the
 * request's axes made explicit. The KEY structural win is the **model-dialect
 * axis**: the only way to obtain the egress model for a Codex transport is via
 * {@link remapToCodexEgressModel}, which returns a branded {@link CodexEgressModel}.
 * Because the Codex classification's `egressModel` field is typed
 * `CodexEgressModel` (not `string`), constructing a Codex upstream request with
 * an un-remapped `claude-`-dialect model name is a **type error**, not a silent
 * runtime leak. See the boundary-registry entry `codex-model-dialect-axis`.
 *
 * Boundary note: this module is reached by the cloud bootstrap
 * (`cloud-service/src/bootstrap.ts` imports `proxyManager` from `src/main`), so
 * it MUST NOT import `electron`. All dependencies here are `@core` / `@shared`.
 * The Stage 11 no-electron-import invariant guards the parent module.
 *
 * Scope guardrail: this classifier CONSUMES the routing decision; it does NOT
 * re-implement provider selection. Provider/route resolution lives in
 * `@core/rebelCore/providerRouting.ts` (a separate boundary/hotspot) and, for
 * the route-table lookup, in `localModelProxyServer.resolveRouteProfile`.
 */

import type { IncomingHttpHeaders } from 'node:http';
import { getWorkingModelProfile } from '@shared/types';
import { isCodexModelSupported } from '@shared/data/codexModels';
import { getSettings } from '@core/services/settingsStore';

/** Codex's deterministic default model when no working profile is configured. */
export const CODEX_DEFAULT_MODEL = 'gpt-5.5';

/**
 * The model-dialect axis. Pins WHICH wire dialect an inbound model name speaks,
 * so a transport branch can never silently forward a model in the wrong dialect
 * (the REBEL-540 / PM 260429 / PM 260504 class).
 *
 * - `anthropic-native` — `claude-*` (and `anthropic/claude-*`). MUST NOT reach
 *   the Codex Responses endpoint.
 * - `openai-codex`     — an OpenAI model name Codex accepts.
 * - `openai-other`     — an OpenAI-shaped model name Codex does NOT accept
 *   (e.g. a stale `gpt-5.5-pro`; the REBEL-520 mirror case).
 */
export type ModelDialect = 'anthropic-native' | 'openai-codex' | 'openai-other';

/**
 * Classify a raw inbound model name onto the {@link ModelDialect} axis.
 *
 * The anthropic-native predicate is aligned with the parent module's
 * `isAnthropicModel` (PM 260505 prefix canonicalization): it matches BOTH the
 * bare `claude-*` dialect AND the OpenRouter `anthropic/claude-*` (vendor-
 * prefixed) dialect, case-insensitively. A prefixed claude id therefore cannot
 * dodge the claude-leak remap by being mis-classified as `openai-other`.
 */
export function classifyModelDialect(rawModel: string): ModelDialect {
  const lower = rawModel.toLowerCase();
  if (lower.startsWith('claude-') || lower.startsWith('anthropic/')) {
    return 'anthropic-native';
  }
  return isCodexModelSupported(rawModel) ? 'openai-codex' : 'openai-other';
}

/**
 * A model name that has been PROVEN safe to send to the Codex Responses
 * endpoint: it is not a `claude-`-dialect name, and it is a Codex-supported
 * OpenAI model. The unique brand makes this assignable only from the output of
 * {@link remapToCodexEgressModel} — a plain `string` (e.g. an un-remapped
 * `claude-opus-4-7`) is NOT assignable to it. This is what turns the
 * "claude-under-Codex" leak from a silent runtime bug into a compile error at
 * the upstream-request construction site.
 */
export type CodexEgressModel = string & { readonly __brand: 'CodexEgressModel' };

/**
 * Diagnostics emitted by {@link remapToCodexEgressModel} when a model had to be
 * remapped at the proxy egress (i.e. an upstream routing guard was bypassed).
 * Passed back as data so this module stays free of the parent's logger / error
 * reporter wiring (and free of any electron-adjacent imports).
 */
export type CodexRemapDiagnostic =
  | {
      /** The PM 260429 / 260504 / REBEL-540 Claude-leak case. */
      reason: 'claude-leak';
      requestedModel: string;
      remappedModel: string;
    }
  | {
      /** The REBEL-520 mirror: a Codex-unsupported OpenAI model (e.g. gpt-5.5-pro). */
      reason: 'codex-unsupported';
      requestedModel: string;
      remappedModel: string;
      workingProfileId: string | null;
      workingProfileModel: string | null;
      workingProfileProvider: string | null;
    };

export interface CodexEgressModelResolution {
  /** Brand-typed model proven safe for Codex egress. */
  model: CodexEgressModel;
  /** The raw inbound model name, preserved for diagnostics / response attribution. */
  rawModel: string;
  /** The dialect the raw inbound model spoke (before any remap). */
  inboundDialect: ModelDialect;
  /**
   * Present iff a defence-in-depth remap fired (a routing guard upstream was
   * bypassed). The parent module logs / captures these — keeping the
   * side-effecting reporter out of the classifier.
   */
  diagnostic?: CodexRemapDiagnostic;
}

/**
 * The single constructor of {@link CodexEgressModel}. Encapsulates BOTH
 * defence-in-depth remaps that previously lived inline in
 * `handleMessagesRequest`:
 *
 *  1. `claude-*` (anthropic-native) → working-profile model, else Codex default.
 *     (PM 260429 / 260504 / REBEL-540 — the Claude-leak guard.)
 *  2. Codex-unsupported OpenAI model (e.g. `gpt-5.5-pro`) → working-profile
 *     model if Codex-supported, else Codex default. (REBEL-520 mirror.)
 *
 * Behaviour is byte-for-byte the same as the previous inline logic; the only
 * change is that the result is brand-typed so callers cannot bypass it.
 *
 * `settingsOverride` is a test/seam hook; production passes nothing and the
 * function reads `getSettings()` exactly as the inline code did.
 */
export function remapToCodexEgressModel(
  rawModel: string,
  settingsOverride?: ReturnType<typeof getSettings>,
): CodexEgressModelResolution {
  // Mirror the inline default: an empty/undefined model name became 'gpt-5.5'
  // BEFORE the claude-prefix check ran. We preserve that ordering.
  const requested = rawModel || CODEX_DEFAULT_MODEL;
  const inboundDialect = classifyModelDialect(requested);

  // Case 1: claude-* leak. Remap to working-profile model or Codex default.
  //
  // REBEL-520 cascade (R1): HEAD's inline logic ran the two guards as a cascade
  // on a mutable `modelName` — the claude branch set `modelName = wp?.model ||
  // 'gpt-5.5'`, then the SECOND guard re-checked that remapped value and, if it
  // was a Codex-unsupported OpenAI model (the single deny-listed `gpt-5.5-pro`),
  // corrected it to the Codex default. We must reproduce that second-stage
  // re-check here: a claude-leak whose working-profile model is `gpt-5.5-pro`
  // MUST egress `gpt-5.5`, not `gpt-5.5-pro` (which Codex rejects with HTTP 400).
  // Gating the remap target on `isCodexModelSupported` makes this branch
  // byte-for-byte identical to HEAD's claude→REBEL-520 cascade outcome.
  if (inboundDialect === 'anthropic-native') {
    const settings = settingsOverride ?? getSettings();
    const wp = getWorkingModelProfile(settings);
    const remapped =
      wp?.model && isCodexModelSupported(wp.model) ? wp.model : CODEX_DEFAULT_MODEL;
    return {
      model: remapped as CodexEgressModel,
      rawModel,
      inboundDialect,
      diagnostic: {
        reason: 'claude-leak',
        requestedModel: requested,
        remappedModel: remapped,
      },
    };
  }

  // Case 2: REBEL-520 — a Codex-unsupported OpenAI model. Remap to a supported
  // working-profile model or the Codex default. (Identical to the inline guard:
  // it only fired for non-claude models, which is now guaranteed by the branch
  // above returning early.)
  if (inboundDialect === 'openai-other') {
    const settings = settingsOverride ?? getSettings();
    const wp = getWorkingModelProfile(settings);
    const remapped =
      wp?.model && isCodexModelSupported(wp.model) ? wp.model : CODEX_DEFAULT_MODEL;
    return {
      model: remapped as CodexEgressModel,
      rawModel,
      inboundDialect,
      diagnostic: {
        reason: 'codex-unsupported',
        requestedModel: requested,
        remappedModel: remapped,
        workingProfileId: wp?.id ?? null,
        workingProfileModel: wp?.model ?? null,
        workingProfileProvider: wp?.providerType ?? null,
      },
    };
  }

  // Case 3: already a Codex-supported OpenAI model — pass through unchanged.
  return {
    model: requested as CodexEgressModel,
    rawModel,
    inboundDialect,
  };
}

// ── Request classification axes ────────────────────────────────────────────

/**
 * WHO/what shape the inbound consumer is. Distinguishes the explicit-transport
 * passthrough consumers (signalled by headers set upstream) from the
 * route-resolved consumer (council member / lead agent / base profile).
 */
export type ConsumerClass =
  | 'openrouter-turn'
  | 'codex-turn'
  | 'route-resolved';

/**
 * The wire transport the upstream call will use. This is the axis the prior
 * bugs omitted; making it the discriminant forces every branch to be handled.
 */
export type ProviderTransport =
  | 'openrouter-passthrough'
  | 'codex-responses'
  | 'route-resolved'; // resolved later by resolveRouteProfile (anthropic / openai-compatible / OR-fallback)

/** Stream contract the inbound request asked for. */
export type StreamContract = 'streaming' | 'non-streaming';

/** Whether the inbound request carries Anthropic structured-output enforcement. */
export type StructuredOutputContract = 'anthropic-output-format' | 'none';

/**
 * Codex auth always injects an OAuth bearer (no inbound credential is trusted);
 * OpenRouter injects the resolved OR bearer; route-resolved auth is decided
 * per-profile downstream. Pinned here so the auth axis is explicit even though
 * the actual injection still happens in the upstream handlers (Stage 13
 * consolidates the injectors).
 */
export type AuthPlan = 'codex-oauth' | 'openrouter-bearer' | 'route-resolved';

interface BaseClassification {
  streamContract: StreamContract;
  structuredOutputContract: StructuredOutputContract;
  /** Turn id resolved by the parent (header + __legacy__ fallback). */
  turnId: string | undefined;
}

/**
 * The typed result of classifying an inbound `/v1/messages` request. A
 * discriminated union on {@link ConsumerClass} / {@link ProviderTransport}: the
 * Codex variant carries the brand-typed {@link CodexEgressModel}, so the Codex
 * upstream-request construction site cannot compile with a raw model name.
 */
export type RequestClassification =
  | (BaseClassification & {
      consumerClass: 'openrouter-turn';
      providerTransport: 'openrouter-passthrough';
      authPlan: 'openrouter-bearer';
    })
  | (BaseClassification & {
      consumerClass: 'codex-turn';
      providerTransport: 'codex-responses';
      authPlan: 'codex-oauth';
      /** Model-dialect axis, brand-typed: proven non-claude, Codex-supported. */
      egress: CodexEgressModelResolution;
    })
  | (BaseClassification & {
      consumerClass: 'route-resolved';
      providerTransport: 'route-resolved';
      authPlan: 'route-resolved';
    });

/** Minimal inbound shape the classifier needs (subset of AnthropicRequest). */
export interface ClassifiableRequest {
  model?: string;
  stream?: boolean;
  output_format?: unknown;
}

/**
 * The transport-dispatch headers, owned here so the raw header-string literals
 * live in ONE typed place (the transport axis) rather than being re-derived at
 * the call site. Set upstream by agentTurnExecutor (`x-openrouter-turn`) and
 * buildCodexProxyEnv (`x-codex-turn`).
 */
const OPENROUTER_TURN_HEADER = 'x-openrouter-turn';
const CODEX_TURN_HEADER = 'x-codex-turn';

export interface ClassifyRequestInput {
  /** Inbound request headers (transport dispatch is detected from these). */
  headers: IncomingHttpHeaders;
  /** Parsed inbound body (Anthropic-shaped). */
  request: ClassifiableRequest;
  /** Turn id resolved by the parent (header + __legacy__ fallback). */
  turnId: string | undefined;
  /** Test/seam hook; production omits and the Codex remap reads getSettings(). */
  settingsOverride?: ReturnType<typeof getSettings>;
}

/**
 * Classify an inbound `/v1/messages` request into a typed
 * {@link RequestClassification}. Mirrors the dispatch ORDER of the original
 * `handleMessagesRequest`: OpenRouter-turn first, then Codex-turn, then the
 * route-resolved path (Anthropic passthrough / base profile / route table —
 * still resolved by `resolveRouteProfile` in the parent).
 *
 * This function is pure aside from the Codex remap's `getSettings()` /
 * `getWorkingModelProfile()` reads (which exactly reproduce the previous inline
 * reads). It performs NO provider selection beyond the transport-header
 * dispatch the parent already did inline.
 */
export function classifyRequest(input: ClassifyRequestInput): RequestClassification {
  const { headers, request, turnId, settingsOverride } = input;

  const isOpenRouterTurn = headers[OPENROUTER_TURN_HEADER] === 'true';
  const isCodexTurn = headers[CODEX_TURN_HEADER] === 'true';

  const base: BaseClassification = {
    streamContract: request.stream ? 'streaming' : 'non-streaming',
    structuredOutputContract: request.output_format ? 'anthropic-output-format' : 'none',
    turnId,
  };

  if (isOpenRouterTurn) {
    return {
      ...base,
      consumerClass: 'openrouter-turn',
      providerTransport: 'openrouter-passthrough',
      authPlan: 'openrouter-bearer',
    };
  }

  if (isCodexTurn) {
    return {
      ...base,
      consumerClass: 'codex-turn',
      providerTransport: 'codex-responses',
      authPlan: 'codex-oauth',
      egress: remapToCodexEgressModel(request.model ?? '', settingsOverride),
    };
  }

  return {
    ...base,
    consumerClass: 'route-resolved',
    providerTransport: 'route-resolved',
    authPlan: 'route-resolved',
  };
}
