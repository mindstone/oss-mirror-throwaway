import { BlockSourceSchema, FileLocationSchema } from '@rebel/shared';
import { z } from 'zod';
import { defineInvokeChannel } from '../schemas';
import { MemoryUpdateStatusSchema, TimeSavedStatusSchema } from '../schemas/agent';

export const MemoryHistoryEntrySchema = z.object({
  id: z.string(),
  timestamp: z.number(),
  sessionId: z.string(),
  turnId: z.string(),
  entity: z.string(),
  visibility: z.enum(['private', 'shared']),
  action: z.enum(['created', 'updated']),
  summary: z.string(),
  filePath: z.string().optional(),
  sessionTitle: z.string().optional(),
});

export interface MemorySpaceStats {
  space: string;
  count: number;
  lastUpdated: number | null;
  visibility: 'private' | 'shared';
  children?: MemorySpaceStats[];
}

export const MemorySpaceStatsSchema: z.ZodType<MemorySpaceStats> = z.object({
  space: z.string(),
  count: z.number(),
  lastUpdated: z.number().nullable(),
  visibility: z.enum(['private', 'shared']),
  children: z.lazy(() => z.array(MemorySpaceStatsSchema)).optional(),
});

/**
 * Status values returned by CoS pending service operations (publish, discard, keep-private, resolve-conflict).
 * Matches the `PublishResult['status']` union from `cosPendingService.ts`.
 */
export const StagingStatusSchema = z.enum([
  'success',
  'conflict',
  'not-found',
  'error',
  'invalid-destination',
  'already-resolved',
]);

/**
 * Conflict payload shape after `normalizeConflictResponse` in memoryHandlers.
 * Used by `staging-publish` and `staging-resolve-conflict` responses.
 */
export const NormalizedConflictSchema = z.object({
  realContent: z.string(),
  stagedContent: z.string(),
});

export const StagedMemoryFileSchema = z.object({
  id: z.string(),
  realPath: z.string(),
  pendingDestination: z.string().optional(),
  spaceName: z.string(),
  // Stage 5A: tightened from z.string() to .min(1). Post-Stage-2 producers
  // (memory:get-pending-approvals, memory:staging-get-all, cloudStagingBridge)
  // are fail-closed and always emit spacePath derived from
  // location.workspaceRelativePath / location.absolutePath — both .min(1)
  // on FileLocationSchema. Empty-string emission is now a schema violation.
  // See docs/plans/260419_file_location_centralisation.md § Stage 5A.
  spacePath: z.string().min(1),
  location: FileLocationSchema.optional(),
  sessionId: z.string(),
  baseHash: z.string(),
  summary: z.string(),
  stagedAt: z.number(),
  sensitivity: z.literal('high'),
  sharing: z.string().optional(),
  blockedBy: BlockSourceSchema.optional(),
  hasConflict: z.boolean().optional(),
  approvalKind: z.enum(['memory_write', 'shared_skill_checkpoint']).optional(),
  authorLabel: z.string().optional(),
  toolUseId: z.string().optional(),
});

export const memoryChannels = {
  'memoryUpdate:applyStatusToSession': defineInvokeChannel({
    channel: 'memoryUpdate:applyStatusToSession',
    request: z.object({
      sessionId: z.string(),
      turnId: z.string(),
      status: MemoryUpdateStatusSchema,
    }),
    response: z.object({
      ok: z.boolean(),
      error: z.string().optional(),
      context: z.record(z.string(), z.unknown()).optional(),
    }),
    description: 'Apply a memory update status to a specific session via main-process atomic RMW',
  }),

  'timeSaved:applyTimeSavedStatusToSession': defineInvokeChannel({
    channel: 'timeSaved:applyTimeSavedStatusToSession',
    request: z.object({
      sessionId: z.string(),
      turnId: z.string(),
      status: TimeSavedStatusSchema,
    }),
    response: z.object({
      ok: z.boolean(),
      error: z.string().optional(),
      context: z.record(z.string(), z.unknown()).optional(),
    }),
    description: 'Apply a time saved status to a specific session via main-process atomic RMW',
  }),

  'memory:get-history': defineInvokeChannel({
    channel: 'memory:get-history',
    request: z.object({
      space: z.string().optional(),
      limit: z.number().default(100),
      beforeTimestamp: z.number().optional(),
    }),
    response: z.object({
      entries: z.array(MemoryHistoryEntrySchema),
      hasMore: z.boolean(),
    }),
    description: 'Get memory history entries with optional filtering',
  }),

  'memory:get-stats': defineInvokeChannel({
    channel: 'memory:get-stats',
    request: z.object({}),
    response: z.object({
      bySpace: z.array(MemorySpaceStatsSchema),
      total: z.number(),
    }),
    description: 'Get aggregate memory stats by space',
  }),

  'memory:get-history-count': defineInvokeChannel({
    channel: 'memory:get-history-count',
    request: z.object({}),
    response: z.object({
      count: z.number(),
    }),
    description:
      'Lightweight memory history entry count (avoids the workspace scan that memory:get-stats performs).',
  }),

  'memory:forget-entry': defineInvokeChannel({
    channel: 'memory:forget-entry',
    request: z.object({
      entryId: z.string(),
    }),
    response: z.object({
      success: z.boolean(),
      error: z.string().optional(),
    }),
    description: 'Forget a specific memory entry (launches background agent)',
  }),

  'memory:get-entry': defineInvokeChannel({
    channel: 'memory:get-entry',
    request: z.object({
      entryId: z.string(),
    }),
    response: z.object({
      entry: MemoryHistoryEntrySchema.nullable(),
    }),
    description: 'Get a single memory history entry by ID',
  }),

  'memory:repair-entry-path': defineInvokeChannel({
    channel: 'memory:repair-entry-path',
    request: z.object({
      entryId: z.string(),
      repairedFilePath: z.string().min(1),
    }),
    response: z.object({
      success: z.boolean(),
    }),
    description: 'Repair a memory history entry filePath after renderer-side path resolution fallback',
  }),

  'memory:get-pending-approvals': defineInvokeChannel({
    channel: 'memory:get-pending-approvals',
    request: z.object({}),
    response: z.array(
      z.object({
        toolUseId: z.string(),
        originalTurnId: z.string(),
        originalSessionId: z.string(),
        turnId: z.string(),
        sessionId: z.string(),
        filePath: z.string(),
        spaceName: z.string(),
        summary: z.string(),
        content: z.string(),
        timestamp: z.number(),
        // Rich fields for UI consistency after restart (optional for backwards compatibility)
        sensitivityReason: z.string().optional(),
        hasSpaceOverride: z.boolean().optional(),
        privateMode: z.boolean().optional(),
        blockedBy: BlockSourceSchema.optional(),
        spacePath: z.string().optional(),
        location: FileLocationSchema.optional(),
        sharing: z.enum(['private', 'restricted', 'company-wide', 'public']).optional(),
        contentPreview: z.string().optional(),
        approvalIdentifier: z.string().optional(),
        approvalKind: z.enum(['memory_write', 'shared_skill_checkpoint']).optional(),
        authorLabel: z.string().optional(),
        staged: z.boolean().optional(),
      })
    ),
    description: 'Get pending memory approval requests (persisted across app restarts)',
  }),

  'memory:staging-get-all': defineInvokeChannel({
    channel: 'memory:staging-get-all',
    request: z.void(),
    response: z.object({
      files: z.array(StagedMemoryFileSchema),
    }),
    description: 'Get all staged memory files awaiting user review',
  }),

  'memory:write-approval-response': defineInvokeChannel({
    channel: 'memory:write-approval-response',
    request: z.object({
      toolUseId: z.string(),
      approved: z.boolean(),
    }),
    response: z.object({
      success: z.boolean(),
      sessionId: z.string().optional(),
      filePath: z.string().optional(),
      spaceName: z.string().optional(),
      content: z.string().optional(),
      error: z.string().optional(),
    }),
    description: 'User response to memory write approval request (Phase 2)',
  }),

  // =========================================================================
  // Staged Writes (CoS Pending) Channels
  // =========================================================================

  'memory:staging-get-content': defineInvokeChannel({
    channel: 'memory:staging-get-content',
    request: z.object({
      id: z.string(),
    }),
    response: z.object({
      content: z.string().nullable(),
      error: z.string().optional(),
    }),
    description: 'Get staged file body content for diff view',
  }),

  'memory:staging-publish': defineInvokeChannel({
    channel: 'memory:staging-publish',
    request: z.object({
      id: z.string(),
      // Stage C (260417_approval_consolidation_closeout): optional
      // client-supplied UUID. When present, the server caches the first
      // response for 30 seconds and replays it for any retry carrying
      // the same key — defense-in-depth for `fetchWithRetry` double-fires
      // whose first attempt mutated state but whose response was lost.
      clientDedupKey: z.string().uuid().optional(),
    }),
    response: z.object({
      status: StagingStatusSchema,
      error: z.string().optional(),
      conflict: NormalizedConflictSchema.optional(),
    }),
    description: 'Approve and publish a single staged file to its destination',
  }),

  'memory:staging-discard': defineInvokeChannel({
    channel: 'memory:staging-discard',
    request: z.object({
      id: z.string(),
      // Stage C: see memory:staging-publish.clientDedupKey.
      clientDedupKey: z.string().uuid().optional(),
    }),
    response: z.object({
      status: StagingStatusSchema,
      error: z.string().optional(),
    }),
    description: 'Discard a single staged file',
  }),

  'memory:staging-keep-private': defineInvokeChannel({
    channel: 'memory:staging-keep-private',
    request: z.object({
      id: z.string(),
      // Stage C: see memory:staging-publish.clientDedupKey.
      clientDedupKey: z.string().uuid().optional(),
    }),
    response: z.object({
      status: StagingStatusSchema,
      error: z.string().optional(),
      destinationPath: z.string().optional(),
    }),
    description: 'Keep a staged file private (move to Chief-of-Staff memory/topics)',
  }),

  'memory:staging-publish-all': defineInvokeChannel({
    channel: 'memory:staging-publish-all',
    request: z.void(),
    response: z.object({
      published: z.array(z.string()),
      conflicts: z.array(z.string()),
      errors: z.array(z.string()),
    }),
    description: 'Approve and publish all staged files (batch operation)',
  }),

  'memory:staging-discard-all': defineInvokeChannel({
    channel: 'memory:staging-discard-all',
    request: z.void(),
    response: z.object({
      success: z.boolean(),
    }),
    description: 'Discard all staged files (batch operation)',
  }),

  'memory:staging-mint-conflict-capability': defineInvokeChannel({
    channel: 'memory:staging-mint-conflict-capability',
    request: z.object({
      stagedFileId: z.string().min(1).max(256),
    }),
    response: z.discriminatedUnion('success', [
      z.object({
        success: z.literal(true),
        token: z.string().min(1).max(2048),
        expiresAt: z.number().int().positive(),
      }),
      z.object({
        success: z.literal(false),
        /**
         * Error codes surfaced by the mint handler.
         *
         * - `UNKNOWN_STAGED_FILE`: the requested `stagedFileId` has no
         *   matching pending file on the server.
         * - `INVALID_INPUT`: the id failed late validation inside the
         *   service (e.g. RangeError from `mint()`). The Zod schema
         *   above already caps at 256 chars; this code is defense-in-depth.
         * - `SERVICE_UNAVAILABLE`: the `ConflictCapabilityService`
         *   dependency is not wired into the handler registry. Surfaced
         *   so fail-closed wiring bugs are observable rather than
         *   silently hanging the UI.
         * - `READ_ONLY`: RESERVED for a future product-level read-only
         *   state gate (e.g. cloud instance in maintenance). No handler
         *   path emits this code today; kept in the enum so mobile
         *   clients can branch once we introduce the state.
         */
        error: z.enum([
          'UNKNOWN_STAGED_FILE',
          'INVALID_INPUT',
          'SERVICE_UNAVAILABLE',
          'READ_ONLY',
        ]),
      }),
    ]),
    description:
      'Mint a short-lived, one-time-use capability token authorizing resolution of a specific staged-file conflict. The token is required by memory:staging-resolve-conflict.',
  }),

  'memory:staging-resolve-conflict': defineInvokeChannel({
    channel: 'memory:staging-resolve-conflict',
    request: z.object({
      id: z.string(),
      resolution: z.enum(['keep-staged', 'keep-real']),
      // Stage B: capability token is REQUIRED. A jailbroken agent that
      // calls this handler directly (bypassing the conversational seed
      // prompt) would not have minted a token, so the handler rejects
      // with `CAPABILITY_*` errors. No backward-compat — all call sites
      // must mint before resolving.
      capabilityToken: z.string().min(1).max(2048),
      // Stage C (260417_approval_consolidation_closeout): see
      // memory:staging-publish.clientDedupKey. Resolve is the most
      // important channel to dedup because the server-side mutation
      // (capability-token consume + file publish) is genuinely not
      // idempotent — a replayed resolve without dedup mapping lands
      // as CAPABILITY_REUSED, which the store treats as success but
      // wastes a full handler run before reaching that verdict.
      clientDedupKey: z.string().uuid().optional(),
    }),
    response: z.object({
      status: StagingStatusSchema,
      /**
       * Error string. When a capability-token check fails, the value is
       * exactly one of:
       *   - `CAPABILITY_MALFORMED` — missing/empty/unparseable token
       *   - `CAPABILITY_INVALID_SIGNATURE` — token signature mismatch
       *   - `CAPABILITY_EXPIRED` — token past its 5-minute TTL
       *   - `CAPABILITY_SCOPE_MISMATCH` — token was minted for a different stagedFileId
       *   - `CAPABILITY_REUSED` — token's nonce was already consumed (replay)
       *   - `CAPABILITY_UNAVAILABLE` — the ConflictCapabilityService is
       *     not wired into this handler instance (fail-closed)
       *
       * Clients can branch on these for typed recovery (e.g. re-mint on
       * `CAPABILITY_EXPIRED`, treat `CAPABILITY_REUSED` as idempotent
       * success — see `cloud-client/src/stores/stagedFilesStore.ts`).
       */
      error: z.string().optional(),
      conflict: NormalizedConflictSchema.optional(),
    }),
    description:
      'Resolve a staging conflict by choosing staged or real content. Requires a valid capability token from memory:staging-mint-conflict-capability (scoped to the same staged file id, one-time-use, 5-minute TTL).',
  }),

  'memory:staging-cleanup': defineInvokeChannel({
    channel: 'memory:staging-cleanup',
    request: z.void(),
    response: z.object({
      cleanedCount: z.number(),
    }),
    description: 'Cleanup endpoint (no-op for CoS pending; kept for API compatibility)',
  }),
};
