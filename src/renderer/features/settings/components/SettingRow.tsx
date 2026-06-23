import type { ReactNode } from 'react';
import { HelpCircle } from 'lucide-react';
import { Tooltip } from '@renderer/components/ui';
import styles from './SettingRow.module.css';

export type SettingRowProps = {
  /** Label text for this setting */
  label: string;
  /** Optional description below the label */
  description?: string;
  /** Optional tooltip shown via a help icon */
  tooltip?: string;
  /** Optional badge rendered after the label (e.g., MaturityBadge) */
  badge?: ReactNode;
  /** Layout variant: 'default' is side-by-side, 'stacked' is label-above-control */
  variant?: 'default' | 'stacked';
  /** Wires the <label> to a control via htmlFor */
  htmlFor?: string;
  /** Section ID for deep-link scrolling via useScrollToSection */
  'data-section'?: string;
  /** Test ID for E2E tests */
  'data-testid'?: string;
  /** The control element (Select, Toggle, Input, etc.) */
  children: ReactNode;
};

export const SettingRow = ({
  label,
  description,
  tooltip,
  badge,
  variant = 'default',
  htmlFor,
  'data-section': dataSection,
  'data-testid': dataTestId,
  children,
}: SettingRowProps) => {
  const isStacked = variant === 'stacked';

  const rowClassName = [
    styles.row,
    isStacked ? styles.rowStacked : '',
  ].filter(Boolean).join(' ');

  const labelClassName = [
    styles.label,
    htmlFor ? styles.labelClickable : '',
  ].filter(Boolean).join(' ');

  const LabelTag = htmlFor ? 'label' : 'span';

  return (
    <div
      className={rowClassName}
      data-section={dataSection}
      data-testid={dataTestId}
    >
      <div className={styles.labelGroup}>
        <div className={styles.labelRow}>
          <LabelTag
            className={labelClassName}
            {...(htmlFor ? { htmlFor } : {})}
          >
            {label}
          </LabelTag>
          {badge}
          {tooltip && (
            <Tooltip content={tooltip} placement="top" delayShow={300}>
              <span className={styles.tooltipIcon}>
                <HelpCircle size={14} />
              </span>
            </Tooltip>
          )}
        </div>
        {description && (
          <p className={styles.description}>{description}</p>
        )}
      </div>
      <div className={styles.control}>
        {children}
      </div>
    </div>
  );
};
