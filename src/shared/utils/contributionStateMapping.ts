/**
 * Maps ContributionStatus → MCPBuildCardState
 *
 * Derives the visual state for MCPBuildCard from the contribution store.
 *
 * State mapping:
 *   - draft → building.implementing (neutral "Writing <name>" progress card,
 *     no submit CTA — per SKILL.md the submit prompt only appears at
 *     ready_to_submit after Phase 6 testing passes)
 *   - testing (no errors) → building.testing (neutral "Testing <name>"
 *     progress card, no CTA — makes the long Phase 6 loop visible)
 *   - testing + errors → testing-error (agent-reported tool failure UX)
 *   - ready_to_submit → submit-prompt (tests passed — the ONLY place the
 *     "Add to the community" CTA appears)
 *   - (attribution needed) → github-check
 *   - submitted..published → submitted (with varying helperText/substatus)
 *
 * Platform-agnostic — no Electron or React imports.
 *
 * @see docs/plans/260410_oss_mcp_integration_forward_plan.md (P3)
 * @see docs/plans/260420_simplify_mcp_build_flow.md (Stage 3 + post-ship
 *      correction introducing the `building` phase)
 */

// ─── Contribution Types (mirrored from @core/services/contributionTypes) ──
// Defined locally to avoid @core/ path dependency in shared code.
// These must stay in sync with the canonical types in contributionTypes.ts.

/** All 10 states of a connector contribution lifecycle. */
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

/** Minimal contribution record shape needed for state mapping. */
export interface ContributionRecord {
  id?: string;
  connectorName: string;
  status: ContributionStatus;
  attributionName?: string;
  prUrl?: string;
  reviewNotes?: string;
  /**
   * Most-recent rejected transition error. Plumbed through to the renderer so
   * the `testing-error` card can surface the raw or structured error
   * (e.g. evidence-insufficient JSON from the bridge evidence gate) when the
   * agent misreports state. Optional and additive.
   */
  lastTransitionError?: string;
}

// ─── MCPBuildCard Types (mirrored from renderer, no React dependency) ───

export type MCPBuildTool = {
  name: string;
  status?: 'pending' | 'pass' | 'fail';
  error?: string;
};

/**
 * Extended MCPBuildCardState that includes helperText and substatus
 * for varying copy within the submitted phase.
 */
export type MappedBuildCardState =
  | {
      phase: 'testing-error';
      connectorName: string;
      tools: MCPBuildTool[];
      autoFixMessage?: string;
      /**
       * Raw last-transition error from the contribution store. Surfaced on
       * the testing-error card so the user (and Rebel) can see why the
       * testing gate rejected a premature `ready_to_submit`. May be a raw
       * string or a JSON-serialized evidence-insufficient payload from the
       * bridge evidence gate (Stage 2.5). Optional.
       */
      lastTransitionError?: string;
    }
  | {
      /**
       * Neutral progress state shown during the long silent stretches of
       * the build flow (Phase 4 implementation and Phase 6 testing). No
       * question / CTA — purely informational so the user can see which
       * connector is being worked on and which stage is running.
       *
       * `subphase`:
       *  - 'implementing' — contribution status is `draft` (after Phase 4).
       *  - 'testing'      — contribution status is `testing` (Phase 6, no
       *                     errors yet).
       */
      phase: 'building';
      subphase: 'implementing' | 'testing';
      connectorName: string;
      tools: MCPBuildTool[];
    }
  | { phase: 'submit-prompt'; connectorName: string; tools: MCPBuildTool[] }
  | { phase: 'github-check'; connectorName: string }
  | {
      phase: 'submitted';
      connectorName: string;
      helperText: string;
      substatus: SubmittedSubstatus;
      authorName?: string;
      prUrl?: string;
    };

/**
 * Substatus values for the 'submitted' phase.
 *
 * Simplified for non-technical users:
 * - under_review: submitted is still in-flight
 * - pending_approval: automated checks passed and the PR is awaiting human approval
 * - checks_failed: automated checks found an issue before approval
 * - changes_needed: reviewer requested changes
 * - approved, rejected, published: later lifecycle states with clear meaning
 */
export type SubmittedSubstatus =
  | 'under_review'
  | 'pending_approval'
  | 'checks_failed'
  | 'changes_needed'
  | 'approved'
  | 'rejected'
  | 'published';

// ─── Helper Text Constants ──────────────────────────────────────────

export const SUBMITTED_HELPER_TEXT: Record<SubmittedSubstatus, string> = {
  under_review:
    "A reviewer is taking a look now to make sure everything works well and is ready to share. We'll let you know as soon as it's available to everyone.",
  pending_approval: 'Checks passed. A reviewer is taking a look.',
  checks_failed: 'The checks came back with something to fix. Rebel can help.',
  changes_needed: 'A reviewer asked for a couple of tweaks. Rebel can handle them.',
  approved: 'Your tool was approved. It should land soon.',
  rejected: "They didn't take this one. Your tool still works on your machine — nothing's lost.",
  published: 'Your tool is live. Other people can use it now.',
};

// ─── State Mapping ──────────────────────────────────────────────────

/**
 * Maps a contribution status to an MCPBuildCard submitted substatus.
 * Returns null if the status is not in the submitted family.
 *
 * `ci_pass` gets its own user-facing state so the UI can say the connector is
 * awaiting approval, rather than flattening it into a generic "under review".
 */
export function toSubmittedSubstatus(status: ContributionStatus): SubmittedSubstatus | null {
  switch (status) {
    case 'submitted':
      return 'under_review';
    case 'ci_pass':
      return 'pending_approval';
    case 'ci_fail':
      return 'checks_failed';
    case 'changes_requested':
      return 'changes_needed';
    case 'approved':
      return 'approved';
    case 'rejected':
      return 'rejected';
    case 'published':
      return 'published';
    default:
      return null;
  }
}

/**
 * Options for controlling how testing states are mapped.
 * The skill reports tool results that inform whether to show
 * the testing or testing-error phase.
 */
export interface StateMapOptions {
  /** Tools discovered during the build (for testing/testing-error/submit-prompt phases). */
  tools?: MCPBuildTool[];
  /** If true, shows testing-error instead of testing. */
  hasTestErrors?: boolean;
  /** Auto-fix message for testing-error phase. */
  autoFixMessage?: string;
  /** If rejected, optional review notes to append to helper text. */
  reviewNotes?: string;
}

/**
 * Maps a contribution record to the MCPBuildCardState.
 *
 * Returns null if no contribution exists (caller should not render the card).
 */
export function mapContributionToCardState(
  contribution: ContributionRecord | null | undefined,
  options: StateMapOptions = {},
): MappedBuildCardState | null {
  if (!contribution) {
    return null;
  }

  const { tools = [], hasTestErrors = false, autoFixMessage, reviewNotes } = options;
  const { connectorName, status } = contribution;

  switch (status) {
    case 'draft':
      // Phase 4 complete — the agent has written the code but testing hasn't
      // begun. Show a neutral "writing your connector" card so the user has
      // visible reassurance, but do NOT offer the submit CTA yet — per
      // SKILL.md the submit prompt only appears at `ready_to_submit` (after
      // Phase 6 testing passes).
      return { phase: 'building', subphase: 'implementing', connectorName, tools };

    case 'testing':
      if (hasTestErrors || contribution.lastTransitionError) {
        return {
          phase: 'testing-error',
          connectorName,
          tools,
          ...(autoFixMessage !== undefined && { autoFixMessage }),
          ...(contribution.lastTransitionError
            ? { lastTransitionError: contribution.lastTransitionError }
            : {}),
        };
      }
      // Phase 6 in progress, no failures yet. Show a neutral "testing your
      // connector" card — the agent owns the loop end-to-end, but the user
      // should still see what's happening.
      return { phase: 'building', subphase: 'testing', connectorName, tools };

    case 'ready_to_submit':
      return { phase: 'submit-prompt', connectorName, tools };

    default: {
      // All post-submission states map to the 'submitted' phase
      const substatus = toSubmittedSubstatus(status);
      if (substatus) {
        let helperText = SUBMITTED_HELPER_TEXT[substatus];
        // Append review notes for rejected status
        if (substatus === 'rejected' && (reviewNotes ?? contribution.reviewNotes)) {
          helperText += ` ${reviewNotes ?? contribution.reviewNotes}`;
        }
        return {
          phase: 'submitted',
          connectorName,
          helperText,
          substatus,
          ...(contribution.attributionName ? { authorName: contribution.attributionName } : {}),
          ...(contribution.prUrl ? { prUrl: contribution.prUrl } : {}),
        };
      }

      // Unreachable for valid ContributionStatus values, but defensive
      return null;
    }
  }
}

/**
 * Determines if the github-check phase should be shown.
 * This is a transitional state between ready_to_submit and submitted
 * that doesn't correspond to a persisted ContributionStatus — it's
 * driven by UI flow (user clicked "Submit to community" and hasn't
 * chosen attribution yet).
 *
 * The renderer hook manages this transient state.
 */
export function createGitHubCheckState(connectorName: string): MappedBuildCardState {
  return { phase: 'github-check', connectorName };
}
