const LOG_PREFIX = '[pendingRetryStore]';

const PENDING_RETRY_STORAGE_VERSION = 1;

export const MAX_PERSISTED_RETRIES = 10;
export const PENDING_RETRIES_LS_KEY = `pending-network-retries:v${PENDING_RETRY_STORAGE_VERSION}`;

export interface PersistedPendingRetry {
  sessionId: string;
  userMessageText: string;
  failedAt: number;
  retryCount: number;
  attachmentCacheIds?: string[];
}

export interface PendingRetryStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === 'string');

const isPersistedPendingRetry = (value: unknown): value is PersistedPendingRetry => {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const retry = value as Record<string, unknown>;
  return (
    typeof retry.sessionId === 'string'
    && typeof retry.userMessageText === 'string'
    && typeof retry.failedAt === 'number'
    && Number.isFinite(retry.failedAt)
    && typeof retry.retryCount === 'number'
    && Number.isFinite(retry.retryCount)
    && (retry.attachmentCacheIds === undefined || isStringArray(retry.attachmentCacheIds))
  );
};

const saveRetries = (
  storage: PendingRetryStorage,
  retries: PersistedPendingRetry[],
): void => {
  if (retries.length === 0) {
    storage.removeItem(PENDING_RETRIES_LS_KEY);
    return;
  }

  storage.setItem(PENDING_RETRIES_LS_KEY, JSON.stringify(retries));
};

export function getPersistedRetries(storage: PendingRetryStorage): PersistedPendingRetry[] {
  try {
    const raw = storage.getItem(PENDING_RETRIES_LS_KEY);
    if (!raw) return [];

    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed
      .filter(isPersistedPendingRetry)
      .slice(-MAX_PERSISTED_RETRIES);
  } catch (error) {
    console.warn(LOG_PREFIX, 'Failed to load persisted retries', error);
    return [];
  }
}

export function persistRetry(
  storage: PendingRetryStorage,
  retry: PersistedPendingRetry,
): void {
  try {
    const existing = getPersistedRetries(storage);
    const filtered = existing.filter((entry) => entry.sessionId !== retry.sessionId);
    filtered.push(retry);

    while (filtered.length > MAX_PERSISTED_RETRIES) {
      filtered.shift();
    }

    saveRetries(storage, filtered);
  } catch (error) {
    console.warn(LOG_PREFIX, 'Failed to persist retry', error);
  }
}

export function clearPersistedRetry(
  storage: PendingRetryStorage,
  sessionId: string,
): void {
  try {
    const existing = getPersistedRetries(storage);
    saveRetries(
      storage,
      existing.filter((entry) => entry.sessionId !== sessionId),
    );
  } catch (error) {
    console.warn(LOG_PREFIX, 'Failed to clear persisted retry', error);
  }
}

export function clearAllPersistedRetries(storage: PendingRetryStorage): void {
  try {
    storage.removeItem(PENDING_RETRIES_LS_KEY);
  } catch (error) {
    console.warn(LOG_PREFIX, 'Failed to clear all persisted retries', error);
  }
}
