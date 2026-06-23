// @vitest-environment happy-dom
/**
 * Stage 3 review F1 + F2 (docs/plans/260611_recs-round4): direct-fallback
 * dispatch failures (typed busy refusals when `onSendContinuation` is
 * omitted) must surface honestly instead of silently dropping or
 * falsely failing.
 *
 * - F2 site 1: executeStagedApproval SUCCESS result delivery refused →
 *   'result-not-delivered' (the result text exists ONLY in the continuation;
 *   silent { ok:true } is data loss).
 * - F2 site 2: executeStagedApproval failure-notice refused → the classified
 *   execution failure still returns (never masked into ok:true).
 * - F2 site 3: batch staged summary refused → recorded on
 *   `batchResult.resultDeliveryFailures` (per-item execution accounting
 *   untouched).
 * - F1 UI half: dismissApproval (memory) reports SUCCESS and removes the
 *   item when the deny succeeded and only the feedback turn was refused.
 *
 * All scenarios run WITHOUT onSendContinuation — the fallback surface the
 * review flagged. The normal App drawer path provides onSendContinuation
 * and routes through the queue.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderHook, act, flushAsync } from '@renderer/test-utils';
import {
  usePendingApprovals,
  type PendingApprovalItem,
} from '../usePendingApprovals';

const turnMock = vi.fn();
const stagedExecuteMock = vi.fn();
const stagedExecuteBatchMock = vi.fn();
const sendMemoryWriteApprovalResponseMock = vi.fn();

/** The typed busy refusal shape as the renderer sees it through IPC. */
const busyRefusal = () =>
  new Error("Error invoking remote method 'agent:turn': Error: AGENT_TURN_TARGET_BUSY");

beforeEach(() => {
  vi.clearAllMocks();
  turnMock.mockResolvedValue({ turnId: 'turn-1' });
  stagedExecuteMock.mockResolvedValue({ success: true, content: 'Email sent to bob@example.com' });
  stagedExecuteBatchMock.mockResolvedValue({ executed: [] });
  sendMemoryWriteApprovalResponseMock.mockResolvedValue({ success: true });

  vi.stubGlobal('api', {
    onToolSafetyApprovalRequest: vi.fn(() => () => undefined),
    onMemoryWriteApprovalRequest: vi.fn(() => () => undefined),
    onMemoryWriteApprovalResolved: vi.fn(() => () => undefined),
    onToolSafetyApprovalResolved: vi.fn(() => () => undefined),
    onStagedToolCall: vi.fn(() => () => undefined),
    onStagedToolCallUpdated: vi.fn(() => () => undefined),
    onStagedFilesChanged: vi.fn(() => () => undefined),
    getStagedFiles: vi.fn().mockResolvedValue({ files: [] }),
    sendMemoryWriteApprovalResponse: sendMemoryWriteApprovalResponseMock,
  });
  vi.stubGlobal('safetyApi', {
    pending: vi.fn().mockResolvedValue([]),
    stagedGetAll: vi.fn().mockResolvedValue([]),
    stagedExecute: stagedExecuteMock,
    stagedExecuteBatch: stagedExecuteBatchMock,
    stagedReject: vi.fn().mockResolvedValue({ success: true }),
  });
  vi.stubGlobal('memoryApi', {
    getPendingApprovals: vi.fn().mockResolvedValue([]),
  });
  vi.stubGlobal('sessionsApi', {
    list: vi.fn().mockResolvedValue([]),
  });
  vi.stubGlobal('agentApi', { turn: turnMock });
});

const makeStagedItem = (overrides: Partial<PendingApprovalItem> = {}): PendingApprovalItem => ({
  id: 'staged-tool:st-1',
  type: 'staged-tool',
  title: 'Send email',
  description: 'Send email to Bob',
  timestamp: 1_000,
  sessionId: 'session-1',
  stagedToolCall: {
    id: 'st-1',
    displayName: 'Send email',
    mcpPayload: { packageId: 'gmail', toolId: 'send_email', args: {} },
  },
  ...overrides,
});

const makeMemoryItem = (): PendingApprovalItem => ({
  id: 'memory:mem-1',
  type: 'memory',
  title: 'Save memory',
  description: 'Save to Memory',
  timestamp: 1_000,
  sessionId: 'session-1',
  memoryApproval: {
    toolUseId: 'mem-1',
    originalSessionId: 'session-1',
    filePath: 'memory/notes.md',
    spaceName: 'Memory',
    summary: 'remember this',
    content: 'remember this',
  },
});

async function mountHook() {
  const harness = renderHook(() => usePendingApprovals());
  await flushAsync(); // settle the initial loadApprovals effect
  return harness;
}

describe('executeStagedApproval — fallback result delivery (F2)', () => {
  it("SUCCESS result refused → { ok:false, reason:'result-not-delivered' }, never a silent ok", async () => {
    turnMock.mockRejectedValueOnce(busyRefusal());
    const { result, unmount } = await mountHook();

    let outcome: unknown;
    await act(async () => {
      outcome = await result.current.executeStagedApproval(makeStagedItem());
    });

    // Execution itself ran…
    expect(stagedExecuteMock).toHaveBeenCalledWith({ id: 'st-1' });
    // …the result dispatch used the non-interrupting policy…
    expect(turnMock).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'session-1', supersedePolicy: 'reject' }),
    );
    // …and the lost result text surfaces instead of a silent success.
    expect(outcome).toMatchObject({ ok: false, reason: 'result-not-delivered' });
    unmount();
  });

  it('SUCCESS result delivered → { ok:true } (unchanged happy path)', async () => {
    const { result, unmount } = await mountHook();

    let outcome: unknown;
    await act(async () => {
      outcome = await result.current.executeStagedApproval(makeStagedItem());
    });

    expect(outcome).toEqual({ ok: true });
    unmount();
  });

  it('execution FAILURE + refused failure notice → classified failure still returns (never masked)', async () => {
    stagedExecuteMock.mockResolvedValueOnce({ success: false, error: 'SMTP exploded' });
    turnMock.mockRejectedValueOnce(busyRefusal());
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { result, unmount } = await mountHook();

    let outcome: unknown;
    await act(async () => {
      outcome = await result.current.executeStagedApproval(makeStagedItem());
    });

    expect(outcome).toMatchObject({ ok: false, reason: 'execution-failed' });
    // The dropped agent notice is observable, not silent.
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('failure notice could not be delivered'),
      expect.objectContaining({ sessionId: 'session-1' }),
    );
    warnSpy.mockRestore();
    unmount();
  });

  it('arg-validation failure → arg-recovering outcome + agent STILL gets the self-recovery notice (FOX-3519)', async () => {
    stagedExecuteMock.mockResolvedValueOnce({
      success: false,
      error: "[gmail/send_email] MCP error -33003: Argument validation failed for tool 'send_email'. Missing required: to. Use 'get_tool_details' to review the schema, or 'dry_run: true' to test arguments.",
    });
    const { result, unmount } = await mountHook();

    let outcome: unknown;
    await act(async () => {
      outcome = await result.current.executeStagedApproval(makeStagedItem());
    });

    // User-facing outcome is the calm class, NOT a raw execution-failed toast,
    // and it carries the action display name so the toast can name the action
    // (FOX-3519 refinement) — makeStagedItem's displayName is "Send email".
    expect(outcome).toMatchObject({ ok: false, reason: 'arg-recovering', displayName: 'Send email' });
    // The agent self-recovery path still fires — it receives the failure notice
    // (with the full stripped detail) via the non-interrupting reject policy so
    // it can re-dispatch with fixed args.
    expect(turnMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'session-1',
        isSystemContinuation: true,
        supersedePolicy: 'reject',
      }),
    );
    unmount();
  });
});

describe('batchApproveToolApprovals — staged summary delivery (F2)', () => {
  it('refused batch summary → recorded on resultDeliveryFailures, execution accounting untouched', async () => {
    stagedExecuteBatchMock.mockResolvedValueOnce({
      executed: [{ id: 'st-1', result: { success: true, content: 'done' } }],
    });
    turnMock.mockRejectedValueOnce(busyRefusal());
    const { result, unmount } = await mountHook();

    let batch: Awaited<ReturnType<typeof result.current.batchApproveToolApprovals>> | undefined;
    await act(async () => {
      batch = await result.current.batchApproveToolApprovals([makeStagedItem()]);
    });

    expect(batch?.failed).toBe(0); // the execution itself succeeded
    expect(batch?.resultDeliveryFailures).toHaveLength(1);
    expect(batch?.resultDeliveryFailures?.[0]).toMatchObject({ sessionId: 'session-1' });
    unmount();
  });

  it('delivered batch summary → no resultDeliveryFailures (unchanged happy path)', async () => {
    stagedExecuteBatchMock.mockResolvedValueOnce({
      executed: [{ id: 'st-1', result: { success: true, content: 'done' } }],
    });
    const { result, unmount } = await mountHook();

    let batch: Awaited<ReturnType<typeof result.current.batchApproveToolApprovals>> | undefined;
    await act(async () => {
      batch = await result.current.batchApproveToolApprovals([makeStagedItem()]);
    });

    expect(batch?.resultDeliveryFailures).toBeUndefined();
    unmount();
  });

  it('arg-validation failure is EXCLUDED from the batch failure tally (FOX-3519)', async () => {
    // A recoverable arg-validation failure must NOT be counted as a user-facing
    // failure — otherwise the batch summary toast reads "1 action failed: Rebel
    // is sorting that out". The agent still gets the per-session continuation.
    stagedExecuteBatchMock.mockResolvedValueOnce({
      executed: [{
        id: 'st-1',
        result: {
          success: false,
          error: "[gmail/send_email] use_tool \"args\" must be an object, null/omitted, or a JSON string that parses to an object. Use get_tool_details(...)",
        },
      }],
    });
    const { result, unmount } = await mountHook();

    let batch: Awaited<ReturnType<typeof result.current.batchApproveToolApprovals>> | undefined;
    await act(async () => {
      batch = await result.current.batchApproveToolApprovals([makeStagedItem()]);
    });

    expect(batch?.failed).toBe(0);
    expect(batch?.failures).toHaveLength(0);
    unmount();
  });
});

describe('dismissApproval (memory) — deny success survives a refused feedback turn (F1 UI half)', () => {
  it('returns TRUE and removes the approval when only the feedback dispatch is busy-refused', async () => {
    // Seed a real memory approval so removal is observable on the list.
    (window as unknown as { memoryApi: { getPendingApprovals: ReturnType<typeof vi.fn> } })
      .memoryApi.getPendingApprovals.mockResolvedValue([
        {
          toolUseId: 'mem-1',
          originalTurnId: 'turn-1',
          originalSessionId: 'session-1',
          turnId: 'turn-1',
          sessionId: 'session-1',
          filePath: 'memory/notes.md',
          spaceName: 'Memory',
          summary: 'remember this',
          content: 'remember this',
          timestamp: 1_000,
          staged: false,
        },
      ]);
    turnMock.mockRejectedValueOnce(busyRefusal());
    const { result, unmount } = await mountHook();

    expect(result.current.approvals.map((a) => a.id)).toContain('memory:mem-1');

    let success: boolean | undefined;
    await act(async () => {
      success = await result.current.dismissApproval(makeMemoryItem());
    });

    expect(success).toBe(true);
    expect(sendMemoryWriteApprovalResponseMock).toHaveBeenCalledWith({
      toolUseId: 'mem-1',
      approved: false,
    });
    // The deny landed → the item must be gone, not stranded as stale UI.
    expect(result.current.approvals.map((a) => a.id)).not.toContain('memory:mem-1');
    unmount();
  });
});
