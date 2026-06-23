import { memo, useMemo } from 'react';
import { cn } from '@renderer/lib/utils';
import type { AgentSessionSidebarEntry } from '../types';
import { CheckCircle2, Plus } from 'lucide-react';
import { Tooltip } from '@renderer/components/ui/Tooltip';
import styles from './PinnedFavoritesTabs.module.css';

type PinnedFavoritesTabsProps = {
  pinnedSessions: AgentSessionSidebarEntry[];
  activeSessionId: string;
  onSelect: (sessionId: string) => void;
  onUnpin?: (sessionId: string) => void;
  onNewChat?: () => void;
  className?: string;
};

const MAX_VISIBLE_PINNED_TABS = 24;

export const PinnedFavoritesTabs = memo(
  ({ pinnedSessions, activeSessionId, onSelect, onUnpin, onNewChat, className }: PinnedFavoritesTabsProps) => {
    const visiblePinnedSessions = useMemo(() => {
      const active = pinnedSessions.find((entry) => entry.id === activeSessionId);
      const rest = pinnedSessions.filter((entry) => entry.id !== activeSessionId);
      return [
        ...(active ? [active] : []),
        ...rest.slice(0, MAX_VISIBLE_PINNED_TABS - (active ? 1 : 0)),
      ];
    }, [activeSessionId, pinnedSessions]);

    return (
      <div className={cn(styles.tabs, className)} role="tablist" aria-label="Pinned chats">
        {onNewChat && (
          <Tooltip content="New conversation" delayShow={300}>
            <button
              type="button"
              className={styles.newChatButton}
              onClick={onNewChat}
              aria-label="New conversation"
              data-testid="collapsed-new-chat-button"
            >
              <Plus size={14} aria-hidden />
            </button>
          </Tooltip>
        )}
        {visiblePinnedSessions.map((entry) => {
          const isActive = entry.id === activeSessionId;
          return (
            <button
              key={entry.id}
              type="button"
              role="tab"
              aria-selected={isActive}
              className={cn(styles.tab, isActive && styles.tabActive)}
              title={entry.title}
              onClick={() => onSelect(entry.id)}
            >
              <span className={styles.title}>{entry.title}</span>
              <span
                role="button"
                tabIndex={-1}
                className={styles.pin}
                title="Mark as done"
                aria-label={`Mark ${entry.title} as done`}
                onClick={(event) => {
                  event.stopPropagation();
                  onUnpin?.(entry.id);
                }}
              >
                <CheckCircle2 width={14} height={14} aria-hidden />
              </span>
            </button>
          );
        })}
      </div>
    );
  }
);

PinnedFavoritesTabs.displayName = 'PinnedFavoritesTabs';


