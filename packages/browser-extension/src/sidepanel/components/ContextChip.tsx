/**
 * ContextChip — shows the page context a conversation was born with (Stage 6).
 *
 * Rendered at the top of an active conversation so the user can see what
 * page/URL Rebel is anchored to. The chip is deliberately subtle — one
 * row, muted colours, truncation with a tooltip for the full URL.
 *
 * Unlike `EmptyState`'s chip (which mirrors the *current* tab), this chip
 * reflects the conversation's frozen starting context stored in
 * `chatState.pageTitle` / `chatState.pageUrl`.
 *
 * @see docs/plans/260421_embedded_chat_in_extension.md (Stage 6)
 */
import type { ReactElement } from 'react';
import { buildContextChipViewModel } from '@rebel/shared/chatUI';

export interface ContextChipProps {
  /** Page title captured at conversation creation. */
  pageTitle?: string;
  /** Page URL captured at conversation creation. */
  pageUrl?: string;
}

function PageIcon(): ReactElement {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
      <path d="M14 3v6h6" />
    </svg>
  );
}

export default function ContextChip(props: ContextChipProps): ReactElement | null {
  const contextChip = buildContextChipViewModel(props);
  if (!contextChip) return null;

  return (
    <div
      className="context-chip"
      data-testid="context-chip"
      title={contextChip.tooltip}
    >
      <PageIcon />
      <span className="context-chip-text">{contextChip.primaryText}</span>
    </div>
  );
}
