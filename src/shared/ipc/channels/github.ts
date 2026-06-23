import { z } from 'zod';
import {
  defineInvokeChannel,
  IpcSuccessWithErrorResponseSchema,
  IpcSuccessWithErrorAndSetupGuidanceSchema,
} from '../schemas/common';

export const githubChannels = {
  'github:start-auth': defineInvokeChannel({
    channel: 'github:start-auth',
    request: z.void(),
    response: IpcSuccessWithErrorAndSetupGuidanceSchema,
    description: 'Start OAuth flow to connect GitHub',
  }),

  'github:get-status': defineInvokeChannel({
    channel: 'github:get-status',
    request: z.void(),
    response: z.object({
      connected: z.boolean(),
    }),
    description: 'Get GitHub connection status',
  }),

  'github:remove-account': defineInvokeChannel({
    channel: 'github:remove-account',
    request: z.void(),
    response: IpcSuccessWithErrorResponseSchema,
    description: 'Disconnect GitHub and remove stored OAuth tokens',
  }),
};
