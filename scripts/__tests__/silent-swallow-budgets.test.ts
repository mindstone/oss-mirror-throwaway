import { describe, expect, it } from 'vitest';
import {
  KNOWN_SURFACES,
  checkSilentSwallowSurfaceParity,
  normalizePath,
  surfaceOf,
} from '../silent-swallow-budgets';
import {
  SILENT_SWALLOW_SURFACE_COVERAGE,
  coveredSilentSwallowGlobs,
} from '../silentSwallowSurfaceCoverage.mjs';

const REPO = '/Users/dev/rebel-app';

describe('normalizePath — repo-root relativisation', () => {
  it('relativises a root src file under the repo root', () => {
    expect(normalizePath(`${REPO}/src/main/index.ts`, REPO)).toBe('src/main/index.ts');
  });

  it('relativises nested src paths consistently', () => {
    // (Formerly the "3 hot-file budget keys" test; the per-file budgets were
    // retired 2026-06-12 — docs/plans/260612_silent-swallow-gate/PLAN.md. These
    // remain useful normalizePath cases for deeply-nested src paths.)
    expect(normalizePath(`${REPO}/src/main/services/mcpService.ts`, REPO)).toBe(
      'src/main/services/mcpService.ts',
    );
    expect(normalizePath(`${REPO}/src/main/index.ts`, REPO)).toBe('src/main/index.ts');
    expect(normalizePath(`${REPO}/src/main/services/cloud/cloudRouter.ts`, REPO)).toBe(
      'src/main/services/cloud/cloudRouter.ts',
    );
  });

  it('does NOT collapse cloud-service/src to src (the historical bug)', () => {
    expect(normalizePath(`${REPO}/cloud-service/src/bootstrap.ts`, REPO)).toBe(
      'cloud-service/src/bootstrap.ts',
    );
  });

  it('defeats the repo-directory-name trap (dir name contains "cloud-service")', () => {
    const wt = '/Users/dev/rebel-app-260531_silent-swallow-cloud-service';
    expect(normalizePath(`${wt}/cloud-service/src/x.ts`, wt)).toBe('cloud-service/src/x.ts');
  });

  it('defeats the ancestor-directory-named-src trap', () => {
    const root = '/home/src/repo';
    expect(normalizePath(`${root}/cloud-service/src/x.ts`, root)).toBe('cloud-service/src/x.ts');
    expect(normalizePath(`${root}/src/a.ts`, root)).toBe('src/a.ts');
  });

  it('does not mis-anchor on a nested "mobile" segment under src', () => {
    expect(normalizePath(`${REPO}/src/components/mobile/Widget.ts`, REPO)).toBe(
      'src/components/mobile/Widget.ts',
    );
  });

  it('handles Windows backslash paths', () => {
    expect(normalizePath('C:\\Users\\dev\\rebel-app\\src\\a.ts', 'C:\\Users\\dev\\rebel-app')).toBe(
      'src/a.ts',
    );
  });

  it('falls back to earliest known surface for synthetic/relative paths not under repoRoot', () => {
    // The existing ratchet tests pass paths like /repo/src/... — keep them working.
    expect(normalizePath('/repo/src/main/index.ts')).toBe('src/main/index.ts');
    expect(normalizePath('/repo/private/mindstone/src/bootstrap.ts')).toBe(
      'private/mindstone/src/bootstrap.ts',
    );
    expect(normalizePath('/repo/cloud-service/src/x.ts')).toBe('cloud-service/src/x.ts');
    expect(normalizePath('mobile/app/_layout.tsx')).toBe('mobile/app/_layout.tsx');
    expect(normalizePath('cloud-client/src/api.ts')).toBe('cloud-client/src/api.ts');
  });

  it('returns the trimmed path when no known surface is present', () => {
    expect(normalizePath('/tmp/scratch/file.ts')).toBe('tmp/scratch/file.ts');
  });
});

describe('KNOWN_SURFACES — derived from DEFAULT_ESLINT_PATHS', () => {
  it('includes every first-party linted surface', () => {
    expect(KNOWN_SURFACES.has('src')).toBe(true);
    expect(KNOWN_SURFACES.has('private')).toBe(true);
    expect(KNOWN_SURFACES.has('cloud-service')).toBe(true);
    expect(KNOWN_SURFACES.has('cloud-client')).toBe(true);
    expect(KNOWN_SURFACES.has('mobile')).toBe(true);
    expect(KNOWN_SURFACES.has('evals')).toBe(true);
  });
});

describe('surfaceOf', () => {
  it('maps a normalised path to its surface key', () => {
    expect(surfaceOf('cloud-service/src/bootstrap.ts')).toBe('cloud-service');
    expect(surfaceOf('private/mindstone/src/bootstrap.ts')).toBe('private');
    expect(surfaceOf('src/main/index.ts')).toBe('src');
    expect(surfaceOf('mobile/app/_layout.tsx')).toBe('mobile');
    expect(surfaceOf('mobile/src/foo.ts')).toBe('mobile');
    expect(surfaceOf('evals/harness.ts')).toBe('evals');
  });

  it('returns null for paths outside recognised surfaces', () => {
    expect(surfaceOf('tmp/scratch/file.ts')).toBeNull();
  });
});

describe('coveredSilentSwallowGlobs — every covered surface contributes globs', () => {
  it('emits globs for each covered surface plus the fixtures (no covered surface is silently unlinted)', () => {
    const globs = coveredSilentSwallowGlobs();
    const coveredSurfaces = Object.entries(SILENT_SWALLOW_SURFACE_COVERAGE)
      .filter(([, coverage]) => coverage === 'covered')
      .map(([surface]) => surface);
    // Each covered surface must contribute at least one glob mentioning it.
    for (const surface of coveredSurfaces) {
      expect(globs.some((glob) => glob.startsWith(`${surface}/`))).toBe(true);
    }
    // Fixtures are always linted (the rule's own self-test corpus).
    expect(globs.some((glob) => glob.includes('__fixtures__/silent-swallow'))).toBe(true);
    // No empty/malformed globs.
    expect(globs.every((glob) => typeof glob === 'string' && glob.length > 0)).toBe(true);
  });
});

describe('checkSilentSwallowSurfaceParity — no silently-uncovered surface (A-F2)', () => {
  it('passes when every audited surface is classified (the real DEFAULT_ESLINT_PATHS)', () => {
    expect(checkSilentSwallowSurfaceParity().failed).toBe(false);
  });

  it('fails loudly when an audited surface is not classified in the coverage SSoT', () => {
    const result = checkSilentSwallowSurfaceParity([
      'src/',
      'cloud-service/src/',
      'packages/widget/src/', // unclassified surface
    ]);
    expect(result.failed).toBe(true);
    expect(result.unclassified).toContain('packages');
  });
});
