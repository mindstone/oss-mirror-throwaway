// @vitest-environment happy-dom
/**
 * App.smoke.test.tsx — Tier A full-mount smoke (the primary App.tsx hardening
 * net). See docs/plans/260529_apptsx-hardening/subagent_reports/
 *   260529_233000_arbitrator-scoping-synthesis.md  (the plan)
 *   260529_230200_researcher-harness-feasibility-spike.md  (the proven recipe)
 *
 * Mounts the REAL `<App/>` (the 11k-LOC trunk) inside the production provider
 * stack via the shared harness and asserts it boots: `mountError === null`,
 * DOM non-empty, unmount clean. This catches the DOA-on-mount class (TDZ,
 * orphan-setter, ReferenceError, hallucinated-callback) on every CI run.
 *
 * TOLERANCE: the bare smoke uses undefined-resolve preload defaults, so ~19
 * benign caught async rejections occur (hooks log "Failed to load…"). We assert
 * ONLY on thrown / mountError, NEVER on console noise, so the test is not flaky.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';

// ── AtlasCanvas neutralisation (MUST be in this file: vi.mock hoists per-file;
// a vi.mock inside the imported harness module does NOT hoist into this test).
// AtlasCanvas statically imports three / react-force-graph-* which crash at
// module-eval under happy-dom. It is the ONLY such WebGL leaf in App's static
// graph. Mock it to a null-render component so the import chain advances.
// Mocked via the @renderer alias path — resolves to the same module file that
// AtlasView.tsx imports relatively (../../../atlas/components/AtlasCanvas).
vi.mock('@renderer/features/atlas/components/AtlasCanvas', () => ({
  AtlasCanvas: () => null,
}));

import { installPreloadBridges, mountApp } from './_harness/mountApp';

describe('App full-mount smoke', () => {
  let restoreBridges: (() => void) | null = null;
  let unmountApp: (() => void) | null = null;

  // The bare smoke seeds preload bridges with undefined-resolve defaults
  // (iter-6: never a value-Proxy). Most mount-effect hooks dereference the
  // resolved value inside their own try/catch and merely log "Failed to load…"
  // (the ~19 benign caught rejections the plan says to tolerate). The few that
  // dereference WITHOUT a .catch (e.g. useDemoMode reads `status.active`) are
  // given a primitive-safe faithful default in the harness (FAITHFUL_DEFAULTS)
  // so they neither throw at mount nor surface as unhandled rejections. We
  // therefore assert only on the real signal (mountError / throws), never on
  // console noise, so the smoke is not flaky.
  afterEach(() => {
    if (unmountApp) {
      unmountApp();
      unmountApp = null;
    }
    if (restoreBridges) {
      restoreBridges();
      restoreBridges = null;
    }
  });

  it('boots the real <App/> tree to its loading shell without throwing', () => {
    const bridges = installPreloadBridges();
    restoreBridges = bridges.restore;

    const { container, unmount, mountError } = mountApp();
    unmountApp = unmount;

    // Primary assertions: the tree must mount with no thrown error and produce
    // real DOM. We do NOT assert on console output (the ~19 benign caught async
    // "Failed to load…" rejections are expected with undefined-resolve bridges).
    //
    // SCOPE (honest): with undefined-resolve bridges the bare mount settles on
    // the homepage loading-splash skeleton, NOT the full main UI — so this is a
    // DOA-on-mount net (top-level TDZ / ReferenceError / orphan-setter /
    // hook-order all execute in App's body BEFORE the splash and would set
    // mountError), not a broad "rendered meaningful UI" assertion. The > 500
    // threshold is satisfied by the splash skeleton alone; that is intentional.
    expect(mountError).toBeNull();
    expect(container.innerHTML.length).toBeGreaterThan(500);

    // Fail-closed against an error-boundary fallback: App wraps each surface in
    // SurfaceErrorBoundary whose fallback renders "… ran into trouble" (also
    // > 500 chars). The bare smoke stops at the splash so this is latent today,
    // but assert it explicitly so the smoke can never green-light a swallowed
    // surface crash if a future change seeds enough bridges to render a surface.
    expect(container.innerHTML).not.toContain('ran into trouble');
  });

  it('unmounts cleanly without throwing', () => {
    const bridges = installPreloadBridges();
    restoreBridges = bridges.restore;

    const { unmount, mountError } = mountApp();
    expect(mountError).toBeNull();

    // Unmount should not throw (lifecycle cleanup, effect teardown).
    expect(() => unmount()).not.toThrow();
    unmountApp = null; // already unmounted
  });
});
