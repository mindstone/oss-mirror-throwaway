import { useCallback, useMemo } from 'react';
import { Notice } from '@renderer/components/ui';
import type { InboundAuthorPolicy } from '@rebel/shared';
import {
  isUpgradeReviewRepromptSuppressed,
  readUpgradeReviewDismissedAt,
  suppressUpgradeReviewReprompt,
} from '../../hooks/useInboundAuthorPolicy';

const SIXTY_DAYS_MS = 60 * 24 * 60 * 60 * 1000;
const DEFAULT_REVIEW_TARGET_SECTION_ID = 'who-can-message-rebel';

function escapeSectionId(value: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
    return CSS.escape(value);
  }
  return value.replaceAll('"', '\\"');
}

function focusSection(sectionId: string): void {
  if (typeof document === 'undefined') return;
  const section = document.querySelector(
    `[data-section='${escapeSectionId(sectionId)}']`,
  ) as HTMLElement | null;
  if (!section) return;

  section.scrollIntoView({ behavior: 'smooth', block: 'start' });
  const focusTarget = section.querySelector(
    '[data-section-focus-target], button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
  ) as HTMLElement | null;
  const target = focusTarget ?? section;
  target.focus?.();
}

export interface UpgradeReviewNoticeProps {
  policy: InboundAuthorPolicy;
  recentSendersCount: number;
  onDismiss: () => Promise<void> | void;
  onMarkDismissedNow: () => void;
  reviewTargetSectionId?: string;
}

export function UpgradeReviewNotice({
  policy,
  recentSendersCount,
  onDismiss,
  onMarkDismissedNow,
  reviewTargetSectionId = DEFAULT_REVIEW_TARGET_SECTION_ID,
}: UpgradeReviewNoticeProps) {
  const shouldShowReprompt = useMemo(() => {
    if (policy.notices.upgradeReviewPending) return false;
    if (policy.mode !== 'legacyPermissive') return false;
    if (recentSendersCount <= 0) return false;
    if (isUpgradeReviewRepromptSuppressed()) return false;

    const lastDismissedAt = readUpgradeReviewDismissedAt();
    if (lastDismissedAt === null) return false;
    return Date.now() - lastDismissedAt >= SIXTY_DAYS_MS;
  }, [
    policy.mode,
    policy.notices.upgradeReviewPending,
    recentSendersCount,
  ]);

  const isVisible = policy.notices.upgradeReviewPending || shouldShowReprompt;
  const isReprompt = !policy.notices.upgradeReviewPending && shouldShowReprompt;

  const body = isReprompt
    ? `You haven't tightened messaging access in 60 days — ${recentSendersCount} strangers tried to message Rebel.`
    : 'Rebel can now limit who may message it from Slack. Your existing setup still works, but it needs a quick review. Sensible, if not glamorous.';

  const handleReview = useCallback(() => {
    focusSection(reviewTargetSectionId);
  }, [reviewTargetSectionId]);

  const handleDismiss = useCallback(async () => {
    await onDismiss();
    onMarkDismissedNow();
    if (isReprompt) {
      suppressUpgradeReviewReprompt();
    }
  }, [isReprompt, onDismiss, onMarkDismissedNow]);

  if (!isVisible) {
    return null;
  }

  return (
    <Notice
      tone="info"
      placement="inline"
      title="Review who can message Rebel"
      data-testid="upgrade-review-notice"
      actions={[
        {
          label: 'Review',
          onClick: handleReview,
          variant: 'primary',
          'data-testid': 'upgrade-review-notice-review',
        },
        {
          label: 'Dismiss',
          onClick: () => {
            void handleDismiss();
          },
          variant: 'secondary',
          'data-testid': 'upgrade-review-notice-dismiss',
        },
      ]}
    >
      {body}
    </Notice>
  );
}
