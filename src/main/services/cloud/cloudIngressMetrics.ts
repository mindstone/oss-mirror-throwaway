/**
 * Cloud ingress observability metrics.
 *
 * In-memory counter for cloud WebSocket ingress rejections (R2 Stage 3a-D1).
 * Provides test-inspection visibility for the silent-failure-is-a-bug
 * compliance gate: every dropped frame must be observable via BOTH a
 * structured warn log AND this counter.
 *
 * **Production telemetry follow-on (Stage 3b candidate)**: this is in-memory
 * only. A follow-on chunk must wire the counter into the existing
 * Prometheus/metrics export pipeline so production drops are alertable, not
 * just log-grep-discoverable. Recorded in
 * `docs/plans/260502_r2_stage3a_residual_implementation_plan.md` § S3a-D1
 * "Follow-on (NOT in this chunk)".
 *
 * Refs: docs/plans/260502_r2_stage3a_residual_implementation_plan.md § S3a-D1
 */

export type CloudIngressRejectionReason =
  | 'pre-turnstarted-non-control'
  | 'manifest-reject'
  | 'post-turnstarted-control-error'
  | 'turnid-mismatch'
  | 'json-parse-failed';

interface CounterState {
  byReason: Record<CloudIngressRejectionReason, number>;
  total: number;
}

const state: CounterState = {
  byReason: {
    'pre-turnstarted-non-control': 0,
    'manifest-reject': 0,
    'post-turnstarted-control-error': 0,
    'turnid-mismatch': 0,
    'json-parse-failed': 0,
  },
  total: 0,
};

export const cloudIngressRejectionCounter = {
  inc(labels: { reason: CloudIngressRejectionReason }): void {
    state.byReason[labels.reason] += 1;
    state.total += 1;
  },
  /** Test inspection: returns a snapshot of current counts. */
  snapshot(): { byReason: Record<CloudIngressRejectionReason, number>; total: number } {
    return {
      byReason: { ...state.byReason },
      total: state.total,
    };
  },
  /** Test reset: clears all counts. Production code MUST NOT call this. */
  reset(): void {
    for (const key of Object.keys(state.byReason) as CloudIngressRejectionReason[]) {
      state.byReason[key] = 0;
    }
    state.total = 0;
  },
};

/**
 * Truncate a raw message string for bounded log output. Phase-2 P1 log-spam
 * guard: prevents adversarial or buggy upstream traffic from flooding
 * log-shipping subscribers.
 */
export const RAW_MESSAGE_LOG_PREVIEW_LIMIT = 256;

export function truncateRawMessageForLog(raw: unknown): string {
  let serialized: string;
  try {
    serialized = typeof raw === 'string' ? raw : JSON.stringify(raw);
  } catch {
    serialized = '<unserializable>';
  }
  if (serialized.length > RAW_MESSAGE_LOG_PREVIEW_LIMIT) {
    return serialized.slice(0, RAW_MESSAGE_LOG_PREVIEW_LIMIT) + `...[truncated; full length=${serialized.length}]`;
  }
  return serialized;
}
