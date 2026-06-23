/**
 * Pending Approvals Diagnostic Tick
 *
 * Periodically inspects the pending tool/memory approval queues and emits an
 * `approval_stuck` diagnostic event when a request crosses an age bucket
 * (5/15/60/240 minutes). Each (approvalId, bucket) pair fires at most once
 * per process — we keep a per-id last-emitted bucket so the ledger captures
 * lifecycle transitions without filling up on repeated tick events.
 *
 * Why this exists (Stage 1b.2 of the diagnostics overhaul):
 *   - The approval store already tracks `timestamp`, but nothing surfaces
 *     "this request has been pending for hours" until the user notices.
 *   - Bug-report bundles can show queue churn in events.jsonl alongside the
 *     other emit-side signals (cooldowns, MCP transitions, abort_events).
 *
 * No tool name, no path, no content is included in the emit — only the
 * approval kind, the closed age bucket, and the queue depth.
 */

import { appendDiagnosticEvent } from '@core/services/diagnosticEventsLedger';
import {
  bucketApprovalAgeMinutes,
  type ApprovalAgeBucketMinutes,
  type ApprovalKind,
} from '@core/services/diagnostics/manifest';
import { createScopedLogger } from '@core/logger';

import {
  getPendingApprovals,
  getPendingMemoryApprovals,
  type PersistedMemoryApprovalRequest,
  type PersistedToolApprovalRequest,
} from './pendingApprovalsStore';

const log = createScopedLogger({ service: 'pendingApprovalsDiagnosticTick' });

/** Default tick interval. Five minutes balances signal vs main-process churn. */
export const DEFAULT_APPROVAL_TICK_MS = 5 * 60_000;

/**
 * Pure shape consumed by the planner so the periodic helper is trivially
 * testable without touching the real store / setInterval.
 */
export interface ApprovalsForTick {
  tools: ReadonlyArray<Pick<PersistedToolApprovalRequest, 'toolUseID' | 'timestamp'>>;
  memory: ReadonlyArray<Pick<PersistedMemoryApprovalRequest, 'toolUseId' | 'timestamp'>>;
}

export interface ApprovalStuckEmit {
  approvalKind: ApprovalKind;
  ageBucketMinutes: ApprovalAgeBucketMinutes;
  queueDepth: number;
}

export interface ApprovalStuckTickResult {
  emits: ApprovalStuckEmit[];
  /** Updated per-id last-emitted bucket map (caller persists across ticks). */
  nextLastEmittedBucket: Map<string, ApprovalAgeBucketMinutes>;
}

/**
 * Compose a synthetic id namespace per approval kind so the same opaque id
 * across kinds doesn't collide in the last-emitted bucket map.
 */
function approvalKey(kind: ApprovalKind, id: string): string {
  return `${kind}:${id}`;
}

/**
 * Plan emits for one tick. Pure function — no IO, no timers.
 *
 * Invariants:
 *   - Emits at most once per (approvalKey, bucket) pair across the process.
 *   - A given approval may emit multiple times AS IT AGES (5 → 15 → 60 → 240),
 *     but never twice in the same bucket.
 *   - Approvals younger than the smallest bucket are skipped.
 */
export function planApprovalStuckEmits(
  approvals: ApprovalsForTick,
  now: number,
  lastEmittedBucket: ReadonlyMap<string, ApprovalAgeBucketMinutes>,
): ApprovalStuckTickResult {
  const next = new Map(lastEmittedBucket);
  const emits: ApprovalStuckEmit[] = [];
  const toolDepth = approvals.tools.length;
  const memoryDepth = approvals.memory.length;

  for (const tool of approvals.tools) {
    const ageMinutes = (now - tool.timestamp) / 60_000;
    const bucket = bucketApprovalAgeMinutes(ageMinutes);
    if (bucket === null) continue;
    const key = approvalKey('tool', tool.toolUseID);
    const previous = next.get(key);
    if (previous === undefined || bucket > previous) {
      next.set(key, bucket);
      emits.push({ approvalKind: 'tool', ageBucketMinutes: bucket, queueDepth: toolDepth });
    }
  }

  for (const memory of approvals.memory) {
    const ageMinutes = (now - memory.timestamp) / 60_000;
    const bucket = bucketApprovalAgeMinutes(ageMinutes);
    if (bucket === null) continue;
    const key = approvalKey('memory', memory.toolUseId);
    const previous = next.get(key);
    if (previous === undefined || bucket > previous) {
      next.set(key, bucket);
      emits.push({ approvalKind: 'memory', ageBucketMinutes: bucket, queueDepth: memoryDepth });
    }
  }

  return { emits, nextLastEmittedBucket: next };
}

/**
 * Drop entries from the last-emitted-bucket map for approvals that are no
 * longer present (resolved/withdrawn). Keeps the map from growing unboundedly
 * across long-running sessions.
 */
export function pruneResolvedApprovals(
  approvals: ApprovalsForTick,
  lastEmittedBucket: ReadonlyMap<string, ApprovalAgeBucketMinutes>,
): Map<string, ApprovalAgeBucketMinutes> {
  const live = new Set<string>();
  for (const tool of approvals.tools) live.add(approvalKey('tool', tool.toolUseID));
  for (const memory of approvals.memory) live.add(approvalKey('memory', memory.toolUseId));
  const next = new Map<string, ApprovalAgeBucketMinutes>();
  for (const [key, bucket] of lastEmittedBucket) {
    if (live.has(key)) next.set(key, bucket);
  }
  return next;
}

// -----------------------------------------------------------------------------
// Wrapper service: setInterval-driven tick over the real approval store.
// -----------------------------------------------------------------------------

let timer: ReturnType<typeof setInterval> | null = null;
let lastEmittedBucket = new Map<string, ApprovalAgeBucketMinutes>();

function readApprovalsFromStore(): ApprovalsForTick {
  return {
    tools: getPendingApprovals().map((r) => ({ toolUseID: r.toolUseID, timestamp: r.timestamp })),
    memory: getPendingMemoryApprovals().map((r) => ({ toolUseId: r.toolUseId, timestamp: r.timestamp })),
  };
}

/** Run a single tick — exported for tests and bug-report flushes. */
export function runApprovalStuckTickOnce(now: number = Date.now()): void {
  try {
    const approvals = readApprovalsFromStore();
    lastEmittedBucket = pruneResolvedApprovals(approvals, lastEmittedBucket);
    const { emits, nextLastEmittedBucket } = planApprovalStuckEmits(approvals, now, lastEmittedBucket);
    lastEmittedBucket = nextLastEmittedBucket;
    for (const emit of emits) {
      appendDiagnosticEvent({
        kind: 'approval_stuck',
        data: emit,
      });
    }
    if (emits.length > 0) {
      log.info({ emits: emits.length }, 'Emitted approval_stuck diagnostic events');
    }
  } catch (err) {
    log.warn({ err }, 'Failed to plan approval-stuck tick');
  }
}

/**
 * Start the periodic tick. Idempotent: a second call replaces the interval
 * with the new period so callers can safely re-init across hot-reloads.
 */
export function startApprovalStuckDiagnosticTick(intervalMs: number = DEFAULT_APPROVAL_TICK_MS): void {
  if (timer !== null) clearInterval(timer);
  timer = setInterval(() => runApprovalStuckTickOnce(), intervalMs);
  if (typeof timer === 'object' && timer !== null && 'unref' in timer && typeof timer.unref === 'function') {
    timer.unref();
  }
}

export function stopApprovalStuckDiagnosticTick(): void {
  if (timer !== null) clearInterval(timer);
  timer = null;
}
