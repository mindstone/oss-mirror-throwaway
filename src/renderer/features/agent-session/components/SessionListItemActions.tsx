import { memo } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';
import { Star, CheckCircle2, RotateCcw, Cloud, CloudOff } from 'lucide-react';
import { IconButton } from '@renderer/components/ui';
import { Tooltip } from '@renderer/components/ui/Tooltip';
import { SessionActionsMenu, type ContextMenuAnchor } from './SessionActionsMenu';
import type { SessionMenuCallbacks } from './sessionMenuActions';
import styles from './AgentSessionSidebar.module.css';

export interface StarConfig {
  isStarred: boolean | undefined;
  onToggle: (sessionId: string, event: ReactMouseEvent<HTMLButtonElement>) => void;
}

export interface DoneToggleConfig {
  /** true = session is active (show Mark as done), false = session is done (show Reopen) */
  isActive: boolean | undefined;
  onToggle: (sessionId: string, event: ReactMouseEvent<HTMLButtonElement>) => void;
}

export interface CloudToggleConfig {
  isCloudActive: boolean | undefined;
  onToggle: (sessionId: string, event: ReactMouseEvent<HTMLButtonElement>) => void;
}

export interface SessionListItemActionsProps {
  sessionId: string;
  sessionTitle: string;
  /** Star button config. Omit to hide star button. */
  star?: StarConfig;
  /** Done/Reopen toggle config. Omit to hide toggle. */
  doneToggle?: DoneToggleConfig;
  /** Cloud continuity toggle config. Omit to hide cloud button. */
  cloudToggle?: CloudToggleConfig;
  /** SessionActionsMenu callbacks. Omit to hide menu. */
  menu?: SessionMenuCallbacks;
  /** Whether session is cloud_active (for cloud continuity toggle in the menu). */
  isCloudActive?: boolean;
  /** Context menu anchor for right-click trigger (controlled from parent) */
  contextAnchor?: ContextMenuAnchor | null;
  /** Callback to close context menu */
  onContextClose?: () => void;
}

/**
 * Unified action buttons for session list items.
 * Used by Starred, Active, Done sections and search results.
 * Trash section has different actions (Restore/Delete) and doesn't use this.
 *
 * Pressed-state contract (intentional, do not "fix"): star and cloud-active
 * use filled-icon-only as the data-state signal (`fill="currentColor"` on
 * the lucide icon). We deliberately do NOT pass the atom's `active` prop
 * here, because the atom's lavender pressed background is tuned for
 * prominent single-toggle surfaces (settings rows, info-panel toggles).
 * In a dense list-row with multiple toggles per row plus the row's own
 * indigo hover gradient and lift transform, lavender pressed backgrounds
 * stack into visual mud and compete with the row affordance. Filled-icon
 * is the established dense-list convention (Mail flag, Gmail star, Slack
 * pin) and the right density tier here.
 */
export const SessionListItemActions = memo(({
  sessionId,
  sessionTitle,
  star,
  doneToggle,
  cloudToggle,
  menu,
  isCloudActive,
  contextAnchor,
  onContextClose,
}: SessionListItemActionsProps) => {
  const handleButtonClick = (
    event: ReactMouseEvent<HTMLButtonElement>,
    handler: (id: string, e: ReactMouseEvent<HTMLButtonElement>) => void
  ) => {
    handler(sessionId, event);
    (event.currentTarget as HTMLButtonElement).blur();
  };

  return (
    <div className={styles.actions}>
      {star && (
        <Tooltip content={star.isStarred ? "Remove from Starred" : "Add to Starred"}>
          <IconButton
            size="xs"
            variant="ghost"
            className={styles.actionButton}
            onClick={(event) => handleButtonClick(event, star.onToggle)}
            aria-label={`${star.isStarred ? "Remove" : "Add"} ${sessionTitle} ${star.isStarred ? "from" : "to"} Starred`}
          >
            <Star
              className={styles.actionIcon}
              fill={star.isStarred ? "currentColor" : "none"}
              aria-hidden
            />
          </IconButton>
        </Tooltip>
      )}

      {doneToggle && (
        <Tooltip content={doneToggle.isActive !== false ? "Mark as done" : "Reopen"}>
          <IconButton
            size="xs"
            variant="ghost"
            className={styles.actionButton}
            onClick={(event) => handleButtonClick(event, doneToggle.onToggle)}
            aria-label={`${doneToggle.isActive !== false ? "Mark as done" : "Reopen"} ${sessionTitle}`}
          >
            {doneToggle.isActive !== false ? (
              <CheckCircle2 className={styles.actionIcon} aria-hidden />
            ) : (
              <RotateCcw className={styles.actionIcon} aria-hidden />
            )}
          </IconButton>
        </Tooltip>
      )}

      {cloudToggle && (
        <Tooltip content={cloudToggle.isCloudActive ? "Remove from cloud" : "Keep in cloud"}>
          <IconButton
            size="xs"
            variant="ghost"
            className={styles.actionButton}
            onClick={(event) => handleButtonClick(event, cloudToggle.onToggle)}
            aria-label={`${cloudToggle.isCloudActive ? "Remove" : "Keep"} ${sessionTitle} ${cloudToggle.isCloudActive ? "from" : "in"} cloud`}
          >
            {cloudToggle.isCloudActive ? (
              <Cloud
                className={styles.actionIcon}
                fill="currentColor"
                aria-hidden
              />
            ) : (
              <CloudOff className={styles.actionIcon} aria-hidden />
            )}
          </IconButton>
        </Tooltip>
      )}

      {menu && (
        <SessionActionsMenu
          sessionId={sessionId}
          sessionTitle={sessionTitle}
          isStarred={star?.isStarred}
          isActive={doneToggle?.isActive}
          isCloudActive={isCloudActive}
          callbacks={menu}
          contextAnchor={contextAnchor}
          onContextClose={onContextClose}
        />
      )}
    </div>
  );
});

SessionListItemActions.displayName = 'SessionListItemActions';
