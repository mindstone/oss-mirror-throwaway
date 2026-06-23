import { z } from 'zod';
import {
  defineInvokeChannel,
  defineSyncChannel,
  AgentSessionSchema,
  AgentEventSchema,
  AgentSessionSummarySchema,
  DiagnosticSummarySchema,
  ConversationSummarySchema,
  NarrativeAnalysisSchema,
} from '../schemas';

const contentReadRequestSchema = z.object({
  sessionId: z.string(),
  contentId: z.string(),
});

const contentReadResponseSchema = z.discriminatedUnion('reason', [
  z.object({
    reason: z.literal('ok'),
    bytesBase64: z.string(),
    mimeType: z.string(),
  }),
  z.object({
    reason: z.enum(['missing', 'corrupt', 'unknown']),
  }),
]);

export const sessionsChannels = {
  // ============================================================================
  // Legacy channels (kept for backward compatibility during migration)
  // ============================================================================

  'sessions:load': defineInvokeChannel({
    channel: 'sessions:load',
    request: z.void(),
    response: z.array(AgentSessionSchema),
    description: 'Load all persisted agent sessions (legacy - loads full sessions)',
  }),

  'sessions:save': defineInvokeChannel({
    channel: 'sessions:save',
    request: z.array(AgentSessionSchema),
    response: z.object({
      success: z.boolean(),
    }),
    description: 'Save agent sessions to persistent storage (legacy - saves all sessions)',
  }),

  // session:restore-upstream removed — Rebel Core is the sole runtime.
  // See: docs/plans/260406_fix_sdk_conversation_amnesia.md

  'sessions:save-sync': defineSyncChannel({
    channel: 'sessions:save-sync',
    request: z.array(AgentSessionSchema),
    response: z.object({
      success: z.boolean(),
      error: z.string().optional(),
    }),
    description: 'Synchronous save for beforeunload - async invoke does not complete before window closes',
  }),

  // ============================================================================
  // New lazy loading channels (Stage 1 of session history lazy loading)
  // ============================================================================

  'sessions:list': defineInvokeChannel({
    channel: 'sessions:list',
    request: z.void(),
    response: z.array(AgentSessionSummarySchema),
    description: 'Load lightweight session summaries for sidebar display',
  }),

  'sessions:get': defineInvokeChannel({
    channel: 'sessions:get',
    request: z.object({ id: z.string() }),
    response: AgentSessionSchema.nullable(),
    description: 'Load full session content by ID (on-demand)',
  }),

  'sessions:upsert': defineInvokeChannel({
    channel: 'sessions:upsert',
    request: AgentSessionSchema,
    response: z.object({
      success: z.boolean(),
      error: z.object({ message: z.string() }).optional(),
    }),
    description: 'Save or update a single session (writes file + updates index)',
  }),

  'sessions:apply-turn-event-union': defineInvokeChannel({
    channel: 'sessions:apply-turn-event-union',
    request: z.object({
      sessionId: z.string(),
      turnId: z.string(),
      events: z.array(AgentEventSchema),
    }),
    response: z.object({
      success: z.boolean(),
      error: z.object({ message: z.string() }).optional(),
    }),
    description: 'Atomically merge replayed turn events by identity into a session',
  }),

  'sessions:delete': defineInvokeChannel({
    channel: 'sessions:delete',
    request: z.object({ id: z.string() }),
    response: z.object({
      success: z.boolean(),
      error: z.object({ message: z.string() }).optional(),
    }),
    description: 'Delete a session (removes file and index entry)',
  }),

  'sessions:get-diagnostic-summary': defineInvokeChannel({
    channel: 'sessions:get-diagnostic-summary',
    request: z.object({ sessionId: z.string() }),
    response: z.object({
      summary: DiagnosticSummarySchema.nullable(),
      error: z.string().optional(),
    }),
    description: 'Get lightweight diagnostic summary for conversation diagnosis',
  }),

  'sessions:generate-summary': defineInvokeChannel({
    channel: 'sessions:generate-summary',
    request: z.object({
      sessionId: z.string(),
    }),
    response: z.object({
      summary: ConversationSummarySchema.nullable(),
      error: z.string().optional(),
      /** True if truncation fallback was used instead of AI summary */
      fallbackUsed: z.boolean(),
    }),
    description: 'Generate AI summary for conversation mention',
  }),

  'sessions:generate-narrative': defineInvokeChannel({
    channel: 'sessions:generate-narrative',
    request: z.object({
      sessionId: z.string(),
    }),
    response: z.object({
      narrative: NarrativeAnalysisSchema.nullable(),
      error: z.string().optional(),
    }),
    description: 'Generate AI narrative analysis for conversation diagnostics',
  }),

  'sessions:export-logs': defineInvokeChannel({
    channel: 'sessions:export-logs',
    request: z.object({
      sessionId: z.string(),
    }),
    response: z.object({
      success: z.boolean(),
      content: z.string().optional(),
      filename: z.string().optional(),
      error: z.string().optional(),
    }),
    description: 'Export diagnostic report for a specific conversation session',
  }),

  'sessions:read-content': defineInvokeChannel({
    channel: 'sessions:read-content',
    request: contentReadRequestSchema,
    response: contentReadResponseSchema,
    description: 'Read an opaque content_ref payload from the local ContentStore for renderer hydration. Stage B1b.',
  }),

  'content:read': defineInvokeChannel({
    channel: 'content:read',
    request: contentReadRequestSchema,
    response: contentReadResponseSchema,
    description: 'Read content_ref bytes by session/content id. Alias for sessions:read-content.',
  }),
} as const;
