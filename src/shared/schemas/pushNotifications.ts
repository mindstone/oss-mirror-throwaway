/**
 * Push Notification Payload — Cloud → Mobile contract (v1)
 *
 * Canonical Zod schema + builder helpers for the `data` payload attached to
 * every Expo Push notification sent by `cloud-service` and decoded by the
 * mobile app. This is the single source of truth for the cross-surface
 * notification payload shape.
 *
 * Background (see `docs/plans/finished/260502_typed_push_notification_payload.md`):
 * before this module existed, `pushNotificationService.sendPushNotification`
 * accepted `data: { type: string; sessionId?: string; [key: string]: unknown }`
 * and 8 sender call sites constructed payloads ad-hoc. The mobile decoder
 * (`mobile/src/utils/pushNotifications.ts`) only handled `type: 'conversation'`
 * and `type: 'approval'` — it silently dropped `'coaching'` and
 * `'meeting-analysis-complete'` payloads on tap. This module:
 *
 *   1. Forces the cloud sender to construct payloads via type-checked
 *      builders, eliminating the silent-drift class of bug.
 *   2. Validates payloads at the `sendPushNotification` boundary.
 *   3. Lets the mobile decoder `safeParse` and exhaustively switch on
 *      `data.type`, with structured `log.warn` (not silent drop) on
 *      validation failure.
 *
 * Discrimination is on `type` (4 distinct values). `kind` is a metadata
 * sub-enum within `'conversation'` and `'approval'` — used for analytics
 * and in-memory dedup keying, but not for routing today. Future kinds
 * that need kind-specific decoder routing must be added with a deliberate
 * mobile decoder update.
 *
 * Wire-format constraint: the payload must remain a flat object of
 * primitives. Android FCM stringifies values; nested objects would round-
 * trip lossily. iOS APNS preserves objects but enforces a 4 KB total
 * payload cap (FCM is also 4 KB). Today's payloads are well under both.
 *
 * @see docs/plans/finished/260502_typed_push_notification_payload.md
 * @see docs/plans/260502_codebase_centralization_audit.md (Item #4)
 * @see cloud-service/src/services/pushNotificationService.ts
 * @see mobile/src/utils/pushNotifications.ts
 */

import { z } from 'zod';

// ─── Primitive constraints ────────────────────────────────────────────

/** Non-empty session id. Mirrors `AgentSession.id` constraints. */
const SessionIdSchema = z.string().min(1);

// ─── Kind enums (exported for builder arg types and tests) ────────────

/**
 * Kinds of `'conversation'` push. Used for in-memory dedup keying and
 * analytics; not for routing decisions on the mobile side today.
 */
export const CONVERSATION_PUSH_KINDS = [
  'question',
  'turn-complete',
  'turn-error',
] as const;
export type ConversationPushKind = (typeof CONVERSATION_PUSH_KINDS)[number];

/**
 * Kinds of `'approval'` push. Used for in-memory dedup keying and
 * analytics; not for routing decisions on the mobile side today.
 */
export const APPROVAL_PUSH_KINDS = [
  'tool-approval',
  'memory-approval',
  'staged-file',
] as const;
export type ApprovalPushKind = (typeof APPROVAL_PUSH_KINDS)[number];

// ─── Variant schemas ──────────────────────────────────────────────────
// `z.object()` strips unknown keys by default; this is deliberate so the
// schema tolerates Expo / APNS / FCM transport metadata (e.g., an `_aps`
// shim key on iOS) without rejecting valid payloads. See the
// `unknown-key stripping` test in `__tests__/pushNotifications.test.ts`.

const ConversationPushSchema = z.object({
  type: z.literal('conversation'),
  kind: z.enum(CONVERSATION_PUSH_KINDS),
  sessionId: SessionIdSchema,
});

const ApprovalPushSchema = z.object({
  type: z.literal('approval'),
  kind: z.enum(APPROVAL_PUSH_KINDS),
  sessionId: SessionIdSchema.optional(),
});

const CoachingPushSchema = z.object({
  type: z.literal('coaching'),
  kind: z.literal('coaching-card'),
  sessionId: SessionIdSchema.optional(),
});

const MeetingAnalysisCompletePushSchema = z.object({
  type: z.literal('meeting-analysis-complete'),
  sessionId: SessionIdSchema,
  meetingTitle: z.string(),
});

/**
 * Discriminated union over `type`. Use `safeParse` on the mobile decoder
 * (incoming wire payload may be from a stale or future cloud build);
 * use `.parse` on the sender boundary (programming-error if it fails).
 */
export const PushNotificationDataSchema = z.discriminatedUnion('type', [
  ConversationPushSchema,
  ApprovalPushSchema,
  CoachingPushSchema,
  MeetingAnalysisCompletePushSchema,
]);

export type PushNotificationData = z.infer<typeof PushNotificationDataSchema>;

// ─── Builders ─────────────────────────────────────────────────────────
//
// Builders are plain typed-object constructors. They DO NOT call
// `.parse()` — the schema is enforced at the `sendPushNotification`
// boundary. This matters because cloud-service's WS-event broadcaster
// reads payload fields via `as string | undefined` casts, where an empty
// string slips through; if a builder threw synchronously, the existing
// fire-and-forget `.catch(() => {})` would not have attached yet.
//
// Builders normalise empty/whitespace `sessionId` strings to `undefined`
// for the optional variants so callers don't have to.

function normaliseOptionalSessionId(sessionId: string | undefined): string | undefined {
  if (sessionId === undefined) return undefined;
  const trimmed = sessionId.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function buildConversationPush(args: {
  kind: ConversationPushKind;
  sessionId: string;
}): PushNotificationData {
  return {
    type: 'conversation',
    kind: args.kind,
    sessionId: args.sessionId,
  };
}

export function buildApprovalPush(args: {
  kind: ApprovalPushKind;
  sessionId?: string;
}): PushNotificationData {
  return {
    type: 'approval',
    kind: args.kind,
    sessionId: normaliseOptionalSessionId(args.sessionId),
  };
}

export function buildCoachingPush(args: {
  sessionId?: string;
}): PushNotificationData {
  return {
    type: 'coaching',
    kind: 'coaching-card',
    sessionId: normaliseOptionalSessionId(args.sessionId),
  };
}

export function buildMeetingAnalysisCompletePush(args: {
  sessionId: string;
  meetingTitle: string;
}): PushNotificationData {
  return {
    type: 'meeting-analysis-complete',
    sessionId: args.sessionId,
    meetingTitle: args.meetingTitle,
  };
}

// ─── Dedup-key derivation (used by `sendPushNotification`) ────────────

/**
 * Returns the dedup-key kind segment for a payload. `meeting-analysis-complete`
 * has no `kind` — it falls back to `'default'`, preserving today's dedup
 * behaviour exactly.
 *
 * @internal Used by `cloud-service/src/services/pushNotificationService.ts`.
 */
export function getPushDedupKind(data: PushNotificationData): string {
  switch (data.type) {
    case 'conversation':
    case 'approval':
    case 'coaching':
      return data.kind;
    case 'meeting-analysis-complete':
      return 'default';
  }
}

/**
 * Compose the in-memory dedup key used by the push notification service.
 * Matches the legacy format `${type}:${kind ?? 'default'}:${sessionId ?? 'none'}`
 * verbatim so this refactor is bit-identical at the dedup-key level.
 *
 * @internal Used by `cloud-service/src/services/pushNotificationService.ts`.
 */
export function buildPushDedupKey(data: PushNotificationData): string {
  return `${data.type}:${getPushDedupKind(data)}:${data.sessionId ?? 'none'}`;
}
