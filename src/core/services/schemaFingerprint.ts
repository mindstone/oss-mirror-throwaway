/**
 * Schema Fingerprint
 *
 * Deterministic hash over the cloud-service's persisted-store schema versions,
 * used to detect when an image rollback would cross a migration boundary.
 *
 * Cross-surface helper: used by both cloud-service (when stamping the last-
 * known-good record on a healthy boot) and desktop (when deciding whether to
 * surface a "schema drift" warning before the user clicks "Try previous
 * version"). Both surfaces MUST compute identical fingerprints for the same
 * inputs — this module is the single source of truth.
 *
 * Per Decision D3 (revised, see
 * docs/plans/260510_cloud_image_rollback_defense_in_depth.md):
 *   A fingerprint mismatch is a WARNING, not a block. The recovery path is
 *   prioritised over schema-safety pessimism; a degraded-but-running cloud
 *   beats a bricked cloud. The warning surfaces so operators can investigate
 *   genuine schema-corruption risks.
 */

import crypto from 'node:crypto';

/**
 * Compute a deterministic sha256 over the provided store-versions object.
 *
 * The input is typically `ALL_STORE_VERSIONS` from `src/core/constants.ts`,
 * but the function accepts any flat `Record<string, number>` so tests can
 * pass synthetic inputs.
 *
 * Determinism guarantees:
 * - Key order in the input object does NOT affect the output (we sort keys
 *   alphabetically before hashing).
 * - The hash is over a canonical UTF-8 string of `key=value` pairs joined by
 *   newlines. No JSON formatting is involved (so whitespace, trailing commas,
 *   etc. are not part of the hash).
 *
 * Returns: lowercase hex sha256 (64 characters).
 */
export function computeSchemaFingerprint(
  storeVersions: Record<string, number>,
): string {
  const entries = Object.entries(storeVersions)
    .map(([key, value]) => {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new Error(
          `computeSchemaFingerprint: non-numeric version for key '${key}': ${String(value)}`,
        );
      }
      return [key, value] as const;
    })
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  const canonical = entries.map(([key, value]) => `${key}=${value}`).join('\n');
  return crypto.createHash('sha256').update(canonical, 'utf8').digest('hex');
}
