/**
 * Types for the ConnectorContribution store.
 *
 * Defines the contribution lifecycle from draft → published,
 * including per-surface notification dismissal tracking.
 *
 * @see docs/plans/260410_oss_mcp_integration_forward_plan.md (P2)
 */

/**
 * All 10 states of a connector contribution lifecycle.
 *
 * Valid state transitions:
 *   draft → testing
 *   testing → ready_to_submit
 *   ready_to_submit → submitted
 *   submitted → ci_pass | ci_fail
 *   ci_pass → approved | changes_requested | rejected
 *   ci_fail → changes_requested | testing (fix cycle)
 *   changes_requested → testing (fix cycle)
 *   approved → published
 */
export type ContributionStatus =
  | 'draft'
  | 'testing'
  | 'ready_to_submit'
  | 'submitted'
  | 'ci_pass'
  | 'ci_fail'
  | 'changes_requested'
  | 'approved'
  | 'rejected'
  | 'published';

/** All valid ContributionStatus values as a readonly array (useful for validation). */
export const ALL_CONTRIBUTION_STATUSES: readonly ContributionStatus[] = [
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
] as const;

/** UI surfaces that can independently dismiss/acknowledge contribution events. */
export type AcknowledgmentSurface = 'banner' | 'drawer';

/** Tracks per-surface dismissal of a specific status transition. */
export interface AcknowledgedEvent {
  /** Which status transition was acknowledged. */
  status: ContributionStatus;
  /** Which UI surface dismissed it. */
  surface: AcknowledgmentSurface;
  /** ISO timestamp when acknowledged. */
  at: string;
}

/** Attribution mode for the contribution. */
export type AttributionMode = 'github' | 'rebel-name' | 'anonymous';

/**
 * Stage 2 (260428 SE evidence sensor): contribution-attributed session turn window.
 *
 * Invariant (single-active-build): within a session, at most one contribution
 * has `endTurn === null` at any time.
 */
export interface ContributionTurnIndexWindow {
  /** Session that owns this window. */
  sessionId: string;
  /** Inclusive start turn index for this contribution window. */
  startTurn: number;
  /**
   * Inclusive end turn index. `null` means the window is currently open.
   * Empty windows (`endTurn < startTurn`) are valid and treated as
   * "no tasks in window" by detection helpers.
   */
  endTurn: number | null;
}

/** Stage 2 SE-evidence invalidation reason enum (future-proofed union). */
export type SoftwareEngineerEvidenceInvalidatedReason = 'fingerprint_mismatch';

/**
 * A single connector contribution record.
 */
export interface ConnectorContribution {
  /** Unique contribution identifier. */
  id: string;
  /** Original build conversation session ID. */
  sessionId: string;
  /**
   * All sessionIds this contribution has been touched by.
   *
   * Invariants (post-Stage-2):
   *   - `linkedSessionIds[0] === sessionId` (the originating session).
   *   - Subsequent entries appended in first-seen order (no duplicates).
   *   - `length >= 1` for every record post-migration v3 → v4.
   *
   * `followUpSessionIds` (existing) is a derived view of
   * `linkedSessionIds.slice(1)` for one release window; Stage 3 will remove
   * the redundant field once renderer/Settings consumers migrate.
   *
   * Stage 2 (260426): primary key for cross-session followup linking and the
   * multi-connector hijack fix (matrix #5). See
   * `docs/plans/260426_foolproof_contribution_flow_stage2.md`.
   */
  linkedSessionIds: string[];
  /**
   * Linked follow-up sessions (e.g., for changes-requested).
   *
   * @deprecated since Stage 2 (260426); use `linkedSessionIds` instead. Kept
   * as a derived view of `linkedSessionIds.slice(1)` for one release
   * transition window so renderer/Settings consumers (e.g. "Open
   * conversation" buttons) keep working unchanged.
   */
  followUpSessionIds?: string[];
  /** Name of the connector being contributed. */
  connectorName: string;
  /** Local path to the built connector server. */
  localServerPath?: string;
  /**
   * Canonical connector path key derived via `canonicalizeConnectorPath`.
   * Optional — pathless drafts (records without `localServerPath`) leave
   * this field unset and remain session-keyed only.
   *
   * Stage 2 (260426): primary key for `getContributionByPath` lookups and
   * the multi-connector hijack fix (matrix #5). Always derived; never
   * written by callers directly.
   */
  canonicalConnectorPath?: string;
  /** Catalog entry ID if submitted. */
  catalogEntryId?: string;
  /** How the contributor wants to be attributed. Default: 'anonymous'. */
  attributionMode: AttributionMode;
  /** Display name for attribution. */
  attributionName?: string;
  /** User-authored summary of the connector (~120 char soft cap, UI-enforced). */
  summary?: string;
  /** User's motivation / why this connector is useful (~500 char soft cap, UI-enforced). */
  motivation?: string;
  /** Reviewer notes / breaking-changes info (~500 char soft cap, UI-enforced). */
  reviewerNotes?: string;
  /** GitHub PR URL once submitted. */
  prUrl?: string;
  /**
   * Set when the contribution was submitted via the Mindstone relay
   * (non-GitHub attribution). Undefined for direct GitHub submissions.
   *
   * The relay mints a short-lived GitHub App installation token and opens
   * the PR on behalf of the user, so the desktop never holds a per-user
   * GitHub credential. The id is the opaque identifier returned by
   * `POST /api/contribution/v1/submit`; the desktop uses it on subsequent
   * `GET /api/contribution/v1/:id/status` polls.
   *
   * @see docs/contracts/contribution-relay-v1.md
   * @see src/shared/schemas/contributionRelay.ts
   */
  relayContributionId?: string;
  /** GitHub Actions workflow run URL. */
  workflowRunUrl?: string;
  /** Current lifecycle status. */
  status: ContributionStatus;
  /** Review notes from GitHub PR review. */
  reviewNotes?: string;
  /** Catalog ID once published. */
  publishedCatalogId?: string;
  /** Custom PR title for extension PRs (e.g. "feat(humaans): add diceroll_humaans_person tool"). */
  prTitle?: string;
  /** Custom PR body for extension PRs (Markdown). */
  prBody?: string;
  /** Per-surface event acknowledgment tracking. */
  acknowledgedEvents: AcknowledgedEvent[];
  /** ISO timestamp of last GitHub status check. */
  lastCheckedAt?: string;
  /**
   * Most-recent rejected transition error, as a human-readable message
   * (e.g. "Invalid transition: testing → draft. Current status is 'testing';
   * valid next states: ready_to_submit") OR a JSON-serialized
   * evidence-insufficient payload from the bridge evidence gate.
   * Populated by `updateContribution` when a transition is rejected, and by
   * the bridge when rejecting a premature `ready_to_submit`. Cleared
   * automatically on any successful status transition. Used by:
   *   - the agent's `rebel_mcp_report_contribution_state` response so the
   *     LLM can self-correct on the next turn
   *   - the UI: after Stage 3 (260420) the testing-phase card was removed
   *     (agent owns testing end-to-end), so the only user-facing surface
   *     for this field is the `testing-error` card, which renders it inline
   *     when tool-level failures are present.
   * Same-status no-op contract: callers that re-assert current status do
   * NOT clear this field. To clear explicitly while expressing "I'm still
   * at this status", pass `lastTransitionError: undefined` in the update
   * payload (breaks the same-status no-op predicate).
   */
  lastTransitionError?: string;
  /**
   * ISO timestamp when the `published` transactional email was confirmed by the
   * server (either freshly sent or an `already_sent` idempotent reply). Absence
   * means the client should attempt to fire the email on the next status
   * refresh. Back-filled to `updatedAt` for records that reached `published`
   * before this field existed, so we never retroactively re-send.
   */
  publishedEmailSentAt?: string;
  /**
   * Stage 3 (260426) — durable readiness timestamps. Replaced the volatile
   * in-memory promotion-signal registry that Stage 3.F deleted: each field
   * is populated by the `contributionObservationService` reducer (Stage
   * 3.D) when an observation fires for this canonical path. All five
   * fields are derived/written by core only — they are NOT exposed on the
   * `update-local-state` IPC channel (same convention as
   * `lastTransitionError`, `canonicalConnectorPath`, `linkedSessionIds`).
   *
   * Stage 3 promotion predicate (`ready_to_submit`):
   *   `lastReadyRequestedAt` is set
   *   AND (`lastTestPassedAt` is set OR `lastRegisteredAt` is set)
   *   AND `fingerprintMatches(observedFingerprint, lastBuildFingerprint)`
   *
   * Fingerprint mismatches (rebuild between test-pass and ready-requested)
   * clear `lastTestPassedAt` + `lastReadyRequestedAt` only — `lastBuild*`
   * and `lastRegisteredAt` are real-world facts, not stale agent
   * assertions.
   *
   * @see docs/plans/260426_foolproof_contribution_flow_stage3.md § 3.A
   */
  /**
   * ISO timestamp when a build-success Bash command (`npm run build`,
   * `tsc`, …) was observed for this canonical path. Populated by the
   * post-tool-bash, post-turn-sweep, and startup-sweep observation
   * sources. Real-world fact — not cleared on fingerprint mismatch.
   */
  lastBuildDetectedAt?: string;
  /**
   * ISO timestamp when a test-pass observation fired for this canonical
   * path. Populated by either a Bash test command (`npm test`, `vitest`,
   * …) OR an MCP `use_tool` invocation against a connector tool with
   * non-empty input. Cleared by the reducer when a fingerprint mismatch
   * indicates the test was against a different build.
   */
  lastTestPassedAt?: string;
  /**
   * ISO timestamp when `rebel_mcp_add_server` was observed for this
   * canonical path (PostToolUse) OR when the startup sweep found the
   * connector in MCP config. Real-world fact — not cleared on
   * fingerprint mismatch.
   */
  lastRegisteredAt?: string;
  /**
   * ISO timestamp when the agent called
   * `rebel_mcp_report_contribution_state(status: "ready_to_submit")`
   * for this canonical path. Supersedes the legacy in-memory agent
   * tool-call signal that Stage 3.F deleted. Cleared by the reducer
   * when a fingerprint mismatch indicates the assertion was against a
   * different build.
   */
  lastReadyRequestedAt?: string;
  /**
   * Latest SHA-256 hex hash of `mtime|size` of `<canonical>/package.json`,
   * recomputed on every observation. Mismatch between `observedFingerprint`
   * and this stored value invalidates `lastTestPassedAt` and
   * `lastReadyRequestedAt`. Computed by
   * `contributionObservationService::computeBuildFingerprint` (Stage 3.D),
   * which has the `fs` dependency core MUST NOT take directly.
   */
  lastBuildFingerprint?: string;
  /**
   * Stage 2 (260428): single active contribution window for this record's
   * current session attribution. Used by SE Task completion detection to
   * attribute completed Task events to one contribution in multi-build sessions.
   */
  turnIndexWindow?: ContributionTurnIndexWindow;
  /**
   * Stage 2 (260428): ISO timestamp of the latest observed successful
   * Software Engineer workflow Task completion attributed to this
   * contribution's turn window.
   */
  lastSoftwareEngineerTaskCompletedAt?: string;
  /**
   * Stage 2 (260428): ISO timestamp when SE evidence was invalidated due to
   * a build fingerprint mismatch. Cleared when SE completion is observed again.
   */
  lastSoftwareEngineerEvidenceInvalidatedAt?: string;
  /**
   * Stage 2 (260428): reason for the current SE-evidence invalidation marker.
   */
  lastSoftwareEngineerEvidenceInvalidatedReason?: SoftwareEngineerEvidenceInvalidatedReason;
  /**
   * Self-block follow-on (260427) — sub-stage C. ISO timestamp set by the
   * post-turn sweep when the predicate
   * `status ∈ {draft, testing} ∧ lastBuildDetectedAt ∧ lastTestPassedAt ∧
   * !lastRegisteredAt ∧ session-scoped` matches AND the flag is not yet
   * set, signalling that the agent built and tested the connector but
   * never called `rebel_mcp_add_server`. The next-turn system-reminder
   * injection reads this flag (together with `!lastRegisteredAt`) to
   * inject a one-line nudge into the agent's prompt. Idempotency: the
   * sweep predicate also checks `!stuckRegistrationNudgeFiredAt`, so the
   * nudge fires at most once per (contribution, session) tuple. Cleared
   * implicitly — once `lastRegisteredAt` becomes set, the reminder
   * predicate fails and the agent stops seeing it.
   *
   * @see docs/plans/260427_contribution_flow_followon_self_block_at_registration.md § C
   */
  stuckRegistrationNudgeFiredAt?: string;
  /** ISO timestamp when created. */
  createdAt: string;
  /** ISO timestamp when last updated. */
  updatedAt: string;
}

/**
 * Persistent store schema for connector contributions.
 */
export type ContributionStoreState = {
  /** Store schema version for migrations. */
  version: number;
  /** All contribution records. */
  contributions: ConnectorContribution[];
};

/**
 * Valid state transitions map.
 * Key is the current status, value is the set of statuses it can transition to.
 *
 * Note on `ready_to_submit → draft` and `draft → submitted`: these transitions
 * were originally intended to back a "Keep it private, then share later" flow
 * where keep-private would dispatch a status rollback. That UI flow was never
 * shipped — keep-private now uses a UI-only minimize-pill defer (see
 * `docs/plans/260428_keep_private_minimize_and_settings_share_button.md` and
 * `mcpBuildQuestionRouting.ts`). The `ready_to_submit → draft` and
 * `draft → submitted` entries are preserved in the state machine for backwards
 * compatibility with any pre-existing records, but no current UI path invokes
 * them. Recovery from keep-private is via pill restoration, contribution-state
 * flip (testing → ready_to_submit re-emerges the prompt), or the Settings →
 * Tools → "Share with everyone" button.
 *
 * `submitted` allows direct transitions to `approved`, `changes_requested`,
 * `rejected`, and `published` because GitHub status polling may skip intermediate
 * states (e.g., CI passes and approval happens between polls). Similarly, `ci_fail`
 * allows `ci_pass` for re-run CI scenarios.
 */
export const VALID_STATE_TRANSITIONS: Record<ContributionStatus, readonly ContributionStatus[]> = {
  draft: ['testing', 'submitted'],
  testing: ['ready_to_submit'],
  ready_to_submit: ['submitted', 'draft'],
  submitted: ['ci_pass', 'ci_fail', 'approved', 'changes_requested', 'rejected', 'published'],
  ci_pass: ['approved', 'changes_requested', 'rejected', 'published'],
  ci_fail: ['ci_pass', 'changes_requested', 'testing', 'approved', 'rejected', 'published'],
  changes_requested: ['testing', 'approved', 'rejected', 'published'],
  approved: ['published'],
  rejected: [],
  published: [],
};
