/**
 * ChatHeader — the side panel's top bar (Stage 4).
 *
 * Minimal header: a connection-status dot, the "Rebel" title, and two action
 * buttons ("Open in Rebel", "Start Fresh"). Both buttons are present but
 * disabled when there's no active conversation — their handlers land in
 * later stages.
 *
 * @see docs/plans/260421_embedded_chat_in_extension.md (Stage 4)
 */
import type { ReactElement } from 'react';
import {
  SHARED_CHAT_UI_COPY,
  type SharedHeaderStatus,
} from '@rebel/shared/chatUI';

const STATUS_ARIA_LABELS: Record<SharedHeaderStatus, string> = {
  connected: 'Connected to Rebel',
  reconnecting: 'Reconnecting to Rebel',
  degraded: 'Rebel needs attention',
  'not-ready': 'Not connected to Rebel',
};

export interface ChatHeaderProps {
  /** Connection status — drives the coloured status dot. */
  status: SharedHeaderStatus;
  /**
   * Whether there's an active conversation. When false, the "Open in Rebel"
   * and "Start Fresh" buttons are disabled (nothing to open or reset).
   */
  hasConversation: boolean;
  /** Fires when the user clicks the "Open in Rebel" button. */
  onOpenInRebel?: () => void;
  /** Fires when the user clicks the "Start Fresh" button. */
  onStartFresh?: () => void;
}

function OpenInRebelIcon(): ReactElement {
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
      <path d="M7 17L17 7" />
      <path d="M8 7H17V16" />
    </svg>
  );
}

function StartFreshIcon(): ReactElement {
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
      <path d="M3 12a9 9 0 1 0 3-6.7" />
      <path d="M3 4v5h5" />
    </svg>
  );
}

export default function ChatHeader(props: ChatHeaderProps): ReactElement {
  const { status, hasConversation, onOpenInRebel, onStartFresh } = props;

  return (
    <header className="chat-header" data-testid="chat-header">
      <div className="chat-header-left">
        <span
          className="chat-header-status-dot"
          data-status={status}
          data-testid="chat-header-status-dot"
          aria-label={STATUS_ARIA_LABELS[status]}
          role="status"
        />
        <span className="chat-header-title">{SHARED_CHAT_UI_COPY.productName}</span>
      </div>
      <div className="chat-header-actions">
        <button
          type="button"
          className="chat-header-btn"
          onClick={onOpenInRebel}
          disabled={!hasConversation}
          title="Open this conversation in Rebel"
          aria-label="Open this conversation in Rebel"
          data-testid="chat-header-open-in-rebel"
        >
          <OpenInRebelIcon />
        </button>
        <button
          type="button"
          className="chat-header-btn"
          onClick={onStartFresh}
          disabled={!hasConversation}
          title="Start a new conversation"
          aria-label="Start a new conversation"
          data-testid="chat-header-start-fresh"
        >
          <StartFreshIcon />
        </button>
      </div>
    </header>
  );
}
