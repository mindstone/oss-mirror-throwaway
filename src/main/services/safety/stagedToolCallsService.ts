/**
 * Staged Tool Calls Service
 *
 * Manages tool calls that require user approval before execution.
 * Mirrors the memory staging pattern (cosPendingService) but for MCP tool calls.
 *
 * Flow:
 * 1. Tool call intercepted by PreToolUse hook
 * 2. If approval needed, call is staged (stored) instead of denied
 * 3. Agent receives "staged" message and continues
 * 4. User approves via UI (Inbox or conversation)
 * 5. This service executes the tool directly via MCP client
 * 6. Result is delivered via continuation message
 */

import crypto from 'node:crypto';
import { createStore } from '@core/storeFactory';
import type { KeyValueStore } from '@core/store';
import { isUserDataReadOnly } from '@core/userDataWriteGate';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createScopedLogger } from '@core/logger';
import { summarizeStagedExecutionResult } from '@shared/utils/stagedExecutionSummary';
import { backfillToolBlockSource, isSideEffectVerb, type ToolBlockSource } from '@rebel/shared';
import { ignoreBestEffortCleanup } from '@shared/utils/intentionalSwallow';
import { superMcpHttpManager } from '../superMcpHttpManager';

const log = createScopedLogger({ service: 'stagedToolCalls' });

// In-memory lock to prevent double execution of the same staged call.
// Protects against batch-vs-manual conflicts and future async refactors.
const executingIds = new Set<string>();

// Staged approvals are actionable runtime state: if userData is read-only
// because this app version is older than the last writer, disk persistence is
// intentionally blocked, but the user still needs to approve/reject the action
// in the current session. Keep a main-process overlay so every IPC surface sees
// the same pending approvals even when the backing store cannot be written.
const runtimeStagedCalls = new Map<string, StagedToolCall>();
const runtimeSuppressedStagedCallIds = new Set<string>();



// 24 hours in milliseconds
const STAGED_CALL_TTL_MS = 24 * 60 * 60 * 1000;

// Terminal-state calls (executed, rejected, failed) older than this are removed.
const TERMINAL_STATE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// MCP client info for direct tool execution
const MCP_CLIENT_INFO = {
  name: 'rebel-staged-execution',
  version: '1.0.0',
};

/**
 * Status of a staged tool call.
 * - pending: Awaiting user approval
 * - executing: Currently being executed
 * - executed: Successfully executed
 * - failed: Execution failed (requires re-staging)
 * - rejected: User rejected (won't execute)
 * - expired: TTL exceeded (auto-cleaned)
 */
export type StagedCallStatus = 'pending' | 'executing' | 'executed' | 'failed' | 'rejected' | 'expired';

/**
 * Tool category for determining result delivery strategy.
 * - side-effect: Tool has external effects (send email, create issue)
 * - read-only: Tool only reads data (list calendar, search files)
 */
export type ToolCategory = 'side-effect' | 'read-only';

/**
 * The exact payload needed to execute a tool via MCP.
 * This is what gets passed to client.callTool().
 */
export interface McpExecutionPayload {
  packageId: string;
  toolId: string;
  args: Record<string, unknown>;
}

/**
 * Result of a staged tool execution.
 */
export interface StagedCallResult {
  success: boolean;
  content?: string;
  error?: string;
  executedAt: number;
}

/**
 * A staged tool call awaiting approval.
 */
export interface StagedToolCall {
  id: string;
  sessionId: string;
  turnId: string;
  timestamp: number;
  expiresAt: number;
  status: StagedCallStatus;

  // MCP execution payload - the exact data needed to execute
  mcpPayload: McpExecutionPayload;

  // Display metadata
  displayName: string;
  toolCategory: ToolCategory;
  riskLevel?: 'low' | 'medium' | 'high';
  reason?: string;
  allowPermanentTrust?: boolean;
  /** Block source — 'safety_prompt' for principled blocks, 'eval_error' for evaluator unavailable. */
  blockedBy?: ToolBlockSource;
  /**
   * Optional first-wins coalesce key. When present, pending calls with the same
   * (sessionId, coalesceKey) are returned unchanged instead of replacing the
   * executable payload.
   */
  coalesceKey?: string;

  // Automation context (set when staged from an automation access-rules block)
  automationId?: string;
  automationName?: string;

  // Result (populated after execution)
  result?: StagedCallResult;
}

/**
 * Input for staging a new tool call.
 */
export interface StageToolCallInput {
  sessionId: string;
  turnId: string;
  mcpPayload: McpExecutionPayload;
  displayName: string;
  toolCategory: ToolCategory;
  riskLevel?: 'low' | 'medium' | 'high';
  reason?: string;
  allowPermanentTrust?: boolean;
  /** Block source — 'safety_prompt' for principled blocks, 'eval_error' for evaluator unavailable. */
  blockedBy: ToolBlockSource;
  coalesceKey?: string;
  automationId?: string;
  automationName?: string;
}

export interface StageToolCallResult {
  call: StagedToolCall;
  /** True when an existing pending call was returned without modification. */
  coalesced: boolean;
}

/**
 * Result of batch execution.
 */
export interface BatchExecutionResult {
  executed: Array<{ id: string; result: StagedCallResult }>;
}

type StagedToolCallsStoreShape = {
  version: number;
  stagedCalls: StagedToolCall[];
}

/**
 * Sentinel error message returned when a staged call ID doesn't exist in the store.
 * The renderer matches on this exact string to distinguish "call was already resolved"
 * from MCP execution errors that happen to contain "not found" (e.g. "Tool not found").
 */
export const STAGED_CALL_NOT_FOUND_ERROR = 'Staged call not found';

/**
 * Stable error constants for staged call failure modes.
 * Re-exported from @shared/ipc/channels/safety.ts so the renderer can
 * classify failures without fragile string-matching on inline literals.
 */
export const STAGED_CALL_ALREADY_EXECUTING_ERROR = 'Already executing';
export const STAGED_CALL_EXPIRED_ERROR = 'This action has expired. Please ask the assistant to try again.';
export const STAGED_CALL_MCP_UNAVAILABLE_ERROR = 'MCP service unavailable. Please try again.';
export const STAGED_CALL_STATUS_PREFIX = 'Cannot execute call with status:';

const STAGED_CALL_EXECUTION_FAILED_ERROR = 'The approved action failed.';
const STAGED_CALL_ERROR_MESSAGE_FIELDS = [
  'message',
  'error_description',
  'description',
  'detail',
  'reason',
] as const;

const STORE_VERSION = 1;

let _store: KeyValueStore<StagedToolCallsStoreShape> | null = null;
const getStore = (): KeyValueStore<StagedToolCallsStoreShape> => {
  if (!_store) {
    _store = createStore<StagedToolCallsStoreShape>({
      name: 'staged-tool-calls',
      defaults: {
        version: STORE_VERSION,
        stagedCalls: [],
      },
    });
  }
  return _store;
};

function mergeRuntimeStagedCalls(calls: readonly StagedToolCall[]): StagedToolCall[] {
  const merged = new Map<string, StagedToolCall>();
  for (const call of calls) {
    if (runtimeSuppressedStagedCallIds.has(call.id)) continue;
    merged.set(call.id, call);
  }
  for (const call of runtimeStagedCalls.values()) {
    merged.set(call.id, call);
  }
  return Array.from(merged.values()).map(normalizeStagedToolCallBlockSource);
}

function normalizeStagedToolCallBlockSource(call: StagedToolCall): StagedToolCall {
  const blockedBy = backfillToolBlockSource(call.blockedBy, call.reason);
  return blockedBy === call.blockedBy ? call : { ...call, blockedBy };
}

function persistStagedCalls(calls: StagedToolCall[]): void {
  if (isUserDataReadOnly()) {
    log.warn(
      { count: calls.length },
      'Skipping staged call persistence because userData is read-only; keeping runtime approvals in memory',
    );
    return;
  }
  getStore().set('stagedCalls', calls);
}

/**
 * Generate a unique ID for a staged call.
 */
function generateId(): string {
  return crypto.randomBytes(8).toString('hex');
}

/**
 * Key-order-independent JSON serialization for args comparison.
 * Ensures {to, subject} and {subject, to} produce the same string.
 */
function stableStringify(obj: unknown): string {
  if (obj === null || obj === undefined || typeof obj !== 'object') {
    return JSON.stringify(obj);
  }
  if (Array.isArray(obj)) {
    return '[' + obj.map(stableStringify).join(',') + ']';
  }
  const sorted = Object.keys(obj as Record<string, unknown>).sort();
  return '{' + sorted.map((k) => JSON.stringify(k) + ':' + stableStringify((obj as Record<string, unknown>)[k])).join(',') + '}';
}

function extractReadableStagedCallErrorMessage(
  error: unknown,
  seen = new Set<object>(),
): string | undefined {
  if (error instanceof Error) {
    return extractReadableStagedCallErrorMessage(error.message, seen);
  }

  if (typeof error === 'string') {
    const trimmed = error.trim();
    if (!trimmed) {
      return undefined;
    }

    const looksJsonLike =
      (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
      (trimmed.startsWith('[') && trimmed.endsWith(']'));

    if (looksJsonLike) {
      try {
        const parsed = JSON.parse(trimmed) as unknown;
        return extractReadableStagedCallErrorMessage(parsed, seen);
      } catch (error) {
        ignoreBestEffortCleanup(error, {
          operation: 'stagedToolCalls.extractReadableStagedCallErrorMessage',
          reason: 'Error string looked JSON-like but was not parseable; continue with fallback message parsing.',
        });
        return undefined;
      }
    }

    return trimmed;
  }

  if (typeof error !== 'object' || error === null) {
    return undefined;
  }

  if (seen.has(error)) {
    return undefined;
  }
  seen.add(error);

  const errorRecord = error as Record<string, unknown>;
  for (const field of STAGED_CALL_ERROR_MESSAGE_FIELDS) {
    const message = extractReadableStagedCallErrorMessage(errorRecord[field], seen);
    if (message) {
      return message;
    }
  }

  const nestedErrorMessage = extractReadableStagedCallErrorMessage(errorRecord.error, seen);
  if (nestedErrorMessage) {
    return nestedErrorMessage;
  }

  return undefined;
}

function getStagedCallExecutionErrorMessage(error: unknown): string {
  return extractReadableStagedCallErrorMessage(error) ?? STAGED_CALL_EXECUTION_FAILED_ERROR;
}

/**
 * Get all staged calls, optionally filtered by session.
 */
export function getStagedCalls(sessionId?: string): StagedToolCall[] {
  try {
    const calls = mergeRuntimeStagedCalls(getStore().get('stagedCalls', []));
    if (sessionId) {
      return calls.filter((c) => c.sessionId === sessionId);
    }
    return calls;
  } catch (error) {
    log.error({ err: error }, 'Failed to load staged calls');
    const fallback = Array.from(runtimeStagedCalls.values()).map(normalizeStagedToolCallBlockSource);
    return sessionId ? fallback.filter((c) => c.sessionId === sessionId) : fallback;
  }
}

/**
 * Get a specific staged call by ID.
 */
export function getStagedCall(id: string): StagedToolCall | undefined {
  return getStagedCalls().find((c) => c.id === id);
}

/**
 * Get pending staged calls (not yet executed/rejected).
 */
export function getPendingStagedCalls(sessionId?: string): StagedToolCall[] {
  return getStagedCalls(sessionId).filter((c) => c.status === 'pending');
}

/**
 * Stage a new tool call for approval.
 */
export function stageToolCall(input: StageToolCallInput): StageToolCallResult {
  const now = Date.now();
  const stagedCall: StagedToolCall = {
    id: generateId(),
    sessionId: input.sessionId,
    turnId: input.turnId,
    timestamp: now,
    expiresAt: now + STAGED_CALL_TTL_MS,
    status: 'pending',
    mcpPayload: input.mcpPayload,
    displayName: input.displayName,
    toolCategory: input.toolCategory,
    riskLevel: input.riskLevel,
    reason: input.reason,
    allowPermanentTrust: input.allowPermanentTrust,
    ...(input.blockedBy ? { blockedBy: input.blockedBy } : {}),
    ...(input.coalesceKey ? { coalesceKey: input.coalesceKey } : {}),
    ...(input.automationId ? { automationId: input.automationId } : {}),
    ...(input.automationName ? { automationName: input.automationName } : {}),
  };

  try {
    const current = getStagedCalls();

    if (input.coalesceKey) {
      const existing = current.find((c) =>
        c.sessionId === input.sessionId &&
        c.status === 'pending' &&
        c.coalesceKey === input.coalesceKey
      );
      if (existing) {
        log.info(
          { id: existing.id, sessionId: input.sessionId, coalesceKey: input.coalesceKey },
          'Coalesced into existing pending staged call',
        );
        return { call: existing, coalesced: true };
      }
    }

    // Dedup: if a pending call for the same session + tool + args already exists,
    // replace it (the agent retried with fixed params or identical params).
    //
    // Coalesced safety-eval cooldown cards are first-wins: if a coalesceKey was
    // supplied and did not match above, this input must stage a new call rather
    // than falling through to args-based replacement of an unrelated pending card.
    const existingIdx = input.coalesceKey ? -1 : current.findIndex((c) =>
      c.sessionId === input.sessionId &&
      c.status === 'pending' &&
      c.mcpPayload.packageId === input.mcpPayload.packageId &&
      c.mcpPayload.toolId === input.mcpPayload.toolId &&
      stableStringify(c.mcpPayload.args) === stableStringify(input.mcpPayload.args)
    );

    if (existingIdx !== -1) {
      const existing = current[existingIdx];
      // Preserve the original ID so the renderer's in-memory reference stays valid.
      stagedCall.id = existing.id;
      log.info(
        {
          id: existing.id,
          toolId: input.mcpPayload.toolId,
          displayName: input.displayName,
        },
        'Replacing duplicate pending staged call (preserving ID)'
      );
      const updated = [...current];
      updated[existingIdx] = stagedCall;
      runtimeSuppressedStagedCallIds.delete(stagedCall.id);
      runtimeStagedCalls.set(stagedCall.id, stagedCall);
      persistStagedCalls(updated);
    } else {
      const updated = [...current, stagedCall];
      runtimeSuppressedStagedCallIds.delete(stagedCall.id);
      runtimeStagedCalls.set(stagedCall.id, stagedCall);
      persistStagedCalls(updated);
    }

    log.info(
      {
        id: stagedCall.id,
        sessionId: input.sessionId,
        packageId: input.mcpPayload.packageId,
        toolId: input.mcpPayload.toolId,
        displayName: input.displayName,
      },
      'Staged tool call for approval'
    );
  } catch (error) {
    log.error({ err: error, id: stagedCall.id }, 'Failed to persist staged call');
  }

  return { call: stagedCall, coalesced: false };
}

/**
 * Update a staged call's status and optionally its result.
 */
function updateStagedCall(id: string, updates: Partial<Pick<StagedToolCall, 'status' | 'result'>>): void {
  try {
    const current = getStagedCalls();
    let updatedCall: StagedToolCall | undefined;
    const updated = current.map((c) => {
      if (c.id !== id) return c;
      updatedCall = { ...c, ...updates };
      return updatedCall;
    });
    if (updatedCall) {
      runtimeStagedCalls.set(id, updatedCall);
    }
    persistStagedCalls(updated);
  } catch (error) {
    log.error({ err: error, id }, 'Failed to update staged call');
  }
}

/**
 * Result of executeStagedCall including the authoritative final status.
 * Handlers use this to broadcast the correct status without guessing.
 */
export interface ExecuteStagedCallOutcome {
  status: StagedCallStatus;
  result: StagedCallResult;
}

/**
 * Execute a staged tool call directly via MCP.
 * Returns the authoritative final status and result.
 */
export async function executeStagedCall(id: string): Promise<ExecuteStagedCallOutcome> {
  // Acquire execution lock synchronously (before any await) to prevent double execution
  if (executingIds.has(id)) {
    log.warn({ id }, 'Staged call already executing - skipping duplicate');
    return {
      status: 'executing',
      result: { success: false, error: STAGED_CALL_ALREADY_EXECUTING_ERROR, executedAt: Date.now() },
    };
  }
  executingIds.add(id);
  log.debug({ id }, 'Acquired execution lock');

  try {
    return await executeStagedCallInner(id);
  } finally {
    executingIds.delete(id);
    log.debug({ id }, 'Released execution lock');
  }
}

async function executeStagedCallInner(id: string): Promise<ExecuteStagedCallOutcome> {
  const stagedCall = getStagedCall(id);
  if (!stagedCall) {
    return {
      status: 'failed',
      result: { success: false, error: STAGED_CALL_NOT_FOUND_ERROR, executedAt: Date.now() },
    };
  }

  if (stagedCall.status !== 'pending') {
    return {
      status: stagedCall.status,
      result: {
        success: false,
        error: `${STAGED_CALL_STATUS_PREFIX} ${stagedCall.status}`,
        executedAt: Date.now(),
      },
    };
  }

  // Check if call has expired
  if (Date.now() > stagedCall.expiresAt) {
    updateStagedCall(id, { status: 'expired' });
    return {
      status: 'expired',
      result: {
        success: false,
        error: STAGED_CALL_EXPIRED_ERROR,
        executedAt: Date.now(),
      },
    };
  }

  // Check if Super-MCP is running
  const state = superMcpHttpManager.getState();
  if (!state.isRunning || !state.url) {
    log.warn({ id }, 'Cannot execute staged call - Super-MCP not running');
    return {
      status: 'failed',
      result: { success: false, error: STAGED_CALL_MCP_UNAVAILABLE_ERROR, executedAt: Date.now() },
    };
  }

  // Mark as executing (idempotency)
  updateStagedCall(id, { status: 'executing' });

  const { packageId, toolId, args } = stagedCall.mcpPayload;
  log.info({ id, packageId, toolId }, 'Executing staged tool call');

  const client = new Client(MCP_CLIENT_INFO);
  const transport = new StreamableHTTPClientTransport(new URL(state.url));

  try {
    await client.connect(transport);

    const result = await client.callTool(
      {
        name: 'use_tool',
        arguments: {
          package_id: packageId,
          tool_id: toolId,
          args,
        },
      },
      undefined,
      { timeout: 60000 }
    );

    // Extract text content from result
    const textEntries = (result.content as Array<Record<string, unknown>> | undefined)?.filter(
      (entry: Record<string, unknown>): entry is { type: string; text: string } => entry?.type === 'text' && typeof entry.text === 'string'
    ) ?? [];
    const combinedText = textEntries.length > 0
      ? textEntries.map((entry) => entry.text).join('\n')
      : undefined;
    const summarizedSuccessContent = summarizeStagedExecutionResult(
      combinedText ?? 'Tool executed successfully',
    );

    if (result.isError === true) {
      const summarizedFailureContent = summarizeStagedExecutionResult(
        combinedText ?? 'Tool execution failed.',
      );
      const enrichedError = `[${packageId}/${toolId}] ${summarizedFailureContent}`;
      const executionResult: StagedCallResult = {
        success: false,
        error: enrichedError,
        executedAt: Date.now(),
      };

      updateStagedCall(id, { status: 'failed', result: executionResult });
      const hasContent = Array.isArray(result.content) ? result.content.length : 0;
      log.warn({ id, packageId, toolId, hasContent }, 'Staged tool call returned isError: true');
      return { status: 'failed', result: executionResult };
    }

    const executionResult: StagedCallResult = {
      success: true,
      content: summarizedSuccessContent,
      executedAt: Date.now(),
    };

    updateStagedCall(id, { status: 'executed', result: executionResult });
    log.info({ id, packageId, toolId }, 'Staged tool call executed successfully');

    return { status: 'executed', result: executionResult };
  } catch (error) {
    const errorMessage = getStagedCallExecutionErrorMessage(error);

    log.error({ err: error, id, packageId, toolId }, 'Staged tool call execution failed');

    const argKeys = args && typeof args === 'object' ? Object.keys(args) : [];
    const enrichedError = `[${packageId}/${toolId}] ${errorMessage}${argKeys.length > 0 ? ` (args: ${argKeys.join(', ')})` : ''}`;

    const executionResult: StagedCallResult = {
      success: false,
      error: enrichedError,
      executedAt: Date.now(),
    };

    updateStagedCall(id, { status: 'failed', result: executionResult });

    return { status: 'failed', result: executionResult };
  } finally {
    try {
      await transport.terminateSession();
    } catch (error) {
      ignoreBestEffortCleanup(error, {
        operation: 'stagedToolCalls.executeStagedCall.transportTerminateSession',
        reason: 'Best-effort MCP session termination failed during cleanup after execution.',
      });
    }
    try {
      await client.close();
    } catch (error) {
      ignoreBestEffortCleanup(error, {
        operation: 'stagedToolCalls.executeStagedCall.clientClose',
        reason: 'Best-effort MCP client close failed during cleanup after execution.',
      });
    }
  }
}

/**
 * Execute multiple staged calls sequentially.
 * Continues through all calls regardless of individual failures so the AI
 * gets a single consolidated report of what worked and what didn't.
 */
export async function executeStagedBatch(ids: string[]): Promise<BatchExecutionResult> {
  const executed: Array<{ id: string; result: StagedCallResult }> = [];

  for (const id of ids) {
    const outcome = await executeStagedCall(id);
    executed.push({ id, result: outcome.result });
  }

  return { executed };
}

/**
 * Reject a staged call (user clicked "Don't run").
 */
export function rejectStagedCall(id: string): void {
  updateStagedCall(id, { status: 'rejected' });
  log.info({ id }, 'Staged call rejected by user');
}

/**
 * Remove a staged call from the store entirely.
 */
export function removeStagedCall(id: string): void {
  try {
    const current = getStagedCalls();
    const filtered = current.filter((c) => c.id !== id);
    if (filtered.length !== current.length) {
      runtimeStagedCalls.delete(id);
      runtimeSuppressedStagedCallIds.add(id);
      persistStagedCalls(filtered);
      log.debug({ id }, 'Removed staged call');
    }
  } catch (error) {
    log.error({ err: error, id }, 'Failed to remove staged call');
  }
}

/**
 * Clear all staged calls for a session.
 * Called when session ends.
 */
export function clearSessionStagedCalls(sessionId: string): void {
  try {
    const current = getStagedCalls();
    const filtered = current.filter((c) => c.sessionId !== sessionId);
    if (filtered.length !== current.length) {
      const removedCount = current.length - filtered.length;
      for (const call of current) {
        if (call.sessionId === sessionId) {
          runtimeStagedCalls.delete(call.id);
          runtimeSuppressedStagedCallIds.add(call.id);
        }
      }
      persistStagedCalls(filtered);
      log.info({ sessionId, removedCount }, 'Cleared staged calls for session');
    }
  } catch (error) {
    log.error({ err: error, sessionId }, 'Failed to clear session staged calls');
  }
}

/**
 * Clean up expired staged calls and old terminal-state calls.
 * Called on app startup and periodically (every 6 hours).
 *
 * Removes:
 *  - Non-terminal calls whose TTL has passed (expired pending/executing)
 *  - Terminal-state calls (executed, rejected, failed) older than TERMINAL_STATE_MAX_AGE_MS
 */
export function cleanupExpiredStagedCalls(): number {
  const now = Date.now();
  try {
    const current = getStagedCalls();
    const filtered = current.filter((c) => {
      const isTerminal = c.status === 'executed' || c.status === 'rejected' || c.status === 'failed';
      if (isTerminal) {
        // Keep terminal calls only if they're younger than max-age
        const ageRef = c.result?.executedAt ?? c.timestamp;
        return (now - ageRef) < TERMINAL_STATE_MAX_AGE_MS;
      }
      // Non-terminal: keep if not expired
      return c.expiresAt > now;
    });

    const removedCount = current.length - filtered.length;
    if (removedCount > 0) {
      const retainedIds = new Set(filtered.map((call) => call.id));
      for (const call of current) {
        if (!retainedIds.has(call.id)) {
          runtimeStagedCalls.delete(call.id);
          runtimeSuppressedStagedCallIds.add(call.id);
        }
      }
      persistStagedCalls(filtered);
      log.info({ removedCount }, 'Cleaned up expired/old staged calls');
    }

    return removedCount;
  } catch (error) {
    log.error({ err: error }, 'Failed to cleanup expired staged calls');
    return 0;
  }
}

/**
 * Clear all staged calls (for testing/reset).
 */
export function clearAllStagedCalls(): void {
  try {
    for (const call of getStagedCalls()) {
      runtimeSuppressedStagedCallIds.add(call.id);
    }
    runtimeStagedCalls.clear();
    persistStagedCalls([]);
    if (!isUserDataReadOnly()) {
      runtimeSuppressedStagedCallIds.clear();
    }
    log.info('Cleared all staged calls');
  } catch (error) {
    log.error({ err: error }, 'Failed to clear all staged calls');
  }
}

/**
 * Build a human-readable display name for a tool call.
 */
export function buildToolDisplayName(packageId: string, toolId: string, args: Record<string, unknown>): string {
  // Try to extract meaningful info from common tool patterns
  const cleanToolId = toolId.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());

  // Extract common identifiers
  const to = args.to ?? args.recipient ?? args.email;
  const subject = args.subject ?? args.title ?? args.name;

  if (to && typeof to === 'string') {
    if (subject && typeof subject === 'string') {
      return `${cleanToolId} to ${to}: "${subject.slice(0, 50)}"`;
    }
    return `${cleanToolId} to ${to}`;
  }

  if (subject && typeof subject === 'string') {
    return `${cleanToolId}: "${subject.slice(0, 50)}"`;
  }

  // Avoid packageId duplication when the toolId already starts with the package name
  // e.g. "Slack-mindstone" + "Slack-mindstone_reply_to_slack_thread" → just "Reply to slack thread"
  const normalizedPrefix = packageId.toLowerCase().replace(/[-_]/g, ' ');
  const normalizedSuffix = cleanToolId.toLowerCase().replace(/[-_]/g, ' ');
  if (normalizedSuffix.startsWith(normalizedPrefix)) {
    const trimmed = cleanToolId.slice(packageId.length).replace(/^[\s\-_]+/, '');
    if (trimmed) return trimmed.replace(/^\w/, (c) => c.toUpperCase());
  }
  return `${packageId} - ${cleanToolId}`;
}

/**
 * Determine if a tool is a side-effect tool (vs read-only).
 * Side-effect tools modify external state (send, create, delete, post, etc.).
 * Uses word-boundary-aware matching via pre-compiled regex patterns:
 * a verb must appear at the start of the ID or after an underscore.
 *
 * Examples:
 *   "send_email"             → true  ("send" at start)
 *   "gmail_send_email"       → true  ("send" after underscore)
 *   "get_message_sender_info"→ false ("send" is inside "sender", not a word boundary)
 *   "executor_status"        → false ("execute" is inside "executor")
 *   "run_ner_status"         → true  ("run" at start followed by underscore)
 */
export function isSideEffectTool(toolId: string): boolean {
  return isSideEffectVerb(toolId);
}
