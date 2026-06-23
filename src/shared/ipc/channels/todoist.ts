/**
 * Todoist IPC Channels
 *
 * IPC contract for Todoist integration in the Tasks panel.
 */

import { z } from 'zod';
import { defineInvokeChannel } from '../schemas';

export const TodoistConnectionStatusSchema = z.discriminatedUnion('connected', [
  z.object({
    connected: z.literal(false),
    reason: z.enum(['not_authenticated', 'api_error']),
    error: z.string().optional(),
  }),
  z.object({
    connected: z.literal(true),
    inboxProjectId: z.string(),
  }),
]);

export type TodoistConnectionStatus = z.infer<typeof TodoistConnectionStatusSchema>;

export const TodoistTaskSchema = z.object({
  id: z.string(),
  content: z.string(),
  description: z.string(),
  project_id: z.string(),
  due: z.object({
    date: z.string(),
    string: z.string(),
    datetime: z.string().optional(),
  }).nullable(),
  priority: z.number(),
  is_completed: z.boolean(),
  created_at: z.string(),
  order: z.number(),
});

export type TodoistTask = z.infer<typeof TodoistTaskSchema>;

export const todoistChannels = {
  'todoist:check-connection': defineInvokeChannel({
    channel: 'todoist:check-connection',
    request: z.void(),
    response: TodoistConnectionStatusSchema,
    description: 'Check Todoist connection status',
  }),

  'todoist:get-tasks': defineInvokeChannel({
    channel: 'todoist:get-tasks',
    request: z.void(),
    response: z.array(TodoistTaskSchema),
    description: 'Get all active tasks from Todoist (all projects)',
  }),

  'todoist:create-task': defineInvokeChannel({
    channel: 'todoist:create-task',
    request: z.object({
      content: z.string(),
      due_date: z.string().optional(),
    }),
    response: TodoistTaskSchema,
    description: 'Create a task in Todoist Inbox',
  }),

  'todoist:complete-task': defineInvokeChannel({
    channel: 'todoist:complete-task',
    request: z.object({ taskId: z.string() }),
    response: z.object({ success: z.boolean() }),
    description: 'Complete a Todoist task',
  }),

  'todoist:delete-task': defineInvokeChannel({
    channel: 'todoist:delete-task',
    request: z.object({ taskId: z.string() }),
    response: z.object({ success: z.boolean() }),
    description: 'Delete a Todoist task',
  }),
} as const;

export type TodoistChannelName = keyof typeof todoistChannels;
