import type { ToastVariant } from '../components/ui/Toast';

/**
 * Pure copy decision for the `bug-report:status` broadcast toast (App.tsx
 * listener). Extracted so the user-facing copy — especially the honest
 * delivery-status branches — is regression-testable without App churn.
 *
 * Payload shape mirrors `BugReportStatusPayload` (src/main/ipc/
 * bugReportHandlers.ts; channel is not in the typed broadcast registry).
 *
 * Status vocabulary (Stage 5 — honest delivery status):
 * - 'queued'               → the report was durably saved to the on-disk outbox
 *                            (`accepted` returned). Fires ONE positive toast.
 * - 'delivered'            → confirmed 2xx after flush. A SILENT upgrade: this
 *                            helper returns `null` so no second toast fires (the
 *                            queued toast already gave confidence; a delivered
 *                            toast would be noise and undermine the first).
 * - 'delivery-unavailable' → Sentry off / no-DSN, OR dead-letter after retries
 *                            exhausted. Warning toast with a Copy-report action
 *                            (environment-independent) + Rebels-community pointer.
 * - 'failed'               → even the durable save failed (disk full). Error toast.
 *
 * `reason` is present only for status 'delivery-unavailable':
 * - 'no-dsn'      → this build shipped without error reporting configured
 *                   (NOT a dev-mode situation) — never mention dev mode.
 * - 'env-disabled' → the dev default / explicit SENTRY_ENABLED opt-out.
 * - 'dead-letter' → delivery retries exhausted.
 * The copy is identical across reasons (the user need not know WHY the team
 * couldn't be reached, only that their report is safe and Rebel will keep
 * trying); the reason is preserved for forward-compat / logging.
 *
 * `reportText`, when present (forwarded by the main-process broadcast for the
 * delivery-unavailable case), is the raw report the user wrote. The pure module
 * does not perform clipboard I/O — instead it flags `action: 'copy-report'` so
 * the App.tsx listener can wire an environment-independent "Copy report" toast
 * action over the forwarded text.
 */
export interface BugReportToastCopy {
  title: string;
  description: string;
  variant?: ToastVariant;
  duration?: number;
  /**
   * When set, the renderer should attach a toast action of this kind. The pure
   * module cannot hold an onClick (it would need clipboard + the report text),
   * so it names the affordance and the App.tsx listener wires the handler.
   * - 'copy-report' → a "Copy report" button that copies the user's report text
   *   to the clipboard, plus a Rebels-community pointer (rendered by App.tsx).
   */
  action?: 'copy-report';
}

/** Duration for the recovering (warning) delivery-unavailable toast. */
const DELIVERY_UNAVAILABLE_DURATION_MS = 12000;

export const bugReportStatusToastCopy = (
  data: { status: string; reason?: string }
): BugReportToastCopy | null => {
  switch (data.status) {
    case 'queued':
      // One positive toast on durable write. Quietly-confident success: the
      // report is safe and on its way; name receipt, not transport.
      return {
        title: 'Got it',
        description: 'Your report is safe with Rebel, and on its way to the team.',
        variant: 'success',
      };
    case 'delivered':
      // Confirmed 2xx is a SILENT upgrade — no second toast (the queued toast
      // already reassured; another would be noise and undermine the first).
      return null;
    case 'delivery-unavailable':
      // Saved locally but couldn't be sent right now (Sentry off / no DSN, or
      // dead-letter after retries). Warning (recovering, not error). Offer an
      // environment-independent way to reach the team: copy the report (copying
      // can't fail like the network did) + the Rebels community.
      return {
        title: "Saved, but we couldn't reach the team yet",
        description:
          "Your report is safe on this device and Rebel will keep trying. If it's urgent, copy it and send it to us directly, or post it in the Rebels community.",
        variant: 'warning',
        duration: DELIVERY_UNAVAILABLE_DURATION_MS,
        action: 'copy-report',
      };
    case 'failed':
      // Even the durable save failed (disk full) — near-impossible after the
      // outbox lands. Honest error with a direct-contact fallback.
      return {
        title: "Couldn't save your report",
        description:
          'Something went wrong saving it. Please try again, or copy it and contact us directly.',
        variant: 'error',
      };
    default:
      // Unknown/future statuses: show nothing rather than a misleading toast.
      return null;
  }
};
