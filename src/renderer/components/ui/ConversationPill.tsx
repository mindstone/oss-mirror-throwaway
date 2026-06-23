import * as React from 'react';
import { cn } from '../../lib/utils';
import styles from './ConversationPill.module.css';

export interface ConversationPillProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  title: string;
}

export const ConversationPill = React.forwardRef<HTMLButtonElement, ConversationPillProps>(
  ({ title, className, type = 'button', ...props }, ref) => (
    <button
      ref={ref}
      type={type}
      className={cn(styles.pill, className)}
      title={title}
      {...props}
    >
      <span className={styles.title}>{title}</span>
    </button>
  ),
);

ConversationPill.displayName = 'ConversationPill';
