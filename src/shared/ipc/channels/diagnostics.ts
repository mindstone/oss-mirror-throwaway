import { z } from 'zod';
import { defineInvokeChannel } from '../schemas';
import { RecentDiagnosticContextSchema } from '@shared/diagnostics/recentDiagnosticContext';
import { ProviderReachabilitySnapshotSchema } from '@shared/diagnostics/providerReachabilitySnapshot';

/**
 * Diagnostics IPC Channels
 *
 * Read-side surfaces for the in-app Diagnostics UI (Wave 4.2). The channel is
 * routable (`{ routable: true, transport: 'ipc' }`) so desktop reads its local
 * ledger and mobile reads the cloud ledger — symmetric to how
 * `agent:tool-safety-response` works but without dual-write, because the read
 * needs to honor wherever the user is running.
 *
 * Backed by `getRecentDiagnosticContext` in
 * `src/core/services/diagnostics/recentDiagnosticContext.ts`. Helper-never-throws
 * semantics: errors return an empty shape with `readerAvailable: false`.
 */
export const DiagnosticsRecentContextRequestSchema = z
  .object({
    limit: z.number().int().min(1).max(20).optional(),
    windowHours: z.number().int().min(1).max(168).optional(),
  })
  .default({});

export const diagnosticsChannels = {
  'diagnostics:get-recent-context': defineInvokeChannel({
    channel: 'diagnostics:get-recent-context',
    request: DiagnosticsRecentContextRequestSchema,
    response: RecentDiagnosticContextSchema,
    description:
      'Read recent diagnostic events for the in-app Diagnostics surface. Routable: desktop reads desktop ledger, cloud reads cloud ledger. Helper-never-throws.',
  }),
  'diagnostics:get-provider-reachability-snapshot': defineInvokeChannel({
    channel: 'diagnostics:get-provider-reachability-snapshot',
    request: z.void(),
    response: ProviderReachabilitySnapshotSchema,
    description:
      'Read cached provider reachability without network I/O for the desktop Diagnostics surface.',
  }),
  'diagnostics:refresh-provider-reachability-cache': defineInvokeChannel({
    channel: 'diagnostics:refresh-provider-reachability-cache',
    request: z.void(),
    response: ProviderReachabilitySnapshotSchema,
    description:
      'Explicitly refresh provider reachability cache from a user-triggered desktop Diagnostics action.',
  }),
} as const;
