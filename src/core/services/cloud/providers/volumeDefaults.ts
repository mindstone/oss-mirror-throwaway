/**
 * Volume Size Defaults (shared across all BYOK providers)
 *
 * Single source of truth for the default volume size used when a user does
 * not supply one. Fly.io enforces a billing wall at 20 GB — new accounts
 * without a payment method cannot create volumes larger than 20 GB. The
 * default therefore sits deliberately below that threshold so the
 * no-footprint fallback never regresses the billing-wall UX that commit
 * `6146c509d` addressed.
 *
 * See planning doc:
 *   docs/plans/260419_cloud_setup_adaptive_sizing_and_honest_progress.md
 *   (Stage 2 — Provider Plumbing, DEFAULT_VOLUME_SIZE_GB amendment)
 */

/**
 * Fallback volume size for provisioning when no adaptive recommendation is
 * available. MUST remain below 20 GB so new Fly.io accounts without a
 * payment method can still provision on the zero-data fallback path.
 */
export const DEFAULT_VOLUME_SIZE_GB = 15;

/**
 * Fly.io's billing-wall threshold. Volumes larger than this require a
 * payment method on file. Exposed for the Stage 3 UI's inline warning.
 */
export const FLY_BILLING_WALL_GB = 20;

/**
 * Minimum recommended volume size in GB. A user with zero measured data
 * still gets something useful provisioned rather than "10 GB" feeling
 * stingy. Kept separate from `DEFAULT_VOLUME_SIZE_GB` because the IPC
 * Zod floor (10 GB) is the *input* floor, not the *recommendation* floor.
 */
const RECOMMENDED_MIN_GB = 10;

/**
 * Maximum volume size the IPC schema accepts. Must stay in sync with
 * the Zod `.max()` in `src/shared/ipc/channels/cloud.ts`.
 */
const RECOMMENDED_MAX_GB = 500;

/**
 * Bytes per gigabyte (binary — GiB). Matches the footprint walker's
 * accounting so the math agrees end-to-end.
 */
const BYTES_PER_GB = 1024 ** 3;

/**
 * Recommend a volume size in GB given a measured footprint in bytes.
 *
 * Policy (from plan Stage 3):
 *   - Floor at 10 GB so we never provision a volume the user immediately
 *     outgrows.
 *   - 3× multiplier on the measured size gives headroom for growth.
 *   - Round up to the nearest 5 GB (industry convention).
 *   - Clamp to 500 GB to stay inside the IPC schema range.
 *   - Zero or negative input returns `DEFAULT_VOLUME_SIZE_GB` — the
 *     no-data fallback value that sits below Fly's 20 GB billing wall.
 *
 * Examples:
 *   recommendVolumeGb(0)             === DEFAULT_VOLUME_SIZE_GB // 15
 *   recommendVolumeGb(4 * 1024 ** 3) === 15   // 4 GB workspace → 15 GB
 *   recommendVolumeGb(40 * 1024 ** 3) === 120 // 40 GB workspace → 120 GB
 *   recommendVolumeGb(1e15)          === 500  // clamped
 *
 * See planning doc:
 *   docs/plans/260419_cloud_setup_adaptive_sizing_and_honest_progress.md
 *   (Stage 3 — Recommendation math)
 */
export function recommendVolumeGb(totalBytes: number): number {
  if (!Number.isFinite(totalBytes) || totalBytes <= 0) {
    return DEFAULT_VOLUME_SIZE_GB;
  }
  const gb = totalBytes / BYTES_PER_GB;
  // Round up to the nearest 5 GB after the 3× headroom multiplier.
  const recommended = Math.ceil((3 * gb) / 5) * 5;
  return Math.min(RECOMMENDED_MAX_GB, Math.max(RECOMMENDED_MIN_GB, recommended));
}
