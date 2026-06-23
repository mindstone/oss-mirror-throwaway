import { z } from 'zod';
import { defineInvokeChannel } from '../schemas/common';

const OpenRouterSetupResultSchema = z.discriminatedUnion('outcome', [
  z.object({
    outcome: z.literal('success'),
    maskedKey: z.string(),
  }),
  z.object({
    outcome: z.literal('cancelled'),
  }),
  z.object({
    outcome: z.literal('error'),
    error: z.string(),
  }),
]);

export const openRouterChannels = {
  'openRouter:setup-token': defineInvokeChannel({
    channel: 'openRouter:setup-token',
    request: z.void(),
    response: OpenRouterSetupResultSchema,
    description: 'Run the OpenRouter OAuth PKCE flow to obtain a permanent API key.',
  }),
  'openRouter:cancel-setup': defineInvokeChannel({
    channel: 'openRouter:cancel-setup',
    request: z.void(),
    response: z.void(),
    description: 'Cancel any in-progress OpenRouter token setup',
  }),
  'openRouter:disconnect': defineInvokeChannel({
    channel: 'openRouter:disconnect',
    request: z.void(),
    response: z.void(),
    description: 'Disconnect OpenRouter — clear stored API key and settings',
  }),
};
