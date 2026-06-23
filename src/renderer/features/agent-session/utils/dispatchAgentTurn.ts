/**
 * Renderer agent-turn dispatch chokepoint — every renderer-initiated
 * `agent:turn` outside the session-engine internals MUST go through
 * `dispatchAgentTurn`, which requires an EXPLICIT supersede decision.
 *
 * Why (postmortem 260610_queue_drain_cancels_turn, rec 10d93cdce18d854b):
 * `AgentTurnRequest.supersedePolicy` is optional on the wire for
 * backward/forward compatibility, and an OMITTED policy means legacy
 * supersede-on-busy — i.e. "cancel the target session's active turn".
 * A new dispatch site that simply forgets the field therefore silently
 * inherits *interrupt* semantics and can destroy a running turn (incident
 * f6b3e9b0: queue drain cancelled an in-flight background turn). This module
 * makes that omission unrepresentable at the call site: the type system
 * forces every caller to pick a decision, and the legacy escape hatch is
 * explicit + greppable instead of being a default you fall into.
 *
 * Decision → wire mapping:
 * - `{ policy: 'reject' }`        → `supersedePolicy: 'reject'` (typed
 *   `AGENT_TURN_TARGET_BUSY` refusal when the target is busy; never cancels).
 * - `{ policy: 'interrupt' }`     → `supersedePolicy: 'supersede'` (explicit
 *   cancel-the-active-turn intent, e.g. a user-facing "send now").
 * - `{ policy: 'inherit-legacy' }`→ field OMITTED on the wire (main-side
 *   default supersede backstop). Only for pre-seam call paths whose omission
 *   semantics are pinned by tests (see
 *   `useAgentSessionEngine.supersedePolicy.test.ts`); every entry must carry
 *   a `reason` so the escape hatch is auditable.
 *
 * Enforcement: `scripts/check-agent-turn-dispatch-chokepoint.ts` (wired into
 * `npm run validate:fast`) bans raw `agentApi.turn(` call sites in
 * `src/renderer/**` outside this module + a count-pinned allowlist of
 * engine internals.
 */
import type { AgentTurnRequest } from '@shared/types';

/**
 * Explicit admission decision for a renderer-dispatched turn. A caller cannot
 * construct a dispatch without choosing one — there is deliberately no
 * default and no optional form.
 */
export type AgentTurnSupersedeDecision =
  /** Refuse admission if the target session is busy (never cancels work). */
  | { policy: 'reject' }
  /** Explicitly cancel the target's active turn (user-facing interrupt). */
  | { policy: 'interrupt' }
  /**
   * Preserve legacy omission semantics (main-side supersede default).
   * `reason` is required so every use of the escape hatch documents itself
   * and is greppable for later tightening.
   */
  | { policy: 'inherit-legacy'; reason: string };

/**
 * Request shape accepted by the chokepoint: everything `agent:turn` takes
 * EXCEPT `supersedePolicy`, which is owned by the decision parameter so a
 * caller cannot smuggle a policy past the explicit-decision requirement.
 */
export type DispatchableAgentTurnRequest = Omit<AgentTurnRequest, 'supersedePolicy'>;

/**
 * The single sanctioned renderer dispatch seam for `agent:turn` outside the
 * session engine. See module doc for the decision → wire mapping.
 */
export async function dispatchAgentTurn(
  request: DispatchableAgentTurnRequest,
  supersede: AgentTurnSupersedeDecision,
): Promise<Awaited<ReturnType<Window['agentApi']['turn']>>> {
  const wireRequest: AgentTurnRequest =
    supersede.policy === 'inherit-legacy'
      ? request
      : {
          ...request,
          supersedePolicy: supersede.policy === 'reject' ? 'reject' : 'supersede',
        };
  // The ONLY sanctioned raw call site outside useAgentSessionEngine internals
  // (count-pinned by scripts/check-agent-turn-dispatch-chokepoint.ts).
  return window.agentApi.turn(wireRequest);
}
