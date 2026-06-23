import { describe, it, expect } from 'vitest';

import type { MCPBuildCardState } from '../../components/MCPBuildCard';
import {
  getEffectiveMcpBuildCardState,
  isTerminalBuildPhase,
} from '../getEffectiveMcpBuildCardState';

// ─── Stage 1.3 X1b (260420 OSS MCP backend relay) ─────────────────────
// The `github-check` transient owned by `useMcpBuildSubmission` is
// preserved on recoverable submit failures (R1) so the picker stays
// visible for retry. That preservation must NOT mask the store when
// the contribution has already moved to a terminal phase on the
// server (`submitted` — covers under_review / pending_approval /
// checks_failed / changes_needed / approved / rejected / published).
// Otherwise a background refresh discovering the real PR status gets
// silently hidden behind a dead-end attribution picker.

describe('isTerminalBuildPhase', () => {
  it('returns true for submitted', () => {
    expect(isTerminalBuildPhase('submitted')).toBe(true);
  });

  it('returns false for pre-submit phases', () => {
    expect(isTerminalBuildPhase('building')).toBe(false);
    expect(isTerminalBuildPhase('testing-error')).toBe(false);
    expect(isTerminalBuildPhase('submit-prompt')).toBe(false);
  });

  it('returns false for the transient overlay phases (owned by the hook, not the store)', () => {
    // The store mapping never emits `submitting` or `github-check` —
    // those are renderer transients. They must NOT be treated as
    // terminal; otherwise the hook's own overlay would short-circuit
    // itself.
    expect(isTerminalBuildPhase('submitting')).toBe(false);
    expect(isTerminalBuildPhase('github-check')).toBe(false);
  });
});

describe('getEffectiveMcpBuildCardState', () => {
  const buildSubmitted = (
    overrides: Partial<Extract<MCPBuildCardState, { phase: 'submitted' }>> = {},
  ): MCPBuildCardState => ({
    phase: 'submitted',
    connectorName: 'X',
    ...overrides,
  });

  const buildSubmitPrompt = (): MCPBuildCardState => ({
    phase: 'submit-prompt',
    connectorName: 'X',
    tools: [],
  });

  const buildBuilding = (): MCPBuildCardState => ({
    phase: 'building',
    subphase: 'implementing',
    connectorName: 'X',
    tools: [],
  });

  // ── X1b: terminal phase wins ──────────────────────────────────────

  it('returns cardState (submitted) even when a github-check transient is preserved', () => {
    const cardState = buildSubmitted({ substatus: 'under_review', helperText: 'Under review' });
    const result = getEffectiveMcpBuildCardState({
      submittingConnectorName: null,
      githubCheckConnectorName: 'X',
      userFirstName: 'Alex',
      cardState,
    });
    expect(result).toEqual(cardState);
    expect(result?.phase).toBe('submitted');
  });

  it('returns cardState for every submitted substatus variant (rejected / published / approved / etc.)', () => {
    const substatuses = [
      'under_review',
      'pending_approval',
      'checks_failed',
      'changes_needed',
      'approved',
      'rejected',
      'published',
    ] as const;
    for (const substatus of substatuses) {
      const cardState = buildSubmitted({ substatus, helperText: substatus });
      const result = getEffectiveMcpBuildCardState({
        submittingConnectorName: null,
        githubCheckConnectorName: 'X',
        userFirstName: null,
        cardState,
      });
      expect(result, `substatus=${substatus}`).toEqual(cardState);
    }
  });

  it('terminal store phase wins over both transients (submitting AND github-check set)', () => {
    // Pathological case: the user clicked submit, a refresh fires,
    // store reports submitted. The `submitting` overlay is also stale
    // in this case — the real submission went through.
    const cardState = buildSubmitted({ substatus: 'pending_approval' });
    const result = getEffectiveMcpBuildCardState({
      submittingConnectorName: 'X',
      githubCheckConnectorName: 'X',
      userFirstName: 'Alex',
      cardState,
    });
    expect(result?.phase).toBe('submitted');
  });

  // ── Priority preservation (pre-X1b behaviour retained) ────────────

  it('submit-prompt cedes to the github-check transient (preserved for retry)', () => {
    const result = getEffectiveMcpBuildCardState({
      submittingConnectorName: null,
      githubCheckConnectorName: 'X',
      userFirstName: 'Alex',
      cardState: buildSubmitPrompt(),
    });
    expect(result).toEqual({
      phase: 'github-check',
      connectorName: 'X',
      rebelName: 'Alex',
    });
  });

  it('building phase cedes to the github-check transient', () => {
    const result = getEffectiveMcpBuildCardState({
      submittingConnectorName: null,
      githubCheckConnectorName: 'X',
      userFirstName: 'Alex',
      cardState: buildBuilding(),
    });
    expect(result?.phase).toBe('github-check');
  });

  it('testing-error phase cedes to the github-check transient (pre-submit recovery state)', () => {
    const cardState: MCPBuildCardState = {
      phase: 'testing-error',
      connectorName: 'X',
      tools: [],
    };
    const result = getEffectiveMcpBuildCardState({
      submittingConnectorName: null,
      githubCheckConnectorName: 'X',
      userFirstName: 'Alex',
      cardState,
    });
    expect(result?.phase).toBe('github-check');
  });

  it('submitting transient wins over store pre-submit phases when no picker is open', () => {
    const result = getEffectiveMcpBuildCardState({
      submittingConnectorName: 'X',
      githubCheckConnectorName: null,
      userFirstName: 'Alex',
      cardState: buildSubmitPrompt(),
    });
    expect(result).toEqual({ phase: 'submitting', connectorName: 'X' });
  });

  it('submitting transient wins over github-check transient when both are set', () => {
    const result = getEffectiveMcpBuildCardState({
      submittingConnectorName: 'X',
      githubCheckConnectorName: 'X',
      userFirstName: 'Alex',
      cardState: null,
    });
    expect(result?.phase).toBe('submitting');
  });

  // ── Fallback to store state ──────────────────────────────────────

  it('returns cardState when both transients are null', () => {
    const cardState = buildSubmitPrompt();
    const result = getEffectiveMcpBuildCardState({
      submittingConnectorName: null,
      githubCheckConnectorName: null,
      userFirstName: 'Alex',
      cardState,
    });
    expect(result).toBe(cardState);
  });

  it('returns null when there is no store state and no transient', () => {
    const result = getEffectiveMcpBuildCardState({
      submittingConnectorName: null,
      githubCheckConnectorName: null,
      userFirstName: 'Alex',
      cardState: null,
    });
    expect(result).toBeNull();
  });

  // ── github-check transient label composition ─────────────────────

  it('omits rebelName when userFirstName is missing (option falls back to generic label)', () => {
    const result = getEffectiveMcpBuildCardState({
      submittingConnectorName: null,
      githubCheckConnectorName: 'X',
      userFirstName: null,
      cardState: null,
    });
    expect(result).toEqual({ phase: 'github-check', connectorName: 'X' });
    expect(result && 'rebelName' in result).toBe(false);
  });

  it('attaches rebelName when userFirstName is set', () => {
    const result = getEffectiveMcpBuildCardState({
      submittingConnectorName: null,
      githubCheckConnectorName: 'X',
      userFirstName: 'Alex',
      cardState: null,
    });
    expect(result).toEqual({
      phase: 'github-check',
      connectorName: 'X',
      rebelName: 'Alex',
    });
  });

  // 260424 PR-template revamp follow-up (addendum #2): the Stage 4
  // `storedSummary` / `storedMotivation` / `storedReviewerNotes` seeding
  // was removed along with the inline "One more thing" form. The
  // reconstructed `github-check` transient now carries only
  // `connectorName` and `rebelName` — the component renders null for
  // this phase anyway, so no form values need to survive.
});
