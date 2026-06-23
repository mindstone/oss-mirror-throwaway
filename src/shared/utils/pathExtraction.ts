/**
 * Shared regex-based fallback for extracting path values from truncated/malformed JSON.
 *
 * sanitizeEventForRenderer may truncate large detail strings mid-JSON (e.g. Write
 * tool input with file content). JSON.parse fails on the result, but the path
 * key-value pairs are typically near the start and still intact.
 */

export const TOOL_PATH_KEYS = ['path', 'file_path', 'filepath', 'source', 'destination', 'old_path', 'new_path', 'file'] as const;

/**
 * Extract path-like key-value pairs from a possibly-truncated JSON string.
 * Returns a record of key → value for any PATH_KEYS found via regex.
 * Callers can filter further (e.g. by `isLikelyFilePath`).
 */
export const extractPathsFromMalformedJson = (detail: string): Record<string, string> => {
  const compact: Record<string, string> = {};
  for (const key of TOOL_PATH_KEYS) {
    const regex = new RegExp(`"${key}"\\s*:\\s*"([^"]+)"`, 'u');
    const match = detail.match(regex);
    if (match?.[1]) {
      compact[key] = match[1];
    }
  }
  return compact;
};
