/**
 * Sanitize tool inputs for approval request storage.
 *
 * Strips large base64-like string values from tool inputs before they're
 * stored in ToolApprovalRequest, broadcast via IPC, and persisted to disk.
 *
 * The runtime retains the full tool_use block, so the retry will
 * still have access to the original input. The sanitized version is only used
 * for UI display (approval cards, details accordion) and persistence.
 *
 * Without this, tools like gmail__send_email that include base64 file
 * attachments in their input can blow up the conversation context window
 * when the approval flow accumulates duplicate base64 in session history.
 */

const BASE64_MIN_LENGTH = 1_000;
const BASE64_PATTERN = /^(?:data:[^;]*;base64,)?[A-Za-z0-9+/\n\r]{500,}={0,2}$/;
const PLACEHOLDER = '[base64 content stripped for approval display]';

function isLikelyBase64(value: string): boolean {
  if (value.length < BASE64_MIN_LENGTH) return false;
  return BASE64_PATTERN.test(value.trim());
}

function sanitizeValue(value: unknown): unknown {
  if (typeof value === 'string') {
    return isLikelyBase64(value) ? PLACEHOLDER : value;
  }
  if (Array.isArray(value)) {
    return value.map(sanitizeValue);
  }
  if (value !== null && typeof value === 'object') {
    return sanitizeRecord(value as Record<string, unknown>);
  }
  return value;
}

function sanitizeRecord(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(obj)) {
    result[key] = sanitizeValue(val);
  }
  return result;
}

/**
 * Strip large base64 values from a tool input object.
 * Returns a new object with base64 strings replaced by a placeholder.
 */
export function sanitizeToolInputForApproval(input: Record<string, unknown>): Record<string, unknown> {
  return sanitizeRecord(input);
}

/**
 * Return a renderer-safe copy of a staged tool call while preserving the exact
 * execution payload in main-process storage.
 */
export function sanitizeStagedToolCallForApproval<
  T extends { mcpPayload: { args: Record<string, unknown> } }
>(call: T): T {
  return {
    ...call,
    mcpPayload: {
      ...call.mcpPayload,
      args: sanitizeToolInputForApproval(call.mcpPayload.args),
    },
  };
}
