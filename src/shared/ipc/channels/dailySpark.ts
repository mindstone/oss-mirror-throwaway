import { z } from 'zod';
import { defineInvokeChannel } from '../schemas';

const DailySparkFormatSchema = z.enum([
  'limerick',
  'dry_one_liner',
  'haiku',
  'faux_news_headline',
  'mock_weather_report',
  'one_sentence_noir',
  'sommelier_note',
  'faux_shakespearean_aside',
  'telegram_style',
  'personal_proverb',
]);

const DailySparkLayoutSchema = z.enum(['poem', 'single', 'structured']);
const DailySparkToneGaugeSchema = z.enum(['normal', 'gentle', 'silent']);

const DailySparkSchema = z.object({
  id: z.string(),
  weekStartIso: z.string(),
  dayIso: z.string(),
  format: DailySparkFormatSchema,
  layout: DailySparkLayoutSchema,
  body: z.string(),
  captionOverride: z.string().optional(),
  revealedAt: z.number().optional(),
  dismissedAt: z.number().optional(),
  feedback: z.literal('less_like_this').optional(),
});

const DailySparkWeeklyBatchSchema = z.object({
  weekStartIso: z.string(),
  generatedAt: z.number(),
  toneGauge: DailySparkToneGaugeSchema,
  sparks: z.array(DailySparkSchema),
  sourceModel: z.string(),
  promptVersion: z.string(),
  isFirstAppearanceWeek: z.boolean(),
});

export const dailySparkChannels = {
  'daily-spark:get-today': defineInvokeChannel({
    channel: 'daily-spark:get-today',
    request: z.object({}),
    response: z.object({
      spark: DailySparkSchema.nullable(),
      isFirstAppearance: z.boolean(),
      toneGauge: DailySparkToneGaugeSchema.nullable(),
    }),
    description: "Get today's Daily Spark and first-appearance flag.",
  }),
  'daily-spark:dismiss-today': defineInvokeChannel({
    channel: 'daily-spark:dismiss-today',
    request: z.object({ sparkId: z.string() }),
    response: z.object({ ok: z.boolean() }),
    description: "Dismiss today's spark only (per-day).",
  }),
  'daily-spark:feedback-less-like-this': defineInvokeChannel({
    channel: 'daily-spark:feedback-less-like-this',
    request: z.object({ sparkId: z.string() }),
    response: z.object({ ok: z.boolean() }),
    description: 'Record per-format less-like-this feedback (no spark text leaves).',
  }),
  'daily-spark:generate-now': defineInvokeChannel({
    channel: 'daily-spark:generate-now',
    request: z.object({}),
    response: z.object({
      batch: DailySparkWeeklyBatchSchema.nullable(),
      error: z.string().optional(),
    }),
    description: 'Dev/QA: trigger immediate batch generation.',
  }),
} as const;
