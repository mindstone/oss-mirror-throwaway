import { memo, useMemo, useCallback, useEffect, useState, type RefObject } from 'react';
import { ChevronsUp, ChevronUp, ChevronDown } from 'lucide-react';
import { Tooltip } from '@renderer/components/ui';
import { useVisibilityAwareInterval } from '@renderer/hooks/useVisibilityAwareInterval';
import type { AgentTurnMessage } from '@shared/types';
import type { ConversationPaneHandle } from './ConversationPane';
import styles from './ConversationNav.module.css';

interface ConversationNavProps {
  /** Whether user has scrolled away from bottom */
  isScrolledAway: boolean;
  /** Count of new messages since scrolling away */
  newMessageCount: number;
  /** All messages in the conversation */
  visibleMessages: AgentTurnMessage[];
  /** Ref to ConversationPane handle for scroll control */
  containerRef: RefObject<ConversationPaneHandle | null>;
  /** Current session ID - for state reset on session switch */
  currentSessionId: string;
  /** Hide on non-session surfaces */
  isInsightSurface?: boolean;
  isDiagnosticsSurface?: boolean;
  /** Jump to latest callback — clears sticky scroll-away latch and scrolls to bottom (FOX-2668) */
  onJumpToLatest?: (options?: { behavior?: 'auto' | 'smooth' }) => void;
}

/**
 * Consolidated conversation navigation component.
 * Provides navigation arrows for user messages and a "Jump to latest" pill.
 *
 * Layout: [⇑] [↑] [↓] [Jump to latest + badge]
 *
 * Visibility logic:
 * - Navigation arrows (top/prev/next): Show if 2+ user messages
 * - "Jump to latest" pill: Show only if scrolled away from bottom
 * - Entire component: Hide on insight surfaces
 */
export const ConversationNav = memo(({
  isScrolledAway,
  newMessageCount,
  visibleMessages,
  containerRef,
  currentSessionId,
  isInsightSurface = false,
  isDiagnosticsSurface = false,
  onJumpToLatest,
}: ConversationNavProps) => {
  // Track current user message position by ID (resolved to index on each render)
  const [currentUserMessageId, setCurrentUserMessageId] = useState<string | null>(null);

  // Compute indices of user messages (virtualization-safe, data-driven)
  const userMessageIndices = useMemo(() => {
    const indices: number[] = [];
    visibleMessages.forEach((msg, idx) => {
      if (msg.role === 'user') {
        indices.push(idx);
      }
    });
    return indices;
  }, [visibleMessages]);

  // Map message ID -> index for quick lookup
  const messageIdToIndex = useMemo(() => {
    const map = new Map<string, number>();
    visibleMessages.forEach((msg, idx) => {
      map.set(msg.id, idx);
    });
    return map;
  }, [visibleMessages]);

  // Reset position tracking on session switch
  useEffect(() => {
    setCurrentUserMessageId(null);
  }, [currentSessionId]);

  // Update current position based on visible range (virtualization-safe)
  const updateCurrentPosition = useCallback(() => {
    const range = containerRef.current?.getVisibleRange();
    if (!range || userMessageIndices.length === 0) return;

    // Find the first user message index that falls within the visible range
    // or the last user message before the visible range
    let foundId: string | null = null;
    for (let i = userMessageIndices.length - 1; i >= 0; i--) {
      const userIdx = userMessageIndices[i];
      if (userIdx <= range.endIndex) {
        foundId = visibleMessages[userIdx]?.id ?? null;
        break;
      }
    }

    if (foundId && foundId !== currentUserMessageId) {
      setCurrentUserMessageId(foundId);
    }
  }, [containerRef, userMessageIndices, visibleMessages, currentUserMessageId]);

  // Poll for position updates (scroll events from virtualization don't bubble reliably)
  // Pause completely when hidden - scroll position only matters when user can see the conversation
  useVisibilityAwareInterval(
    updateCurrentPosition,
    200,    // foreground: 200ms (original rate)
    null,   // background: pause completely
    [userMessageIndices.length] // Restart if message count changes
  );

  // Resolve current user message ID to its position in userMessageIndices
  const currentUserPosition = useMemo(() => {
    if (!currentUserMessageId) return 0;
    const msgIndex = messageIdToIndex.get(currentUserMessageId);
    if (msgIndex === undefined) return 0;
    const position = userMessageIndices.indexOf(msgIndex);
    return position >= 0 ? position : 0;
  }, [currentUserMessageId, messageIdToIndex, userMessageIndices]);

  // Navigation handlers
  const jumpToTop = useCallback(() => {
    containerRef.current?.scrollToIndex(0, { align: 'start', behavior: 'smooth' });
  }, [containerRef]);

  const jumpToLatest = useCallback(() => {
    if (onJumpToLatest) {
      onJumpToLatest({ behavior: 'smooth' });
    } else {
      containerRef.current?.scrollToBottom({ behavior: 'smooth' });
    }
  }, [containerRef, onJumpToLatest]);

  const goToPrevious = useCallback(() => {
    if (currentUserPosition <= 0 || userMessageIndices.length === 0) return;
    const prevIndex = userMessageIndices[currentUserPosition - 1];
    if (prevIndex !== undefined) {
      const prevMessage = visibleMessages[prevIndex];
      if (prevMessage) {
        setCurrentUserMessageId(prevMessage.id);
      }
      containerRef.current?.scrollToIndex(prevIndex, { align: 'center', behavior: 'smooth' });
    }
  }, [containerRef, currentUserPosition, userMessageIndices, visibleMessages]);

  const goToNext = useCallback(() => {
    if (currentUserPosition >= userMessageIndices.length - 1) return;
    const nextIndex = userMessageIndices[currentUserPosition + 1];
    if (nextIndex !== undefined) {
      const nextMessage = visibleMessages[nextIndex];
      if (nextMessage) {
        setCurrentUserMessageId(nextMessage.id);
      }
      containerRef.current?.scrollToIndex(nextIndex, { align: 'center', behavior: 'smooth' });
    }
  }, [containerRef, currentUserPosition, userMessageIndices, visibleMessages]);

  // Visibility logic
  const showNavArrows = userMessageIndices.length >= 2;
  const showJumpToLatest = isScrolledAway;

  // Don't render if on insight surface or nothing to show
  if (isInsightSurface || isDiagnosticsSurface || (!showNavArrows && !showJumpToLatest)) {
    return null;
  }

  // Can navigate?
  const canGoPrevious = currentUserPosition > 0;
  const canGoNext = currentUserPosition < userMessageIndices.length - 1;

  return (
    <div className={styles.container}>
      {showNavArrows && (
        <>
          <Tooltip content="Jump to first message" placement="top">
            <button
              type="button"
              className={styles.navButton}
              onClick={jumpToTop}
              aria-label="Jump to first message"
            >
              <ChevronsUp size={16} strokeWidth={2} />
            </button>
          </Tooltip>
          <Tooltip content="Previous user message" placement="top">
            <button
              type="button"
              className={styles.navButton}
              onClick={goToPrevious}
              disabled={!canGoPrevious}
              aria-label="Previous user message"
            >
              <ChevronUp size={16} strokeWidth={2.5} />
            </button>
          </Tooltip>
          <Tooltip content="Next user message" placement="top">
            <button
              type="button"
              className={styles.navButton}
              onClick={goToNext}
              disabled={!canGoNext}
              aria-label="Next user message"
            >
              <ChevronDown size={16} strokeWidth={2.5} />
            </button>
          </Tooltip>
        </>
      )}
      {showJumpToLatest && (
        <button
          type="button"
          className={styles.jumpButton}
          onClick={jumpToLatest}
          aria-label={`Jump to latest${newMessageCount > 0 ? ` (${newMessageCount} new)` : ''}`}
        >
          <ChevronDown size={16} className={styles.icon} aria-hidden />
          <span>Jump to latest</span>
          {newMessageCount > 0 && (
            <span className={styles.badge} aria-hidden>
              {newMessageCount > 9 ? '9+' : newMessageCount}
            </span>
          )}
        </button>
      )}
    </div>
  );
});

ConversationNav.displayName = 'ConversationNav';
