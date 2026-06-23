import { z } from 'zod';
import { defineInvokeChannel } from '../schemas';
import { ImpactLevelSchema } from '../schemas/agent';

const WeeklyTimeSavedAggregateSchema = z.object({
  weekStartDate: z.string(),
  totalMinutes: z.number(),
  sessionCount: z.number(),
});

const TimeSavedAggregateSummarySchema = z.object({
  totalMinutes: z.number(),
  sessionCount: z.number(),
});

const TimeSavedAggregatesSchema = z.object({
  currentWeek: WeeklyTimeSavedAggregateSchema,
  lastWeek: WeeklyTimeSavedAggregateSchema,
  currentMonth: TimeSavedAggregateSummarySchema,
  allTime: TimeSavedAggregateSummarySchema,
});

const WeeklyTrendSchema = z.enum(['up', 'steady']).nullable();

const TimeSavedTaskTypeSchema = z.enum([
  'research',
  'writing',
  'coordination',
  'analysis',
  'automation',
  'mixed',
]);

const TopSessionInfoSchema = z.object({
  sessionId: z.string(),
  totalMinutes: z.number(),
  taskType: TimeSavedTaskTypeSchema,
  reasoning: z.string().optional(),
  reasoningDetail: z.string().optional(),
  entryCount: z.number(),
  latestTimestamp: z.number(),
  highestImpact: ImpactLevelSchema.optional(),
});

export const timeSavedChannels = {
  'time-saved:aggregates': defineInvokeChannel({
    channel: 'time-saved:aggregates',
    request: z.void(),
    response: z.object({
      aggregates: TimeSavedAggregatesSchema,
      trend: WeeklyTrendSchema,
      trackingSince: z.number().nullable(),
    }),
    description: 'Get time saved aggregate totals, trend, and tracking start timestamp',
  }),

  'time-saved:by-session': defineInvokeChannel({
    channel: 'time-saved:by-session',
    request: z.void(),
    response: z.record(z.string(), z.number()),
    description: 'Get time saved minutes grouped by session ID',
  }),

  'time-saved:has-seen-first': defineInvokeChannel({
    channel: 'time-saved:has-seen-first',
    request: z.void(),
    response: z.boolean(),
    description: 'Check whether the first time saved estimate has been seen',
  }),

  'time-saved:mark-first-seen': defineInvokeChannel({
    channel: 'time-saved:mark-first-seen',
    request: z.void(),
    response: z.void(),
    description: 'Mark the first time saved estimate as seen',
  }),

  'time-saved:next-milestone': defineInvokeChannel({
    channel: 'time-saved:next-milestone',
    request: z.void(),
    response: z.number().nullable(),
    description: 'Get the next unacknowledged time saved milestone',
  }),

  'time-saved:acknowledge-milestone': defineInvokeChannel({
    channel: 'time-saved:acknowledge-milestone',
    request: z.number(),
    response: z.void(),
    description: 'Acknowledge a time saved milestone by minute value',
  }),

  'time-saved:today-minutes': defineInvokeChannel({
    channel: 'time-saved:today-minutes',
    request: z.void(),
    response: z.number(),
    description: 'Get time saved minutes for today',
  }),

  'time-saved:week-daily-totals': defineInvokeChannel({
    channel: 'time-saved:week-daily-totals',
    request: z.void(),
    response: z.record(z.string(), z.number()),
    description: 'Get daily time saved totals for the current week',
  }),

  'time-saved:should-show-first-big-win': defineInvokeChannel({
    channel: 'time-saved:should-show-first-big-win',
    request: z.void(),
    response: z.boolean(),
    description: 'Check whether the first big win celebration should be shown',
  }),

  'time-saved:should-show-first-week': defineInvokeChannel({
    channel: 'time-saved:should-show-first-week',
    request: z.void(),
    response: z.boolean(),
    description: 'Check whether the first week celebration should be shown',
  }),

  'time-saved:mark-first-big-win-shown': defineInvokeChannel({
    channel: 'time-saved:mark-first-big-win-shown',
    request: z.void(),
    response: z.void(),
    description: 'Mark the first big win celebration as shown',
  }),

  'time-saved:mark-first-week-shown': defineInvokeChannel({
    channel: 'time-saved:mark-first-week-shown',
    request: z.void(),
    response: z.void(),
    description: 'Mark the first week celebration as shown',
  }),

  'time-saved:should-show-first-high-impact': defineInvokeChannel({
    channel: 'time-saved:should-show-first-high-impact',
    request: z.void(),
    response: z.boolean(),
    description: 'Check whether the first high-impact celebration should be shown',
  }),

  'time-saved:mark-first-high-impact-shown': defineInvokeChannel({
    channel: 'time-saved:mark-first-high-impact-shown',
    request: z.void(),
    response: z.void(),
    description: 'Mark the first high-impact celebration as shown',
  }),

  'time-saved:week-top-sessions': defineInvokeChannel({
    channel: 'time-saved:week-top-sessions',
    request: z.void(),
    response: z.array(TopSessionInfoSchema),
    description: 'Get top sessions by time saved for the current week',
  }),

  'time-saved:day-top-sessions': defineInvokeChannel({
    channel: 'time-saved:day-top-sessions',
    request: z.string(),
    response: z.array(TopSessionInfoSchema),
    description: 'Get top sessions by time saved for a given date',
  }),
} as const;
