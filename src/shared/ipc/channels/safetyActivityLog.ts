import { z } from 'zod';
import { defineInvokeChannel } from '../schemas/common';

const EvaluationEntrySchema = z.object({
  id: z.string(),
  timestamp: z.number(),
  type: z.literal('evaluation'),
  executionSurface: z.enum(['desktop', 'cloud']).optional(),
  toolDisplayName: z.string(),
  toolId: z.string(),
  actionSummary: z.string(),
  decision: z.enum(['allowed', 'blocked']),
  reason: z.string(),
  sessionType: z.enum(['interactive', 'automation', 'role']),
  automationName: z.string().optional(),
  source: z.enum(['deterministic', 'safety-prompt', 'user-approved']).optional(),
  flagged: z.boolean(),
});

export const VersionChangeEntrySchema = z.object({
  id: z.string(),
  timestamp: z.number(),
  type: z.literal('version-change'),
  executionSurface: z.enum(['desktop', 'cloud']).optional(),
  fromVersion: z.number(),
  toVersion: z.number(),
  source: z
    .enum(['ui-picker', 'chat-intent', 'settings-editor', 'system', 'migration'])
    .optional(),
});

export const ActivityLogEntrySchema = z.discriminatedUnion('type', [
  EvaluationEntrySchema,
  VersionChangeEntrySchema,
]);

export const SafetyActivityLogCloudSyncStateSchema = z.enum([
  'success',
  'failed',
  'offline',
  'not-configured',
]);

export type SafetyActivityLogCloudSyncState = z.infer<typeof SafetyActivityLogCloudSyncStateSchema>;

export const safetyActivityLogChannels = {
  'safety-activity-log:get': defineInvokeChannel({
    channel: 'safety-activity-log:get',
    request: z.object({ limit: z.number().optional() }).optional(),
    response: z.object({ entries: z.array(ActivityLogEntrySchema) }),
    description: 'Get activity log entries',
  }),

  'safety-activity-log:flag': defineInvokeChannel({
    channel: 'safety-activity-log:flag',
    request: z.object({ entryId: z.string() }),
    response: z.object({ success: z.boolean() }),
    description: 'Flag an allowed action as incorrect',
  }),

  'safety-activity-log:unflag': defineInvokeChannel({
    channel: 'safety-activity-log:unflag',
    request: z.object({ entryId: z.string() }),
    response: z.object({ success: z.boolean() }),
    description: 'Remove flag from an activity log entry',
  }),

  'safety-activity-log:sync-cloud': defineInvokeChannel({
    channel: 'safety-activity-log:sync-cloud',
    request: z.void(),
    response: z.object({ cloudSyncState: SafetyActivityLogCloudSyncStateSchema }),
    description: 'Fetch and merge cloud safety activity log entries into the local log',
  }),
} as const;
