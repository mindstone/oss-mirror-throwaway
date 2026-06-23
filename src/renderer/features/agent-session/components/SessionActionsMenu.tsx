import { useState, useCallback, useEffect, useMemo, type FC, type MouseEvent as ReactMouseEvent } from 'react';
import {
  useFloating,
  autoUpdate,
  offset,
  flip,
  shift,
  useClick,
  useDismiss,
  useRole,
  useInteractions,
  FloatingPortal
} from '@floating-ui/react';
import { MoreHorizontal, Star } from 'lucide-react';
import { Tooltip } from '@renderer/components/ui';
import {
  type SessionMenuCallbacks,
  type SessionMenuContext,
  getActionsForContext,
  getActionLabel,
  getActionIcon,
  executeAction,
} from './sessionMenuActions';
import styles from './SessionActionsMenu.module.css';

/** Anchor point for context menu positioning (right-click coordinates) */
export interface ContextMenuAnchor {
  x: number;
  y: number;
  /** Optional element for scroll ancestor detection (enables dismiss-on-scroll) */
  contextElement?: HTMLElement | null;
}

type SessionActionsMenuProps = {
  sessionId: string;
  sessionTitle: string;
  /** Whether session is starred as favourite. Required for star toggle action. */
  isStarred?: boolean;
  /** Whether session is Active (`doneAt == null`). Required for done toggle action. */
  isActive?: boolean;
  /** Whether session is cloud_active. Required for cloud continuity toggle. */
  isCloudActive?: boolean;
  /** All menu action callbacks — passed through wholesale from sidebar. */
  callbacks: SessionMenuCallbacks;
  /**
   * Optional anchor point for context menu mode (right-click trigger).
   * When provided, the menu opens at this position instead of the button.
   * Set to null to close the context menu.
   */
  contextAnchor?: ContextMenuAnchor | null;
  /** Callback when context menu closes (for controlled context menu mode) */
  onContextClose?: () => void;
};

export const SessionActionsMenu: FC<SessionActionsMenuProps> = ({
  sessionId,
  sessionTitle,
  isStarred = false,
  isActive = true,
  isCloudActive,
  callbacks,
  contextAnchor,
  onContextClose,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  
  // Context menu mode: controlled by external anchor
  const isContextMode = contextAnchor != null;

  // Virtual element for context menu positioning (at cursor coordinates)
  // Includes contextElement for scroll ancestor detection
  const virtualElement = useMemo(() => {
    if (!contextAnchor) return null;
    return {
      getBoundingClientRect: () => ({
        width: 0,
        height: 0,
        x: contextAnchor.x,
        y: contextAnchor.y,
        top: contextAnchor.y,
        left: contextAnchor.x,
        right: contextAnchor.x,
        bottom: contextAnchor.y,
      }),
      contextElement: contextAnchor.contextElement ?? undefined,
    };
  }, [contextAnchor]);

  // Determine effective open state: button mode uses local state, context mode uses anchor presence
  const effectiveIsOpen = isContextMode ? true : isOpen;

  const handleOpenChange = useCallback((open: boolean) => {
    if (isContextMode) {
      // In context mode, closing is handled via onContextClose
      if (!open) {
        onContextClose?.();
      }
    } else {
      setIsOpen(open);
    }
  }, [isContextMode, onContextClose]);

  const { refs, floatingStyles, context, isPositioned } = useFloating({
    open: effectiveIsOpen,
    onOpenChange: handleOpenChange,
    placement: isContextMode ? 'bottom-start' : 'bottom-end',
    strategy: 'fixed',
    middleware: [
      offset(4),
      flip({ padding: 8 }),
      shift({ padding: 8 })
    ],
    whileElementsMounted: autoUpdate
  });

  // Set position reference based on mode
  useEffect(() => {
    if (isContextMode && virtualElement) {
      refs.setPositionReference(virtualElement);
    }
  }, [isContextMode, virtualElement, refs]);

  const click = useClick(context, { enabled: !isContextMode });
  const dismiss = useDismiss(context, { ancestorScroll: true });
  const role = useRole(context, { role: 'menu' });

  const { getReferenceProps, getFloatingProps } = useInteractions([
    click,
    dismiss,
    role
  ]);

  const menuContext = useMemo<SessionMenuContext>(() => ({
    sessionId,
    sessionTitle,
    isStarred,
    isActive,
    isCloudActive,
  }), [isCloudActive, isActive, isStarred, sessionId, sessionTitle]);

  const actions = getActionsForContext('sidebar', callbacks);

  const handleAction = useCallback(
    (actionId: Parameters<typeof executeAction>[0], event: ReactMouseEvent<HTMLButtonElement>) => {
      event.stopPropagation();
      executeAction(actionId, menuContext, callbacks, event);
      if (isContextMode) {
        onContextClose?.();
      } else {
        setIsOpen(false);
      }
    },
    [menuContext, callbacks, isContextMode, onContextClose]
  );

  // In context menu mode, skip rendering the button trigger
  if (isContextMode) {
    return (
      <FloatingPortal>
        <div
          ref={refs.setFloating}
          style={floatingStyles}
          className={styles.menu}
          role="menu"
          data-positioned={isPositioned}
          onClick={(e) => e.stopPropagation()}
          {...getFloatingProps()}
        >
          {actions.map((action, index) => {
            const Icon = getActionIcon(action, menuContext);
            const label = getActionLabel(action, menuContext);
            const showFilled = action.id === 'toggleStar' && isStarred;

            return (
              <div key={action.id}>
                {action.dividerBefore && index > 0 && (
                  <div className={styles.menuDivider} />
                )}
                <button
                  type="button"
                  className={`${styles.menuItem} ${action.isDanger ? styles.menuItemDanger : ''}`.trim()}
                  role="menuitem"
                  onClick={(e) => handleAction(action.id, e)}
                >
                  {action.id === 'toggleStar' ? (
                    <Star
                      size={14}
                      strokeWidth={2}
                      className={styles.menuItemIcon}
                      fill={showFilled ? 'currentColor' : 'none'}
                    />
                  ) : (
                    <Icon size={14} strokeWidth={2} className={styles.menuItemIcon} />
                  )}
                  <span>{label}</span>
                </button>
              </div>
            );
          })}
        </div>
      </FloatingPortal>
    );
  }

  return (
    <>
      <Tooltip content="More actions" disabled={isOpen}>
        <button
          ref={refs.setReference}
          type="button"
          className={`${styles.menuTrigger} ${isOpen ? styles.menuTriggerOpen : ''}`.trim()}
          aria-label={`More actions for ${sessionTitle}`}
          aria-haspopup="menu"
          aria-expanded={isOpen}
          {...getReferenceProps({
            onClick: (e) => e.stopPropagation(),
          })}
        >
          <MoreHorizontal size={16} strokeWidth={2} />
        </button>
      </Tooltip>
      {isOpen && (
        <FloatingPortal>
          <div
            ref={refs.setFloating}
            style={floatingStyles}
            className={styles.menu}
            role="menu"
            data-positioned={isPositioned}
            onClick={(e) => e.stopPropagation()}
            {...getFloatingProps()}
          >
            {actions.map((action, index) => {
              const Icon = getActionIcon(action, menuContext);
              const label = getActionLabel(action, menuContext);
              const showFilled = action.id === 'toggleStar' && isStarred;

              return (
                <div key={action.id}>
                  {action.dividerBefore && index > 0 && (
                    <div className={styles.menuDivider} />
                  )}
                  <button
                    type="button"
                    className={`${styles.menuItem} ${action.isDanger ? styles.menuItemDanger : ''}`.trim()}
                    role="menuitem"
                    onClick={(e) => handleAction(action.id, e)}
                  >
                    {action.id === 'toggleStar' ? (
                      <Star
                        size={14}
                        strokeWidth={2}
                        className={styles.menuItemIcon}
                        fill={showFilled ? 'currentColor' : 'none'}
                      />
                    ) : (
                      <Icon size={14} strokeWidth={2} className={styles.menuItemIcon} />
                    )}
                    <span>{label}</span>
                  </button>
                </div>
              );
            })}
          </div>
        </FloatingPortal>
      )}
    </>
  );
};

SessionActionsMenu.displayName = 'SessionActionsMenu';

