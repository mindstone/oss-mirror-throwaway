import type { ReactNode } from 'react';
import { cn } from '../../lib/utils';
import styles from './SectionHeader.module.css';

export interface SectionHeaderProps {
  title: ReactNode;
  subtitle?: ReactNode;
  className?: string;
}

export function SectionHeader({
  title,
  subtitle,
  className,
}: SectionHeaderProps) {
  return (
    <div className={cn(styles.header, className)}>
      <h2 className={styles.title}>{title}</h2>
      {subtitle && <p className={styles.subtitle}>{subtitle}</p>}
    </div>
  );
}
