import { describe, it, expect } from 'vitest';
import {
  planApprovalStuckEmits,
  pruneResolvedApprovals,
  type ApprovalsForTick,
} from '../pendingApprovalsDiagnosticTick';
import type { ApprovalAgeBucketMinutes } from '@core/services/diagnostics/manifest';

const MIN = 60_000;
const baseNow = 1_700_000_000_000;

function tool(id: string, ageMinutes: number): ApprovalsForTick['tools'][number] {
  return { toolUseID: id, timestamp: baseNow - ageMinutes * MIN };
}
function memory(id: string, ageMinutes: number): ApprovalsForTick['memory'][number] {
  return { toolUseId: id, timestamp: baseNow - ageMinutes * MIN };
}

describe('planApprovalStuckEmits', () => {
  it('skips approvals younger than the smallest bucket', () => {
    const approvals: ApprovalsForTick = { tools: [tool('t1', 4)], memory: [] };
    const { emits, nextLastEmittedBucket } = planApprovalStuckEmits(approvals, baseNow, new Map());
    expect(emits).toEqual([]);
    expect(nextLastEmittedBucket.size).toBe(0);
  });

  it('emits once when an approval first crosses a bucket', () => {
    const approvals: ApprovalsForTick = { tools: [tool('t1', 7)], memory: [] };
    const { emits, nextLastEmittedBucket } = planApprovalStuckEmits(approvals, baseNow, new Map());
    expect(emits).toEqual([{ approvalKind: 'tool', ageBucketMinutes: 5, queueDepth: 1 }]);
    expect(nextLastEmittedBucket.get('tool:t1')).toBe(5);
  });

  it('does NOT re-emit on subsequent ticks at the same bucket', () => {
    const approvals: ApprovalsForTick = { tools: [tool('t1', 7)], memory: [] };
    const last = new Map<string, ApprovalAgeBucketMinutes>([['tool:t1', 5]]);
    const { emits, nextLastEmittedBucket } = planApprovalStuckEmits(approvals, baseNow, last);
    expect(emits).toEqual([]);
    expect(nextLastEmittedBucket.get('tool:t1')).toBe(5);
  });

  it('emits again when an approval ages past a higher bucket', () => {
    const approvals: ApprovalsForTick = { tools: [tool('t1', 20)], memory: [] };
    const last = new Map<string, ApprovalAgeBucketMinutes>([['tool:t1', 5]]);
    const { emits, nextLastEmittedBucket } = planApprovalStuckEmits(approvals, baseNow, last);
    expect(emits).toEqual([{ approvalKind: 'tool', ageBucketMinutes: 15, queueDepth: 1 }]);
    expect(nextLastEmittedBucket.get('tool:t1')).toBe(15);
  });

  it('reports the largest bucket crossed when a fresh tick lands at high age', () => {
    const approvals: ApprovalsForTick = { tools: [tool('t1', 300)], memory: [] };
    const { emits } = planApprovalStuckEmits(approvals, baseNow, new Map());
    expect(emits).toEqual([{ approvalKind: 'tool', ageBucketMinutes: 240, queueDepth: 1 }]);
  });

  it('namespaces tool vs memory IDs so the same id across kinds does not collide', () => {
    const approvals: ApprovalsForTick = {
      tools: [tool('shared-id', 7)],
      memory: [memory('shared-id', 7)],
    };
    const { emits } = planApprovalStuckEmits(approvals, baseNow, new Map());
    expect(emits).toHaveLength(2);
    expect(emits.map((e) => e.approvalKind).sort()).toEqual(['memory', 'tool']);
  });

  it('reports queue depth per kind, not the union', () => {
    const approvals: ApprovalsForTick = {
      tools: [tool('t1', 7), tool('t2', 7)],
      memory: [memory('m1', 7)],
    };
    const { emits } = planApprovalStuckEmits(approvals, baseNow, new Map());
    const tools = emits.filter((e) => e.approvalKind === 'tool');
    const mems = emits.filter((e) => e.approvalKind === 'memory');
    expect(tools.every((e) => e.queueDepth === 2)).toBe(true);
    expect(mems.every((e) => e.queueDepth === 1)).toBe(true);
  });

  it('handles an empty queue cleanly', () => {
    const { emits, nextLastEmittedBucket } = planApprovalStuckEmits(
      { tools: [], memory: [] },
      baseNow,
      new Map(),
    );
    expect(emits).toEqual([]);
    expect(nextLastEmittedBucket.size).toBe(0);
  });
});

describe('pruneResolvedApprovals', () => {
  it('drops bucket entries whose ids are no longer in the live queues', () => {
    const last = new Map<string, ApprovalAgeBucketMinutes>([
      ['tool:t1', 60],
      ['tool:t2', 15],
      ['memory:m1', 5],
    ]);
    const approvals: ApprovalsForTick = {
      tools: [tool('t1', 70)],
      memory: [],
    };
    const next = pruneResolvedApprovals(approvals, last);
    expect(next.size).toBe(1);
    expect(next.get('tool:t1')).toBe(60);
  });

  it('preserves entries that are still live', () => {
    const last = new Map<string, ApprovalAgeBucketMinutes>([['memory:m1', 240]]);
    const approvals: ApprovalsForTick = { tools: [], memory: [memory('m1', 300)] };
    const next = pruneResolvedApprovals(approvals, last);
    expect(next.get('memory:m1')).toBe(240);
  });

  it('returns an empty map when every approval has resolved', () => {
    const last = new Map<string, ApprovalAgeBucketMinutes>([['tool:t1', 5]]);
    const next = pruneResolvedApprovals({ tools: [], memory: [] }, last);
    expect(next.size).toBe(0);
  });
});
