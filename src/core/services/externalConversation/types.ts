/**
 * @intent-marker Unified External Conversation Architecture Stage 1
 *
 * Part of the unified external-conversation architecture (intent-critical).
 * Source of truth for intent: docs/plans/260502_unified_external_conversation_architecture.md
 *
 * KEY INVARIANTS (do not weaken without re-reading the planning doc):
 *  - Transport-agnostic core (§3 invariant 2)
 *  - Cross-surface parity (§3 invariant 5)
 *  - Adapter-shaped extension point (§2 success criteria)
 *  - D9: ConversationScopeBinding holds (conversationId, context, boundAt) — context provides identity for deriveScopeKey
 *
 * NOTE: ToolProvider and AttributionDescriptor are placeholder shapes for Stage 1 (no consumers).
 * Stage 3 will refine these when adapter implementations land.
 *
 * @see docs/plans/260502_unified_external_conversation_architecture.md §4.2
 */

import type { AgentMessage } from '@core/agentRuntimeTypes';
import type { ExternalContext } from './externalContext';

export type AgentResponse = AgentMessage;

export interface ToolProvider {
  name: string;
  [key: string]: unknown;
}

export interface AttributionDescriptor {
  source: string;
  url?: string;
  [key: string]: unknown;
}

/**
 * Generalisation of BrowserConversationScopeBinding.
 * Used by the future ConversationScopeResolver.
 */
export interface ConversationScopeBinding<TCtx extends ExternalContext = ExternalContext> {
  conversationId: string;
  context: TCtx;
  boundAt: number;
}
