import { z } from 'zod';
import { defineInvokeChannel } from '../schemas';

/**
 * HTML Preview Trust IPC Channels
 *
 * Per-file trust gate for the rebel-html:// document viewer. The renderer
 * reads/writes trust state via these channels; the rebel-html protocol
 * handler reads it directly via getHtmlPreviewTrustService() to pick CSP.
 *
 * @see src/core/services/htmlPreviewTrustService.ts
 * @see docs/plans/260525_html_preview_trust_tiers.md
 */

const WorkspacePathRequest = z.object({
  workspacePath: z.string().min(1),
});

export const htmlPreviewTrustChannels = {
  'htmlPreviewTrust:isTrusted': defineInvokeChannel({
    channel: 'htmlPreviewTrust:isTrusted',
    request: WorkspacePathRequest,
    response: z.object({
      trusted: z.boolean(),
    }),
    description: 'Return whether the given workspace-relative HTML file is currently trusted (path present and content hash matches).',
  }),
  'htmlPreviewTrust:trust': defineInvokeChannel({
    channel: 'htmlPreviewTrust:trust',
    request: WorkspacePathRequest,
    response: z.object({
      success: z.boolean(),
      error: z.string().optional(),
    }),
    description: 'Mark the given workspace-relative HTML file as trusted, pinning the current file content hash.',
  }),
  'htmlPreviewTrust:reset': defineInvokeChannel({
    channel: 'htmlPreviewTrust:reset',
    request: WorkspacePathRequest,
    response: z.object({
      success: z.boolean(),
    }),
    description: 'Remove trust for the given workspace-relative HTML file. Reverts the next preview to strict CSP.',
  }),
} as const;
