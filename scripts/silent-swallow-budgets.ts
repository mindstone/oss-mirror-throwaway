import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_ESLINT_PATHS } from './lib/eslint-warning-audit';
import { SILENT_SWALLOW_SURFACE_COVERAGE } from './silentSwallowSurfaceCoverage.mjs';

export const SILENT_SWALLOW_RULE_ID = 'rebel-silent-swallow/no-silent-swallow';

// The silent-swallow COUNT baselines (global `BASELINE_SILENT_SWALLOW`, the
// per-surface `SILENT_SWALLOW_SURFACE_BASELINES`, and the per-file
// `SILENT_SWALLOW_FILE_BUDGETS`) were retired in Stage 3 of
// docs/plans/260612_silent-swallow-gate/PLAN.md (decision D1). They were a hot,
// drift-reconciled number that caused merge contention on nearly every weekly
// review / merge. New swallows are now caught per-change by the diff-scoped
// `validate:eslint-new-warnings` gate (Stage 1), the `npm run lint
// --max-warnings 3000` total cap is the coarse mass-regression backstop, and
// rule-presence is asserted by silent-swallow-rule-presence.test.ts (Stage 2).
// This module retains only the path helpers and the surface-PARITY guard
// (`checkSilentSwallowSurfaceParity`) — parity is orthogonal to the count
// baselines and still wanted (it turns a silently-uncovered new lint surface
// into a loud CI failure).

/**
 * Repo root, computed from this module's own location (`scripts/` → repo root)
 * so it does NOT depend on `process.cwd()`. ESLint emits absolute file paths
 * under this root; relativising against it preserves the surface prefix
 * (`cloud-service/src/x.ts`, never collapsed to `src/x.ts`) and is immune to
 * ancestor directories or a repo directory name that happens to contain a
 * surface token like `src` or `cloud-service` (the historical `lastIndexOf('/src/')`
 * bug — see docs/plans/260531_silent_swallow_lint_surface_coverage.md A-F3).
 */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Recognised top-level surfaces, derived from the single source of truth
 * (`DEFAULT_ESLINT_PATHS` in eslint-warning-audit). Each audit path's first
 * segment is the surface key — `mobile/src/` and `mobile/app/` both map to
 * `mobile`. Deriving from the SSoT means adding a lint surface there
 * automatically updates surface detection here (no second hand-maintained list).
 */
export const KNOWN_SURFACES: ReadonlySet<string> = new Set(
  DEFAULT_ESLINT_PATHS
    .map((p) => p.replace(/\\/g, '/').replace(/^\.?\//, '').split('/')[0])
    .filter((segment): segment is string => Boolean(segment)),
);

/**
 * Fallback for paths that are NOT under `REPO_ROOT` (already-relative paths, or
 * synthetic test fixtures): slice from the EARLIEST path segment that is a known
 * surface, preserving that surface prefix. Earliest-by-position (not by
 * surface-list order) so `src/components/mobile/x.ts` stays `src/...`, not
 * `mobile/...`.
 */
function stripLeadingSurfaceSegment(normalized: string): string {
  const segments = normalized.replace(/^\.?\//, '').split('/');
  const surfaceIndex = segments.findIndex((segment) => KNOWN_SURFACES.has(segment));
  if (surfaceIndex >= 0) {
    return segments.slice(surfaceIndex).join('/');
  }
  return segments.join('/');
}

/**
 * Normalise an ESLint-reported file path to a repo-relative, surface-prefixed
 * key (e.g. `cloud-service/src/bootstrap.ts`). Real audit paths are absolute and
 * under `REPO_ROOT`, so the repo-root strip is the primary path; the
 * surface-segment fallback covers relative/synthetic inputs. `repoRoot` is
 * injectable for tests.
 */
export function normalizePath(filePath: string, repoRoot: string = REPO_ROOT): string {
  const normalized = filePath.replaceAll('\\', '/');
  const root = repoRoot.replaceAll('\\', '/').replace(/\/+$/, '');
  if (root.length > 0 && normalized.startsWith(`${root}/`)) {
    return normalized.slice(root.length + 1);
  }
  return stripLeadingSurfaceSegment(normalized);
}

/**
 * The top-level surface a normalised path belongs to (`cloud-service`, `src`,
 * `mobile`, …), or `null` if it is not under a recognised surface.
 */
export function surfaceOf(normalizedPath: string): string | null {
  const first = normalizedPath.replace(/^\.?\//, '').split('/')[0];
  return first && KNOWN_SURFACES.has(first) ? first : null;
}

// ─── Surface coverage parity guard (A-F2) ────────────────────────────────────
// The historical coverage gap (rule fired only on src/** while the audit linted
// more surfaces) can silently recur whenever a NEW surface is added to the
// audit's DEFAULT_ESLINT_PATHS without anyone classifying it for this rule. This
// guard asserts every audited surface is classified (covered OR explicitly
// exempt) — turning a silent miss into a loud CI failure.
// See docs/plans/260531_silent_swallow_lint_surface_coverage.md A-F2.

export interface SilentSwallowSurfaceParityResult {
  failed: boolean;
  unclassified: string[];
}

export function auditedSurfaces(
  auditPaths: readonly string[] = DEFAULT_ESLINT_PATHS,
): string[] {
  const surfaces = new Set<string>();
  for (const auditPath of auditPaths) {
    const first = auditPath.replace(/\\/g, '/').replace(/^\.?\//, '').split('/')[0];
    if (first) surfaces.add(first);
  }
  return [...surfaces];
}

export function checkSilentSwallowSurfaceParity(
  auditPaths: readonly string[] = DEFAULT_ESLINT_PATHS,
): SilentSwallowSurfaceParityResult {
  const classified = new Set(Object.keys(SILENT_SWALLOW_SURFACE_COVERAGE));
  const unclassified = auditedSurfaces(auditPaths).filter((surface) => !classified.has(surface));
  return { failed: unclassified.length > 0, unclassified };
}

export function formatSilentSwallowSurfaceParityReport(
  result: SilentSwallowSurfaceParityResult,
): string {
  if (!result.failed) {
    return 'Silent-swallow surface parity passed (every audited surface is classified).';
  }
  return [
    'Silent-swallow surface parity FAILED.',
    `✘ Audited but unclassified surfaces: ${result.unclassified.join(', ')}`,
    'Classify each in scripts/silentSwallowSurfaceCoverage.mjs as covered or { exempt: <reason> }.',
  ].join('\n');
}
