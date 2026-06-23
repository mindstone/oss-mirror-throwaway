/**
 * FocusNoCalendar — Graceful empty state when no calendar is connected
 *
 * Shown within FocusPanel when the user has Focus enabled but no calendar
 * data is available. Encourages connecting Google Calendar or Microsoft 365
 * with a clear CTA that navigates to Settings → Connectors.
 *
 * @see docs/plans/260406_focus_phase2_surface_shell.md — Stage 5
 */

import { useCallback } from 'react';
import { ArrowRight } from 'lucide-react';
import { Button } from '@renderer/components/ui';
import { useNavigationSafe } from '@renderer/contexts/NavigationContext';
import { fireAndForget } from '@shared/utils/fireAndForget';
import styles from './FocusNoCalendar.module.css';

export function FocusNoCalendar() {
  const navigation = useNavigationSafe();

  const handleConnectCalendar = useCallback(() => {
    fireAndForget(navigation?.navigate({ type: 'settings', tab: 'tools' }), 'navigateToToolsSettings');
  }, [navigation]);

  return (
    <div className={styles.container} data-testid="focus-no-calendar">
      <h2 className={styles.heading}>
        Focus works best with your calendar.
      </h2>

      <p className={styles.body}>
        Connect Google Calendar or Microsoft 365 to get started.
      </p>

      <Button
        className={styles.connectButton}
        onClick={handleConnectCalendar}
      >
        Connect calendar
        <ArrowRight size={14} />
      </Button>

      <p className={styles.secondary}>
        Without a calendar, I can still help you think about your goals — just not your time.
      </p>
    </div>
  );
}
