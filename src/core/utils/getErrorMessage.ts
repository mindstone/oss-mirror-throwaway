/**
 * Extract a human-readable error message from an unknown thrown value.
 *
 * Handles: Error instances, objects with a `.message` property, raw strings,
 * and arbitrary values (via String()). This is the single canonical
 * implementation — do not create local copies.
 */
export function getErrorMessage(error: unknown, fallback = ''): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'object' && error !== null) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message.length > 0) return message;
  }
  if (typeof error === 'string') {
    return error;
  }
  return error != null ? String(error) : fallback;
}
