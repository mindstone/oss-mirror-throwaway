/**
 * @intent-marker Unified External Conversation Architecture Stage 1
 *
 * Part of the unified external-conversation architecture (intent-critical).
 * Source of truth for intent: docs/plans/260502_unified_external_conversation_architecture.md
 *
 * KEY INVARIANTS (do not weaken without re-reading the planning doc):
 *  - Transport-agnostic core (§3 invariant 2)
 *  - Cross-surface parity (§3 invariant 5)
 *  - Provenance on every cross-surface broadcast (§3 Spec Reader)
 *  - Adapter-shaped extension point (§2 success criteria)
 */

import { randomUUID } from 'node:crypto';
import { deriveScopeKey, tabContextsMateriallyMatch } from './externalContext';
import type { ExternalContext } from './externalContext';
import type { ConversationScopeBinding } from './types';

export class ConversationScopeResolver {
  private readonly bindings = new Map<string, ConversationScopeBinding>();
  // O(1) scope-key index — keyed by `${kind}:${deriveScopeKey(ctx)}`.
  private readonly scopeKeyIndex = new Map<string, string>();

  constructor(private readonly maxBindings = 500) {}

  /**
   * Resolve an ExternalContext to a stable conversationId.
   *
   * @param ctx - the external context to resolve
   * @param forceConversationId - optional. If provided and no matching scope is found,
   *   use this conversationId for the new binding instead of minting a fresh UUID.
   *   Stage 3's lifecycle service uses this to inject into an existing conversation
   *   that was created via a different code path.
   */
  resolve(
    ctx: ExternalContext,
    forceConversationId?: string,
  ): { conversationId: string; isNewConversation: boolean } {
    const scopeKey = this.indexKey(ctx);
    const existing = this.scopeKeyIndex.get(scopeKey);
    if (existing !== undefined && this.bindings.has(existing)) {
      return { conversationId: existing, isNewConversation: false };
    }

    const conversationId = forceConversationId ?? randomUUID();
    this.bindConversation(conversationId, ctx);
    return { conversationId, isNewConversation: true };
  }

  lookup(ctx: ExternalContext): { conversationId: string } | null {
    const conversationId = this.scopeKeyIndex.get(this.indexKey(ctx));
    if (conversationId === undefined || !this.bindings.has(conversationId)) {
      return null;
    }
    return { conversationId };
  }

  private indexKey(ctx: ExternalContext): string {
    return deriveScopeKey(ctx);
  }

  matchesScope(a: ExternalContext, b: ExternalContext): boolean {
    return a.kind === b.kind && deriveScopeKey(a) === deriveScopeKey(b);
  }

  matchesFingerprint(a: ExternalContext, b: ExternalContext): boolean {
    if (a.kind !== b.kind) return false;

    switch (a.kind) {
      case 'browser-tab': {
        const tabA = a as Extract<ExternalContext, { kind: 'browser-tab' }>;
        const tabB = b as Extract<ExternalContext, { kind: 'browser-tab' }>;
        
        return tabContextsMateriallyMatch(
          { tabId: tabA.identity.tabId, url: tabA.metadata.url },
          { tabId: tabB.identity.tabId, url: tabB.metadata.url }
        );
      }
      case 'office-document':
      case 'slack-thread':
      case 'slack-mention-poll':
        return this.matchesScope(a, b);
      default:
        return false;
    }
  }

  bindConversation(conversationId: string, ctx: ExternalContext): void {
    if (!conversationId) return;
    const previous = this.bindings.get(conversationId);
    if (previous) {
      this.scopeKeyIndex.delete(this.indexKey(previous.context));
    }
    this.bindings.delete(conversationId);
    this.bindings.set(conversationId, {
      conversationId,
      context: ctx,
      boundAt: Date.now(),
    });
    this.scopeKeyIndex.set(this.indexKey(ctx), conversationId);

    while (this.bindings.size > this.maxBindings) {
      const oldestKey = this.bindings.keys().next().value;
      if (oldestKey) {
        const evicted = this.bindings.get(oldestKey);
        if (evicted) {
          this.scopeKeyIndex.delete(this.indexKey(evicted.context));
        }
        this.bindings.delete(oldestKey);
      } else {
        break;
      }
    }
  }

  getBinding(conversationId: string): ConversationScopeBinding | undefined {
    if (!conversationId) return undefined;
    return this.bindings.get(conversationId);
  }

  releaseBinding(conversationId: string): void {
    const binding = this.bindings.get(conversationId);
    if (binding) {
      this.scopeKeyIndex.delete(this.indexKey(binding.context));
    }
    this.bindings.delete(conversationId);
  }

  clearAll(): void {
    this.bindings.clear();
    this.scopeKeyIndex.clear();
  }
}

export const conversationScopeResolver = new ConversationScopeResolver();
