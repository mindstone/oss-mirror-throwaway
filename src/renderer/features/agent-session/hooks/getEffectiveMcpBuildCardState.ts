/**
 * getEffectiveMcpBuildCardState — pure selector that composes the
 * transient attribution-picker overlay state with the store-derived
 * `MCPBuildCardState`.
 *
 * Priority order:
 *   1. Store terminal phase (`submitted` + its substatuses) wins over
 *      everything. If the contribution has moved past the point where the
 *      attribution picker is meaningful (server reports a PR was filed),
 *      a stale preserved transient must not mask that. Stage 1.3 X1b of
 *      `docs/plans/260420_oss_mcp_backend_relay.md`.
 *   2. `submitting` overlay (transient) — set while an attribution-picker
 *      submission is in flight.
 *   3. `github-check` overlay (transient) — set while the user is
 *      choosing an attribution mode. Preserved on recoverable submit
 *      failures (R1) so the picker stays visible for retry.
 *   4. Store-derived `cardState` (building, testing-error, submit-prompt,
 *      or submitted when the transient guard above didn't fire — e.g. no
 *      picker was ever open).
 *
 * Extracted from App.tsx's `effectiveMcpBuildCardState` memo so the
 * priority logic is testable without a full render tree. Pure — no
 * React imports.
 */

import type { MCPBuildCardState } from '../components/MCPBuildCard';

/**
 * Phases that mean "the store has already moved past the attribution
 * picker". When the store reports one of these, a preserved transient
 * `github-check` override is stale and must not be rendered.
 *
 * Today this is just `'submitted'` (the single post-submission phase
 * that carries every substatus: under_review / pending_approval /
 * checks_failed / changes_needed / approved / rejected / published).
 * Pre-submit phases (`building`, `testing-error`, `submit-prompt`) do
 * NOT count — the user may still be mid-flight on the picker and the
 * transient represents their intent. The `submitting` phase isn't
 * emitted by the store mapping (it's only set as an in-flight overlay),
 * so it does not need to be enumerated here.
 */
export function isTerminalBuildPhase(phase: MCPBuildCardState['phase']): boolean {
  return phase === 'submitted';
}

export interface EffectiveMcpBuildCardStateInput {
  /** Transient: connector name while an attribution-picker submission is in flight. */
  submittingConnectorName: string | null;
  /** Transient: connector name while the github-check picker is shown. */
  githubCheckConnectorName: string | null;
  /** Settings > Profile first name, used on the "Use my Rebel name (Alex)" option label. */
  userFirstName: string | null | undefined;
  /** Store-derived card state (null when no contribution exists). */
  cardState: MCPBuildCardState | null | undefined;
}

export function getEffectiveMcpBuildCardState(
  input: EffectiveMcpBuildCardStateInput,
): MCPBuildCardState | null | undefined {
  const {
    submittingConnectorName,
    githubCheckConnectorName,
    userFirstName,
    cardState,
  } = input;

  // Stage 1.3 X1b: when the store has moved to a terminal (submitted)
  // phase, the preserved picker override (and any still-mounted
  // submitting overlay) is stale — the contribution has already been
  // filed. Returning `cardState` here lets the submitted card surface
  // so the user sees the real status instead of a dead-end picker.
  if (cardState && isTerminalBuildPhase(cardState.phase)) {
    return cardState;
  }

  if (submittingConnectorName) {
    return { phase: 'submitting', connectorName: submittingConnectorName };
  }
  if (githubCheckConnectorName) {
    // 260424 PR-template revamp follow-up (addendum #2): the Stage 4
    // form-value seeding was removed along with the inline "One more
    // thing" form. The reconstructed `github-check` state now carries
    // only `connectorName` and (when available) `rebelName` — the
    // footer question batch reads `rebelName` to label the Rebel-name
    // option. The card component itself renders `null` for this phase.
    return {
      phase: 'github-check',
      connectorName: githubCheckConnectorName,
      ...(userFirstName ? { rebelName: userFirstName } : {}),
    };
  }
  return cardState;
}
