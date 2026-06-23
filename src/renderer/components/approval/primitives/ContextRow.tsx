/**
 * ContextRow — Shared label:value row primitive.
 *
 * Renders a structured row with an uppercase label and flexible value.
 * Value accepts ReactNode so badges/icons can be composed inline.
 * Extracted from UnifiedApprovalCard's context section rows.
 */

import { memo, type FC, type ReactNode } from 'react';
import { cn } from '@renderer/lib/utils';
import { Tooltip } from '@renderer/components/ui';
import styles from './ContextRow.module.css';

export interface ContextRowProps {
  /** Row label (rendered uppercase, e.g. "What", "File", "Space") */
  label: string;
  /** Row value — supports string or ReactNode for composed content */
  value: ReactNode;
  /** Optional tooltip for truncated values */
  tooltip?: string;
  /** Truncate value to 2 lines */
  truncate?: boolean;
  className?: string;
}

const ContextRowComponent: FC<ContextRowProps> = ({
  label,
  value,
  tooltip,
  truncate = false,
  className,
}) => {
  const valueContent = (
    <span className={cn(styles.value, truncate && styles.valueTruncate)}>
      {value}
    </span>
  );

  return (
    <div className={cn(styles.row, className)}>
      <span className={styles.label}>{label}</span>
      {tooltip ? (
        <Tooltip content={tooltip} maxWidth="400px">
          {valueContent}
        </Tooltip>
      ) : (
        valueContent
      )}
    </div>
  );
};

export const ContextRow = memo(ContextRowComponent);
ContextRow.displayName = 'ContextRow';
