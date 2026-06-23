import * as React from 'react';
import { cn } from '../../lib/utils';
import styles from './IconButton.module.css';

export interface IconButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  size?: 'xs' | 'sm' | 'md' | 'lg';
  variant?: 'framed' | 'ghost' | 'subtle';
  active?: boolean;
  danger?: boolean;
}

export const IconButton = React.forwardRef<HTMLButtonElement, IconButtonProps>(
  (
    {
      className,
      size = 'md',
      variant = 'framed',
      active = false,
      danger = false,
      type = 'button',
      ...props
    },
    ref,
  ) => {
    return (
      <button
        ref={ref}
        type={type}
        className={cn(
          styles.button,
          styles[`size${size.charAt(0).toUpperCase()}${size.slice(1)}`],
          styles[`variant${variant.charAt(0).toUpperCase()}${variant.slice(1)}`],
          active && styles.active,
          danger && styles.danger,
          className,
        )}
        {...props}
      />
    );
  },
);

IconButton.displayName = 'IconButton';
