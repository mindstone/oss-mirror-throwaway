import { z } from 'zod';
import { defineInvokeChannel } from '../schemas';

/**
 * Use Case Library IPC Channels
 *
 * Provides access to the self-curating use case library.
 *
 * @see src/main/services/useCaseLibraryStore.ts
 * @see docs/plans/finished/251231_use_case_library_self_curating.md
 */

/** Schema for a use case record */
export const UseCaseRecordSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  prompt: z.string(),
  icon: z.string(),
  qualityRating: z.number(),
  generatedAt: z.number(),
  isNew: z.boolean(),
  newUntil: z.number(),
  usageCount: z.number(),
  lastUsedAt: z.number().nullable(),
  firstUsedAt: z.number(),
  dismissedFromCoach: z.boolean(),
});

export type UseCaseRecordIpc = z.infer<typeof UseCaseRecordSchema>;

/** Schema for grouped use cases */
export const GroupedUseCasesSchema = z.object({
  new: z.array(UseCaseRecordSchema),
  frequent: z.array(UseCaseRecordSchema),
  other: z.array(UseCaseRecordSchema),
});

export type GroupedUseCasesIpc = z.infer<typeof GroupedUseCasesSchema>;

/** Schema for library stats */
export const LibraryStatsSchema = z.object({
  total: z.number(),
  newCount: z.number(),
  usedCount: z.number(),
  avgRating: z.number(),
});

export type LibraryStatsIpc = z.infer<typeof LibraryStatsSchema>;

export const useCaseLibraryChannels = {
  'useCaseLibrary:get-all': defineInvokeChannel({
    channel: 'useCaseLibrary:get-all',
    request: z.object({}),
    response: z.object({
      useCases: z.array(UseCaseRecordSchema),
    }),
    description: 'Get all use cases in the library',
  }),

  'useCaseLibrary:get-for-display': defineInvokeChannel({
    channel: 'useCaseLibrary:get-for-display',
    request: z.object({
      limit: z.number().optional(),
    }),
    response: z.object({
      useCases: z.array(UseCaseRecordSchema),
    }),
    description: 'Get prioritized use cases for display (frequent first, then one new for discovery, then by quality)',
  }),

  'useCaseLibrary:get-grouped': defineInvokeChannel({
    channel: 'useCaseLibrary:get-grouped',
    request: z.object({}),
    response: GroupedUseCasesSchema,
    description: 'Get use cases grouped by category (frequent/your-workflows, new, suggestions)',
  }),

  'useCaseLibrary:record-usage': defineInvokeChannel({
    channel: 'useCaseLibrary:record-usage',
    request: z.object({
      id: z.string(),
    }),
    response: z.object({
      success: z.boolean(),
    }),
    description: 'Record that a use case was used',
  }),

  'useCaseLibrary:mark-seen': defineInvokeChannel({
    channel: 'useCaseLibrary:mark-seen',
    request: z.object({
      id: z.string(),
    }),
    response: z.object({
      success: z.boolean(),
    }),
    description: 'Mark a use case as seen (removes new badge)',
  }),

  'useCaseLibrary:get-stats': defineInvokeChannel({
    channel: 'useCaseLibrary:get-stats',
    request: z.object({}),
    response: LibraryStatsSchema,
    description: 'Get library statistics',
  }),

  'useCaseLibrary:needs-migration': defineInvokeChannel({
    channel: 'useCaseLibrary:needs-migration',
    request: z.object({}),
    response: z.object({
      needsMigration: z.boolean(),
    }),
    description: 'Check if migration from settings is needed',
  }),

  'useCaseLibrary:dismiss': defineInvokeChannel({
    channel: 'useCaseLibrary:dismiss',
    request: z.object({
      id: z.string(),
    }),
    response: z.object({
      success: z.boolean(),
    }),
    description: 'Dismiss a use case from the Coach carousel so it never appears again',
  }),
} as const;
