/**
 * Canonical error kinds used for retry/fallback routing across the agent turn flow.
 *
 * MULTI-PROVIDER GAP: Currently these kinds are only detected for Anthropic/Claude error patterns.
 * When non-Claude providers (GPT, Gemini, etc.) are routed through the alt-model proxy, their
 * error formats may not be recognized and will fall through as 'unknown'. See
 * docs/plans/finished/260311_unified_error_classification.md for the provider-aware pattern sets plan.
 */
/**
 * All known error kinds as a const tuple.
 * Single source of truth: the Zod schema (`schemas/agent.ts`) imports this
 * for `z.enum(AGENT_ERROR_KINDS)` so both TS type and Zod stay in sync.
 */
export const AGENT_ERROR_KINDS = [
  'rate_limit',
  'auth',
  'connection-not-configured',
  'billing',
  'moderation',
  'server_error',
  'network',
  'invalid_request',
  /**
   * Routing misconfiguration — a proxy-dialect model ID (slash-containing,
   * e.g. 'anthropic/claude-opus-4.7') reached a path that only accepts native
   * Anthropic IDs, or a proxy-dialect model was requested without a proxy
   * config. Thrown by `createDirectAnthropicClient` (R2 assertion) and the
   * `rebelCoreQuery` defense-in-depth guard. Sub-cause is carried on the
   * error object as `__routingCause`. See
   * docs/plans/260422_provider_routing_residual.md.
   */
  'routing',
  'context_overflow',
  'session_not_found',
  'tool_name_corrupt',
  'model_unavailable',
  /**
   * Managed (Mindstone) plan rejected the requested model because it is not in
   * the tier's allowlist. Thrown by the local model proxy 403 gate with shape
   * `{ code: 'MANAGED_MODEL_NOT_ALLOWED', requested, allowed }`. Handler emits
   * a humanizer-owned error event carrying `managedModelMeta` so the renderer
   * can offer plan-default switching or BYOK fallback.
   */
  'managed_model_not_allowed',
  'process_exit',
  'mcp_error',
  'message_timeout',
  'user_action',
  /**
   * Provider rejects the requested model — typically because the user's
   * subscription tier does not include it. Emitted by `providerRouteDecision.ts`
   * when it sees `codex-unsupported-model`.
   */
  'unsupported_model',
  /**
   * The provider rejected the request because the active model can't accept
   * image input (e.g. OpenRouter 404 "No endpoints found that support image
   * input" for a text-only model with an image in history). Distinct from
   * `model_unavailable` ON PURPOSE: that kind triggers the thinking-model
   * downgrade recovery and says "pick another model" — the right UX here is
   * image-specific (lead with switch-to-a-vision-capable-model) and must NOT
   * auto-downgrade. Non-transient: retry re-sends the same image-bearing
   * history. See docs/plans/260610_image-unsupported-by-model/PLAN.md.
   */
  'image_input_unsupported',
  /**
   * The user's Chief-of-Staff instructions (README.md / legacy AGENTS.md) could
   * not be read at turn admission on a desktop interactive turn. Emitted by the
   * turn-admission gate (`turnAdmission.admit`) when a bounded Chief-of-Staff
   * read is NOT `ok`: a dead/slow cloud mount (`reconnecting`), a present-but-
   * unreadable file (`unreadable`), or a genuinely-absent file after onboarding
   * has completed (`missing-after-setup`). Carries the cause as
   * `__chiefOfStaffReason` on the routed error and into `classifyErrorUx` via
   * `chiefOfStaffReason` so the recovery copy can distinguish the three causes
   * (Stage 4 refines the per-reason copy/actions). Desktop-only: cloud/mobile/
   * headless turns (`win === null`) never block — they log + proceed on the
   * template. See docs/plans/260622_render-preview-cloud-hang/PLAN.md Stage 3.
   */
  'chief-of-staff-unavailable',
  'unknown',
] as const;

export type AgentErrorKind = typeof AGENT_ERROR_KINDS[number];

const LEGACY_SENTINEL_PREFIX_TO_KIND = [
  ['RATE_LIMIT_RETRY:', 'rate_limit'],
  ['SERVER_ERROR_RETRY:', 'server_error'],
  ['API_ERROR_INTERCEPT:', 'invalid_request'],
  ['TOOL_NAME_CORRUPT_RETRY:', 'tool_name_corrupt'],
  ['SESSION_NOT_FOUND_RETRY:', 'session_not_found'],
] as const satisfies ReadonlyArray<readonly [string, AgentErrorKind]>;

const KIND_TO_LEGACY_SENTINEL_PREFIX: Partial<Record<AgentErrorKind, string>> = {
  rate_limit: 'RATE_LIMIT_RETRY',
  server_error: 'SERVER_ERROR_RETRY',
  invalid_request: 'API_ERROR_INTERCEPT',
  tool_name_corrupt: 'TOOL_NAME_CORRUPT_RETRY',
  session_not_found: 'SESSION_NOT_FOUND_RETRY',
};

const AGENT_ERROR_KIND_SET = new Set<string>(AGENT_ERROR_KINDS);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isAgentErrorKind(value: unknown): value is AgentErrorKind {
  return typeof value === 'string' && AGENT_ERROR_KIND_SET.has(value as AgentErrorKind);
}

function getMetadataKind(error: unknown): AgentErrorKind | null {
  if (!isRecord(error)) {
    return null;
  }

  const metadataKind = error.__agentErrorKind;
  return isAgentErrorKind(metadataKind) ? metadataKind : null;
}

function getErrorMessage(error: unknown): string | null {
  if (error instanceof Error) {
    return error.message;
  }

  if (!isRecord(error)) {
    return null;
  }

  const message = error.message;
  return typeof message === 'string' ? message : null;
}

/**
 * Creates a routed error with both structured metadata and a legacy sentinel prefix.
 *
 * The sentinel in `error.message` preserves backward compatibility for callers that
 * still match on legacy prefixes instead of `getErrorKind()`.
 */
export function createRoutedError(kind: AgentErrorKind, rawMessage: string): Error {
  const prefix = KIND_TO_LEGACY_SENTINEL_PREFIX[kind];
  const message = prefix ? `${prefix}: ${rawMessage}` : rawMessage;
  const error = new Error(message) as Error & {
    __agentErrorKind?: AgentErrorKind;
    __rawMessage?: string;
  };

  error.__agentErrorKind = kind;
  error.__rawMessage = rawMessage;
  return error;
}

/**
 * Extracts the normalized routed error kind from an unknown error.
 *
 * Priority order:
 * 1) Structured metadata (`__agentErrorKind`)
 * 2) Legacy sentinel prefixes in `error.message`
 * 3) `unknown`
 */
export function getErrorKind(error: unknown): AgentErrorKind {
  const metadataKind = getMetadataKind(error);
  if (metadataKind) {
    return metadataKind;
  }

  // Detect MessageTimeoutError by name (avoids circular import from core)
  if (isRecord(error) && (error as { name?: string }).name === 'MessageTimeoutError') {
    return 'message_timeout';
  }

  const message = getErrorMessage(error);
  if (!message) {
    return 'unknown';
  }

  for (const [prefix, kind] of LEGACY_SENTINEL_PREFIX_TO_KIND) {
    if (message.startsWith(prefix)) {
      return kind;
    }
  }

  return 'unknown';
}

/** Returns true when an error maps to any known routed kind. */
export function isRoutedError(error: unknown): boolean {
  return getErrorKind(error) !== 'unknown';
}
