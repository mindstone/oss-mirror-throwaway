import type { ReactNode } from 'react';
import { cn } from '../../lib/utils';
import styles from './PageHeader.module.css';

export interface PageHeaderProps {
  title: ReactNode;
  subtitle?: ReactNode;
  meta?: ReactNode;
  className?: string;
}

export function PageHeader({
  title,
  subtitle,
  meta,
  className,
}: PageHeaderProps) {
  return (
    <div className={cn(styles.header, className)}>
      <h1 className={styles.title}>{title}</h1>
      {(subtitle || meta) && (
        <div className={styles.subtitleRow}>
          {subtitle && <p className={styles.subtitle}>{subtitle}</p>}
          {meta}
        </div>
      )}
    </div>
  );
}
