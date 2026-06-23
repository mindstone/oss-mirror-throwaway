/**
 * usePendingApprovals
 *
 * Unified hook that combines tool and memory approvals for the Inbox
 * pending approvals strip. Provides a consistent interface for displaying
 * and navigating to pending approval requests.
 */

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { summarizeToolForApproval } from '@renderer/features/agent-session/utils/toolChips';
import { buildToolContinuationMessage } from '@renderer/features/agent-session/utils/buildToolContinuationMessage';
import { saveMemoryApproval, discardMemoryApproval } from '@renderer/utils/saveMemoryApproval';
import { dispatchAgentTurn } from '@renderer/features/agent-session/utils/dispatchAgentTurn';
import {
  isGenericReason,
  deriveUnifiedApprovals,
  type FileLocation,
  type MemoryBlockedBySource,
  type MemoryWriteApprovalRequestBroadcast,
  type MemoryApprovalInput,
  type SessionContextForApprovals,
  type StagedFileInput,
  type StagedToolCallInput,
  type ToolBlockSource,
  type ToolSafetyApprovalRequestBroadcast,
  type ToolSafetyStagedCallBroadcast,
  type ToolApprovalInput,
  type ToolApprovalSummary,
  type UnifiedApproval,
} from '@rebel/shared';
import { useStagedFiles } from './useStagedFiles';
import { summarizeStagedExecutionResult } from '@shared/utils/stagedExecutionSummary';
import { parseBackgroundTaskType } from '../utils/backgroundTaskLabels';
import { classifySessionKind } from '@shared/sessionKind';
import { useSessionStore } from '@renderer/features/agent-session/store/sessionStore';

const SAFETY_RULES_BLOCKED_PREFIX = 'Safety Rules blocked:';

/** Strip the "Safety Rules blocked:" prefix for user-facing display */
function stripSafetyPrefix(reason: string): string {
  if (reason.startsWith(SAFETY_RULES_BLOCKED_PREFIX)) {
    return reason.slice(SAFETY_RULES_BLOCKED_PREFIX.length).trim();
  }
  return reason;
}
import {
  AUTOMATION_RUN_TOOL_ID,
  STAGED_CALL_NOT_FOUND_ERROR,
  STAGED_CALL_ALREADY_EXECUTING_ERROR,
  STAGED_CALL_EXPIRED_ERROR,
  STAGED_CALL_MCP_UNAVAILABLE_ERROR,
  STAGED_CALL_STATUS_PREFIX,
  type StagedToolCallPayload,
} from '@shared/ipc/channels/safety';

// ---------------------------------------------------------------------------
// Cross-hook optimistic sync
// ---------------------------------------------------------------------------
// See `./approvalOptimisticRemoval.ts` for the canonical bookkeeping module.
// We re-export `notifyOptimisticRemoval` for back-compat with existing
// consumers (useAutomationApprovals + NotificationDrawer).
//
// Supported ID prefixes:
//   - `tool:<toolUseID>`          — inline tool approvals
//   - `memory:<toolUseId>`        — memory write approvals
//   - `staged-tool:<id>`          — queued MCP tool calls
//   - `staged-file:<id>`          — staged memory files (Stage 3 F23)
// ---------------------------------------------------------------------------
import {
  notifyOptimisticRemoval,
  snapshotOptimisticRemovals,
  OPTIMISTIC_REMOVAL_EVENT,
  type OptimisticRemovalEventDetail,
} from './approvalOptimisticRemoval';

// Back-compat re-exports so consumers that imported these from
// `usePendingApprovals` keep working (useAutomationApprovals,
// NotificationDrawer, etc.).
export { notifyOptimisticRemoval, OPTIMISTIC_REMOVAL_EVENT };

// ---------------------------------------------------------------------------
// ApprovalOutcome — typed result for approval/execution functions
// ---------------------------------------------------------------------------

export type ApprovalFailureReason =
  | 'ipc-unavailable'
  | 'already-handled'
  | 'expired'
  | 'execution-failed'
  | 'mcp-unavailable'
  | 'already-executing'
  /**
   * The action EXECUTED, but its result continuation could not be delivered
   * to the conversation (e.g. typed busy refusal on the direct dispatch
   * fallback). The result text exists only in that continuation, so this
   * must surface instead of silently reporting success (Stage 3 review F2).
   */
  | 'result-not-delivered'
  /**
   * The approved tool call failed ARGUMENT VALIDATION (the validator rejected
   * the model's malformed inputs — e.g. super-mcp's `ARG_VALIDATION_FAILED`
   * wrapper error or a downstream per-tool `-33003 Argument validation failed`).
   * This is recoverable WITHOUT the user: the agent receives a parallel
   * failure-notice continuation and self-corrects (re-dispatches with fixed
   * args). So instead of an alarming red error toast that leaks agent-directed
   * guidance ("Use get_tool_details / dry_run: true") to a non-technical user,
   * we surface a calm, low-severity "Rebel is sorting that out" affordance and
   * let the agent retry. FOX-3519 (consolidated class ticket; ~15 prior
   * per-tool autopilot tickets). Genuine non-arg execution failures still use
   * `execution-failed`. NOTE: per-attempt — if the agent's retries are
   * exhausted, the terminal outcome still surfaces (agent narrates the give-up
   * in the transcript; a non-arg failure routes to `execution-failed`), so this
   * never strands the user in false success.
   */
  | 'arg-recovering'
  /**
   * The arg-validation retries have been EXHAUSTED — super-mcp appended its
   * stop-retrying guidance ("Arguments may require user clarification. Please
   * ask the user for specifics.") after repeated failed attempts
   * (`STOP_RETRYING_THRESHOLD`). The agent has effectively given up auto-fixing
   * the inputs; the user genuinely needs to supply more detail. This is a
   * TERMINAL state, NOT a recovering one — collapsing it into `arg-recovering`
   * would falsely tell the user "no need to do anything" when in fact Rebel is
   * stuck (FOX-3519 review F2). So it gets its own calm-but-honest warning copy
   * (still jargon-free — never leaks get_tool_details/dry_run/schema text).
   */
  | 'arg-needs-detail'
  /**
   * An approved connector tool failed because Rebel lost its connection to the
   * connector's downstream server mid-flight (a transport reap/lifecycle race,
   * NOT an API-key or auth problem — see the 260622 live-repro finding). super-mcp
   * wraps the downstream death as a structured `-33007` error whose message
   * usually contains a raw `-32000 Connection closed … restart_package(...)` dump.
   * Showing that raw string to a non-technical user is alarming and misleading
   * (it reads like a config error and even leaks an agent-directed
   * `restart_package` hint). So we detect the downstream-transport markers and
   * surface calm, connector-named reconnect copy instead: "Rebel lost the
   * connection … you can try again". Severity is `warning` (NOT `error` — keeps
   * it out of the Sentry error-toast flood; the action genuinely failed so not
   * `info`). NEVER mentions API keys, `-32000`, or `restart_package`. Genuine
   * non-transport execution failures still use `execution-failed`. (Stage 3 / B2;
   * pairs with the B3 telemetry split `downstream_transport_closed`.)
   */
  | 'connector-unavailable'
  | 'unknown';

export type ApprovalOutcome =
  | { ok: true }
  | {
      ok: false;
      reason: ApprovalFailureReason;
      detail?: string;
      /**
       * Human action display name (e.g. "Send email") for the failed staged
       * call, threaded by callers that know it (FOX-3519 refinement). Used to
       * make the `arg-recovering` / `arg-needs-detail` toast copy less vague
       * without leaking validator jargon. `classifyStagedError` does NOT set
       * this — the copy helpers fall back to generic phrasing when it's absent.
       */
      displayName?: string;
    };

export interface BatchApprovalResult {
  total: number;
  succeeded: number;
  failed: number;
  failures: Array<{ displayName: string; reason: ApprovalFailureReason; detail?: string }>;
  /**
   * Sessions whose staged-execution result summary could not be delivered
   * (Stage 3 review F2). The executions themselves succeeded/failed per
   * `failures`; entries here mean the RESULT TEXT was lost on the direct
   * fallback and the user should ask the conversation for the outcome.
   */
  resultDeliveryFailures?: Array<{ sessionId: string; detail?: string }>;
}

/**
 * Detect the TOOL ARGUMENT-VALIDATION failure class (FOX-3519).
 *
 * super-mcp surfaces this class with several stable wordings, ALL under error
 * code `-33003 / ARG_VALIDATION_FAILED`:
 *   - the `use_tool` wrapper validator (`parseArgsContainer`):
 *     `use_tool "args" must be an object …`
 *   - the per-tool argument validator (`useTool.ts:602`):
 *     `Argument validation failed for tool '…' in package '…'`
 *   - the downstream MCP-server validator (`useTool.ts:1471`):
 *     `Downstream validation failed for tool '…': …`  (review F1 — was missed)
 * All append agent-directed recovery guidance (`get_tool_details`, `dry_run`,
 * `search_tools`) that must never reach a non-technical user.
 *
 * We match on the stable substrings AND on the `-33003` / `ARG_VALIDATION_FAILED`
 * code markers (that code is, by definition, the arg-validation failure code),
 * so a new validator wording still classifies correctly. Deliberately scoped:
 * genuine non-arg execution failures (timeout, auth, network, backend) keep
 * their `execution-failed` red toast. Pure — safe to unit test.
 */
export function isArgValidationFailure(error: string | undefined): boolean {
  if (!error) return false;
  const lower = error.toLowerCase();
  return (
    lower.includes('argument validation failed') ||
    lower.includes('downstream validation failed') ||
    lower.includes('"args" must be an object') ||
    lower.includes('-33003') ||
    lower.includes('arg_validation_failed')
  );
}

/**
 * Detect the EXHAUSTED-retries terminal signal within the arg-validation class
 * (FOX-3519 review F2). super-mcp appends `STOP_RETRYING_MESSAGE` —
 * "Arguments may require user clarification. Please ask the user for specifics."
 * — once attempts hit `STOP_RETRYING_THRESHOLD`. At that point the agent can no
 * longer auto-fix the inputs; the user must supply more detail. We must surface
 * this as a terminal "needs your input" state, not the calm "no need to do
 * anything" recovering affordance. Matched on the stable, jargon-free fragment.
 */
export function isArgValidationExhausted(error: string | undefined): boolean {
  if (!error) return false;
  const lower = error.toLowerCase();
  return (
    lower.includes('may require user clarification') ||
    lower.includes('ask the user for specifics')
  );
}

/**
 * Detect the DOWNSTREAM CONNECTOR TRANSPORT-FAILURE class (Stage 3 / B2).
 *
 * When an approved connector tool (e.g. Brave Search) fails because Rebel lost
 * its link to the connector's downstream server, super-mcp wraps the death as a
 * structured `-33007` (DOWNSTREAM_ERROR) and the stringified error reaching the
 * renderer typically contains a raw transport dump:
 *   `Tool execution failed … Failed to connect to MCP server '…'.
 *    MCP error -32000: Connection closed … try 'restart_package(package_id: "…")'`
 * The 260622 live repro proved this is a transport reap/lifecycle RACE, not an
 * API-key/boot problem — so the copy must stay neutral ("lost connection, try
 * again") and never blame the key.
 *
 * Two-tier match, so a new wording still classifies correctly:
 *   1. PRIMARY — the structured `-33007` / `DOWNSTREAM_ERROR` markers
 *      (super-mcp's dedicated downstream-failure code). These are the stable
 *      contract and the reason this classifies as a transport failure.
 *   2. SECONDARY (heuristic) — the raw transport-dump strings `-32000`,
 *      `connection closed`, and `restart_package`. These catch dumps that
 *      reach the renderer without the structured wrapper, but are best-effort
 *      pattern-matching rather than a stable contract.
 * Checked AFTER the arg-validation branch (arg-validation keeps priority) but
 * BEFORE the generic `execution-failed` fallthrough. Pure — safe to unit test.
 */
export function isConnectorTransportFailure(error: string | undefined): boolean {
  if (!error) return false;
  const lower = error.toLowerCase();
  // Primary: structured downstream-failure markers (stable contract).
  if (lower.includes('-33007') || lower.includes('downstream_error')) {
    return true;
  }
  // Secondary: raw transport-dump heuristic (best-effort, not a contract).
  return (
    lower.includes('-32000') ||
    lower.includes('connection closed') ||
    lower.includes('restart_package')
  );
}

/**
 * Classify a staged call error string into a structured ApprovalOutcome.
 * Pure function — safe to unit test directly.
 */
export function classifyStagedError(error: string | undefined): ApprovalOutcome & { ok: false } {
  if (!error) return { ok: false, reason: 'unknown' };
  if (error === STAGED_CALL_NOT_FOUND_ERROR) return { ok: false, reason: 'already-handled' };
  if (error === STAGED_CALL_ALREADY_EXECUTING_ERROR) return { ok: false, reason: 'already-executing' };
  if (error.startsWith(STAGED_CALL_STATUS_PREFIX)) return { ok: false, reason: 'already-handled' };
  if (error === STAGED_CALL_EXPIRED_ERROR) return { ok: false, reason: 'expired' };
  if (error === STAGED_CALL_MCP_UNAVAILABLE_ERROR) return { ok: false, reason: 'mcp-unavailable' };
  if (isArgValidationFailure(error)) {
    // Within the arg-validation class, distinguish the EXHAUSTED-retries
    // terminal state (the agent has given up auto-fixing; the user must supply
    // more detail) from the recoverable case (the agent self-corrects). The
    // stop-retrying guidance is appended to the SAME validation wording, so it
    // must be checked first (FOX-3519 review F2). Both stay jargon-free.
    if (isArgValidationExhausted(error)) return { ok: false, reason: 'arg-needs-detail' };
    // Recoverable — route to the calm affordance instead of a raw
    // `execution-failed` error toast that leaks agent-directed guidance.
    return { ok: false, reason: 'arg-recovering' };
  }
  // Downstream connector transport failure (Stage 3 / B2). Checked AFTER
  // arg-validation (which keeps priority) but BEFORE the generic
  // `execution-failed` fallthrough so the raw `-32000 Connection closed …
  // restart_package` dump never reaches the user as a red error toast.
  if (isConnectorTransportFailure(error)) {
    return { ok: false, reason: 'connector-unavailable' };
  }
  return { ok: false, reason: 'execution-failed', detail: sanitizeErrorDetail(error) };
}

/**
 * Attach the action display name to a failure outcome (FOX-3519 refinement), so
 * the arg-validation copy helpers can name the action. A blank/whitespace name
 * is dropped so the helpers cleanly fall back to generic phrasing rather than
 * rendering a dangling "the details for ." Pure.
 */
export function withDisplayName(
  outcome: ApprovalOutcome & { ok: false },
  displayName: string | undefined,
): ApprovalOutcome & { ok: false } {
  const trimmed = displayName?.trim();
  return trimmed ? { ...outcome, displayName: trimmed } : outcome;
}

/**
 * Strip syntactic noise from error messages: `[package/tool]` prefixes, `(args: ...)` suffixes,
 * and JSON status envelopes (`{ "status", "error", "resolution" }`).
 * Preserves semantic content (error codes, field names, etc.) for agent-facing contexts
 * where the detail helps the agent self-correct.
 */
export function stripErrorNoise(error: string): string {
  // Strip leading "[package/tool] " prefix added by stagedToolCallsService
  // Package IDs can contain spaces (e.g. "PostHog EU"), dots, slashes, hyphens
  let cleaned = error.replace(/^\[[^\]]+\]\s*/, '');
  // Strip trailing " (args: ...)" dumps
  cleaned = cleaned.replace(/\s*\(args:\s*[^)]*\)\s*$/, '');
  // Extract error message from JSON status envelopes (REBEL-53T).
  // MCP servers may return structured { "status", "error", "resolution" } objects
  // that get stringified before reaching this function. Both agent and user paths
  // benefit from unwrapping the semantic message.
  cleaned = extractFromJsonEnvelope(cleaned);
  return cleaned || error;
}

/**
 * Strip syntactic noise AND humanize developer-facing errors for user-visible surfaces (toasts).
 * Uses stripErrorNoise() for syntactic cleanup, then applies semantic humanization for
 * MCP validation errors keep the sanitized field-level detail so users can report
 * the exact schema problem and agents can retry with corrected inputs.
 */
export function sanitizeErrorDetail(error: string): string {
  let cleaned = stripErrorNoise(error);

  // Compound matching to avoid false positives on unrelated errors.
  const lowerCleaned = cleaned.toLowerCase();
  if (lowerCleaned.includes('argument validation failed') ||
      (lowerCleaned.includes('mcp error') && lowerCleaned.includes('missing required'))) {
    return `The tool received unexpected inputs: ${cleaned}`;
  }

  // Strip MCP error code prefix for remaining MCP errors (e.g., -32603).
  // The error code is developer-facing; the message after the colon is user-meaningful.
  // Only applied in user-facing sanitizeErrorDetail, NOT in agent-facing stripErrorNoise,
  // because agents may benefit from the error code for self-correction.
  cleaned = cleaned.replace(/^MCP error -\d+:\s*/, '');

  return cleaned;
}

function errorDetailFromUnknown(error: unknown): string | undefined {
  if (error instanceof Error) return sanitizeErrorDetail(error.message);
  if (typeof error === 'string') return sanitizeErrorDetail(error);
  return undefined;
}

/**
 * If the string looks like a JSON status envelope, extract the human-meaningful
 * message. Handles two known MCP envelope shapes:
 *   - `{ status, error, resolution }` (REBEL-53T) → `error`
 *   - `{ ok: false, action_required, next_step }` (REBEL-539) → `action_required`
 * Otherwise return the input unchanged.
 */
function extractFromJsonEnvelope(input: string): string {
  const trimmed = input.trim();
  if (!trimmed.startsWith('{')) return input;
  try {
    const parsed = JSON.parse(trimmed);
    if (typeof parsed === 'object' && parsed !== null) {
      // Surface the first non-empty message field across the two known MCP envelope
      // shapes. `error` is preferred for backward-compat with the { status, error,
      // resolution } shape (REBEL-53T); `action_required` (then `next_step`) covers the
      // { ok: false, action_required, next_step } structured-failure envelope (REBEL-539)
      // returned when an approved MCP-app action fails. Requiring a non-empty trimmed
      // string avoids regressing an empty/whitespace/non-string field back to the raw
      // JSON blob (which is what got dumped into the "Approved, but the action failed: …"
      // toast before this fix).
      const message = [parsed.error, parsed.action_required, parsed.next_step].find(
        (value): value is string => typeof value === 'string' && value.trim().length > 0,
      );
      if (message) return message;
    }
  } catch {
    // Not valid JSON — return unchanged
  }
  return input;
}

/**
 * User-facing copy for the arg-validation recovery class (FOX-3519).
 * Brand-voice approved (chief-designer): calm, jargon-free, signals Rebel is
 * handling it, tells the user there's nothing to do. Surfaced as a low-severity
 * `info` toast (NOT a red error). The description NAMES the action when known
 * (FOX-3519 refinement) and falls back to a generic line when it isn't, so we
 * never render a dangling "the details for ." Closed-loop ("nothing you need to
 * do") — the contrast partner of the terminal `arg-needs-detail` copy.
 */
export const ARG_RECOVERING_TOAST_TITLE = 'Rebel is sorting that out';
export const ARG_RECOVERING_TOAST_DESCRIPTION_GENERIC =
  "Rebel hit a snag with the details and is adjusting, so there's nothing you need to do.";
export function argRecoveringToastDescription(displayName?: string): string {
  const name = displayName?.trim();
  return name
    ? `Rebel hit a snag with the details for ${name} and is adjusting, so there's nothing you need to do.`
    : ARG_RECOVERING_TOAST_DESCRIPTION_GENERIC;
}
/**
 * First-person variant for the in-conversation surface (`useStagedToolCalls`),
 * rendered `<DisplayName>: <this>` — so it must NOT re-name the action. Verb
 * ("adjusting") matches the toast so both surfaces sound like one Rebel. Non-empty.
 */
export const ARG_RECOVERING_CONVERSATION_LINE = 'Adjusting how I run this. Give me a moment.';

/**
 * User-facing copy for the EXHAUSTED-retries terminal case (FOX-3519 review F2).
 * Brand-voice approved (chief-designer): leads with earned reassurance ("your
 * approval went through"), states honestly that Rebel tried and couldn't, points
 * the user to the conversation for what's needed. Surfaced as a `warning` toast
 * (NOT `info`) so the one toast the user MUST act on does not blend into the
 * calm recovering toast — the variant + the open-loop "your turn" wording carry
 * the difference, defusing the false-reassurance trap. NAMES the action when
 * known, falls back to generic otherwise. No jargon.
 */
export const ARG_NEEDS_DETAIL_TOAST_TITLE = 'Rebel needs a bit more from you';
export const ARG_NEEDS_DETAIL_TOAST_DESCRIPTION_GENERIC =
  "Your approval went through, but Rebel couldn't work out the details on its own. See the conversation for what it needs.";
export function argNeedsDetailToastDescription(displayName?: string): string {
  const name = displayName?.trim();
  return name
    ? `Your approval went through, but Rebel couldn't work out the details for ${name}. See the conversation for what it needs.`
    : ARG_NEEDS_DETAIL_TOAST_DESCRIPTION_GENERIC;
}
/**
 * First-person in-conversation variant (rendered `<DisplayName>: <this>`, so it
 * does NOT re-name the action). Verb ("work out the details") matches the toast.
 * Non-empty.
 */
export const ARG_NEEDS_DETAIL_CONVERSATION_LINE =
  "I couldn't work out all the details for this on my own. Tell me what you had in mind and I'll continue.";

/**
 * User-facing copy for the downstream connector transport-failure class
 * (Stage 3 / B2). Brand-voice: calm, honest, jargon-free. The action genuinely
 * failed, so we acknowledge it ("Approved, but Rebel lost the connection") and
 * give the user a clear, low-anxiety next step ("Ask Rebel to try again in a
 * moment"). NAMES the connector when the caller threads a display name, falls
 * back to a generic (un-named) line otherwise. Surfaced as a `warning` toast (NOT `error` —
 * keeps it out of the Sentry error-toast flood; NOT `info` — the action failed).
 *
 * NEVER mentions API keys (the 260622 live repro ruled the key out — this is a
 * transport reap/lifecycle race), and NEVER leaks the raw `-32000` /
 * `restart_package` transport dump.
 */
export const CONNECTOR_UNAVAILABLE_TOAST_TITLE = 'Rebel lost the connection';
export const CONNECTOR_UNAVAILABLE_TOAST_DESCRIPTION_GENERIC =
  'Your approval went through, but Rebel lost its connection before it finished. Ask Rebel to try again in a moment.';
export function connectorUnavailableToastDescription(displayName?: string): string {
  const name = displayName?.trim();
  return name
    ? `Your approval went through, but Rebel lost its connection to ${name} before it finished. Ask Rebel to try again in a moment.`
    : CONNECTOR_UNAVAILABLE_TOAST_DESCRIPTION_GENERIC;
}
/**
 * First-person in-conversation variant (rendered `<DisplayName>: <this>`, so it
 * does NOT re-name the action). Verb ("lost the connection") matches the toast
 * so both surfaces sound like one Rebel. Non-empty. Jargon-free — no key/-32000/
 * restart_package leakage.
 */
export const CONNECTOR_UNAVAILABLE_CONVERSATION_LINE =
  'I lost the connection before I could finish that. Ask me to try again in a moment.';

/**
 * Map a failed ApprovalOutcome to a user-friendly toast message (the title).
 * Used by NotificationDrawer and AutomationsPanel for consistent messaging.
 * For the toast *description* (only some reasons have one), see
 * {@link approvalOutcomeDescription}.
 */
export function approvalOutcomeMessage(result: ApprovalOutcome & { ok: false }): string {
  switch (result.reason) {
    case 'already-executing': return 'Already processing...';
    case 'already-handled': return ''; // silent — no toast
    case 'expired': return 'This action expired. Ask Rebel to try again.';
    case 'execution-failed': return result.detail
      ? `Approved, but the action failed: ${result.detail}`
      : 'Approved, but the action failed.';
    case 'ipc-unavailable': return "Couldn't reach Rebel. Try again in a moment.";
    case 'mcp-unavailable': return "Couldn't run that action right now. Try again shortly.";
    case 'result-not-delivered':
      return "Executed, but the conversation was busy — ask Rebel for the result.";
    // Recoverable arg-validation failure — calm reassurance, agent self-corrects.
    case 'arg-recovering': return ARG_RECOVERING_TOAST_TITLE;
    // Exhausted retries — honest "your turn" copy (terminal, needs user input).
    case 'arg-needs-detail': return ARG_NEEDS_DETAIL_TOAST_TITLE;
    // Downstream connector transport failure — calm, key-silent reconnect copy.
    case 'connector-unavailable': return CONNECTOR_UNAVAILABLE_TOAST_TITLE;
    case 'unknown': return 'Something went wrong. Try again.';
  }
}

/**
 * Optional toast description (secondary line) for a failed ApprovalOutcome.
 * Returns `undefined` for reasons whose single-line title is sufficient.
 */
export function approvalOutcomeDescription(result: ApprovalOutcome & { ok: false }): string | undefined {
  // Name the action when the caller threaded a display name (FOX-3519
  // refinement); both builders fall back to generic copy when it's absent.
  if (result.reason === 'arg-recovering') return argRecoveringToastDescription(result.displayName);
  if (result.reason === 'arg-needs-detail') return argNeedsDetailToastDescription(result.displayName);
  if (result.reason === 'connector-unavailable') return connectorUnavailableToastDescription(result.displayName);
  return undefined;
}

/**
 * Map a failed ApprovalOutcome to a toast variant.
 */
export function approvalOutcomeVariant(result: ApprovalOutcome & { ok: false }): 'error' | 'warning' | 'default' | 'info' {
  switch (result.reason) {
    case 'already-executing': return 'default';
    case 'already-handled': return 'default';
    case 'expired': return 'warning';
    case 'execution-failed': return 'error';
    case 'ipc-unavailable': return 'error';
    case 'mcp-unavailable': return 'error';
    case 'result-not-delivered': return 'warning'; // the action itself succeeded
    // Not an error from the user's POV — their approval landed; Rebel is
    // retrying. `info` signals "being handled", and (crucially) keeps this
    // OUT of the Sentry error-toast flood (instrumentToast only captures
    // `error` variant). FOX-3519.
    case 'arg-recovering': return 'info';
    // Terminal — the user MUST supply more detail. `warning` (not `info`) so it
    // visually out-ranks the calm recovering toast; not `error` because nothing
    // broke. The variant carries the open-loop "your turn" signal (FOX-3519 F2).
    case 'arg-needs-detail': return 'warning';
    // Downstream connector transport failure — the action failed, so NOT `info`,
    // but `warning` (not `error`) keeps it OUT of the Sentry error-toast flood
    // while still flagging that the user may want to retry (Stage 3 / B2).
    case 'connector-unavailable': return 'warning';
    case 'unknown': return 'error';
  }
}

/** Session context lookup map (sessionId -> context) */
type SessionContextMap = Map<string, SessionContext>;
type MemoryApprovalKind = NonNullable<MemoryWriteApprovalRequestBroadcast['approvalKind']>;
type MemoryApprovalSharing = NonNullable<MemoryWriteApprovalRequestBroadcast['sharing']>;
export type StagedToolCallBroadcastPayload = ToolSafetyStagedCallBroadcast;

type ApprovalSessionSummary = { id: string; deletedAt?: number | null };

function isApprovalSourceSessionAvailable(
  sessionId: string | null | undefined,
  sessionSummaries: readonly ApprovalSessionSummary[],
): boolean {
  if (!sessionId) return true;

  const summary = sessionSummaries.find((candidate) => candidate.id === sessionId);
  if (!summary) {
    const kind = classifySessionKind(sessionId);
    return kind === 'automation' || kind === 'automation-insight';
  }
  return summary.deletedAt == null;
}

/**
 * ID-keyed state for {@link usePendingApprovalCount}. Each set holds the
 * primary key for one approval source, with a composite-prefix mapping that
 * mirrors {@link OPTIMISTIC_REMOVAL_EVENT}:
 *   - tool       → `tool:<toolUseID>`
 *   - memory     → `memory:<toolUseId>`        (non-staged memory only)
 *   - stagedTool → `staged-tool:<id>`          (status === 'pending')
 *   - stagedFile → `staged-file:<id>`
 *
 * Tracking IDs (rather than a numeric count) makes every add/remove
 * operation idempotent. Same-ID broadcasts (e.g. `onStagedToolCall`
 * re-emitting a pending call when its `blockedBy` field is set, or
 * IPC catch-up arriving for items already loaded) cannot inflate the
 * badge, and duplicate resolved events cannot drag it negative.
 */
export interface ApprovalCountIdSets {
  readonly tool: ReadonlySet<string>;
  readonly memory: ReadonlySet<string>;
  readonly stagedTool: ReadonlySet<string>;
  readonly stagedFile: ReadonlySet<string>;
}

const EMPTY_APPROVAL_COUNT_ID_SETS: ApprovalCountIdSets = {
  tool: new Set<string>(),
  memory: new Set<string>(),
  stagedTool: new Set<string>(),
  stagedFile: new Set<string>(),
};

type ApprovalCountBucket = keyof ApprovalCountIdSets;

const COMPOSITE_ID_PREFIXES: Readonly<Record<ApprovalCountBucket, string>> = {
  tool: 'tool:',
  memory: 'memory:',
  stagedTool: 'staged-tool:',
  stagedFile: 'staged-file:',
};

/** Count pending items across all buckets. */
export function countApprovalIdSets(sets: ApprovalCountIdSets): number {
  return sets.tool.size + sets.memory.size + sets.stagedTool.size + sets.stagedFile.size;
}

/**
 * Add a primary-key ID to one bucket. Returns the same `prev` reference
 * when the ID was already present (no-op) so React skips an unnecessary
 * re-render.
 */
export function addApprovalCountId(
  prev: ApprovalCountIdSets,
  bucket: ApprovalCountBucket,
  id: string,
): ApprovalCountIdSets {
  const current = prev[bucket];
  if (current.has(id)) return prev;
  const next = new Set(current);
  next.add(id);
  return { ...prev, [bucket]: next } as ApprovalCountIdSets;
}

/**
 * Remove a primary-key ID from one bucket. Returns the same `prev` reference
 * when the ID was absent so duplicate resolved events / optimistic-removal
 * follow-ups become free no-ops.
 */
export function removeApprovalCountId(
  prev: ApprovalCountIdSets,
  bucket: ApprovalCountBucket,
  id: string,
): ApprovalCountIdSets {
  const current = prev[bucket];
  if (!current.has(id)) return prev;
  const next = new Set(current);
  next.delete(id);
  return { ...prev, [bucket]: next } as ApprovalCountIdSets;
}

/**
 * Resolve a composite optimistic-removal ID (`tool:<id>` / `memory:<id>` /
 * `staged-tool:<id>` / `staged-file:<id>`) to its bucket and primary key.
 * Returns null for unknown prefixes so the caller can short-circuit.
 */
export function parseCompositeApprovalId(
  compositeId: string,
): { bucket: ApprovalCountBucket; id: string } | null {
  for (const bucket of Object.keys(COMPOSITE_ID_PREFIXES) as ApprovalCountBucket[]) {
    const prefix = COMPOSITE_ID_PREFIXES[bucket];
    if (compositeId.startsWith(prefix)) {
      return { bucket, id: compositeId.slice(prefix.length) };
    }
  }
  return null;
}

/**
 * Build the ID-set snapshot from raw IPC payloads, applying:
 *   - session-availability filtering (deleted sessions hide their items),
 *   - non-staged-memory filtering (staged memory rows are surfaced via the
 *     companion staged-file row instead — matches drawer semantics),
 *   - pending-only filter for staged tool calls,
 *   - optimistic-removal tombstones (a refresh that lands inside the 60s
 *     TTL must NOT resurrect items the user just actioned).
 *
 * Pure / synchronous so it can be unit-tested without React.
 */
export function buildApprovalCountIdSets(args: {
  toolPending: ReadonlyArray<{ toolUseID: string; sessionId?: string }>;
  memoryPending: ReadonlyArray<{ toolUseId: string; originalSessionId?: string; sessionId?: string; staged?: boolean }>;
  stagedCalls: ReadonlyArray<{ id: string; sessionId?: string; status?: string }>;
  stagedFiles: ReadonlyArray<{ id?: string; sessionId?: string | null }>;
  sessionSummaries: readonly ApprovalSessionSummary[];
  suppressedIds: ReadonlySet<string>;
}): ApprovalCountIdSets {
  const { toolPending, memoryPending, stagedCalls, stagedFiles, sessionSummaries, suppressedIds } = args;

  const tool = new Set<string>();
  for (const item of toolPending) {
    if (suppressedIds.has(`tool:${item.toolUseID}`)) continue;
    if (!isApprovalSourceSessionAvailable(item.sessionId, sessionSummaries)) continue;
    tool.add(item.toolUseID);
  }

  const memory = new Set<string>();
  for (const item of memoryPending) {
    if (item.staged) continue;
    if (suppressedIds.has(`memory:${item.toolUseId}`)) continue;
    if (!isApprovalSourceSessionAvailable(item.originalSessionId ?? item.sessionId, sessionSummaries)) continue;
    memory.add(item.toolUseId);
  }

  const stagedTool = new Set<string>();
  for (const item of stagedCalls) {
    if (item.status !== 'pending') continue;
    if (suppressedIds.has(`staged-tool:${item.id}`)) continue;
    if (!isApprovalSourceSessionAvailable(item.sessionId, sessionSummaries)) continue;
    stagedTool.add(item.id);
  }

  const stagedFile = new Set<string>();
  for (const item of stagedFiles) {
    if (!item.id) continue;
    if (suppressedIds.has(`staged-file:${item.id}`)) continue;
    if (!isApprovalSourceSessionAvailable(item.sessionId ?? null, sessionSummaries)) continue;
    stagedFile.add(item.id);
  }

  return { tool, memory, stagedTool, stagedFile };
}

/**
 * Raw tool-approval payload (as received from IPC / broadcasts).
 * Stored in state and fed to the shared `deriveUnifiedApprovals` mapper at
 * render time — this is Stage 3's "extract pure list-derivation logic" split.
 */
type RawToolApproval = ToolSafetyApprovalRequestBroadcast;

/** Raw memory-approval payload. */
type RawMemoryApproval = Pick<
  MemoryWriteApprovalRequestBroadcast,
  | 'toolUseId'
  | 'originalSessionId'
  | 'summary'
  | 'timestamp'
  | 'sensitivityReason'
  | 'hasSpaceOverride'
  | 'privateMode'
  | 'contentPreview'
  | 'approvalIdentifier'
  | 'approvalKind'
  | 'authorLabel'
  | 'staged'
> & {
  toolUseId: string;
  originalSessionId: string;
  filePath: string;
  spaceName: string;
  location?: FileLocation;
  summary: string;
  content: string;
  timestamp: number;
  blockedBy?: MemoryBlockedBySource;
  spacePath?: string;
  sharing?: MemoryApprovalSharing;
  isNewFile?: boolean;
};

/** Session context for rich tooltips */
export interface SessionContext {
  title: string;
  firstMessagePreview?: string;
  lastMessagePreview?: string;
  messageCount: number;
  sessionStartedAt?: number;
  lastUpdatedAt?: number;
}

/** Unified approval item for display in the inbox strip */
export interface PendingApprovalItem {
  /** Composite key: `tool:${id}`, `memory:${id}`, or `staged-tool:${id}` */
  id: string;
  /** Approval type */
  type: 'tool' | 'memory' | 'staged-tool';
  /** Display title - session/conversation title or fallback */
  title: string;
  /** Human-readable description of what the tool wants to do */
  description: string;
  /** When the approval was requested */
  timestamp: number;
  /** Session to navigate to for review */
  sessionId: string | null;
  /** Risk level (tool and staged-tool approvals) */
  riskLevel?: 'low' | 'medium' | 'high';
  /** Package name e.g. "Gmail" (tool and staged-tool approvals) */
  packageName?: string;
  /** Conversation title for context (tool approvals only) */
  conversationTitle?: string;
  /** Rich session context for tooltips */
  sessionContext?: SessionContext;
  /** Original tool approval data (for type='tool') */
  toolApproval?: {
    toolUseID: string;
    turnId: string;
    toolName: string;
    input: Record<string, unknown>;
    reason?: string;
    /** Effective tool ID for trustedTools writes (inner tool_id for use_tool wrappers) */
    effectiveToolId?: string;
    /** Block source — 'safety_prompt' for principled blocks, 'eval_error' for evaluator unavailable. */
    blockedBy?: ToolBlockSource;
  };
  /** Original memory approval data (for type='memory') */
  memoryApproval?: {
    toolUseId: string;
    originalSessionId: string;
    filePath: string;
    spaceName: string;
    location?: FileLocation;
    summary: string;
    content: string;
    /** Rich fields for UI display (from real-time broadcast or persisted store) */
    sensitivityReason?: string;
    hasSpaceOverride?: boolean;
    privateMode?: boolean;
    /** Which evaluation path blocked this write */
    blockedBy?: MemoryBlockedBySource;
    /** Workspace-relative path for per-space safety overrides */
    spacePath?: string;
    sharing?: MemoryApprovalSharing;
    contentPreview?: string;
    approvalIdentifier?: string;
    approvalKind?: MemoryApprovalKind;
    authorLabel?: string;
    /** True when content was already staged to CoS pending — approval is informational */
    staged?: boolean;
    /** True when the pending write is creating a new file instead of editing one. */
    isNewFile?: boolean;
  };
  /** Staged tool call data (for type='staged-tool') */
  stagedToolCall?: {
    id: string;
    displayName: string;
    mcpPayload: { packageId: string; toolId: string; args: Record<string, unknown> };
    riskLevel?: 'low' | 'medium' | 'high';
    reason?: string;
    allowPermanentTrust?: boolean;
    /** Block source — 'safety_prompt' for principled blocks, 'eval_error' for evaluator unavailable. */
    blockedBy?: ToolBlockSource;
    automationName?: string;
  };
}

export interface UsePendingApprovalsReturn {
  /** Combined list of pending approvals, sorted by timestamp (most recent first for easier triage) */
  approvals: PendingApprovalItem[];
  /** Whether initial load is in progress */
  isLoading: boolean;
  /** Refresh approvals (called on window focus) */
  refresh: () => Promise<void>;
  /** Remove an approval from the list (optimistic, for when navigating to review) */
  removeApproval: (id: string) => void;
  /** Dismiss an approval without reviewing (skips it). Returns true on success, false on failure.
   * @param options.sendFeedback - When true (default), sends a discard message to the originating conversation for memory approvals. */
  dismissApproval: (approval: PendingApprovalItem, options?: { sendFeedback?: boolean }) => Promise<boolean>;
  /** Save a memory approval directly (silent save, no navigation) */
  saveApproval: (approval: PendingApprovalItem) => Promise<void>;
  /** Approve a tool directly from inbox. Returns ApprovalOutcome with failure reason. */
  approveToolApproval: (approval: PendingApprovalItem) => Promise<ApprovalOutcome>;
  /** Execute a staged tool call directly. Returns ApprovalOutcome with failure reason. */
  executeStagedApproval: (approval: PendingApprovalItem) => Promise<ApprovalOutcome>;
  /** Batch-approve multiple approvals (tool, memory, and staged-tool), grouping continuations by session.
   * Sends one combined continuation message per session instead of one per approval. */
  batchApproveToolApprovals: (approvals: PendingApprovalItem[]) => Promise<BatchApprovalResult>;
}

export function buildStagedToolCallPayloadFromBroadcast(
  data: StagedToolCallBroadcastPayload,
  existing?: StagedToolCallPayload,
): StagedToolCallPayload {
  return {
    id: data.id,
    sessionId: data.sessionId,
    turnId: existing?.turnId ?? '',
    timestamp: data.timestamp,
    expiresAt: existing?.expiresAt ?? 0,
    status: existing?.status ?? 'pending',
    mcpPayload: {
      packageId: data.packageId,
      toolId: data.toolId,
      args: existing?.mcpPayload.args ?? {},
    },
    displayName: data.displayName,
    toolCategory: existing?.toolCategory ?? 'side-effect',
    riskLevel: data.riskLevel ?? existing?.riskLevel,
    reason: data.reason ?? existing?.reason,
    allowPermanentTrust: data.allowPermanentTrust ?? existing?.allowPermanentTrust,
    blockedBy: data.blockedBy ?? existing?.blockedBy,
    automationId: existing?.automationId,
    automationName: data.automationName ?? existing?.automationName,
    result: existing?.result,
  };
}

export function mergeStagedToolCallBroadcast(
  previous: readonly StagedToolCallPayload[],
  data: StagedToolCallBroadcastPayload,
): StagedToolCallPayload[] {
  const existingIndex = previous.findIndex((approval) => approval.id === data.id);
  if (existingIndex === -1) {
    return [...previous, buildStagedToolCallPayloadFromBroadcast(data)];
  }

  return previous.map((approval, index) =>
    index === existingIndex
      ? buildStagedToolCallPayloadFromBroadcast(data, approval)
      : approval,
  );
}

/**
 * Hook to load and track all pending approvals (tool + memory).
 * Subscribes to new approval events and polls on window focus for removals.
 * 
 * NOTE: usePendingApprovalCount (below) subscribes to the same 6 IPC events.
 * If adding new approval event types, update both hooks to stay in sync.
 */
// TTL for session context cache - avoids fetching session list on every approval event
const SESSION_CONTEXT_TTL_MS = 30_000; // 30 seconds

export function usePendingApprovals(
  options?: { onSendContinuation?: (sessionId: string, message: string, receiptText?: string) => Promise<void> | void }
): UsePendingApprovalsReturn {
  const onSendContinuation = options?.onSendContinuation;
  // Raw DTO state — the final `PendingApprovalItem[]` list is computed via
  // the shared `deriveUnifiedApprovals` mapper (Stage 3 of
  // docs/plans/260416_centralize_approval_and_diff_viewing_ux.md). Holding
  // the raw shape lets us reuse the same derivation on mobile/web via
  // `useUnifiedApprovals`, and guarantees the two paths cannot drift.
  const [rawTools, setRawTools] = useState<RawToolApproval[]>([]);
  const [rawMemories, setRawMemories] = useState<RawMemoryApproval[]>([]);
  const [rawStagedCalls, setRawStagedCalls] = useState<StagedToolCallPayload[]>([]);
  // F3-1: staged files are read live for dedup + optimistic cascade; they're
  // NOT emitted as rows here (desktop has a dedicated staged-files strip
  // rendered via useStagedFiles in the consumer). The mapper honours this
  // via `includeStagedFileItems: false` below.
  const { files: stagedFileItems } = useStagedFiles();
  // The UI also needs to honour optimistic removals triggered from elsewhere
  // (e.g. the notification bell), so we track a ticker that forces the
  // memoized output to refresh whenever the module-level suppression set
  // changes.
  const [suppressionTick, setSuppressionTick] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  // Cache session context to avoid repeated lookups
  const sessionContextRef = useRef<SessionContextMap>(new Map());
  const sessionContextLastFetchedRef = useRef<number>(0);

  // Load session context for lookup (includes title, previews, timestamps)
  // Uses TTL cache to avoid fetching on every approval event
  const loadSessionContext = useCallback(async (): Promise<SessionContextMap> => {
    // Return cached if fresh (within TTL)
    const now = Date.now();
    if (now - sessionContextLastFetchedRef.current < SESSION_CONTEXT_TTL_MS && sessionContextRef.current.size > 0) {
      return sessionContextRef.current;
    }
    try {
      const summaries = await window.sessionsApi.list();
      const map = new Map<string, SessionContext>();
      for (const s of summaries) {
        map.set(s.id, {
          title: s.title || 'Untitled',
          firstMessagePreview: s.firstMessagePreview,
          lastMessagePreview: s.lastMessagePreview,
          messageCount: s.messageCount,
          sessionStartedAt: s.createdAt,
          lastUpdatedAt: s.updatedAt,
        });
      }
      sessionContextRef.current = map;
      sessionContextLastFetchedRef.current = now;
      return map;
    } catch (err) {
      console.error('Failed to load session context:', err);
      return sessionContextRef.current;
    }
  }, []);

  // Load all approvals with abort support
  const loadApprovals = useCallback(async (signal?: AbortSignal) => {
    try {
      // Load session context first for lookup (title, previews, timestamps)
      await loadSessionContext();
      if (signal?.aborted) return;

      // Load tool approvals
      // Note: We use replace (not merge) for Inbox because:
      // 1. Inbox loads on mount, not per-session change, so race window is narrow
      // 2. Window focus triggers reload anyway for sync
      // 3. Using merge would cause "ghost items" - items removed remotely would re-appear
      //    because they'd look like "new IPC arrivals" to the merge logic
      const toolPending = await window.safetyApi.pending();
      if (signal?.aborted) return;
      setRawTools(toolPending.map((a): RawToolApproval => ({
        toolUseID: a.toolUseID,
        turnId: a.turnId,
        sessionId: a.sessionId,
        toolName: a.toolName,
        input: a.input,
        reason: a.reason,
        timestamp: a.timestamp,
        riskLevel: a.riskLevel,
        packageName: a.packageName,
        conversationTitle: a.conversationTitle,
        effectiveToolId: a.effectiveToolId,
        blockedBy: a.blockedBy,
      })));

      // Load memory approvals
      // Memory approvals have real-time resolved subscription, so replace is safe
      const memoryPending = await window.memoryApi.getPendingApprovals({});
      if (signal?.aborted) return;
      setRawMemories(memoryPending.map((a): RawMemoryApproval => ({
        toolUseId: a.toolUseId,
        originalSessionId: a.originalSessionId,
        filePath: a.filePath,
        spaceName: a.spaceName,
        location: a.location,
        summary: a.summary,
        content: a.content,
        timestamp: a.timestamp,
        sensitivityReason: a.sensitivityReason,
        hasSpaceOverride: a.hasSpaceOverride,
        privateMode: a.privateMode,
        blockedBy: a.blockedBy,
        spacePath: a.spacePath,
        sharing: a.sharing,
        contentPreview: a.contentPreview,
        approvalIdentifier: a.approvalIdentifier,
        approvalKind: a.approvalKind,
        authorLabel: a.authorLabel,
        staged: a.staged,
        isNewFile: (a as { isNewFile?: boolean }).isNewFile,
      })));

      // Load staged tool calls (cross-session — no sessionId filter).
      // Filtering to `pending` stays here to match legacy behaviour — the
      // shared mapper also enforces this via `excludeNonPendingStagedCalls`
      // by default, but keeping the upfront filter keeps state slim.
      const stagedPending = await window.safetyApi.stagedGetAll({});
      if (signal?.aborted) return;
      setRawStagedCalls(stagedPending.filter((c) => c.status === 'pending'));
    } catch (err) {
      if (signal?.aborted) return;
      console.error('Failed to load pending approvals:', err);
    } finally {
      if (!signal?.aborted) {
        setIsLoading(false);
      }
    }
  }, [loadSessionContext]);

  // Initial load with cleanup
  useEffect(() => {
    const abortController = new AbortController();
    setIsLoading(true);
    void loadApprovals(abortController.signal);
    return () => abortController.abort();
  }, [loadApprovals]);

  // Subscribe to new tool approval requests — push raw DTO into state;
  // the UI list is recomputed from state by the shared mapper downstream.
  useEffect(() => {
    const unsubscribe = window.api.onToolSafetyApprovalRequest((request) => {
      setRawTools((prev) => {
        if (prev.some((a) => a.toolUseID === request.toolUseID)) return prev;
        const next: RawToolApproval = {
          toolUseID: request.toolUseID,
          turnId: request.turnId,
          sessionId: request.sessionId,
          toolName: request.toolName,
          input: request.input,
          reason: request.reason,
          timestamp: request.timestamp,
          riskLevel: request.riskLevel,
          packageName: request.packageName,
          conversationTitle: request.conversationTitle,
          effectiveToolId: request.effectiveToolId,
          blockedBy: request.blockedBy,
        };
        return [...prev, next];
      });
    });
    return () => unsubscribe();
  }, []);

  // Subscribe to new memory approval requests
  useEffect(() => {
    const unsubscribe = window.api.onMemoryWriteApprovalRequest((request) => {
      setRawMemories((prev) => {
        if (prev.some((a) => a.toolUseId === request.toolUseId)) return prev;
        // Real-time broadcasts use a nested `destination` object; cloud
        // catch-up sends the flat shape. Normalize both to the raw shape.
        const dest = request.destination;
        const flat = request as Record<string, unknown>;
        const next: RawMemoryApproval = {
          toolUseId: request.toolUseId,
          originalSessionId: request.originalSessionId,
          filePath: dest?.path ?? (flat.filePath as string) ?? '',
          spaceName: dest?.spaceName ?? (flat.spaceName as string) ?? '',
          location: dest?.location ?? (flat.location as FileLocation | undefined),
          summary: request.summary,
          // Not available in real-time - fetched from persistence on preview
          content: '',
          timestamp: request.timestamp,
          sensitivityReason: request.sensitivityReason,
          hasSpaceOverride: request.hasSpaceOverride,
          privateMode: request.privateMode,
          blockedBy: (request as { blockedBy?: MemoryBlockedBySource }).blockedBy,
          spacePath: dest?.spacePath ?? (flat.spacePath as string | undefined),
          sharing:
            dest?.sharing ??
            (flat.sharing as MemoryApprovalSharing | undefined),
          contentPreview: request.contentPreview,
          approvalIdentifier: request.approvalIdentifier,
          approvalKind: request.approvalKind,
          authorLabel: request.authorLabel,
          staged: (request as { staged?: boolean }).staged,
          isNewFile: dest?.isNew ?? (flat.isNewFile as boolean | undefined),
        };
        return [...prev, next];
      });
    });
    return () => unsubscribe();
  }, []);

  // Subscribe to resolved memory approvals (from other surfaces) for real-time sync
  useEffect(() => {
    const unsubscribe = window.api.onMemoryWriteApprovalResolved((data) => {
      setRawMemories((prev) => prev.filter((a) => a.toolUseId !== data.toolUseId));
    });
    return () => unsubscribe();
  }, []);

  // Subscribe to resolved tool approvals (from other surfaces) for real-time sync
  useEffect(() => {
    const unsubscribe = window.api.onToolSafetyApprovalResolved((data) => {
      setRawTools((prev) => prev.filter((a) => a.toolUseID !== data.toolUseID));
    });
    return () => unsubscribe();
  }, []);

  // Subscribe to new staged tool calls (cross-session — no session filter)
  useEffect(() => {
    const unsubscribe = window.api.onStagedToolCall((data) => {
      setRawStagedCalls((prev) => {
        // The lightweight broadcast event doesn't include expiresAt / args /
        // turnId. Execution uses the staged call ID to look up the full
        // payload in main process, so placeholders here don't affect
        // correctness. Same-id broadcasts are merged so updated display /
        // trust metadata (notably `blockedBy`) can reach the UI without
        // replacing the stored executable arguments.
        return mergeStagedToolCallBroadcast(prev, data);
      });
    });
    return () => unsubscribe();
  }, []);

  // Subscribe to staged tool call status updates (remove on terminal status)
  useEffect(() => {
    const unsubscribe = window.api.onStagedToolCallUpdated((data) => {
      if (data.status !== 'pending') {
        setRawStagedCalls((prev) => prev.filter((a) => a.id !== data.id));
      }
    });
    return () => unsubscribe();
  }, []);

  // Poll on window focus for removals
  useEffect(() => {
    let abortController: AbortController | null = null;
    const handleFocus = () => {
      // Abort any previous in-flight request
      abortController?.abort();
      abortController = new AbortController();
      void loadApprovals(abortController.signal);
    };
    window.addEventListener('focus', handleFocus);
    return () => {
      window.removeEventListener('focus', handleFocus);
      abortController?.abort();
    };
  }, [loadApprovals]);

  // Derive the display list via the shared pure mapper. Desktop keeps its
  // legacy semantics: staged files are rendered in a dedicated surface (via
  // useStagedFiles), not inline here, and staged-memory rows stay visible
  // (dedup applies only in `usePendingApprovalCount`). Staged files ARE fed
  // into the mapper so cascade suppression of paired memory rows works when
  // a staged-file action fires `notifyOptimisticRemoval('staged-file:X')`.
  const approvals = useMemo<PendingApprovalItem[]>(() => {
    const suppressed = snapshotOptimisticRemovals();
    // Supply tool summaries for the mapper so its "no reason" fallback
    // matches desktop's rich tool chip description (e.g. "Run command: npm
    // test"). The summary is platform-specific (uses the renderer tool-chip
    // utility), so we compute it here and pass it in.
    const toolSummaries = new Map<string, ToolApprovalSummary>();
    for (const t of rawTools) {
      const s = summarizeToolForApproval(t.toolName, t.input);
      toolSummaries.set(t.toolUseID, { label: s.label, detail: s.detail });
    }

    // Map desktop StagedFileItem (hook-enriched) → shared StagedFileInput.
    // The mapper uses these for FM #16 dedup + cascade suppression of
    // paired memory rows. `toolUseId` is the preferred pairing key;
    // `destination` falls back to `pendingDestination` when toolUseId is
    // absent (older staged files / IPC payloads that predate the residual
    // fields). `includeStagedFileItems: false` below keeps these rows out
    // of the emitted list — desktop renders staged files in a dedicated
    // strip via useStagedFiles.
    const stagedFilesForMapper: StagedFileInput[] = stagedFileItems.map((f) => ({
      id: f.id,
      realPath: f.realPath,
      spaceName: f.spaceName,
      spacePath: f.spacePath,
      location: f.location,
      sessionId: f.sessionId,
      baseHash: f.baseHash,
      summary: f.summary,
      stagedAt: f.stagedAt,
      sensitivity: 'high',
      sharing: f.sharing,
      blockedBy: f.blockedBy,
      hasConflict: f.hasConflict,
      // F3-1-residual: forward the paired-memory cascade keys.
      toolUseId: f.toolUseId,
      destination: f.pendingDestination,
    }));

    const mapperInputs = {
      toolApprovals: rawTools as readonly ToolApprovalInput[],
      memoryApprovals: rawMemories as readonly MemoryApprovalInput[],
      stagedCalls: rawStagedCalls as readonly StagedToolCallInput[],
      stagedFiles: stagedFilesForMapper,
      sessionContext: sessionContextRef.current as ReadonlyMap<string, SessionContextForApprovals>,
      toolSummaries,
    };
    const unified: UnifiedApproval[] = deriveUnifiedApprovals(mapperInputs, {
      suppressedIds: suppressed,
      excludeNonPendingStagedCalls: true,
      includeStagedFileItems: false,
      dedupStagedMemoryApprovals: false,
      parseBackgroundTaskType,
      stripSafetyPrefix,
      isGenericReason,
    });

    // Convert UnifiedApproval → PendingApprovalItem shape used across desktop.
    // Callers downstream have typed consumers on this shape. Staged-file rows
    // are already suppressed by `includeStagedFileItems: false`, but we keep
    // a defensive filter here as belt-and-braces.
    return unified
      .filter((u) => u.kind !== 'staged-file')
      .map((u): PendingApprovalItem => ({
        id: u.id,
        type: u.kind === 'staged-tool' ? 'staged-tool' : u.kind === 'memory' ? 'memory' : 'tool',
        title: u.title,
        description: u.description,
        timestamp: u.timestamp,
        sessionId: u.sessionId,
        riskLevel: u.riskLevel,
        packageName: u.packageName,
        conversationTitle: u.conversationTitle,
        sessionContext: u.sessionContext,
        toolApproval: u.toolApproval,
        memoryApproval: u.memoryApproval,
        stagedToolCall: u.stagedToolCall,
      }));
    // `suppressionTick` is a deliberate recompute trigger: it's bumped when
    // `notifyOptimisticRemoval` fires outside the hook, so the mapper
    // re-reads the module-level suppression set. Excluding it would leave
    // stale UI after cross-surface optimistic removals.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: omitting stable mapper helpers; suppressionTick is the explicit recompute trigger for module-level suppression state
  }, [rawTools, rawMemories, rawStagedCalls, stagedFileItems, suppressionTick]);

  // Keep the mapper's suppression view in sync with module-level events.
  useEffect(() => {
    const handler = () => setSuppressionTick((n) => n + 1);
    window.addEventListener(OPTIMISTIC_REMOVAL_EVENT, handler);
    return () => window.removeEventListener(OPTIMISTIC_REMOVAL_EVENT, handler);
  }, []);

  // Remove an approval optimistically (when user clicks Review/Approve/Dismiss).
  // Also signals usePendingApprovalCount to decrement immediately.
  const removeApproval = useCallback((id: string) => {
    notifyOptimisticRemoval(id);
    if (id.startsWith('tool:')) {
      const toolId = id.slice('tool:'.length);
      setRawTools((prev) => prev.filter((a) => a.toolUseID !== toolId));
    } else if (id.startsWith('memory:')) {
      const memId = id.slice('memory:'.length);
      setRawMemories((prev) => prev.filter((a) => a.toolUseId !== memId));
    } else if (id.startsWith('staged-tool:')) {
      const stId = id.slice('staged-tool:'.length);
      setRawStagedCalls((prev) => prev.filter((a) => a.id !== stId));
    }
    // staged-file:* suppression is honoured via notifyOptimisticRemoval; the
    // paired memory row is dropped by the mapper's cascade rule.
  }, []);

  // Dismiss an approval (skip/deny it without reviewing)
  // Returns true on success, false on failure (for error handling in callers)
  // When sendFeedback is true (default) and the approval is memory type,
  // a discard message is sent to the originating conversation.
  const dismissApproval = useCallback(async (
    approval: PendingApprovalItem,
    dismissOptions?: { sendFeedback?: boolean },
  ): Promise<boolean> => {
    const sendFeedback = dismissOptions?.sendFeedback ?? true;
    try {
      if (approval.type === 'staged-tool' && approval.stagedToolCall) {
        await window.safetyApi.stagedReject({ id: approval.stagedToolCall.id });
      } else if (approval.type === 'tool' && approval.toolApproval) {
        // Deny the tool approval (no discard feedback for tool approvals)
        await window.agentApi.toolSafetyResponse({
          toolUseID: approval.toolApproval.toolUseID,
          approved: false,
          input: approval.toolApproval.input,
        });
      } else if (approval.type === 'memory' && approval.memoryApproval) {
        if (sendFeedback) {
          // Use discardMemoryApproval to deny + send feedback in one flow
          const success = await discardMemoryApproval(
            {
              toolUseId: approval.memoryApproval.toolUseId,
              originalSessionId: approval.memoryApproval.originalSessionId,
              filePath: approval.memoryApproval.filePath,
              spaceName: approval.memoryApproval.spaceName,
            },
            onSendContinuation,
          );
          if (!success) {
            return false;
          }
        } else {
          // Skip without feedback (e.g. guidance flow already sends its own message)
          const result = await window.api.sendMemoryWriteApprovalResponse({
            toolUseId: approval.memoryApproval.toolUseId,
            approved: false,
          });
          if (!result.success) {
            return false;
          }
        }
      }
      // Remove from local state
      removeApproval(approval.id);
      return true;
    } catch (err) {
      console.error('Failed to dismiss approval:', err);
      return false;
    }
  }, [onSendContinuation, removeApproval]);

  // Save a memory approval directly (silent save, no navigation)
  const saveApproval = useCallback(async (approval: PendingApprovalItem) => {
    if (approval.type !== 'memory' || !approval.memoryApproval) {
      console.warn('saveApproval called on non-memory approval');
      return;
    }

    // Optimistic removal - don't wait for broadcast
    removeApproval(approval.id);

    // Use shared utility for save logic — pass through callback for queue routing
    const result = await saveMemoryApproval(
      {
        toolUseId: approval.memoryApproval.toolUseId,
        originalSessionId: approval.memoryApproval.originalSessionId,
        filePath: approval.memoryApproval.filePath,
        spaceName: approval.memoryApproval.spaceName,
        content: approval.memoryApproval.content,
        approvalKind: approval.memoryApproval.approvalKind,
        staged: approval.memoryApproval.staged,
      },
      onSendContinuation,
    );

    if (!result.ok) {
      console.error('Failed to save memory approval from Inbox:', { toolUseId: approval.memoryApproval.toolUseId });
      // Note: Item is already removed optimistically. Broadcast sync or refresh will restore if still pending.
    }
  }, [onSendContinuation, removeApproval]);

  // Approve a tool directly from inbox (no navigation, triggers retry via continuation)
  // Returns ApprovalOutcome with failure reason for contextual error handling
  const approveToolApproval = useCallback(async (approval: PendingApprovalItem): Promise<ApprovalOutcome> => {
    if (approval.type !== 'tool' || !approval.toolApproval) {
      console.warn('approveToolApproval called on non-tool approval');
      return { ok: false, reason: 'unknown' };
    }

    // Optimistic removal
    removeApproval(approval.id);

    try {
      // 1. Store approval via IPC (so retry will be auto-approved)
      await window.agentApi.toolSafetyResponse({
        toolUseID: approval.toolApproval.toolUseID,
        approved: true,
        input: approval.toolApproval.input,
      });
    } catch (err) {
      console.error('Failed to store tool approval:', err);
      void loadApprovals();
      return { ok: false, reason: 'ipc-unavailable' };
    }

    // 2. Send continuation message to trigger agent retry.
    // This is best-effort — the approval is already stored, so a continuation
    // failure should not revert the approval or show "Failed to approve" (REBEL-10T).
    try {
      if (approval.sessionId) {
        const message = buildToolContinuationMessage(
          approval.toolApproval.toolName,
          approval.toolApproval.input
        );
        const summary = summarizeToolForApproval(approval.toolApproval.toolName, approval.toolApproval.input);
        const receipt = `Approved: ${summary.label}`;
        if (onSendContinuation) {
          await Promise.resolve(onSendContinuation(approval.sessionId, message, receipt));
        } else {
          // 'reject': an approval continuation must never cancel a turn the
          // user has since started — if the target is busy, the agent picks
          // the stored approval up on its next interaction instead.
          await dispatchAgentTurn({
            sessionId: approval.sessionId,
            prompt: message,
            isSystemContinuation: true,
          }, { policy: 'reject' });
        }
      }
    } catch (err) {
      console.warn('Tool approved but continuation failed — agent will retry on next interaction:', err);
    }

    return { ok: true };
  }, [loadApprovals, onSendContinuation, removeApproval]);

  // Execute a staged tool call directly from notification bell / inbox.
  // Calls stagedExecute IPC, then sends a continuation message with the result.
  // Returns ApprovalOutcome with failure reason for contextual error handling.
  const executeStagedApproval = useCallback(async (approval: PendingApprovalItem): Promise<ApprovalOutcome> => {
    if (approval.type !== 'staged-tool' || !approval.stagedToolCall) {
      console.warn('executeStagedApproval called on non-staged-tool approval');
      return { ok: false, reason: 'unknown' };
    }

    removeApproval(approval.id);

    try {
      const result = await window.safetyApi.stagedExecute({
        id: approval.stagedToolCall.id,
      });

      const displayName = approval.stagedToolCall.displayName;
      const isAutomationRun = approval.stagedToolCall.mcpPayload.toolId === AUTOMATION_RUN_TOOL_ID;

      // Handle stale calls (already executed/rejected/expired in main process).
      // Uses the shared constant to avoid string-literal coupling with main process.
      if (!result.success && result.error === STAGED_CALL_NOT_FOUND_ERROR) {
        return { ok: true }; // silently succeed — call was already handled
      }

      if (!result.success) {
        // Classify the error into a structured outcome for contextual toast messages.
        // Thread the action display name so the arg-validation copy can name the
        // action ("…the details for Send email…") without leaking jargon (FOX-3519
        // refinement). Harmless for other reasons (copy helpers ignore it).
        const outcome = withDisplayName(classifyStagedError(result.error), displayName);

        // Execution itself failed — inform the agent. Best-effort for the
        // RETURN value (the user already sees the classified failure +
        // detail via `outcome`), but never a silent drop: the agent missing
        // the failure notice is observable in the log (Stage 3 review F2).
        //
        // Pass a `receipt` (mirroring the success path below) so this
        // agent-facing notice is hidden and stamped `system-continuation`.
        // Without it the notice has no hide signal, rides the message queue
        // as a visible `role:'user'` message, gets stamped `queue-drain` on
        // drain, and renders as an editable "YOU" bubble — misattributing a
        // system error to the user (260618 diagnosis). The user already sees
        // the failure via `outcome` (toast); this message exists for the agent.
        try {
          if (approval.sessionId) {
            const message = `Failed to execute: ${displayName}\n\nError: ${stripErrorNoise(result.error || 'Unknown error')}`;
            const receipt = `Failed to execute: ${displayName}`;
            if (onSendContinuation) {
              await Promise.resolve(onSendContinuation(approval.sessionId, message, receipt));
            } else {
              // 'reject': best-effort failure notice — never worth cancelling
              // a running turn for.
              await dispatchAgentTurn({
                sessionId: approval.sessionId,
                prompt: message,
                isSystemContinuation: true,
              }, { policy: 'reject' });
            }
          }
        } catch (noticeErr) {
          console.warn(
            'Staged tool failed and the failure notice could not be delivered to the conversation:',
            { sessionId: approval.sessionId, displayName, error: errorDetailFromUnknown(noticeErr) },
          );
        }
        void loadApprovals();
        return outcome;
      }

      // Execution succeeded — deliver the result. NOT silently best-effort:
      // the result text exists ONLY in this continuation, so a failed
      // delivery (e.g. typed busy refusal on the direct fallback) must
      // surface as 'result-not-delivered' instead of a silent { ok:true }
      // (Stage 3 review F2). The execution state stays consistent — the
      // staged call is consumed and is NOT restored.
      try {
        if (approval.sessionId && !isAutomationRun) {
          const summary = summarizeStagedExecutionResult(result.content || 'Operation completed successfully.');
          const message = `Executed: ${displayName}\n\nResult:\n${summary}`;
          const receipt = `Executed: ${displayName}`;
          if (onSendContinuation) {
            await Promise.resolve(onSendContinuation(approval.sessionId, message, receipt));
          } else {
            // 'reject': result delivery must not interrupt an active turn on
            // the target session (the incident class this stage kills).
            await dispatchAgentTurn({
              sessionId: approval.sessionId,
              prompt: message,
              isSystemContinuation: true,
            }, { policy: 'reject' });
          }
        }
      } catch (err) {
        console.warn('Staged tool executed but result delivery failed:', err);
        return { ok: false, reason: 'result-not-delivered', detail: errorDetailFromUnknown(err) };
      }
      return { ok: true };
    } catch (err) {
      console.error('Failed to execute staged tool from notification bell:', err);
      void loadApprovals();
      return { ok: false, reason: 'ipc-unavailable' };
    }
  }, [loadApprovals, onSendContinuation, removeApproval]);

  // Batch-approve multiple tool approvals, grouping continuations by session.
  // Instead of firing N separate agent:turn calls (where N-1 get superseded),
  // this stores all approvals and sends one combined continuation per session.
  const batchApproveToolApprovals = useCallback(async (items: PendingApprovalItem[]): Promise<BatchApprovalResult> => {
    const batchResult: BatchApprovalResult = {
      total: items.length,
      succeeded: items.length,
      failed: 0,
      failures: [],
    };
    const toolItems = items.filter(a => a.type === 'tool' && a.toolApproval);
    const memoryItems = items.filter(a => a.type === 'memory');
    const stagedItems = items.filter(a => a.type === 'staged-tool' && a.stagedToolCall);

    // Handle memory approvals individually (they don't need grouping)
    for (const item of memoryItems) {
      try { await saveApproval(item); } catch (err) {
        console.error('Failed to batch-save memory approval:', err);
        batchResult.failed += 1;
        batchResult.succeeded -= 1;
        batchResult.failures.push({
          displayName: 'memory approval',
          reason: 'ipc-unavailable',
          detail: errorDetailFromUnknown(err),
        });
      }
    }

    // Handle staged tool calls via batch execute
    if (stagedItems.length > 0) {
      const ids = stagedItems
        .map((a) => a.stagedToolCall?.id)
        .filter((id): id is string => Boolean(id));
      for (const a of stagedItems) removeApproval(a.id);

      try {
        const result = await window.safetyApi.stagedExecuteBatch({ ids });
        const stagedItemsById = new Map(stagedItems.map((item) => [item.stagedToolCall?.id, item] as const));

        // Group results by session and send one continuation per session
        const stagedBySession = new Map<string, string[]>();
        for (const executed of result.executed) {
          const item = stagedItemsById.get(executed.id);
          const stagedToolCall = item?.stagedToolCall;
          if (!stagedToolCall) continue;

          const displayName = stagedToolCall.displayName;
          if (!executed.result.success) {
            const outcome = classifyStagedError(executed.result.error);
            // `arg-recovering` is NOT a user-facing failure — the agent
            // self-corrects (FOX-3519). Excluding it from the batch failure
            // tally avoids a contradictory "N actions failed: Rebel is sorting
            // that out" summary toast. The agent still receives the full
            // stripped error via the per-session continuation below.
            if (
              outcome.reason !== 'already-handled' &&
              outcome.reason !== 'already-executing' &&
              outcome.reason !== 'arg-recovering'
            ) {
              batchResult.failed += 1;
              batchResult.succeeded -= 1;
              batchResult.failures.push({
                displayName,
                reason: outcome.reason,
                detail: outcome.detail,
              });
            }
          }
          if (!item?.sessionId) continue;
          if (stagedToolCall.mcpPayload.toolId === AUTOMATION_RUN_TOOL_ID) continue;

          const msg = executed.result.success
            ? `✓ ${displayName}: ${summarizeStagedExecutionResult(executed.result.content || 'Completed')}`
            : `✗ ${displayName}: ${stripErrorNoise(executed.result.error || 'Failed')}`;

          const group = stagedBySession.get(item.sessionId) ?? [];
          group.push(msg);
          stagedBySession.set(item.sessionId, group);
        }

        for (const [sessionId, messages] of stagedBySession) {
          const combined = messages.length === 1
            ? `Executed: ${messages[0]}`
            : `Executed ${messages.length} queued action(s):\n\n${messages.join('\n')}`;
          const receipt = messages.length === 1
            ? `Executed: ${stagedItems.find(a => a.sessionId === sessionId)?.stagedToolCall?.displayName ?? 'action'}`
            : `Executed ${messages.length} queued actions`;

          try {
            if (onSendContinuation) {
              await Promise.resolve(onSendContinuation(sessionId, combined, receipt));
            } else {
              // 'reject': batch staged-execution summary must not interrupt
              // an active turn on the target session.
              await dispatchAgentTurn(
                { sessionId, prompt: combined, isSystemContinuation: true },
                { policy: 'reject' },
              );
            }
          } catch (err) {
            // The per-session result summary exists only in this
            // continuation — record the delivery failure on the batch
            // result so callers can surface it instead of a silent log
            // (Stage 3 review F2).
            console.error('Failed to send staged batch continuation:', err);
            batchResult.resultDeliveryFailures ??= [];
            batchResult.resultDeliveryFailures.push({
              sessionId,
              detail: errorDetailFromUnknown(err),
            });
          }
        }
      } catch (err) {
        console.error('Failed to execute staged batch:', err);
      }
    }

    if (toolItems.length === 0) return batchResult;

    // 1. Store all blocking tool approvals via IPC
    for (const item of toolItems) {
      const toolApproval = item.toolApproval;
      if (!toolApproval) continue;
      removeApproval(item.id);
      try {
        await window.agentApi.toolSafetyResponse({
          toolUseID: toolApproval.toolUseID,
          approved: true,
          input: toolApproval.input,
        });
      } catch (err) {
        console.error('Failed to store approval in batch:', err);
        batchResult.failed += 1;
        batchResult.succeeded -= 1;
        batchResult.failures.push({
          displayName: toolApproval.toolName,
          reason: 'ipc-unavailable',
          detail: errorDetailFromUnknown(err),
        });
      }
    }

    // 2. Group by sessionId and send one continuation per session
    const bySession = new Map<string, PendingApprovalItem[]>();
    for (const item of toolItems) {
      const sid = item.sessionId ?? '';
      if (!sid) continue;
      const group = bySession.get(sid) ?? [];
      group.push(item);
      bySession.set(sid, group);
    }

    for (const [sessionId, group] of bySession) {
      const summaries = group
        .map((item) => {
          const toolApproval = item.toolApproval;
          if (!toolApproval) return null;
          const summary = summarizeToolForApproval(toolApproval.toolName, toolApproval.input);
          return summary.label + (summary.detail ? ` (${summary.detail})` : '');
        })
        .filter((summary): summary is string => Boolean(summary));
      if (summaries.length === 0) continue;
      const message = group.length === 1
        ? `Approved. Please retry: ${summaries[0]}`
        : `Approved ${group.length} operations. Please retry: ${summaries.join(', ')}`;
      const receipt = group.length === 1
        ? `Approved: ${summaries[0]}`
        : `Approved ${group.length} operations`;

      try {
        if (onSendContinuation) {
          await Promise.resolve(onSendContinuation(sessionId, message, receipt));
        } else {
          // 'reject': batch-approval retry trigger — approvals are already
          // stored, so never cancel a running turn to deliver it.
          await dispatchAgentTurn({
            sessionId,
            prompt: message,
            isSystemContinuation: true,
          }, { policy: 'reject' });
        }
      } catch (err) {
        console.error('Failed to send batch continuation:', err);
      }
    }
    return batchResult;
  }, [onSendContinuation, removeApproval, saveApproval]);

  return {
    approvals,
    isLoading,
    refresh: loadApprovals,
    removeApproval,
    dismissApproval,
    saveApproval,
    approveToolApproval,
    executeStagedApproval,
    batchApproveToolApprovals,
  };
}

/**
 * Lightweight hook for just the approval count.
 * Used in App.tsx for the Inbox tab badge without the full hook overhead.
 *
 * Tracks a primary-key Set per approval source (`tool`, `memory`,
 * `stagedTool`, `stagedFile`) and derives the badge count from set sizes.
 * Idempotent add/remove operations make the hook robust against same-ID
 * broadcasts (e.g. `onStagedToolCall` re-emitting a pending call when
 * `blockedBy` is set), IPC catch-up arriving for items already loaded,
 * and duplicate resolve events that would otherwise drag a numeric
 * counter into drift territory.
 *
 * Optimistic-removal tombstones from {@link notifyOptimisticRemoval}
 * suppress both incoming adds and `refreshCount` rebuilds for the 60s
 * TTL so a stale broadcast cannot resurrect items the user has already
 * actioned. {@link OPTIMISTIC_REMOVAL_EVENT}'s `detail.id` drives the
 * cross-hook decrement.
 *
 * NOTE: This hook subscribes to the same IPC events as `usePendingApprovals`.
 * If adding new approval event types, update both hooks to stay in sync.
 */
export function usePendingApprovalCount(): number {
  const [idSets, setIdSets] = useState<ApprovalCountIdSets>(EMPTY_APPROVAL_COUNT_ID_SETS);
  const sessionSummaries = useSessionStore((state) => state.sessionSummaries);
  const sessionSummariesRef = useRef<ApprovalSessionSummary[]>(sessionSummaries);
  const approvalSourceSessionKey = useMemo(
    () => sessionSummaries
      .map((summary) => `${summary.id}:${summary.deletedAt ?? ''}`)
      .join('|'),
    [sessionSummaries],
  );

  useEffect(() => {
    sessionSummariesRef.current = sessionSummaries;
  }, [sessionSummaries]);

  const refreshCount = useCallback(async (signal?: AbortSignal) => {
    try {
      const [toolPending, memoryPending, stagedCalls, stagedFileResult] = await Promise.all([
        window.safetyApi.pending(),
        window.memoryApi.getPendingApprovals({}),
        window.safetyApi.stagedGetAll({}),
        window.api.getStagedFiles(),
      ]);
      if (signal?.aborted) return;
      const stagedFiles = Array.isArray(stagedFileResult)
        ? stagedFileResult
        : (stagedFileResult as { files: Array<{ id?: string; sessionId?: string | null }> }).files ?? [];
      setIdSets(buildApprovalCountIdSets({
        toolPending,
        memoryPending,
        stagedCalls,
        stagedFiles,
        sessionSummaries: sessionSummariesRef.current,
        suppressedIds: snapshotOptimisticRemovals(),
      }));
    } catch (err) {
      if (!signal?.aborted) {
        console.error('Failed to load pending approval counts:', err);
      }
    }
  }, []);

  // Initial load only - fetch actual counts from main process
  useEffect(() => {
    const abortController = new AbortController();
    void refreshCount(abortController.signal);
    return () => abortController.abort();
  }, [refreshCount]);

  // Session deletion/restoration changes which approval sources are visible.
  useEffect(() => {
    const abortController = new AbortController();
    void refreshCount(abortController.signal);
    return () => abortController.abort();
  }, [approvalSourceSessionKey, refreshCount]);

  // Add new approvals to the appropriate ID set. Idempotent: same-ID
  // broadcasts collapse to a single entry. Tombstone-aware: a stale
  // broadcast for an item the user just actioned cannot resurrect it.
  useEffect(() => {
    const unsubTool = window.api.onToolSafetyApprovalRequest((req) => {
      if (snapshotOptimisticRemovals().has(`tool:${req.toolUseID}`)) return;
      if (!isApprovalSourceSessionAvailable(req.sessionId, sessionSummariesRef.current)) return;
      setIdSets((prev) => addApprovalCountId(prev, 'tool', req.toolUseID));
    });
    const unsubMemory = window.api.onMemoryWriteApprovalRequest((req) => {
      // Staged memory rows surface via the staged-file path instead.
      if (req.staged) return;
      if (snapshotOptimisticRemovals().has(`memory:${req.toolUseId}`)) return;
      if (!isApprovalSourceSessionAvailable(req.originalSessionId, sessionSummariesRef.current)) return;
      setIdSets((prev) => addApprovalCountId(prev, 'memory', req.toolUseId));
    });
    const unsubStaged = window.api.onStagedToolCall((req) => {
      if (snapshotOptimisticRemovals().has(`staged-tool:${req.id}`)) return;
      if (!isApprovalSourceSessionAvailable(req.sessionId, sessionSummariesRef.current)) return;
      setIdSets((prev) => addApprovalCountId(prev, 'stagedTool', req.id));
    });
    return () => {
      unsubTool();
      unsubMemory();
      unsubStaged();
    };
  }, []);

  // Optimistic removals from sibling hooks (drawer/inbox/automations/staged
  // files). Uses the CustomEvent's `detail.id` to remove the right entry —
  // idempotent if the ID is unknown or already gone.
  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<OptimisticRemovalEventDetail>).detail;
      if (!detail?.id) return;
      const parsed = parseCompositeApprovalId(detail.id);
      if (!parsed) return;
      setIdSets((prev) => removeApprovalCountId(prev, parsed.bucket, parsed.id));
    };
    window.addEventListener(OPTIMISTIC_REMOVAL_EVENT, handler);
    return () => window.removeEventListener(OPTIMISTIC_REMOVAL_EVENT, handler);
  }, []);

  // Resolved IPC events. `removeApprovalCountId` is a no-op when the ID is
  // already gone (e.g. an optimistic removal landed first), so we no longer
  // need the consumeOptimisticRemoval guard the numeric counter required.
  useEffect(() => {
    const unsubMemoryResolved = window.api.onMemoryWriteApprovalResolved((data) => {
      setIdSets((prev) => removeApprovalCountId(prev, 'memory', data.toolUseId));
    });
    const unsubToolResolved = window.api.onToolSafetyApprovalResolved((data) => {
      setIdSets((prev) => removeApprovalCountId(prev, 'tool', data.toolUseID));
    });
    // Mirror the drawer hook: any non-pending status removes the call.
    // Previously only `executed`/`rejected`/`expired` decremented, which
    // left the badge inflated when a call transitioned to `failed`.
    const unsubStagedResolved = window.api.onStagedToolCallUpdated((data) => {
      if (data.status === 'pending') return;
      setIdSets((prev) => removeApprovalCountId(prev, 'stagedTool', data.id));
    });
    return () => {
      unsubMemoryResolved();
      unsubToolResolved();
      unsubStagedResolved();
    };
  }, []);

  // Staged files have no granular add/remove events — full rebuild.
  useEffect(() => {
    const unsubStagedFiles = window.api.onStagedFilesChanged(() => {
      void refreshCount();
    });
    return () => unsubStagedFiles();
  }, [refreshCount]);

  // Window-focus sync — corrects any drift from missed transitions while
  // backgrounded. Tombstone filtering inside `refreshCount` ensures we
  // don't resurrect just-actioned items.
  useEffect(() => {
    let abortController: AbortController | null = null;
    const handleFocus = () => {
      abortController?.abort();
      abortController = new AbortController();
      void refreshCount(abortController.signal);
    };
    window.addEventListener('focus', handleFocus);
    return () => {
      window.removeEventListener('focus', handleFocus);
      abortController?.abort();
    };
  }, [refreshCount]);

  return countApprovalIdSets(idSets);
}
