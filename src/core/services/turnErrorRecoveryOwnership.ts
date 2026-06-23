import type { AgentErrorKind } from '@shared/utils/agentErrorCatalog';

export type RecoveryOwner =
  | 'thinking_model_fallback_handler'
  | 'managed_model_not_allowed_handler'
  | 'billing_handler'
  | 'rate_limit_handler'
  | 'alt_model_then_server_error_retry'
  | 'alt_model_then_transient_retry'
  | 'classify_and_dispatch_tail';

/**
 * Stage 1 ownership contract: every known error kind has one explicit recovery
 * owner so routing changes are compile-time visible.
 */
export const RECOVERY_OWNER_BY_KIND = {
  rate_limit: 'rate_limit_handler',
  auth: 'classify_and_dispatch_tail',
  'connection-not-configured': 'classify_and_dispatch_tail',
  billing: 'billing_handler',
  moderation: 'classify_and_dispatch_tail',
  server_error: 'alt_model_then_server_error_retry',
  network: 'alt_model_then_transient_retry',
  invalid_request: 'classify_and_dispatch_tail',
  routing: 'classify_and_dispatch_tail',
  context_overflow: 'classify_and_dispatch_tail',
  session_not_found: 'classify_and_dispatch_tail',
  tool_name_corrupt: 'classify_and_dispatch_tail',
  model_unavailable: 'thinking_model_fallback_handler',
  managed_model_not_allowed: 'managed_model_not_allowed_handler',
  process_exit: 'alt_model_then_transient_retry',
  mcp_error: 'classify_and_dispatch_tail',
  message_timeout: 'alt_model_then_transient_retry',
  user_action: 'alt_model_then_transient_retry',
  unsupported_model: 'classify_and_dispatch_tail',
  image_input_unsupported: 'classify_and_dispatch_tail',
  // Dispatched directly as a terminal admission block — no recovery-pipeline
  // retry; classify + show the user (like auth / connection-not-configured).
  'chief-of-staff-unavailable': 'classify_and_dispatch_tail',
  unknown: 'alt_model_then_transient_retry',
} as const satisfies Record<AgentErrorKind, RecoveryOwner>;

export function ownerForRecoveryKind(kind: AgentErrorKind): RecoveryOwner {
  return RECOVERY_OWNER_BY_KIND[kind];
}
