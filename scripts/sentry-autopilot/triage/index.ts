import type { AutopilotConfig } from '../config.ts';
import { type PolledIssue, triageIssue } from '../poller.ts';
import type { StateDB } from '../state.ts';

export type TriageGateDecision = 'dispatch' | 'skip' | 'defer';

export interface TriageGateResult {
  decision: TriageGateDecision;
  reason?: string;
  gate?: string;
  metadata?: Record<string, string>;
  context?: Record<string, string>;
}

export interface TriageGateContext {
  config?: AutopilotConfig;
  db?: StateDB;
  gates?: readonly TriageGate[];
}

export type TriageGate = (
  issue: PolledIssue,
  ctx: TriageGateContext,
) => TriageGateResult | Promise<TriageGateResult>;

/**
 * Runs the pre-dispatch triage pipeline.
 *
 * Gate 0 intentionally preserves the existing `triageIssue` behaviour. Later
 * stages plug release-aware, Linear-dedup, and in-flight-dedup gates into the
 * extension surface exposed by `ctx.gates`.
 */
export async function runTriageGates(
  issue: PolledIssue,
  ctx: TriageGateContext = {},
): Promise<TriageGateResult> {
  const legacyDecision = triageIssue(issue);
  if (legacyDecision !== 'dispatch') {
    return { decision: legacyDecision, gate: 'poller-triage', reason: 'legacy-triage-skip' };
  }

  for (const gate of ctx.gates ?? []) {
    const result = await gate(issue, ctx);
    if (result.decision !== 'dispatch') {
      return result;
    }
  }

  return { decision: 'dispatch' };
}
