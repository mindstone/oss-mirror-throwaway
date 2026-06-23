// @vitest-environment happy-dom
/**
 * Stage 3 review F1 (docs/plans/260611_recs-round4): a successful memory
 * DENY must report success even when the follow-up informational feedback
 * turn cannot be delivered.
 *
 * The false-failure chain this pins shut: `discardMemoryApproval` returned
 * false on a busy-refused feedback dispatch → `usePendingApprovals.
 * dismissApproval` bailed before `removeApproval` → NotificationDrawer
 * showed "Failed to dismiss" and stranded stale UI — after the deny had
 * already taken effect. The deny IS the discard; the feedback message is
 * best-effort.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { discardMemoryApproval, saveMemoryApproval } from '../saveMemoryApproval';

const sendMemoryWriteApprovalResponse = vi.fn();
const turnMock = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  sendMemoryWriteApprovalResponse.mockResolvedValue({ success: true });
  turnMock.mockResolvedValue({ turnId: 'turn-1' });
  vi.stubGlobal('api', { sendMemoryWriteApprovalResponse });
  vi.stubGlobal('agentApi', { turn: turnMock });
});

const DISCARD = {
  toolUseId: 'tool-use-1',
  originalSessionId: 'session-1',
  filePath: 'memory/notes.md',
  spaceName: 'Memory',
};

/** The typed busy refusal shape as the renderer sees it through IPC. */
const busyRefusal = () =>
  new Error("Error invoking remote method 'agent:turn': Error: AGENT_TURN_TARGET_BUSY");

describe('discardMemoryApproval — feedback turn is best-effort after a successful deny (F1)', () => {
  it('returns TRUE when the deny succeeds but the direct feedback dispatch is busy-refused', async () => {
    turnMock.mockRejectedValueOnce(busyRefusal());

    const result = await discardMemoryApproval(DISCARD);

    expect(result).toBe(true);
    expect(sendMemoryWriteApprovalResponse).toHaveBeenCalledWith({
      toolUseId: 'tool-use-1',
      approved: false,
    });
    // The dispatch was attempted with the non-interrupting policy.
    expect(turnMock).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'session-1', supersedePolicy: 'reject' }),
    );
  });

  it('returns TRUE when the deny succeeds but the queue-based sendContinuation throws', async () => {
    const sendContinuation = vi.fn().mockRejectedValue(new Error('queue pipeline exploded'));

    const result = await discardMemoryApproval(DISCARD, sendContinuation);

    expect(result).toBe(true);
    expect(sendContinuation).toHaveBeenCalledTimes(1);
    expect(turnMock).not.toHaveBeenCalled();
  });

  it('still returns FALSE when the deny itself fails (unchanged semantics)', async () => {
    sendMemoryWriteApprovalResponse.mockResolvedValueOnce({ success: false });

    const result = await discardMemoryApproval(DISCARD);

    expect(result).toBe(false);
    expect(turnMock).not.toHaveBeenCalled();
  });

  it('still returns FALSE when the deny IPC throws (unchanged semantics)', async () => {
    sendMemoryWriteApprovalResponse.mockRejectedValueOnce(new Error('ipc down'));

    const result = await discardMemoryApproval(DISCARD);

    expect(result).toBe(false);
    expect(turnMock).not.toHaveBeenCalled();
  });
});

describe('saveMemoryApproval — continuation refusal keeps the existing ok+reason shape (regression pin)', () => {
  it('returns { ok:true, reason:"continuation-failed" } when the retry-trigger dispatch is busy-refused', async () => {
    sendMemoryWriteApprovalResponse.mockResolvedValueOnce({
      success: true,
      spaceName: 'Memory',
      filePath: 'memory/notes.md',
      content: 'remember this',
    });
    turnMock.mockRejectedValueOnce(busyRefusal());

    const result = await saveMemoryApproval({
      toolUseId: 'tool-use-1',
      originalSessionId: 'session-1',
      filePath: 'memory/notes.md',
      spaceName: 'Memory',
      content: 'remember this',
    });

    expect(result).toEqual({ ok: true, reason: 'continuation-failed' });
  });
});
