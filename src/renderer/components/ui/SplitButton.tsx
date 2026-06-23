/**
 * SplitButton component
 *
 * A split button with a primary action on the left and a dropdown trigger on the right.
 * Use for actions with common defaults but secondary options (e.g., "Save" with "Save as...").
 *
 * @example
 * <SplitButton
 *   onClick={() => handleSave()}
 *   dropdownItems={[
 *     { label: 'Save as...', onClick: handleSaveAs, icon: Save }
 *   ]}
 * >
 *   Save
 * </SplitButton>
 */
import { useState, useCallback, useRef, useEffect, type ReactNode, type FC } from 'react';
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
import { ChevronDown, type LucideIcon } from 'lucide-react';
import { cn } from '../../lib/utils';
import { Tooltip } from './Tooltip';
import styles from './SplitButton.module.css';

export type DropdownItem = {
  label: string;
  onClick: () => void;
  icon?: LucideIcon;
  /** Optional tooltip shown on hover */
  tooltip?: string;
};

export type SplitButtonProps = {
  /** Primary button label */
  children: ReactNode;
  /** Primary action handler */
  onClick: () => void;
  /** Disable primary button */
  disabled?: boolean;
  /** Button type attribute */
  type?: 'button' | 'submit';
  /** Button size */
  size?: 'sm' | 'md' | 'lg';
  /** Visual variant — 'default' uses solid primary background, 'outline' uses transparent with border */
  variant?: 'default' | 'outline';
  /** Dropdown menu items */
  dropdownItems: DropdownItem[];
  /** Disable dropdown trigger */
  dropdownDisabled?: boolean;
  /** Tooltip for primary button (native title attribute) */
  title?: string;
  /** Shows loading state — disables both buttons and applies muted styling */
  loading?: boolean;
};

export const SplitButton: FC<SplitButtonProps> = ({
  children,
  onClick,
  disabled = false,
  type = 'button',
  size = 'md',
  variant = 'default',
  dropdownItems,
  dropdownDisabled = false,
  title,
  loading = false,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const [focusedIndex, setFocusedIndex] = useState(-1);

  const { refs, floatingStyles, context, isPositioned } = useFloating({
    open: isOpen,
    onOpenChange: setIsOpen,
    placement: 'bottom-end',
    middleware: [
      offset(4),
      flip({ padding: 8 }),
      shift({ padding: 8 })
    ],
    whileElementsMounted: autoUpdate
  });

  const click = useClick(context);
  const dismiss = useDismiss(context);
  const role = useRole(context, { role: 'menu' });

  const { getReferenceProps, getFloatingProps } = useInteractions([
    click,
    dismiss,
    role
  ]);

  // Reset focus index when menu closes
  useEffect(() => {
    if (!isOpen) {
      setFocusedIndex(-1);
    }
  }, [isOpen]);

  // Keyboard navigation for dropdown
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (!isOpen) {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        setIsOpen(true);
      }
      return;
    }

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setFocusedIndex(prev => 
          prev < dropdownItems.length - 1 ? prev + 1 : 0
        );
        break;
      case 'ArrowUp':
        e.preventDefault();
        setFocusedIndex(prev => 
          prev > 0 ? prev - 1 : dropdownItems.length - 1
        );
        break;
      case 'Enter':
      case ' ':
        e.preventDefault();
        if (focusedIndex >= 0 && focusedIndex < dropdownItems.length) {
          dropdownItems[focusedIndex].onClick();
          setIsOpen(false);
        }
        break;
      case 'Escape':
        e.preventDefault();
        setIsOpen(false);
        break;
    }
  }, [isOpen, focusedIndex, dropdownItems]);

  const handleItemClick = useCallback((item: DropdownItem) => {
    item.onClick();
    setIsOpen(false);
  }, []);

  const sizeClass = {
    sm: styles.sizeSm,
    md: styles.sizeMd,
    lg: styles.sizeLg,
  }[size];

  const effectiveDisabled = disabled || loading;

  return (
    <div className={cn(styles.container, sizeClass, variant === 'outline' && styles.containerOutline, loading && styles.containerLoading)}>
      {/* Primary action button */}
      <button
        type={type}
        className={styles.primaryButton}
        onClick={onClick}
        disabled={effectiveDisabled}
        title={title}
      >
        {children}
      </button>

      {/* Divider between buttons */}
      <div className={styles.divider} />

      {/* Dropdown trigger */}
      <button
        ref={refs.setReference}
        type="button"
        className={styles.dropdownTrigger}
        aria-haspopup="menu"
        aria-expanded={isOpen}
        aria-label="More options"
        disabled={dropdownDisabled || effectiveDisabled}
        {...getReferenceProps({
          onKeyDown: handleKeyDown
        })}
      >
        <ChevronDown 
          size={size === 'sm' ? 14 : size === 'lg' ? 18 : 16} 
          className={cn(styles.chevron, isOpen && styles.chevronOpen)}
        />
      </button>

      {/* Dropdown menu */}
      {isOpen && (
        <FloatingPortal>
          <div
            ref={(node) => {
              refs.setFloating(node);
              if (menuRef.current !== node) {
                (menuRef as React.MutableRefObject<HTMLDivElement | null>).current = node;
              }
            }}
            style={floatingStyles}
            className={styles.menu}
            role="menu"
            data-positioned={isPositioned}
            {...getFloatingProps()}
          >
            {dropdownItems.map((item, index) => {
              const Icon = item.icon;
              const isFocused = index === focusedIndex;

              const menuButton = (
                <button
                  key={item.label}
                  type="button"
                  className={cn(styles.menuItem, isFocused && styles.menuItemFocused)}
                  role="menuitem"
                  tabIndex={-1}
                  onClick={() => handleItemClick(item)}
                  onMouseEnter={() => setFocusedIndex(index)}
                >
                  {Icon && (
                    <Icon size={14} strokeWidth={2} className={styles.menuItemIcon} />
                  )}
                  <span>{item.label}</span>
                </button>
              );

              return item.tooltip ? (
                <Tooltip key={item.label} content={item.tooltip} placement="left" delayShow={300}>
                  {menuButton}
                </Tooltip>
              ) : (
                menuButton
              );
            })}
          </div>
        </FloatingPortal>
      )}
    </div>
  );
};

SplitButton.displayName = 'SplitButton';
