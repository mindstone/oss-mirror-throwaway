import { describe, it, expect } from 'vitest';

import {
  computePendingMcpBuildQuestionBatch,
  computeVisibleMcpBuildQuestionBatch,
} from '../mcpBuildQuestionVisibility';

// ─── 260424 bug: synthetic MCP build batch appears while agent is busy ─
//
// The batch is derived from `contribution.status === 'ready_to_submit'`.
// The agent may legitimately transition to that status part-way through
// a turn (after Phase 6 testing) and then continue working on Phase 6.4
// `rebel_mcp_add_server`, Phase 7 quality review, and Phase 8 completion
// summary. If we show the submit-prompt during that window the user can
// click "Add to the community" mid-turn, racing the agent.
//
// The gate lives inside `computeVisibleMcpBuildQuestionBatch` — tested
// here in isolation so we don't need to stand up the full
// `SessionSurfaceContent` render tree.

describe('computeVisibleMcpBuildQuestionBatch', () => {
  const batch = { batchId: 'mcp-build:session-A:connector:submit-prompt' };

  it('returns null when isBusy=true, even with a valid batch', () => {
    const result = computeVisibleMcpBuildQuestionBatch({
      batch,
      dismissedBatchId: null,
      isBusy: true,
    });
    expect(result).toBeNull();
  });

  it('returns the batch when isBusy=false and not dismissed', () => {
    const result = computeVisibleMcpBuildQuestionBatch({
      batch,
      dismissedBatchId: null,
      isBusy: false,
    });
    expect(result).toBe(batch);
  });

  it('returns null when isBusy=false but batch is dismissed', () => {
    const result = computeVisibleMcpBuildQuestionBatch({
      batch,
      dismissedBatchId: batch.batchId,
      isBusy: false,
    });
    expect(result).toBeNull();
  });

  it('returns null when there is no batch', () => {
    expect(
      computeVisibleMcpBuildQuestionBatch({
        batch: null,
        dismissedBatchId: null,
        isBusy: false,
      }),
    ).toBeNull();
    expect(
      computeVisibleMcpBuildQuestionBatch({
        batch: undefined,
        dismissedBatchId: null,
        isBusy: false,
      }),
    ).toBeNull();
  });

  it('busy gate takes precedence over dismissal', () => {
    // If both suppress reasons apply, we still return null — but the
    // caller shouldn't have to care which one fired. Order-independent.
    const result = computeVisibleMcpBuildQuestionBatch({
      batch,
      dismissedBatchId: batch.batchId,
      isBusy: true,
    });
    expect(result).toBeNull();
  });

  it('busy gate suppresses even a non-dismissed batch with a matching-looking id', () => {
    // Regression guard: make sure the isBusy short-circuit runs before
    // any batch.batchId / dismissedBatchId comparison.
    const result = computeVisibleMcpBuildQuestionBatch({
      batch,
      dismissedBatchId: 'some-other-batch',
      isBusy: true,
    });
    expect(result).toBeNull();
  });
});

// ─── 260428 Stage 0: cleanup-effect resolution helper ────────────────
//
// `computePendingMcpBuildQuestionBatch` is the un-busy-gated companion
// to the visible selector. It exists for the minimized-question
// cleanup `useEffect`s in `SessionSurfaceContent`, which must identify
// the right batch to record a dismissal on even when `isBusy=true` has
// already hidden the visible batch.
//
// Without this helper, the busy-transition cleanup branch never matches
// the MCP build batch, dismissal is never recorded, and the batch
// re-emerges as a footer card on next idle. See planning doc
// `docs/plans/260428_keep_private_minimize_and_settings_share_button.md`
// (Stage 0).

describe('computePendingMcpBuildQuestionBatch', () => {
  const batch = { batchId: 'mcp-build:session-A:connector:submit-prompt' };

  it('returns the batch even when isBusy would otherwise hide it (un-busy-gated)', () => {
    // Core invariant: this helper must return a non-null batch for the
    // exact scenario that was breaking the visible variant — busy
    // transition where the cleanup effect needs to know which batch the
    // minimized pill refers to.
    const result = computePendingMcpBuildQuestionBatch({
      batch,
      dismissedBatchId: null,
    });
    expect(result).toBe(batch);
  });

  it('still respects dismissal — a dismissed batch is null', () => {
    // Cleanup effects shouldn't redundantly re-dismiss something
    // already dismissed. Mirrors the visible selector's dismissal
    // filter.
    const result = computePendingMcpBuildQuestionBatch({
      batch,
      dismissedBatchId: batch.batchId,
    });
    expect(result).toBeNull();
  });

  it('returns null when there is no batch', () => {
    expect(
      computePendingMcpBuildQuestionBatch({
        batch: null,
        dismissedBatchId: null,
      }),
    ).toBeNull();
    expect(
      computePendingMcpBuildQuestionBatch({
        batch: undefined,
        dismissedBatchId: null,
      }),
    ).toBeNull();
  });

  it('matches visible-when-not-busy parity', () => {
    // Equivalence: when isBusy=false, the two selectors agree. The
    // helper is not allowed to drift from the visible selector's
    // dismissal/null-batch handling — only the busy gate differs.
    const inputs = [
      { batch, dismissedBatchId: null },
      { batch, dismissedBatchId: batch.batchId },
      { batch: null, dismissedBatchId: null },
      { batch: undefined, dismissedBatchId: 'whatever' },
    ] as const;
    for (const input of inputs) {
      const visible = computeVisibleMcpBuildQuestionBatch({ ...input, isBusy: false });
      const pending = computePendingMcpBuildQuestionBatch(input);
      expect(pending).toBe(visible);
    }
  });

  it('cleanup-effect scenario: minimized pill survives busy=true while batch persists', () => {
    // Concrete scenario from the bug:
    //  - User clicked "Keep it private" → minimized pill set, batch in
    //    `mcpBuildQuestionBatch` still present.
    //  - User then types a message → isBusy flips false → true.
    //  - The visible selector returns null (busy gate).
    //  - The cleanup effect must still resolve the batch to record a
    //    dismissal under `dismissedMcpBuildQuestionId` so that the
    //    batch does NOT re-emit as a footer card on next idle.
    const visibleAtBusy = computeVisibleMcpBuildQuestionBatch({
      batch,
      dismissedBatchId: null,
      isBusy: true,
    });
    const pendingAtBusy = computePendingMcpBuildQuestionBatch({
      batch,
      dismissedBatchId: null,
    });

    expect(visibleAtBusy).toBeNull(); // render path: correctly hidden
    expect(pendingAtBusy).toBe(batch); // cleanup path: still resolvable
    // The cleanup effect's `else if (pendingMcpBuildBatch?.batchId === minimizedQuestionBatchId)`
    // branch can therefore match and record dismissal.
  });
});
