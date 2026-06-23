// cloud-client/src/offlineQueue/classifyUploadFailureCategory.ts

import type { QueueErrorCategory } from './types';

/**
 * Map an HTTP status code from a media-upload endpoint (voice transcribe,
 * meeting recording upload, meeting chunk upload/finalize) to a
 * {@link QueueErrorCategory}.
 *
 * SSOT for the **permanent-whitelist** retry taxonomy shared by all three
 * media-upload consumers. It exists because the previous blanket
 * `status >= 400 -> 'permanent'` rule was the root cause of REBEL-6BJ /
 * FOX-3516: a transient `404` from `/api/voice/transcribe` (route-not-found
 * during a deploy window / version skew on a self-hosted personal cloud)
 * was classified `permanent`, which terminalizes the queue item immediately
 * (no retry, `maxAttempts: 1`) and permanently destroyed the user's recording.
 *
 * Design: encode endpoint *semantics*, not HTTP-class folklore. For an upload
 * endpoint, only a narrow set of 4xx statuses are genuinely permanent —
 * re-sending the same bytes cannot succeed (malformed request, payload too
 * large, unsupported/unprocessable media). Everything else is treated as
 * transient and retryable, because destroying a user's recording is far worse
 * than a bounded retry (the queue already caps retries at 10 attempts with
 * exponential backoff and a ~48h stale sweep).
 *
 * Mapping:
 * - `401` / `403`        -> `'auth'`       — token expired / invalid pairing.
 * - `400`/`413`/`415`/`422` -> `'permanent'` — malformed / too-large /
 *   unsupported / semantically-unprocessable; re-sending the same bytes
 *   won't help.
 * - `404`/`408`/`425`/`429` -> `'temporary'` — route-not-found (typically a
 *   deploy window / version skew on `/api/voice/transcribe`; meeting
 *   chunk/finalize can also legitimately return a session-not-found 404),
 *   request timeout, too-early, rate-limited. All treated as transient: a
 *   bounded retry (capped at 10 attempts) is far safer than permanently
 *   destroying a recording, even for a legitimate session-not-found 404.
 * - `>= 500`             -> `'temporary'` — transient server error.
 * - any other / unknown 4xx -> `'temporary'` — conservative default: prefer a
 *   bounded retry over destroying a recording.
 *
 * Note: this never returns `'defer'` (attempt-neutral -> endless retries) and
 * never returns `'network'` (thrown fetch errors are handled separately by the
 * consumers, which keep their `catch` -> `'network'` branch so the connectivity
 * UI lights up).
 *
 * @param status An HTTP status code from a non-2xx upload response.
 */
export function classifyUploadFailureCategory(status: number): QueueErrorCategory {
  // Auth — token expired or invalid pairing; needs re-auth, not retry.
  if (status === 401 || status === 403) {
    return 'auth';
  }

  // Genuinely permanent: re-sending the same bytes cannot succeed.
  // 400 malformed request, 413 payload too large, 415 unsupported media type,
  // 422 semantically invalid / unprocessable audio.
  if (status === 400 || status === 413 || status === 415 || status === 422) {
    return 'permanent';
  }

  // Transient server error.
  if (status >= 500) {
    return 'temporary';
  }

  // Transient 4xx (404 route-not-found/deploy-window, 408 timeout, 425 too
  // early, 429 rate-limited) AND any other/unknown 4xx — all retryable. A 404
  // is usually deploy/version skew (esp. on `/api/voice/transcribe`), though
  // meeting chunk/finalize can legitimately return session-not-found 404;
  // either way a bounded retry must not destroy the recording.
  return 'temporary';
}
