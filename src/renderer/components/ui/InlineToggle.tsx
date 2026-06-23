import * as React from 'react';
import { cn } from '../../lib/utils';
import { Toggle } from './Toggle';
import styles from './InlineToggle.module.css';

export interface InlineToggleProps extends Omit<React.LabelHTMLAttributes<HTMLLabelElement>, 'onChange'> {
  checked: boolean;
  label: React.ReactNode;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  toggleId?: string;
  stopPropagation?: boolean;
  toggleClassName?: string;
}

export const InlineToggle = React.forwardRef<HTMLLabelElement, InlineToggleProps>(
  (
    {
      checked,
      className,
      label,
      onCheckedChange,
      disabled = false,
      toggleId,
      stopPropagation = false,
      toggleClassName,
      onClick,
      ...props
    },
    ref,
  ) => {
    return (
      <label
        ref={ref}
        className={cn(styles.root, checked && styles.checked, disabled && styles.disabled, className)}
        data-checked={checked}
        data-disabled={disabled}
        onClick={(event) => {
          if (stopPropagation) {
            event.stopPropagation();
          }
          onClick?.(event);
        }}
        {...props}
      >
        <Toggle
          id={toggleId}
          checked={checked}
          disabled={disabled}
          onCheckedChange={onCheckedChange}
          className={cn(styles.toggle, toggleClassName)}
        />
        <span className={styles.label}>{label}</span>
      </label>
    );
  },
);

InlineToggle.displayName = 'InlineToggle';
