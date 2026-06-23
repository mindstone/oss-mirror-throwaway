import { z } from 'zod';
import { ConnectorContributionSchema } from '@shared/ipc/channels/contribution';

type SoftwareEngineerEvidenceInvalidatedReason = NonNullable<
  z.infer<typeof ConnectorContributionSchema>['lastSoftwareEngineerEvidenceInvalidatedReason']
>;

/**
 * Decision envelope returned by the bundled MCP bridge endpoint
 * `POST /contribution/report-state`.
 *
 * This is the **bridge-HTTP** contract between the desktop bundled inbox
 * bridge (`src/main/services/bundledInboxBridge.ts`) and the
 * `RebelMcpConnectors` MCP server wrapper
 * (`resources/mcp/rebel-mcp-connectors/server.cjs`). It is NOT an
 * IPC channel — keeping it in `src/shared/contribution/` (a sibling of
 * `src/shared/utils/contributionStateMapping.ts`) avoids polluting the
 * IPC channel registry.
 *
 * The wrapper renders the `decision` field into a deterministic text block
 * for the agent (`isError` is set per `kind`). The TypeScript-side schema
 * is the canonical cross-surface shape: future cloud or mobile proxies of
 * `/contribution/report-state` MUST honor this envelope.
 *
 * Stage 1.A of the foolproof contribution flow redesign — see
 * `docs/plans/260426_foolproof_contribution_flow_stage1.md`.
 *
 * NOTE: `reauth_required` and `reauth_github` are reserved for future
 * bridge endpoints (e.g. GitHub auth probe on report). No current code
 * path emits them; they are forward-compat placeholders for Stage 3+.
 */

export const DecisionKindSchema = z.enum([
  'created',
  'updated',
  'noop',
  'deferred',
  'rejected',
]);
export type DecisionKind = z.infer<typeof DecisionKindSchema>;

export const DecisionReasonSchema = z.enum([
  'missing_evidence',
  'non_canonical_path',
  'invalid_transition',
  'reauth_required',
  // Stage 3.E: cloud/mobile fail-closed contract. The bridge runs on a
  // surface without filesystem access AND the agent did not supply a
  // build manifest fingerprint via `agentAssertedFingerprint`. The
  // observation reducer (`contributionObservationService.ts`) emits
  // `deferralReason: 'fingerprint_unavailable'` and the bridge maps it
  // to `Decision.reason: 'fingerprint_unavailable', nextAction: 'run_build'`.
  // Per Stage 3 plan § "Hidden gotchas → G11".
  'fingerprint_unavailable',
]);
export type DecisionReason = z.infer<typeof DecisionReasonSchema>;

export const DecisionNextActionSchema = z.enum([
  'run_tests',
  'register_server',
  'move_to_canonical_path',
  'reauth_github',
  'wait_for_review',
  'run_software_engineer_workflow',
  // Stage 3.E: paired with Decision.reason: 'fingerprint_unavailable'.
  // The agent must run the build (npm run build / tsc) so a fresh
  // fingerprint is observable, OR supply `agentAssertedFingerprint` on
  // the next ready_requested observation.
  'run_build',
]);
export type DecisionNextAction = z.infer<typeof DecisionNextActionSchema>;

/**
 * Discriminated union: success (`created` / `updated` / `noop`) or
 * non-success (`deferred` / `rejected`) — the latter always carries
 * `reason`, `nextAction`, and `guidance` so the agent can self-correct.
 */
export const DecisionSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('created'),
    build: ConnectorContributionSchema,
  }),
  z.object({
    kind: z.literal('updated'),
    build: ConnectorContributionSchema,
  }),
  z.object({
    kind: z.literal('noop'),
    build: ConnectorContributionSchema,
  }),
  z.object({
    kind: z.literal('deferred'),
    build: ConnectorContributionSchema.optional(),
    reason: DecisionReasonSchema,
    nextAction: DecisionNextActionSchema,
    /**
     * Machine-oriented guidance for the agent — may include path strings,
     * tool names, and status names. The agent should NEVER show this
     * verbatim to the user; instead translate it via `chatSafeGuidance`
     * (or the SKILL.md § Voice Firewall translation table).
     */
    guidance: z.string().min(1),
    /**
     * Plain-English version of `guidance` safe to show non-technical
     * users. Optional for backwards compat: when absent, the renderer
     * falls back to a generic "we hit a snag" sentence rather than
     * showing the raw guidance. Voice doc:
     * docs/project/CONNECTOR_CONTRIBUTION_VOICE.md.
     */
    chatSafeGuidance: z.string().min(1).optional(),
  }),
  z.object({
    kind: z.literal('rejected'),
    build: ConnectorContributionSchema.optional(),
    reason: DecisionReasonSchema,
    nextAction: DecisionNextActionSchema,
    /** See `deferred.guidance` — internal/agent-only. */
    guidance: z.string().min(1),
    /** See `deferred.chatSafeGuidance` — user-safe paraphrase. */
    chatSafeGuidance: z.string().min(1).optional(),
  }),
]);
export type Decision = z.infer<typeof DecisionSchema>;

/**
 * Full bridge response body for `/contribution/report-state`.
 *
 * The `decision` field is required on every non-malformed-input response
 * (Stage 1.A of the foolproof contribution flow); it is `undefined` only on
 * HTTP 400 (input validation) / 404 (not found) / 500 (fallback) responses.
 *
 * Legacy fields are preserved for one release window per Decision 4 of the
 * Stage 1 plan; their write sites carry `// TODO(stage-3)` comments.
 */
export const DecisionEnvelopeBodySchema = z
  .object({
    success: z.boolean(),
    contributionId: z.string().optional(),
    status: z.string().optional(),
    created: z.boolean().optional(),
    decision: DecisionSchema.optional(),
    // Legacy compat fields retained for one-release transition window —
    // see Stage 1.A of `docs/plans/260426_foolproof_contribution_flow.md`:
    promotionDecision: z.string().nullable().optional(),
    promotionReason: z.string().nullable().optional(),
    missingSignals: z.array(z.string()).optional(),
    guidance: z.string().optional(),
    error: z.string().optional(),
    currentStatus: z.string().optional(),
    attemptedStatus: z.string().optional(),
  })
  .passthrough();
export type DecisionEnvelopeBody = z.infer<typeof DecisionEnvelopeBodySchema>;

/** Stable singleton guidance copy — matches the existing bridge wording. */
const NON_CANONICAL_GUIDANCE_SHORT =
  'Move the connector into ~/mcp-servers/<api-name>-mcp/, re-register it with rebel_mcp_add_server, then report ready_to_submit again.';

const MISSING_EVIDENCE_GUIDANCE =
  'Run tests (Bash) or register the server via rebel_mcp_add_server before reporting ready_to_submit. The next evidence signal will promote this contribution automatically.';

const FINGERPRINT_UNAVAILABLE_GUIDANCE =
  'A build fingerprint is required to confirm the agent tested the current build. Run `npm run build` (or `tsc`) so the connector\'s package.json mtime updates, then report ready_to_submit again.';

const SOFTWARE_ENGINEER_RECOVERY_CHAT_SAFE_GUIDANCE =
  'Let me think this through properly before I share it.';

const SOFTWARE_ENGINEER_RECOVERY_INTERNAL_VARIANT_A =
  'You reported ready_to_submit on a non-trivial connector without invoking the Software Engineer workflow. Read rebel-system/skills/workflows/software-engineer/SKILL.md, then re-run the build phases as the SE planner/implementer/reviewer. Re-call rebel_mcp_report_contribution_state(status: "ready_to_submit", ...) once docs/build-plan.md reflects the SE working-doc template (workflow: software-engineer, models.*, ## Review History).';

const SOFTWARE_ENGINEER_RECOVERY_INTERNAL_VARIANT_B =
  'You ran the Software Engineer workflow earlier, but the connector code has changed since. The SE evidence on this contribution was invalidated and must be refreshed against the current build state. Re-invoke the Software Engineer workflow against the current connector path. The SE working doc at docs/build-plan.md should be updated (or re-created) to reflect the changed code. Re-call rebel_mcp_report_contribution_state(status: "ready_to_submit", ...) once SE has run on the new build state.';

/* ────────────────────────────────────────────────────────────────────
 * Factory helpers
 * Used by the bridge endpoint to construct a typed `Decision` without
 * repeating the discriminator + field assembly at every call site.
 * ──────────────────────────────────────────────────────────────────── */

type SuccessKind = 'created' | 'updated' | 'noop';

export function buildSuccessDecision(
  kind: SuccessKind,
  build: z.infer<typeof ConnectorContributionSchema>,
): Decision {
  return { kind, build };
}

export function buildDeferredDecision(args: {
  build?: z.infer<typeof ConnectorContributionSchema>;
  reason: DecisionReason;
  nextAction: DecisionNextAction;
  guidance: string;
  chatSafeGuidance?: string;
}): Decision {
  return {
    kind: 'deferred',
    ...(args.build ? { build: args.build } : {}),
    reason: args.reason,
    nextAction: args.nextAction,
    guidance: args.guidance,
    ...(args.chatSafeGuidance ? { chatSafeGuidance: args.chatSafeGuidance } : { chatSafeGuidance: deriveChatSafeGuidance(args.nextAction) }),
  };
}

export function buildRejectedDecision(args: {
  build?: z.infer<typeof ConnectorContributionSchema>;
  reason: DecisionReason;
  nextAction: DecisionNextAction;
  guidance: string;
  chatSafeGuidance?: string;
}): Decision {
  return {
    kind: 'rejected',
    ...(args.build ? { build: args.build } : {}),
    reason: args.reason,
    nextAction: args.nextAction,
    guidance: args.guidance,
    ...(args.chatSafeGuidance ? { chatSafeGuidance: args.chatSafeGuidance } : { chatSafeGuidance: deriveChatSafeGuidance(args.nextAction) }),
  };
}

/**
 * Default chat-safe paraphrase per `nextAction` code. Mirrors the
 * translation table in `build-custom-mcp-server/SKILL.md § Voice Firewall`.
 * Callers may override by passing `chatSafeGuidance` explicitly when the
 * default isn't a good fit for the situation.
 */
export function deriveChatSafeGuidance(nextAction: DecisionNextAction): string {
  switch (nextAction) {
    case 'run_tests':
      return 'I need to try it properly before sharing.';
    case 'register_server':
      return 'I need to connect it to Rebel first.';
    case 'move_to_canonical_path':
      return 'I need to move the files into the right folder before sharing.';
    case 'reauth_github':
      return 'Please reconnect GitHub in Settings → Connectors so we can send it out.';
    case 'wait_for_review':
      return 'A reviewer will take a look soon.';
    case 'run_software_engineer_workflow':
      return SOFTWARE_ENGINEER_RECOVERY_CHAT_SAFE_GUIDANCE;
    case 'run_build':
      return 'I need to put the pieces together one more time before sharing.';
  }
}

export function deriveSoftwareEngineerRecoveryGuidance(args: {
  invalidationReason?: SoftwareEngineerEvidenceInvalidatedReason;
}): { chatSafe: string; internal: string } {
  const reason: SoftwareEngineerEvidenceInvalidatedReason | 'absent' =
    args.invalidationReason ?? 'absent';
  switch (reason) {
    case 'fingerprint_mismatch':
      return {
        chatSafe: SOFTWARE_ENGINEER_RECOVERY_CHAT_SAFE_GUIDANCE,
        internal: SOFTWARE_ENGINEER_RECOVERY_INTERNAL_VARIANT_B,
      };
    case 'absent':
      return {
        chatSafe: SOFTWARE_ENGINEER_RECOVERY_CHAT_SAFE_GUIDANCE,
        internal: SOFTWARE_ENGINEER_RECOVERY_INTERNAL_VARIANT_A,
      };
    default: {
      const _exhaustive: never = reason;
      return _exhaustive;
    }
  }
}

/** Re-exported guidance constants for use by the bridge endpoint. */
export const GUIDANCE_PRESETS = {
  missingEvidence: MISSING_EVIDENCE_GUIDANCE,
  nonCanonicalPathShort: NON_CANONICAL_GUIDANCE_SHORT,
  fingerprintUnavailable: FINGERPRINT_UNAVAILABLE_GUIDANCE,
} as const;
