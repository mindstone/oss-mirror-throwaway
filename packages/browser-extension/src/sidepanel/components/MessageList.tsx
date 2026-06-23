/**
 * MessageList — the scrollable conversation transcript (Stage 6, polished Stage 7).
 *
 * Renders completed messages (user + assistant), the in-flight streaming
 * assistant response (with a blinking cursor), and a "Rebel is thinking…"
 * indicator when the turn has started but no tokens have arrived yet.
 *
 * Stage 7 adds:
 *   - Subtle relative timestamps next to each message ("just now", "2m ago").
 *     Timestamps re-render every 30s so they stay accurate.
 *   - A "↓ New messages" jump-to-bottom button that appears when the user
 *     has scrolled up AND new content has arrived since they did. Clicking
 *     it scrolls back to the bottom and clears the indicator.
 *
 * Auto-scroll: when new content arrives, we scroll to the bottom UNLESS the
 * user has scrolled up — we treat anything more than ~48px from the bottom
 * as "user is reading older content" and leave scroll alone.
 *
 * No markdown rendering in MVP — `white-space: pre-wrap` preserves line
 * breaks and spacing in the plain-text messages.
 *
 * @see docs/plans/260421_embedded_chat_in_extension.md (Stages 6 + 7)
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
} from 'react';
import {
  buildConversationEntries,
  SHARED_CHAT_UI_COPY,
  type ConversationEntryViewModel,
} from '@rebel/shared/chatUI';
import type { HistoryMessage } from '../../lib/intents';

export interface MessageListProps {
  /** Completed messages in chronological order. */
  messages: Array<HistoryMessage & { partial?: boolean }>;
  /** Partial assistant response being streamed from the current turn. */
  streamingText: string;
  /** Whether a turn is currently running. Drives the thinking indicator. */
  turnStatus: 'idle' | 'running';
}

/**
 * Distance from the bottom (in px) beyond which we treat the user as
 * actively reading older content and skip auto-scroll.
 */
const AUTO_SCROLL_THRESHOLD_PX = 48;

/** Tick the relative timestamps forward every 30s. */
const RELATIVE_TIME_TICK_MS = 30_000;

function isNearBottom(el: HTMLElement): boolean {
  const distanceFromBottom = el.scrollHeight - (el.scrollTop + el.clientHeight);
  return distanceFromBottom <= AUTO_SCROLL_THRESHOLD_PX;
}

function formatMessageTimestampTitle(date: Date): string {
  try {
    return date.toLocaleString();
  } catch {
    return '';
  }
}

function renderEntry(entry: ConversationEntryViewModel): ReactElement {
  switch (entry.kind) {
    case 'message':
      return (
        <div
          key={entry.id}
          className={`message message-${entry.role}`}
          data-testid={entry.role === 'user' ? 'user-message' : 'assistant-message'}
        >
          <div className="message-bubble">{entry.text}</div>
          {entry.partial && entry.partialLabel && (
            <div className="message-partial" data-testid="partial-indicator">
              {entry.partialLabel}
            </div>
          )}
          <div
            className="message-timestamp"
            data-testid="message-timestamp"
            title={entry.timestamp.title}
          >
            {entry.timestamp.relativeLabel}
          </div>
        </div>
      );
    case 'streaming':
      return (
        <div
          key={entry.id}
          className="message message-assistant message-streaming"
          data-testid="assistant-message"
        >
          <div className="message-bubble" data-testid="streaming-text">
            {entry.text}
            {entry.showCursor && (
              <span className="streaming-cursor" aria-hidden="true">
                │
              </span>
            )}
          </div>
        </div>
      );
    case 'thinking':
      return (
        <div
          key={entry.id}
          className="message message-assistant message-thinking"
          data-testid="thinking-indicator"
        >
          <div className="message-bubble message-bubble-thinking">
            <span className="thinking-dot" />
            <span className="thinking-dot" />
            <span className="thinking-dot" />
            <span className="thinking-label">{entry.label}</span>
          </div>
        </div>
      );
  }
}

export default function MessageList(props: MessageListProps): ReactElement {
  const { messages, streamingText, turnStatus } = props;
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const stickToBottomRef = useRef<boolean>(true);

  // `isAtBottom` mirrors `stickToBottomRef` but in React state so the
  // floating "New messages" button can toggle visibility.
  const [isAtBottom, setIsAtBottom] = useState(true);
  // `hasNewContent` latches true when content arrives while the user is
  // scrolled up; cleared when they jump back to the bottom (by clicking the
  // button or scrolling there manually).
  const [hasNewContent, setHasNewContent] = useState(false);
  // `now` powers relative-time display. Tick it every 30s so timestamps
  // stay honest without re-rendering on every animation frame.
  const [now, setNow] = useState(() => Date.now());
  const entries = useMemo(
    () =>
      buildConversationEntries({
        messages,
        streamingText,
        turnStatus,
        now,
        formatTimestampTitle: formatMessageTimestampTitle,
      }),
    [messages, streamingText, turnStatus, now],
  );

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), RELATIVE_TIME_TICK_MS);
    return (): void => clearInterval(timer);
  }, []);

  // Track whether the user is "stuck" to the bottom. If they scroll up
  // beyond the threshold, we stop auto-scrolling. Re-enter stickiness when
  // they scroll back down to the bottom.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = (): void => {
      const atBottom = isNearBottom(el);
      stickToBottomRef.current = atBottom;
      setIsAtBottom(atBottom);
      // Scrolling back to the bottom clears the "new messages" pip.
      if (atBottom) setHasNewContent(false);
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return (): void => {
      el.removeEventListener('scroll', onScroll);
    };
  }, []);

  // After every render where the content may have grown, scroll to bottom
  // if the user hasn't scrolled up. If they HAVE scrolled up, surface a
  // subtle pip so they know new content arrived.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (stickToBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    } else {
      // User is reading earlier content — don't yank them, but flag that
      // new stuff is waiting at the bottom.
      setHasNewContent(true);
    }
  }, [messages, streamingText, turnStatus]);

  const handleJumpToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    stickToBottomRef.current = true;
    setIsAtBottom(true);
    setHasNewContent(false);
  }, []);

  const showJumpToBottom = !isAtBottom && hasNewContent;

  return (
    <div className="message-list-wrap">
      <div ref={scrollRef} className="message-list" data-testid="message-list">
        {entries.map((entry) => renderEntry(entry))}
      </div>
      {showJumpToBottom && (
        <button
          type="button"
          className="jump-to-bottom"
          onClick={handleJumpToBottom}
          aria-label={SHARED_CHAT_UI_COPY.jumpToBottomAriaLabel}
          data-testid="jump-to-bottom"
        >
          <span aria-hidden="true">↓</span>
          <span>{SHARED_CHAT_UI_COPY.jumpToBottomLabel}</span>
        </button>
      )}
    </div>
  );
}
