import { z } from 'zod';
import { defineInvokeChannel } from '../schemas';

export const permissionsChannels = {
  'permissions:get-microphone-status': defineInvokeChannel({
    channel: 'permissions:get-microphone-status',
    request: z.void(),
    response: z.enum(['granted', 'denied', 'restricted', 'not-determined', 'unknown']),
    description: 'Get the current microphone permission status',
  }),

  'permissions:request-microphone': defineInvokeChannel({
    channel: 'permissions:request-microphone',
    request: z.void(),
    response: z.object({
      granted: z.boolean(),
      error: z.string().optional(),
    }),
    description: 'Request microphone access permission',
  }),

  'permissions:check-file-access': defineInvokeChannel({
    channel: 'permissions:check-file-access',
    request: z.string().optional(),
    response: z.object({
      hasAccess: z.boolean(),
      devMode: z.boolean().optional(),
      reason: z.string().optional(),
      errorCode: z.string().optional(),
      errorMessage: z.string().optional(),
    }),
    description: 'Check if the app has file system access to the workspace',
  }),

  'permissions:open-system-preferences': defineInvokeChannel({
    channel: 'permissions:open-system-preferences',
    request: z.enum(['microphone', 'files', 'screen-recording', 'notifications']),
    response: z.object({
      success: z.boolean(),
      reason: z.string().optional(),
      error: z.string().optional(),
    }),
    description: 'Open system preferences to the relevant permission panel',
  }),
} as const;
