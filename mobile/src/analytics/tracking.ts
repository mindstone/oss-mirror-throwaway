/**
 * Mobile analytics event taxonomy (typed wrappers).
 *
 * Mirrors the SHAPE of desktop's renderer-side `tracking` object
 * (`src/renderer/src/tracking.ts`) — a flat object of named, typed wrapper
 * functions that each call the gated `analytics` singleton — but is a
 * deliberately SMALL, mobile-local set.
 *
 * ── CRITICAL: one-emitter-per-event partition (no double-counting) ──────────
 * Mobile business logic executes on the user's CLOUD instance, whose tracker
 * (`getTracker().track(...)`) ALREADY emits the core/agent-lifecycle events for
 * a mobile-driven session (turn completed/error, tool execution, cost, memory,
 * daily summaries, watchdog). If mobile ALSO emitted those, every mobile session
 * would be double-counted (once as mobile, once as cloud).
 *
 * Therefore this taxonomy contains ONLY client/UI-origin events that core does
 * NOT emit. Each event below was verified against:
 *   - `src/renderer/src/tracking.ts` (renderer = client-origin → safe to mirror)
 *   - `src/core/` `getTracker().track(...)` emitters (core = server-origin on the
 *     cloud instance → MUST NOT be mirrored here)
 *
 * Per-event client-origin verification (recorded for the audit trail):
 *   - App Opened / App Backgrounded — mobile-only lifecycle (desktop has no RN
 *     AppState equivalent; core emits nothing of the sort). Pure client signal.
 *   - Pair Started / Pair Succeeded / Pair Failed / Unpaired — mobile-only
 *     device-pairing UI lifecycle. `src/core/appBridge/*` only LOGS "Pair…"
 *     strings; it never calls `getTracker().track('Pair …')`. Client-origin.
 *   - Screen Viewed — renderer/UI navigation signal (desktop tracks page/route
 *     views from the renderer; core never tracks screen views). Client-origin.
 *   - Message Sent — desktop emits the analogous "Chat Message Sent" from the
 *     RENDERER (`src/renderer/src/tracking.ts:426`), NOT from core. The UI
 *     send-tap is client-origin; the agent turn it triggers fires
 *     "Agent Turn Completed/Error" (renderer-origin on desktop —
 *     `src/renderer/src/tracking.ts`, NOT core). It is EXCLUDED from mobile
 *     because for a mobile-driven session the user's CLOUD INSTANCE owns and
 *     emits the turn events — mobile re-emitting them would double-count.
 *   - Voice Recording Completed — desktop emits "Voice Recording Stopped" from
 *     the RENDERER (`src/renderer/src/tracking.ts:785`); core does not. The
 *     transcription RESULT ("STT Transcription Completed") IS a core emitter
 *     (`src/core/services/audioService.ts:1040`) → EXCLUDED from mobile. We emit
 *     only the UI recording-stop tap.
 *   - Inbox Action Tapped / Approval Resolved — desktop emits Inbox-* events
 *     from the RENDERER (`src/renderer/src/tracking.ts:839+`); core does not.
 *     These are UI tap handlers. The downstream execution result
 *     ("Inbox Item Execution Completed/Error") is renderer-side on desktop but
 *     on mobile the EXECUTION runs on cloud and is emitted there — so we emit
 *     only the UI tap, never the execution outcome.
 *
 * EXPLICITLY EXCLUDED — the user's cloud instance emits these for a
 * mobile-driven session, so mobile must not re-emit them (double-count):
 *   - Agent Turn Completed/Error — renderer-origin on desktop, but for a mobile
 *     session the CLOUD INSTANCE owns and emits the turn events.
 *   - tool execution, cost (Daily Cost Summary / Cost Incurred), memory
 *     (Memory Update Turn Completed), STT Transcription Completed,
 *     Daily Time Saved Summary, Watchdog Self-Resolved — these are genuinely
 *     CORE emitters (`src/core/services/*`), emitted on the cloud instance.
 *
 * Every event carries `client_surface: 'mobile'` (added by the singleton) and every
 * property is routed through the B1 redaction layer + privacy contract. This
 * module never imports the RudderStack SDK directly (F4 guard) — it only calls
 * the `analytics` singleton.
 */

import { analytics } from './analytics';

/** Route-name source for Screen Viewed (non-PII: route name, never params). */
export type MobileScreenName = string;

/** Where a message send originated in the UI. */
type MessageSendSource = 'text' | 'voice';

/** How an inbox approval was resolved by the user. */
type ApprovalResolution = 'approved' | 'denied';

/**
 * The mobile event taxonomy. Intentionally boring, intentionally small
 * (~8-12 client/UI-origin events). Object-Action Title Case naming, matching
 * desktop + the data dictionary convention.
 */
export const tracking = {
  // ── App lifecycle (RN AppState; hand-emitted, NOT RudderStack auto-events) ──
  appOpened: (): void => {
    analytics.track('App Opened');
  },
  appBackgrounded: (): void => {
    analytics.track('App Backgrounded');
  },

  // ── Device pairing lifecycle (UI-origin; core only logs, never tracks) ──────
  pair: {
    started: (method: 'scan' | 'manual'): void => {
      analytics.track('Pair Started', { method });
    },
    succeeded: (method: 'scan' | 'manual'): void => {
      analytics.track('Pair Succeeded', { method });
    },
    /**
     * A pairing attempt failed. `reason` is a coarse, non-PII category
     * (auth / network / unknown) — never the raw error string, cloud URL, or
     * token (those are forbidden keys, dropped by redaction anyway).
     */
    failed: (method: 'scan' | 'manual', reason: 'auth' | 'network' | 'unknown'): void => {
      analytics.track('Pair Failed', { method, reason });
    },
    /** The device was unpaired (logout / 401). Sibling to SDK reset() on unpair. */
    unpaired: (): void => {
      analytics.track('Unpaired');
    },
  },

  // ── Navigation ──────────────────────────────────────────────────────────────
  /**
   * A screen/route became active. `name` MUST be a non-PII route name (e.g.
   * `(tabs)/inbox`), never route params or content.
   */
  screenViewed: (name: MobileScreenName): void => {
    analytics.track('Screen Viewed', { name });
  },

  // ── Key UI actions ───────────────────────────────────────────────────────────
  /**
   * The user tapped send in the composer. UI-origin only — the resulting agent
   * turn is emitted server-side (excluded here). No message content: only the
   * shape of the send (source, whether it had attachments, online/offline).
   */
  messageSent: (params: {
    source: MessageSendSource;
    hasAttachments: boolean;
    online: boolean;
  }): void => {
    analytics.track('Message Sent', params);
  },

  /**
   * A voice recording finished from the UI (stop tap, sufficient duration).
   * UI-origin only — the transcription RESULT is a core emitter and excluded.
   */
  voiceRecordingCompleted: (params: { durationMs: number }): void => {
    analytics.track('Voice Recording Completed', params);
  },

  /**
   * The user resolved a tool approval from the inbox sheet (approve/deny tap).
   * UI-origin tap only — the downstream execution runs on cloud and is emitted
   * there. `allowForSession` only meaningful on approve.
   */
  approvalResolved: (params: {
    resolution: ApprovalResolution;
    allowForSession?: boolean;
  }): void => {
    analytics.track('Approval Resolved', params);
  },

  /**
   * The user tapped a non-approval action on an inbox item (execute / archive /
   * delete / restore). `action` is a small enum, never the item content.
   */
  inboxActionTapped: (params: {
    action: 'execute' | 'archive' | 'delete' | 'restore';
  }): void => {
    analytics.track('Inbox Action Tapped', params);
  },
} as const;

// ── Identity (matches desktop: identify by email on pair, reset on unpair) ─────

/**
 * Identify the current user by email after pairing. Email is the SDK-managed
 * identity channel (passed as the userId), mirroring desktop. Graceful
 * degradation is the CALLER's responsibility: when no email is available, call
 * `identifyAnonymous()` instead (anonymousId-only) and log the degraded state.
 */
export function identifyByEmail(email: string): void {
  analytics.identify(email);
}

/**
 * Reset analytics identity on unpair so no identified session outlives the
 * pairing. Keeps the (non-PII, reconciled) anonymousId. Sibling to Sentry's
 * `clearSentryContext()` on unpair.
 */
export function resetIdentity(): void {
  analytics.reset();
}
