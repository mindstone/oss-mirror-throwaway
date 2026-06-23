// mobile/src/utils/turnFailureCopy.ts
//
// Plain-English, recoverable copy for a turn that failed terminally on the
// mobile/cloud surface (a persisted `outcome:"error"` from a terminal
// provider-route decision). Kept in its own module — free of socket, logger,
// and breadcrumb dependencies — so both the queued-drain path
// (`submitTurnViaSocket`) and the interactive send-and-done path
// (`sendAndDone`) can reuse it without dragging in heavier deps.

/**
 * Choose plain-English, recoverable copy for a persisted-error turn surfaced on
 * mobile. The provider's own message is honest on desktop but can mislead on
 * mobile/cloud — most notably the Mindstone "subscription isn't ready yet" copy,
 * which is wrong when the subscription IS ready but simply isn't reachable from
 * the cloud surface yet. Brand voice: dry, calm, useful; non-technical audience.
 *
 * The Mindstone copy was set by chief-designer review
 * (see docs/plans/260622_mobile-record-recreated-session/PLAN.md Decision Log
 * 2026-06-23). It is a Layer-3 swap point — see the branch comment below.
 */
export function resolveTurnFailureUserMessage(args: {
  provider?: string;
  errorKind?: string;
  providerMessage?: string;
}): string {
  const provider = (args.provider ?? '').trim();
  // LAYER-3 SWAP POINT — delete this entire branch when cloud managed-key parity
  // lands (see PLAN.md Layer 3). Today the managed Mindstone subscription can't be
  // served from the cloud surface, so a mobile turn routed there never runs. Don't
  // tell the user their subscription "isn't ready" — it is; it just runs on their
  // computer for now. The "for now" framing is pre-authorised obsolescence: when
  // Layer 3 ships, mobile falls through to the generic recoverable copy below.
  if (provider.toLowerCase() === 'mindstone') {
    return "Rebel's subscription runs on your computer for now. Open Rebel there to continue this conversation, and it'll sync back to your phone.";
  }
  // Other terminal provider-route reasons (reconnect needed, model unsupported,
  // missing key). The provider's own copy is reasonable here; prefer it, with a
  // calm, recoverable fallback.
  const providerMessage = (args.providerMessage ?? '').trim();
  if (providerMessage) {
    return providerMessage;
  }
  if (provider) {
    return `${provider} needs attention before this can run. Open Rebel on your computer to reconnect, then try again.`;
  }
  return "That message couldn't be sent — the connection needs attention. Open Rebel on your computer to sort it out, then try again.";
}
