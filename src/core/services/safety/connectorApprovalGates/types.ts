/**
 * Connector approval gates — generic types.
 *
 * Two override patterns live here:
 *
 * 1. **Cohabited-trust gate** — for tools where a single trust grant ("you can
 *    send to this channel") would otherwise leak to recipients on a private,
 *    1:1 surface that the safety prompt's channel-level policy layer cannot
 *    address. Forces approval unless the safety prompt *explicitly* names
 *    that private surface.
 *
 * 2. **Inbound auto-approve gate** — for "reply" tools triggered by external
 *    inbound events (e.g. @-mentions) where there is no interactive renderer
 *    to surface an approval card. Auto-approves to avoid a stuck flow.
 *
 * The registry intentionally stays small and data-driven; the generic safety
 * service (`toolSafetyService.ts`) only knows about these two patterns. New
 * connector-specific gates are registered as plain records — no plug-in
 * machinery required.
 */

export interface ToolApprovalContext {
  /** Hook-reported tool name (may be a router wrapper). */
  toolName: string;
  /** Canonical tool id after alias resolution. */
  effectiveToolId: string;
  /** Connector / package id, if known. */
  packageId: string | undefined;
  /** Router-extracted package id (when the tool is wrapped). */
  routerPackageId: string | undefined;
  /** Router-extracted args (when the tool is wrapped). */
  routerArgs: Record<string, unknown>;
}

export interface CohabitedTrustGate {
  /** Stable machine identifier — used for logs and tests. */
  id: string;
  /** Does this gate apply to the call? */
  matches: (ctx: ToolApprovalContext) => boolean;
  /** Does the safety prompt explicitly grant permission for this surface? */
  hasExplicitPermission: (safetyPrompt: string) => boolean;
  /**
   * User-facing reason string surfaced as the block reason. Kept verbatim from
   * the original implementation so existing UX copy is preserved.
   */
  reason: string;
}

export interface InboundAutoApproveGate {
  /** Stable machine identifier — used for logs and tests. */
  id: string;
  /** Canonical tool ids to auto-approve on inbound-* sessions. */
  toolIds: ReadonlyArray<string>;
  /** User-facing reason fragment included in the approval message. */
  reason: string;
}

export interface CohabitedTrustDecision {
  gateId: string;
  reason: string;
}

export interface InboundAutoApproveDecision {
  gateId: string;
  reason: string;
}
