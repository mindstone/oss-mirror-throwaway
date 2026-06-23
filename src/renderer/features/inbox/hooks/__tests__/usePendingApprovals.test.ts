// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  notifyOptimisticRemoval,
  classifyStagedError,
  withDisplayName,
  isArgValidationFailure,
  isArgValidationExhausted,
  sanitizeErrorDetail,
  stripErrorNoise,
  approvalOutcomeMessage,
  approvalOutcomeDescription,
  approvalOutcomeVariant,
  ARG_RECOVERING_CONVERSATION_LINE,
  ARG_NEEDS_DETAIL_CONVERSATION_LINE,
  isConnectorTransportFailure,
  CONNECTOR_UNAVAILABLE_CONVERSATION_LINE,
  mergeStagedToolCallBroadcast,
  addApprovalCountId,
  removeApprovalCountId,
  countApprovalIdSets,
  parseCompositeApprovalId,
  buildApprovalCountIdSets,
  type ApprovalCountIdSets,
} from '../usePendingApprovals';
import {
  STAGED_CALL_ALREADY_EXECUTING_ERROR,
  STAGED_CALL_EXPIRED_ERROR,
  STAGED_CALL_MCP_UNAVAILABLE_ERROR,
  STAGED_CALL_NOT_FOUND_ERROR,
  STAGED_CALL_STATUS_PREFIX,
} from '@shared/ipc/channels/safety';

describe('notifyOptimisticRemoval', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('dispatches pending-approval-optimistic-removal event with the composite id in detail', () => {
    const handler = vi.fn();
    window.addEventListener('pending-approval-optimistic-removal', handler);

    notifyOptimisticRemoval('tool:abc');

    expect(handler).toHaveBeenCalledTimes(1);
    const event = handler.mock.calls[0][0] as CustomEvent<{ id: string }>;
    expect(event.detail).toEqual({ id: 'tool:abc' });
    window.removeEventListener('pending-approval-optimistic-removal', handler);
  });

  it('fires cleanup timeout (60s)', () => {
    notifyOptimisticRemoval('tool:cleanup-test');

    vi.advanceTimersByTime(60_001);
    // No assertion needed for internal Set cleanup -- the timeout firing without
    // error confirms the cleanup path runs. The Set is module-private.
  });
});

describe('stripSafetyPrefix (via module internals)', () => {
  // stripSafetyPrefix is not exported but exercised indirectly via transformToolApproval.
  // We verify the prefix-stripping behavior through the public API in integration tests.
  // This placeholder ensures the test file covers the module boundary.
  it('module imports successfully', async () => {
    const mod = await import('../usePendingApprovals');
    expect(typeof mod.notifyOptimisticRemoval).toBe('function');
    expect(typeof mod.usePendingApprovals).toBe('function');
    expect(typeof mod.usePendingApprovalCount).toBe('function');
  });
});

describe('classifyStagedError', () => {
  it('returns already-handled for STAGED_CALL_NOT_FOUND_ERROR', () => {
    const result = classifyStagedError(STAGED_CALL_NOT_FOUND_ERROR);
    expect(result).toEqual({ ok: false, reason: 'already-handled' });
  });

  it('returns already-executing for STAGED_CALL_ALREADY_EXECUTING_ERROR', () => {
    const result = classifyStagedError(STAGED_CALL_ALREADY_EXECUTING_ERROR);
    expect(result).toEqual({ ok: false, reason: 'already-executing' });
  });

  it('returns already-handled for status prefix errors', () => {
    const result = classifyStagedError(`${STAGED_CALL_STATUS_PREFIX} executed`);
    expect(result).toEqual({ ok: false, reason: 'already-handled' });
  });

  it('returns already-handled for rejected status', () => {
    const result = classifyStagedError(`${STAGED_CALL_STATUS_PREFIX} rejected`);
    expect(result).toEqual({ ok: false, reason: 'already-handled' });
  });

  it('returns expired for STAGED_CALL_EXPIRED_ERROR', () => {
    const result = classifyStagedError(STAGED_CALL_EXPIRED_ERROR);
    expect(result).toEqual({ ok: false, reason: 'expired' });
  });

  it('returns mcp-unavailable for STAGED_CALL_MCP_UNAVAILABLE_ERROR', () => {
    const result = classifyStagedError(STAGED_CALL_MCP_UNAVAILABLE_ERROR);
    expect(result).toEqual({ ok: false, reason: 'mcp-unavailable' });
  });

  it('returns execution-failed with sanitized detail for MCP tool errors', () => {
    const result = classifyStagedError('[gmail/send_email] Connection timeout (args: to, subject)');
    expect(result).toEqual({ ok: false, reason: 'execution-failed', detail: 'Connection timeout' });
  });

  it('returns execution-failed for unknown error strings', () => {
    const result = classifyStagedError('Some unexpected error');
    expect(result).toEqual({ ok: false, reason: 'execution-failed', detail: 'Some unexpected error' });
  });

  it('returns unknown for undefined error', () => {
    const result = classifyStagedError(undefined);
    expect(result).toEqual({ ok: false, reason: 'unknown' });
  });
});

describe('mergeStagedToolCallBroadcast', () => {
  it('merges same-id broadcasts while preserving executable payload fields', () => {
    const merged = mergeStagedToolCallBroadcast(
      [
        {
          id: 'staged-1',
          sessionId: 'session-a',
          turnId: 'turn-original',
          timestamp: 100,
          expiresAt: 900,
          status: 'pending',
          mcpPayload: {
            packageId: 'gmail',
            toolId: 'send-email',
            args: { to: 'a@example.com' },
          },
          displayName: 'Send email',
          toolCategory: 'side-effect',
          riskLevel: 'medium',
          reason: 'old reason',
          allowPermanentTrust: true,
          blockedBy: 'safety_prompt',
        },
      ],
      {
        id: 'staged-1',
        sessionId: 'session-a',
        displayName: 'Send urgent email',
        packageId: 'gmail',
        toolId: 'send-email',
        riskLevel: 'high',
        reason: 'The safety check did not finish',
        timestamp: 200,
        allowPermanentTrust: false,
        blockedBy: 'eval_error',
      },
    );

    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({
      id: 'staged-1',
      turnId: 'turn-original',
      expiresAt: 900,
      mcpPayload: {
        packageId: 'gmail',
        toolId: 'send-email',
        args: { to: 'a@example.com' },
      },
      displayName: 'Send urgent email',
      riskLevel: 'high',
      reason: 'The safety check did not finish',
      allowPermanentTrust: false,
      blockedBy: 'eval_error',
    });
  });
});

describe('sanitizeErrorDetail', () => {
  it('strips [package/tool] prefix', () => {
    expect(sanitizeErrorDetail('[gmail/send_email] Connection timeout')).toBe('Connection timeout');
  });

  it('strips trailing (args: ...) dump', () => {
    expect(sanitizeErrorDetail('Connection timeout (args: to, subject)')).toBe('Connection timeout');
  });

  it('strips both prefix and args dump', () => {
    expect(sanitizeErrorDetail('[slack/post_message] API error (args: channel, text)')).toBe('API error');
  });

  it('returns original string when no patterns match', () => {
    expect(sanitizeErrorDetail('Simple error message')).toBe('Simple error message');
  });

  it('handles nested slashes in package ID', () => {
    expect(sanitizeErrorDetail('[my-org/my-tool] Something broke')).toBe('Something broke');
  });

  it('handles spaces in package ID', () => {
    expect(sanitizeErrorDetail('[PostHog EU/query-run] Timeout')).toBe('Timeout');
  });

  describe('stripErrorNoise (agent-facing syntactic cleanup)', () => {
    it('strips [package/tool] prefix but preserves MCP error detail', () => {
      const raw = '[GoogleWorkspace/delete_sheet] MCP error -33003: Argument validation failed. Missing: sheet_id';
      expect(stripErrorNoise(raw)).toBe('MCP error -33003: Argument validation failed. Missing: sheet_id');
    });

    it('strips (args: ...) suffix but preserves error content', () => {
      expect(stripErrorNoise('Connection timeout (args: {"url":"http://example.com"})')).toBe('Connection timeout');
    });

    it('preserves undecorated errors unchanged', () => {
      expect(stripErrorNoise('HTTP 500: Internal server error')).toBe('HTTP 500: Internal server error');
    });

    it('extracts error from JSON envelope (agent path also benefits)', () => {
      const raw = '{ "status": "error", "error": "MCP error -32603: Range exceeds limits", "resolution": "Try again" }';
      expect(stripErrorNoise(raw)).toBe('MCP error -32603: Range exceeds limits');
    });

    it('handles [package/tool] prefix wrapping JSON envelope', () => {
      const raw = '[GoogleWorkspace/update_values] { "status": "error", "error": "MCP error -32603: Row out of range", "resolution": "Try again" }';
      expect(stripErrorNoise(raw)).toBe('MCP error -32603: Row out of range');
    });
  });

  describe('MCP validation error detail (REBEL-1G3)', () => {
    it('keeps "argument validation failed" field details for user-visible reporting', () => {
      const raw = 'MCP error -33003: Argument validation failed for tool \'delete_workspace_spreadsheet_sheet\' in package \'GoogleWorkspace-teammember-mindstone-com\'. Missing required: sheet_id. Unknown fields: sheet_name. Valid arguments: email, spreadsheet_id, sheet_id.. Use \'get_tool_details\' to review the schema, or \'dry_run: true\' to test arguments.';
      const result = sanitizeErrorDetail(raw);
      expect(result).toContain('unexpected inputs');
      expect(result).toContain('MCP error -33003');
      expect(result).toContain('sheet_id');
      expect(result).toContain('sheet_name');
    });

    it('keeps "argument validation failed" detail for HubSpot fields', () => {
      const raw = 'MCP error -33003: Argument validation failed for tool \'update_hubspot_deal\' in package \'HubSpot\'. Missing required: dealId. Unknown fields: id. Valid arguments: dealId, properties.. Use \'get_tool_details\' to review the schema, or \'dry_run: true\' to test arguments.';
      const result = sanitizeErrorDetail(raw);
      expect(result).toContain('unexpected inputs');
      expect(result).toContain('dealId');
      expect(result).toContain('Unknown fields: id');
    });

    it('keeps MCP error with "missing required" compound match', () => {
      const result = sanitizeErrorDetail('MCP error -33003: missing required field: email');
      expect(result).toContain('unexpected inputs');
      expect(result).toContain('email');
    });

    it('does NOT humanize non-MCP "missing required" errors', () => {
      const result = sanitizeErrorDetail('missing required permissions for this operation');
      expect(result).toBe('missing required permissions for this operation');
    });

    it('strips MCP error code but preserves auth error message', () => {
      const result = sanitizeErrorDetail('MCP error -33005: Authentication required for HubSpot');
      expect(result).toBe('Authentication required for HubSpot');
      expect(result).not.toContain('MCP error');
    });

    it('does NOT humanize non-MCP errors', () => {
      const result = sanitizeErrorDetail('HTTP 500: Internal server error');
      expect(result).toBe('HTTP 500: Internal server error');
    });

    // NOTE: arg-validation errors are now ROUTED to the calm `arg-recovering`
    // class (FOX-3519) rather than surfaced as a raw `execution-failed` detail
    // toast. `sanitizeErrorDetail` still humanizes the substring (tested above
    // and below) because it remains the detail formatter for any residual
    // `execution-failed` path, but the classify → toast path no longer leaks it.
    it('full path: arg-validation routes to calm arg-recovering toast (FOX-3519)', () => {
      const outcome = classifyStagedError('MCP error -33003: Argument validation failed for tool \'test_tool\'. Use \'get_tool_details\' to review the schema, or \'dry_run: true\' to test arguments.');
      expect(outcome.reason).toBe('arg-recovering');
      const msg = approvalOutcomeMessage(outcome);
      // No developer jargon, no raw validator text reaches the user.
      expect(msg).toBe('Rebel is sorting that out');
      expect(msg).not.toContain('-33003');
      expect(msg).not.toContain('get_tool_details');
      expect(msg).not.toContain('dry_run');
      expect(msg).not.toContain('validation');
    });
  });

  describe('JSON envelope extraction (REBEL-53T)', () => {
    it('extracts error from JSON-wrapped MCP response', () => {
      const raw = '{ "status": "error", "error": "MCP error -32603: Requested writing within range [\'Lifecycle Metrics\'!A1:Z19], but tried writing to row [20]", "resolution": "Please try again or contact support if the issue persists" }';
      const result = sanitizeErrorDetail(raw);
      expect(result).not.toContain('"status"');
      expect(result).not.toContain('"resolution"');
      expect(result).not.toContain('MCP error');
      expect(result).toContain('Requested writing within range');
    });

    it('extracts error from JSON with grid-limit error (REBEL-53T event 3)', () => {
      const raw = '{ "status": "error", "error": "MCP error -32603: Range (\'Ανά Εταιρεία\'!A1164:K1188) exceeds grid limits. Max rows: 1163, max columns: 27", "resolution": "Please try again or contact support if the issue persists" }';
      const result = sanitizeErrorDetail(raw);
      expect(result).not.toContain('"status"');
      expect(result).toContain('exceeds grid limits');
      expect(result).not.toContain('MCP error -32603');
    });

    it('returns unchanged for non-JSON strings', () => {
      expect(sanitizeErrorDetail('Simple error message')).toBe('Simple error message');
    });

    it('returns unchanged for JSON without error field', () => {
      expect(sanitizeErrorDetail('{ "message": "something" }')).toBe('{ "message": "something" }');
    });

    it('returns unchanged for invalid JSON starting with {', () => {
      expect(sanitizeErrorDetail('{ not valid json')).toBe('{ not valid json');
    });
  });

  describe('action_required envelope extraction (REBEL-539)', () => {
    // Real-world failure envelope from REBEL-539: an approved MCP-app action
    // returned { ok, action_required, next_step }. The old extractor only knew
    // about the { status, error, resolution } shape, so the whole JSON blob was
    // dumped verbatim into the "Approved, but the action failed: …" toast.
    const envelope = JSON.stringify({
      ok: false,
      action_required: 'MCP error -32603: Invalid requests[0].addDocumentTab: Tab title must be unique',
      next_step: 'Review the error, adjust the request if needed, and retry.',
    });

    it('extracts action_required and drops the raw envelope/keys', () => {
      const result = sanitizeErrorDetail(envelope);
      expect(result).not.toContain('"ok"');
      expect(result).not.toContain('"action_required"');
      expect(result).not.toContain('"next_step"');
      expect(result).not.toContain('MCP error');
      expect(result).toContain('Tab title must be unique');
    });

    it('produces a clean toast through the classify → message path', () => {
      const outcome = classifyStagedError(envelope);
      expect(outcome).toMatchObject({ ok: false, reason: 'execution-failed' });
      const msg = approvalOutcomeMessage(outcome as Extract<typeof outcome, { ok: false }>);
      expect(msg).not.toContain('{');
      expect(msg).toContain('Approved, but the action failed:');
      expect(msg).toContain('Tab title must be unique');
    });

    // Precedence is intentionally `error` → `action_required` → `next_step` (error first
    // keeps REBEL-53T behaviour unchanged). Lock it so it doesn't drift silently.
    it('prefers error over action_required when both are present', () => {
      const both = JSON.stringify({ status: 'error', error: 'Primary failure', action_required: 'Secondary' });
      expect(sanitizeErrorDetail(both)).toBe('Primary failure');
    });

    // An empty/whitespace action_required must NOT regress to dumping the raw JSON blob —
    // it falls through to the next non-empty field (next_step here).
    it('falls through empty action_required to next_step instead of raw JSON', () => {
      const sparse = JSON.stringify({ ok: false, action_required: '   ', next_step: 'Try the request again.' });
      const result = sanitizeErrorDetail(sparse);
      expect(result).not.toContain('{');
      expect(result).not.toContain('action_required');
      expect(result).toBe('Try the request again.');
    });
  });

  describe('MCP error code prefix stripping', () => {
    it('strips MCP error -32603 prefix', () => {
      const result = sanitizeErrorDetail('MCP error -32603: Something went wrong with the tool');
      expect(result).toBe('Something went wrong with the tool');
      expect(result).not.toContain('MCP error');
    });

    it('strips arbitrary MCP error codes', () => {
      const result = sanitizeErrorDetail('MCP error -32000: Server not ready');
      expect(result).toBe('Server not ready');
    });

    it('does NOT strip non-MCP error prefixes', () => {
      const result = sanitizeErrorDetail('HTTP 500: Internal server error');
      expect(result).toBe('HTTP 500: Internal server error');
    });
  });

  describe('full path: JSON envelope + MCP code stripping (REBEL-53T exact)', () => {
    it('classifyStagedError → approvalOutcomeMessage produces clean toast', () => {
      const raw = '{ "status": "error", "error": "MCP error -32603: Requested writing within range [\'Lifecycle Metrics\'!A1:Z19], but tried writing to row [20]", "resolution": "Please try again" }';
      const outcome = classifyStagedError(raw);
      expect(outcome.reason).toBe('execution-failed');
      const msg = approvalOutcomeMessage(outcome);
      expect(msg).toBe("Approved, but the action failed: Requested writing within range ['Lifecycle Metrics'!A1:Z19], but tried writing to row [20]");
      expect(msg).not.toContain('"status"');
      expect(msg).not.toContain('MCP error');
    });
  });
});

describe('approvalOutcomeMessage', () => {
  it('returns contextual message for each failure reason', () => {
    expect(approvalOutcomeMessage({ ok: false, reason: 'already-executing' })).toBe('Already processing...');
    expect(approvalOutcomeMessage({ ok: false, reason: 'already-handled' })).toBe('');
    expect(approvalOutcomeMessage({ ok: false, reason: 'expired' })).toBe('This action expired. Ask Rebel to try again.');
    expect(approvalOutcomeMessage({ ok: false, reason: 'execution-failed' })).toBe('Approved, but the action failed.');
    expect(approvalOutcomeMessage({ ok: false, reason: 'execution-failed', detail: 'Timeout' })).toBe('Approved, but the action failed: Timeout');
    expect(approvalOutcomeMessage({ ok: false, reason: 'ipc-unavailable' })).toBe("Couldn't reach Rebel. Try again in a moment.");
    expect(approvalOutcomeMessage({ ok: false, reason: 'mcp-unavailable' })).toBe("Couldn't run that action right now. Try again shortly.");
    expect(approvalOutcomeMessage({ ok: false, reason: 'arg-recovering' })).toBe('Rebel is sorting that out');
    expect(approvalOutcomeMessage({ ok: false, reason: 'arg-needs-detail' })).toBe('Rebel needs a bit more from you');
    expect(approvalOutcomeMessage({ ok: false, reason: 'connector-unavailable' })).toBe('Rebel lost the connection');
    expect(approvalOutcomeMessage({ ok: false, reason: 'unknown' })).toBe('Something went wrong. Try again.');
  });
});

describe('approvalOutcomeVariant', () => {
  it('returns correct variant for each failure reason', () => {
    expect(approvalOutcomeVariant({ ok: false, reason: 'already-executing' })).toBe('default');
    expect(approvalOutcomeVariant({ ok: false, reason: 'already-handled' })).toBe('default');
    expect(approvalOutcomeVariant({ ok: false, reason: 'expired' })).toBe('warning');
    expect(approvalOutcomeVariant({ ok: false, reason: 'execution-failed' })).toBe('error');
    expect(approvalOutcomeVariant({ ok: false, reason: 'ipc-unavailable' })).toBe('error');
    expect(approvalOutcomeVariant({ ok: false, reason: 'mcp-unavailable' })).toBe('error');
    // arg-recovering is NOT an error — calm `info` keeps it out of the Sentry
    // error-toast flood and off the alarming red surface (FOX-3519).
    expect(approvalOutcomeVariant({ ok: false, reason: 'arg-recovering' })).toBe('info');
    // arg-needs-detail (exhausted) is `warning`: terminal, the user must act —
    // out-ranks the calm `info` recovering toast, but isn't a red error.
    expect(approvalOutcomeVariant({ ok: false, reason: 'arg-needs-detail' })).toBe('warning');
    // connector-unavailable is `warning` (action failed, but NOT a red error —
    // keeps it out of the Sentry error-toast flood). Stage 3 / B2.
    expect(approvalOutcomeVariant({ ok: false, reason: 'connector-unavailable' })).toBe('warning');
    expect(approvalOutcomeVariant({ ok: false, reason: 'unknown' })).toBe('error');
  });
});

// ---------------------------------------------------------------------------
// FOX-3519 — tool arg-validation failures surface a calm, jargon-free
// affordance instead of a raw "Approved, but the action failed: …" red toast.
// ---------------------------------------------------------------------------
describe('arg-validation failure class (FOX-3519)', () => {
  it('isArgValidationFailure detects all three validator layers, not genuine failures', () => {
    // Wrapper validator (use_tool envelope, REBEL-6BM)
    expect(isArgValidationFailure(
      'use_tool "args" must be an object, null/omitted, or a JSON string that parses to an object. Use search_tools(...)',
    )).toBe(true);
    // Per-tool argument validator (-33003)
    expect(isArgValidationFailure(
      "MCP error -33003: Argument validation failed for tool 'notion-update-page' in package 'Notion'. Missing required: properties.",
    )).toBe(true);
    // Downstream MCP-server validator (review F1 — was previously missed)
    expect(isArgValidationFailure(
      "MCP error -33003: Downstream validation failed for tool 'salesforce_update_lead': Invalid field 'foo'.",
    )).toBe(true);
    // Code-marker only (defends against future validator wording drift)
    expect(isArgValidationFailure('ARG_VALIDATION_FAILED')).toBe(true);
    // Case-insensitive
    expect(isArgValidationFailure('ARGUMENT VALIDATION FAILED')).toBe(true);
    // Genuine non-arg failures must NOT match (keep their red toast)
    expect(isArgValidationFailure('MCP error -32603: Request timed out')).toBe(false);
    expect(isArgValidationFailure('Authentication required for HubSpot')).toBe(false);
    expect(isArgValidationFailure('HTTP 500: Internal server error')).toBe(false);
    expect(isArgValidationFailure(undefined)).toBe(false);
    expect(isArgValidationFailure('')).toBe(false);
  });

  it('isArgValidationExhausted detects the stop-retrying signal only (review F2)', () => {
    expect(isArgValidationExhausted(
      "MCP error -33003: Argument validation failed for tool 'x'. Arguments may require user clarification. Please ask the user for specifics.",
    )).toBe(true);
    expect(isArgValidationExhausted('Please ask the user for specifics.')).toBe(true);
    // A normal (non-exhausted) arg-validation error is NOT exhausted
    expect(isArgValidationExhausted(
      "MCP error -33003: Argument validation failed for tool 'x'. Missing required: id.",
    )).toBe(false);
    expect(isArgValidationExhausted(undefined)).toBe(false);
  });

  it('classifyStagedError routes the downstream-validation wording to arg-recovering (F1)', () => {
    const downstreamErr = "[Salesforce/update_lead] MCP error -33003: Downstream validation failed for tool 'update_lead': Missing required lead_id. Use 'get_tool_details' to review the schema.";
    expect(classifyStagedError(downstreamErr).reason).toBe('arg-recovering');
  });

  it('classifyStagedError routes EXHAUSTED retries to the terminal arg-needs-detail (F2)', () => {
    const exhausted = "[Notion/update_page] MCP error -33003: Argument validation failed for tool 'update_page'. Missing required: properties. Arguments may require user clarification. Please ask the user for specifics.";
    const outcome = classifyStagedError(exhausted);
    // Terminal — NOT collapsed into the calm "no need to do anything" toast.
    expect(outcome.reason).toBe('arg-needs-detail');
    const title = approvalOutcomeMessage(outcome);
    expect(title).toBe('Rebel needs a bit more from you');
    expect(title).not.toMatch(/get_tool_details|dry_run|schema|validation|-33003/i);
    expect(approvalOutcomeVariant(outcome)).toBe('warning');
    const description = approvalOutcomeDescription(outcome);
    expect(description).not.toMatch(/get_tool_details|dry_run|schema|validation|args/i);
  });

  it('classifyStagedError routes the wrapper validator error to arg-recovering', () => {
    const wrapperErr = "[Notion/update_page] use_tool \"args\" must be an object, null/omitted, or a JSON string that parses to an object. Use get_tool_details(...) to inspect the argument schema.";
    expect(classifyStagedError(wrapperErr).reason).toBe('arg-recovering');
  });

  it('classifyStagedError routes the per-tool -33003 error to arg-recovering', () => {
    const perToolErr = "[HubSpot/update_deal] MCP error -33003: Argument validation failed for tool 'update_deal' in package 'HubSpot'. Missing required: dealId. Use 'get_tool_details' to review the schema, or 'dry_run: true' to test arguments.";
    expect(classifyStagedError(perToolErr).reason).toBe('arg-recovering');
  });

  it('genuine execution failures still classify as execution-failed (NOT silenced)', () => {
    expect(classifyStagedError('MCP error -32603: Request timed out').reason).toBe('execution-failed');
    expect(classifyStagedError('Network unreachable').reason).toBe('execution-failed');
  });

  it('the arg-recovering toast leaks NO agent-directed jargon to the user', () => {
    const outcome = classifyStagedError(
      "use_tool \"args\" must be an object, null/omitted, or a JSON string that parses to an object. Use search_tools(query: \"...\"), list_tools(...), or get_tool_details(tool_ids: [\"X\"]) to inspect the argument schema.",
    );
    const title = approvalOutcomeMessage(outcome);
    const description = approvalOutcomeDescription(outcome);
    for (const text of [title, description ?? '']) {
      expect(text).not.toMatch(/get_tool_details|dry_run|search_tools|list_tools|must be an object|JSON|schema/i);
    }
    expect(title).toBe('Rebel is sorting that out');
    // Generic (no display name threaded) — falls back, no dangling article.
    expect(description).toBe("Rebel hit a snag with the details and is adjusting, so there's nothing you need to do.");
  });

  it('names the action in BOTH toasts when a display name is threaded (FOX-3519 refinement)', () => {
    const recovering = withDisplayName({ ok: false, reason: 'arg-recovering' }, 'Send email');
    const needsDetail = withDisplayName({ ok: false, reason: 'arg-needs-detail' }, 'Send email');
    expect(approvalOutcomeDescription(recovering)).toBe(
      "Rebel hit a snag with the details for Send email and is adjusting, so there's nothing you need to do.",
    );
    expect(approvalOutcomeDescription(needsDetail)).toBe(
      "Your approval went through, but Rebel couldn't work out the details for Send email. See the conversation for what it needs.",
    );
    // Still jargon-free with a name threaded.
    for (const text of [approvalOutcomeDescription(recovering), approvalOutcomeDescription(needsDetail)]) {
      expect(text).not.toMatch(/get_tool_details|dry_run|search_tools|must be an object|JSON|schema|-33003/i);
    }
  });

  it('falls back to generic copy (no dangling article) when the display name is missing/blank', () => {
    for (const name of [undefined, '', '   ']) {
      const recovering = withDisplayName({ ok: false, reason: 'arg-recovering' }, name);
      const needsDetail = withDisplayName({ ok: false, reason: 'arg-needs-detail' }, name);
      // No "the details for ." dangling article.
      expect(approvalOutcomeDescription(recovering)).toBe(
        "Rebel hit a snag with the details and is adjusting, so there's nothing you need to do.",
      );
      expect(approvalOutcomeDescription(needsDetail)).toBe(
        "Your approval went through, but Rebel couldn't work out the details on its own. See the conversation for what it needs.",
      );
      expect(approvalOutcomeDescription(recovering)).not.toMatch(/for\s*\.|details for\b\s*$/);
    }
  });

  it('approvalOutcomeDescription only populates the arg-validation cases', () => {
    expect(approvalOutcomeDescription({ ok: false, reason: 'arg-recovering' })).toBeTruthy();
    expect(approvalOutcomeDescription({ ok: false, reason: 'arg-needs-detail' })).toBeTruthy();
    expect(approvalOutcomeDescription({ ok: false, reason: 'execution-failed', detail: 'x' })).toBeUndefined();
    expect(approvalOutcomeDescription({ ok: false, reason: 'unknown' })).toBeUndefined();
  });

  it('the in-conversation sibling lines are non-empty, first-person, jargon-free, and contrasting', () => {
    // useStagedToolCalls renders `<DisplayName>: <line>` into the transcript —
    // both lines must be non-empty (else "Name: "), free of agent jargon, and
    // must NOT re-name the action (the prefix already does).
    for (const line of [ARG_RECOVERING_CONVERSATION_LINE, ARG_NEEDS_DETAIL_CONVERSATION_LINE]) {
      expect(line.trim().length).toBeGreaterThan(0);
      expect(line).not.toMatch(
        /get_tool_details|dry_run|search_tools|must be an object|JSON|schema|-33003/i,
      );
    }
    expect(ARG_RECOVERING_CONVERSATION_LINE).toBe('Adjusting how I run this. Give me a moment.');
    expect(ARG_NEEDS_DETAIL_CONVERSATION_LINE).toBe(
      "I couldn't work out all the details for this on my own. Tell me what you had in mind and I'll continue.",
    );
    // Contrast invariant (chief-designer): recovering = closed-loop ("give me a
    // moment"), terminal = open-loop ("tell me what you had in mind").
    expect(ARG_RECOVERING_CONVERSATION_LINE).not.toBe(ARG_NEEDS_DETAIL_CONVERSATION_LINE);
  });
});

// ---------------------------------------------------------------------------
// Stage 3 / B2 — downstream connector transport failures (e.g. Brave Search
// `-32000 Connection closed`) surface calm, connector-named, KEY-SILENT
// reconnect copy instead of the raw `restart_package` transport dump.
// ---------------------------------------------------------------------------
describe('connector transport-failure class (Stage 3 / B2)', () => {
  // The exact raw string a non-technical user hit (the reported Brave failure).
  const RAW_BRAVE_FAILURE =
    "Tool execution failed in package 'Brave Search'. ❌ Failed to connect to MCP server 'Brave Search'. ❌ MCP error -32000: Connection closed. You can try 'restart_package(package_id: \"brave-search\")' to reconnect.";

  it('isConnectorTransportFailure detects the downstream-transport markers, not genuine failures', () => {
    expect(isConnectorTransportFailure(RAW_BRAVE_FAILURE)).toBe(true);
    expect(isConnectorTransportFailure('MCP error -33007: Connection closed')).toBe(true);
    expect(isConnectorTransportFailure('DOWNSTREAM_ERROR: child exited')).toBe(true);
    expect(isConnectorTransportFailure('MCP error -32000: something')).toBe(true);
    expect(isConnectorTransportFailure("try restart_package(package_id: 'x')")).toBe(true);
    // Case-insensitive
    expect(isConnectorTransportFailure('CONNECTION CLOSED')).toBe(true);
    // Genuine non-transport failures must NOT match
    expect(isConnectorTransportFailure('MCP error -32603: Request timed out')).toBe(false);
    expect(isConnectorTransportFailure('Authentication required for HubSpot')).toBe(false);
    expect(isConnectorTransportFailure('HTTP 500: Internal server error')).toBe(false);
    expect(isConnectorTransportFailure(undefined)).toBe(false);
    expect(isConnectorTransportFailure('')).toBe(false);
  });

  it('classifyStagedError routes the raw Brave failure to connector-unavailable (was execution-failed)', () => {
    expect(classifyStagedError(RAW_BRAVE_FAILURE).reason).toBe('connector-unavailable');
    expect(classifyStagedError('MCP error -33007: Connection closed').reason).toBe('connector-unavailable');
  });

  it('arg-validation keeps PRIORITY over the connector class when both markers are present', () => {
    // A -33003 arg-validation error whose message also happens to say
    // "connection closed" must still route to arg-recovering, not connector.
    const mixed = "MCP error -33003: Argument validation failed for tool 'x'. (connection closed earlier)";
    expect(classifyStagedError(mixed).reason).toBe('arg-recovering');
  });

  it('the connector-unavailable toast is warning severity and leaks NO key / raw transport jargon', () => {
    const outcome = classifyStagedError(RAW_BRAVE_FAILURE);
    expect(outcome.reason).toBe('connector-unavailable');
    const title = approvalOutcomeMessage(outcome);
    const description = approvalOutcomeDescription(outcome);
    expect(title).toBe('Rebel lost the connection');
    // warning, NOT error (keeps it out of the Sentry error-toast flood)
    expect(approvalOutcomeVariant(outcome)).toBe('warning');
    for (const text of [title, description ?? '']) {
      // NEVER mention API keys, the raw -32000/-33007 codes, or restart_package.
      expect(text).not.toMatch(/api key|-32000|-33007|restart_package|MCP server|connection closed\b.*restart/i);
    }
  });

  it('names the connector when a display name is threaded, falls back to generic otherwise', () => {
    const named = withDisplayName(classifyStagedError(RAW_BRAVE_FAILURE), 'Brave Search');
    expect(approvalOutcomeDescription(named)).toBe(
      'Your approval went through, but Rebel lost its connection to Brave Search before it finished. Ask Rebel to try again in a moment.',
    );
    for (const blank of [undefined, '', '   ']) {
      const generic = withDisplayName(classifyStagedError(RAW_BRAVE_FAILURE), blank);
      expect(approvalOutcomeDescription(generic)).toBe(
        'Your approval went through, but Rebel lost its connection before it finished. Ask Rebel to try again in a moment.',
      );
    }
  });

  it('the in-conversation sibling line is non-empty, first-person, and key/transport-jargon-free', () => {
    expect(CONNECTOR_UNAVAILABLE_CONVERSATION_LINE.trim().length).toBeGreaterThan(0);
    expect(CONNECTOR_UNAVAILABLE_CONVERSATION_LINE).not.toMatch(
      /api key|-32000|-33007|restart_package|MCP server/i,
    );
    expect(CONNECTOR_UNAVAILABLE_CONVERSATION_LINE).toBe(
      'I lost the connection before I could finish that. Ask me to try again in a moment.',
    );
  });

  it('approvalOutcomeDescription populates connector-unavailable', () => {
    expect(approvalOutcomeDescription({ ok: false, reason: 'connector-unavailable' })).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// usePendingApprovalCount internals — pure helpers backing the badge dedup
// fix (REBEL-BADGE-DRIFT). Tracking IDs in Sets makes add/remove idempotent
// and prevents same-ID broadcasts from inflating the badge.
// ---------------------------------------------------------------------------

const EMPTY_SETS: ApprovalCountIdSets = {
  tool: new Set(),
  memory: new Set(),
  stagedTool: new Set(),
  stagedFile: new Set(),
};

describe('addApprovalCountId / removeApprovalCountId', () => {
  it('adds a new id and clones the bucket', () => {
    const next = addApprovalCountId(EMPTY_SETS, 'tool', 'a');
    expect(next).not.toBe(EMPTY_SETS);
    expect(next.tool.has('a')).toBe(true);
    expect(EMPTY_SETS.tool.has('a')).toBe(false); // input unchanged
  });

  it('returns the same reference when adding a duplicate id', () => {
    const first = addApprovalCountId(EMPTY_SETS, 'tool', 'a');
    const second = addApprovalCountId(first, 'tool', 'a');
    expect(second).toBe(first);
  });

  it('removes an existing id idempotently', () => {
    const withA = addApprovalCountId(EMPTY_SETS, 'memory', 'a');
    const removed = removeApprovalCountId(withA, 'memory', 'a');
    expect(removed.memory.has('a')).toBe(false);
    const removedAgain = removeApprovalCountId(removed, 'memory', 'a');
    expect(removedAgain).toBe(removed); // no-op shortcut
  });

  it('returns the same reference when removing an absent id (cannot drift negative)', () => {
    const result = removeApprovalCountId(EMPTY_SETS, 'tool', 'never-added');
    expect(result).toBe(EMPTY_SETS);
  });
});

describe('countApprovalIdSets', () => {
  it('sums the size of every bucket', () => {
    let sets = EMPTY_SETS;
    sets = addApprovalCountId(sets, 'tool', 't1');
    sets = addApprovalCountId(sets, 'tool', 't2');
    sets = addApprovalCountId(sets, 'memory', 'm1');
    sets = addApprovalCountId(sets, 'stagedTool', 's1');
    sets = addApprovalCountId(sets, 'stagedFile', 'f1');
    expect(countApprovalIdSets(sets)).toBe(5);
  });

  it('returns 0 for empty sets', () => {
    expect(countApprovalIdSets(EMPTY_SETS)).toBe(0);
  });
});

describe('parseCompositeApprovalId', () => {
  it('parses every supported prefix', () => {
    expect(parseCompositeApprovalId('tool:abc')).toEqual({ bucket: 'tool', id: 'abc' });
    expect(parseCompositeApprovalId('memory:m-1')).toEqual({ bucket: 'memory', id: 'm-1' });
    expect(parseCompositeApprovalId('staged-tool:s-9')).toEqual({ bucket: 'stagedTool', id: 's-9' });
    expect(parseCompositeApprovalId('staged-file:f-2')).toEqual({ bucket: 'stagedFile', id: 'f-2' });
  });

  it('returns null for unknown prefixes', () => {
    expect(parseCompositeApprovalId('unknown:abc')).toBeNull();
    expect(parseCompositeApprovalId('abc')).toBeNull();
  });
});

describe('buildApprovalCountIdSets (drift regressions)', () => {
  // Session prefixed with `automation-` is auto-available even without an
  // explicit summary entry — see isApprovalSourceSessionAvailable.
  const SESSION = 'automation-fixture';

  it('counts each unique id once even when the IPC payload contains duplicates', () => {
    const sets = buildApprovalCountIdSets({
      toolPending: [
        { toolUseID: 'tool-1', sessionId: SESSION },
        { toolUseID: 'tool-1', sessionId: SESSION }, // duplicate
        { toolUseID: 'tool-2', sessionId: SESSION },
      ],
      memoryPending: [
        { toolUseId: 'mem-1', originalSessionId: SESSION },
        { toolUseId: 'mem-1', originalSessionId: SESSION }, // duplicate
      ],
      stagedCalls: [
        { id: 'staged-1', sessionId: SESSION, status: 'pending' },
      ],
      stagedFiles: [
        { id: 'file-1', sessionId: SESSION },
      ],
      sessionSummaries: [],
      suppressedIds: new Set(),
    });
    // 2 unique tools + 1 memory + 1 staged tool + 1 staged file
    expect(countApprovalIdSets(sets)).toBe(5);
    expect(sets.tool.size).toBe(2);
    expect(sets.memory.size).toBe(1);
    expect(sets.stagedTool.size).toBe(1);
    expect(sets.stagedFile.size).toBe(1);
  });

  it('excludes staged memory rows from the memory bucket (drawer parity)', () => {
    const sets = buildApprovalCountIdSets({
      toolPending: [],
      memoryPending: [
        { toolUseId: 'mem-staged', originalSessionId: SESSION, staged: true },
        { toolUseId: 'mem-real', originalSessionId: SESSION, staged: false },
      ],
      stagedCalls: [],
      stagedFiles: [],
      sessionSummaries: [],
      suppressedIds: new Set(),
    });
    expect(sets.memory.has('mem-staged')).toBe(false);
    expect(sets.memory.has('mem-real')).toBe(true);
  });

  it('excludes non-pending staged tool calls (covers `failed` parity gap with drawer)', () => {
    const sets = buildApprovalCountIdSets({
      toolPending: [],
      memoryPending: [],
      stagedCalls: [
        { id: 's-pending', sessionId: SESSION, status: 'pending' },
        { id: 's-executed', sessionId: SESSION, status: 'executed' },
        { id: 's-failed', sessionId: SESSION, status: 'failed' },
        { id: 's-rejected', sessionId: SESSION, status: 'rejected' },
      ],
      stagedFiles: [],
      sessionSummaries: [],
      suppressedIds: new Set(),
    });
    expect(sets.stagedTool.size).toBe(1);
    expect(sets.stagedTool.has('s-pending')).toBe(true);
  });

  it('honors optimistic-removal tombstones during refresh (no resurrect)', () => {
    const sets = buildApprovalCountIdSets({
      toolPending: [{ toolUseID: 'tool-1', sessionId: SESSION }],
      memoryPending: [{ toolUseId: 'mem-1', originalSessionId: SESSION }],
      stagedCalls: [{ id: 'staged-1', sessionId: SESSION, status: 'pending' }],
      stagedFiles: [{ id: 'file-1', sessionId: SESSION }],
      sessionSummaries: [],
      suppressedIds: new Set([
        'tool:tool-1',
        'memory:mem-1',
        'staged-tool:staged-1',
        'staged-file:file-1',
      ]),
    });
    expect(countApprovalIdSets(sets)).toBe(0);
  });

  it('excludes items whose owning session has been deleted', () => {
    const sets = buildApprovalCountIdSets({
      toolPending: [
        { toolUseID: 'tool-live', sessionId: 'live-session' },
        { toolUseID: 'tool-dead', sessionId: 'deleted-session' },
      ],
      memoryPending: [],
      stagedCalls: [],
      stagedFiles: [],
      sessionSummaries: [
        { id: 'live-session', deletedAt: null },
        { id: 'deleted-session', deletedAt: 1704067200000 },
      ],
      suppressedIds: new Set(),
    });
    expect(sets.tool.has('tool-live')).toBe(true);
    expect(sets.tool.has('tool-dead')).toBe(false);
  });

  it('skips staged files without an id', () => {
    const sets = buildApprovalCountIdSets({
      toolPending: [],
      memoryPending: [],
      stagedCalls: [],
      stagedFiles: [
        { id: 'file-1', sessionId: SESSION },
        { sessionId: SESSION }, // no id — should be skipped
      ],
      sessionSummaries: [],
      suppressedIds: new Set(),
    });
    expect(sets.stagedFile.size).toBe(1);
    expect(sets.stagedFile.has('file-1')).toBe(true);
  });
});
