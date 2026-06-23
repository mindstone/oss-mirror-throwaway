/**
 * @intent-marker Unified External Conversation Architecture Stage 1
 *
 * Part of the unified external-conversation architecture (intent-critical).
 * Source of truth for intent: docs/plans/260502_unified_external_conversation_architecture.md
 *
 * KEY INVARIANTS (do not weaken without re-reading the planning doc):
 *  - Transport-agnostic core (§3 invariant 2) — adapter owns transport, contract has no transport assumptions
 *  - Cross-surface parity (§3 invariant 5) — same contract on desktop and cloud
 *  - Provenance on every cross-surface broadcast (§3 Spec Reader) — adapters MUST stamp provenance
 *  - Adapter-shaped extension point (§2 success criteria) — adding a surface = days, not weeks
 *  - D4: Webhook trust boundary lives in the adapter (verifyInbound), executed BEFORE any core call
 *  - D5: Four-state DeliveryResult, observable, persisted before send (resumePendingDeliveries is mandatory)
 *  - D6: Adapters own their context tools (return MCP descriptors, not implementations)
 *
 * @see docs/plans/260502_unified_external_conversation_architecture.md §5 (D-decisions), §6 (risks)
 */

import type { ExternalContext } from './externalContext';
import type { AgentResponse, ToolProvider, AttributionDescriptor } from './types';

/**
 * Four-state result, observable, never silent.
 */
export type DeliveryResult =
  | { status: 'delivered' }
  | { status: 'pending-confirmation'; reason: string; confirmationDeadline: number }
  | { status: 'transient-failure'; retryAt?: number; retryAfterSec?: number; reason: string }
  | { status: 'permanent-failure'; reason: string; userActionable: boolean };

export class WebhookAuthError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly userActionable: boolean,
  ) {
    super(message);
    this.name = 'WebhookAuthError';
  }
}

export type InboundVerificationDropResult =
  | { kind: 'workspace-not-connected'; reason?: string }
  | { kind: 'self-mention-ignored'; reason?: string }
  | { kind: 'signature-invalid'; reason?: string };

/**
 * Common shape for HTTP headers across environments.
 */
export interface HeadersLike {
  get(name: string): string | null | undefined;
}

export interface ExternalConversationAdapter<TCtx extends ExternalContext> {
  readonly kind: TCtx['kind'];

  /** Send a response back to the originating surface. */
  deliverResponse(args: {
    context: TCtx;
    conversationId: string;
    message: AgentResponse;
  }): Promise<DeliveryResult>;

  /** Surface-specific tools (e.g. "edit this paragraph", "post in this thread"). */
  getContextTools(context: TCtx): ToolProvider[];

  /**
   * Resumes pending deliveries after a restart, matching the persistence invariant.
   * On restart during retry-backoff, the cron-style sweeper resumes pending deliveries.
   */
  resumePendingDeliveries(): Promise<void>;

  /** Optional: how to format the initial prompt for this context. */
  formatInitialPrompt?(args: { intent?: string; userText?: string; context: TCtx; pageContext?: { title?: string; url?: string; selection?: string; text?: string } }): string;

  /** Optional: validate context before binding it. Throw an error (e.g., AppBridgeError) if divergence is detected. */
  assertContextCanBind?(conversationId: string, context: TCtx, previousContext: TCtx | undefined): void;

  /** Optional: how to render attribution back to the user (mobile viewer needs this). */
  renderAttribution?(context: TCtx): AttributionDescriptor;

  /** Webhook adapters only: signature + replay verification. */
  verifyInbound?(rawBody: Buffer, headers: HeadersLike): Promise<TCtx | InboundVerificationDropResult>;
}
