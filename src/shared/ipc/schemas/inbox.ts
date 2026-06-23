import { z } from 'zod';
import type { InboxItem, InboxHistoryEntry, InboxState, InboxItemStatus } from '@rebel/shared';

/** Inbox reference schema */
export const InboxReferenceSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('workspace'),
    path: z.string(),
    label: z.string().optional(),
  }),
  z.object({
    kind: z.literal('url'),
    url: z.string(),
    label: z.string().optional(),
  }),
  z.object({
    kind: z.literal('email'),
    threadId: z.string().min(1),
    messageId: z.string().min(1).optional(),
    provider: z.enum(['gmail', 'outlook']).optional(),
    label: z.string().optional(),
  }),
  z.object({
    kind: z.literal('linear'),
    issueId: z.string().min(1),
    label: z.string().optional(),
  }),
  z.object({
    kind: z.literal('github'),
    owner: z.string().min(1),
    repo: z.string().min(1),
    issueNumber: z.number().int().positive(),
    label: z.string().optional(),
  }),
  z.object({
    kind: z.literal('asana'),
    taskId: z.string().min(1),
    label: z.string().optional(),
  }),
]);

/** Inbox source schema */
export const InboxSourceSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('text'),
    label: z.string(),
  }),
  z.object({
    kind: z.literal('workspace'),
    path: z.string(),
    label: z.string().optional(),
  }),
  z.object({
    kind: z.literal('automation'),
    automationId: z.string(),
    automationName: z.string(),
    label: z.string().optional(),
  }),
  z.object({
    kind: z.literal('role'),
    roleId: z.string(),
    roleName: z.string(),
    rhythmLabel: z.string().optional(),
    label: z.string().optional(),
  }),
  z.object({
    kind: z.literal('meeting'),
    meetingId: z.string().optional(),
    meetingTitle: z.string().optional(),
    label: z.string().optional(),
  }),
  z.object({
    kind: z.literal('conversation'),
    sessionId: z.string(),
    label: z.string().optional(),
  }),
]);

/** Social platform schema */
export const SocialPlatformSchema = z.enum(['twitter', 'linkedin', 'facebook']);

/** Inbox item category (origin/intent) */
export const InboxItemCategorySchema = z.enum([
  'user-request',
  'automation',
  'meeting-action',
  'follow-up',
  'system',
  'uncategorized',
]);

/** Inbox confidence level */
export const InboxConfidenceSchema = z.enum(['high', 'medium', 'low']);

/** Inbox item lifecycle status */
export const InboxItemStatusSchema = z.enum([
  'active', 'executing', 'completed', 'dismissed',
]) satisfies z.ZodType<InboxItemStatus>;

export const InboxDismissReasonCategorySchema = z.enum([
  'not_useful',
  'not_an_action',
  'wrong_context',
  'already_handled',
  'other',
]);

/** Inbox priority schema (deprecated - use urgent + important) */
export const InboxPrioritySchema = z.enum(['p1', 'p2', 'p3']);

/** Inbox quadrant schema (derived from urgent + important) */
export const InboxQuadrantSchema = z.enum(['do-now', 'schedule', 'delegate', 'consider']);

/** Inbox action schema */
export const InboxActionSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('execute'),
  }),
  z.object({
    type: z.literal('shareToSocial'),
    text: z.string(),
    url: z.string().optional(),
    platforms: z.array(SocialPlatformSchema).optional(),
  }),
]);

// NOTE: `satisfies z.ZodType<T>` catches field type mismatches but won't flag
// NEW optional fields added to the canonical type but missing from the schema.

/** Inbox item schema */
export const InboxItemSchema = z.object({
  id: z.string(),
  title: z.string(),
  text: z.string(),
  source: InboxSourceSchema.nullable().optional(),
  references: z.array(InboxReferenceSchema),
  addedAt: z.number(),
  archived: z.boolean().optional(),
  archivedAt: z.number().optional(),
  actions: z.array(InboxActionSchema).optional(),
  /** @deprecated Use urgent + important instead */
  priority: InboxPrioritySchema.optional(),
  /** Eisenhower: requires immediate attention. Default: false */
  urgent: z.boolean().optional(),
  /** Eisenhower: matters for goals/values. Default: true */
  important: z.boolean().optional(),
  /** Optional clarifying question from Rebel */
  clarifyingQuestion: z.string().optional(),
  /** Pre-drafted deliverable (email, post, document) ready for user approval */
  draft: z.string().optional(),
  /** Session ID of currently executing conversation */
  executingSessionId: z.string().optional(),
  /** Whether the executing session should complete this item when Rebel finishes */
  autoCompleteOnExecution: z.boolean().optional(),
  /** Epoch ms after which this item is no longer actionable */
  relevantDate: z.number().optional(),
  /** Epoch ms by which this item should be completed. Used for temporal grouping. */
  dueBy: z.number().optional(),
  /** Origin/intent category for filtering and analytics */
  category: InboxItemCategorySchema.optional(),
  /** Free-form topic tags for filtering and search */
  tags: z.array(z.string()).optional(),
  /** Rebel's confidence that this item is actionable */
  confidence: InboxConfidenceSchema.optional(),
  /** Override CTA label set by automations/agents at write time */
  actionLabel: z.string().optional(),
  /** Whether this item was auto-completed by Rebel */
  autoCompleted: z.boolean().optional(),
  /** Lifecycle status */
  status: InboxItemStatusSchema.optional(),
  /** Who marked this item completed */
  completedBy: z.enum(['user', 'rebel']).optional(),
  /** Epoch ms when completed */
  completedAt: z.number().optional(),
  /** Epoch ms when dismissed */
  dismissedAt: z.number().optional(),
  /** Optional structured reason the user gave when deleting/dismissing the item */
  dismissedReasonCategory: InboxDismissReasonCategorySchema.optional(),
  /** Optional free-text reason the user gave when deleting/dismissing the item */
  dismissedReason: z.string().optional(),
  /** Epoch ms of last mutation. Used for cloud sync conflict resolution. */
  updatedAt: z.number().optional(),
}) satisfies z.ZodType<InboxItem>;

/** Inbox execution mode */
export const InboxExecutionModeSchema = z.enum(['execute', 'execute_with_context']);

/** Inbox history entry schema */
export const InboxHistoryEntrySchema = InboxItemSchema.extend({
  executedAt: z.number(),
  sessionId: z.string(),
  mode: InboxExecutionModeSchema,
  completionSource: z.enum(['user', 'rebel']).optional(),
}) satisfies z.ZodType<InboxHistoryEntry>;

/** Inbox state schema */
export const InboxStateSchema = z.object({
  version: z.number(),
  items: z.array(InboxItemSchema),
  history: z.array(InboxHistoryEntrySchema),
}) satisfies z.ZodType<InboxState>;
export type { InboxState } from '@rebel/shared';

/** Inbox index entry schema (lightweight metadata only) */
export const InboxIndexEntrySchema = z.object({
  id: z.string(),
  title: z.string(),
  archived: z.boolean(),
  addedAt: z.number(),
  archivedAt: z.number().optional(),
  sourceKind: z.enum(['text', 'workspace', 'automation', 'role', 'meeting', 'conversation']).optional(),
  /** @deprecated Use urgent + important instead */
  priority: InboxPrioritySchema.optional(),
  /** Eisenhower: requires immediate attention */
  urgent: z.boolean().optional(),
  /** Eisenhower: matters for goals/values */
  important: z.boolean().optional(),
  /** Session ID of currently executing conversation */
  executingSessionId: z.string().optional(),
  /** Epoch ms after which this item is no longer actionable */
  relevantDate: z.number().optional(),
  /** Epoch ms by which this item should be completed. Used for temporal grouping. */
  dueBy: z.number().optional(),
  /** Origin/intent category for filtering and analytics */
  category: InboxItemCategorySchema.optional(),
  /** Free-form topic tags for filtering and search */
  tags: z.array(z.string()).optional(),
  /** Rebel's confidence that this item is actionable (derived at read time if absent) */
  confidence: InboxConfidenceSchema.optional(),
  /** Whether this item was auto-completed by Rebel */
  autoCompleted: z.boolean().optional(),
  /** Lifecycle status */
  status: InboxItemStatusSchema.optional(),
  /** Optional structured reason the user gave when deleting/dismissing the item */
  dismissedReasonCategory: InboxDismissReasonCategorySchema.optional(),
  /** Optional free-text reason the user gave when deleting/dismissing the item */
  dismissedReason: z.string().optional(),
  /** Epoch ms of last mutation. Used for cloud sync conflict resolution. */
  updatedAt: z.number().optional(),
});
export type InboxIndexEntry = z.infer<typeof InboxIndexEntrySchema>;

/** Inbox index state schema */
export const InboxIndexStateSchema = z.object({
  version: z.number(),
  entries: z.array(InboxIndexEntrySchema),
  history: z.array(InboxHistoryEntrySchema),
  migrationComplete: z.boolean().optional(),
  retroactiveCleanupComplete: z.boolean().optional(),
  retroactiveCleanupVersion: z.number().optional(),
  lastFreshnessCheck: z.number().optional(),
  /** Tombstones for deleted items — prevents cloud pull from resurrecting them. */
  deletedIds: z.array(z.object({ id: z.string(), deletedAt: z.number() })).optional(),
});
export type InboxIndexStateType = z.infer<typeof InboxIndexStateSchema>;

/** Input for adding an inbox item via IPC */
export const InboxAddInputSchema = z.object({
  id: z.string().uuid().optional(),
  title: z.string(),
  text: z.string().optional(),
  urgent: z.boolean().optional(),
  important: z.boolean().optional(),
  category: InboxItemCategorySchema.optional(),
  tags: z.array(z.string()).optional(),
  dueBy: z.number().optional(),
});
export type InboxAddInput = z.infer<typeof InboxAddInputSchema>;

/** Response from inbox:execute */
export const InboxExecuteResponseSchema = z.object({
  sessionId: z.string(),
  prompt: z.string(),
  success: z.boolean(),
});
export type InboxExecuteResponse = z.infer<typeof InboxExecuteResponseSchema>;

/** @deprecated Use InboxReferenceSchema */
export const TaskReferenceSchema = InboxReferenceSchema;
/** @deprecated Use InboxSourceSchema */
export const TaskSourceSchema = InboxSourceSchema;
/** @deprecated Use InboxItemSchema */
export const TaskQueueItemSchema = InboxItemSchema;
/** @deprecated Use InboxExecutionModeSchema */
export const TaskExecutionModeSchema = InboxExecutionModeSchema;
/** @deprecated Use InboxHistoryEntrySchema */
export const TaskHistoryEntrySchema = InboxHistoryEntrySchema;
/** @deprecated Use InboxStateSchema */
export const TaskQueueStateSchema = InboxStateSchema;
/** @deprecated Use InboxState */
export type TaskQueueState = InboxState;
