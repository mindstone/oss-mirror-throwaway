import { z } from 'zod';
import { defineInvokeChannel } from '../schemas';

export const MemoryFileInfoSchema = z.object({
  path: z.string(),
  relativePath: z.string(),
  name: z.string(),
  updatedAt: z.number(),
});

export const scratchpadChannels = {
  'scratchpad:load': defineInvokeChannel({
    channel: 'scratchpad:load',
    request: z.object({}),
    response: z.object({
      content: z.string(),
      exists: z.boolean(),
      lastModified: z.number().nullable(),
    }),
    description: 'Load scratchpad content (returns empty if file does not exist)',
  }),

  'scratchpad:save': defineInvokeChannel({
    channel: 'scratchpad:save',
    request: z.object({
      content: z.string(),
    }),
    response: z.object({
      success: z.boolean(),
    }),
    description: 'Save scratchpad content (creates file and folders if needed)',
  }),

  'scratchpad:list-recent-memory-files': defineInvokeChannel({
    channel: 'scratchpad:list-recent-memory-files',
    request: z.object({
      limit: z.number().optional().default(5),
    }),
    response: z.array(MemoryFileInfoSchema),
    description: 'List recently modified files in Chief-of-Staff/memory/',
  }),

  'scratchpad:suggest-location': defineInvokeChannel({
    channel: 'scratchpad:suggest-location',
    request: z.object({
      content: z.string(),
    }),
    response: z.object({
      suggestedFolder: z.string(),
      suggestedFilename: z.string(),
      reasoning: z.string(),
    }),
    description: 'Use LLM to suggest where to save a note',
  }),
} as const;
