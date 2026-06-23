/**
 * Plaud IPC Channels
 *
 * Channels for Plaud voice recorder integration.
 */

import { z } from 'zod';
import { defineInvokeChannel, OAuthSetupGuidanceSchema } from '../schemas/common';

const PlaudAccountSchema = z.object({
  userId: z.string(),
  email: z.string(),
  nickname: z.string().optional(),
  connectedAt: z.string(),
});

const PlaudConnectionStateSchema = z.object({
  connected: z.boolean(),
  account: PlaudAccountSchema.optional(),
  lastSyncTime: z.string().nullable(),
  syncInProgress: z.boolean(),
  error: z.string().optional(),
});

export const plaudChannels = {
  'plaud:get-connection-state': defineInvokeChannel({
    channel: 'plaud:get-connection-state',
    request: z.void(),
    response: PlaudConnectionStateSchema,
    description: 'Get current Plaud connection state',
  }),

  'plaud:start-auth': defineInvokeChannel({
    channel: 'plaud:start-auth',
    request: z.void(),
    response: z.object({
      success: z.boolean(),
      email: z.string().optional(),
      error: z.string().optional(),
      setupGuidance: OAuthSetupGuidanceSchema.optional(),
    }),
    description: 'Start OAuth flow to connect Plaud account',
  }),

  'plaud:disconnect': defineInvokeChannel({
    channel: 'plaud:disconnect',
    request: z.void(),
    response: z.object({
      success: z.boolean(),
      error: z.string().optional(),
    }),
    description: 'Disconnect Plaud account',
  }),

  'plaud:trigger-sync': defineInvokeChannel({
    channel: 'plaud:trigger-sync',
    request: z.void(),
    response: z.object({
      success: z.boolean(),
      synced: z.number().optional(),
      errors: z.number().optional(),
      error: z.string().optional(),
    }),
    description: 'Trigger manual sync of Plaud recordings',
  }),

  'plaud:cancel-auth': defineInvokeChannel({
    channel: 'plaud:cancel-auth',
    request: z.void(),
    response: z.void(),
    description: 'Cancel pending OAuth flow',
  }),

  'plaud:retranscribe': defineInvokeChannel({
    channel: 'plaud:retranscribe',
    request: z.object({
      filePath: z.string(),
    }),
    response: z.object({
      success: z.boolean(),
      error: z.string().optional(),
    }),
    description: 'Re-transcribe an existing Plaud meeting file',
  }),
};
