import { z } from 'zod';
import { defineInvokeChannel, InboxStateSchema, InboxExecutionModeSchema, InboxIndexStateSchema, InboxItemSchema, InboxAddInputSchema, InboxExecuteResponseSchema, InboxItemStatusSchema } from '../schemas';

export const inboxChannels = {
  'inbox:load': defineInvokeChannel({
    channel: 'inbox:load',
    request: z.void(),
    response: InboxStateSchema,
    description: 'Load the inbox state',
  }),

  'inbox:load-index': defineInvokeChannel({
    channel: 'inbox:load-index',
    request: z.void(),
    response: InboxIndexStateSchema,
    description: 'Load inbox index (metadata only, fast startup)',
  }),

  'inbox:load-items': defineInvokeChannel({
    channel: 'inbox:load-items',
    request: z.object({
      ids: z.array(z.string().uuid()),
    }),
    response: z.array(InboxItemSchema),
    description: 'Load full item data for specified IDs',
  }),

  'inbox:delete': defineInvokeChannel({
    channel: 'inbox:delete',
    request: z.string(),
    response: InboxStateSchema,
    description: 'Delete an item from the inbox',
  }),

  'inbox:record-execution': defineInvokeChannel({
    channel: 'inbox:record-execution',
    request: z.object({
      itemId: z.string(),
      sessionId: z.string(),
      mode: InboxExecutionModeSchema,
      executedAt: z.number().optional(),
    }),
    response: InboxStateSchema,
    description: 'Record inbox item execution in history',
  }),

  'inbox:mark-archived': defineInvokeChannel({
    channel: 'inbox:mark-archived',
    request: z.string(),
    response: InboxStateSchema,
    description: 'Mark an inbox item as archived',
  }),

  'inbox:set-archived': defineInvokeChannel({
    channel: 'inbox:set-archived',
    request: z.object({
      itemId: z.string(),
      archived: z.boolean(),
    }),
    response: InboxStateSchema,
    description: 'Set inbox item archived state (true = archived, false = active)',
  }),

  'inbox:set-quadrant': defineInvokeChannel({
    channel: 'inbox:set-quadrant',
    request: z.object({
      itemId: z.string(),
      urgent: z.boolean(),
      important: z.boolean(),
    }),
    response: InboxStateSchema,
    description: 'Set inbox item Eisenhower quadrant (urgent + important)',
  }),

  'inbox:set-dueBy': defineInvokeChannel({
    channel: 'inbox:set-dueBy',
    request: z.object({
      itemId: z.string(),
      dueBy: z.number().nullable(),
    }),
    response: InboxStateSchema,
    description: 'Set inbox item dueBy timestamp (nullable)',
  }),

  'inbox:set-executing': defineInvokeChannel({
    channel: 'inbox:set-executing',
    request: z.object({
      itemId: z.string(),
      sessionId: z.string().nullable(),
      autoCompleteOnExecution: z.boolean().optional(),
    }),
    response: InboxStateSchema,
    description: 'Set or clear the executing session ID for an inbox item',
  }),

  'inbox:set-status': defineInvokeChannel({
    channel: 'inbox:set-status',
    request: z.object({
      itemId: z.string(),
      status: InboxItemStatusSchema,
      completedBy: z.enum(['user', 'rebel']).optional(),
      dismissedReasonCategory: z.enum(['not_useful', 'not_an_action', 'wrong_context', 'already_handled', 'other']).optional(),
      dismissedReason: z.string().optional(),
    }),
    response: InboxStateSchema,
    description: 'Set the lifecycle status of an inbox item',
  }),

  'inbox:set-tags': defineInvokeChannel({
    channel: 'inbox:set-tags',
    request: z.object({
      itemId: z.string(),
      tags: z.array(z.string()),
    }),
    response: InboxStateSchema,
    description: 'Set tags on an inbox item',
  }),

  'inbox:add': defineInvokeChannel({
    channel: 'inbox:add',
    request: InboxAddInputSchema,
    response: InboxStateSchema,
    description: 'Add a new item to the inbox',
  }),

  'inbox:execute': defineInvokeChannel({
    channel: 'inbox:execute',
    request: z.object({
      itemId: z.string(),
      sessionId: z.string().uuid().optional(),
      context: z.string().optional(),
    }),
    response: InboxExecuteResponseSchema,
    description: 'Prepare an inbox item for fire-and-forget execution (archives, records, returns sessionId)',
  }),

  'inbox:upsert': defineInvokeChannel({
    channel: 'inbox:upsert',
    request: InboxItemSchema,
    response: InboxStateSchema,
    description: 'Upsert a full inbox item (used for cloud sync push)',
  }),

  'inbox:check-resolution': defineInvokeChannel({
    channel: 'inbox:check-resolution',
    request: z.object({
      maxItems: z.number().int().positive().optional(),
      mode: z.enum(['normal', 'backlog']).optional(),
      dryRun: z.boolean().optional(),
    }).optional(),
    response: z.object({
      checked: z.number(),
      archived: z.number(),
      wouldArchive: z.number().optional(),
      skipped: z.boolean().optional(),
      mode: z.enum(['normal', 'backlog']).optional(),
      candidates: z.number().optional(),
      results: z.array(z.object({
        itemId: z.string(),
        title: z.string(),
        status: z.enum(['resolved', 'active', 'unsupported', 'error']),
        evidence: z.string().optional(),
      })).optional(),
    }),
    description: 'Check referenced evidence for resolved action items. Normal mode is capped/cooldown-protected; backlog mode is dry-run-only and intended for explicit first-run/user-triggered sweep receipts.',
  }),
} as const;

/** @deprecated Use inboxChannels */
export const tasksChannels = inboxChannels;
