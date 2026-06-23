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
import { MoreHorizontal, Star, Maximize2, Minimize2, BarChart3, SlidersHorizontal } from 'lucide-react';
import { Tooltip } from '@renderer/components/ui';
import {
  type SessionMenuAction,
  type SessionMenuActionId,
  type SessionMenuCallbacks,
  type SessionMenuContext,
  getActionsForContext,
  getActionLabel,
  getActionIcon,
  executeAction,
} from './sessionMenuActions';
import menuStyles from './SessionActionsMenu.module.css';
import styles from './ConversationActionsMenu.module.css';

/** Anchor point for context menu positioning (right-click coordinates) */
export interface ConversationContextMenuAnchor {
  x: number;
  y: number;
  /** Optional element for scroll ancestor detection (enables dismiss-on-scroll) */
  contextElement?: HTMLElement | null;
}

interface ConversationActionsMenuProps extends SessionMenuCallbacks {
  sessionId: string;
  sessionTitle: string;
  isStarred: boolean;
  /** True when the session is Active (`doneAt == null`). */
  isActive: boolean;
  /**
   * Optional anchor point for context menu mode (right-click trigger).
   * When provided, the menu opens at this position instead of the button.
   * Set to null to close the context menu.
   */
  contextAnchor?: ConversationContextMenuAnchor | null;
  /** Callback when context menu closes (for controlled context menu mode) */
  onContextClose?: () => void;
  /** When true, the pinned-tabs toolbar is visible above the conversation — shifts button down to avoid overlap */
  toolbarVisible?: boolean;
  /** Whether conversation is in full-width mode */
  isWideMode?: boolean;
  /** Toggle full-width mode */
  onToggleWideMode?: () => void;
  /** Toggle the diagnostics panel for this conversation */
  onToggleDiagnostics?: () => void;
  /** Whether diagnostics panel is currently active */
  isDiagnosticsActive?: boolean;
  /** Whether the session is busy (disables diagnostics toggle) */
  isBusy?: boolean;
  /** Whether the model override selector is visible */
  isModelOverrideVisible?: boolean;
  /** Toggle model override selector visibility */
  onToggleModelOverride?: () => void;
  /** Whether the session has messages (hides model toggle after first message) */
  hasMessages?: boolean;
}

/**
 * Renders menu items including the optional wide mode toggle at the top.
 */
function renderMenuItems(
  actions: SessionMenuAction[],
  menuContext: SessionMenuContext,
  isStarred: boolean,
  handleAction: (actionId: SessionMenuActionId, event: ReactMouseEvent<HTMLButtonElement>) => void,
  isWideMode: boolean,
  onToggleWideMode?: () => void,
  onClose?: () => void,
) {
  const WidthIcon = isWideMode ? Minimize2 : Maximize2;
  const shortcutHint = navigator.platform?.includes('Mac') ? '\u2318\u21E7F' : 'Ctrl+Shift+F';

  return (
    <>
      {onToggleWideMode && (
        <>
          <button
            type="button"
            className={menuStyles.menuItem}
            role="menuitem"
            onClick={(e) => {
              e.stopPropagation();
              onToggleWideMode();
              onClose?.();
            }}
          >
            <WidthIcon size={14} strokeWidth={2} className={menuStyles.menuItemIcon} />
            <span>{isWideMode ? 'Reading width' : 'Full width'}</span>
            <kbd className={menuStyles.menuItemShortcut}>{shortcutHint}</kbd>
          </button>
          <div className={menuStyles.menuDivider} />
        </>
      )}
      {actions.map((action, index) => {
        const Icon = getActionIcon(action, menuContext);
        const label = getActionLabel(action, menuContext);
        const showFilled = action.id === 'toggleStar' && isStarred;

        return (
          <div key={action.id}>
            {action.dividerBefore && index > 0 && (
              <div className={menuStyles.menuDivider} />
            )}
            <button
              type="button"
              className={`${menuStyles.menuItem} ${action.isDanger ? menuStyles.menuItemDanger : ''}`.trim()}
              role="menuitem"
              onClick={(e) => handleAction(action.id, e)}
            >
              {action.id === 'toggleStar' ? (
                <Star
                  size={14}
                  strokeWidth={2}
                  className={menuStyles.menuItemIcon}
                  fill={showFilled ? 'currentColor' : 'none'}
                />
              ) : (
                <Icon size={14} strokeWidth={2} className={menuStyles.menuItemIcon} />
              )}
              <span>{label}</span>
            </button>
          </div>
        );
      })}
    </>
  );
}

/**
 * Actions menu for the conversation view (top-right of main conversation area).
 * Uses the same shared action definitions as SessionActionsMenu for consistency.
 */
export const ConversationActionsMenu: FC<ConversationActionsMenuProps> = ({
  sessionId,
  sessionTitle,
  isStarred,
  isActive,
  onRename,
  onDelete,
  onFindSimilar,
  onToggleStar,
  onTogglePin,
  onCopyMarkdown,
  onExportMarkdown,
  onCopyLink,
  onShareConversation,
  onRevealInSidebar,
  onDiagnose,
  onExportLogs,
  onMoveToFolder,
  onRemoveFromFolder,
  isInFolder,
  contextAnchor,
  onContextClose,
  toolbarVisible = false,
  isWideMode = false,
  onToggleWideMode,
  onToggleDiagnostics,
  isDiagnosticsActive = false,
  isBusy = false,
  isModelOverrideVisible = false,
  onToggleModelOverride,
  hasMessages = false,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  
  // Context menu mode: controlled by external anchor
  const isContextMode = contextAnchor != null;

  // Virtual element for context menu positioning (at cursor coordinates)
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
  }), [isActive, isStarred, sessionId, sessionTitle]);

  const callbacks = useMemo<SessionMenuCallbacks>(() => ({
    onRename,
    onDelete,
    onFindSimilar,
    onToggleStar,
    onTogglePin,
    onCopyMarkdown,
    onExportMarkdown,
    onCopyLink,
    onShareConversation,
    onRevealInSidebar,
    onDiagnose,
    onExportLogs,
    onMoveToFolder,
    onRemoveFromFolder,
    isInFolder,
  }), [onCopyLink, onCopyMarkdown, onDelete, onDiagnose, onExportLogs, onExportMarkdown, onFindSimilar, onRename, onRevealInSidebar, onShareConversation, onTogglePin, onToggleStar, onMoveToFolder, onRemoveFromFolder, isInFolder]);

  const actions = getActionsForContext('conversation', callbacks);

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

  const closeButtonMenu = useCallback(() => setIsOpen(false), []);

  // In context menu mode, render only the menu (no button trigger)
  if (isContextMode) {
    return (
      <FloatingPortal>
        <div
          ref={refs.setFloating}
          style={floatingStyles}
          className={menuStyles.menu}
          role="menu"
          data-positioned={isPositioned}
          onClick={(e) => e.stopPropagation()}
          {...getFloatingProps()}
        >
          {renderMenuItems(actions, menuContext, isStarred, handleAction, isWideMode, onToggleWideMode, () => onContextClose?.())}
        </div>
      </FloatingPortal>
    );
  }

  return (
    <div className={`${styles.container} ${toolbarVisible ? styles.containerBelowToolbar : ''}`.trim()}>
      <Tooltip content="Conversation actions" disabled={isOpen}>
        <button
          ref={refs.setReference}
          type="button"
          className={`${styles.menuTrigger} ${isOpen ? styles.menuTriggerOpen : ''}`.trim()}
          aria-label={`Actions for ${sessionTitle}`}
          aria-haspopup="menu"
          aria-expanded={isOpen}
          {...getReferenceProps({
            onClick: (e) => e.stopPropagation(),
          })}
        >
          <MoreHorizontal size={18} strokeWidth={2} />
        </button>
      </Tooltip>
      {onToggleDiagnostics && (
        <Tooltip
          content={isBusy ? 'Available after turn completes' : (isDiagnosticsActive ? 'Close diagnostics' : 'View diagnostics')}
          disabled={isOpen}
        >
          <span>
            <button
              type="button"
              className={`${styles.menuTrigger} ${isDiagnosticsActive ? styles.menuTriggerOpen : ''}`.trim()}
              aria-label="Toggle diagnostics"
              aria-pressed={isDiagnosticsActive}
              disabled={isBusy}
              data-testid="diagnostics-toggle-button"
              onClick={(e) => { e.stopPropagation(); onToggleDiagnostics(); }}
            >
              <BarChart3 size={16} strokeWidth={2} />
            </button>
          </span>
        </Tooltip>
      )}
      {onToggleModelOverride && !hasMessages && (
        <Tooltip
          content={isModelOverrideVisible ? 'Hide model overrides' : 'Override models for this conversation'}
          disabled={isOpen}
        >
          <button
            type="button"
            className={`${styles.menuTrigger} ${isModelOverrideVisible ? styles.menuTriggerOpen : ''}`.trim()}
            aria-label="Toggle model overrides"
            aria-pressed={isModelOverrideVisible}
            data-testid="model-override-toggle-button"
            onClick={(e) => { e.stopPropagation(); onToggleModelOverride(); }}
          >
            <SlidersHorizontal size={16} strokeWidth={2} />
          </button>
        </Tooltip>
      )}
      {isOpen && (
        <FloatingPortal>
          <div
            ref={refs.setFloating}
            style={floatingStyles}
            className={menuStyles.menu}
            role="menu"
            data-positioned={isPositioned}
            onClick={(e) => e.stopPropagation()}
            {...getFloatingProps()}
          >
            {renderMenuItems(actions, menuContext, isStarred, handleAction, isWideMode, onToggleWideMode, closeButtonMenu)}
          </div>
        </FloatingPortal>
      )}
    </div>
  );
};

ConversationActionsMenu.displayName = 'ConversationActionsMenu';
