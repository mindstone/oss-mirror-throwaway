/**
 * Connector approval gates — registry + generic API.
 *
 * The generic safety hook in `toolSafetyService.ts` calls only the two helpers
 * exported here. Connector-specific detection lives in sibling files
 * (`slackGates.ts`, etc.) and is wired in via the two arrays below. This is the
 * only place in the safety system that needs to know which connectors exist.
 *
 * Adding a new connector gate:
 *   1. Create `<connector>Gates.ts` with the typed records.
 *   2. Import and register them here.
 *   3. Add unit tests under `__tests__/`.
 */

import type {
  CohabitedTrustDecision,
  CohabitedTrustGate,
  InboundAutoApproveDecision,
  InboundAutoApproveGate,
  ToolApprovalContext,
} from './types';
import {
  SLACK_DIRECT_MESSAGE_TRUST_GATE,
  SLACK_INBOUND_REPLY_GATE,
} from './slackGates';

const COHABITED_TRUST_GATES: ReadonlyArray<CohabitedTrustGate> = [
  SLACK_DIRECT_MESSAGE_TRUST_GATE,
];

const INBOUND_AUTO_APPROVE_GATES: ReadonlyArray<InboundAutoApproveGate> = [
  SLACK_INBOUND_REPLY_GATE,
];

/**
 * If a cohabited-trust gate matches this call AND the safety prompt does not
 * explicitly grant permission for that surface, return the override; otherwise
 * `undefined`. The override forces approval even when the evaluator decided to
 * allow.
 */
export function getCohabitedTrustApprovalOverride(
  ctx: ToolApprovalContext,
  safetyPrompt: string,
): CohabitedTrustDecision | undefined {
  for (const gate of COHABITED_TRUST_GATES) {
    if (gate.matches(ctx) && !gate.hasExplicitPermission(safetyPrompt)) {
      return { gateId: gate.id, reason: gate.reason };
    }
  }
  return undefined;
}

/**
 * If the tool id is registered as an inbound auto-approve target, return the
 * decision; otherwise `undefined`. Callers should already have checked that
 * the session is an inbound-trigger session.
 */
export function getInboundAutoApproveDecision(
  effectiveToolId: string,
): InboundAutoApproveDecision | undefined {
  for (const gate of INBOUND_AUTO_APPROVE_GATES) {
    if (gate.toolIds.includes(effectiveToolId)) {
      return { gateId: gate.id, reason: gate.reason };
    }
  }
  return undefined;
}

export type { ToolApprovalContext } from './types';
