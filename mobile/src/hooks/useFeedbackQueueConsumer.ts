/**
 * Queue consumer for `feedback` items (mobile offline feedback queue).
 *
 * Unlike the text/voice consumers (which submit a conversation turn via the
 * turn-oriented `createQueueConsumer` factory), a feedback item is delivered to
 * the cloud `/api/feedback` relay. This is a bespoke consumer: it loads the
 * persisted `FeedbackRequest` JSON payload and submits it via
 * `submitFeedbackOnce` (NO internal retry — the QUEUE owns retry/backoff, so the
 * consumer must see the first-attempt HTTP status to classify it).
 *
 * The persisted payload carries the stable client-minted `eventId` (32-hex) and
 * `clientReportId`, reused on every retry, so a retried-after-delivery report
 * dedups server-side in Sentry (no duplicate issue) — see the cloud relay
 * `sentryFeedback.ts` and the desktop idempotency precedent.
 *
 * Failure classification (SSOT `classifyUploadFailureCategory`):
 *   - 200 → success → queue removes the item + its JSON payload.
 *   - 422 → `permanent` (cloud Sentry unconfigured — retrying can't help). The
 *     queue terminalizes the item but RETAINS the payload on disk, so the help
 *     screen can offer a Copy-report fallback (R3 honest delivery-unavailable).
 *   - 503 / 429 / 5xx / 404 → `temporary` → retry with backoff.
 *   - 401 / 403 → `auth` → retry (the report survives and delivers after re-pair).
 *   - network/transport error (no HTTP status) → `network` → retry + lights up
 *     the connectivity UI.
 */

import {
  useOfflineQueueStore,
  submitFeedbackOnce,
  classifyUploadFailureCategory,
  CloudClientError,
  createLogger,
} from '@rebel/cloud-client';
import type { QueueItem, QueueConsumerResult, FeedbackRequest } from '@rebel/cloud-client';

const log = createLogger('feedbackQueueConsumer');

/**
 * Creates the `feedback` queue consumer callback (a plain async function for
 * `initOfflineQueueStore`, not a React hook).
 */
export function createFeedbackQueueConsumer(): (
  item: QueueItem,
  payloadUri: string | null,
  signal?: AbortSignal,
) => Promise<QueueConsumerResult> {
  return async (item: QueueItem, _payloadUri: string | null, signal?: AbortSignal): Promise<QueueConsumerResult> => {
    const payload = await useOfflineQueueStore.getState().loadJsonPayload<FeedbackRequest>(item.id);

    if (!payload) {
      // The raw report is the only artifact; if it's gone there's nothing to
      // deliver and retrying can't recover it. Terminalize (permanent), loudly.
      log.warn('Feedback payload missing — cannot deliver', { itemId: item.id });
      return { success: false, error: 'Feedback payload missing', errorCategory: 'permanent' };
    }

    if (!payload.message?.trim()) {
      return { success: false, error: 'Feedback message is empty', errorCategory: 'permanent' };
    }

    if (signal?.aborted) {
      return { success: false, error: 'Aborted', errorCategory: 'timeout' };
    }

    try {
      await submitFeedbackOnce(payload, signal);
      log.info('Feedback delivered from offline queue', {
        itemId: item.id,
        attempts: item.attempts + 1,
      });
      return { success: true };
    } catch (err) {
      if (err instanceof CloudClientError && err.statusCode !== undefined) {
        const category = classifyUploadFailureCategory(err.statusCode);
        log.warn('Feedback delivery failed', { itemId: item.id, status: err.statusCode, category });
        return { success: false, error: `HTTP ${err.statusCode}`, errorCategory: category };
      }
      // No HTTP status → connectivity/transport failure. Retryable; surfaces the
      // connectivity UI via the queue's `network`-category handling.
      const message = err instanceof Error ? err.message : String(err);
      log.warn('Feedback delivery network error', { itemId: item.id, error: message });
      return { success: false, error: message, errorCategory: 'network' };
    }
  };
}
