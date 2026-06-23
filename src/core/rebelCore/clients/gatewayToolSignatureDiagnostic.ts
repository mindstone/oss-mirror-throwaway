/**
 * Gateway tool-signature diagnostic — observability-only.
 *
 * Custom OpenAI-compatible gateways that front Gemini (e.g. a litellm→Vertex
 * proxy) must echo Gemini's per-call `thought_signature` back across turns, or
 * Vertex rejects the next tool-calling turn with HTTP 400 *"Function call is
 * missing a thought_signature in functionCall parts"* (Sentry REBEL-5RJ variant
 * 2). There are TWO incompatible wire conventions for carrying that token over
 * the OpenAI shape, and we don't yet know which (if any) a given gateway
 * surfaces from production traffic:
 *
 * | Convention            | Where the signature lives                                   | Who uses it                          |
 * | --------------------- | ----------------------------------------------------------- | ------------------------------------ |
 * | Google OpenAI-compat  | `tool_calls[].extra_content.google.thought_signature`       | Google's endpoint + Rebel's proxy    |
 * | litellm               | embedded in `tool_call.id` (`call_xxx__thought__<sig>`) AND  | litellm proxies                      |
 * |                       | `tool_calls[].provider_specific_fields.thought_signature`   |                                      |
 *
 * This module MEASURES which convention a gateway surfaces by classifying the
 * tool-calls of a custom-gateway response and emitting one PII-safe analytics
 * event. The diagnostic never EXTRACTS, LOGS, or EMITS the signature VALUE — only
 * presence booleans/counts — and it never feeds anything back into request
 * building. (Note: for litellm's id-embedding convention the signature lives
 * INSIDE `tool_call.id`, which the OpenAI translation already preserves verbatim
 * into `ToolUseBlock.id`; the accurate claim is therefore that this diagnostic
 * never extracts/logs/emits the value, NOT that the value is "never stored".) The
 * round-trip / re-injection work is deferred until this telemetry tells us the
 * real scenario (see PLAN Stage 2b/2c).
 *
 * Fail-open: the emit is wrapped; a throwing tracker is logged, never propagated
 * into the turn path (AGENTS.md "silent failure is a bug" — observable, not
 * swallowed). The tracker is a no-op by default.
 *
 * @see docs/plans/260619_gemini-thought-signature-roundtrip/PLAN.md
 * @see docs/project/CUSTOM_GATEWAY_COMPATIBILITY.md §2
 */

import { createScopedLogger } from '@core/logger';
import { getTracker } from '@core/tracking';
import { ignoreBestEffortCleanup } from '@shared/utils/intentionalSwallow';
import type { OpenAIProviderType } from './openaiClientTypes';

/** litellm embeds the signature in the tool-call id with this delimiter. */
export const LITELLM_THOUGHT_ID_DELIMITER = '__thought__';

/** Analytics event name for the gateway tool-signature diagnostic. */
export const GATEWAY_TOOL_SIGNATURE_EVENT = 'Gateway Tool Signature Observed';

/** Schema version — bump when the event's dimension set changes. */
export const GATEWAY_TOOL_SIGNATURE_SCHEMA_VERSION = 1;

// Lazy logger: created on first use (only in the rare fail-open catch), NOT at
// module load — this module is imported by the OpenAI client, whose tests may
// partially mock `@core/logger`.
let _log: ReturnType<typeof createScopedLogger> | undefined;
const getLog = (): ReturnType<typeof createScopedLogger> =>
  (_log ??= createScopedLogger({ service: 'gatewayToolSignatureDiagnostic' }));

/** A tool-call viewed through the diagnostic's lens (loose, presence-only). */
export interface ClassifiableToolCall {
  id?: string;
  extra_content?: { google?: { thought_signature?: string } };
  provider_specific_fields?: { thought_signature?: string };
}

/** Per-tool-call presence classification. Booleans only — never the value. */
export interface ToolCallSignatureClassification {
  /** litellm: signature embedded in the tool-call id (`__thought__` delimiter). */
  idEmbedded: boolean;
  /** litellm: `provider_specific_fields.thought_signature` present. */
  providerSpecificFields: boolean;
  /** Google OpenAI-compat: `extra_content.google.thought_signature` present. */
  extraContent: boolean;
  /** Any of the above — i.e. the gateway surfaced a signature in some form. */
  any: boolean;
}

/**
 * Classify which thought_signature convention (if any) a tool-call carries.
 * Pure; reads only structural presence — NEVER the signature value.
 */
export function classifyToolCallSignature(
  toolCall: ClassifiableToolCall,
): ToolCallSignatureClassification {
  const idEmbedded =
    typeof toolCall.id === 'string' && toolCall.id.includes(LITELLM_THOUGHT_ID_DELIMITER);
  const providerSpecificFields = !!toolCall.provider_specific_fields?.thought_signature;
  const extraContent = !!toolCall.extra_content?.google?.thought_signature;
  return {
    idEmbedded,
    providerSpecificFields,
    extraContent,
    any: idEmbedded || providerSpecificFields || extraContent,
  };
}

/** Aggregate presence counts across a response's tool-calls. */
export interface ToolSignatureAggregate {
  toolCallCount: number;
  withIdEmbedded: number;
  withProviderSpecificFields: number;
  withExtraContent: number;
  withAnySignature: number;
}

/**
 * Reduce a list of tool-calls to presence counts. Shared by the streaming and
 * non-streaming seams.
 */
export function aggregateToolCallSignatures(
  toolCalls: readonly ClassifiableToolCall[],
): ToolSignatureAggregate {
  const agg: ToolSignatureAggregate = {
    toolCallCount: toolCalls.length,
    withIdEmbedded: 0,
    withProviderSpecificFields: 0,
    withExtraContent: 0,
    withAnySignature: 0,
  };
  for (const tc of toolCalls) {
    const c = classifyToolCallSignature(tc);
    if (c.idEmbedded) agg.withIdEmbedded += 1;
    if (c.providerSpecificFields) agg.withProviderSpecificFields += 1;
    if (c.extraContent) agg.withExtraContent += 1;
    if (c.any) agg.withAnySignature += 1;
  }
  return agg;
}

/** Already-aggregated presence flags (used by the streaming finalize seam). */
export interface PreAggregatedToolSignature {
  idEmbedded: boolean;
  providerSpecificFields: boolean;
  extraContent: boolean;
}

/**
 * Reduce streaming-accumulated per-tool-call flags to the same aggregate shape.
 * The streaming path OR-accumulates `provider_specific_fields`/`extra_content`
 * presence across deltas and checks `idEmbedded` from the final assembled id.
 */
export function aggregatePreClassifiedSignatures(
  flags: readonly PreAggregatedToolSignature[],
): ToolSignatureAggregate {
  const agg: ToolSignatureAggregate = {
    toolCallCount: flags.length,
    withIdEmbedded: 0,
    withProviderSpecificFields: 0,
    withExtraContent: 0,
    withAnySignature: 0,
  };
  for (const f of flags) {
    if (f.idEmbedded) agg.withIdEmbedded += 1;
    if (f.providerSpecificFields) agg.withProviderSpecificFields += 1;
    if (f.extraContent) agg.withExtraContent += 1;
    if (f.idEmbedded || f.providerSpecificFields || f.extraContent) agg.withAnySignature += 1;
  }
  return agg;
}

export interface EmitGatewayToolSignatureInput {
  /**
   * Whether this provider should run the diagnostic — pass the result of
   * `surfacesCustomGatewayToolSignature(providerType)` from
   * `providerFeatureGuards.ts`. The gate lives in that predicate module (not an
   * inline `providerType` literal) per the typed-capability-matrix lint rule.
   */
  shouldEmit: boolean;
  providerType: OpenAIProviderType;
  provider: string;
  modelId: string;
  streaming: boolean;
  aggregate: ToolSignatureAggregate;
}

/**
 * Emit the PII-safe gateway tool-signature diagnostic event. Gated by
 * `shouldEmit` (the custom-gateway predicate) — first-party openai / together /
 * cerebras never carry these conventions and would be noise. Emits only when the
 * response actually had tool-calls. Fail-open.
 *
 * Properties are booleans/counts/ids ONLY — NO signature value, NO tool args,
 * inputs, or names.
 */
export function emitGatewayToolSignatureObserved(input: EmitGatewayToolSignatureInput): void {
  if (!input.shouldEmit) return;
  if (input.aggregate.toolCallCount === 0) return;

  try {
    getTracker().track(GATEWAY_TOOL_SIGNATURE_EVENT, {
      schemaVersion: GATEWAY_TOOL_SIGNATURE_SCHEMA_VERSION,
      providerType: input.providerType,
      provider: input.provider,
      modelId: input.modelId,
      streaming: input.streaming,
      toolCallCount: input.aggregate.toolCallCount,
      withIdEmbedded: input.aggregate.withIdEmbedded,
      withProviderSpecificFields: input.aggregate.withProviderSpecificFields,
      withExtraContent: input.aggregate.withExtraContent,
      withAnySignature: input.aggregate.withAnySignature,
    });
  } catch (err) {
    // Fail-open: telemetry must never break a turn. Observable, not swallowed —
    // but the logging itself must also be guarded: `createScopedLogger` (or
    // `.warn`) can throw under a partially-mocked `@core/logger`, and that throw
    // would otherwise propagate into the turn path. Best-effort log, never escape.
    try {
      getLog().warn(
        { provider: input.provider, streaming: input.streaming, err },
        'gatewayToolSignatureDiagnostic emit failed — continuing',
      );
    } catch (logErr) {
      // The logger itself threw (e.g. `createScopedLogger` absent under a partial
      // `@core/logger` mock). Record the intentional swallow via the never-throws
      // helper rather than a bare empty catch — observability degrades to the
      // helper's own best-effort channel, and the turn path is never broken.
      ignoreBestEffortCleanup(logErr, {
        operation: 'gatewayToolSignatureDiagnostic.logEmitFailure',
        reason: 'observability-only diagnostic logger unavailable; must not break the turn',
      });
    }
  }
}
