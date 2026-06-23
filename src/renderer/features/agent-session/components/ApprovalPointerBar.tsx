import { BellRing } from 'lucide-react';
import { Button } from '@renderer/components/ui';
import styles from './ApprovalPointerBar.module.css';

export interface ApprovalPointerBarProps {
  /** Number of blocking approvals (tool + memory) — agent is paused */
  blockingCount: number;
  /** Number of non-blocking items (staged-tool + staged-file) — agent continued */
  nonBlockingCount: number;
  /** Callback to open drawer and scroll to this session's group */
  onReview: () => void;
}

function buildStatusText(blocking: number, nonBlocking: number): string {
  const total = blocking + nonBlocking;
  if (blocking > 0) {
    return `Rebel paused. ${total} ${total === 1 ? 'action needs' : 'actions need'} your OK`;
  }
  return `${total} ${total === 1 ? 'action needs' : 'actions need'} your OK`;
}

export function ApprovalPointerBar({
  blockingCount,
  nonBlockingCount,
  onReview,
}: ApprovalPointerBarProps) {
  if (blockingCount === 0 && nonBlockingCount === 0) {
    return null;
  }

  return (
    <div
      className={styles.container}
      role="status"
      aria-live="polite"
      data-testid="approval-pointer-bar"
    >
      <div className={styles.statusLeft}>
        <BellRing size={14} className={styles.bellIcon} aria-hidden="true" />
        <span className={styles.statusText}>
          {buildStatusText(blockingCount, nonBlockingCount)}
        </span>
      </div>
      <Button
        variant="default"
        size="xs"
        onClick={onReview}
        aria-label="View pending actions"
        data-testid="approval-pointer-review"
      >
        View
      </Button>
    </div>
  );
}
