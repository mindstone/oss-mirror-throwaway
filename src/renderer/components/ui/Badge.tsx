import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../../lib/utils';
import styles from './Badge.module.css';

/**
 * Badge component for status indicators, labels, and chips.
 * Supports multiple visual variants and sizes.
 *
 * @example
 * <Badge>Default</Badge>
 * <Badge variant="success">Active</Badge>
 * <Badge variant="warning" size="lg">Pending</Badge>
 */

const badgeVariants = cva(styles.badge, {
  variants: {
    variant: {
      default: styles['badge--default'],
      primary: styles['badge--primary'],
      secondary: styles['badge--secondary'],
      success: styles['badge--success'],
      warning: styles['badge--warning'],
      info: styles['badge--info'],
      destructive: styles['badge--destructive'],
      outline: styles['badge--outline'],
      muted: styles['badge--muted']
    },
    size: {
      sm: styles['badge--sm'],
      md: styles['badge--md'],
      lg: styles['badge--lg']
    }
  },
  defaultVariants: {
    variant: 'default',
    size: 'md'
  }
});

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

export const Badge = React.forwardRef<HTMLSpanElement, BadgeProps>(
  ({ className, variant, size, ...props }, ref) => {
    return (
      <span ref={ref} className={cn(badgeVariants({ variant, size }), className)} {...props} />
    );
  }
);
Badge.displayName = 'Badge';
