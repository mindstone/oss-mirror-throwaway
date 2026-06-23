import * as React from 'react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '../../lib/utils';
import styles from './IconTile.module.css';

export type IconTileTone =
  | 'default'
  | 'neutral'
  | 'meeting'
  | 'inbox'
  | 'automation'
  | 'role'
  | 'connector'
  | 'focus'
  | 'onboarding'
  | 'success'
  | 'warning';

export interface IconTileProps extends React.HTMLAttributes<HTMLSpanElement> {
  icon: LucideIcon;
  size?: 'sm' | 'md' | 'lg';
  tone?: IconTileTone;
}

export function IconTile({
  icon: Icon,
  size = 'md',
  tone = 'default',
  className,
  ...props
}: IconTileProps) {
  return (
    <span
      className={cn(
        styles.tile,
        styles[`size${size.charAt(0).toUpperCase()}${size.slice(1)}`],
        styles[`tone${tone.charAt(0).toUpperCase()}${tone.slice(1)}`],
        className,
      )}
      {...props}
    >
      <Icon aria-hidden="true" />
    </span>
  );
}
