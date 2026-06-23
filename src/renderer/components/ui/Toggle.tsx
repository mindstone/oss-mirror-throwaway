import * as React from 'react';
import { cn } from '../../lib/utils';
import styles from './Toggle.module.css';

export interface ToggleProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type' | 'onChange'> {
  onCheckedChange?: (checked: boolean) => void;
}

export const Toggle = React.forwardRef<HTMLInputElement, ToggleProps>(
  ({ className, onCheckedChange, ...props }, ref) => {
    return (
      <input
        ref={ref}
        type="checkbox"
        className={cn(styles.toggle, className)}
        onChange={(event) => {
          onCheckedChange?.(event.target.checked);
        }}
        {...props}
      />
    );
  },
);

Toggle.displayName = 'Toggle';
