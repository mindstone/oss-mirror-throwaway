/**
 * Shared copy for capability-mint error codes returned by the
 * `memory:staging-mint-conflict-capability` handler (Stage B of
 * `docs/plans/260417_approval_consolidation_closeout.md`).
 *
 * Extracted from `mobile/app/(tabs)/inbox.tsx` in Stage D so both the
 * inbox host and the new detail sheets can surface the same copy for
 * capability-mint failures. Keeps the strings in one place — the
 * canonical code catalog lives in `src/shared/ipc/channels/memory.ts`.
 *
 * Copy-tone: dry, Rebel-voice, terse. No platform-specific surfaces
 * mentioned ("try again" works on any surface).
 */

export function describeMintError(code: string): string {
  switch (code) {
    case 'UNKNOWN_STAGED_FILE':
      return 'This staged file was removed. Please refresh.';
    case 'SERVICE_UNAVAILABLE':
      return 'Unable to prepare conflict resolution. Please try again.';
    case 'INVALID_INPUT':
      return 'Could not start conflict resolution. Please try again.';
    case 'READ_ONLY':
      return 'Conflict resolution is currently unavailable.';
    default:
      return 'Could not start conflict resolution. Please try again.';
  }
}
