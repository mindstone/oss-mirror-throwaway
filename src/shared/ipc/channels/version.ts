import { z } from 'zod';
import { defineInvokeChannel } from '../schemas';

/**
 * Version Check Response Schema
 * Matches VersionCheckResult from versionCheckService.ts
 */
export const VersionCheckResultSchema = z.object({
  isOutdated: z.boolean(),
  currentVersion: z.string(),
  latestVersion: z.string().nullable(),
  downloadUrl: z.string().nullable(),
});

export const ReadOnlyStatusSchema = z.object({
  readOnly: z.boolean(),
  reason: z.string().nullable(),
  newerAppVersion: z.string().nullable(),
});

export const versionChannels = {
  'version:check': defineInvokeChannel({
    channel: 'version:check',
    request: z.void(),
    response: VersionCheckResultSchema,
    description: 'Check if current app version is outdated (2+ minor versions behind)',
  }),

  'version:clear-cache': defineInvokeChannel({
    channel: 'version:clear-cache',
    request: z.void(),
    response: z.object({
      success: z.boolean(),
    }),
    description: 'Clear version check cache (for testing)',
  }),

  'version:read-only-status': defineInvokeChannel({
    channel: 'version:read-only-status',
    request: z.void(),
    response: ReadOnlyStatusSchema,
    description: 'Check if app is in read-only mode due to newer version having written userData',
  }),
} as const;
