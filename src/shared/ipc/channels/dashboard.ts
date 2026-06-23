import { z } from 'zod';
import { defineInvokeChannel, JsonValueSchema, PersonalizedUseCaseSchema } from '../schemas';
import { AGENT_ERROR_KINDS } from '../../utils/agentErrorCatalog';

/** A recent memory update preview */
export const MemoryPreviewSchema = z.object({
  summary: z.string(),
  timestamp: z.number(),
  action: z.enum(['created', 'updated']),
  /** Relative file path to open */
  filePath: z.string().optional(),
});

/** A recent skill update preview */
export const SkillPreviewSchema = z.object({
  name: z.string(),
  timestamp: z.number(),
  /** Relative file path to open */
  filePath: z.string(),
});

/** Activity summary for a single space */
export const SpaceActivitySchema = z.object({
  /** Space path (e.g., "Chief-of-Staff", "work/Mindstone/General") */
  spacePath: z.string(),
  /** Display name for the space */
  displayName: z.string(),
  /** Space type */
  spaceType: z.enum(['chief-of-staff', 'personal', 'company', 'team', 'project', 'operator', 'other']),
  /** Number of memory entries in the time window */
  memoryCount: z.number(),
  /** Number of skill files modified in the time window */
  skillCount: z.number(),
  /** Most recent activity timestamp (memory or skill) */
  lastActivityAt: z.number().nullable(),
  /** Whether this space is a symlink */
  isSymlink: z.boolean().optional(),
  /** Preview of recent memories (up to 3) */
  recentMemories: z.array(MemoryPreviewSchema),
  /** Preview of recent skills (up to 3) */
  recentSkills: z.array(SkillPreviewSchema),
});

export type MemoryPreview = z.infer<typeof MemoryPreviewSchema>;
export type SkillPreview = z.infer<typeof SkillPreviewSchema>;
export type SpaceActivity = z.infer<typeof SpaceActivitySchema>;

/** Synthesis of space activity */
export const SpacesSynthesisSchema = z.object({
  hook: z.string(),
  detail: z.string(),
  generatedAt: z.number(),
  focus: z.string(),
});

export type SpacesSynthesis = z.infer<typeof SpacesSynthesisSchema>;

/** Personal goals from Chief-of-Staff frontmatter */
export const PersonalGoalItemSchema = z.object({
  goal: z.string(),
  why: z.string().optional(),
});

export const PersonalGoalsSchema = z.object({
  /** Quarterly goals (the most actionable level) */
  thisQuarter: z.array(PersonalGoalItemSchema),
  /** Last reviewed date (YYYY-MM-DD format) */
  lastReviewed: z.string().nullable(),
  /** Status based on lastReviewed date */
  status: z.enum(['not_set', 'current', 'stale']),
});

export type PersonalGoalItem = z.infer<typeof PersonalGoalItemSchema>;
export type PersonalGoals = z.infer<typeof PersonalGoalsSchema>;

export const DashboardSharePayloadSchema = z.object({
  version: z.literal(1),
  source: z.object({
    tableId: z.string(),
    organizationId: z.string(),
    organizationName: z.string(),
    windowDays: z.number(),
    snapshotAt: z.string(),
  }),
  rows: z.array(JsonValueSchema),
  starterPrompt: z.string(),
  mcpHints: z.object({
    scopedToolHint: z.string().optional(),
  }).optional(),
});

export type DashboardSharePayload = z.infer<typeof DashboardSharePayloadSchema>;

const DashboardShareRedeemResponseSchema = z.union([
  z.object({
    success: z.literal(true),
    payload: DashboardSharePayloadSchema,
    organizationId: z.string(),
    createdByUserId: z.string(),
  }),
  z.object({
    success: z.literal(false),
    errorCode: z.enum([
      'TOKEN_EXPIRED',
      'TOKEN_REPLAYED',
      'TOKEN_NOT_FOUND',
      'FORBIDDEN_SCOPE',
      'UNAUTHENTICATED',
      'NETWORK_ERROR',
      'UNSUPPORTED_PAYLOAD_VERSION',
      'UNKNOWN_ERROR',
    ]),
    message: z.string(),
  }),
]);

export type DashboardShareRedeemResponse = z.infer<typeof DashboardShareRedeemResponseSchema>;

export const dashboardChannels = {
  'dashboard:get-space-activity': defineInvokeChannel({
    channel: 'dashboard:get-space-activity',
    request: z.object({
      /** Time window in days (default: 7) */
      dayWindow: z.number().default(7),
    }),
    response: z.object({
      spaces: z.array(SpaceActivitySchema),
      totalMemoryCount: z.number(),
      totalSkillCount: z.number(),
    }),
    description: 'Get activity summary across all spaces for The Spark',
  }),

  'dashboard:get-spaces-synthesis': defineInvokeChannel({
    channel: 'dashboard:get-spaces-synthesis',
    request: z.object({
      focus: z.string(),
      forceRegenerate: z.boolean().optional(),
    }),
    response: SpacesSynthesisSchema,
    description: 'Get AI-generated synthesis of space activity',
  }),

  'dashboard:generate-use-cases': defineInvokeChannel({
    channel: 'dashboard:generate-use-cases',
    request: z.void(),
    response: z.object({
      success: z.boolean(),
      useCases: z.array(PersonalizedUseCaseSchema).optional(),
      userFirstName: z.string().optional(),
      userEmail: z.string().optional(),
      error: z.string().optional(),
      errorKind: z.enum(AGENT_ERROR_KINDS).optional(),
      count: z.number().optional(),
    }),
    description: 'Generate personalized use cases based on connected tools',
  }),
  'dashboard:parse-use-cases': defineInvokeChannel({
    channel: 'dashboard:parse-use-cases',
    request: z.object({
      sessionOutput: z.string(),
    }),
    response: z.object({
      success: z.boolean(),
      useCases: z.array(PersonalizedUseCaseSchema).optional(),
      userFirstName: z.string().optional(),
      userEmail: z.string().optional(),
      error: z.string().optional(),
      errorKind: z.enum(AGENT_ERROR_KINDS).optional(),
      count: z.number().optional(),
    }),
    description: 'Parse and save use cases from existing session output (skips discovery phase)',
  }),

  'dashboard:get-personal-goals': defineInvokeChannel({
    channel: 'dashboard:get-personal-goals',
    request: z.void(),
    response: PersonalGoalsSchema,
    description: 'Get personal goals from Chief-of-Staff frontmatter',
  }),

  'dashboard:redeem-share-token': defineInvokeChannel({
    channel: 'dashboard:redeem-share-token',
    request: z.object({
      token: z.string().min(1),
    }),
    response: DashboardShareRedeemResponseSchema,
    description: 'Redeem a Rebel Platform dashboard share token for seeded chat context',
  }),

  'dashboard:ensure-goals-in-frontmatter': defineInvokeChannel({
    channel: 'dashboard:ensure-goals-in-frontmatter',
    request: z.void(),
    response: z.object({
      success: z.boolean(),
      action: z.enum(['already_correct', 'extracted_from_body', 'no_goals_found', 'error']),
      goalCount: z.number().optional(),
      error: z.string().optional(),
      errorKind: z.enum(AGENT_ERROR_KINDS).optional(),
    }),
    description: 'Check if goals are in frontmatter; if not, extract from markdown body and save',
  }),
} as const;
