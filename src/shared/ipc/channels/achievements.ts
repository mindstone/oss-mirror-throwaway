import { z } from 'zod';
import { defineInvokeChannel } from '../schemas';

const StreakDataSchema = z.object({
  current: z.number(),
  longest: z.number(),
  lastActiveDate: z.string(),
  freezesUsedThisWeek: z.number(),
  weekStartDate: z.string(),
});

const BadgeRecordSchema = z.object({
  unlockedAt: z.number(),
  notified: z.boolean(),
});

const TierSchema = z.object({
  tier: z.string(),
  unlockedAt: z.number(),
});

const EvidenceRecordSchema = z.object({
  signal: z.string(),
  timestamp: z.number(),
  sessionId: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const TierEvidenceSchema = z.object({
  tier: z.string(),
  unlockedAt: z.number(),
  evidence: z.array(EvidenceRecordSchema),
});

const OnboardingJourneySchema = z.object({
  completedDays: z.array(z.number()),
  journeyStartedAt: z.number().optional(),
});

const CountersSchema = z.object({
  totalSessions: z.number(),
  voiceSessions: z.number(),
  weekendSessions: z.number(),
  totalTimeSavedMinutes: z.number(),
});

const TierProgressSchema = z.object({
  currentTier: z.string(),
  nextTier: z.string().nullable(),
  requiredSignals: z.array(z.string()),
  earnedSignals: z.array(z.string()),
  signalsNeeded: z.number(),
  minCount: z.number(),
});

export const achievementsChannels = {
  'achievements:get-streak': defineInvokeChannel({
    channel: 'achievements:get-streak',
    request: z.void(),
    response: StreakDataSchema,
    description: 'Get current streak data (current, longest, last active date, weekly freezes)',
  }),

  'achievements:get-badges': defineInvokeChannel({
    channel: 'achievements:get-badges',
    request: z.void(),
    response: z.record(z.string(), BadgeRecordSchema),
    description: 'Get all unlocked badges keyed by badge ID',
  }),

  'achievements:get-tier': defineInvokeChannel({
    channel: 'achievements:get-tier',
    request: z.void(),
    response: TierSchema,
    description: 'Get current fluency tier and when it was unlocked',
  }),

  'achievements:get-tier-evidence': defineInvokeChannel({
    channel: 'achievements:get-tier-evidence',
    request: z.void(),
    response: TierEvidenceSchema,
    description: 'Get current tier with the evidence records that contributed to unlocking it',
  }),

  'achievements:get-next-badge': defineInvokeChannel({
    channel: 'achievements:get-next-badge',
    request: z.void(),
    response: z.string().nullable(),
    description: 'Get the badge ID of the next unnotified badge, or null if none pending',
  }),

  'achievements:mark-badge-notified': defineInvokeChannel({
    channel: 'achievements:mark-badge-notified',
    request: z.string(),
    response: z.object({ success: z.boolean() }),
    description: 'Mark a badge as notified (user has seen the toast)',
  }),

  'achievements:get-evidence-counts': defineInvokeChannel({
    channel: 'achievements:get-evidence-counts',
    request: z.void(),
    response: z.record(z.string(), z.number()),
    description: 'Get evidence counts keyed by signal type',
  }),

  'achievements:get-journey': defineInvokeChannel({
    channel: 'achievements:get-journey',
    request: z.void(),
    response: OnboardingJourneySchema,
    description: 'Get 14-day onboarding journey state (completed days, start timestamp)',
  }),

  'achievements:start-journey': defineInvokeChannel({
    channel: 'achievements:start-journey',
    request: z.void(),
    response: z.object({ success: z.boolean() }),
    description: 'Start the 14-day onboarding journey',
  }),

  'achievements:reset-journey': defineInvokeChannel({
    channel: 'achievements:reset-journey',
    request: z.void(),
    response: z.object({ success: z.boolean() }),
    description: 'Reset the onboarding journey state without affecting other achievements',
  }),

  'achievements:complete-journey-day': defineInvokeChannel({
    channel: 'achievements:complete-journey-day',
    request: z.number(),
    response: z.object({
      success: z.boolean(),
      day: z.number(),
    }),
    description: 'Mark a specific journey day as complete (1–14)',
  }),

  'achievements:get-counters': defineInvokeChannel({
    channel: 'achievements:get-counters',
    request: z.void(),
    response: CountersSchema,
    description: 'Get cumulative session counters used for badge evaluation',
  }),

  'achievements:should-show-graduation': defineInvokeChannel({
    channel: 'achievements:should-show-graduation',
    request: z.void(),
    response: z.boolean(),
    description: 'Whether the graduation modal should be shown (day 14 complete and not yet shown)',
  }),

  'achievements:mark-graduation-shown': defineInvokeChannel({
    channel: 'achievements:mark-graduation-shown',
    request: z.void(),
    response: z.void(),
    description: 'Mark the graduation modal as shown',
  }),

  'achievements:get-tier-progress': defineInvokeChannel({
    channel: 'achievements:get-tier-progress',
    request: z.void(),
    response: TierProgressSchema.nullable(),
    description: 'Get progress toward the next fluency tier, or null if at max tier',
  }),
} as const;
