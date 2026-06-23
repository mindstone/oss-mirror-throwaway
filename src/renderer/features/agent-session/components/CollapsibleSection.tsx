import { memo, useCallback, type ReactNode, type KeyboardEvent } from 'react';
import { ChevronRight, type LucideIcon } from 'lucide-react';
import styles from './CollapsibleSection.module.css';

type CollapsibleSectionProps = {
  label: string;
  count: number;
  icon?: LucideIcon;
  isExpanded: boolean;
  onToggle: () => void;
  children: ReactNode;
  'data-testid'?: string;
  /** Optional action element rendered in the header (e.g., "Empty" button for trash) */
  headerAction?: ReactNode;
};

export const CollapsibleSection = memo(
  ({
    label,
    count,
    icon: Icon,
    isExpanded,
    onToggle,
    children,
    'data-testid': testId,
    headerAction
  }: CollapsibleSectionProps) => {
    const handleKeyDown = useCallback(
      (event: KeyboardEvent<HTMLButtonElement>) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onToggle();
        }
      },
      [onToggle]
    );

    return (
      <div className={styles.section} data-testid={testId}>
        <div className={styles.header}>
          <button
            type="button"
            className={styles.headerToggle}
            onClick={onToggle}
            onKeyDown={handleKeyDown}
            aria-expanded={isExpanded}
            aria-controls={`section-content-${label.toLowerCase().replace(/\s+/g, '-')}`}
          >
            <ChevronRight
              className={`${styles.chevron} ${isExpanded ? styles.chevronExpanded : ''}`}
              size={14}
              aria-hidden
            />
            {Icon && <Icon className={styles.icon} size={14} aria-hidden />}
            <span className={styles.label}>{label}</span>
            <span className={styles.count}>({count})</span>
          </button>
          {headerAction && <span className={styles.headerAction}>{headerAction}</span>}
        </div>
        {isExpanded && (
          <div
            id={`section-content-${label.toLowerCase().replace(/\s+/g, '-')}`}
            className={styles.content}
            role="region"
            aria-label={`${label} conversations`}
          >
            {children}
          </div>
        )}
      </div>
    );
  }
);

CollapsibleSection.displayName = 'CollapsibleSection';
