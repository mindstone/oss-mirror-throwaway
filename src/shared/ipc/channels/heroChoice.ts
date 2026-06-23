import { z } from 'zod';
import { defineInvokeChannel } from '../schemas';

const HeroChoiceCandidateTypeSchema = z.enum([
  'meeting_prep',
  'coaching',
  'improvement',
  'use_case',
  'insight',
]);

const HeroChoiceCandidateSchema = z.object({
  id: z.string(),
  type: HeroChoiceCandidateTypeSchema,
  headline: z.string(),
  body: z.string(),
  actionLabel: z.string(),
  actionPrompt: z.string(),
  priority: z.number(),
  sourceSessionId: z.string().optional(),
  sourceSkill: z.string().optional(),
});

const HeroChoiceResultSchema = z.object({
  candidates: z.array(HeroChoiceCandidateSchema),
  weekSummary: z.string(),
  generatedAt: z.number(),
  modelUsed: z.string(),
});

const HeroChoiceCandidateStateSchema = z.enum(['pending', 'acted', 'dismissed']);

const HeroChoiceEntrySchema = z.object({
  result: HeroChoiceResultSchema,
  candidateStates: z.record(z.string(), HeroChoiceCandidateStateSchema),
  feedback: z.record(z.string(), z.enum(['helpful', 'not_helpful'])),
});

export const heroChoiceChannels = {
  'hero-choice:get-current': defineInvokeChannel({
    channel: 'hero-choice:get-current',
    request: z.object({}),
    response: z.object({
      entry: HeroChoiceEntrySchema.nullable(),
    }),
    description: 'Get the current hero choice entry with candidates',
  }),

  'hero-choice:update-candidate-state': defineInvokeChannel({
    channel: 'hero-choice:update-candidate-state',
    request: z.object({
      candidateId: z.string(),
      state: z.enum(['acted', 'dismissed']),
    }),
    response: z.object({ success: z.boolean() }),
    description: 'Update state of a hero choice candidate (act or dismiss)',
  }),

  'hero-choice:set-feedback': defineInvokeChannel({
    channel: 'hero-choice:set-feedback',
    request: z.object({
      candidateId: z.string(),
      feedback: z.enum(['helpful', 'not_helpful']),
    }),
    response: z.object({ success: z.boolean() }),
    description: 'Set feedback on a hero choice candidate',
  }),

  'hero-choice:generate-now': defineInvokeChannel({
    channel: 'hero-choice:generate-now',
    request: z.object({}),
    response: z.object({
      entry: HeroChoiceEntrySchema.nullable(),
      error: z.string().optional(),
    }),
    description: 'Trigger on-demand hero choice generation and return the result',
  }),
} as const;
