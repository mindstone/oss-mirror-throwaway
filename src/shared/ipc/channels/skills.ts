import { z } from 'zod';
import { defineInvokeChannel } from '../schemas';

/**
 * Skills IPC Channels
 *
 * Provides skill usage tracking functionality.
 *
 * @see src/main/services/skillUsageStore.ts
 */

export const skillsChannels = {
  'skills:get-usage': defineInvokeChannel({
    channel: 'skills:get-usage',
    request: z.object({}),
    response: z.object({
      skills: z.array(z.object({
        skillName: z.string(),
        usageCount: z.number(),
        lastUsedAt: z.number(),
        lastNudgeShownAt: z.number().optional(),
      })),
    }),
    description: 'Get all skill usage records',
  }),

  'skills:mark-nudged': defineInvokeChannel({
    channel: 'skills:mark-nudged',
    request: z.object({
      skillName: z.string(),
    }),
    response: z.object({
      success: z.boolean(),
    }),
    description: 'Mark a skill as having been nudged for improvement (throttles further nudges)',
  }),
};
