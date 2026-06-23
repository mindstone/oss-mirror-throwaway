import { Check } from 'lucide-react';
import { Button } from '@renderer/components/ui';
import styles from './ConversationFeedbackChips.module.css';

type ConversationFeedbackChipsProps = {
  availableChips: readonly string[];
  selectedChips: string[];
  onToggle: (label: string) => void;
  testIdPrefix?: string;
};

export function ConversationFeedbackChips({
  availableChips,
  selectedChips,
  onToggle,
  testIdPrefix = 'conversation-feedback-chip',
}: ConversationFeedbackChipsProps) {
  return (
    <div className={styles.chipGrid} data-testid={`${testIdPrefix}-grid`}>
      {availableChips.map((label) => {
        const isSelected = selectedChips.includes(label);
        return (
          <Button
            key={label}
            type="button"
            variant={isSelected ? 'secondary' : 'outline'}
            size="xs"
            className={`${styles.chipButton} ${isSelected ? styles.chipButtonSelected : styles.chipButtonUnselected}`}
            aria-pressed={isSelected}
            onClick={() => onToggle(label)}
            data-testid={`${testIdPrefix}-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`}
          >
            {isSelected ? <Check className={styles.checkIcon} aria-hidden="true" /> : null}
            <span>{label}</span>
          </Button>
        );
      })}
    </div>
  );
}

ConversationFeedbackChips.displayName = 'ConversationFeedbackChips';
