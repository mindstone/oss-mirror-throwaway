/**
 * MCP Apps IPC Handlers
 * 
 * Handles IPC requests for MCP Apps UI resources.
 * Phase 1: Read-only views + package-scoped tool calls from MCP Apps iframes
 * 
 * @see https://modelcontextprotocol.io/docs/extensions/apps
 */

import { app, ipcMain, shell } from 'electron';
import path from 'node:path';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  MCP_APPS_BROADCAST_CHANNELS,
  mcpAppsChannels,
} from '@shared/ipc/contracts';
import { getBroadcastService } from '@core/broadcastService';
import { createScopedLogger } from '@core/logger';
import type {
  IframeMessageMethod,
  PermissionScope,
  TrustBoundaryRejection,
  TrustBoundaryRejectionReason,
} from '@shared/types/agent';
import { formatMcpAppSendMessageText } from '@shared/utils/mcpAppSendMessageAttribution';
import { mcpAppModelContextStore } from '../services/mcpAppModelContextStore';
import {
  buildTrustBoundaryLogEvent,
  checkLimit,
  ensureKnownV1ToolGrant,
  hashAttemptedContent,
  hashSourcePackageId,
  isGranted,
  isToolAllowed,
  issueNonce,
  listPermissions,
  recordHit,
  revoke as revokePermissionGrant,
  revokePackage,
  revokeTool,
  validateAndConsume,
  grant,
  grantTool,
  invalidateForConversation,
  invalidateForIframeInstance,
  deriveSourcePackageFamily,
  type NonceScope,
  type RateLimitScope,
} from '../services/mcpAppsTrust';
import { superMcpHttpManager } from '../services/superMcpHttpManager';

const logger = createScopedLogger({ service: 'mcpAppsHandlers' });

const MCP_CLIENT_INFO = {
  name: 'rebel-mcp-apps',
  version: process.env['npm_package_version'] ?? '0.0.0-dev',
};

/** Timeout for resource fetch requests (30 seconds) */
const RESOURCE_FETCH_TIMEOUT_MS = 30_000;
/** Timeout for MCP tool calls from app iframes (60 seconds) */
const TOOL_CALL_TIMEOUT_MS = 60_000;
const UI_INITIALIZE_METHOD: IframeMessageMethod = 'ui/initialize';
const SEND_MESSAGE_METHOD: IframeMessageMethod = 'ui/sendMessage';
const UPDATE_MODEL_CONTEXT_METHOD: IframeMessageMethod = 'ui/updateModelContext';
const TOOL_CALL_METHOD: IframeMessageMethod = 'tools/call';
const MAX_UPDATE_CONTEXT_CONTENT_CHARS = 16_384;
const MAX_UPDATE_CONTEXT_STRUCTURED_BYTES = 32 * 1024;
const MAX_SEND_MESSAGE_CONTENT_CHARS = 16_384;
const SAFETY_CLEANUP_MARKER = ' (cleaned for safety)';
const UNICODE_CONTROL_PATTERN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u200B-\u200F\uFEFF\u202A-\u202E\u2066-\u2069]/gu;
const UNICODE_TAG_CHARACTER_PATTERN = /[\u{E0000}-\u{E007F}]/gu;
const EXCESSIVE_COMBINING_MARKS_PATTERN = /\p{M}{4,}/gu;
const XML_ROLE_MARKER_PATTERN = /<\/?\s*(?:system|assistant|developer|user)\s*>|<\s*role\s*=\s*["']?\s*(?:system|assistant|developer|user)\s*["']?\s*>/giu;
const IM_START_MARKER_PATTERN = /<\|?im_start\|?>\s*(?:system|assistant|developer|user)\b|<\s*im_start\|\s*>\s*(?:system|assistant|developer|user)\b/giu;
const MARKDOWN_ROLE_FENCE_PATTERN = /(^|\n)\s*```\s*(?:system|assistant|developer|user|tool|function)\b[^\n]*(?=\n|$)/giu;
const TOOL_USE_MARKER_PATTERN = /<\/?\s*tool_use\b[^>]*>/giu;
const TOOL_KEYWORD_PATTERN = /\b(?:function_call|tool_call)\b/giu;
const BRACKET_ROLE_MARKER_PATTERN = /\[(?:user|assistant|system|developer)\]\s*:?\s*/giu;
const HOMOGLYPH_ROLE_WORD_PATTERN = String.raw`(?:[aаɑα][sѕ][sѕ][iіι1][sѕ][tтτ][aаɑα][nпո][tтτ]|[sѕ][yу][sѕ][tтτ][eе℮][mм]|[dԁ][eе℮][vν][eе℮][lӏ][oоο0][pр][eе℮][rг]|[uυ][sѕ][eе℮][rг])`;
const LINE_ROLE_CLAIM_PATTERN = new RegExp(String.raw`(^|\n)\s*(?:role\s*:\s*)?${HOMOGLYPH_ROLE_WORD_PATTERN}\s*:\s*`, 'giu');
const INLINE_ROLE_CONFUSION_PATTERN = new RegExp(String.raw`\bnow\s+act\s+as\s+${HOMOGLYPH_ROLE_WORD_PATTERN}\s*:?\s*`, 'giu');
const IGNORE_PREVIOUS_INSTRUCTIONS_PATTERN = /ignore\s+previous\s+instructions/iu;
const TOOL_CALL_LOOKALIKE_PATTERN = /\{[\s\r\n]*"tool"[\s\r\n]*:[\s\r\n]*"[^"]+"[\s\r\n]*,[\s\r\n]*"arguments"[\s\r\n]*:[\s\r\n]*(?:\{[\s\S]*?\}|\[[\s\S]*?\]|"[^"]*"|[^\}]+)\s*\}/gu;

export interface McpResourceContent {
  uri: string;
  mimeType?: string;
  text?: string;
  blob?: string;
}

export interface McpResourceResult {
  success: boolean;
  contents?: McpResourceContent[];
  error?: string;
}

export interface McpToolCallResult {
  success: boolean;
  result?: unknown;
  error?: string;
}

type UpdateContextRequest = z.input<typeof mcpAppsChannels['mcp:update-context']['request']>;
type ListPermissionsRequest = z.input<typeof mcpAppsChannels['mcp:list-permissions']['request']>;
type RevokePermissionRequest = z.input<typeof mcpAppsChannels['mcp:revoke-permission']['request']>;
type GrantPermissionRequest = z.input<typeof mcpAppsChannels['mcp:grant-permission']['request']>;
const SendMessageTrustRequestSchema = z.object({
  sourcePackageId: z.string(),
  toolUseId: z.string(),
  sessionId: z.string(),
  conversationId: z.string(),
  iframeInstanceId: z.string(),
  nonce: z.string(),
  content: z.string(),
  role: z.string(),
});
type SendMessageRequest = z.input<typeof SendMessageTrustRequestSchema>;
type TrustLogRequestFields = Pick<
  UpdateContextRequest,
  'sourcePackageId' | 'sessionId' | 'conversationId' | 'nonce' | 'toolUseId' | 'content' | 'structuredContent'
> & {
  method: IframeMessageMethod | string;
};

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function stringifyStructuredContent(value: unknown): { ok: true; text: string } | { ok: false; error: string } {
  try {
    return { ok: true, text: JSON.stringify(value) };
  } catch {
    return { ok: false, error: 'structuredContent must be JSON serializable' };
  }
}

function summarizeAttemptContent(request: Pick<UpdateContextRequest, 'content' | 'structuredContent'>): {
  bytes: number;
  hash?: string;
  oversize?: boolean;
} {
  const contentParts: string[] = [];
  if (typeof request.content === 'string') {
    const contentBytes = byteLength(request.content);
    if (contentBytes > MAX_UPDATE_CONTEXT_CONTENT_CHARS * 2) {
      return {
        bytes: contentBytes,
        oversize: true,
      };
    }
    contentParts.push(request.content.slice(0, MAX_UPDATE_CONTEXT_CONTENT_CHARS));
  }
  if (request.structuredContent !== undefined) {
    const structured = stringifyStructuredContent(request.structuredContent);
    if (structured.ok) {
      const structuredBytes = byteLength(structured.text);
      if (structuredBytes > MAX_UPDATE_CONTEXT_STRUCTURED_BYTES * 2) {
        return {
          bytes: byteLength(contentParts.join('\n')) + structuredBytes,
          oversize: true,
        };
      }
      contentParts.push(structured.text.slice(0, MAX_UPDATE_CONTEXT_STRUCTURED_BYTES));
    } else {
      contentParts.push('[unserializable structuredContent]');
    }
  }
  const joined = contentParts.join('\n');
  return {
    bytes: byteLength(joined),
    ...(joined ? { hash: hashAttemptedContent(joined) } : {}),
  };
}

function makeRejection(
  reason: TrustBoundaryRejectionReason,
  safeMessage: string,
  jsonRpcCode: TrustBoundaryRejection['jsonRpcCode'] = -32603,
): TrustBoundaryRejection {
  return {
    jsonRpcCode,
    reason,
    safeMessage,
    correlationId: randomUUID(),
  };
}

function logTrustRejection(
  request: TrustLogRequestFields,
  rejection: TrustBoundaryRejection,
  extra: {
    kind: Parameters<typeof buildTrustBoundaryLogEvent>[0]['kind'];
    subkind?: string;
    rateLimitTier?: Parameters<typeof buildTrustBoundaryLogEvent>[0]['rateLimitTier'];
    attemptCount?: number;
    timeSinceFirstAttemptMs?: number;
  },
): void {
  const attempt = summarizeAttemptContent(request);
  logger.warn(
    buildTrustBoundaryLogEvent({
      sourcePackageId: request.sourcePackageId,
      sessionId: request.sessionId,
      conversationId: request.conversationId,
      method: request.method,
      nonce: request.nonce,
      reason: rejection.reason,
      kind: extra.kind,
      ...(extra.subkind ? { subkind: extra.subkind } : {}),
      attemptedContentBytes: attempt.bytes,
      ...(request.toolUseId ? { toolUseId: request.toolUseId } : {}),
      ...(extra.rateLimitTier ? { rateLimitTier: extra.rateLimitTier } : {}),
      ...(typeof extra.attemptCount === 'number' ? { attemptCount: extra.attemptCount } : {}),
      ...(typeof extra.timeSinceFirstAttemptMs === 'number'
        ? { timeSinceFirstAttemptMs: extra.timeSinceFirstAttemptMs }
        : {}),
      ...(attempt.hash ? { attemptedContentHash: attempt.hash } : {}),
      ...(attempt.oversize ? { attemptedContentOversize: true } : {}),
    }),
    'Rejected MCP App iframe message at trust boundary',
  );
}

function extractStringField(value: unknown, key: string, fallback = 'unknown'): string {
  if (!value || typeof value !== 'object') {
    return fallback;
  }
  const field = (value as Record<string, unknown>)[key];
  return typeof field === 'string' && field.trim() ? field : fallback;
}

function trustLogFieldsFromUnknown(
  request: unknown,
  method: IframeMessageMethod | string,
): TrustLogRequestFields {
  const object = request && typeof request === 'object'
    ? request as Record<string, unknown>
    : {};
  return {
    sourcePackageId: extractStringField(request, 'sourcePackageId'),
    sessionId: extractStringField(request, 'sessionId'),
    conversationId: extractStringField(request, 'conversationId'),
    toolUseId: extractStringField(request, 'toolUseId', ''),
    nonce: extractStringField(request, 'nonce', ''),
    method,
    ...(typeof object['content'] === 'string' ? { content: object['content'] } : {}),
    ...(Object.prototype.hasOwnProperty.call(object, 'structuredContent')
      ? { structuredContent: object['structuredContent'] }
      : {}),
  };
}

function checkAndRecordRateLimit(
  scope: RateLimitScope,
  method: IframeMessageMethod,
) {
  const result = checkLimit(scope, method);
  recordHit(scope, method);
  return result;
}

function broadcastPermissionChanged(
  kind: 'granted' | 'revoked',
  scope: 'method' | 'tool' | 'conversation' | 'package',
  details?: {
    sourcePackageId?: string;
    conversationId?: string;
    method?: 'ui/updateModelContext' | 'ui/sendMessage' | 'tools/call';
    toolName?: string;
  },
): void {
  getBroadcastService().sendToAllWindows(MCP_APPS_BROADCAST_CHANNELS.PERMISSION_CHANGED, {
    kind,
    scope,
    ...details,
  });
}

function validateUpdateContextPayload(
  request: UpdateContextRequest,
): TrustBoundaryRejection | null {
  if (typeof request.content === 'string' && request.content.length > MAX_UPDATE_CONTEXT_CONTENT_CHARS) {
    return makeRejection(
      'invalid_params',
      'Context content is too long',
      -32602,
    );
  }

  if (request.structuredContent !== undefined) {
    const structured = stringifyStructuredContent(request.structuredContent);
    if (!structured.ok) {
      return makeRejection('invalid_params', structured.error, -32602);
    }
    if (byteLength(structured.text) > MAX_UPDATE_CONTEXT_STRUCTURED_BYTES) {
      return makeRejection(
        'invalid_params',
        'Structured context is too large',
        -32602,
      );
    }
  }

  return null;
}

export interface McpAppSendMessageSanitizationResult {
  sanitizedContent: string;
  removedMarkers: string[];
  removedControlCharCount: number;
  changed: boolean;
}

type SendMessagePayloadValidationResult =
  | { ok: true; sanitization: McpAppSendMessageSanitizationResult }
  | {
      ok: false;
      rejection: TrustBoundaryRejection;
      logKind: Parameters<typeof buildTrustBoundaryLogEvent>[0]['kind'];
      subkind?: string;
    };

function applySanitizerPattern(
  value: string,
  pattern: RegExp,
  marker: string,
  removedMarkers: Set<string>,
  replacement = '',
): string {
  pattern.lastIndex = 0;
  if (!pattern.test(value)) {
    return value;
  }
  removedMarkers.add(marker);
  pattern.lastIndex = 0;
  return value.replace(pattern, replacement);
}

export function sanitizeMcpAppSendMessageContent(content: string): McpAppSendMessageSanitizationResult {
  const normalized = content.replace(/\r\n?/gu, '\n');
  const truncated = normalized.slice(0, MAX_SEND_MESSAGE_CONTENT_CHARS);
  const removedMarkers = new Set<string>();
  if (normalized !== content) {
    removedMarkers.add('crlf_normalized');
  }
  let sanitized = truncated;

  const controlMatches = [
    ...sanitized.matchAll(UNICODE_CONTROL_PATTERN),
    ...sanitized.matchAll(UNICODE_TAG_CHARACTER_PATTERN),
    ...sanitized.matchAll(EXCESSIVE_COMBINING_MARKS_PATTERN),
  ];
  const removedControlCharCount = controlMatches.reduce((total, match) => total + (match[0]?.length ?? 0), 0);

  sanitized = applySanitizerPattern(sanitized, UNICODE_CONTROL_PATTERN, 'unicode_control', removedMarkers);
  sanitized = applySanitizerPattern(sanitized, UNICODE_TAG_CHARACTER_PATTERN, 'unicode_tag_characters', removedMarkers);
  sanitized = applySanitizerPattern(sanitized, EXCESSIVE_COMBINING_MARKS_PATTERN, 'excessive_combining_marks', removedMarkers);
  sanitized = applySanitizerPattern(sanitized, TOOL_CALL_LOOKALIKE_PATTERN, 'tool_call_json', removedMarkers);
  sanitized = applySanitizerPattern(sanitized, XML_ROLE_MARKER_PATTERN, 'xml_role_marker', removedMarkers);
  sanitized = applySanitizerPattern(sanitized, IM_START_MARKER_PATTERN, 'im_start_marker', removedMarkers);
  sanitized = applySanitizerPattern(sanitized, MARKDOWN_ROLE_FENCE_PATTERN, 'markdown_role_fence', removedMarkers, '$1');
  sanitized = applySanitizerPattern(sanitized, TOOL_USE_MARKER_PATTERN, 'tool_use_marker', removedMarkers);
  sanitized = applySanitizerPattern(sanitized, TOOL_KEYWORD_PATTERN, 'tool_keyword', removedMarkers);
  sanitized = applySanitizerPattern(sanitized, BRACKET_ROLE_MARKER_PATTERN, 'bracket_role_marker', removedMarkers);
  sanitized = applySanitizerPattern(sanitized, INLINE_ROLE_CONFUSION_PATTERN, 'inline_role_confusion', removedMarkers);
  sanitized = applySanitizerPattern(sanitized, LINE_ROLE_CLAIM_PATTERN, 'line_role_claim', removedMarkers, '$1');
  sanitized = sanitized.replace(/\n{3,}/gu, '\n\n').trim();

  return {
    sanitizedContent: sanitized,
    removedMarkers: [...removedMarkers],
    removedControlCharCount,
    changed: sanitized !== content,
  };
}

function validateSendMessagePayload(
  request: SendMessageRequest,
): SendMessagePayloadValidationResult {
  if (request.role !== 'user') {
    return {
      ok: false,
      rejection: makeRejection(
        'invalid_role',
        'View tried to send a message in an unauthorized role.',
        -32602,
      ),
      logKind: 'invalid_role',
    };
  }

  if (request.content.length > MAX_SEND_MESSAGE_CONTENT_CHARS) {
    return {
      ok: false,
      rejection: makeRejection(
        'invalid_params',
        'Message content is too long',
        -32602,
      ),
      logKind: 'invalid_params',
      subkind: 'oversized',
    };
  }

  const normalizedForLiteralChecks = request.content
    .normalize('NFKC')
    .replace(/\r\n?/gu, '\n');
  if (IGNORE_PREVIOUS_INSTRUCTIONS_PATTERN.test(normalizedForLiteralChecks)) {
    return {
      ok: false,
      rejection: makeRejection(
        'invalid_params',
        'Message content contains unsafe instruction text',
        -32602,
      ),
      logKind: 'invalid_params',
      subkind: 'prompt_injection_literal',
    };
  }

  const sanitization = sanitizeMcpAppSendMessageContent(request.content);
  if (!sanitization.sanitizedContent) {
    return {
      ok: false,
      rejection: makeRejection(
        'invalid_params',
        'Message content is empty after safety cleanup',
        -32602,
      ),
      logKind: 'invalid_params',
      subkind: 'all_stripped',
    };
  }

  return { ok: true, sanitization };
}

export function handleIssueNonce(request: unknown): { success: true; nonce: string } | { success: false; rejection: TrustBoundaryRejection } {
  const issueNonceChannel = mcpAppsChannels['mcp:issue-nonce'];
  const parsed = (() => {
    try {
      return issueNonceChannel.request.parse(request);
    } catch {
      const rejection = makeRejection('invalid_params', 'Invalid nonce request', -32602);
      logTrustRejection(trustLogFieldsFromUnknown(request, UI_INITIALIZE_METHOD), rejection, { kind: 'invalid_params' });
      return null;
    }
  })();
  if (!parsed) {
    return {
      success: false,
      rejection: makeRejection('invalid_params', 'Invalid nonce request', -32602),
    };
  }
  const rateLimitScope: RateLimitScope = {
    sourcePackageId: parsed.sourcePackageId,
    sessionId: parsed.sessionId,
    conversationId: parsed.conversationId,
    iframeInstanceId: parsed.iframeInstanceId,
  };
  const rateLimitResult = checkAndRecordRateLimit(rateLimitScope, UI_INITIALIZE_METHOD);
  if (!rateLimitResult.ok) {
    const rejection = makeRejection(
      'rate_limited',
      'View is sending too much context. It will retry shortly.',
      -32029,
    );
    logTrustRejection({
      ...parsed,
      method: UI_INITIALIZE_METHOD,
      nonce: 'none',
    }, rejection, {
      kind: 'rate_limit',
      rateLimitTier: rateLimitResult.tier,
      attemptCount: rateLimitResult.attemptCount,
      timeSinceFirstAttemptMs: rateLimitResult.timeSinceFirstAttemptMs,
    });
    return { success: false, rejection };
  }
  return {
    success: true,
    nonce: issueNonce(parsed),
  };
}

export function handleUpdateModelContext(
  request: unknown,
): { success: true } | { success: false; rejection: TrustBoundaryRejection } {
  const updateContextChannel = mcpAppsChannels['mcp:update-context'];
  const parsed = (() => {
    try {
      return updateContextChannel.request.parse(request);
    } catch {
      const rejection = makeRejection('invalid_params', 'Invalid context update request', -32602);
      logTrustRejection(trustLogFieldsFromUnknown(request, UPDATE_MODEL_CONTEXT_METHOD), rejection, { kind: 'invalid_params' });
      return null;
    }
  })();
  if (!parsed) {
    return {
      success: false,
      rejection: makeRejection('invalid_params', 'Invalid context update request', -32602),
    };
  }
  const trustLogFields = {
    ...parsed,
    method: UPDATE_MODEL_CONTEXT_METHOD,
  };
  const nonceScope: NonceScope = {
    sourcePackageId: parsed.sourcePackageId,
    sessionId: parsed.sessionId,
    conversationId: parsed.conversationId,
    toolUseId: parsed.toolUseId,
    iframeInstanceId: parsed.iframeInstanceId,
  };

  if (!validateAndConsume(nonceScope, parsed.nonce)) {
    const rejection = makeRejection('stale_nonce', 'Iframe nonce stale or invalid');
    logTrustRejection(trustLogFields, rejection, { kind: 'replay' });
    return { success: false, rejection };
  }

  const rateLimitScope: RateLimitScope = {
    sourcePackageId: parsed.sourcePackageId,
    sessionId: parsed.sessionId,
    conversationId: parsed.conversationId,
    iframeInstanceId: parsed.iframeInstanceId,
  };
  const rateLimitResult = checkAndRecordRateLimit(rateLimitScope, UPDATE_MODEL_CONTEXT_METHOD);
  if (!rateLimitResult.ok) {
    const rejection = makeRejection(
      'rate_limited',
      'View is sending too much context. It will retry shortly.',
      -32029,
    );
    logTrustRejection(trustLogFields, rejection, {
      kind: 'rate_limit',
      rateLimitTier: rateLimitResult.tier,
      attemptCount: rateLimitResult.attemptCount,
      timeSinceFirstAttemptMs: rateLimitResult.timeSinceFirstAttemptMs,
    });
    return { success: false, rejection };
  }

  const permissionScope = {
    sourcePackageId: parsed.sourcePackageId,
    conversationId: parsed.conversationId,
  };
  if (!isGranted(permissionScope, UPDATE_MODEL_CONTEXT_METHOD)) {
    const rejection = makeRejection(
      'permission_denied',
      'View tried to provide context to the assistant. Grant in Settings to enable.',
    );
    logTrustRejection(trustLogFields, rejection, { kind: 'permission_denial' });
    return { success: false, rejection };
  }

  const invalidPayload = validateUpdateContextPayload(parsed);
  if (invalidPayload) {
    logTrustRejection(trustLogFields, invalidPayload, { kind: 'invalid_params' });
    return { success: false, rejection: invalidPayload };
  }

  mcpAppModelContextStore.storeContext({
    sourcePackageId: parsed.sourcePackageId,
    conversationId: parsed.conversationId,
    toolUseId: parsed.toolUseId,
    ...(parsed.content !== undefined ? { content: parsed.content } : {}),
    ...(parsed.structuredContent !== undefined ? { structuredContent: parsed.structuredContent } : {}),
    storedAt: new Date().toISOString(),
  });
  return { success: true };
}

export function handleSendMessage(
  request: unknown,
): { success: true } | { success: false; rejection: TrustBoundaryRejection } {
  const parsed = (() => {
    try {
      return SendMessageTrustRequestSchema.parse(request);
    } catch {
      const rejection = makeRejection('invalid_params', 'Invalid send message request', -32602);
      logTrustRejection(trustLogFieldsFromUnknown(request, SEND_MESSAGE_METHOD), rejection, { kind: 'invalid_params' });
      return null;
    }
  })();
  if (!parsed) {
    return {
      success: false,
      rejection: makeRejection('invalid_params', 'Invalid send message request', -32602),
    };
  }
  const trustLogFields = {
    ...parsed,
    method: SEND_MESSAGE_METHOD,
  };
  const nonceScope: NonceScope = {
    sourcePackageId: parsed.sourcePackageId,
    sessionId: parsed.sessionId,
    conversationId: parsed.conversationId,
    toolUseId: parsed.toolUseId,
    iframeInstanceId: parsed.iframeInstanceId,
  };

  if (!validateAndConsume(nonceScope, parsed.nonce)) {
    const rejection = makeRejection('stale_nonce', 'Iframe nonce stale or invalid');
    logTrustRejection(trustLogFields, rejection, { kind: 'replay' });
    return { success: false, rejection };
  }

  const rateLimitScope: RateLimitScope = {
    sourcePackageId: parsed.sourcePackageId,
    sessionId: parsed.sessionId,
    conversationId: parsed.conversationId,
    iframeInstanceId: parsed.iframeInstanceId,
  };
  const rateLimitResult = checkAndRecordRateLimit(rateLimitScope, SEND_MESSAGE_METHOD);
  if (!rateLimitResult.ok) {
    const rejection = makeRejection(
      'rate_limited',
      'View is sending too many messages. It will retry shortly.',
      -32029,
    );
    logTrustRejection(trustLogFields, rejection, {
      kind: 'rate_limit',
      rateLimitTier: rateLimitResult.tier,
      attemptCount: rateLimitResult.attemptCount,
      timeSinceFirstAttemptMs: rateLimitResult.timeSinceFirstAttemptMs,
    });
    return { success: false, rejection };
  }

  const permissionScope = {
    sourcePackageId: parsed.sourcePackageId,
    conversationId: parsed.conversationId,
  };
  if (!isGranted(permissionScope, SEND_MESSAGE_METHOD)) {
    const rejection = makeRejection(
      'permission_denied',
      'View tried to send a message on your behalf. Grant in Settings to enable.',
    );
    logTrustRejection(trustLogFields, rejection, { kind: 'permission_denial' });
    return { success: false, rejection };
  }

  const payloadValidation = validateSendMessagePayload(parsed);
  if (!payloadValidation.ok) {
    logTrustRejection(trustLogFields, payloadValidation.rejection, {
      kind: payloadValidation.logKind,
      ...(payloadValidation.subkind ? { subkind: payloadValidation.subkind } : {}),
    });
    return { success: false, rejection: payloadValidation.rejection };
  }

  const timestamp = new Date().toISOString();
  const sourcePackageFamily = deriveSourcePackageFamily(parsed.sourcePackageId);
  const { sanitization } = payloadValidation;
  const sanitizedContent = sanitization.changed
    ? `${sanitization.sanitizedContent}${SAFETY_CLEANUP_MARKER}`
    : sanitization.sanitizedContent;
  if (sanitization.changed) {
    logger.info(
      {
        data: {
          boundary: 'mcp-apps-bidirectional-trust',
          kind: 'sanitization_applied',
          sourcePackageFamily,
          conversationId: parsed.conversationId,
          removedMarkersCount: sanitization.removedMarkers.length,
          removedControlCharCount: sanitization.removedControlCharCount,
          originalLength: parsed.content.length,
          sanitizedLength: sanitizedContent.length,
        },
      },
      'iframe message sanitized',
    );
  }
  const attributedText = formatMcpAppSendMessageText({
    sourcePackageId: parsed.sourcePackageId,
    sourcePackageFamily,
    toolUseId: parsed.toolUseId,
    timestamp,
    content: sanitizedContent,
  });

  try {
    getBroadcastService().sendToAllWindows('conversations:send-requested', {
      sessionId: parsed.conversationId,
      text: attributedText,
      displayText: sanitizedContent,
      sendMessage: true,
      switchToConversation: false,
      mcpAppAttribution: {
        sourcePackageFamily,
        toolUseId: parsed.toolUseId,
        timestamp,
      },
    });
  } catch (error) {
    const rejection = makeRejection(
      'invalid_params',
      'Could not send the app message. Rebel tripped over its own shoelaces.',
      -32603,
    );
    logTrustRejection(trustLogFields, rejection, { kind: 'injection_failed' });
    logger.error(
      {
        err: error,
        sourcePackageFamily,
        conversationId: parsed.conversationId,
        toolUseId: parsed.toolUseId,
      },
      'Failed to broadcast MCP App send-message request',
    );
    return { success: false, rejection };
  }

  logger.info(
    {
      sourcePackageFamily,
      conversationId: parsed.conversationId,
      toolUseId: parsed.toolUseId,
      contentLength: sanitizedContent.length,
    },
    'Accepted MCP App send-message request',
  );
  return { success: true };
}

function extractErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'string') {
    return error;
  }
  if (typeof error === 'object' && error !== null) {
    const errorMessage = (error as { message?: unknown }).message;
    if (typeof errorMessage === 'string') {
      return errorMessage;
    }
    try {
      return JSON.stringify(error);
    } catch {
      // Fall through to unknown error.
    }
  }
  return 'Unknown error';
}

/**
 * Extract package ID from source package identifier.
 * Accepts either a direct package ID ("google-workspace") or a UI URI ("ui://google-workspace/compose-email").
 */
export function extractSourcePackageId(sourcePackageId: string): string | null {
  const trimmed = sourcePackageId.trim();
  if (!trimmed) {
    return null;
  }

  if (!trimmed.startsWith('ui://')) {
    return trimmed;
  }

  try {
    const parsed = new URL(trimmed);
    return parsed.hostname || null;
  } catch {
    return null;
  }
}

/**
 * Normalize a requested tool name to a tool ID scoped to the source package.
 * If the tool name is package-prefixed (package__tool), enforce package match.
 */
export function normalizeScopedToolId(toolName: string, sourcePackageId: string): { toolId?: string; error?: string } {
  const trimmedToolName = toolName.trim();
  if (!trimmedToolName) {
    return { error: 'Tool name is required' };
  }

  if (trimmedToolName.startsWith(`${sourcePackageId}__`)) {
    const toolId = trimmedToolName.slice(sourcePackageId.length + 2).trim();
    if (!toolId) {
      return { error: 'Invalid namespaced tool name' };
    }
    return { toolId };
  }

  if (trimmedToolName.includes('__')) {
    const [toolPackageId] = trimmedToolName.split('__');
    if (toolPackageId && toolPackageId !== sourcePackageId) {
      return {
        error: `Tool "${trimmedToolName}" is outside source package scope "${sourcePackageId}"`,
      };
    }
  }

  return { toolId: trimmedToolName };
}

/**
 * Call a package-scoped MCP tool via Super-MCP.
 * Trust/allowlist checks happen before this helper; sourcePackageId routes to the package instance.
 */
async function callMcpTool(request: {
  appFamily: string;
  sourcePackageId: string;
  toolName: string;
  args: Record<string, unknown>;
}): Promise<McpToolCallResult> {
  const appFamily = request.appFamily.trim();
  if (!appFamily) {
    return {
      success: false,
      error: 'Missing appFamily for tool call',
    };
  }

  // Determine routing package ID from the host-derived source package instance.
  const routingPackageId = extractSourcePackageId(request.sourcePackageId) || appFamily;
  if (routingPackageId === appFamily) {
    logger.warn(
      { appFamily, sourcePackageFamily: deriveSourcePackageFamily(request.sourcePackageId) },
      'sourcePackageId invalid, falling back to appFamily for routing',
    );
  }

  // Upstream MCP servers namespace tools with their app-family name, not the Rebel-assigned instance ID
  const { toolId, error: toolIdError } = normalizeScopedToolId(request.toolName, appFamily);
  if (!toolId || toolIdError) {
    return {
      success: false,
      error: toolIdError ?? 'Invalid tool name',
    };
  }

  const state = superMcpHttpManager.getState();
  if (!state.isRunning || !state.url) {
    logger.warn({ routingPackageFamily: deriveSourcePackageFamily(routingPackageId), toolId }, 'Super-MCP HTTP server not running for mcp:call-tool');
    return {
      success: false,
      error: 'Super-MCP server is not running',
    };
  }

  const client = new Client(MCP_CLIENT_INFO);
  const transport = new StreamableHTTPClientTransport(new URL(state.url));
  const timeoutController = new AbortController();
  const timeoutId = setTimeout(() => timeoutController.abort(), TOOL_CALL_TIMEOUT_MS);

  try {
    logger.info(
      { appFamily, routingPackageFamily: deriveSourcePackageFamily(routingPackageId), toolId, argKeys: Object.keys(request.args ?? {}), superMcpUrl: state.url },
      'Calling MCP tool via Super-MCP',
    );

    await client.connect(transport);

    // Route to the specific package instance via Super-MCP
    const result = await client.callTool(
      {
        name: 'use_tool',
        arguments: {
          package_id: routingPackageId,
          tool_id: toolId,
          args: request.args,
        },
      },
      undefined,
      { signal: timeoutController.signal },
    );

    // Check for tool-level errors (MCP tools can return isError: true)
    if (result.isError) {
      const errorText = Array.isArray(result.content)
        ? result.content
            .filter((c: { type?: string; text?: string }) => c.type === 'text' && typeof c.text === 'string')
            .map((c: { text: string }) => c.text)
            .join('\n')
        : 'Tool call failed';
      logger.warn({ routingPackageFamily: deriveSourcePackageFamily(routingPackageId), toolId, error: errorText }, 'MCP tool returned isError');
      return { success: false, error: errorText };
    }

    return { success: true, result };
  } catch (error) {
    const message = extractErrorMessage(error);
    logger.error({ routingPackageFamily: deriveSourcePackageFamily(routingPackageId), toolId, error: message }, 'Error calling MCP tool via Super-MCP');
    return {
      success: false,
      error: message,
    };
  } finally {
    clearTimeout(timeoutId);
    try {
      await transport.terminateSession();
    } catch {
      // Ignore cleanup errors.
    }
    try {
      await client.close();
    } catch {
      // Ignore cleanup errors.
    }
  }
}

export async function handleCallTool(
  request: unknown,
): Promise<McpToolCallResult | { success: false; rejection: TrustBoundaryRejection }> {
  const callToolChannel = mcpAppsChannels['mcp:call-tool'];
  const parsed = (() => {
    try {
      return callToolChannel.request.parse(request);
    } catch {
      const rejection = makeRejection('invalid_params', 'Invalid tool call request', -32602);
      logTrustRejection(trustLogFieldsFromUnknown(request, TOOL_CALL_METHOD), rejection, { kind: 'invalid_params' });
      return null;
    }
  })();
  if (!parsed) {
    return {
      success: false,
      rejection: makeRejection('invalid_params', 'Invalid tool call request', -32602),
    };
  }

  const trustLogFields = {
    ...parsed,
    method: TOOL_CALL_METHOD,
  };
  const nonceScope: NonceScope = {
    sourcePackageId: parsed.sourcePackageId,
    sessionId: parsed.sessionId,
    conversationId: parsed.conversationId,
    toolUseId: parsed.toolUseId,
    iframeInstanceId: parsed.iframeInstanceId,
  };

  if (!validateAndConsume(nonceScope, parsed.nonce)) {
    const rejection = makeRejection('stale_nonce', 'Iframe nonce stale or invalid');
    logTrustRejection(trustLogFields, rejection, { kind: 'replay' });
    return { success: false, rejection };
  }

  const rateLimitScope: RateLimitScope = {
    sourcePackageId: parsed.sourcePackageId,
    sessionId: parsed.sessionId,
    conversationId: parsed.conversationId,
    iframeInstanceId: parsed.iframeInstanceId,
  };
  const rateLimitResult = checkAndRecordRateLimit(rateLimitScope, TOOL_CALL_METHOD);
  if (!rateLimitResult.ok) {
    const rejection = makeRejection(
      'rate_limited',
      'View is calling tools too quickly.',
      -32029,
    );
    logTrustRejection(trustLogFields, rejection, {
      kind: 'rate_limit',
      rateLimitTier: rateLimitResult.tier,
      attemptCount: rateLimitResult.attemptCount,
      timeSinceFirstAttemptMs: rateLimitResult.timeSinceFirstAttemptMs,
    });
    return { success: false, rejection };
  }

  const { toolId, error: toolIdError } = normalizeScopedToolId(parsed.toolName, parsed.appFamily);
  if (!toolId || toolIdError) {
    const rejection = makeRejection(
      'invalid_params',
      toolIdError ?? 'Invalid tool name',
      -32602,
    );
    logTrustRejection(trustLogFields, rejection, { kind: 'invalid_params' });
    return { success: false, rejection };
  }

  const permissionScope = {
    sourcePackageId: parsed.sourcePackageId,
    conversationId: parsed.conversationId,
  };
  const allowed = isToolAllowed(permissionScope, toolId)
    || ensureKnownV1ToolGrant(permissionScope, parsed.appFamily, toolId);

  if (!allowed) {
    const rejection = makeRejection(
      'tool_not_allowed',
      "View tried to use a tool that isn't allowed. Grant access in Settings.",
    );
    logTrustRejection(trustLogFields, rejection, { kind: 'permission_denial' });
    return { success: false, rejection };
  }

  logger.info(
    {
      appFamily: parsed.appFamily,
      sourcePackageFamily: deriveSourcePackageFamily(parsed.sourcePackageId),
      toolName: toolId,
      argKeys: Object.keys(parsed.args ?? {}),
    },
    'Calling MCP tool from MCP App iframe via IPC',
  );

  return callMcpTool(parsed);
}

export async function handleListPermissions(_request: ListPermissionsRequest): Promise<{
  permissions: ReturnType<typeof listPermissions>;
}> {
  return { permissions: listPermissions() };
}

function logPermissionRevoked(request: z.infer<typeof mcpAppsChannels['mcp:revoke-permission']['request']>): void {
  logger.info(
    {
      kind: 'permission_revoked',
      scope: request.scope,
      sourcePackageFamily: deriveSourcePackageFamily(request.sourcePackageId),
      sourcePackageIdHash: hashSourcePackageId(request.sourcePackageId),
      ...('conversationId' in request ? { conversationId: request.conversationId } : {}),
      ...('method' in request ? { method: request.method } : {}),
      ...('toolName' in request ? { toolName: request.toolName } : {}),
    },
    'Revoked MCP App permission',
  );
}

export async function handleRevokePermission(request: RevokePermissionRequest): Promise<{ success: true }> {
  const revokePermissionChannel = mcpAppsChannels['mcp:revoke-permission'];
  const parsed = revokePermissionChannel.request.parse(request);

  switch (parsed.scope) {
    case 'method': {
      revokePermissionGrant({
        sourcePackageId: parsed.sourcePackageId,
        conversationId: parsed.conversationId,
      }, [parsed.method]);
      break;
    }
    case 'tool': {
      revokeTool({
        sourcePackageId: parsed.sourcePackageId,
        conversationId: parsed.conversationId,
      }, parsed.toolName);
      break;
    }
    case 'conversation': {
      revokePermissionGrant({
        sourcePackageId: parsed.sourcePackageId,
        conversationId: parsed.conversationId,
      });
      break;
    }
    case 'package': {
      revokePackage(parsed.sourcePackageId);
      break;
    }
  }

  logPermissionRevoked(parsed);
  broadcastPermissionChanged('revoked', parsed.scope, {
    sourcePackageId: 'sourcePackageId' in parsed ? parsed.sourcePackageId : undefined,
    conversationId: 'conversationId' in parsed ? parsed.conversationId : undefined,
    method: parsed.scope === 'method' ? parsed.method : parsed.scope === 'tool' ? 'tools/call' : undefined,
    toolName: parsed.scope === 'tool' ? parsed.toolName : undefined,
  });
  return { success: true };
}

export async function handleGrantPermission(request: GrantPermissionRequest): Promise<{ success: true }> {
  const grantPermissionChannel = mcpAppsChannels['mcp:grant-permission'];
  const parsed = grantPermissionChannel.request.parse(request);
  const scope: PermissionScope = {
    sourcePackageId: parsed.sourcePackageId,
    conversationId: parsed.conversationId,
  };
  if (parsed.method === TOOL_CALL_METHOD && 'toolName' in parsed) {
    grantTool(scope, parsed.toolName);
    const details = {
      sourcePackageId: parsed.sourcePackageId,
      conversationId: parsed.conversationId,
      method: 'tools/call',
      toolName: parsed.toolName,
    } as const;
    logger.info(
      {
        kind: 'granted',
        scope: 'tool',
        sourcePackageId: details.sourcePackageId,
        conversationId: details.conversationId,
        method: details.method,
      },
      'mcp-app:permission-changed broadcast emitted',
    );
    broadcastPermissionChanged('granted', 'tool', details);
  } else {
    grant(scope, [parsed.method]);
    const details = {
      sourcePackageId: parsed.sourcePackageId,
      conversationId: parsed.conversationId,
      method: parsed.method,
    } as const;
    logger.info(
      {
        kind: 'granted',
        scope: 'method',
        sourcePackageId: details.sourcePackageId,
        conversationId: details.conversationId,
        method: details.method,
      },
      'mcp-app:permission-changed broadcast emitted',
    );
    broadcastPermissionChanged('granted', 'method', details);
  }
  return { success: true };
}

/**
 * Fetch a resource from Super-MCP via the MCP SDK client.
 * Uses proper StreamableHTTP transport with session initialization.
 * 
 * @param uri - The resource URI (e.g., ui://package/app.html)
 * @returns Resource contents or error
 */
async function fetchMcpResource(uri: string, sourcePackageId?: string): Promise<McpResourceResult> {
  if (!uri.startsWith('ui://')) {
    return {
      success: false,
      error: `Invalid resource URI scheme. Phase 1 only supports ui:// URIs. Got: ${uri}`,
    };
  }

  const state = superMcpHttpManager.getState();
  
  if (!state.isRunning || !state.url) {
    logger.warn({ uri }, 'Super-MCP HTTP server not running');
    return {
      success: false,
      error: 'Super-MCP server is not running. Please try again.',
    };
  }

  const client = new Client(MCP_CLIENT_INFO);
  const transport = new StreamableHTTPClientTransport(new URL(state.url));
  const timeoutController = new AbortController();
  const timeoutId = setTimeout(() => timeoutController.abort(), RESOURCE_FETCH_TIMEOUT_MS);

  try {
    logger.info({ uri, superMcpUrl: state.url }, 'Fetching MCP resource');

    await client.connect(transport);

    const result = await client.readResource(
      {
        uri,
        ...(sourcePackageId ? { _meta: { rebel_packageId: sourcePackageId } } : {}),
      },
      { signal: timeoutController.signal },
    );

    const contents = result?.contents;
    if (!contents || !Array.isArray(contents)) {
      logger.warn({ uri }, 'No contents in response');
      return { success: false, error: 'Resource not found or empty response' };
    }

    logger.info({ uri, contentsCount: contents.length }, 'Successfully fetched MCP resource');
    return { success: true, contents };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      logger.warn({ uri }, 'Resource fetch timed out');
      return {
        success: false,
        error: `Request timed out after ${RESOURCE_FETCH_TIMEOUT_MS / 1000} seconds`,
      };
    }
    
    const message = error instanceof Error ? error.message : 'Unknown error';
    logger.error({ uri, error: message }, 'Error fetching MCP resource');
    return { success: false, error: message };
  } finally {
    clearTimeout(timeoutId);
    try {
      await transport.terminateSession();
    } catch { /* ignore cleanup errors */ }
    try {
      await client.close();
    } catch { /* ignore cleanup errors */ }
  }
}

const PREVIEW_TEMP_DIR = 'rebel-canvas-preview';
const TEMP_FILE_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

function getPreviewTempDir(): string {
  return path.join(app.getPath('temp'), PREVIEW_TEMP_DIR);
}

/**
 * Clean up preview temp files older than 24 hours.
 * Called on app startup to prevent accumulation.
 */
export async function cleanupPreviewTempFiles(): Promise<void> {
  const dir = getPreviewTempDir();
  try {
    const entries = await fs.readdir(dir).catch(() => []);
    const now = Date.now();
    let cleaned = 0;
    for (const entry of entries) {
      try {
        const filePath = path.join(dir, entry);
        const stat = await fs.stat(filePath);
        if (now - stat.mtimeMs > TEMP_FILE_MAX_AGE_MS) {
          await fs.unlink(filePath);
          cleaned++;
        }
      } catch { /* skip files that can't be stat'd or deleted */ }
    }
    if (cleaned > 0) {
      logger.info({ cleaned, dir }, 'Cleaned up preview temp files');
    }
  } catch { /* directory may not exist yet */ }
}

/**
 * Register MCP Apps IPC handlers.
 */
export function registerMcpAppsHandlers(): void {
  const readResourceChannel = mcpAppsChannels['mcp:read-resource'];
  
  ipcMain.handle(readResourceChannel.channel, async (_event, request) => {
    const { uri, sourcePackageId } = readResourceChannel.request.parse(request);
    
    logger.info(
      { uri, sourcePackageFamily: deriveSourcePackageFamily(sourcePackageId) },
      'Reading MCP resource via IPC',
    );
    
    try {
      return await fetchMcpResource(uri, sourcePackageId);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error reading MCP resource';
      logger.error({ uri, error: message }, 'Error in MCP resource handler');
      return {
        success: false,
        error: message,
      };
    }
  });

  const openHtmlChannel = mcpAppsChannels['mcp:open-html-in-browser'];

  ipcMain.handle(openHtmlChannel.channel, async (_event, request) => {
    const { html } = openHtmlChannel.request.parse(request);

    try {
      const dir = getPreviewTempDir();
      await fs.mkdir(dir, { recursive: true });
      const fileName = `preview-${Date.now()}.html`;
      const filePath = path.join(dir, fileName);
      await fs.writeFile(filePath, html, 'utf8');
      const result = await shell.openPath(filePath);
      if (result) {
        logger.warn({ filePath, result }, 'shell.openPath returned error');
        return { success: false, error: result };
      }
      logger.info({ filePath }, 'Opened HTML preview in browser');
      return { success: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to open HTML in browser';
      logger.error({ error: message }, 'Error opening HTML in browser');
      return { success: false, error: message };
    }
  });

  const callToolChannel = mcpAppsChannels['mcp:call-tool'];

  ipcMain.handle(callToolChannel.channel, async (_event, request) => {
    try {
      return await handleCallTool(request);
    } catch (error) {
      const message = extractErrorMessage(error);
      logger.error(
        { error: message },
        'Error in MCP tool call handler',
      );
      return {
        success: false,
        error: message,
      };
    }
  });

  const issueNonceChannel = mcpAppsChannels['mcp:issue-nonce'];

  ipcMain.handle(issueNonceChannel.channel, async (_event, request) => handleIssueNonce(request));

  const updateContextChannel = mcpAppsChannels['mcp:update-context'];

  ipcMain.handle(updateContextChannel.channel, async (_event, request) => handleUpdateModelContext(request));

  const sendMessageChannel = mcpAppsChannels['mcp:send-message'];

  ipcMain.handle(sendMessageChannel.channel, async (_event, request) => handleSendMessage(request));

  const invalidateNonceChannel = mcpAppsChannels['mcp:invalidate-nonce'];
  ipcMain.handle(invalidateNonceChannel.channel, async (_event, request) => {
    const parsed = invalidateNonceChannel.request.parse(request);
    invalidateForIframeInstance(parsed.iframeInstanceId);
    return { success: true };
  });

  const invalidateConversationNoncesChannel = mcpAppsChannels['mcp:invalidate-conversation-nonces'];
  ipcMain.handle(invalidateConversationNoncesChannel.channel, async (_event, request) => {
    const parsed = invalidateConversationNoncesChannel.request.parse(request);
    invalidateForConversation(parsed.conversationId);
    return { success: true };
  });

  const grantPermissionChannel = mcpAppsChannels['mcp:grant-permission'];
  ipcMain.handle(grantPermissionChannel.channel, async (_event, request) => handleGrantPermission(request));

  const listPermissionsChannel = mcpAppsChannels['mcp:list-permissions'];
  ipcMain.handle(listPermissionsChannel.channel, async (_event, request) => {
    listPermissionsChannel.request.parse(request);
    return handleListPermissions(request);
  });

  const revokePermissionChannel = mcpAppsChannels['mcp:revoke-permission'];
  ipcMain.handle(revokePermissionChannel.channel, async (_event, request) => handleRevokePermission(request));
  
  logger.info('MCP Apps handlers registered');
}
