/**
 * RichSelect component
 *
 * A custom select dropdown that supports rich content (title + description) for each option.
 * Use when users need contextual help to understand their choices.
 *
 * @example
 * <RichSelect
 *   value={selected}
 *   onChange={setSelected}
 *   options={[
 *     { value: 'auto', label: 'Auto-save', description: 'Save automatically without asking' },
 *     { value: 'smart', label: 'Smart check', description: 'Ask for sensitive content' },
 *   ]}
 * />
 */
import { useState, useCallback, useEffect, type ReactNode } from 'react';
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
import { ChevronDown, Check, type LucideIcon } from 'lucide-react';
import { cn } from '../../lib/utils';
import styles from './RichSelect.module.css';

export type RichSelectOption<T extends string = string> = {
  /** The value to be selected */
  value: T;
  /** Primary label displayed in the option */
  label: string;
  /** Description text shown below the label */
  description: string;
  /** Optional icon shown before the label */
  icon?: LucideIcon;
};

export type RichSelectProps<T extends string = string> = {
  /** Currently selected value */
  value: T;
  /** Callback when selection changes */
  onChange: (value: T) => void;
  /** Available options */
  options: RichSelectOption<T>[];
  /** Placeholder when no value selected */
  placeholder?: string;
  /** Disable the select */
  disabled?: boolean;
  /** Custom trigger content (overrides default display) */
  trigger?: ReactNode;
  /** Additional class for the trigger button */
  className?: string;
  /** Size variant */
  size?: 'sm' | 'md';
  /** Optional icon to show before the selected label */
  triggerIcon?: LucideIcon;
};

export function RichSelect<T extends string = string>({
  value,
  onChange,
  options,
  placeholder = 'Select option...',
  disabled = false,
  trigger,
  className,
  size = 'md',
  triggerIcon: TriggerIcon,
}: RichSelectProps<T>) {
  const [isOpen, setIsOpen] = useState(false);
  const [focusedIndex, setFocusedIndex] = useState(-1);

  const selectedOption = options.find(opt => opt.value === value);

  const { refs, floatingStyles, context, isPositioned, x, y } = useFloating({
    open: isOpen,
    onOpenChange: setIsOpen,
    placement: 'bottom-start',
    middleware: [
      offset(4),
      flip({ padding: 8 }),
      shift({ padding: 8 })
    ],
    whileElementsMounted: autoUpdate
  });

  // Prevent the “top-left flash” by only showing the menu once we have real coords.
  // (In some cases isPositioned flips true briefly before final x/y settle.)
  const hasCoords = x != null && y != null;
  const isVisuallyPositioned = isPositioned && hasCoords;

  const click = useClick(context);
  const dismiss = useDismiss(context);
  const role = useRole(context, { role: 'listbox' });

  const { getReferenceProps, getFloatingProps } = useInteractions([
    click,
    dismiss,
    role
  ]);

  // Reset focus index when menu closes
  useEffect(() => {
    if (!isOpen) {
      setFocusedIndex(-1);
    } else {
      // Focus on currently selected option when opening
      const currentIndex = options.findIndex(opt => opt.value === value);
      if (currentIndex >= 0) {
        setFocusedIndex(currentIndex);
      }
    }
  }, [isOpen, options, value]);

  // Keyboard navigation
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (!isOpen) {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') {
        e.preventDefault();
        setIsOpen(true);
      }
      return;
    }

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setFocusedIndex(prev => 
          prev < options.length - 1 ? prev + 1 : 0
        );
        break;
      case 'ArrowUp':
        e.preventDefault();
        setFocusedIndex(prev => 
          prev > 0 ? prev - 1 : options.length - 1
        );
        break;
      case 'Enter':
      case ' ':
        e.preventDefault();
        if (focusedIndex >= 0 && focusedIndex < options.length) {
          onChange(options[focusedIndex].value);
          setIsOpen(false);
        }
        break;
      case 'Escape':
        e.preventDefault();
        setIsOpen(false);
        break;
      case 'Tab':
        setIsOpen(false);
        break;
    }
  }, [isOpen, focusedIndex, options, onChange]);

  const handleOptionClick = useCallback((optionValue: T) => {
    onChange(optionValue);
    setIsOpen(false);
  }, [onChange]);

  return (
    <div className={cn(styles.container, className)}>
      {/* Trigger button */}
      <button
        ref={refs.setReference}
        type="button"
        className={cn(
          styles.trigger,
          size === 'sm' && styles.triggerSm,
          isOpen && styles.triggerOpen,
          disabled && styles.triggerDisabled
        )}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        {...getReferenceProps({
          onKeyDown: handleKeyDown
        })}
      >
        {trigger ?? (
          <span className={styles.triggerContent}>
            {TriggerIcon && <TriggerIcon size={16} className={styles.triggerIcon} />}
            <span className={cn(styles.triggerLabel, !selectedOption && styles.triggerPlaceholder)}>
              {selectedOption?.label ?? placeholder}
            </span>
          </span>
        )}
        <ChevronDown 
          size={16} 
          className={cn(styles.chevron, isOpen && styles.chevronOpen)}
        />
      </button>

      {/* Dropdown menu */}
      {isOpen && (
        <FloatingPortal>
          <div
            ref={refs.setFloating}
            style={
              isVisuallyPositioned
                ? floatingStyles
                : {
                    position: 'fixed',
                    top: 0,
                    left: 0,
                    transform: 'translate(-10000px, -10000px)',
                  }
            }
            className={styles.menu}
            role="listbox"
            data-positioned={isVisuallyPositioned}
            {...getFloatingProps()}
          >
            {options.map((option, index) => {
              const Icon = option.icon;
              const isSelected = option.value === value;
              const isFocused = index === focusedIndex;

              return (
                <button
                  key={option.value}
                  type="button"
                  className={cn(
                    styles.option,
                    isSelected && styles.optionSelected,
                    isFocused && styles.optionFocused
                  )}
                  role="option"
                  aria-selected={isSelected}
                  tabIndex={-1}
                  onClick={() => handleOptionClick(option.value)}
                  onMouseEnter={() => setFocusedIndex(index)}
                >
                  <div className={styles.optionContent}>
                    {Icon && <Icon size={18} className={styles.optionIcon} />}
                    <div className={styles.optionText}>
                      <span className={styles.optionLabel}>{option.label}</span>
                      <span className={styles.optionDescription}>{option.description}</span>
                    </div>
                  </div>
                  {isSelected && (
                    <Check size={16} className={styles.checkIcon} />
                  )}
                </button>
              );
            })}
          </div>
        </FloatingPortal>
      )}
    </div>
  );
}

RichSelect.displayName = 'RichSelect';
