// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest';

import { routeMcpBuildAnswer } from '../mcpBuildQuestionRouting';
import { buildMcpBuildQuestionBatch } from '../MCPBuildCard';
import type {
  MCPBuildCardActionHandlers,
  MCPBuildCardState,
} from '../MCPBuildCard';

// ─── 260424 PR-template revamp follow-up (addendum #2) ────────────────
//
// The Stage 4 `pendingAttributionMode` redirect was removed along with
// the inline `github-check` form. Footer attribution clicks
// (`rebel-name` / `github-yes` / `anonymous`) now invoke the submit
// handler directly. The batch is dismissed iff the handler returns
// `true` (terminal success); recoverable failures keep the picker
// visible for retry. `github-skip` (Stage 5a) remains a pure
// dismissal.

describe('routeMcpBuildAnswer — footer attribution submit (direct)', () => {
  function makeActions(overrides: Partial<MCPBuildCardActionHandlers> = {}): MCPBuildCardActionHandlers {
    return {
      onUseRebelName: vi.fn().mockResolvedValue(true),
      onAnonymous: vi.fn().mockResolvedValue(true),
      onGitHubYes: vi.fn().mockResolvedValue(true),
      onSubmitToCommunity: vi.fn().mockResolvedValue(true),
      onRunTest: vi.fn(),
      onReRunTest: vi.fn(),
      onContactTeam: vi.fn(),
      onMakeChanges: vi.fn(),
      onViewOnGitHub: vi.fn(),
      ...overrides,
    };
  }

  it('rebel-name click → invokes onUseRebelName and dismisses on terminal success', async () => {
    const actions = makeActions();
    const { shouldDismiss } = await routeMcpBuildAnswer({
      selectedOptionIds: new Set(['rebel-name']),
      actions,
      mcpBuildCardState: { phase: 'github-check', connectorName: 'X' },
    });
    expect(actions.onUseRebelName).toHaveBeenCalledTimes(1);
    expect(shouldDismiss).toBe(true);
    // Sibling handlers must not fire.
    expect(actions.onAnonymous).not.toHaveBeenCalled();
    expect(actions.onGitHubYes).not.toHaveBeenCalled();
    expect(actions.onSubmitToCommunity).not.toHaveBeenCalled();
  });

  it('rebel-name click with recoverable failure → does NOT dismiss (picker stays for retry)', async () => {
    const actions = makeActions({
      onUseRebelName: vi.fn().mockResolvedValue(false),
    });
    const { shouldDismiss } = await routeMcpBuildAnswer({
      selectedOptionIds: new Set(['rebel-name']),
      actions,
      mcpBuildCardState: { phase: 'github-check', connectorName: 'X' },
    });
    expect(actions.onUseRebelName).toHaveBeenCalledTimes(1);
    expect(shouldDismiss).toBe(false);
  });

  it('github-yes click → invokes onGitHubYes and dismisses on terminal success', async () => {
    const actions = makeActions();
    const { shouldDismiss } = await routeMcpBuildAnswer({
      selectedOptionIds: new Set(['github-yes']),
      actions,
      mcpBuildCardState: { phase: 'github-check', connectorName: 'X' },
    });
    expect(actions.onGitHubYes).toHaveBeenCalledTimes(1);
    expect(shouldDismiss).toBe(true);
    expect(actions.onUseRebelName).not.toHaveBeenCalled();
    expect(actions.onAnonymous).not.toHaveBeenCalled();
  });

  it('github-yes click with recoverable failure (e.g. reAuthRequired) → does NOT dismiss', async () => {
    const actions = makeActions({
      onGitHubYes: vi.fn().mockResolvedValue(false),
    });
    const { shouldDismiss } = await routeMcpBuildAnswer({
      selectedOptionIds: new Set(['github-yes']),
      actions,
      mcpBuildCardState: { phase: 'github-check', connectorName: 'X' },
    });
    expect(shouldDismiss).toBe(false);
  });

  it('anonymous click → invokes onAnonymous and dismisses on terminal success', async () => {
    const actions = makeActions();
    const { shouldDismiss } = await routeMcpBuildAnswer({
      selectedOptionIds: new Set(['anonymous']),
      actions,
      mcpBuildCardState: { phase: 'github-check', connectorName: 'X' },
    });
    expect(actions.onAnonymous).toHaveBeenCalledTimes(1);
    expect(shouldDismiss).toBe(true);
    expect(actions.onUseRebelName).not.toHaveBeenCalled();
    expect(actions.onGitHubYes).not.toHaveBeenCalled();
  });

  it('anonymous click with recoverable failure → does NOT dismiss', async () => {
    const actions = makeActions({
      onAnonymous: vi.fn().mockResolvedValue(false),
    });
    const { shouldDismiss } = await routeMcpBuildAnswer({
      selectedOptionIds: new Set(['anonymous']),
      actions,
      mcpBuildCardState: { phase: 'github-check', connectorName: 'X' },
    });
    expect(shouldDismiss).toBe(false);
  });

  it('does not throw and does not dismiss when actions is undefined (defensive)', async () => {
    const { shouldDismiss } = await routeMcpBuildAnswer({
      selectedOptionIds: new Set(['rebel-name']),
      actions: undefined,
      mcpBuildCardState: { phase: 'github-check', connectorName: 'X' },
    });
    // With no handler, the fallback `?? false` path keeps the picker
    // visible — a missing wiring shouldn't accidentally dismiss and
    // lose the user's spot.
    expect(shouldDismiss).toBe(false);
  });
});

// ─── Non-attribution routing (unchanged) ─────────────────────────────

describe('routeMcpBuildAnswer — non-attribution routing', () => {
  function makeActions(overrides: Partial<MCPBuildCardActionHandlers> = {}): MCPBuildCardActionHandlers {
    return {
      onUseRebelName: vi.fn().mockResolvedValue(true),
      onAnonymous: vi.fn().mockResolvedValue(true),
      onGitHubYes: vi.fn().mockResolvedValue(true),
      onSubmitToCommunity: vi.fn().mockResolvedValue(true),
      onRunTest: vi.fn(),
      onReRunTest: vi.fn(),
      onContactTeam: vi.fn(),
      onMakeChanges: vi.fn(),
      onViewOnGitHub: vi.fn(),
      ...overrides,
    };
  }

  it('run-check → does NOT dismiss (handler is a sync state nudge; next batch carries the user through)', async () => {
    const actions = makeActions();
    const { shouldDismiss } = await routeMcpBuildAnswer({
      selectedOptionIds: new Set(['run-check']),
      actions,
      mcpBuildCardState: undefined,
    });
    expect(actions.onRunTest).toHaveBeenCalledTimes(1);
    expect(shouldDismiss).toBe(false);
  });

  it('re-run-check → invokes onReRunTest and does not dismiss', async () => {
    const actions = makeActions();
    const { shouldDismiss } = await routeMcpBuildAnswer({
      selectedOptionIds: new Set(['re-run-check']),
      actions,
      mcpBuildCardState: undefined,
    });
    expect(actions.onReRunTest).toHaveBeenCalledTimes(1);
    expect(shouldDismiss).toBe(false);
  });

  it('contact-team → invokes onContactTeam and does not dismiss', async () => {
    const actions = makeActions();
    const { shouldDismiss } = await routeMcpBuildAnswer({
      selectedOptionIds: new Set(['contact-team']),
      actions,
      mcpBuildCardState: undefined,
    });
    expect(actions.onContactTeam).toHaveBeenCalledTimes(1);
    expect(shouldDismiss).toBe(false);
  });

  it('add-to-community handler returns true → shouldDismiss true (advanced to picker)', async () => {
    const actions = makeActions({
      onSubmitToCommunity: vi.fn().mockResolvedValue(true),
    });
    const { shouldDismiss } = await routeMcpBuildAnswer({
      selectedOptionIds: new Set(['add-to-community']),
      actions,
      mcpBuildCardState: { phase: 'submit-prompt', connectorName: 'X', tools: [] },
    });
    expect(actions.onSubmitToCommunity).toHaveBeenCalledTimes(1);
    expect(shouldDismiss).toBe(true);
  });

  it('add-to-community handler returns false → shouldDismiss false (no-op, picker stays)', async () => {
    const actions = makeActions({
      onSubmitToCommunity: vi.fn().mockResolvedValue(false),
    });
    const { shouldDismiss } = await routeMcpBuildAnswer({
      selectedOptionIds: new Set(['add-to-community']),
      actions,
      mcpBuildCardState: { phase: 'submit-prompt', connectorName: 'X', tools: [] },
    });
    expect(shouldDismiss).toBe(false);
  });

  // 260428 Stage 1: "Keep it private" routes through the existing
  // minimize machinery instead of full dismissal — the user gets a
  // `MinimizedQuestionPill` they can restore (same code path as the
  // manual minimize button). The contribution stays at
  // `ready_to_submit`; recovery paths are pill click, re-ask the agent,
  // or Settings → Tools → "Share with everyone".
  //
  // Parent-dispatch contract (verified at the call site in
  // `SessionSurfaceContent.handleMcpBuildQuestionSubmit`):
  //   if (result.shouldMinimize) handleMinimizeQuestion(batchId);
  //   else if (result.shouldDismiss) setDismissedMcpBuildQuestionId(batchId);
  // We can't unit-test that closure boundary here without
  // `@testing-library/react`; the UI smoke covers the end-to-end flow.
  it('keep-private → minimizes (does NOT dismiss) and dispatches no handler', async () => {
    const actions = makeActions();
    const result = await routeMcpBuildAnswer({
      selectedOptionIds: new Set(['keep-private']),
      actions,
      mcpBuildCardState: { phase: 'submit-prompt', connectorName: 'X', tools: [] },
    });
    expect(actions.onSubmitToCommunity).not.toHaveBeenCalled();
    expect(actions.onUseRebelName).not.toHaveBeenCalled();
    expect(actions.onAnonymous).not.toHaveBeenCalled();
    expect(result).toEqual({ shouldDismiss: false, shouldMinimize: true });
  });

  it('view-on-github → invokes onViewOnGitHub with the PR URL and dismisses', async () => {
    const actions = makeActions();
    const state: MCPBuildCardState = {
      phase: 'submitted',
      connectorName: 'X',
      prUrl: 'https://example.com/pull/1',
      substatus: 'under_review',
    };
    const { shouldDismiss } = await routeMcpBuildAnswer({
      selectedOptionIds: new Set(['view-on-github']),
      actions,
      mcpBuildCardState: state,
    });
    expect(actions.onViewOnGitHub).toHaveBeenCalledWith('https://example.com/pull/1');
    expect(shouldDismiss).toBe(true);
  });

  it('make-changes → invokes onMakeChanges and dismisses', async () => {
    const actions = makeActions();
    const { shouldDismiss } = await routeMcpBuildAnswer({
      selectedOptionIds: new Set(['make-changes']),
      actions,
      mcpBuildCardState: { phase: 'submitted', connectorName: 'X', substatus: 'changes_needed' },
    });
    expect(actions.onMakeChanges).toHaveBeenCalledTimes(1);
    expect(shouldDismiss).toBe(true);
  });

  it('unknown option → dismisses defensively (no orphan card)', async () => {
    const actions = makeActions();
    const { shouldDismiss } = await routeMcpBuildAnswer({
      selectedOptionIds: new Set(['somethingelse']),
      actions,
      mcpBuildCardState: undefined,
    });
    expect(shouldDismiss).toBe(true);
  });

  // Stage 5a (260420 OSS MCP backend relay): `github-skip` is emitted
  // by the 2-option picker when the relay flag is off. It must be a
  // pure dismissal — no handler invocation, no submit IPC, no store
  // writes.
  it('github-skip (Stage 5a) → dismisses without invoking any submit handler', async () => {
    const actions = makeActions();
    const { shouldDismiss } = await routeMcpBuildAnswer({
      selectedOptionIds: new Set(['github-skip']),
      actions,
      mcpBuildCardState: { phase: 'github-check', connectorName: 'X' },
    });
    expect(shouldDismiss).toBe(true);
    expect(actions.onUseRebelName).not.toHaveBeenCalled();
    expect(actions.onAnonymous).not.toHaveBeenCalled();
    expect(actions.onGitHubYes).not.toHaveBeenCalled();
    expect(actions.onSubmitToCommunity).not.toHaveBeenCalled();
  });

  // 260428 Stage 1 invariant: `shouldMinimize: true` is exclusive to the
  // keep-private branch. Every other selectedOptionId must leave it
  // unset (or false) so the parent dispatch never accidentally routes
  // a non-keep-private answer through `handleMinimizeQuestion`.
  it('shouldMinimize is exclusive to keep-private — all other branches leave it unset', async () => {
    const cases: Array<{
      label: string;
      selectedOptionIds: Set<string>;
      state: MCPBuildCardState | undefined;
    }> = [
      { label: 'run-check', selectedOptionIds: new Set(['run-check']), state: undefined },
      { label: 're-run-check', selectedOptionIds: new Set(['re-run-check']), state: undefined },
      { label: 'contact-team', selectedOptionIds: new Set(['contact-team']), state: undefined },
      {
        label: 'add-to-community',
        selectedOptionIds: new Set(['add-to-community']),
        state: { phase: 'submit-prompt', connectorName: 'X', tools: [] },
      },
      {
        label: 'rebel-name',
        selectedOptionIds: new Set(['rebel-name']),
        state: { phase: 'github-check', connectorName: 'X' },
      },
      {
        label: 'github-yes',
        selectedOptionIds: new Set(['github-yes']),
        state: { phase: 'github-check', connectorName: 'X' },
      },
      {
        label: 'anonymous',
        selectedOptionIds: new Set(['anonymous']),
        state: { phase: 'github-check', connectorName: 'X' },
      },
      {
        label: 'github-skip',
        selectedOptionIds: new Set(['github-skip']),
        state: { phase: 'github-check', connectorName: 'X' },
      },
      {
        label: 'view-on-github',
        selectedOptionIds: new Set(['view-on-github']),
        state: {
          phase: 'submitted',
          connectorName: 'X',
          prUrl: 'https://example.com/pull/1',
          substatus: 'under_review',
        },
      },
      {
        label: 'make-changes',
        selectedOptionIds: new Set(['make-changes']),
        state: { phase: 'submitted', connectorName: 'X', substatus: 'changes_needed' },
      },
      { label: 'unknown', selectedOptionIds: new Set(['somethingelse']), state: undefined },
    ];
    for (const { label, selectedOptionIds, state } of cases) {
      const result = await routeMcpBuildAnswer({
        selectedOptionIds,
        actions: makeActions(),
        mcpBuildCardState: state,
      });
      expect(
        result.shouldMinimize,
        `${label} branch must NOT request minimize`,
      ).toBeFalsy();
    }
  });
});

// ─── Stage 1.2 R3 (260420 OSS MCP backend relay) ─────────────────────
// Two sessions working on a connector with the same name must NOT
// share picker dismissal state. The dismissal key (`batchId`) is
// session-scoped, so a dismissal in session A does not suppress the
// picker in session B even when the connector name is identical. This
// test pins that invariant at the helper layer.

describe('buildMcpBuildQuestionBatch — session-scoped dismissal (Stage 1.2 R3)', () => {
  it('two sessions with the same connector name get distinct batch ids (no dismissal collision)', () => {
    // Stand-in for SessionSurfaceContent's `dismissedMcpBuildQuestionId`:
    // a single shared set that records which batch ids the user has
    // dismissed. Before R3 both sessions would write the same id, so
    // dismissing in A also hid the picker in B.
    const dismissed = new Set<string>();
    const state: MCPBuildCardState = { phase: 'github-check', connectorName: 'SharedConnector' };

    const batchA = buildMcpBuildQuestionBatch(state, 'session-A');
    const batchB = buildMcpBuildQuestionBatch(state, 'session-B');
    expect(batchA).not.toBeNull();
    expect(batchB).not.toBeNull();

    // User dismisses the picker in session A.
    dismissed.add(batchA!.batchId);

    // Session B's batch must still be visible — its id is different.
    expect(dismissed.has(batchA!.batchId)).toBe(true);
    expect(dismissed.has(batchB!.batchId)).toBe(false);
    expect(batchA!.batchId).not.toBe(batchB!.batchId);
  });

  it('same session id produces stable batch ids across calls (regression guard)', () => {
    // Round-tripping the builder on the same inputs must return an
    // identical id, otherwise the in-flight dismissal key drifts and
    // the user's dismissal is immediately invalidated.
    const state: MCPBuildCardState = { phase: 'submit-prompt', connectorName: 'Foo', tools: [] };
    const first = buildMcpBuildQuestionBatch(state, 'session-X');
    const second = buildMcpBuildQuestionBatch(state, 'session-X');
    expect(first?.batchId).toBe(second?.batchId);
  });
});
