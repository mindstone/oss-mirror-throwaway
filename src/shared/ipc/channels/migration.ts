import { z } from 'zod';
import { defineInvokeChannel } from '../schemas';

const MigrationReAuthChecklistSchema = z.object({
  providerKeys: z.array(z.string()),
  connectors: z.array(z.string()),
  cloudRepairRequired: z.boolean(),
});

const MigrationSensitiveCountsSchema = z.object({
  copiedFiles: z.number().int().nonnegative(),
  copiedBytes: z.number().int().nonnegative(),
  copiedSessionFiles: z.number().int().nonnegative(),
  copiedSpaceFiles: z.number().int().nonnegative(),
  pointerOnlySpaces: z.number().int().nonnegative(),
});

const MigrationImportSummarySchema = z.object({
  sourceAppVersion: z.string(),
  sourceDataSchemaEpoch: z.number().int().nonnegative(),
  createdAt: z.string(),
  importId: z.string(),
  reAuthChecklist: MigrationReAuthChecklistSchema,
});

const MigrationErrorKindSchema = z.enum([
  'cancelled',
  'incompatible',
  'corrupt',
  'not-fresh',
  'storage',
  'permission',
  'file-in-use',
  'unknown',
]);

const MigrationErrorSchema = z.object({
  kind: MigrationErrorKindSchema,
  code: z.string().optional(),
  message: z.string(),
  retryable: z.boolean().optional(),
});

const MigrationImportNoticeSchema = z.object({
  importId: z.string(),
  adoptedAt: z.string(),
  reAuthChecklist: MigrationReAuthChecklistSchema,
});

export const migrationChannels = {
  'migration:export': defineInvokeChannel({
    channel: 'migration:export',
    request: z.object({
      defaultFileName: z.string().optional(),
    }).optional(),
    response: z.discriminatedUnion('status', [
      z.object({ status: z.literal('cancelled') }),
      z.object({
        status: z.literal('success'),
        filePath: z.string(),
        containsSensitiveHistory: z.literal(true),
        sensitiveCounts: MigrationSensitiveCountsSchema,
        removedSecretFields: z.array(z.string()),
        reAuthChecklist: MigrationReAuthChecklistSchema,
      }),
      z.object({
        status: z.literal('error'),
        error: MigrationErrorSchema,
      }),
    ]),
    description: 'Create a portable Rebel transfer file via a native save dialog',
  }),

  'migration:validate-import': defineInvokeChannel({
    channel: 'migration:validate-import',
    request: z.void(),
    response: z.discriminatedUnion('status', [
      z.object({ status: z.literal('cancelled') }),
      z.object({
        status: z.literal('valid'),
        transferFilePath: z.string(),
        extractedBundleDir: z.string(),
        summary: MigrationImportSummarySchema,
      }),
      z.object({
        status: z.literal('incompatible'),
        error: MigrationErrorSchema,
      }),
      z.object({
        status: z.literal('corrupt'),
        error: MigrationErrorSchema,
      }),
      z.object({
        status: z.literal('not-fresh'),
        error: MigrationErrorSchema,
      }),
      z.object({
        status: z.literal('error'),
        error: MigrationErrorSchema,
      }),
    ]),
    description: 'Choose and validate a Rebel transfer file for onboarding import',
  }),

  'migration:prepare-import': defineInvokeChannel({
    channel: 'migration:prepare-import',
    request: z.object({
      extractedBundleDir: z.string(),
    }),
    response: z.discriminatedUnion('status', [
      z.object({
        status: z.literal('ready-to-relaunch'),
        importId: z.string(),
        shouldRelaunch: z.literal(true),
        summary: MigrationImportSummarySchema,
      }),
      z.object({
        status: z.literal('incompatible'),
        error: MigrationErrorSchema,
      }),
      z.object({
        status: z.literal('corrupt'),
        error: MigrationErrorSchema,
      }),
      z.object({
        status: z.literal('not-fresh'),
        error: MigrationErrorSchema,
      }),
      z.object({
        status: z.literal('error'),
        error: MigrationErrorSchema,
      }),
    ]),
    description: 'Stage a validated Rebel transfer file and write the restart adoption flag',
  }),

  'migration:discard-extracted': defineInvokeChannel({
    channel: 'migration:discard-extracted',
    request: z.object({
      extractedBundleDir: z.string(),
    }),
    response: z.object({
      discarded: z.boolean(),
    }),
    description: 'Discard a temporary extracted Rebel transfer file directory',
  }),

  'migration:consume-import-notice': defineInvokeChannel({
    channel: 'migration:consume-import-notice',
    request: z.void(),
    response: z.object({
      notice: MigrationImportNoticeSchema.nullable(),
    }),
    description: 'Consume the one-shot successful migration import startup notice',
  }),

  'migration:relaunch': defineInvokeChannel({
    channel: 'migration:relaunch',
    request: z.void(),
    response: z.void(),
    description: 'Relaunch Rebel after a migration import has been prepared',
  }),
} as const;

export type MigrationExportResponse = z.infer<typeof migrationChannels['migration:export']['response']>;
export type MigrationValidateImportResponse = z.infer<typeof migrationChannels['migration:validate-import']['response']>;
export type MigrationPrepareImportResponse = z.infer<typeof migrationChannels['migration:prepare-import']['response']>;
export type MigrationReAuthChecklist = z.infer<typeof MigrationReAuthChecklistSchema>;
export type MigrationImportNotice = z.infer<typeof MigrationImportNoticeSchema>;
