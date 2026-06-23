/**
 * useHomepageState - Determines which of 5 user states applies
 *
 * The homepage adapts by data density, not user segment.
 * States:
 *   1. new-loading:        Connectors active, data loading
 *   2. new-no-data:        Connectors active, no data yet
 *   3. new-no-connectors:  Zero connectors
 *   4. established-daily:  Connected tools, history, daily check-in
 *   5. returning-after-idle: User has just navigated to Home within ~30 s of
 *      returning from a 15+ min idle period (signal armed by
 *      `useInactivityReturn`). The homepage no longer force-navigates here;
 *      this state only fires when the user chooses to come Home themselves
 *      while the welcome-back window is still open.
 */

import { useMemo } from 'react';

export type HomepageUserState =
  | { kind: 'new-loading' }
  | { kind: 'new-no-data' }
  | { kind: 'new-no-connectors' }
  | { kind: 'established-daily' }
  | { kind: 'returning-after-idle' };

interface UseHomepageStateOptions {
  /** Number of connected external connectors (calendar, email, etc.) */
  connectedConnectorCount?: number;
  /** Whether the user has completed onboarding */
  onboardingCompleted?: boolean;
  /** Whether meeting data is still loading */
  meetingsLoading?: boolean;
  /** Whether the user has any meetings today */
  hasMeetings?: boolean;
  /** Number of past conversation sessions */
  sessionCount?: number;
  /** Whether the user recently returned from idle (set by useInactivityReturn) */
  isReturningFromIdle?: boolean;
}

/**
 * Derive homepage user state from available signals.
 *
 * All data signals (meetingsLoading, hasMeetings) must be passed in by the
 * caller. This keeps the hook data-driven and avoids duplicate data fetching
 * (meeting cache is owned by the parent surface, not here).
 */
export function useHomepageState(options: UseHomepageStateOptions = {}): HomepageUserState {
  const {
    connectedConnectorCount = 0,
    onboardingCompleted: _onboardingCompleted = true,
    meetingsLoading: meetingsLoading = true,
    hasMeetings: hasMeetings = false,
    sessionCount = 0,
    isReturningFromIdle = false,
  } = options;

  return useMemo<HomepageUserState>(() => {
    // State 5: Returning after idle (takes priority for established users)
    if (isReturningFromIdle && sessionCount > 0 && connectedConnectorCount > 0) {
      return { kind: 'returning-after-idle' };
    }

    // State 3: Zero connectors
    if (connectedConnectorCount === 0) {
      return { kind: 'new-no-connectors' };
    }

    // State 4: Established daily user — has connectors and history.
    // meetingsLoading is NOT checked here: the Today section handles its own
    // loading states internally, so established users see "Here's your check-in
    // for today" immediately rather than the "new-loading" skeleton.
    if (sessionCount > 3 && connectedConnectorCount > 0) {
      return { kind: 'established-daily' };
    }

    // State 1: New user with connectors, data still loading
    if (meetingsLoading) {
      return { kind: 'new-loading' };
    }

    // State 2: New user with connectors, but no data yet
    if (!hasMeetings && sessionCount <= 3) {
      return { kind: 'new-no-data' };
    }

    // Default: established daily (has some data)
    return { kind: 'established-daily' };
  }, [connectedConnectorCount, meetingsLoading, hasMeetings, sessionCount, isReturningFromIdle]);
}
