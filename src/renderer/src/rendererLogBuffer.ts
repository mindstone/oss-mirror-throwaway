/**
 * Renderer-process recent-log ring buffer (Stage 4 / Class B capture-context).
 *
 * Until now the renderer attached NO logs to its Sentry events — only redacted
 * breadcrumb *messages* (renderer log-breadcrumb `data` is dropped at
 * `beforeBreadcrumb`, see src/renderer/src/sentry.ts, because the @core
 * deny-by-default log allowlist can't cross the renderer↔core boundary). So a
 * renderer-side error reached Sentry with almost no context, forcing the
 * user's full `.zip` for diagnosis. This is the renderer counterpart of the
 * main-process buffer (src/core/logBuffer.ts) — a small, bounded, in-renderer
 * ring of the same {level, message, context} entries `emitLog` already
 * produces, attached (redacted) on renderer captures.
 *
 * Deliberately renderer-LOCAL (no @core import) to respect the boundary the
 * breadcrumb path documents. Redaction is applied at attachment time in
 * sentry.ts via the @shared redactors — identical to how the MAIN attachment
 * path redacts (formatLogsForAttachment → @shared redactObjectDeep); the
 * stricter @core breadcrumb allowlist is a separate path and is NOT what main's
 * attachment uses either, so this is parity, not a privacy regression.
 *
 * "More of the same, redacted" (founder constraint): no new data TYPES, no
 * richer auto-snapshot — just the renderer logs that already exist, attached.
 */

export interface RendererLogBufferEntry {
  timestamp: number;
  level: string;
  message: string;
  context?: Record<string, unknown>;
}

// ~5-minute / ≤1000-entry tail, matching the main buffer (src/core/logBuffer.ts).
// The emitted attachment is hard-capped at MAX_RENDERER_LOG_ATTACHMENT_SIZE
// (100KB tail) in sentry.ts, so this is safe from Sentry's `too_large` drop.
const RENDERER_LOG_BUFFER_WINDOW_MS = 300_000; // 5 minutes
const MAX_RENDERER_BUFFER_ENTRIES = 1000;

// Pre-allocated circular buffer (O(1) writes, zero per-call allocations) — same
// shape as the main buffer.
const buffer: (RendererLogBufferEntry | null)[] = new Array<RendererLogBufferEntry | null>(
  MAX_RENDERER_BUFFER_ENTRIES,
).fill(null);
let head = 0;
let count = 0;

/** Add a renderer log entry to the ring. O(1), zero allocations. */
export const addToRendererLogBuffer = (entry: RendererLogBufferEntry): void => {
  buffer[head] = entry;
  head = (head + 1) % MAX_RENDERER_BUFFER_ENTRIES;
  if (count < MAX_RENDERER_BUFFER_ENTRIES) count++;
};

/**
 * Get recent renderer log entries within the time window, oldest first.
 * @param windowMs - Time window in ms (default RENDERER_LOG_BUFFER_WINDOW_MS = 5 minutes).
 */
export const getRecentRendererLogs = (
  windowMs = RENDERER_LOG_BUFFER_WINDOW_MS,
): RendererLogBufferEntry[] => {
  const cutoff = Date.now() - windowMs;
  const result: RendererLogBufferEntry[] = [];
  for (let i = 0; i < count; i++) {
    const idx = (head - count + i + MAX_RENDERER_BUFFER_ENTRIES) % MAX_RENDERER_BUFFER_ENTRIES;
    const entry = buffer[idx];
    if (entry && entry.timestamp > cutoff) {
      result.push(entry);
    }
  }
  return result;
};

/**
 * Clear the buffer (testing).
 * @internal test-only seam — no production consumers (parity with the main
 * buffer's clearLogBuffer); the ring auto-evicts in production.
 */
export const clearRendererLogBuffer = (): void => {
  buffer.fill(null);
  head = 0;
  count = 0;
};
