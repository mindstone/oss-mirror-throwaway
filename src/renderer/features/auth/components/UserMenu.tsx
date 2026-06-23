import { useCallback, useState, type ReactElement } from 'react';
import { LogOut, User } from 'lucide-react';
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
  FloatingPortal,
} from '@floating-ui/react';
import { useAuth } from '../hooks/useAuth';
import styles from './UserMenu.module.css';

type UserMenuVariant = 'sidebar' | 'header';

type UserMenuProps = {
  /** Display variant - 'sidebar' shows full name, 'header' shows avatar only */
  variant?: UserMenuVariant;
};

/**
 * User menu component.
 * - 'sidebar' variant: Shows user name/avatar with a dropdown for logout (bottom left of sidebar).
 * - 'header' variant: Shows avatar only with a dropdown for logout (top right header).
 */
export function UserMenu({ variant = 'sidebar' }: UserMenuProps): ReactElement | null {
  const { user, logout, isGuestMode, exitGuestMode } = useAuth();
  const isHeader = variant === 'header';
  
  // Open state for the dropdown
  const [isOpen, setIsOpen] = useState(false);

  // Floating UI setup with controlled open state
  const { refs, floatingStyles, context } = useFloating({
    open: isOpen,
    onOpenChange: setIsOpen,
    placement: isHeader ? 'bottom-end' : 'top-start',
    middleware: [
      offset(8),
      flip({ padding: 8 }),
      shift({ padding: 8 }),
    ],
    whileElementsMounted: autoUpdate,
  });

  const click = useClick(context);
  const dismiss = useDismiss(context);
  const role = useRole(context, { role: 'menu' });

  const { getReferenceProps, getFloatingProps } = useInteractions([
    click,
    dismiss,
    role,
  ]);

  const handleExitGuestMode = useCallback(() => {
    exitGuestMode();
  }, [exitGuestMode]);

  const handleLogout = useCallback(async () => {
    try {
      await logout();
    } catch {
      // Ignore logout errors - UI state already updated
    }
  }, [logout]);

  const containerClass = isHeader 
    ? `${styles.container} ${styles.containerHeader}` 
    : styles.container;
  
  const triggerClass = isHeader 
    ? `${styles.trigger} ${styles.triggerHeader}` 
    : styles.trigger;
  
  const dropdownClass = isHeader 
    ? `${styles.dropdown} ${styles.dropdownHeader}` 
    : styles.dropdown;

  // Guest mode UI
  if (isGuestMode && !user) {
    return (
      <div className={containerClass}>
        <button
          ref={refs.setReference}
          className={triggerClass}
          aria-label={isHeader ? 'Guest account menu' : undefined}
          {...getReferenceProps()}
        >
          <div className={styles.avatarFallback}>
            <User size={14} />
          </div>
          {!isHeader && <span className={styles.name}>Guest</span>}
        </button>

        {isOpen && (
          <FloatingPortal>
            <div
              ref={refs.setFloating}
              style={floatingStyles}
              className={dropdownClass}
              role="menu"
              {...getFloatingProps()}
            >
              <button
                className={styles.menuItem}
                onClick={handleExitGuestMode}
                role="menuitem"
              >
                <LogOut size={16} />
                <span>Exit Guest Mode</span>
              </button>
            </div>
          </FloatingPortal>
        )}
      </div>
    );
  }

  // Authenticated user UI
  if (!user) {
    return null;
  }

  const initials = user.name
    ? user.name.split(' ').map((n) => n[0]).join('').toUpperCase().slice(0, 2)
    : user.email[0].toUpperCase();

  const displayName = user.name || user.email;

  // In header variant, always show neutral initials avatar (no profile image)
  const avatarFallbackClass = isHeader 
    ? `${styles.avatarFallback} ${styles.avatarFallbackHeader}` 
    : styles.avatarFallback;

  return (
    <div className={containerClass}>
      <button
        ref={refs.setReference}
        className={triggerClass}
        aria-label={isHeader ? `${displayName} account menu` : undefined}
        {...getReferenceProps()}
      >
        {user.image && !isHeader ? (
          <img src={user.image} alt="" className={styles.avatar} referrerPolicy="no-referrer" />
        ) : (
          <div className={avatarFallbackClass}>
            {initials || <User size={14} />}
          </div>
        )}
        {!isHeader && <span className={styles.name}>{displayName}</span>}
      </button>

      {isOpen && (
        <FloatingPortal>
          <div
            ref={refs.setFloating}
            style={floatingStyles}
            className={dropdownClass}
            role="menu"
            {...getFloatingProps()}
          >
            <div className={styles.userInfo}>
              <span className={styles.userName}>{user.name || user.email}</span>
              {user.name && <span className={styles.userEmail}>{user.email}</span>}
            </div>
            <div className={styles.divider} />
            <button
              className={styles.menuItem}
              onClick={handleLogout}
              role="menuitem"
            >
              <LogOut size={16} />
              <span>Sign out</span>
            </button>
          </div>
        </FloatingPortal>
      )}
    </div>
  );
}
