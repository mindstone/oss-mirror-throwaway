import { z } from 'zod';
import { defineInvokeChannel } from '../schemas';

const SuggestionStateSchema = z.enum(['pending', 'acted', 'rejected', 'dismissed']);

const ImprovementTargetSchema = z.object({
  type: z.enum(['skill', 'memory', 'preference']),
  name: z.string(),
  path: z.string().optional(),
});

const SystemImprovementSuggestionSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  evaluatedAt: z.number(),
  observation: z.string(),
  target: ImprovementTargetSchema,
  proposedChange: z.string(),
  intent: z.string(),
  confidence: z.number(),
  state: SuggestionStateSchema,
  fingerprint: z.string(),
  stateUpdatedAt: z.number().optional(),
});

export const systemImprovementChannels = {
  'system-improvement:get-pending': defineInvokeChannel({
    channel: 'system-improvement:get-pending',
    request: z.object({}),
    response: z.object({
      suggestions: z.array(SystemImprovementSuggestionSchema),
    }),
    description: 'Get all pending improvement suggestions',
  }),

  'system-improvement:update-state': defineInvokeChannel({
    channel: 'system-improvement:update-state',
    request: z.object({
      id: z.string(),
      state: SuggestionStateSchema,
    }),
    response: z.object({
      success: z.boolean(),
    }),
    description: 'Update the state of an improvement suggestion (act/reject/dismiss)',
  }),
};
