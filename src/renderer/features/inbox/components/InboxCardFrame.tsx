import { memo, useCallback, useEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import styles from './InboxItemCard.module.css';

type InboxCardFrameProps = {
  itemId: string;
  children: ReactNode;
  expandedContent?: ReactNode;
  footer?: ReactNode;
  isDeparting?: boolean;
  isArchived?: boolean;
  isExpanded?: boolean;
  isSelected?: boolean;
  selectionActive?: boolean;
  onToggleSelect?: () => void;
  selectionLabel?: string;
  onActivate?: () => void;
};

function isInteractiveTarget(target: HTMLElement | null, container: HTMLElement): boolean {
  if (!target) return false;
  const match = target.closest(
    'button, input, textarea, select, a, label, [role="button"], [role="link"], [role="switch"], [role="radio"], [role="option"]',
  );
  // Only block if the matched interactive element is inside the container,
  // not an ancestor above it (e.g. the card wrapper's own role="button").
  return match !== null && container.contains(match);
}

export const InboxCardFrame = memo(function InboxCardFrame({
  itemId,
  children,
  expandedContent,
  footer,
  isDeparting,
  isArchived,
  isExpanded,
  isSelected,
  selectionActive,
  onToggleSelect,
  selectionLabel,
  onActivate,
}: InboxCardFrameProps) {
  const expandRef = useRef<HTMLDivElement>(null);
  const [expandHeight, setExpandHeight] = useState<number | undefined>(undefined);

  useEffect(() => {
    if (!expandRef.current) return;
    setExpandHeight(isExpanded ? expandRef.current.scrollHeight : 0);
  }, [isExpanded, expandedContent]);

  useEffect(() => {
    if (!isExpanded || !expandRef.current) return;
    const observer = new ResizeObserver(() => {
      if (expandRef.current) setExpandHeight(expandRef.current.scrollHeight);
    });
    observer.observe(expandRef.current);
    return () => observer.disconnect();
  }, [isExpanded, expandedContent]);

  const handleBodyClick = useCallback(
    (event: MouseEvent<HTMLDivElement>) => {
      if (!onActivate) return;
      if (isInteractiveTarget(event.target as HTMLElement, event.currentTarget)) return;
      onActivate();
    },
    [onActivate],
  );

  const handleCardKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (!onActivate) return;
      if (event.key !== 'Enter' && event.key !== ' ') return;
      // Allow activation when the card itself is focused (it has role="button").
      // Block when focus is on an inner interactive element.
      if (event.target !== event.currentTarget && isInteractiveTarget(event.target as HTMLElement, event.currentTarget)) return;
      event.preventDefault();
      onActivate();
    },
    [onActivate],
  );

  const cardClasses = [
    styles.card,
    isDeparting && styles.cardDeparting,
    isArchived && styles.cardArchived,
    isExpanded && styles.cardExpanded,
    isSelected && styles.cardSelected,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div
      className={cardClasses}
      data-item-id={itemId}
      data-testid="inbox-item-card"
      tabIndex={onActivate ? 0 : undefined}
      onKeyDown={handleCardKeyDown}
      role={onActivate ? 'button' : undefined}
    >
      <div className={styles.cardBody} onClick={handleBodyClick}>
        {onToggleSelect && (
          <input
            type="checkbox"
            className={`${styles.selectCheckbox} ${selectionActive ? styles.selectCheckboxVisible : ''}`}
            checked={isSelected ?? false}
            onChange={(event) => {
              event.stopPropagation();
              onToggleSelect();
            }}
            onClick={(event) => event.stopPropagation()}
            aria-label={selectionLabel}
          />
        )}

        {children}

        {expandedContent && (
          <div
            ref={expandRef}
            className={styles.expandWrapper}
            style={{ maxHeight: expandHeight !== undefined ? expandHeight : 0 }}
            aria-hidden={!isExpanded}
          >
            {isExpanded ? expandedContent : null}
          </div>
        )}
      </div>

      {footer ? <div className={styles.cardFooter}>{footer}</div> : null}
    </div>
  );
});
