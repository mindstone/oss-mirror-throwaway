/**
 * Tests for `pruneStaleApprovals` (REBEL-H7c).
 *
 * Approvals queue grows entries with a `timestamp` (ms since epoch) but has
 * no expiry. This sweep is intended to run once at startup and drop entries
 * older than a conservative TTL (30+ days) while leaving the recent-but-
 * stale range to the existing `approval_stuck` diagnostic.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const storeState: {
  pendingApprovals: unknown[];
  pendingMemoryApprovals: unknown[];
} = { pendingApprovals: [], pendingMemoryApprovals: [] };

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

import { pruneStaleApprovals } from '../pendingApprovalsStore';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = 1_780_000_000_000;

function toolApproval(toolUseID: string, ageDays: number) {
  return {
    toolUseID,
    turnId: `turn-${toolUseID}`,
    sessionId: `session-${toolUseID}`,
    toolName: 'Bash',
    input: {},
    timestamp: NOW - ageDays * DAY_MS,
  };
}

function memoryApproval(toolUseId: string, ageDays: number) {
  return {
    toolUseId,
    originalTurnId: `turn-${toolUseId}`,
    originalSessionId: `session-${toolUseId}`,
    turnId: `bg-turn-${toolUseId}`,
    sessionId: `bg-session-${toolUseId}`,
    filePath: '/tmp/x.md',
    spaceName: 'Personal',
    summary: 'x',
    content: 'x',
    timestamp: NOW - ageDays * DAY_MS,
  };
}

describe('pruneStaleApprovals', () => {
  beforeEach(() => {
    storeState.pendingApprovals = [];
    storeState.pendingMemoryApprovals = [];
    mockStore.get.mockClear();
    mockStore.set.mockClear();
  });

  it('removes tool approvals older than maxAgeMs and reports oldest age', () => {
    storeState.pendingApprovals = [
      toolApproval('fresh', 5),
      toolApproval('stale-31', 31),
      toolApproval('ancient-90', 90),
    ];

    const result = pruneStaleApprovals(30 * DAY_MS, NOW);

    expect(result.removedTool).toBe(2);
    expect(result.removedMemory).toBe(0);
    expect(result.oldestRemovedAgeMs).toBe(90 * DAY_MS);
    expect((storeState.pendingApprovals as { toolUseID: string }[]).map((r) => r.toolUseID))
      .toEqual(['fresh']);
  });

  it('removes memory approvals older than maxAgeMs', () => {
    storeState.pendingMemoryApprovals = [
      memoryApproval('m-fresh', 10),
      memoryApproval('m-stale', 45),
    ];

    const result = pruneStaleApprovals(30 * DAY_MS, NOW);

    expect(result.removedMemory).toBe(1);
    expect(result.removedTool).toBe(0);
    expect(result.oldestRemovedAgeMs).toBe(45 * DAY_MS);
    expect((storeState.pendingMemoryApprovals as { toolUseId: string }[]).map((r) => r.toolUseId))
      .toEqual(['m-fresh']);
  });

  it('does not call store.set when nothing is removed', () => {
    storeState.pendingApprovals = [toolApproval('fresh-1', 1), toolApproval('fresh-5', 5)];

    const result = pruneStaleApprovals(30 * DAY_MS, NOW);

    expect(result.removedTool).toBe(0);
    expect(result.removedMemory).toBe(0);
    expect(result.oldestRemovedAgeMs).toBeNull();
    expect(mockStore.set).not.toHaveBeenCalled();
  });

  it('leaves entries inside the conservative TTL window untouched', () => {
    storeState.pendingApprovals = [
      toolApproval('stuck-12', 12), // matches Hannah's oldest pending — 12 days
    ];

    const result = pruneStaleApprovals(30 * DAY_MS, NOW);

    expect(result.removedTool).toBe(0);
    expect((storeState.pendingApprovals as { toolUseID: string }[]).map((r) => r.toolUseID))
      .toEqual(['stuck-12']);
  });
});
