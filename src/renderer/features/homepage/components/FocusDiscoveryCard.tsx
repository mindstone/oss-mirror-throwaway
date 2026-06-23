/**
 * FocusDiscoveryCard — "Your day has N meetings" nudge
 *
 * Appears in TodaySection card stream when Focus is disabled but
 * the user has calendar data. Clicking "See my week" enables Focus
 * and navigates to the surface. Dismiss persists in localStorage
 * (max 3, then the card never shows again).
 *
 * Visual treatment matches the connector-nudge card pattern in TodaySection.
 */

import { useCallback, useEffect, useRef } from 'react';
import { BarChart3, ChevronRight, X } from 'lucide-react';
import { Button, IconTile } from '@renderer/components/ui';
import { tracking } from '@renderer/src/tracking';
import todayStyles from './TodaySection.module.css';

// ── localStorage helpers ────────────────────────────────────────────────────

const NUDGE_DISMISS_KEY = 'rebel:focus:nudgeDismissCount';

export function getFocusNudgeDismissCount(): number {
  try {
    const raw = localStorage.getItem(NUDGE_DISMISS_KEY);
    if (!raw) return 0;
    const n = Number(raw);
    return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
  } catch {
    return 0;
  }
}

function incrementNudgeDismissCount(): number {
  const next = getFocusNudgeDismissCount() + 1;
  try {
    localStorage.setItem(NUDGE_DISMISS_KEY, String(next));
  } catch {
    // Non-critical — worst case card reappears
  }
  return next;
}

// ── Component ───────────────────────────────────────────────────────────────

interface FocusDiscoveryCardProps {
  /** Number of meetings today from the calendar cache */
  meetingCount: number;
  /** Enables focusEnabled setting and navigates to Focus — must await settings persistence */
  onEnableFocus: () => Promise<void>;
  /** Called after dismiss counter is incremented */
  onDismiss: () => void;
}

export function FocusDiscoveryCard({
  meetingCount,
  onEnableFocus,
  onDismiss,
}: FocusDiscoveryCardProps) {
  // Track impression once per mount
  const trackedRef = useRef(false);
  useEffect(() => {
    if (!trackedRef.current) {
      trackedRef.current = true;
      tracking.homepage.focusNudgeShown(meetingCount);
    }
  }, [meetingCount]);

  const handleCta = useCallback(() => {
    tracking.homepage.focusNudgeClicked(meetingCount);
    void onEnableFocus();
  }, [meetingCount, onEnableFocus]);

  const handleDismiss = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      const count = incrementNudgeDismissCount();
      tracking.homepage.focusNudgeDismissed(count);
      onDismiss();
    },
    [onDismiss],
  );

  const headline =
    meetingCount === 1
      ? 'You have 1 meeting today'
      : `You have ${meetingCount} meetings today`;

  return (
    <div className={todayStyles.card} data-testid="today-card" data-urgent={false}>
      <IconTile icon={BarChart3} tone="neutral" className={todayStyles.mutedIconTile} />
      <div className={todayStyles.cardBody}>
        <p className={todayStyles.cardTitle}>{headline}</p>
        <p className={todayStyles.cardMeta} data-type="focus-nudge">
          I can analyse your calendar and help you plan your week around what
          actually matters.
        </p>
      </div>
      <Button
        type="button"
        variant="secondary"
        size="xs"
        className={todayStyles.cardCta}
        onClick={handleCta}
      >
        See my week <ChevronRight size={12} />
      </Button>
      <button
        type="button"
        className={todayStyles.cardDismiss}
        onClick={handleDismiss}
        aria-label="Dismiss"
      >
        <X size={10} />
      </button>
    </div>
  );
}
