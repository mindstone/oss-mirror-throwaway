import type { ReactNode } from 'react';
import { Badge, Button } from '@renderer/components/ui';
import { cn } from '@renderer/lib/utils';
import { shouldIgnoreCardClick } from './cardClickGuard';
import styles from './FileCard.module.css';

export interface LibraryItemCardProps {
  title: string;
  badgeLabel: string;
  icon: ReactNode;
  path: string;
  summary?: string;
  openLabel?: string;
  className?: string;
  onOpen?: () => void;
}

export function LibraryItemCard({
  title,
  badgeLabel,
  icon,
  path,
  summary,
  openLabel = 'Open',
  className,
  onOpen,
}: LibraryItemCardProps) {
  const isInteractive = Boolean(onOpen);
  return (
    <article
      className={cn(styles.card, isInteractive && styles.cardInteractive, className)}
      tabIndex={isInteractive ? -1 : undefined}
      onClick={isInteractive ? (event) => {
        if (shouldIgnoreCardClick(event)) {
          return;
        }
        onOpen?.();
      } : undefined}
    >
      <header className={styles.header}>
        <span className={styles.title}>
          {icon}
          {title}
        </span>
        <Badge variant="muted" size="sm">{badgeLabel}</Badge>
      </header>
      <p className={styles.path} title={path}>
        {path}
      </p>
      {summary ? <p className={styles.summary}>{summary}</p> : null}
      <div className={styles.actions}>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={(event) => {
            event.stopPropagation();
            onOpen?.();
          }}
        >
          {openLabel}
        </Button>
      </div>
    </article>
  );
}
