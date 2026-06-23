import { memo } from 'react';
import { HelpCircle, X } from 'lucide-react';
import styles from './UserQuestionCard.module.css';

interface MinimizedQuestionPillProps {
  onRestore: () => void;
  onDismiss: () => void;
  label?: string;
}

const MinimizedQuestionPillComponent = ({
  onRestore,
  onDismiss,
  label = 'Rebel has a question',
}: MinimizedQuestionPillProps) => (
  <div
    className={styles.minimizedPill}
    role="status"
    aria-label={label}
    data-testid="minimized-question-pill"
  >
    <button
      type="button"
      className={styles.minimizedPillBody}
      onClick={onRestore}
      aria-label={`Restore: ${label}`}
    >
      <HelpCircle size={14} aria-hidden="true" />
      <span>{label}</span>
    </button>
    <button
      type="button"
      className={styles.minimizedPillDismiss}
      onClick={onDismiss}
      aria-label="Dismiss question"
    >
      <X size={12} aria-hidden="true" />
    </button>
  </div>
);

MinimizedQuestionPillComponent.displayName = 'MinimizedQuestionPill';
export const MinimizedQuestionPill = memo(MinimizedQuestionPillComponent);
