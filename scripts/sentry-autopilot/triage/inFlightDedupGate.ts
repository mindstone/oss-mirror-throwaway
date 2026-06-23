import { extractStackFrames, fetchIssueDetail } from '../sentryRest.ts';
import { fingerprintTightHash } from './fingerprint.ts';
import type { TriageGate } from './index.ts';

function logWarn(data: Record<string, unknown> = {}, message: string): void {
  console.warn(JSON.stringify({ level: 'warn', component: 'sentry-autopilot-inflight-dedup-gate', message, ...data }));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const inFlightDedupGate: TriageGate = async (issue, ctx) => {
  const config = ctx.config;
  if (!config?.inFlightDedupEnabled) {
    return { decision: 'dispatch' };
  }

  if (!ctx.db) {
    logWarn(
      { gate: 'inflight-dedup', sentryId: issue.sentryId, fail_reason: 'missing_state_db' },
      'In-flight dedup gate failed open because no state DB was provided',
    );
    return { decision: 'dispatch' };
  }

  const windowHours = config.inFlightDedupWindowHours ?? 6;

  let fingerprintHash: string | null = null;
  try {
    const detail = await fetchIssueDetail(issue.sentryId, config);
    fingerprintHash = fingerprintTightHash(extractStackFrames(detail));
  } catch (error) {
    logWarn(
      {
        gate: 'inflight-dedup',
        sentryId: issue.sentryId,
        fail_reason: 'fingerprint_lookup_failed',
        error: errorMessage(error),
      },
      'In-flight dedup gate failed open because fingerprint extraction failed',
    );
    return { decision: 'dispatch' };
  }

  if (!fingerprintHash) {
    logWarn(
      { gate: 'inflight-dedup', sentryId: issue.sentryId, fail_reason: 'fingerprint_unavailable' },
      'In-flight dedup gate failed open because no tight fingerprint was computable',
    );
    return { decision: 'dispatch' };
  }

  try {
    const activeSentryId = ctx.db.findActiveIssueByFingerprint(
      fingerprintHash,
      issue.sentryId,
      windowHours,
    );
    if (activeSentryId) {
      return {
        decision: 'defer',
        gate: 'inflight-dedup',
        reason: `inflight-dedup:fingerprint=${fingerprintHash}:active=${activeSentryId}`,
        context: {
          fingerprint_hash: fingerprintHash,
        },
      };
    }
  } catch (error) {
    logWarn(
      {
        gate: 'inflight-dedup',
        sentryId: issue.sentryId,
        fail_reason: 'state_lookup_failed',
        error: errorMessage(error),
      },
      'In-flight dedup gate failed open because state lookup failed',
    );
    return { decision: 'dispatch' };
  }

  return {
    decision: 'dispatch',
    context: {
      fingerprint_hash: fingerprintHash,
    },
  };
};
