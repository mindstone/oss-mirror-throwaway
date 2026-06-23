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
import type { OfficeDocumentContext } from '../externalContext';
import type { ToolProvider } from '../types';

export const OFFICE_DOCUMENT_TOOLS: ToolProvider[] = [
  // Placeholder names; actual tools might be registered by the sidecar MCP.
  // We include one just to satisfy the contract of getContextTools returning something,
  // or return an empty array if tools are provided separately by the sidecar server.
  // Actually, the requirements say "Tool descriptor list matches Office sidecar tools"
  { name: 'rebel_office_read_document' },
  { name: 'rebel_office_write_document' },
];

export class OfficeDocumentAdapter implements ExternalConversationAdapter<OfficeDocumentContext> {
  readonly kind = 'office-document' as const;

  async deliverResponse(): Promise<DeliveryResult> {
    // Like browser-tab, desktop handles delivery.
    return { status: 'delivered' };
  }

  getContextTools(): ToolProvider[] {
    return OFFICE_DOCUMENT_TOOLS;
  }

  async resumePendingDeliveries(): Promise<void> {
    // no-op
  }

  private resolveDocumentLabel(host?: string): 'Document' | 'Workbook' | 'Presentation' {
    switch (host) {
      case 'excel':
        return 'Workbook';
      case 'powerpoint':
        return 'Presentation';
      case undefined:
      default:
        return 'Document';
    }
  }

  private formatDocumentContextLine(context: OfficeDocumentContext): string {
    const label = this.resolveDocumentLabel(context.identity.host);
    const title = context.metadata.title?.trim();
    if (title) {
      return `\n\n${label}: ${title}`;
    }
    if (context.identity.host) {
      return `\n\n${label}: ${context.identity.host}`;
    }
    return `\n\n${label}: current Office file`;
  }

  formatInitialPrompt(args: { intent?: string; userText?: string; context: OfficeDocumentContext; pageContext?: { selection?: string } }): string {
    const { intent, userText, context, pageContext } = args;
    
    const contextNoun = this.resolveDocumentLabel(context.identity.host).toLowerCase();
    const contextLine = this.formatDocumentContextLine(context);
        
    const selection = pageContext?.selection?.trim()
      ? `\n\nSelection:\n> ${pageContext.selection.trim().slice(0, 2_000).replace(/\n/g, '\n> ')}`
      : '';

    const MAX_TEXT_LEN = 16_000;

    switch (intent) {
      case 'summarise':
        return `Summarise the ${contextNoun} I'm looking at.${contextLine}${selection}`;
      case 'save_to_notes':
        return `Save this ${contextNoun} to my notes.${contextLine}${selection}`;
      case 'ask': {
        const question = userText?.trim();
        if (question) {
          return `${question.slice(0, MAX_TEXT_LEN)}${contextLine}${selection}`;
        }
        return `Help me understand this ${contextNoun}.${contextLine}${selection}`;
      }
      case undefined:
      case 'chat':
      default: {
        const question = userText?.trim();
        if (question) {
          return `${question.slice(0, MAX_TEXT_LEN)}${contextLine}${selection}`;
        }
        return `Help me with this ${contextNoun}.${contextLine}${selection}`;
      }
    }
  }
}
