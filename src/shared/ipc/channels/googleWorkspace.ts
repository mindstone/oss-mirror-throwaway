import { z } from 'zod';
import { defineInvokeChannel, OAuthSetupGuidanceSchema } from '../schemas/common';

const GoogleAccountSchema = z.object({
  email: z.string(),
  category: z.string(),
  description: z.string(),
  status: z.enum(['active', 'expired', 'error']),
});

export const googleWorkspaceChannels = {
  'google-workspace:get-accounts': defineInvokeChannel({
    channel: 'google-workspace:get-accounts',
    request: z.void(),
    response: z.object({
      accounts: z.array(GoogleAccountSchema),
    }),
    description: 'Get all connected Google Workspace accounts with status',
  }),

  'google-workspace:start-auth': defineInvokeChannel({
    channel: 'google-workspace:start-auth',
    // Optional request keeps existing no-arg `startAuth()` callers working.
    // `targetEmail` scopes a RECONNECT to one account: the auth service
    // rejects the callback when the user signs into a different account
    // (Stage 3 [GPT-F2], 260611_calendar-cache-attention).
    request: z.object({
      targetEmail: z.string().optional(),
    }).optional(),
    response: z.object({
      success: z.boolean(),
      email: z.string().optional(),
      error: z.string().optional(),
      setupGuidance: OAuthSetupGuidanceSchema.optional(),
    }),
    description: 'Start OAuth flow to connect a new Google account (optionally scoped to one account for reconnect)',
  }),

  'google-workspace:remove-account': defineInvokeChannel({
    channel: 'google-workspace:remove-account',
    request: z.object({
      email: z.string(),
    }),
    response: z.object({
      success: z.boolean(),
      error: z.string().optional(),
    }),
    description: 'Remove a connected Google account',
  }),

  'google-workspace:cancel-auth': defineInvokeChannel({
    channel: 'google-workspace:cancel-auth',
    request: z.void(),
    response: z.void(),
    description: 'Cancel any pending OAuth flow',
  }),
};
