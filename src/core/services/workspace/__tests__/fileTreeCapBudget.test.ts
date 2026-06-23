import { describe, expect, it } from 'vitest';

import {
  MAX_FILE_TREE_NODES,
  MAX_FILE_TREE_ESTIMATED_BYTES,
  RENDERER_RETAINED_BYTES_PER_NODE,
  RENDERER_HEAP_SAFE_BUDGET_BYTES,
} from '@core/constants';

/**
 * Deterministic standing gate for Bug-2 Rec #2 (260616 renderer-OOM diagnosis,
 * docs/plans/260616_stuck-library-renderer-oom/PLAN.md).
 *
 * The Library file tree is held in the renderer across several full-scale
 * derivations (tree + flatten + path map + facets + Fuse index). The 260616 OOM
 * was the renderer crash-looping at V8's 4 GiB ceiling because the producer had
 * no global node cap. The fix added `MAX_FILE_TREE_NODES` so an unbounded tree
 * is unrepresentable downstream.
 *
 * This test converts "the cap keeps the renderer safely under the heap budget"
 * from a one-time diagnosis into a release gate: it reddens CI if a future
 * change raises `MAX_FILE_TREE_NODES` (or `MAX_FILE_TREE_ESTIMATED_BYTES`) past
 * the safe envelope, silently re-opening the OOM.
 *
 * It is PURE constant arithmetic by design — no `process.memoryUsage`, no GC, no
 * heap snapshot, no async. The runtime heap-measurement gate (which catches a
 * *new* derivation re-bloating the per-node multiplier without changing
 * constants) is a separately spun-out harness.
 */
describe('file-tree cap renderer-heap budget (260616 OOM gate)', () => {
  // Largest node count whose retained set still fits the reserved budget.
  const safeMaxNodes = Math.floor(RENDERER_HEAP_SAFE_BUDGET_BYTES / RENDERER_RETAINED_BYTES_PER_NODE);

  it('the configured node cap keeps the renderer within the safe heap budget', () => {
    const retainedAtCap = MAX_FILE_TREE_NODES * RENDERER_RETAINED_BYTES_PER_NODE;

    // Assert via a throwing check so the failure message is always actionable
    // (Vitest's toBeLessThanOrEqual just prints the numbers, not the why/how).
    if (retainedAtCap > RENDERER_HEAP_SAFE_BUDGET_BYTES) {
      throw new Error(
        `MAX_FILE_TREE_NODES=${MAX_FILE_TREE_NODES} × ${RENDERER_RETAINED_BYTES_PER_NODE} B/node = ` +
          `${retainedAtCap} B retained, exceeding the ${RENDERER_HEAP_SAFE_BUDGET_BYTES} B renderer budget. ` +
          `Raising MAX_FILE_TREE_NODES above ~${safeMaxNodes} re-risks the renderer OOM ` +
          `(260616 diagnosis, docs/plans/260616_stuck-library-renderer-oom/PLAN.md). ` +
          `If intentional, re-measure RENDERER_RETAINED_BYTES_PER_NODE and adjust ` +
          `RENDERER_HEAP_SAFE_BUDGET_BYTES.`,
      );
    }
    expect(retainedAtCap).toBeLessThanOrEqual(RENDERER_HEAP_SAFE_BUDGET_BYTES);
  });

  it('the configured byte cap is coherent with the safe heap budget', () => {
    // The estimated-byte producer cap is a lower-bound estimate of on-the-wire
    // size, not the renderer's retained set, but it must not on its own exceed
    // the renderer budget — a sanity tie so the two caps can't drift apart.
    expect(MAX_FILE_TREE_ESTIMATED_BYTES).toBeLessThanOrEqual(RENDERER_HEAP_SAFE_BUDGET_BYTES);
  });

  it('documents substantial headroom under the safe-max node count', () => {
    // The configured cap (100k) is ~Nx under the safe max (~1.27M nodes), so a
    // normal cap nudge stays safe; this records the headroom so a future reader
    // sees how much margin exists before the gate would bite.
    expect(MAX_FILE_TREE_NODES).toBeLessThan(safeMaxNodes);
    const headroomFactor = safeMaxNodes / MAX_FILE_TREE_NODES;
    expect(headroomFactor).toBeGreaterThan(2);
  });
});
