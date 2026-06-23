import { beforeEach, describe, expect, it, vi } from 'vitest';

const storeState: {
  pendingApprovals: unknown[];
  pendingMemoryApprovals: unknown[];
} = {
  pendingApprovals: [],
  pendingMemoryApprovals: [],
};

const mockStore = {
  get: vi.fn((key: 'pendingApprovals' | 'pendingMemoryApprovals', fallback: unknown[]) => {
    const value = storeState[key];
    return value !== undefined ? value : fallback;
  }),
  set: vi.fn((key: 'pendingApprovals' | 'pendingMemoryApprovals', value: unknown[]) => {
    storeState[key] = value;
  }),
};

vi.mock('@core/storeFactory', () => ({
  createStore: () => mockStore,
}));

vi.mock('@core/logger', () => ({
  createScopedLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  }),
}));

import {
  addPendingApproval,
  clearAllPendingApprovals,
  getPendingApprovals,
} from '../pendingApprovalsStore';

describe('safety verdict conformance - pending approval persistence', () => {
  beforeEach(() => {
    storeState.pendingApprovals = [];
    storeState.pendingMemoryApprovals = [];
    mockStore.get.mockClear();
    mockStore.set.mockClear();
    clearAllPendingApprovals();
  });

  it('preserves tool blockedBy through getPendingApprovals after restart-style persistence', () => {
    // Invariant #10: locks behavior for S4 verdict refactor.
    addPendingApproval({
      toolUseID: 'persisted-safety-prompt',
      turnId: 'turn-safety-prompt',
      sessionId: 'session-persisted',
      toolName: 'send_message',
      input: { text: 'hello' },
      reason: 'Safety Rules blocked: needs review',
      timestamp: 1_780_000_000_000,
      allowPermanentTrust: false,
      effectiveToolId: 'send_message',
      blockedBy: 'safety_prompt',
    });
    addPendingApproval({
      toolUseID: 'persisted-eval-error',
      turnId: 'turn-eval-error',
      sessionId: 'session-persisted',
      toolName: 'Bash',
      input: { command: 'dangerous' },
      reason: "Rebel couldn't run its safety check.",
      timestamp: 1_780_000_000_100,
      allowPermanentTrust: false,
      effectiveToolId: 'Bash',
      blockedBy: 'eval_error',
    });

    expect(getPendingApprovals()).toEqual([
      expect.objectContaining({
        toolUseID: 'persisted-safety-prompt',
        blockedBy: 'safety_prompt',
      }),
      expect.objectContaining({
        toolUseID: 'persisted-eval-error',
        blockedBy: 'eval_error',
      }),
    ]);
  });

  it('backfills safety_prompt for legacy persisted tool approvals with the safety prefix', () => {
    storeState.pendingApprovals = [
      {
        toolUseID: 'legacy-safety-prompt',
        turnId: 'turn-legacy',
        sessionId: 'session-legacy',
        toolName: 'send_message',
        input: { text: 'hello' },
        reason: 'Safety Rules blocked: needs review',
        timestamp: 1_780_000_000_000,
      },
    ];

    expect(getPendingApprovals()).toEqual([
      expect.objectContaining({
        toolUseID: 'legacy-safety-prompt',
        blockedBy: 'safety_prompt',
      }),
    ]);
    expect(storeState.pendingApprovals[0]).not.toHaveProperty('blockedBy');
  });

  it('does not backfill non-safety reasons for legacy persisted tool approvals', () => {
    storeState.pendingApprovals = [
      {
        toolUseID: 'legacy-generic',
        turnId: 'turn-generic',
        sessionId: 'session-generic',
        toolName: 'send_message',
        input: { text: 'hello' },
        reason: 'Some other reason',
        timestamp: 1_780_000_000_000,
      },
    ];

    const approvals = getPendingApprovals();
    expect(approvals).toEqual([
      expect.objectContaining({
        toolUseID: 'legacy-generic',
      }),
    ]);
    expect(approvals[0].blockedBy).toBeUndefined();
    expect(storeState.pendingApprovals[0]).not.toHaveProperty('blockedBy');
  });

  it('does not overwrite existing eval_error blockedBy on prefixed persisted tool approvals', () => {
    storeState.pendingApprovals = [
      {
        toolUseID: 'legacy-eval-error',
        turnId: 'turn-eval',
        sessionId: 'session-eval',
        toolName: 'send_message',
        input: { text: 'hello' },
        reason: 'Safety Rules blocked: needs review',
        timestamp: 1_780_000_000_000,
        blockedBy: 'eval_error',
      },
    ];

    expect(getPendingApprovals()).toEqual([
      expect.objectContaining({
        toolUseID: 'legacy-eval-error',
        blockedBy: 'eval_error',
      }),
    ]);
  });
});
