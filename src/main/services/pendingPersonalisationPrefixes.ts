import { createScopedLogger } from '@core/logger';

const log = createScopedLogger({ service: 'pendingPersonalisationPrefixes' });

const MAX_ENTRY_BYTES = 20_000;
const MAX_ENTRIES = 64;

interface PendingEntry {
  prefix: string;
  createdAt: number;
}

const entries = new Map<string, PendingEntry>();

export function registerPendingPersonalisationPrefix(sessionId: string, prefix: string): void {
  const trimmed = prefix.trim();
  if (!sessionId || trimmed.length === 0) return;
  if (Buffer.byteLength(trimmed, 'utf8') > MAX_ENTRY_BYTES) {
    log.warn(
      { sessionId, byteLength: Buffer.byteLength(trimmed, 'utf8'), maxBytes: MAX_ENTRY_BYTES },
      'operators:personalisation_prefix_oversized_dropped',
    );
    return;
  }
  if (entries.size >= MAX_ENTRIES) {
    const oldestKey = entries.keys().next().value;
    if (oldestKey) entries.delete(oldestKey);
  }
  entries.set(sessionId, { prefix: trimmed, createdAt: Date.now() });
}

export function consumePendingPersonalisationPrefix(sessionId: string): string | undefined {
  if (!sessionId) return undefined;
  const entry = entries.get(sessionId);
  if (!entry) return undefined;
  entries.delete(sessionId);
  return entry.prefix;
}

export function peekPendingPersonalisationPrefix(sessionId: string): string | undefined {
  return entries.get(sessionId)?.prefix;
}

export function clearPendingPersonalisationPrefix(sessionId: string): void {
  entries.delete(sessionId);
}

export function clearAllPendingPersonalisationPrefixes(): void {
  entries.clear();
}
