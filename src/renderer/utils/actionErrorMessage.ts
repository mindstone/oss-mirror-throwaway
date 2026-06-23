const DEFAULT_ERROR_MESSAGE = 'Something went sideways';

export function extractActionErrorMessage(error: unknown, fallback = DEFAULT_ERROR_MESSAGE): string {
  if (typeof error === 'string') {
    const trimmed = error.trim();
    return trimmed || fallback;
  }

  if (error instanceof Error) {
    const trimmed = error.message.trim();
    return trimmed || fallback;
  }

  if (typeof error === 'object' && error !== null) {
    for (const key of ['message', 'error', 'reason', 'detail']) {
      const value = (error as Record<string, unknown>)[key];
      if (typeof value === 'string' && value.trim()) {
        return value.trim();
      }
    }
  }

  return fallback;
}

export function toUserFacingActionErrorReason(error: unknown, fallback = DEFAULT_ERROR_MESSAGE): string {
  const message = extractActionErrorMessage(error, fallback);
  const lower = message.toLowerCase();

  if (
    lower.includes('eacces') ||
    lower.includes('eperm') ||
    lower.includes('erofs') ||
    lower.includes('permission denied') ||
    lower.includes('operation not permitted') ||
    lower.includes('read-only')
  ) {
    return 'Permission denied or the file is read-only. Check access and try again.';
  }

  if (
    lower.includes('enospc') ||
    lower.includes('edquot') ||
    lower.includes('no space left') ||
    lower.includes('quota exceeded')
  ) {
    return 'Not enough storage is available. Free up space and try again.';
  }

  if (
    lower.includes('network') ||
    lower.includes('fetch failed') ||
    lower.includes('failed to fetch') ||
    lower.includes('offline') ||
    lower.includes('econnreset') ||
    lower.includes('econnrefused') ||
    lower.includes('etimedout') ||
    lower.includes('timeout')
  ) {
    return "Couldn't reach the network. Check your connection and try again.";
  }

  return message;
}

export function appendErrorReason(title: string, error: unknown, fallback = DEFAULT_ERROR_MESSAGE): string {
  return `${title}: ${toUserFacingActionErrorReason(error, fallback)}`;
}
