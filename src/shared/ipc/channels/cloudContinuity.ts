import { z } from 'zod';
import { defineInvokeChannel } from '../schemas/common';

/**
 * Cloud Continuity IPC Channels
 *
 * Per-session cloud continuity management: get/set state, pin/unpin, list all.
 * All channels are local-only — NOT in CLOUD_CHANNEL_POLICIES.
 * Desktop decides what to replicate; cloud has no say in these.
 *
 * @see src/main/services/cloud/cloudContinuityMetadata.ts
 */

const ContinuityStateSchema = z.enum(['local_only', 'cloud_active']);

export const cloudContinuityChannels = {
  'cloud-continuity:get-state': defineInvokeChannel({
    channel: 'cloud-continuity:get-state',
    request: z.object({ sessionId: z.string() }),
    response: z.object({ state: ContinuityStateSchema }),
    description: 'Get cloud continuity state for a session',
  }),

  'cloud-continuity:set-state': defineInvokeChannel({
    channel: 'cloud-continuity:set-state',
    request: z.object({
      sessionId: z.string(),
      state: ContinuityStateSchema,
    }),
    response: z.object({ success: z.boolean() }),
    description: 'Set cloud continuity state for a session',
  }),

  'cloud-continuity:pin': defineInvokeChannel({
    channel: 'cloud-continuity:pin',
    request: z.object({ sessionId: z.string() }),
    response: z.object({ success: z.boolean() }),
    description: 'Pin a session to cloud (prevents auto-demotion). Auto-promotes local_only to cloud_active.',
  }),

  'cloud-continuity:unpin': defineInvokeChannel({
    channel: 'cloud-continuity:unpin',
    request: z.object({ sessionId: z.string() }),
    response: z.object({ success: z.boolean() }),
    description: 'Unpin a session from cloud (re-subjects to auto-demotion rules)',
  }),

  'cloud-continuity:get-all': defineInvokeChannel({
    channel: 'cloud-continuity:get-all',
    request: z.void(),
    response: z.record(z.string(), z.object({
      state: ContinuityStateSchema,
      lastCloudActivityAt: z.number().optional(),
      cloudPinnedAt: z.number().optional(),
    })),
    description: 'Get all session continuity states (for sidebar badges and CloudTab summary)',
  }),
} as const;
