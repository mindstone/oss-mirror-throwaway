/**
 * Re-export shim — canonical implementation lives in @core/utils/emfileRetry.
 * Defence-in-depth helper: covers `*Sync` and `node:fs/promises` named import
 * paths that the global graceful-fs patch (installed at boot) cannot reach.
 * The canonical copy carries the full JSDoc with the Sentry-based removal
 * roadmap and `maxAttempts: 1` guidance for callback-fs callers. See
 * `docs/plans/260428_graceful_fs_emfile_fix.md`.
 */
export {
  isTooManyOpenFilesError,
  withRetryOnEmfile,
  withSingleSyncRetryOnEmfile,
} from '@core/utils/emfileRetry';
export type { EmfileRetryOptions } from '@core/utils/emfileRetry';
