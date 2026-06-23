/**
 * Canonical HTTP error catalog for Rebel Cloud routes.
 *
 * This is deliberately parallel to src/core/appBridge/shared/errors.ts, not a
 * replacement for it: AppBridge spans HTTP/MCP/WS compatibility surfaces while
 * this catalog describes cloud-service route JSON responses only.
 */

export interface CloudErrorCatalogEntry {
  defaultMessage: string;
  defaultStatus: number;
}

export const CLOUD_ERROR_CATALOG = {
  BODY_TOO_LARGE: {
    defaultStatus: 413,
    defaultMessage: "Request body exceeds maximum allowed size",
  },
  CATCH_UP_UNAVAILABLE: {
    defaultStatus: 500,
    defaultMessage: "Catch-up endpoint is unavailable",
  },
  CHANNEL_NOT_ALLOWED: {
    defaultStatus: 403,
    defaultMessage: "Channel is not available in cloud mode",
  },
  CHUNK_CONFLICT: {
    defaultStatus: 409,
    defaultMessage:
      "Chunk index already exists with a different idempotency key",
  },
  CHUNK_RANGE_GAP: {
    defaultStatus: 409,
    defaultMessage:
      "Chunk indices are not contiguous from 0 to totalChunks - 1",
  },
  CHUNK_TOO_LARGE: {
    defaultStatus: 413,
    defaultMessage: "Chunk exceeds maximum allowed size",
  },
  CHUNK_UPLOAD_FAILED: {
    defaultStatus: 500,
    defaultMessage: "Failed to persist uploaded chunk",
  },
  CONVERSATION_UNAVAILABLE: {
    defaultStatus: 404,
    defaultMessage: "This conversation is no longer available.",
  },
  DELETE_FAILED: { defaultStatus: 500, defaultMessage: "Delete failed" },
  DNS_DELETE_FAILED: {
    defaultStatus: 502,
    defaultMessage: "DNS delete failed",
  },
  DNS_NOT_CONFIGURED: {
    defaultStatus: 500,
    defaultMessage: "Cloudflare credentials not available",
  },
  FEEDBACK_FAILED: {
    defaultStatus: 500,
    defaultMessage: "Failed to submit feedback",
  },
  FILE_ACCESS_ERROR: {
    defaultStatus: 500,
    defaultMessage: "Unable to access file",
  },
  FILE_NOT_FOUND: { defaultStatus: 404, defaultMessage: "File not found" },
  FILE_TOO_LARGE: {
    defaultStatus: 413,
    defaultMessage: "Upload exceeds maximum size",
  },
  FIXTURE_MISCONFIGURATION: {
    defaultStatus: 500,
    defaultMessage: "E2E fixture route is not configured",
  },
  HANDLER_ERROR: {
    defaultStatus: 500,
    defaultMessage: "Internal handler error",
  },
  HANDLER_NOT_FOUND: {
    defaultStatus: 404,
    defaultMessage: "Handler not registered",
  },
  INTERNAL_ERROR: {
    defaultStatus: 500,
    defaultMessage: "An unexpected error occurred",
  },
  INVALID_BODY: {
    defaultStatus: 400,
    defaultMessage: "Request body must be a JSON object",
  },
  INVALID_CHUNK_INDEX: {
    defaultStatus: 400,
    defaultMessage: "X-Chunk-Index must be a non-negative integer",
  },
  INVALID_CONTENT_TYPE: {
    defaultStatus: 400,
    defaultMessage: "Content-Type must be an audio mime type",
  },
  INVALID_EXPIRY: {
    defaultStatus: 400,
    defaultMessage: "expiresIn must be one of: 24h, 7d, 30d, never",
  },
  INVALID_JSON: {
    defaultStatus: 400,
    defaultMessage: "Request body must be valid JSON",
  },
  INVALID_PARAM: {
    defaultStatus: 400,
    defaultMessage: "Request parameter is invalid",
  },
  INVALID_PASSWORD: {
    defaultStatus: 401,
    defaultMessage: "Incorrect password",
  },
  INVALID_PATH: {
    defaultStatus: 400,
    defaultMessage: "Path traversal not allowed",
  },
  INVALID_PAYLOAD: {
    defaultStatus: 400,
    defaultMessage: "Missing or invalid required fields",
  },
  INVALID_PLATFORM: {
    defaultStatus: 400,
    defaultMessage: 'platform must be "ios" or "android"',
  },
  INVALID_TAG: {
    defaultStatus: 400,
    defaultMessage:
      "Tag must match pattern: prod-<hash>, dev-<hash>, prod-latest, or dev-latest",
  },
  INVALID_TARGET: {
    defaultStatus: 400,
    defaultMessage: 'Target must be "workspace" or "appdata"',
  },
  INVALID_TOKEN: {
    defaultStatus: 400,
    defaultMessage: "deviceToken must be a non-empty string",
  },
  INVALID_TOKENS: {
    defaultStatus: 400,
    defaultMessage: "tokens must be a valid CodexTokens object or null",
  },
  INVALID_TOTAL_CHUNKS: {
    defaultStatus: 400,
    defaultMessage: "Body must include a positive integer `totalChunks`",
  },
  MANIFEST_FAILED: {
    defaultStatus: 500,
    defaultMessage: "Failed to build manifest",
  },
  METHOD_NOT_ALLOWED: {
    defaultStatus: 405,
    defaultMessage: "Method not allowed",
  },
  MISSING_IDEMPOTENCY_KEY: {
    defaultStatus: 400,
    defaultMessage: "X-Idempotency-Key header is required",
  },
  MISSING_SKILL_ID: {
    defaultStatus: 400,
    defaultMessage: "Body must include a non-empty `skillId`",
  },
  MISSING_TEXT: {
    defaultStatus: 400,
    defaultMessage: 'Request body must include a non-empty "text" field',
  },
  MEETING_SESSION_IDEMPOTENCY_CONFLICT: {
    defaultStatus: 409,
    defaultMessage: "Idempotency key was already used for a different companion session",
  },
  MEETING_SESSION_FINALIZE_COMPANION_MISMATCH: {
    defaultStatus: 409,
    defaultMessage: "Companion session id cannot change once the meeting session is bound",
  },
  NOT_FOUND: { defaultStatus: 404, defaultMessage: "Not found" },
  NO_SHARE: { defaultStatus: 404, defaultMessage: "No share link exists" },
  NO_WORKSPACE: {
    defaultStatus: 500,
    defaultMessage: "Core directory not configured",
  },
  PASSWORD_REQUIRED: {
    defaultStatus: 401,
    defaultMessage: "This content is password protected.",
  },
  PRIVATE_SESSION: {
    defaultStatus: 400,
    defaultMessage: "Cannot share a private conversation",
  },
  QUEUE_FULL: {
    defaultStatus: 503,
    defaultMessage:
      "Queue's full (200 items). Keep me online for a minute so I can clear space.",
  },
  RATE_LIMITED: {
    defaultStatus: 429,
    defaultMessage: "Too many requests. Try again shortly.",
  },
  READ_ERROR: { defaultStatus: 500, defaultMessage: "Failed to read" },
  RESOURCE_UNAVAILABLE: {
    defaultStatus: 404,
    defaultMessage: "This file is no longer available.",
  },
  SESSION_DELETED: {
    defaultStatus: 400,
    defaultMessage: "Cannot share a deleted conversation",
  },
  SESSION_MUTEX_DEADLOCK: {
    defaultStatus: 503,
    defaultMessage: "Session is busy. Try again shortly",
  },
  SESSION_NOT_FOUND: {
    defaultStatus: 404,
    defaultMessage: "Session not found",
  },
  SESSION_NOT_RECORDING: {
    defaultStatus: 409,
    defaultMessage: "Session no longer accepts new chunks",
  },
  TEXT_TOO_LONG: {
    defaultStatus: 400,
    defaultMessage: "Text must be 5000 characters or fewer",
  },
  TRANSCRIPTION_FAILED: {
    defaultStatus: 500,
    defaultMessage: "Transcription failed",
  },
  TTS_FAILED: { defaultStatus: 500, defaultMessage: "Text-to-speech failed" },
  TTS_UNAVAILABLE: {
    defaultStatus: 400,
    defaultMessage:
      "Text-to-speech is not available for the current voice provider",
  },
  TURN_NOT_FOUND: { defaultStatus: 404, defaultMessage: "No active turn" },
  UNAUTHORIZED: {
    defaultStatus: 401,
    defaultMessage: "Authentication required",
  },
  UNSUPPORTED_PROVIDER: {
    defaultStatus: 400,
    defaultMessage: "This action requires a different provider",
  },
  UPDATE_FAILED: { defaultStatus: 500, defaultMessage: "Update failed" },
  UPLOAD_FAILED: {
    defaultStatus: 500,
    defaultMessage: "Failed to save uploaded audio",
  },
  VALIDATION_ERROR: { defaultStatus: 400, defaultMessage: "Validation error" },
  WRITE_FAILED: { defaultStatus: 500, defaultMessage: "Failed to write" },
  LKG_READ_FAILED: { defaultStatus: 500, defaultMessage: "Failed to read last-known-good image record" },
  LIST_FILES_FAILED: { defaultStatus: 500, defaultMessage: "Failed to list workspace files" },
} as const satisfies Record<string, CloudErrorCatalogEntry>;

export type CloudErrorCode = keyof typeof CLOUD_ERROR_CATALOG;

export const QUEUE_FULL_USER_MESSAGE =
  CLOUD_ERROR_CATALOG.QUEUE_FULL.defaultMessage;
