import type { KeyboardEvent } from 'react';
import styles from '../OnboardingWizard.module.css';

type StepPillProps = {
  index: number;
  total: number;
  label: string;
  ariaLabel?: string;
  state: 'done' | 'active' | 'upcoming';
  onClick?: () => void;
  disabled?: boolean;
};

export const StepPill = ({
  index,
  total,
  label,
  ariaLabel,
  state,
  onClick,
  disabled,
}: StepPillProps) => {
  const clickable = Boolean(onClick) && !disabled;
  const className = [
    styles.stepPillItem,
    state === 'done' ? styles.stepPillDone : '',
    state === 'active' ? styles.stepPillActive : '',
    state === 'upcoming' ? styles.stepPillUpcoming : '',
    clickable ? styles.stepPillClickable : '',
  ]
    .filter(Boolean)
    .join(' ');

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onClick?.();
    }
  };

  const interactiveProps = clickable
    ? {
        role: 'button' as const,
        tabIndex: 0,
        onClick,
        onKeyDown: handleKeyDown,
      }
    : {
        role: 'listitem' as const,
        'aria-disabled': disabled || undefined,
      };

  return (
    <div
      className={className}
      aria-current={state === 'active' ? 'step' : undefined}
      {...interactiveProps}
      aria-label={`${ariaLabel ?? label} (${index} of ${total})`}
    >
      <div className={styles.stepPillIcon} aria-hidden>
        {state === 'done' ? (
          <span className={styles.stepPillCheck}>✓</span>
        ) : (
          <span className={styles.stepPillNumber}>{index}</span>
        )}
      </div>
      <div className={styles.stepPillText}>
        <span className={styles.stepPillLabel} title={label}>{label}</span>
      </div>
    </div>
  );
};
