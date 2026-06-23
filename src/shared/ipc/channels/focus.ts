import { z } from 'zod';
import { defineInvokeChannel } from '../schemas';

/**
 * Focus Surface IPC Channels
 *
 * Desktop-only channels for managing Focus goals: CRUD, review,
 * and frontmatter migration. All gated on `experimental.focusEnabled`.
 *
 * @see src/core/goalTypes.ts
 * @see src/core/services/goalsStore.ts
 * @see docs/plans/260406_focus_phase2_surface_shell.md
 */

// =============================================================================
// Zod Schemas (match src/core/goalTypes.ts)
// =============================================================================

const GoalStatusSchema = z.enum(['active', 'completed', 'dropped']);

const GoalSchema = z.object({
  id: z.string(),
  text: z.string(),
  why: z.string().optional(),
  outcome: z.string().optional(),
  obstacle: z.string().optional(),
  plan: z.string().optional(),
  status: GoalStatusSchema,
  createdAt: z.number(),
  updatedAt: z.number(),
  lastReviewedAt: z.number().optional(),
  quarterTag: z.string().optional(),
});

const CreateGoalInputSchema = z.object({
  text: z.string(),
  why: z.string().optional(),
  outcome: z.string().optional(),
  obstacle: z.string().optional(),
  plan: z.string().optional(),
  quarterTag: z.string().optional(),
});

const UpdateGoalInputSchema = z.object({
  id: z.string(),
  text: z.string().optional(),
  why: z.string().optional(),
  outcome: z.string().optional(),
  obstacle: z.string().optional(),
  plan: z.string().optional(),
  status: GoalStatusSchema.optional(),
  quarterTag: z.string().optional(),
});

// =============================================================================
// Channel Definitions
// =============================================================================

export const focusChannels = {
  'focus:get-goals': defineInvokeChannel({
    channel: 'focus:get-goals',
    request: z.object({}),
    response: z.object({
      goals: z.array(GoalSchema),
      lastWeeklyReview: z.number().nullable(),
      lastMonthlyReview: z.number().nullable(),
      migratedFromFrontmatterAt: z.number().nullable(),
    }),
    description: 'Get all goals and store metadata',
  }),

  /** @deprecated Goals are now edited via conversation. Use focus:get-all-space-goals for reads. */
  'focus:create-goal': defineInvokeChannel({
    channel: 'focus:create-goal',
    request: CreateGoalInputSchema,
    response: z.object({
      goal: GoalSchema,
    }),
    description: 'Create a new goal (deprecated — goals now edited via conversation)',
  }),

  /** @deprecated Goals are now edited via conversation. Use focus:get-all-space-goals for reads. */
  'focus:update-goal': defineInvokeChannel({
    channel: 'focus:update-goal',
    request: UpdateGoalInputSchema,
    response: z.object({
      goal: GoalSchema.nullable(),
    }),
    description: 'Update an existing goal by id (deprecated — goals now edited via conversation)',
  }),

  /** @deprecated Goals are now edited via conversation. Use focus:get-all-space-goals for reads. */
  'focus:delete-goal': defineInvokeChannel({
    channel: 'focus:delete-goal',
    request: z.object({ id: z.string() }),
    response: z.object({ success: z.boolean() }),
    description: 'Delete a goal by id (deprecated — goals now edited via conversation)',
  }),

  'focus:review-goals': defineInvokeChannel({
    channel: 'focus:review-goals',
    request: z.object({}),
    response: z.object({ success: z.boolean() }),
    description: 'Mark all active goals as reviewed (explicit review action)',
  }),

  'focus:migrate-from-frontmatter': defineInvokeChannel({
    channel: 'focus:migrate-from-frontmatter',
    request: z.object({}),
    response: z.object({
      migrated: z.boolean(),
      goalCount: z.number(),
    }),
    description: 'One-time migration of goals from Chief-of-Staff frontmatter to goals store',
  }),

  'focus:get-month-stats': defineInvokeChannel({
    channel: 'focus:get-month-stats',
    request: z.object({ monthOffset: z.number().optional() }),
    response: z.object({
      totalMeetings: z.number(),
      totalMeetingHoursEstimate: z.number(),
      meetingsByWeek: z.array(z.object({
        weekLabel: z.string(),
        meetingCount: z.number(),
        meetingHours: z.number(),
        solo: z.number(),
        internal: z.number(),
        external: z.number(),
      })),
      transcriptsCaptured: z.number(),
      goalsCreated: z.number(),
      goalsCompleted: z.number(),
      goalsDropped: z.number(),
      activeGoalCount: z.number(),
      lastReviewedAt: z.number().nullable(),
      dataSpanDays: z.number(),
      oldestEntryAt: z.number().nullable(),
      // Enriched fields
      soloTotal: z.number(),
      internalTotal: z.number(),
      externalTotal: z.number(),
      deepWorkHoursEstimate: z.number(),
      meetingVolumeTrend: z.enum(['increasing', 'decreasing', 'stable']),
      stalledGoals: z.array(z.string()),
    }),
    description: 'Get aggregated month stats from meeting history + goals for the Month Lens',
  }),
  // ── Space Goals (frontmatter-first redesign) ───────────────────────
  // @see docs/plans/260407_focus_goals_redesign.md

  'focus:get-all-space-goals': defineInvokeChannel({
    channel: 'focus:get-all-space-goals',
    request: z.void(),
    response: z.object({
      spaces: z.array(z.object({
        spaceName: z.string(),
        spacePath: z.string(),
        spaceType: z.string(),
        isPersonal: z.boolean(),
        goals: z.array(z.object({
          goal: z.string(),
          why: z.string().optional(),
        })),
        lastReviewed: z.string().nullable(),
      })),
      parseErrors: z.array(z.object({
        spaceName: z.string(),
        spacePath: z.string(),
        error: z.string(),
      })).optional(),
      /** Paths of spaces the user has dismissed (needed for restore UI) */
      dismissedPaths: z.array(z.string()).optional(),
      /** Spaces that exist but have no goals in their frontmatter */
      spacesWithoutGoals: z.array(z.object({
        spaceName: z.string(),
        spacePath: z.string(),
      })).optional(),
    }),
    description: 'Get goals from all space READMEs, filtered by user dismissals. Returns dismissedPaths for restore UI.',
  }),

  'focus:dismiss-space-goals': defineInvokeChannel({
    channel: 'focus:dismiss-space-goals',
    request: z.object({ spacePath: z.string() }),
    response: z.object({ success: z.boolean() }),
    description: 'Dismiss goals for a specific space (per-user, stored in local settings)',
  }),

  'focus:restore-space-goals': defineInvokeChannel({
    channel: 'focus:restore-space-goals',
    request: z.object({ spacePath: z.string() }),
    response: z.object({ success: z.boolean() }),
    description: 'Restore previously dismissed space goals',
  }),

  // ── Goal-Calendar Alignment ────────────────────────────────
  // @see docs/plans/260409_focus_time_vs_goals_visualization.md

  'focus:get-goal-alignment': defineInvokeChannel({
    channel: 'focus:get-goal-alignment',
    request: z.object({
      granularity: z.enum(['week', 'month']),
      weekOffset: z.number().optional(),
      monthOffset: z.number().optional(),
    }),
    response: z.object({
      goals: z.array(z.object({
        goalText: z.string(),
        spaceName: z.string(),
        isPersonal: z.boolean(),
        alignedHours: z.number(),
        alignedMeetingCount: z.number(),
        alignedMeetingTitles: z.array(z.string()),
        status: z.enum(['matched', 'no_matches', 'no_usable_keywords']),
      })),
      totalMeetingHours: z.number(),
      totalMeetingCount: z.number(),
      unalignedHours: z.number(),
      unalignedCount: z.number(),
      preppedMeetingCount: z.number(),
      excludedAsNoiseCount: z.number(),
      granularity: z.enum(['week', 'month']),
    }),
    description: 'Get duration-based goal-calendar alignment data for Time & Goals visualization',
  }),
} as const;
