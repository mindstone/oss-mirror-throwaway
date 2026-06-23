/**
 * Returns a strictly monotonic session content timestamp.
 *
 * Guarantees the returned value is greater than `previousUpdatedAt` when that
 * value is finite, which protects cloud merge ordering for status-only writes
 * that don't add a new message timestamp.
 */
export function nextContentUpdatedAt(previousUpdatedAt: number | undefined): number {
  const now = Date.now();
  if (typeof previousUpdatedAt !== 'number' || !Number.isFinite(previousUpdatedAt)) {
    return now;
  }
  return Math.max(now, previousUpdatedAt + 1);
}
