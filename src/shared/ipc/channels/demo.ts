import { z } from 'zod';
import { defineInvokeChannel } from '../schemas';

export const demoChannels = {
  'demo:enter': defineInvokeChannel({
    channel: 'demo:enter',
    request: z.object({
      /** If true, copy API keys from current settings to demo settings */
      keepApiKeys: z.boolean().optional(),
      /** If true, seed mock content (skills and memories) for UX testing */
      seedMockContent: z.boolean().optional(),
      /** If true, show onboarding wizard instead of skipping it */
      showOnboarding: z.boolean().optional(),
    }).optional(),
    response: z.object({
      success: z.boolean(),
      tempDirectory: z.string().optional(),
      error: z.string().optional(),
      /** If true, user must manually restart (dev mode - Vite doesn't auto-restart) */
      requiresManualRestart: z.boolean().optional(),
    }),
    description: 'Enter demo mode with temporary workspace',
  }),

  'demo:exit': defineInvokeChannel({
    channel: 'demo:exit',
    request: z.void(),
    response: z.object({
      success: z.boolean(),
      error: z.string().optional(),
    }),
    description: 'Exit demo mode and restore normal settings',
  }),

  'demo:status': defineInvokeChannel({
    channel: 'demo:status',
    request: z.void(),
    response: z.object({
      active: z.boolean(),
      hasActiveTurns: z.boolean(),
    }),
    description: 'Check if demo mode is currently active',
  }),
} as const;
