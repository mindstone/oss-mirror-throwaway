/**
 * Constants for recent diagnostic context read-side surfaces.
 * Domain-local — do NOT add to src/core/constants.ts.
 */
export const MAX_TAIL_BYTES_PER_FILE = 2 * 1024 * 1024; // 2 MiB
export const MAX_TOTAL_TAIL_BYTES = 4 * 1024 * 1024; // 4 MiB hard ceiling
export const DEFAULT_RECENT_LOGS_BYTES = 256 * 1024; // 256 KiB soft default (~2000 typical pino lines)
export const MIN_RECENT_LOGS_BYTES = 1024; // 1 KiB
export const MAX_RECENT_LOGS_LINES = 2000;
export const DEFAULT_RECENT_LOGS_LINES = 200;
export const MIN_RECENT_LOGS_LINES = 1;
export const DEFAULT_WINDOW_HOURS = 24;
export const MIN_WINDOW_HOURS = 1;
export const MAX_WINDOW_HOURS = 168; // 1 week
export const DEFAULT_RECENT_EVENTS_LIMIT = 5;
export const MIN_RECENT_EVENTS_LIMIT = 1;
export const MAX_RECENT_EVENTS_LIMIT = 20;
export const MAIN_LOG_FILENAME_RE = /^mindstone-rebel(\.\d+)?\.log$/;
