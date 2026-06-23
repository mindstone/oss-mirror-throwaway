import { type ReactNode, useState } from 'react';
import {
  autoUpdate,
  flip,
  FloatingPortal,
  offset,
  shift,
  useClick,
  useDismiss,
  useFloating,
  useInteractions,
  useRole,
} from '@floating-ui/react';
import { Copy, History, MoreHorizontal, Pencil, Trash2 } from 'lucide-react';
import menuStyles from '../../agent-session/components/SessionActionsMenu.module.css';
import styles from '../OperatorsPanel.module.css';

export type OperatorMoreMenuActionId = 'rename' | 'duplicate' | 'history' | 'remove';
type OperatorMoreMenuActionIcon = 'rename' | 'duplicate' | 'history' | 'remove';

export interface OperatorMoreMenuAction {
  id: OperatorMoreMenuActionId;
  label: string;
  icon: OperatorMoreMenuActionIcon;
  onSelect: () => void;
  isDanger?: boolean;
}

const ICON_MAP: Record<OperatorMoreMenuActionIcon, typeof Pencil> = {
  rename: Pencil,
  duplicate: Copy,
  history: History,
  remove: Trash2,
};

interface OperatorMoreMenuProps {
  actions: OperatorMoreMenuAction[];
  buttonLabel: string;
}

export function OperatorMoreMenu({ actions, buttonLabel }: OperatorMoreMenuProps): ReactNode {
  const [isOpen, setIsOpen] = useState(false);

  const { refs, floatingStyles, context, isPositioned } = useFloating({
    open: isOpen,
    onOpenChange: setIsOpen,
    placement: 'bottom-end',
    middleware: [offset(6), flip({ padding: 8 }), shift({ padding: 8 })],
    whileElementsMounted: autoUpdate,
  });

  const click = useClick(context);
  const dismiss = useDismiss(context);
  const role = useRole(context, { role: 'menu' });
  const { getReferenceProps, getFloatingProps } = useInteractions([click, dismiss, role]);

  return (
    <>
      <button
        type="button"
        ref={refs.setReference}
        className={styles.moreMenuButton}
        aria-label={buttonLabel}
        aria-haspopup="menu"
        aria-expanded={isOpen}
        data-testid="operator-card-more-button"
        {...getReferenceProps()}
      >
        <MoreHorizontal size={16} />
      </button>
      {isOpen && (
        <FloatingPortal>
          <div
            ref={refs.setFloating}
            className={menuStyles.menu}
            style={floatingStyles}
            data-positioned={isPositioned}
            {...getFloatingProps()}
          >
            {actions.map((action) => {
              const Icon = ICON_MAP[action.icon];
              return (
                <button
                  key={action.id}
                  type="button"
                  role="menuitem"
                  className={`${menuStyles.menuItem} ${action.isDanger ? menuStyles.menuItemDanger : ''}`.trim()}
                  data-testid={`operator-card-more-${action.id}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    setIsOpen(false);
                    action.onSelect();
                  }}
                >
                  <Icon size={14} strokeWidth={2} className={menuStyles.menuItemIcon} />
                  <span>{action.label}</span>
                </button>
              );
            })}
          </div>
        </FloatingPortal>
      )}
    </>
  );
}
