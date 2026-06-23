import { z } from 'zod';
import { defineInvokeChannel, OAuthSetupGuidanceSchema } from '../schemas';

const SalesforceAccountSchema = z.object({
  username: z.string(),
  instanceUrl: z.string().optional(),
  connectedAt: z.number().optional(),
});

export const salesforceChannels = {
  'salesforce:get-accounts': defineInvokeChannel({
    channel: 'salesforce:get-accounts',
    request: z.void(),
    response: z.object({ accounts: z.array(SalesforceAccountSchema) }),
    description: 'Get all connected Salesforce accounts',
  }),

  'salesforce:start-auth': defineInvokeChannel({
    channel: 'salesforce:start-auth',
    request: z.void(),
    response: z.object({
      success: z.boolean(),
      username: z.string().optional(),
      error: z.string().optional(),
      setupGuidance: OAuthSetupGuidanceSchema.optional(),
    }),
    description: 'Start Salesforce OAuth authentication flow',
  }),

  'salesforce:remove-account': defineInvokeChannel({
    channel: 'salesforce:remove-account',
    request: z.object({ username: z.string() }),
    response: z.object({
      success: z.boolean(),
      error: z.string().optional(),
    }),
    description: 'Remove a connected Salesforce account',
  }),

  'salesforce:cancel-auth': defineInvokeChannel({
    channel: 'salesforce:cancel-auth',
    request: z.void(),
    response: z.void(),
    description: 'Cancel pending Salesforce OAuth authentication',
  }),
} as const;
