import { z } from 'zod';
import { SessionOriginSchema } from './common';

/**
 * Session usage stats schema - pre-computed from eventsByTurn for sidebar display.
 */
export const SessionUsageStatsSchema = z.object({
  costUsd: z.number(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  turnCount: z.number(),
});
export type SessionUsageStats = z.infer<typeof SessionUsageStatsSchema>;

/**
 * Lightweight session summary for index file.
 * Contains only metadata needed for sidebar display, not full content.
 * Full session content is loaded on-demand via sessions:get IPC.
 */
export const AgentSessionSummarySchema = z.object({
  id: z.string(),
  title: z.string().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
  /** Server-stamped monotonic timestamp for cloud ordering/filtering. */
  cloudUpdatedAt: z.number().optional(),
  resolvedAt: z.number().nullable(),
  /** Canonical lifecycle field (non-null = Done). */
  doneAt: z.number().nullable().optional(),
  starredAt: z.number().nullable(),
  deletedAt: z.number().nullable(),
  origin: SessionOriginSchema,
  isCorrupted: z.boolean(),
  /** Private mode indicator (same as AgentSession.privateMode) */
  privateMode: z.boolean().optional(),
  /** Turn ID that was interrupted when the app closed (for auto-resume) */
  interruptedTurnId: z.string().nullable().optional(),

  // Pre-computed for sidebar (avoid loading full session)
  /** Last message snippet (80 chars) */
  preview: z.string(),
  /** First message preview for tooltip (200 chars) */
  firstMessagePreview: z.string().optional(),
  /** Last message preview for tooltip (200 chars) */
  lastMessagePreview: z.string().optional(),
  /** Number of messages in the session */
  messageCount: z.number(),
  /** Whether the session contains at least one user message (for embedding eligibility) */
  hasUserMessages: z.boolean().optional(),
  /** Number of user messages in the session (for summary-tier stale embedding checks) */
  userMessageCount: z.number().optional(),

  // Draft metadata (persisted in index so sidebar can show draft-only sessions without loading full session)
  /** Whether session has a non-empty draft (derived from AgentSession.draft) */
  hasDraft: z.boolean(),
  /** Whether session has pending conversation annotations (derived from AgentSession.annotations) */
  hasAnnotations: z.boolean().optional(),
  /** Draft snippet (50 chars) for draft-only session preview (null when no draft) */
  draftPreview: z.string().nullable(),
  /** Draft updated timestamp (null when no draft) */
  draftUpdatedAt: z.number().nullable(),

  // Usage stats (pre-computed from eventsByTurn at save time)
  usage: SessionUsageStatsSchema,

  // Runtime status fields for lazy loading (sidebar display + event routing)
  /** Active turn ID for resolveSessionId + busy indicator */
  activeTurnId: z.string().nullable(),
  /** Whether session has an active turn (derived from activeTurnId presence) */
  isBusy: z.boolean(),
  /** Last liveness activity timestamp for summary-tier staleness reconciliation. */
  lastActivityAt: z.number().nullable().optional(),
  /** Last error message for sidebar error preview */
  lastError: z.string().nullable(),
  /** Highest server-stamped event sequence number persisted for this session. */
  maxSeq: z.number().int().positive().optional(),
  /** Meeting companion metadata (optional - only present for meeting-linked sessions) */
  meetingCompanion: z.object({
    meetingUrl: z.string(),
    botId: z.string().optional(),
    startedAt: z.number().optional(),
  }).optional(),
});
export type AgentSessionSummary = z.infer<typeof AgentSessionSummarySchema>;

/**
 * Index file structure for lazy-loaded session storage.
 * Canonical version lives in INDEX_VERSION in core/services/incrementalSessionStore.ts.
 */
export const AgentSessionIndexSchema = z.object({
  /** Index format version. Canonical source: INDEX_VERSION in core/services/incrementalSessionStore.ts */
  version: z.number(),
  /** Lightweight session summaries for all sessions */
  sessions: z.array(AgentSessionSummarySchema),
  /** Timestamp of migration from v4 format (if migrated) */
  migratedAt: z.number().optional(),
  /** Previous version that was migrated from (for diagnostics) */
  migratedFrom: z.number().optional(),
  /** Timestamp of last index rebuild (crash recovery) */
  rebuiltAt: z.number().optional(),
});
export type AgentSessionIndex = z.infer<typeof AgentSessionIndexSchema>;

/**
 * Lightweight diagnostic summary for conversation diagnosis.
 * Provides enough context for initial analysis without overflowing context.
 * Agent can fetch full data via Read tool if needed.
 */
export const DiagnosticSummarySchema = z.object({
  // Session identification
  sessionId: z.string(),
  sessionTitle: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),

  // Metrics
  turnCount: z.number(),
  messageCount: z.number(),
  totalDurationMs: z.number(),
  totalCostUsd: z.number(),

  // Issues
  errorCount: z.number(),
  toolFailureCount: z.number(),
  compactionCount: z.number(),
  maxContextUtilization: z.number(), // 0-1

  // Tool breakdown
  toolMetrics: z.object({
    totalCalls: z.number(),
    byTool: z.record(z.string(), z.object({
      calls: z.number(),
      failures: z.number(),
    })),
  }),

  // Recent messages (for quick scan)
  recentMessages: z.array(z.object({
    role: z.enum(['user', 'assistant']),
    preview: z.string(), // 300 chars max
    turnId: z.string(),
    hasErrors: z.boolean(),
  })),

  // File paths for deeper investigation
  paths: z.object({
    claudeTranscript: z.string().nullable(),
    sessionLogsDir: z.string().nullable(),
  }),

  // Internal Rebel link for reference
  rebelConversationLink: z.string(),
});
export type DiagnosticSummary = z.infer<typeof DiagnosticSummarySchema>;

/**
 * AI-generated summary for conversation mentions.
 * Generated by Haiku when @-mentioning a past conversation.
 * Emphasis is on completeness over brevity.
 */
export const ConversationSummarySchema = z.object({
  /** Thorough overview of what was discussed, the user's goals, and outcomes achieved */
  overview: z.string(),
  /** The user's original goal and how their intent evolved during the conversation */
  userIntent: z.string().optional(),
  /** Where things ended: what was completed, what was in progress, what remains */
  currentStatus: z.string().optional(),
  /** All important decisions, conclusions, user preferences, and stated intent */
  keyDecisions: z.array(z.string()),
  /** Unresolved questions, pending decisions, areas needing follow-up */
  openQuestions: z.array(z.string()).optional(),
  /** Surprises, edge cases, gotchas, warnings, or learnings that could help avoid mistakes */
  gotchasAndInsights: z.array(z.string()),
  /** All skills, files, URLs, tools, or resources referenced in the conversation */
  resourcesMentioned: z.array(z.string()),
});
export type ConversationSummary = z.infer<typeof ConversationSummarySchema>;

/**
 * AI-generated narrative analysis for conversation diagnostics.
 * Generated by Haiku when user clicks "Generate Analysis" in the Narrative tab.
 * Identifies waste, inefficiency, and provides an efficiency verdict.
 */
export const NarrativeAnalysisSchema = z.object({
  /** The user's actual goal (1 sentence) */
  goal: z.string(),
  /** What this conversation SHOULD have taken */
  idealEstimate: z.object({
    time: z.string(),
    tokens: z.string(),
    cost: z.string(),
  }),
  /** What actually happened (3-5 sentences, chronological, specific) */
  narrative: z.string(),
  /** Specific waste items identified in the conversation */
  wasteItems: z.array(z.object({
    description: z.string(),
    category: z.enum(['slow_tool', 'redundant_call', 'large_output', 'context_bloat', 'sub_agent_overhead']),
    timeWasted: z.string(),
    tokensWasted: z.string(),
    suggestion: z.string(),
    turnNumber: z.number().optional(),
  })),
  /** Efficiency score 0-100 (100 = perfectly efficient) */
  efficiencyScore: z.number(),
  /** One-sentence bottom line */
  verdict: z.string(),
});
export type NarrativeAnalysis = z.infer<typeof NarrativeAnalysisSchema>;
