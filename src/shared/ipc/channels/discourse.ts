import { z } from 'zod';
import { defineInvokeChannel } from '../schemas/common';

export const discourseChannels = {
  'discourse:start-auth': defineInvokeChannel({
    channel: 'discourse:start-auth',
    request: z.void(),
    response: z.object({
      success: z.boolean(),
      username: z.string().optional(),
      error: z.string().optional(),
    }),
    description: 'Start Discourse User API Key auth flow for Rebels Community write access',
  }),

  'discourse:cancel-auth': defineInvokeChannel({
    channel: 'discourse:cancel-auth',
    request: z.void(),
    response: z.void(),
    description: 'Cancel any pending Discourse auth flow',
  }),
};
