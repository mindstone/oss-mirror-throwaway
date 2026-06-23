import { getErrorKind } from './agentErrorCatalog';

/**
 * Detects provider rejections of a structured-output schema (the
 * `response_format` / `output_config.format` / `output_format` request body).
 * Distinct from MCP `input_schema` rejections — those route through the
 * existing `isSchemaValidationError` heuristic in `turnErrorRecovery.ts`.
 *
 * Origin incidents:
 *   - `f1b4d44b-…` — OpenAI strict mode rejected the previous top-level
 *     `oneOf` ("schema must have type 'object' …").
 *   - `2feaa34a-…` — Anthropic constrained decoding rejected array-form
 *     `type` + `enum` ("Enum value 'low' does not match declared type
 *     '['string', 'null']'").
 *   - merge `1c3b94437` — Anthropic constrained decoding rejected the
 *     17-union-parameter schema with "Schemas contains too many parameters
 *     with union types (17 parameters with type arrays or anyOf). … limit:
 *     16 parameters with unions". This message omits the `response_format`
 *     / `output_config.format` / `output_format` surface keywords entirely,
 *     so the original heuristic missed it and the runtime fallback never
 *     fired. The `parameters with union` surface marker below catches both
 *     phrasings ("union types" and "with unions"). See planner-eval session
 *     2026-05-09 for the diagnosis.
 *
 * See `docs-private/investigations/260506_planning_schema_provider_compat_class_bug.md`
 * for the full diagnosis. The Phase 7 refinement extracted this single
 * source of truth from sister copies in `src/main/services/turnErrorRecovery.ts`
 * and `src/core/rebelCore/planningMode.ts` — duplication of this predicate
 * is the same drift pattern that caused the original class of bugs.
 *
 * Heuristic — must satisfy ALL:
 *   1. The routed error kind is `invalid_request`.
 *   2. Status (when known) is 400. Errors without an explicit status
 *      field still pass — message-only fallbacks are common across the
 *      ecosystem (proxy translation layers, fetch failures, etc.).
 *   3. Raw error text mentions a structured-output surface keyword:
 *      `response_format`, `output_config.format`, `output_format`, or
 *      `parameters with union` (Anthropic constrained-decoding union-cap
 *      overflow — the message variant that omits the other surface keys).
 *   4. Raw error text mentions a schema marker (`schema` or `json_schema`).
 *
 * Conditions 3+4 keep the match narrow: MCP tool-schema 400s mention
 * `input_schema`, not `response_format`/`output_*`/`parameters with union`.
 */
export function isStructuredOutputSchemaRejection(error: unknown): boolean {
  if (getErrorKind(error) !== 'invalid_request') return false;

  const status = readNumericStatus(error);
  if (status !== undefined && status !== 400) return false;

  const lower = readRawErrorText(error).toLowerCase();
  if (lower.length === 0) return false;

  const surfaceMatch =
    lower.includes('response_format') ||
    lower.includes('output_config.format') ||
    lower.includes('output_format') ||
    lower.includes('parameters with union');
  if (!surfaceMatch) return false;

  return lower.includes('json_schema') || lower.includes('schema');
}

function readNumericStatus(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const status = (error as { status?: unknown }).status;
  return typeof status === 'number' ? status : undefined;
}

function readRawErrorText(error: unknown): string {
  if (typeof error === 'string') return error;
  if (typeof error !== 'object' || error === null) return '';

  const candidate = error as { __rawMessage?: unknown; message?: unknown };
  if (typeof candidate.__rawMessage === 'string' && candidate.__rawMessage.length > 0) {
    return candidate.__rawMessage;
  }
  if (typeof candidate.message === 'string') {
    return candidate.message;
  }
  return '';
}
