import { useId } from 'react';
import { ChevronRight, AlertTriangle, Loader2 } from 'lucide-react';
import { cn } from '@renderer/lib/utils';
import styles from './ConversationPane.module.css';

export interface AdditionalViewRowProps {
  viewRoleLabel: string;
  viewSummary: string;
  status?: 'idle' | 'loading' | 'failed';
  onOpen: () => void;
  expanded?: boolean;
  controlledRegionId?: string;
}

export function AdditionalViewRow({
  viewRoleLabel,
  viewSummary,
  status = 'idle',
  onOpen,
  expanded,
  controlledRegionId,
}: AdditionalViewRowProps) {
  const generatedRegionId = useId();
  const regionId = controlledRegionId ?? generatedRegionId;

  return (
    <button
      type="button"
      className={cn(
        styles.additionalViewRow,
        expanded && styles.additionalViewRowExpanded,
        status === 'failed' && styles.additionalViewRowFailed,
      )}
      onClick={onOpen}
      aria-expanded={typeof expanded === 'boolean' ? expanded : undefined}
      aria-controls={typeof expanded === 'boolean' ? regionId : undefined}
      data-testid="additional-view-row"
    >
      <span className={styles.additionalViewRowContent}>
        <span className={styles.additionalViewRowHeader}>
          <span className={styles.additionalViewRowTitle}>{viewRoleLabel}</span>
          {status === 'loading' ? (
            <span className={styles.additionalViewRowStatus}>
              <Loader2 size={13} className={styles.additionalViewRowSpinner} aria-hidden />
              Loading
            </span>
          ) : status === 'failed' ? (
            <span className={styles.additionalViewRowStatus}>
              <AlertTriangle size={13} aria-hidden />
              Needs attention
            </span>
          ) : null}
        </span>
        <span className={styles.additionalViewRowSummary}>{viewSummary}</span>
      </span>
      <ChevronRight
        size={16}
        className={cn(styles.additionalViewRowChevron, expanded && styles.additionalViewRowChevronOpen)}
        aria-hidden
      />
    </button>
  );
}
