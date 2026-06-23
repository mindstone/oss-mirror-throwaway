import { z } from 'zod';
import { defineInvokeChannel } from '../schemas';

/**
 * Contribution IPC Channels
 *
 * Full IPC surface for connector contribution flow:
 * - Submission: submit, refresh-status
 * - Store reads: list, get-by-session
 * - Store writes: update-local-state, dismiss
 *
 * @see src/core/services/contributionStore.ts
 * @see docs/plans/260410_oss_mcp_integration_forward_plan.md (P4.5)
 */

// ─── Shared Schemas ─────────────────────────────────────────────────

const ContributionStatusSchema = z.enum([
  'draft',
  'testing',
  'ready_to_submit',
  'submitted',
  'ci_pass',
  'ci_fail',
  'changes_requested',
  'approved',
  'rejected',
  'published',
]);

const AcknowledgmentSurfaceSchema = z.enum(['banner', 'drawer']);

const AcknowledgedEventSchema = z.object({
  status: ContributionStatusSchema,
  surface: AcknowledgmentSurfaceSchema,
  at: z.string(),
});

const AttributionModeSchema = z.enum(['github', 'rebel-name', 'anonymous']);
const SoftwareEngineerEvidenceInvalidatedReasonSchema = z.enum(['fingerprint_mismatch']);
const ContributionTurnIndexWindowSchema = z.object({
  sessionId: z.string(),
  startTurn: z.number().int(),
  endTurn: z.number().int().nullable(),
});

/**
 * Stage 2 (260428): shared observation payload schema. The observation pipeline
 * remains desktop-only today, but the schema is shared so cloud/mobile can
 * consume the same discriminated union once the contribution flow is mirrored.
 */
export const ContributionObservationSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('build_detected'),
    sessionId: z.string(),
    localServerPath: z.string(),
    connectorName: z.string(),
    source: z.enum(['post-tool-bash', 'post-turn-sweep', 'startup-sweep']),
  }),
  z.object({
    kind: z.literal('test_passed'),
    sessionId: z.string(),
    localServerPath: z.string(),
    source: z.enum(['post-tool-bash', 'post-tool-use-tool']),
  }),
  z.object({
    kind: z.literal('server_registered'),
    sessionId: z.string(),
    localServerPath: z.string(),
    connectorName: z.string(),
    source: z.enum(['post-tool-add-server', 'post-turn-sweep', 'startup-sweep']),
  }),
  z.object({
    kind: z.literal('ready_requested'),
    sessionId: z.string(),
    localServerPath: z.string(),
    connectorName: z.string(),
    source: z.literal('bridge-report-state'),
    agentAssertedFingerprint: z.string().optional(),
  }),
  z.object({
    kind: z.literal('software_engineer_task_completed'),
    sessionId: z.string(),
    contributionId: z.string(),
    taskSubagentTypes: z.array(z.string()),
    observedAt: z.object({
      sessionId: z.string(),
      turnIndex: z.number().int(),
    }),
    source: z.literal('post-turn-sweep'),
  }),
]);

// Stage 2 (260426): canonicalConnectorPath and linkedSessionIds are added
// to the schema for desktop renderer ↔ main consumption only. Cloud and
// mobile surfaces do not currently subscribe to contribution channels;
// when they do (Stage 3+), they should treat both fields as read-only and
// route writes through the desktop's path-keyed identity model.
// See docs/plans/260426_foolproof_contribution_flow_stage2.md (Decision 6).
const ConnectorContributionSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  /**
   * Stage 2 (260426): all sessions linked to this contribution. The
   * originating session is at `[0]`. Cross-surface (cloud, mobile)
   * consumers are read-only — writes only happen in core. Schema is
   * permissive (no `.min(1)`); the `length >= 1` invariant is enforced
   * at the runtime layer, not at the wire boundary.
   */
  linkedSessionIds: z.array(z.string()),
  /**
   * @deprecated since Stage 2 (260426); use `linkedSessionIds`. Kept as a
   * derived view of `linkedSessionIds.slice(1)` for one release transition
   * window so renderer/Settings consumers keep working unchanged.
   */
  followUpSessionIds: z.array(z.string()).optional(),
  connectorName: z.string(),
  localServerPath: z.string().optional(),
  /**
   * Stage 2 (260426): canonical key for connector identity, derived via
   * `canonicalizeConnectorPath`. Optional — pathless drafts remain
   * session-keyed only.
   */
  canonicalConnectorPath: z.string().optional(),
  catalogEntryId: z.string().optional(),
  attributionMode: AttributionModeSchema,
  attributionName: z.string().optional(),
  summary: z.string().optional(),
  motivation: z.string().optional(),
  reviewerNotes: z.string().optional(),
  prTitle: z.string().optional(),
  prBody: z.string().optional(),
  prUrl: z.string().optional(),
  /**
   * Set when the contribution was submitted via the Mindstone relay
   * (non-GitHub attribution). Undefined for direct GitHub submissions.
   * Added in CONTRIBUTION_STORE_VERSION v2 (260420).
   */
  relayContributionId: z.string().optional(),
  workflowRunUrl: z.string().optional(),
  status: ContributionStatusSchema,
  reviewNotes: z.string().optional(),
  publishedCatalogId: z.string().optional(),
  acknowledgedEvents: z.array(AcknowledgedEventSchema),
  lastCheckedAt: z.string().optional(),
  // Stage 3: most-recent rejected transition error, populated by the core store
  // and cleared on next valid transition. Optional so records predating Stage 3
  // still round-trip through this schema.
  lastTransitionError: z.string().optional(),
  // ── Stage 3 (260426) durable readiness fields ────────────────────
  // Five fields populated by the `contributionObservationService`
  // reducer (Stage 3.D) — they replaced the volatile in-memory
  // promotion-signal registry that Stage 3.F deleted. All five are
  // derived/written by core only and are NOT exposed on the
  // `update-local-state` IPC channel (same convention as
  // `lastTransitionError`, `canonicalConnectorPath`, `linkedSessionIds`).
  // Adding any of them as a writeable update surface would defeat the
  // durable-readiness invariant.
  //
  // Cloud/mobile parity: per AGENTS.md `CROSS_SURFACE_PARITY_CHECKLIST`,
  // these fields are read-only on cloud/mobile until the observation
  // pipeline lands cross-surface. Stage 3 keeps the pipeline desktop-only;
  // the schema admits the fields here so cross-surface payloads
  // round-trip unchanged once the pipeline migrates (Stage 6+).
  //
  // See docs/plans/260426_foolproof_contribution_flow_stage3.md § 3.A.
  lastBuildDetectedAt: z.string().optional(),
  lastTestPassedAt: z.string().optional(),
  lastRegisteredAt: z.string().optional(),
  lastReadyRequestedAt: z.string().optional(),
  lastBuildFingerprint: z.string().optional(),
  turnIndexWindow: ContributionTurnIndexWindowSchema.optional(),
  lastSoftwareEngineerTaskCompletedAt: z.string().optional(),
  lastSoftwareEngineerEvidenceInvalidatedAt: z.string().optional(),
  lastSoftwareEngineerEvidenceInvalidatedReason: SoftwareEngineerEvidenceInvalidatedReasonSchema.optional(),
  // Self-block follow-on (260427) — sub-stage C. Idempotency flag set by
  // the post-turn sweep when the agent built+tested but never registered;
  // read by the next-turn system-reminder injection. Optional; absence
  // means the nudge has not fired for this record.
  // See docs/plans/260427_contribution_flow_followon_self_block_at_registration.md § C
  stuckRegistrationNudgeFiredAt: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

// ─── Re-export schemas for test access ──────────────────────────────

export {
  ContributionStatusSchema,
  AcknowledgmentSurfaceSchema,
  ConnectorContributionSchema,
};

// ─── Channel Definitions ────────────────────────────────────────────

export const contributionChannels = {
  // ── Submission channels ─────────────────────────────────────────

  'contribution:submit': defineInvokeChannel({
    channel: 'contribution:submit',
    request: z.object({
      contributionId: z.string().min(1),
    }).strict(),
    response: z.object({
      success: z.boolean(),
      prUrl: z.string().optional(),
      prNumber: z.number().optional(),
      error: z.string().optional(),
      reAuthRequired: z.boolean().optional(),
    }),
    description:
      'DEPRECATED — use `contribution:submit-unified` instead. Thin adapter that now accepts only `{ contributionId }` and routes through the unified dispatcher. TODO(260420 Stage 2 follow-up): remove once all renderer callers have migrated to submitUnified.',
  }),

  'contribution:submit-from-store': defineInvokeChannel({
    channel: 'contribution:submit-from-store',
    request: z.object({
      contributionId: z.string().min(1),
    }),
    response: z.object({
      success: z.boolean(),
      prUrl: z.string().optional(),
      prNumber: z.number().optional(),
      error: z.string().optional(),
      reAuthRequired: z.boolean().optional(),
    }),
    description:
      'DEPRECATED — use `contribution:submit-unified` instead. Thin adapter: routes through the unified dispatcher, preserved for backward compatibility during Stage 2 rollout. TODO(260420 Stage 2 follow-up): remove once all renderer callers have migrated to submitUnified.',
  }),

  // ── Unified submit (preferred) ─────────────────────────────────
  //
  // Stage 2 of the OSS MCP backend relay plan (260420): single entry
  // point that branches on `attributionMode` in the dispatcher. Replaces
  // the legacy `contribution:submit` and `contribution:submit-from-store`
  // channels, which remain as thin adapters for one release cycle.
  'contribution:submit-unified': defineInvokeChannel({
    channel: 'contribution:submit-unified',
    request: z.object({
      contributionId: z.string().min(1),
      /**
       * Stage 3 (260427 follow-on): desired attribution for this specific
       * submit attempt. Dispatcher resolves
       * `desiredAttributionMode ?? contribution.attributionMode` so legacy
       * callers that omit these fields preserve store-read behaviour.
       */
      desiredAttributionMode: AttributionModeSchema.optional(),
      desiredAttributionName: z.string().nullable().optional(),
    }),
    response: z.discriminatedUnion('success', [
      z.object({
        success: z.literal(true),
        prUrl: z.string(),
        prNumber: z.number(),
        duplicate: z.boolean().optional(),
        degraded: z.enum(['persistence-failed', 'record-deleted']).optional(),
        skippedDenylisted: z.array(z.string()).optional(),
      }),
      z.object({
        success: z.literal(false),
        error: z.object({
          code: z.string(),
          message: z.string(),
        }),
        /** Set only when the GitHub path needs re-authorisation. */
        reAuthRequired: z.boolean().optional(),
      }),
    ]),
    description:
      'Submit a connector contribution. GitHub submission is disabled in this build; rebel-name/anonymous use the optional private relay extension when registered.',
  }),

  'contribution:refresh-status': defineInvokeChannel({
    channel: 'contribution:refresh-status',
    request: z.object({
      contributionId: z.string().min(1),
      force: z.boolean().optional(),
    }),
    response: z.object({
      success: z.boolean(),
      contribution: ConnectorContributionSchema.nullable().optional(),
      error: z.string().optional(),
      message: z.string().optional(),
      /**
       * Set to `true` when the GitHub path requires user re-authorisation
       * (access token expired + no usable refresh_token, OR stored token is
       * a pre-refresh-rotation legacy record). The renderer surfaces this
       * as a "Reconnect GitHub" action on the refresh-failure toast.
       * Mirrors the same flag on `contribution:submit-unified` failures.
       */
      reAuthRequired: z.boolean().optional(),
    }),
    description: 'Refresh contribution status from GitHub PR API',
  }),

  // ── Store read channels ─────────────────────────────────────────

  'contribution:list': defineInvokeChannel({
    channel: 'contribution:list',
    request: z.object({}),
    response: z.object({
      contributions: z.array(ConnectorContributionSchema),
      /**
       * REBEL-1HF: surfaced when the store is in its post-EMFILE "awaiting
       * hydration" state. The handler always returns success-shaped data
       * (cached or empty) on EMFILE so this flag is the only way the
       * renderer can detect FD exhaustion and ratchet up its polling
       * backoff. Optional + additive: omitted in the normal case so
       * pre-existing tests that strict-equality-check the response shape
       * keep passing.
       */
      fdExhausted: z.boolean().optional(),
    }),
    description: 'List all connector contributions',
  }),

  'contribution:get-by-session': defineInvokeChannel({
    channel: 'contribution:get-by-session',
    request: z.object({
      sessionId: z.string().min(1),
    }),
    response: z.object({
      contribution: ConnectorContributionSchema.nullable(),
      /**
       * Stage 4 telemetry (260426 foolproof contribution flow). Number of
       * contributions whose `linkedSessionIds` includes the requested
       * `sessionId` — i.e., the result of `getContributionsBySession`.
       * Used by the renderer hook to fire a `console.warn` once per growth
       * transition when a session has multiple builds (matrix #25). Optional
       * + additive: callers compiled against pre-Stage-4 schemas read
       * `undefined` and never warn. The handler returns `0` on the catch
       * path so the renderer can't crash on a partial response.
       *
       * @see docs/plans/260426_foolproof_contribution_flow_stage4.md
       */
      linkedContributionsCount: z.number().int().nonnegative().optional(),
      /**
       * Footer-question suppression follow-on (260427). Connector names of
       * EVERY contribution whose `linkedSessionIds` includes the requested
       * `sessionId`, regardless of status. The renderer uses this to
       * suppress the `suggest_connector_setup` footer card once a build
       * has been started for the same connector — closes the visual
       * inconsistency where the "Want Rebel to build the X connector for
       * you?" card persists alongside an active build during planning and
       * early-build phases. Optional + additive (pre-Stage-4 callers and
       * older renderers ignore it). The handler returns `[]` on the catch
       * path so the renderer can't crash on a partial response.
       *
       * @see docs/plans/260427_contribution_flow_followon_self_block_at_registration.md
       */
      linkedContributionConnectorNames: z.array(z.string()).optional(),
      /**
       * REBEL-1HF: surfaced when the store is in its post-EMFILE "awaiting
       * hydration" state. The handler always returns success-shaped data
       * (cached or null) on EMFILE so this flag is the only way the
       * renderer can detect FD exhaustion and ratchet up its polling
       * backoff. Optional + additive: omitted in the normal case so
       * pre-existing tests that strict-equality-check the response shape
       * keep passing.
       */
      fdExhausted: z.boolean().optional(),
    }),
    description: 'Get the contribution record associated with a session',
  }),

  // ── Store write channels ────────────────────────────────────────

  'contribution:update-local-state': defineInvokeChannel({
    channel: 'contribution:update-local-state',
    request: z.object({
      contributionId: z.string().min(1),
      updates: z.object({
        localServerPath: z.string().optional(),
        connectorName: z.string().optional(),
        attributionMode: AttributionModeSchema.optional(),
        // Accept `null` to explicitly clear a previously-stored attribution
        // name (e.g. user picks Rebel name → writes "Alex", then retries as
        // anonymous → clears the field). See Stage 1.1 C2 fix for
        // `docs/plans/260420_oss_mcp_backend_relay.md`. The store unsets
        // the field on `null`; `undefined` leaves the existing value alone.
        attributionName: z.string().nullable().optional(),
        summary: z.string().optional(),
        motivation: z.string().optional(),
        reviewerNotes: z.string().optional(),
        prTitle: z.string().optional(),
        prBody: z.string().optional(),
        status: ContributionStatusSchema.optional(),
        // Note: `lastTransitionError` is deliberately NOT exposed here. It is
        // populated/cleared by `updateContribution()` in core as a side-effect
        // of state-machine transitions, not by external callers. If a future
        // stage needs a renderer-driven "dismiss error" flow, add it via a
        // dedicated channel (e.g. `contribution:dismiss-transition-error`)
        // rather than widening this generic update surface. See Stage 3 of
        // `docs/plans/260416_agent_reported_state_hardening.md`.
        //
        // Stage 2 (260426): `canonicalConnectorPath` and `linkedSessionIds`
        // follow the same convention — derived/written by core only (the
        // store's `createContribution` derives `canonicalConnectorPath`;
        // `addLinkedSession` mutates `linkedSessionIds`). Adding either as
        // a writeable update surface would defeat the path-keyed identity
        // invariant. See docs/plans/260426_foolproof_contribution_flow_stage2.md.
      }),
    }),
    response: z.object({
      success: z.boolean(),
      contribution: ConnectorContributionSchema.nullable().optional(),
      error: z.string().optional(),
    }),
    description: 'Update local contribution state (non-GitHub fields)',
  }),

  'contribution:dismiss': defineInvokeChannel({
    channel: 'contribution:dismiss',
    request: z.object({
      contributionId: z.string().min(1),
      status: ContributionStatusSchema,
      surface: AcknowledgmentSurfaceSchema,
    }),
    response: z.object({
      success: z.boolean(),
      error: z.string().optional(),
    }),
    description: 'Dismiss a contribution notification on a specific UI surface',
  }),

  // ── Operator-initiated delete (Stage 5 stuck-contribution affordance) ─
  // Used by the Settings "Stuck contributions" recovery UI to discard
  // records that never promoted via normal paths. Not routed to cloud —
  // this is a desktop-only operator action. Files on disk are untouched.
  'contribution:delete': defineInvokeChannel({
    channel: 'contribution:delete',
    request: z.object({
      contributionId: z.string().min(1),
    }),
    response: z.object({
      success: z.boolean(),
      deleted: z.boolean(),
      error: z.string().optional(),
    }),
    description: 'Permanently delete a contribution record (operator-initiated recovery from Settings stuck-contribution affordance)',
  }),

  // ── Follow-up session channels ──────────────────────────────────

  'contribution:create-follow-up-context': defineInvokeChannel({
    channel: 'contribution:create-follow-up-context',
    request: z.object({
      contributionId: z.string().min(1),
    }),
    response: z.object({
      context: z.object({
        prompt: z.string(),
        skillMention: z.string(),
        contributionId: z.string(),
        originalSessionId: z.string(),
        connectorName: z.string(),
      }).nullable(),
    }),
    description: 'Create follow-up session context for a changes_requested or ci_fail contribution',
  }),

  'contribution:link-follow-up-session': defineInvokeChannel({
    channel: 'contribution:link-follow-up-session',
    request: z.object({
      contributionId: z.string().min(1),
      followUpSessionId: z.string().min(1),
    }),
    response: z.object({
      success: z.boolean(),
      error: z.string().optional(),
    }),
    description: 'Link a follow-up session to a contribution record',
  }),
} as const;
