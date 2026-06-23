/**
 * Generic IPC forwarding route handler.
 */

import http from 'node:http';
import { z } from 'zod';
import { readBody, sendJson, log, sendRouteError, RouteError } from '../httpUtils';
import type { CloudServiceDeps } from '../bootstrap';
import { CLOUD_IPC_ALLOWLIST as SHARED_IPC_ALLOWLIST } from '@shared/cloudChannelPolicies';
import type { AgentSession } from '@shared/types';
import { AgentSessionSchema } from '@shared/ipc/schemas/agent';
import { observingSafeParse } from '@shared/ipc/schemas/utils/observingSafeParse';
import { clearServerClockSession, stampCloudUpdatedAt } from '@core/services/continuity/serverClock';
import { getMaxSeqFromSession, getSessionSeqIndex, stampMissingEventSeq } from '@core/services/continuity/sessionSeqIndex';
import { SAFETY_ACTIVITY_LOG_MAX_ENTRIES } from '@core/safetyActivityLogTypes';

/**
 * Adapter that lets `observingSafeParse` log through the cloud-service
 * `log({ level, msg, ...rest })` shape, which differs from the pino-style
 * `warn(obj, msg)` shape that `observingSafeParse`'s `BaseLogger` expects.
 *
 * Observability-only — the underlying call routes to `cloudLog.warn(...)`
 * inside `httpUtils.log`.
 */
const observingSafeParseLogger = {
  warn: (obj: Record<string, unknown>, msg: string) => {
    log({ level: 'warn', msg, ...obj });
  },
};

/**
 * Server-side allowlist of IPC channels that can be handled via the generic endpoint.
 *
 * Starts from the shared CLOUD_IPC_ALLOWLIST (channels with transport: 'ipc') and adds
 * server-only channels that are used by cloud-side code directly, not client-routed.
 */
export const CLOUD_IPC_ALLOWLIST = new Set([
  ...SHARED_IPC_ALLOWLIST,
  // Server-only channels — used by cloud-side code, not routed from the desktop client
  'sessions:save-sync',
  'sessions:export-logs',
  'sessions:generate-summary',
  'sessions:get-diagnostic-summary',
  // Mobile/web-facing channels — called by cloud-client directly, not desktop-routed.
  // These were previously in CLOUD_CHANNEL_POLICIES but removed since desktop no
  // longer needs to forward them. Cloud-service still needs to serve them.
  // See: cloud-client/src/stores/approvalStore.ts for the canonical list of mobile IPC calls.
  'library:scan-skills',
  'tool-safety:pending',
  'tool-safety:staged-get-all',
  'tool-safety:staged-execute',
  'tool-safety:staged-execute-batch',
  'tool-safety:staged-reject',
  'tool-safety:staged-clear-session',
  'memory:get-pending-approvals',
  'memory:write-approval-response',
  // Desktop catch-up read of the cloud's own safety activity log; mirrors tool-safety:pending.
  'safety-activity-log:get',
  // Inbox — called by cloud-client directly, not desktop-routed.
  'inbox:load',
  'inbox:load-index',
  'inbox:load-items',
  'inbox:delete',
  'inbox:record-execution',
  'inbox:mark-archived',
  'inbox:set-archived',
  'inbox:set-quadrant',
  'inbox:set-dueBy',
  'inbox:set-executing',
  'inbox:add',
  'inbox:execute',
  'inbox:upsert',
  // Safety-prompt principle generation — used by mobile approval transport (F-R2-2).
  // Handlers are already registered in cloud-service via registerSafetyPromptHandlers().
  'safety-prompt:generate-options',
  'safety-prompt:apply-selection',
  'safety-prompt:generate-deny-options',
  'safety-prompt:apply-deny-selection',
  // 'safety-prompt:update' is the persistence channel called by
  // ApprovalTransport.safetyPrompt.update(). It is already reachable through
  // the shared cloudChannelPolicies allowlist (transport: 'ipc'), and listed
  // here explicitly so this file serves as a single readable catalog of the
  // approval-flow surface exposed to mobile. Duplicates are deduped by the Set.
  'safety-prompt:update',
  // Settings — narrow-slice channels only (D11 in approval consolidation plan).
  // Full settings:get / settings:update are NOT allowlisted (would leak secrets).
  'settings:set-space-safety-level',
  'settings:add-trusted-tool',
  // Memory staging — resolution of staged writes from web/mobile
  'memory:staging-get-all',
  'memory:staging-get-content',
  'memory:staging-publish',
  'memory:staging-discard',
  'memory:staging-keep-private',
  'memory:staging-resolve-conflict',
  // Stage B (260417_approval_consolidation_closeout): capability-token mint
  // endpoint. Process-local secret — each instance (desktop + cloud) mints
  // and validates its own tokens. Added here so mobile can reach the cloud
  // instance's mint handler. NOT in CLOUD_CHANNEL_POLICIES (no dual-write —
  // desktop/cloud secrets don't sync).
  'memory:staging-mint-conflict-capability',
  'memory:staging-publish-all',
  'memory:staging-discard-all',
  'memory:staging-cleanup',
  // User question response — mobile/cloud-client submits an answer to an
  // AskUserQuestion batch that paused a turn. Returns the continuation
  // message; the client calls startTurn(..., isSystemContinuation:true)
  // to resume. Handler registered in bootstrap.ts via
  // registerUserQuestionResponseHandler(). See:
  // docs/plans/260420_user_question_cross_surface_resilience.md
  'agent:user-question-response',
]);

// ---------------------------------------------------------------------------
// Route-level Zod schemas for channels that accept complex payloads (F-R2-2).
// These cap free-text fields as defense-in-depth and reject malformed payloads
// BEFORE the handler runs (round-2 F17/F18 input-validation requirement).
// ---------------------------------------------------------------------------

/**
 * F4-2: Serialized `toolInput` cap for LLM-hitting endpoints.
 *
 * Matches `TOOL_INPUT_MAX_CHARS` in `src/core/safetyPromptLogic.ts` and the
 * Stage 4 Input Validation table. Without this cap a paired client could
 * send up to the global 10 MB body limit straight into the principle
 * generation LLM, inflating cost and giving the model injection surface.
 */
const TOOL_INPUT_MAX_CHARS = 4000;

const BlockedActionContextRouteSchema = z
  .object({
    toolName: z.string().max(128),
    toolInput: z.record(z.string(), z.unknown()),
    spaceDescription: z.string().max(2000).optional(),
    sessionType: z.enum(['interactive', 'automation', 'role']).optional(),
    automationName: z.string().max(256).optional(),
    blockReason: z.string().max(2000),
  })
  .superRefine((ctx, issue) => {
    // `JSON.stringify` is deterministic for plain objects-of-unknowns used
    // here; if serialization throws (e.g. circular refs a client sneaks
    // through) we treat that as invalid rather than letting it propagate.
    let serialized: string;
    try {
      serialized = JSON.stringify(ctx.toolInput);
    } catch {
      issue.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['toolInput'],
        message: 'toolInput is not serializable',
      });
      return;
    }
    if (serialized.length > TOOL_INPUT_MAX_CHARS) {
      issue.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['toolInput'],
        message: `toolInput exceeds ${TOOL_INPUT_MAX_CHARS} char cap (got ${serialized.length})`,
      });
    }
  });

const PrincipleApplyRouteSchema = z.object({
  blockedAction: BlockedActionContextRouteSchema,
  selectedLabel: z.string().max(100),
  scope: z.enum(['trusted_tool', 'broad', 'specific']),
});

const SetSpaceSafetyLevelRouteSchema = z.object({
  spaceId: z.string().min(1).max(128),
  level: z.enum(['permissive', 'balanced', 'cautious']),
});

/**
 * F4-4: `toolId` format regex.
 *
 * `bareToolId()` in `src/shared/utils/trustedToolNormalization.ts` strips
 * everything up to the last `/`, so malformed IDs like `'gmail/'` would
 * normalize to the empty string and the handler would then store a blank
 * canonical ID. The route rejects these before the handler runs.
 *
 * The regex intentionally stays permissive: alphanumerics, underscore,
 * dot, dash, optionally a single `/` separator (for legacy
 * `packageId/toolId` compound payloads). Both halves of the compound must
 * be non-empty.
 */
const TRUSTED_TOOL_ID_REGEX = /^[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)?$/;

const AddTrustedToolRouteSchema = z.object({
  toolId: z.string().min(1).max(128).regex(TRUSTED_TOOL_ID_REGEX, {
    message:
      'toolId must be an alphanumeric identifier (allowing _ . -), optionally prefixed with "<packageId>/"; empty segments and trailing slashes are rejected',
  }),
  displayName: z.string().max(128).optional(),
  serverHint: z.string().max(256).optional(),
});

// Defense-in-depth cap for the full Safety Prompt document. Desktop stores
// these as JSON in a settings file; 64 KB is comfortably above any realistic
// user document (current defaults are <10 KB) and guards against OOM via a
// runaway mobile payload.
const SafetyPromptUpdateRouteSchema = z.object({
  prompt: z.string().max(64_000),
  updatedBy: z.enum(['user', 'system', 'migration']).optional(),
});

const SafetyActivityLogGetRouteSchema = z.object({
  limit: z.number().int().min(1).max(SAFETY_ACTIVITY_LOG_MAX_ENTRIES).optional(),
}).optional();

// F-B-R2-6: Stage B route-level caps on the capability-token channels.
// The shared IPC schemas in `src/shared/ipc/channels/memory.ts` already
// cap these (256 for ids, 2048 for tokens) but the route layer enforces
// them BEFORE the handler runs so mobile/web cannot bypass by POSTing
// directly to the cloud endpoint. Mirrors the Stage 4 pattern used for
// safety-prompt / trusted-tool / settings inputs above.
const MintConflictCapabilityRouteSchema = z.object({
  stagedFileId: z.string().min(1).max(256),
});

const ResolveConflictRouteSchema = z.object({
  id: z.string().min(1).max(256),
  resolution: z.enum(['keep-staged', 'keep-real']),
  capabilityToken: z.string().min(1).max(2048),
  // Stage C (260417_approval_consolidation_closeout): optional UUID
  // client dedup key. Kept optional so older clients keep working; the
  // uuid() cap prevents a malicious payload from stuffing an oversized
  // composite map key on the server side.
  clientDedupKey: z.string().uuid().optional(),
});

// User-question response route validation. Mirrors the request shape in
// `src/core/services/userQuestionResponseHandler.ts` (platform-agnostic
// handler shared between desktop IPC and cloud HTTP) and caps free-text
// fields so a paired client cannot stream unbounded payloads through the
// LLM-continuation path. See:
// docs/plans/260420_user_question_cross_surface_resilience.md Stage 6.
const USER_QUESTION_FREE_TEXT_MAX = 4000;
const USER_QUESTION_MAX_QUESTIONS = 8;
const USER_QUESTION_MAX_OPTIONS = 12;
const USER_QUESTION_OPTION_LABEL_MAX = 200;

const UserQuestionOptionRouteSchema = z.object({
  id: z.string().min(1).max(128),
  label: z.string().min(1).max(USER_QUESTION_OPTION_LABEL_MAX),
  description: z.string().max(1000).optional(),
});

const UserQuestionRouteSchema = z.object({
  id: z.string().min(1).max(128),
  question: z.string().min(1).max(2000),
  header: z.string().max(200).optional(),
  options: z.array(UserQuestionOptionRouteSchema).max(USER_QUESTION_MAX_OPTIONS),
  multiSelect: z.boolean().optional(),
  allowFreeText: z.boolean().optional(),
  // Stage 2 of docs/plans/260518_reduce_approval_clarification_branch_scope.md:
  // optional semantic discriminator. The route accepts the literal but the
  // platform-agnostic handler verifies authoritative purpose against the
  // stored `user_question` event in the accumulator before applying any
  // approval-context fail-closed semantics.
  purpose: z.literal('approval_clarification').optional(),
});

const UserQuestionAnswerRouteSchema = z.object({
  questionId: z.string().min(1).max(128),
  selectedOptionIds: z.array(z.string().min(1).max(128)).max(USER_QUESTION_MAX_OPTIONS),
  freeText: z.string().max(USER_QUESTION_FREE_TEXT_MAX).optional(),
});

const UserQuestionQueuedBatchRouteSchema = z.object({
  batchId: z.string().min(1).max(256),
  answers: z.array(UserQuestionAnswerRouteSchema).max(USER_QUESTION_MAX_QUESTIONS),
  skipped: z.boolean().optional(),
  questions: z.array(UserQuestionRouteSchema).max(USER_QUESTION_MAX_QUESTIONS),
});

const UserQuestionResponseRouteSchema = z.object({
  batchId: z.string().min(1).max(256),
  answers: z.array(UserQuestionAnswerRouteSchema).max(USER_QUESTION_MAX_QUESTIONS),
  skipped: z.boolean().optional(),
  sessionId: z.string().min(1).max(256),
  turnId: z.string().min(1).max(256),
  toolUseId: z.string().min(1).max(256),
  questions: z.array(UserQuestionRouteSchema).max(USER_QUESTION_MAX_QUESTIONS),
  queuedBatches: z.array(UserQuestionQueuedBatchRouteSchema).max(8).optional(),
});

/** Maps channels to their Zod route-level schemas (applied to args[0]). */
const ROUTE_SCHEMAS: Record<string, z.ZodTypeAny> = {
  'safety-prompt:generate-options': BlockedActionContextRouteSchema,
  'safety-prompt:generate-deny-options': BlockedActionContextRouteSchema,
  'safety-prompt:apply-selection': PrincipleApplyRouteSchema,
  'safety-prompt:apply-deny-selection': PrincipleApplyRouteSchema,
  'safety-prompt:update': SafetyPromptUpdateRouteSchema,
  'safety-activity-log:get': SafetyActivityLogGetRouteSchema,
  'settings:set-space-safety-level': SetSpaceSafetyLevelRouteSchema,
  'settings:add-trusted-tool': AddTrustedToolRouteSchema,
  // Stage B capability-token endpoints (F-B-R2-6).
  'memory:staging-mint-conflict-capability': MintConflictCapabilityRouteSchema,
  'memory:staging-resolve-conflict': ResolveConflictRouteSchema,
  // Stage 6 hardening (docs/plans/260420_user_question_cross_surface_resilience.md):
  // user-question response is cloud-routable; reject malformed payloads at the
  // route so the platform-agnostic handler only ever sees validated data.
  'agent:user-question-response': UserQuestionResponseRouteSchema,
};

function isAgentSessionLike(value: unknown): value is AgentSession {
  return typeof value === 'object'
    && value !== null
    && 'id' in value
    && typeof (value as { id?: unknown }).id === 'string'
    && 'eventsByTurn' in value;
}

async function prepareSessionForPersist(session: AgentSession, deps: CloudServiceDeps): Promise<AgentSession> {
  const existing = await deps.getSession(session.id);
  const mergedForOrdering: AgentSession = existing
    ? {
        ...existing,
        ...session,
        // Never trust client-provided cloudUpdatedAt.
        cloudUpdatedAt: existing.cloudUpdatedAt,
      }
    : session;

  const seqStamped = stampMissingEventSeq(mergedForOrdering);
  const seqIndex = getSessionSeqIndex();
  const maxSeq = getMaxSeqFromSession(seqStamped);
  seqIndex.setSeqFromStorage(seqStamped.id, maxSeq);
  const withMaxSeq = maxSeq > 0 ? { ...seqStamped, maxSeq } : seqStamped;
  return stampCloudUpdatedAt(withMaxSeq);
}

export async function handleGenericIpc(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  segments: string[],
  deps: CloudServiceDeps,
): Promise<void> {
  if (req.method !== 'POST') return sendRouteError(res, undefined, new RouteError('METHOD_NOT_ALLOWED', { status: 405, message: 'Only POST' }));

  const channel = decodeURIComponent(segments[2]);

  // Server-side allowlist check
  if (!CLOUD_IPC_ALLOWLIST.has(channel)) {
    return sendRouteError(res, undefined, new RouteError('CHANNEL_NOT_ALLOWED', { status: 403, message: `Channel "${channel}" is not available in cloud mode` }));
  }

  const body = await readBody(req) as { params?: unknown[] } | null;
  const args = body?.params ?? [];

  // Look up handler in the platform's handler registry
  const { getHandlerRegistry } = await import('@core/handlerRegistry');
  const registry = getHandlerRegistry();
  const handler = registry.get(channel);

  if (!handler) {
    return sendRouteError(res, undefined, new RouteError('HANDLER_NOT_FOUND', { status: 404, message: `No handler registered for channel "${channel}"` }));
  }

  // Route-level Zod validation for channels with complex payloads (F-R2-2).
  // F-R3-1: Always validate when a schema exists — empty/missing params must fail
  // cleanly with 400 VALIDATION_ERROR instead of falling through to the handler.
  const routeSchema = ROUTE_SCHEMAS[channel];
  if (routeSchema) {
    if (args.length === 0) {
      const parsed = routeSchema.safeParse(undefined);
      if (parsed.success) {
        args[0] = parsed.data;
      } else {
        log({ level: 'warn', msg: 'Route-level validation failed: expected exactly 1 param', channel, argsLength: args.length });
        return sendRouteError(res, undefined, new RouteError('VALIDATION_ERROR', { status: 400, message: `Channel "${channel}" requires exactly one payload object (got ${args.length})` }));
      }
    }
    if (args.length !== 1) {
      log({ level: 'warn', msg: 'Route-level validation failed: expected exactly 1 param', channel, argsLength: args.length });
      return sendRouteError(res, undefined, new RouteError('VALIDATION_ERROR', { status: 400, message: `Channel "${channel}" requires exactly one payload object (got ${args.length})` }));
    }
    const parsed = routeSchema.safeParse(args[0]);
    if (!parsed.success) {
      log({ level: 'warn', msg: 'Route-level validation failed', channel, errors: parsed.error.issues });
      return sendRouteError(res, undefined, new RouteError('VALIDATION_ERROR', { status: 400, message: `Invalid payload for ${channel}: ${parsed.error.message}` }));
    }
    // Replace args[0] with the parsed (and potentially coerced/stripped) value.
    args[0] = parsed.data;
  }

  // Observability-only AgentSession validation at the cloud IPC boundary.
  // Closes the cross-surface parity gap from the 260523 sweep — desktop
  // Stage 7 (sessions:save / sessions:upsert in src/main/ipc/sessionsHandlers.ts)
  // already runs observingSafeParse against AgentSessionSchema; the cloud
  // entry-point validated payloads with the weaker isAgentSessionLike()
  // duck check only. Adding observingSafeParse here surfaces schema drift
  // from mobile/web clients in the same structured-log channel as desktop,
  // without changing user-visible behavior (mode: 'observe' default).
  //
  // Flipping to enforce mode is a Phase 3 STOP trigger on this surface
  // because mobile/web clients sending historically-accepted payloads
  // would suddenly see 400s; deferred until observe-mode evidence shows
  // every caller is schema-conforming.
  if (channel === 'sessions:upsert' && args.length === 1) {
    observingSafeParse({
      schema: AgentSessionSchema,
      payload: args[0],
      channel,
      log: observingSafeParseLogger,
    });
  } else if ((channel === 'sessions:save' || channel === 'sessions:save-sync') && args.length === 1) {
    observingSafeParse({
      schema: z.array(AgentSessionSchema),
      payload: args[0],
      channel,
      log: observingSafeParseLogger,
    });
  }

  if (channel === 'sessions:upsert' && args.length === 1 && isAgentSessionLike(args[0])) {
    args[0] = await prepareSessionForPersist(args[0], deps);
  } else if ((channel === 'sessions:save' || channel === 'sessions:save-sync') && args.length === 1 && Array.isArray(args[0])) {
    const preparedSessions: AgentSession[] = [];
    for (const candidate of args[0]) {
      if (!isAgentSessionLike(candidate)) {
        return sendRouteError(res, undefined, new RouteError('VALIDATION_ERROR', { status: 400, message: `Invalid session payload for ${channel}` }));
      }
      preparedSessions.push(await prepareSessionForPersist(candidate, deps));
    }
    args[0] = preparedSessions;
  }

  try {
    const result = await handler(null, ...args);
    if (channel === 'sessions:delete'
      && typeof result === 'object'
      && result !== null
      && 'success' in result
      && (result as { success?: unknown }).success === true
      && typeof args[0] === 'object'
      && args[0] !== null
      && 'id' in args[0]
      && typeof (args[0] as { id?: unknown }).id === 'string') {
      const sessionId = (args[0] as { id: string }).id;
      getSessionSeqIndex().deleteSession(sessionId);
      clearServerClockSession(sessionId);
    }
    return sendJson(res, 200, result, req);
  } catch (err) {
    log({ level: 'error', msg: 'IPC handler error', channel, error: (err as Error).message });
    return sendRouteError(res, undefined, new RouteError('HANDLER_ERROR', { status: 500, message: (err as Error).message }));
  }
}
