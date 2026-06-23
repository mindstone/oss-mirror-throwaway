/**
 * Renderer helper for surfacing reveal/open-path failures to the user (FOX-3422).
 *
 * Previously, "Open in Finder" / file-link clicks that failed (the file moved,
 * or the OS blocked access — e.g. macOS Full Disk Access) were silently
 * swallowed: `app:reveal-path` resolved `undefined`, and `app:open-path`
 * rejections were `void`/`fireAndForget`-ed. This helper normalizes both a
 * structured `RevealPathResult` and a thrown open-path error into a single
 * user-facing toast.
 */
import type { RevealPathResult } from '@shared/ipc/channels/app';

type ShowToast = (options: { title: string }) => void;

/** Generic, friendly copy covering both "moved" and "blocked access" cases. */
export const PATH_OPEN_FAILURE_MESSAGE =
  "Couldn't show that file. It may have moved, or your computer may be blocking access.";

/**
 * Show a failure toast for a reveal/open-path operation.
 *
 * Accepts either the structured `RevealPathResult` returned by
 * `window.appApi.revealPath(...)`, or an unknown error thrown by
 * `window.appApi.openPath(...)`. Returns `true` if a failure toast was shown
 * (i.e. the operation failed), `false` if the result indicates success.
 */
export function showPathOpenFailureToast(
  resultOrError: RevealPathResult | unknown,
  showToast: ShowToast | undefined,
): boolean {
  // Success case: structured result with ok === true.
  if (
    resultOrError != null &&
    typeof resultOrError === 'object' &&
    'ok' in resultOrError &&
    (resultOrError as RevealPathResult).ok === true
  ) {
    return false;
  }

  showToast?.({ title: PATH_OPEN_FAILURE_MESSAGE });
  return true;
}
