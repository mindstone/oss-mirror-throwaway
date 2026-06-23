import { z } from 'zod';

/**
 * Pending action queue for atomically-co-written, durable side effects.
 *
 * The reporter no longer fires every Slack/Linear/Sentry call inline at
 * harvest time. Instead, `planActions()` (added in Stage C) returns a
 * `PendingAction[]` that gets written into the `pending_actions` JSON column
 * atomically with the terminal state change (`markCompleted` /
 * `markFailed` / `markParseFailure` / `markVerificationFailure`). A drainer
 * (Stage C) probes external state for "already done", executes pending
 * actions in `ACTION_DRAIN_ORDER`, and removes them on confirmed success.
 *
 * Stage B ships the schema + state-level utilities (`removePendingAction`,
 * `recordPendingAttempt`); Stage C ships `pending-drainer.ts` and the
 * reporter `planActions` split.
 */

export const PendingActionKind = z.enum([
  'sentry_status',
  'sentry_comment',
  'slack_outcome',
  'slack_user_alert',
  'slack_draft_response',
  'linear_create_issue',
  'linear_comment_existing',
  'pr_open',
  'pr_merge',
]);
export type PendingActionKind = z.infer<typeof PendingActionKind>;

const SentryStatusPayload = z.object({
  status: z.enum(['resolved', 'ignored']),
  status_details: z.record(z.unknown()).optional(),
  // Sentry's update route infers substatus from a top-level `substatus`
  // field; the response-side `statusDetails.ignoreUntilEscalating` flag is
  // NOT a request-side input. Issues sent without `substatus` end up as
  // `archived_forever` regardless of `statusDetails` contents and never
  // re-surface on volume escalation.
  substatus: z.enum(['archived_until_escalating', 'archived_forever']).optional(),
});

const SentryCommentPayload = z.object({
  text: z.string().min(1).max(8000),
});

const SlackPayload = z.object({
  text: z.string().min(1),
  log_discriminator: z.string().optional(),
});

const LinearCreatePayload = z.object({
  title: z.string().min(1),
  description: z.string().min(1),
  priority: z.number().int().min(0).max(4),
});

const LinearCommentPayload = z.object({
  identifier_hint: z.string().optional(),
  body: z.string().min(1),
});

const PrOpenPayload = z.object({
  branch_name: z.string().regex(/^autopilot\/[A-Za-z0-9._-]+$/),
  base: z.literal('dev'),
  title: z.string().min(1).max(256),
  body: z.string().min(1).max(65000),
});

// Auto-merge payload. The PR URL is resolved at drain time from the
// issue row's `pr_url` (written by `pr_open`), so plan-time only carries
// the branch + merge method. `branch_name` is included for idempotency-key
// stability and logging — it never changes between pr_open and pr_merge.
const PrMergePayload = z.object({
  branch_name: z.string().regex(/^autopilot\/[A-Za-z0-9._-]+$/),
  merge_method: z.literal('squash'),
});

const baseFields = {
  idempotency_key: z.string().min(1),
  attempts: z.number().int().min(0).default(0),
  last_error: z.string().nullable().default(null),
  created_at: z.string().min(1),
};

export const PendingAction = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('sentry_status'), payload: SentryStatusPayload, ...baseFields }),
  z.object({ kind: z.literal('sentry_comment'), payload: SentryCommentPayload, ...baseFields }),
  z.object({ kind: z.literal('slack_outcome'), payload: SlackPayload, ...baseFields }),
  z.object({ kind: z.literal('slack_user_alert'), payload: SlackPayload, ...baseFields }),
  z.object({ kind: z.literal('slack_draft_response'), payload: SlackPayload, ...baseFields }),
  z.object({ kind: z.literal('linear_create_issue'), payload: LinearCreatePayload, ...baseFields }),
  z.object({ kind: z.literal('linear_comment_existing'), payload: LinearCommentPayload, ...baseFields }),
  z.object({ kind: z.literal('pr_open'), payload: PrOpenPayload, ...baseFields }),
  z.object({ kind: z.literal('pr_merge'), payload: PrMergePayload, ...baseFields }),
]);

export type PendingAction = z.infer<typeof PendingAction>;

export const PendingActions = z.array(PendingAction).max(20);
export type PendingActions = z.infer<typeof PendingActions>;

export const MAX_ATTEMPTS_PER_ACTION = 5;

export const ACTION_DRAIN_ORDER: readonly PendingActionKind[] = [
  'sentry_status',
  'sentry_comment',
  'pr_open',
  // pr_merge runs immediately after pr_open so the same drain pass that
  // creates the PR also lands it. The probe checks GitHub for "already
  // merged" so re-runs across ticks are idempotent.
  'pr_merge',
  'slack_outcome',
  'slack_user_alert',
  'slack_draft_response',
  'linear_create_issue',
  'linear_comment_existing',
] as const;

export function serializePendingActions(actions: readonly PendingAction[]): string | null {
  if (actions.length === 0) return null;
  return JSON.stringify(PendingActions.parse(actions));
}

export function deserializePendingActions(serialized: string | null | undefined): PendingAction[] {
  if (!serialized) return [];
  const parsed = JSON.parse(serialized) as unknown;
  return PendingActions.parse(parsed);
}
