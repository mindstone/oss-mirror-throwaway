import { z } from 'zod';
import { defineInvokeChannel } from '../schemas';

export const UserTaskStatusSchema = z.enum(['todo', 'in_progress', 'done', 'cancelled']);

export const UserTaskPrioritySchema = z.enum(['urgent', 'high', 'medium', 'low', 'none']);

export const UserTaskSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string().optional(),
  status: UserTaskStatusSchema,
  dueDate: z.number().nullable().optional(),
  priority: UserTaskPrioritySchema.optional(),
  labels: z.array(z.string()).optional(),
  externalId: z.string().nullable().optional(),
  externalUrl: z.string().nullable().optional(),
  syncSource: z.string().nullable().optional(),
  syncedAt: z.number().nullable().optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
  completedAt: z.number().nullable().optional(),
});

export const UserTasksStateSchema = z.object({
  version: z.number(),
  tasks: z.array(UserTaskSchema),
});

export const UserTaskPatchSchema = z.object({
  title: z.string().optional(),
  description: z.string().optional(),
  status: UserTaskStatusSchema.optional(),
  dueDate: z.number().nullable().optional(),
  priority: UserTaskPrioritySchema.optional(),
  labels: z.array(z.string()).optional(),
});

export const userTasksChannels = {
  'user-tasks:load': defineInvokeChannel({
    channel: 'user-tasks:load',
    request: z.void(),
    response: UserTasksStateSchema,
    description: 'Load all user tasks',
  }),

  'user-tasks:add': defineInvokeChannel({
    channel: 'user-tasks:add',
    request: z.object({
      title: z.string(),
      dueDate: z.number().nullable().optional(),
    }),
    response: UserTasksStateSchema,
    description: 'Add a new user task',
  }),

  'user-tasks:update': defineInvokeChannel({
    channel: 'user-tasks:update',
    request: z.object({
      id: z.string(),
      patch: UserTaskPatchSchema,
    }),
    response: UserTasksStateSchema,
    description: 'Update an existing user task',
  }),

  'user-tasks:delete': defineInvokeChannel({
    channel: 'user-tasks:delete',
    request: z.string(),
    response: UserTasksStateSchema,
    description: 'Delete a user task',
  }),
} as const;
