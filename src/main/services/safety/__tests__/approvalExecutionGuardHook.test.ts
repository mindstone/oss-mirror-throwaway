/**
 * Tests for the approval-execution guard Stop hook
 * (FOX-2771/2601 Stage 2 — deterministic post-approval execution guard).
 *
 * Contract under test:
 *  - approval consumed → hook allows stop (no forced continuation)
 *  - approval unconsumed → exactly ONE forced continuation (block) naming the operation
 *  - still unconsumed after the forced continuation → "approved but not executed"
 *    surfaced exactly once, then stop allowed
 *  - staged/default-stored approvals (no expectExecution) never trigger the guard
 *  - approvals stored mid-turn are not this turn's responsibility
 *  - pending user question (AskUserQuestion) → stop allowed WITHOUT spending
 *    the forced-continuation budget (GPT review F2)
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@core/logger', () => ({
  createScopedLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
  }),
}));

import {
  storeSingleUseApproval,
  consumeSingleUseApproval,
  currentApprovalSequence,
  _testing_resetSingleUseApprovals,
  type UnconsumedExecutionExpectation,
} from '../sessionApprovals';
import {
  createApprovalExecutionGuardHook,
  buildApprovedNotExecutedStatus,
} from '../approvalExecutionGuardHook';

const SESSION = 'sess-guard';

function makeHook(overrides: Partial<{
  approvalSeqAtTurnStart: number;
  onApprovedNotExecuted: (items: UnconsumedExecutionExpectation[]) => void;
  isAwaitingUserInput: () => boolean;
  abortSignal: AbortSignal;
}> = {}) {
  return createApprovalExecutionGuardHook({
    sessionId: SESSION,
    // Default: snapshot AFTER the test's stores — they count as "stored
    // before the turn started".
    approvalSeqAtTurnStart: overrides.approvalSeqAtTurnStart ?? currentApprovalSequence(),
    onApprovedNotExecuted: overrides.onApprovedNotExecuted ?? vi.fn(),
    ...(overrides.isAwaitingUserInput ? { isAwaitingUserInput: overrides.isAwaitingUserInput } : {}),
    ...(overrides.abortSignal ? { abortSignal: overrides.abortSignal } : {}),
  });
}

beforeEach(() => {
  _testing_resetSingleUseApprovals();
});

describe('approvalExecutionGuardHook', () => {
  it('allows stop when there are no stored approvals', async () => {
    const hook = makeHook();
    await expect(hook()).resolves.toEqual({});
  });

  it('allows stop when the approval was consumed (the operation executed)', async () => {
    storeSingleUseApproval('tool', SESSION, 'mcp__gmail__send_email', { expectExecution: true });
    consumeSingleUseApproval('tool', SESSION, 'mcp__gmail__send_email');
    const hook = makeHook();
    await expect(hook()).resolves.toEqual({});
  });

  it('forces exactly ONE continuation when the approval was not consumed', async () => {
    storeSingleUseApproval('tool', SESSION, 'mcp__gmail__send_email', { expectExecution: true });
    const onSurfaced = vi.fn();
    const hook = makeHook({ onApprovedNotExecuted: onSurfaced });

    const first = await hook();
    expect(first).toMatchObject({ decision: 'block' });
    const reason = (first as { reason?: string }).reason ?? '';
    // Stronger system message names the approved operation identifier.
    expect(reason).toContain('mcp__gmail__send_email');
    expect(reason).toContain('NOT been executed');
    expect(reason).toContain('[System: auto-continue]');
    expect(onSurfaced).not.toHaveBeenCalled();

    // Second stop evaluation (model ignored the forced continuation too):
    // no second block — surfaces the explicit state instead.
    const second = await hook();
    expect(second).toEqual({});
    expect(onSurfaced).toHaveBeenCalledTimes(1);
    const surfacedItems = onSurfaced.mock.calls[0][0] as UnconsumedExecutionExpectation[];
    expect(surfacedItems.map((i) => i.identifier)).toEqual(['mcp__gmail__send_email']);

    // Third stop evaluation: terminal state already surfaced — nothing more.
    const third = await hook();
    expect(third).toEqual({});
    expect(onSurfaced).toHaveBeenCalledTimes(1);
  });

  it('does not force again if the approval is consumed during the forced continuation', async () => {
    storeSingleUseApproval('memory', SESSION, '/space/notes.md', { expectExecution: true });
    const onSurfaced = vi.fn();
    const hook = makeHook({ onApprovedNotExecuted: onSurfaced });

    const first = await hook();
    expect(first).toMatchObject({ decision: 'block' });

    // Model executes the approved write during the forced continuation.
    consumeSingleUseApproval('memory', SESSION, '/space/notes.md');

    const second = await hook();
    expect(second).toEqual({});
    expect(onSurfaced).not.toHaveBeenCalled();
  });

  it('ignores approvals stored WITHOUT expectExecution (staged path untouched)', async () => {
    // Staged memory writes / un-audited call sites store without the flag.
    storeSingleUseApproval('memory', SESSION, '/space/staged.md');
    const onSurfaced = vi.fn();
    const hook = makeHook({ onApprovedNotExecuted: onSurfaced });
    await expect(hook()).resolves.toEqual({});
    expect(onSurfaced).not.toHaveBeenCalled();
    // And the staged approval is still there, untouched.
    expect(consumeSingleUseApproval('memory', SESSION, '/space/staged.md')).toBe(true);
  });

  it('ignores approvals stored mid-turn (seq after the turn-start snapshot)', async () => {
    // Snapshot taken BEFORE the approval is stored = the approval arrived mid-turn.
    const approvalSeqAtTurnStart = currentApprovalSequence();
    storeSingleUseApproval('tool', SESSION, 'late-approval', { expectExecution: true });
    const hook = makeHook({ approvalSeqAtTurnStart });
    await expect(hook()).resolves.toEqual({});
  });

  it('never forces when the user pressed Stop (abort signal)', async () => {
    storeSingleUseApproval('tool', SESSION, 'op', { expectExecution: true });
    const controller = new AbortController();
    controller.abort();
    const hook = makeHook({ abortSignal: controller.signal });
    await expect(hook()).resolves.toEqual({});
  });

  it('yields to a pending user question WITHOUT spending the forced-continuation budget (GPT F2)', async () => {
    storeSingleUseApproval('tool', SESSION, 'op', { expectExecution: true });
    let questionPending = true;
    const onSurfaced = vi.fn();
    const hook = makeHook({
      isAwaitingUserInput: () => questionPending,
      onApprovedNotExecuted: onSurfaced,
    });

    // Turn stopped to wait for the user — guard must allow the stop,
    // and must NOT mark the expectation forced or surface anything.
    await expect(hook()).resolves.toEqual({});
    expect(onSurfaced).not.toHaveBeenCalled();

    // Post-answer continuation turn: question no longer pending — the budget
    // was preserved, so the guard still gets its one forced continuation.
    questionPending = false;
    const result = await hook();
    expect(result).toMatchObject({ decision: 'block' });
    expect((result as { reason?: string }).reason).toContain('op');
  });

  it('lists multiple unconsumed operations in one forced continuation', async () => {
    storeSingleUseApproval('tool', SESSION, 'mcp__linear__create_issue', { expectExecution: true });
    storeSingleUseApproval('memory', SESSION, '/space/notes.md', { expectExecution: true });
    const hook = makeHook();
    const result = await hook();
    const reason = (result as { reason?: string }).reason ?? '';
    expect(reason).toContain('mcp__linear__create_issue');
    expect(reason).toContain('/space/notes.md');
  });

  it('surfaced-status copy names the operations', () => {
    const text = buildApprovedNotExecutedStatus([
      { domain: 'tool', identifier: 'mcp__gmail__send_email', storedAt: 1 },
      { domain: 'memory', identifier: '/space/notes.md', storedAt: 2 },
    ]);
    expect(text).toContain('Approved but not executed');
    expect(text).toContain('tool call mcp__gmail__send_email');
    expect(text).toContain('memory write to /space/notes.md');
  });
});
