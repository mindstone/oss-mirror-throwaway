// Centralized user-facing copy for offline queue status messages.

import { QUEUE_FULL_USER_MESSAGE as CLOUD_QUEUE_FULL_USER_MESSAGE } from '@core/services/cloudErrorCatalog';

export const QUEUE_FULL_USER_MESSAGE = CLOUD_QUEUE_FULL_USER_MESSAGE;

export const QUEUE_FULL_MEETING_MESSAGE =
  'Queue is full. Let the waiting uploads finish, then resume recording.';

// ---------------------------------------------------------------------------
// Toast copy — shown transiently after queue state transitions.
// Brand voice: dry, calm, first-person. No "Error!" or "Failed!".
// ---------------------------------------------------------------------------

export const queueToastCopy = {
  enqueuedOffline: "Saved. I'll send when you're back online.",
  draining: (count: number) =>
    count === 1
      ? "I'm sending your waiting item now."
      : `I'm sending your ${count} waiting items now.`,
  olderItemsDropped: 'Some older queued items were dropped.',
  /**
   * Shown after an online send failed before the server acknowledged and we
   * restored the user's draft. Reassuring, not alarming.
   */
  draftRestored: "Didn't send — your draft's back. Try again?",
  /**
   * Shown after send-and-done failed pre-ack. The user already navigated
   * away, so we can't restore inline; but we can tell them the draft is
   * safe and nudge them to retry. Paired with a writeback to session
   * scratch (not yet implemented — see I-NBU planning doc).
   */
  sendAndDoneFailedPreAck: "That one didn't go through. Reopen the conversation to retry.",
} as const;

export interface BannerCopyVariant {
  title: string;
  subtitle: string | ((count: number) => string) | null;
  cta?: string;
}

// ---------------------------------------------------------------------------
// Banner copy — displayed in the persistent ConnectivityBanner.
// Keyed by QueueState for easy lookup.
// ---------------------------------------------------------------------------

export const bannerCopy = {
  'online-draining': {
    title: 'Sending queued items…',
    subtitle: (count: number) => `${count} waiting`,
  },
  'offline-queued': {
    title: 'Offline',
    subtitle: (count: number) =>
      count === 1
        ? "1 saved. I'll send it when you're back online."
        : `${count} saved. I'll send them when you're back online.`,
  },
  'offline-empty': {
    title: 'Offline',
    subtitle: null,
  },
  'queue-full': {
    title: 'Upload queue full',
    subtitle: "I'm at capacity right now. Keep the app online so I can clear space.",
  },
  limited: {
    title: 'Limited connection',
    subtitle: "Having trouble reaching the cloud. Will keep trying.",
  },
  'auth-expired': (queuedCount: number): BannerCopyVariant => ({
    title: 'Your session expired',
    subtitle:
      queuedCount === 0
        ? 'Sign in to continue.'
        : queuedCount === 1
          ? 'Sign in to send 1 queued item.'
          : `Sign in to send ${queuedCount} queued items.`,
    cta: 'Sign in again →',
  }),
  reconnecting: {
    title: 'Reconnecting…',
    subtitle: null,
  },
  'has-failures': {
    title: "Some items couldn't send",
    subtitle: (count: number) =>
      count === 1
        ? '1 failed. Tap to review.'
        : `${count} failed. Tap to review.`,
  },
} as const;
