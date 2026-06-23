import { z } from 'zod';
import { defineInvokeChannel } from '../schemas/common';

const ZendeskAccountSchema = z.object({
  subdomain: z.string(),
  email: z.string(),
  status: z.enum(['active', 'expired', 'error']),
});

export const zendeskChannels = {
  'zendesk:get-accounts': defineInvokeChannel({
    channel: 'zendesk:get-accounts',
    request: z.void(),
    response: z.object({
      accounts: z.array(ZendeskAccountSchema),
    }),
    description: 'Get all connected Zendesk accounts with status',
  }),

  'zendesk:remove-account': defineInvokeChannel({
    channel: 'zendesk:remove-account',
    request: z.object({
      subdomain: z.string(),
    }),
    response: z.object({
      success: z.boolean(),
      error: z.string().optional(),
    }),
    description: 'Remove a connected Zendesk account',
  }),

  'zendesk:add-api-key-account': defineInvokeChannel({
    channel: 'zendesk:add-api-key-account',
    request: z.object({
      subdomain: z.string(),
      email: z.string(),
      apiToken: z.string(),
    }),
    response: z.object({
      success: z.boolean(),
      subdomain: z.string().optional(),
      email: z.string().optional(),
      error: z.string().optional(),
    }),
    description: 'Add a Zendesk account using API key credentials (validates before saving)',
  }),
};
