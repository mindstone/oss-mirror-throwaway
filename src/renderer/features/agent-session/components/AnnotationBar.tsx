/**
 * AnnotationBar
 *
 * Shows pending annotation count and send/clear actions.
 * Displayed above the composer when annotations exist.
 */

import { memo } from 'react';
import { MessageSquare, X } from 'lucide-react';
import { Button } from '@renderer/components/ui/Button';
import styles from './AnnotationBar.module.css';

interface AnnotationBarProps {
  count: number;
  onClear: () => void;
  disabled?: boolean;
}

const AnnotationBarComponent = ({
  count,
  onClear,
  disabled = false,
}: AnnotationBarProps) => {
  if (count === 0) return null;

  return (
    <div className={styles.bar}>
      <div className={styles.info}>
        <MessageSquare size={16} className={styles.icon} />
        <span className={styles.count}>
          {count} comment{count !== 1 ? 's' : ''} ready to send
        </span>
      </div>
      <div className={styles.actions}>
        <Button
          variant="ghost"
          size="sm"
          onClick={onClear}
          disabled={disabled}
          className={styles.clearButton}
        >
          <X size={14} />
          Clear
        </Button>
      </div>
    </div>
  );
};

AnnotationBarComponent.displayName = 'AnnotationBar';

export const AnnotationBar = memo(AnnotationBarComponent);
