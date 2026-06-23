/**
 * ApprovalNudgeToast
 *
 * Persistent notification that appears when pending approvals or questions
 * exist and the notification drawer is closed. Clicking opens the drawer; the
 * close button dismisses it until a NEW item arrives (count increases beyond the
 * dismissed-at count).
 *
 * Not built on Sonner — Sonner toasts are immutable and can't dynamically
 * update the count. This is a standalone fixed-position element.
 */

import { memo, useState, useEffect, useCallback } from 'react';
import { X, Bell, MessageCircleQuestion } from 'lucide-react';
import './ApprovalNudgeToast.css';

interface ApprovalNudgeToastProps {
  count: number;
  questionCount?: number;
  drawerVisible: boolean;
  onOpenDrawer: () => void;
}

export const ApprovalNudgeToast = memo(function ApprovalNudgeToast({
  count,
  questionCount = 0,
  drawerVisible,
  onOpenDrawer,
}: ApprovalNudgeToastProps) {
  const [dismissedAtCount, setDismissedAtCount] = useState<number | null>(null);
  const totalCount = count + questionCount;

  useEffect(() => {
    if (dismissedAtCount !== null && totalCount > dismissedAtCount) {
      setDismissedAtCount(null);
    }
  }, [totalCount, dismissedAtCount]);

  const handleDismiss = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setDismissedAtCount(totalCount);
  }, [totalCount]);

  const isDismissed = dismissedAtCount !== null && totalCount <= dismissedAtCount;
  const shouldShow = totalCount > 0 && !drawerVisible && !isDismissed;
  const isDetailOnly = count === 0 && questionCount > 0;

  if (!shouldShow) return null;

  const label = count > 0 && questionCount > 0
    ? `${count === 1 ? '1 approval' : `${count} approvals`} and ${questionCount === 1 ? '1 detail' : `${questionCount} details`} waiting`
    : count > 0
      ? count === 1
        ? 'Rebel needs your approval on 1 action'
        : `Rebel needs your approval on ${count} actions`
      : questionCount === 1
        ? 'Rebel needs 1 detail'
        : `Rebel needs ${questionCount} details`;
  const title = count > 0 && questionCount > 0
    ? 'Rebel needs your attention'
    : count > 0
      ? 'Rebel needs your approval'
      : questionCount === 1
        ? 'Rebel needs one detail'
        : 'Rebel needs a few details';
  const countLabel = count > 0 && questionCount > 0
    ? `${count === 1 ? '1 approval' : `${count} approvals`} and ${questionCount === 1 ? '1 detail' : `${questionCount} details`} waiting`
    : count > 0
      ? count === 1
        ? '1 approval waiting'
        : `${count} approvals waiting`
      : questionCount === 1
        ? '1 detail waiting'
        : `${questionCount} details waiting`;
  const actionLabel = count > 0 ? 'Review' : 'Answer';

  return (
    <div
      className={`approval-nudge-toast${isDetailOnly ? ' approval-nudge-toast--detail-only' : ''}`}
      role="status"
      aria-live="polite"
      data-testid="approval-nudge-toast"
    >
      <button
        type="button"
        className="approval-nudge-toast__body"
        onClick={onOpenDrawer}
        aria-label={label}
      >
        <span className="approval-nudge-toast__iconShell" aria-hidden>
          {isDetailOnly ? (
            <MessageCircleQuestion size={15} className="approval-nudge-toast__icon" />
          ) : (
            <Bell size={15} className="approval-nudge-toast__icon" />
          )}
        </span>
        <span className="approval-nudge-toast__copy">
          <span className="approval-nudge-toast__title">{title}</span>
          <span className="approval-nudge-toast__meta">
            <span className="approval-nudge-toast__count">{countLabel}</span>
            <span className="approval-nudge-toast__review">{actionLabel}</span>
          </span>
        </span>
      </button>
      <button
        type="button"
        className="approval-nudge-toast__close"
        onClick={handleDismiss}
        aria-label="Dismiss notification"
      >
        <X size={14} />
      </button>
    </div>
  );
});
