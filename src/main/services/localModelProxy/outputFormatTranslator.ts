/**
 * Central Anthropic→OpenAI structured-output translator for the Local Model
 * Proxy (Stage 13).
 *
 * Part of the CHIEF_ENGINEER2 hotspot-refactor roadmap
 * (`docs/plans/260526_hotspot-refactor-roadmap/PLAN.md`, Stage 13).
 *
 * BTS callers send Anthropic-shaped `output_format`; every Anthropic→OpenAI
 * translator branch in the proxy MUST turn that into an OpenAI
 * `response_format.json_schema` (which Codex Responses reads as
 * `text.format.json_schema`). Skipping the translation on ANY branch silently
 * drops structured-output enforcement and turns BTS structured output into prose
 * — the bug investigation 260509 (`callViaCodexProxy` Codex non-streaming branch
 * dropped `response_format`) and PM 260427 (OpenRouter structured-output prose).
 *
 * Before Stage 13 the translation call was duplicated inline at six branches.
 * This module is the SINGLE named home for it. A mechanical CI check
 * (`scripts/check-proxy-auth-translator-centralization.ts`) asserts the
 * translation only happens via {@link applyAnthropicOutputFormat} — so a new
 * translator branch cannot quietly omit it.
 *
 * Boundary note: reached by the cloud bootstrap (`proxyManager` from `src/main`),
 * so this module MUST NOT import `electron`. Dependencies are `@core` types only.
 *
 * Investigation: `docs-private/investigations/260509_bts_output_format_dropped_codex_proxy.md`.
 * Invariant: `REBEL_CORE.md:210-272`. Boundary-registry: `structured-output-schema`.
 */
import type { ChatResponseFormat } from '@core/services/codexResponsesTranslator';

/** The Anthropic-shaped structured-output contract BTS callers send. */
export interface AnthropicOutputFormat {
  schema: Record<string, unknown>;
  name?: string;
  strict?: boolean;
}

/** The minimal upstream-request shape the translator mutates. */
interface ResponseFormatTarget {
  response_format?: ChatResponseFormat;
}

/**
 * Translate an Anthropic-shaped `output_format` into the OpenAI Chat Completions
 * `response_format.json_schema` shape.
 *
 * Defaults `strict: false` to avoid surfacing new 400s on schemas that don't
 * satisfy OpenAI strict-mode requirements (`additionalProperties: false`
 * everywhere, every property in `required`, no top-level `anyOf`, etc.).
 * BTS callers can opt in via `output_format.strict`.
 *
 * Defaults `name: 'structured_output'` when the caller doesn't supply one —
 * BTS doesn't currently set a name, but the OpenAI response_format schema
 * requires one.
 */
export function translateAnthropicOutputFormatToOpenAIResponseFormat(
  outputFormat: AnthropicOutputFormat,
): ChatResponseFormat {
  return {
    type: 'json_schema',
    json_schema: {
      name: outputFormat.name ?? 'structured_output',
      schema: outputFormat.schema,
      strict: outputFormat.strict ?? false,
    },
  };
}

/**
 * INVARIANT (the single point every translator branch routes through): if the
 * inbound Anthropic request carries `output_format`, set the upstream request's
 * `response_format` to the translated json_schema. No-op when `outputFormat` is
 * absent (preserving the prior `if (anthropicRequest.output_format) { ... }`
 * guard byte-for-byte).
 *
 * This is the central wiring of the `structuredOutputContract` axis: a branch
 * with the request's classification can pass `classification.structuredOutputContract
 * === 'anthropic-output-format'` confidence, and a branch without it simply
 * passes the raw `output_format` it parsed — both reach this one helper.
 *
 * Returns true iff a translation was applied (for diagnostics:
 * `outboundResponseFormat`).
 */
export function applyAnthropicOutputFormat(
  target: ResponseFormatTarget,
  outputFormat: AnthropicOutputFormat | undefined,
): boolean {
  if (!outputFormat) return false;
  target.response_format = translateAnthropicOutputFormatToOpenAIResponseFormat(outputFormat);
  return true;
}
