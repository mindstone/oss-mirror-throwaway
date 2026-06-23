// Single source of truth for which first-party lint surfaces the
// `rebel-silent-swallow/no-silent-swallow` rule covers, plus the ESLint `files`
// globs derived from that classification.
//
// Consumed by:
//   - eslint.config.mjs                  → builds the rule block's `files` glob
//   - scripts/silent-swallow-budgets.ts  → surface-parity guard (every audited
//                                           surface must be classified)
//   - scripts/__tests__/silent-swallow-rule-presence.test.ts → asserts the rule
//                                           actually fires on each covered surface
//
// NOTE (2026-06-12): the per-surface COUNT baselines this module used to drive
// were retired (docs/plans/260612_silent-swallow-gate/PLAN.md). The coverage
// classification below no longer feeds any count ratchet; it drives the parity
// guard + the rule-presence smoke only. Enforcement of new swallows is now the
// diff-scoped `validate:eslint-new-warnings` gate.
//
// Why a single source of truth: the historical coverage gap (the rule fired only
// on `src/**` while the audit linted cloud-service/cloud-client/mobile/evals too)
// happened because "which surfaces does the rule cover" was implicit in a glob
// maintained separately from the audit's surface list. Deriving the glob here and
// asserting (in the parity guard) that every audited surface is classified turns
// a silently-uncovered surface into a loud CI failure.
//
// Surfaces correspond 1:1 to the first path segment of `DEFAULT_ESLINT_PATHS`
// in scripts/lib/eslint-warning-audit.ts (`mobile/src/` and `mobile/app/` both
// map to `mobile`). Adding a NEW audited surface there without classifying it
// here makes `checkSilentSwallowSurfaceParity()` fail.
//
// See docs/plans/260531_silent_swallow_lint_surface_coverage.md.

/** ESLint `files` globs for each recognised surface. */
const SURFACE_GLOBS = {
  src: ['src/**/*.ts', 'src/**/*.tsx'],
  private: ['private/mindstone/src/**/*.ts', 'private/mindstone/src/**/*.tsx'],
  'cloud-service': ['cloud-service/src/**/*.ts', 'cloud-service/src/**/*.tsx'],
  'cloud-client': ['cloud-client/src/**/*.ts', 'cloud-client/src/**/*.tsx'],
  mobile: [
    'mobile/src/**/*.ts',
    'mobile/src/**/*.tsx',
    'mobile/app/**/*.ts',
    'mobile/app/**/*.tsx',
  ],
  evals: ['evals/**/*.ts', 'evals/**/*.tsx'],
};

/**
 * Coverage classification per surface.
 *   'covered'       → the rule fires here (asserted by the rule-presence smoke);
 *                      the diff-scoped gate catches new swallows in changed files.
 *   { exempt: ... }  → deliberately not covered yet, with a recorded reason
 *                      (a VISIBLE exemption, not a silent gap).
 *
 * src + private/mindstone + cloud-service + cloud-client + mobile are covered;
 * evals is a tracked, visible deferral (eval-harness, not product/client code).
 * (No per-surface count baseline is attached — those were retired 2026-06-12.)
 */
export const SILENT_SWALLOW_SURFACE_COVERAGE = {
  src: 'covered',
  private: 'covered',
  'cloud-service': 'covered',
  'cloud-client': 'covered',
  mobile: 'covered',
  evals: {
    exempt:
      'Eval-harness/tooling, not product or client code (DI-A). Promote to covered if "all first-party TS" is later extended to the eval harness.',
  },
};

/** Fixtures the rule must always lint (its own self-test corpus). */
export const SILENT_SWALLOW_FIXTURE_GLOBS = ['scripts/__fixtures__/silent-swallow/**/*.ts'];

/**
 * The `files` globs for every covered surface, plus the rule's fixtures.
 *
 * Fails loudly (throws at eslint config-load time) if a surface is marked
 * 'covered' but has no SURFACE_GLOBS entry — otherwise the rule would silently
 * never lint that surface, which is the exact silent-coverage gap this whole
 * module exists to prevent.
 */
export function coveredSilentSwallowGlobs() {
  const globs = [];
  for (const [surface, coverage] of Object.entries(SILENT_SWALLOW_SURFACE_COVERAGE)) {
    if (coverage === 'covered') {
      const surfaceGlobs = SURFACE_GLOBS[surface];
      if (!surfaceGlobs || surfaceGlobs.length === 0) {
        throw new Error(
          `silentSwallowSurfaceCoverage: surface "${surface}" is 'covered' but has no SURFACE_GLOBS entry. `
          + 'Add its globs so the rule actually lints it (a covered-but-unlinted surface is a silent gap).',
        );
      }
      globs.push(...surfaceGlobs);
    }
  }
  globs.push(...SILENT_SWALLOW_FIXTURE_GLOBS);
  return globs;
}

/** Surfaces the rule currently covers (used by the parity guard + rule-presence smoke). */
export function coveredSilentSwallowSurfaces() {
  return Object.entries(SILENT_SWALLOW_SURFACE_COVERAGE)
    .filter(([, coverage]) => coverage === 'covered')
    .map(([surface]) => surface);
}
