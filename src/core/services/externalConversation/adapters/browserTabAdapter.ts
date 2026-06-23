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

import { type ExternalConversationAdapter, type DeliveryResult } from '../externalConversationAdapter';
import { type BrowserTabContext, tabContextsMateriallyMatch } from '../externalContext';
import type { ToolProvider } from '../types';

export const BROWSER_TAB_TOOLS: ToolProvider[] = [
  { name: 'rebel_browser_status' },
  { name: 'rebel_browser_read_page' },
  { name: 'rebel_browser_get_selection' },
  { name: 'rebel_browser_get_current_tab_url' },
  { name: 'rebel_browser_fill_form' },
  { name: 'rebel_browser_click' },
  { name: 'rebel_browser_scroll' },
];

export class BrowserTabAdapter implements ExternalConversationAdapter<BrowserTabContext> {
  readonly kind = 'browser-tab' as const;

  async deliverResponse(): Promise<DeliveryResult> {
    // browser is desktop, no persistence-across-restart needed for now.
    // Responses are delivered via existing App Bridge mechanisms (SSE).
    return { status: 'delivered' };
  }

  getContextTools(): ToolProvider[] {
    return BROWSER_TAB_TOOLS;
  }

  async resumePendingDeliveries(): Promise<void> {
    // no-op (browser is desktop, no persistence-across-restart needed for now)
  }

  formatInitialPrompt(args: { intent?: string; userText?: string; context: BrowserTabContext; pageContext?: { title?: string; url?: string; selection?: string } }): string {
    const { intent, userText, pageContext, context } = args;
    
    // Page context URL from args or context metadata
    const pageUrl = pageContext?.url ?? context.metadata.url;
    const pageTitle = pageContext?.title ?? context.metadata.title;

    const contextLine = pageTitle && pageUrl
      ? `\n\nTab: ${pageTitle} — ${pageUrl}`
      : pageUrl
        ? `\n\nTab: ${pageUrl}`
        : '';
        
    const selection = pageContext?.selection?.trim()
      ? `\n\nSelection:\n> ${pageContext.selection.trim().slice(0, 2_000).replace(/\n/g, '\n> ')}`
      : '';

    const MAX_TEXT_LEN = 16_000;

    switch (intent) {
      case 'summarise':
        return `Summarise the page I'm looking at.${contextLine}${selection}`;
      case 'save_to_notes':
        return `Save this page to my notes.${contextLine}${selection}`;
      case 'ask': {
        const question = userText?.trim();
        if (question) {
          return `${question.slice(0, MAX_TEXT_LEN)}${contextLine}${selection}`;
        }
        return `Help me understand this page.${contextLine}${selection}`;
      }
      case undefined:
      case 'chat':
      default: {
        const question = userText?.trim();
        if (question) {
          return `${question.slice(0, MAX_TEXT_LEN)}${contextLine}${selection}`;
        }
        return `Help me with this page.${contextLine}${selection}`;
      }
    }
  }

  assertContextCanBind(conversationId: string, context: BrowserTabContext, previousContext: BrowserTabContext | undefined): void {
    if (!previousContext) return;
    
    // Material match parity Check
    const expected = { tabId: previousContext.identity.tabId, url: previousContext.metadata.url };
    const actual = { tabId: context.identity.tabId, url: context.metadata.url };
    
    if (!tabContextsMateriallyMatch(expected, actual)) {
      // Throw an error that will be caught by the wrapper and re-thrown as AppBridgeError
      const err = new Error('That browser conversation belongs to a different tab.');
      (err as any).code = 'TAB_CONTEXT_DIVERGED';
      (err as any).status = 410;
      throw err;
    }
  }
}
