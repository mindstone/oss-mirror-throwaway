/**
 * mcpBuildQuestionVisibility
 *
 * Pure selector for the synthetic MCP build question batch shown as the
 * footer `composerOverride`. Owns two filters:
 *   1. `isBusy` — suppress while the agent is mid-turn. The batch is
 *      derived purely from `contribution.status === 'ready_to_submit'`,
 *      so it can appear as soon as the agent calls
 *      `rebel_mcp_report_contribution_state` — even if Phase 6.4
 *      `rebel_mcp_add_server`, Phase 7 quality review, or Phase 8
 *      completion summary is still running. Showing it mid-turn races
 *      the agent and visually confuses the user ("is Rebel done or
 *      still running?"). Unlike real `AskUserQuestion` batches — where
 *      the agent pauses naturally — the synthetic build batch needs an
 *      explicit busy gate.
 *   2. `dismissedBatchId` — suppress batches the user has already
 *      dismissed via the X button on the footer question card.
 *
 * Extracted from the `SessionSurfaceContent` memo so the gate is unit
 * testable without a full render tree.
 *
 * @see docs/project/MCP_CONNECTOR_CONTRIBUTION_FLOW.md
 */

import type { UserQuestionBatch } from '@shared/types';

export interface McpBuildQuestionVisibilityInput<T extends Pick<UserQuestionBatch, 'batchId'>> {
  /** Synthesised batch (may be null when no contribution / no eligible phase). */
  batch: T | null | undefined;
  /** Batch id the user has explicitly dismissed via the footer X button. */
  dismissedBatchId: string | null;
  /** True while the agent is mid-turn. When true, the batch is suppressed. */
  isBusy: boolean;
}

export function computeVisibleMcpBuildQuestionBatch<T extends Pick<UserQuestionBatch, 'batchId'>>(
  input: McpBuildQuestionVisibilityInput<T>,
): T | null {
  const { batch, dismissedBatchId, isBusy } = input;
  if (isBusy) return null;
  if (!batch) return null;
  if (batch.batchId === dismissedBatchId) return null;
  return batch;
}

/**
 * Same shape as `computeVisibleMcpBuildQuestionBatch`, but ignores the
 * `isBusy` gate. Used by the minimized-question cleanup effects in
 * `SessionSurfaceContent` to identify which batch the minimized pill
 * refers to — even mid-turn, when the busy gate hides the visible batch.
 *
 * Background (260428 Stage 0 fix): the cleanup effects originally read
 * `visibleMcpBuildQuestionBatch?.batchId` to decide where to record a
 * dismissal on busy=false→true transitions (i.e. user typed a new
 * message instead of answering). But `visibleMcpBuildQuestionBatch` is
 * always `null` while `isBusy=true`, so the dismissal branch never
 * matched and the batch re-emerged as a footer card on the next idle.
 *
 * Render still uses the busy-gated value; only the match logic for
 * cleanup needs the un-gated view.
 */
export function computePendingMcpBuildQuestionBatch<T extends Pick<UserQuestionBatch, 'batchId'>>(
  input: Omit<McpBuildQuestionVisibilityInput<T>, 'isBusy'>,
): T | null {
  return computeVisibleMcpBuildQuestionBatch({ ...input, isBusy: false });
}
