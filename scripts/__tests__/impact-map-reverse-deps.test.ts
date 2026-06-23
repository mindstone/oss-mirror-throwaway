/**
 * Unit tests for the pure reverse-dependency logic in
 * `scripts/generate-impact-map.ts` (CHIEF_ENGINEER2 Stage 1 / DI-2).
 *
 * Background: `madge <srcDir> --json` emits keys RELATIVE TO `srcDir`, not the
 * repo root. The old code inverted those bare/`../`-prefixed keys directly and
 * then flat-merged the five per-root maps with object spread (last-writer-wins).
 * That (a) made `classifySurface` classify everything as `'other'` (its
 * `startsWith('src/...')` checks never matched root-stripped keys) and (b)
 * silently clobbered colliding keys across roots, dropping ~23% of edges.
 *
 * These tests pin the pure logic that fixes both:
 *   - `normalizeMadgeKey` re-anchors intra-root AND cross-root (`../`) deps to
 *     repo-relative via `path.posix.normalize(join(srcDir, raw))`.
 *   - `parseMadgeToReverse` produces repo-relative keys.
 *   - `mergeReverseDeps` UNIONs (not clobbers) importer arrays per key.
 *   - `classifySurface` correctly classifies the normalized keys incl. `packages/`.
 *
 * @see scripts/generate-impact-map.ts
 * @see docs/plans/260613_impact-map-completeness/PLAN.md (Stage 1 / DI-2)
 */
import { describe, it, expect } from 'vitest';
import {
  normalizeMadgeKey,
  parseMadgeToReverse,
  mergeReverseDeps,
  classifySurface,
} from '../generate-impact-map';

describe('normalizeMadgeKey', () => {
  it('re-anchors an intra-root key to repo-relative', () => {
    expect(normalizeMadgeKey('App.tsx', 'src/renderer')).toBe('src/renderer/App.tsx');
    expect(normalizeMadgeKey('lib/knip-diff-guard.ts', 'scripts')).toBe('scripts/lib/knip-diff-guard.ts');
  });

  it('collapses a cross-root `../` dep to repo-relative (not a blind prepend)', () => {
    // src/main importing ../core/foo.ts must resolve to src/core/foo.ts,
    // NOT src/main/../core/foo.ts.
    expect(normalizeMadgeKey('../core/foo.ts', 'src/main')).toBe('src/core/foo.ts');
  });

  it('resolves the same cross-root dep identically regardless of scanned root', () => {
    // madge emits `../../cloud-client/x.ts` from src/main and `../cloud-client/x.ts`
    // from scripts — both must normalize to the same repo-relative key so the
    // union merge can combine their importers.
    const fromMain = normalizeMadgeKey('../../cloud-client/src/cloudClient.ts', 'src/main');
    const fromScripts = normalizeMadgeKey('../cloud-client/src/cloudClient.ts', 'scripts');
    expect(fromMain).toBe('cloud-client/src/cloudClient.ts');
    expect(fromScripts).toBe('cloud-client/src/cloudClient.ts');
    expect(fromMain).toBe(fromScripts);
  });
});

describe('parseMadgeToReverse', () => {
  it('produces repo-relative reverse-dep keys (not bare srcDir-relative)', () => {
    const forward = JSON.stringify({
      'App.tsx': ['components/Button.tsx'],
      'components/Button.tsx': [],
    });
    const reverse = parseMadgeToReverse(forward, 'src/renderer');
    // The dep (importee) becomes a repo-relative key whose importer is also repo-relative.
    expect(reverse['src/renderer/components/Button.tsx']).toEqual(['src/renderer/App.tsx']);
    // Every key is repo-relative; no bare keys leak through.
    for (const key of Object.keys(reverse)) {
      expect(key).not.toBe('App.tsx');
      expect(key).not.toBe('components/Button.tsx');
    }
  });

  it('resolves a cross-root `../` import to the correct repo-relative key', () => {
    // A src/main file imports src/core/logger.ts (emitted by madge as ../core/logger.ts).
    const forward = JSON.stringify({
      'services/foo.ts': ['../core/logger.ts'],
    });
    const reverse = parseMadgeToReverse(forward, 'src/main');
    expect(reverse['src/core/logger.ts']).toEqual(['src/main/services/foo.ts']);
    // The key is the CORRECT cross-root target, never a bare or `../`-mangled form.
    expect(Object.keys(reverse)).not.toContain('logger.ts');
    expect(Object.keys(reverse)).not.toContain('src/main/../core/logger.ts');
  });

  it('does not introduce self-edges', () => {
    const forward = JSON.stringify({ 'a.ts': ['b.ts'], 'b.ts': ['a.ts'] });
    const reverse = parseMadgeToReverse(forward, 'src/core');
    expect(reverse['src/core/a.ts']).not.toContain('src/core/a.ts');
    expect(reverse['src/core/b.ts']).not.toContain('src/core/b.ts');
  });
});

describe('mergeReverseDeps', () => {
  it('UNIONs importer lists for a key present in multiple roots (no clobber)', () => {
    // Simulates the real collision: src/shared/types.ts is imported from BOTH
    // a core scan and a shared scan. The old object-spread merge dropped one set;
    // the union merge must keep both.
    const coreMap = parseMadgeToReverse(
      JSON.stringify({ 'index.ts': ['../shared/types.ts'] }),
      'src/core',
    );
    const sharedMap = parseMadgeToReverse(
      JSON.stringify({ 'foo.ts': ['types.ts'] }),
      'src/shared',
    );
    // Both produce the same repo-relative key:
    expect(coreMap['src/shared/types.ts']).toEqual(['src/core/index.ts']);
    expect(sharedMap['src/shared/types.ts']).toEqual(['src/shared/foo.ts']);

    const merged = mergeReverseDeps(coreMap, sharedMap);
    expect(merged['src/shared/types.ts']).toEqual(
      expect.arrayContaining(['src/core/index.ts', 'src/shared/foo.ts']),
    );
    expect(merged['src/shared/types.ts']).toHaveLength(2);
  });

  it('dedupes identical importers across maps', () => {
    const a = { 'src/shared/x.ts': ['src/main/a.ts'] };
    const b = { 'src/shared/x.ts': ['src/main/a.ts', 'src/main/b.ts'] };
    const merged = mergeReverseDeps(a, b);
    expect(merged['src/shared/x.ts']).toEqual(['src/main/a.ts', 'src/main/b.ts']);
  });

  it('builds fresh arrays without mutating the input maps', () => {
    const a = { 'src/shared/x.ts': ['src/main/a.ts'] };
    const b = { 'src/shared/x.ts': ['src/main/b.ts'] };
    const merged = mergeReverseDeps(a, b);
    expect(a['src/shared/x.ts']).toEqual(['src/main/a.ts']);
    expect(b['src/shared/x.ts']).toEqual(['src/main/b.ts']);
    expect(merged['src/shared/x.ts']).not.toBe(a['src/shared/x.ts']);
  });
});

describe('classifySurface', () => {
  it('classifies normalized repo-relative keys from each root', () => {
    expect(classifySurface('src/core/logger.ts')).toBe('core');
    expect(classifySurface('src/main/index.ts')).toBe('main');
    expect(classifySurface('src/renderer/App.tsx')).toBe('renderer');
    expect(classifySurface('src/shared/types.ts')).toBe('shared');
    expect(classifySurface('src/preload/index.ts')).toBe('preload');
    expect(classifySurface('cloud-service/server.ts')).toBe('cloud');
    expect(classifySurface('cloud-client/src/cloudClient.ts')).toBe('cloud-client');
    expect(classifySurface('mobile/App.tsx')).toBe('mobile');
    expect(classifySurface('scripts/generate-impact-map.ts')).toBe('scripts');
    expect(classifySurface('evals/foo.ts')).toBe('evals');
  });

  it('classifies packages/ keys as `packages` (not `other`)', () => {
    expect(classifySurface('packages/shared/src/index.ts')).toBe('packages');
    expect(classifySurface('packages/browser-extension/src/foo.ts')).toBe('packages');
  });

  it('returns `other` only for genuinely unrecognized paths', () => {
    expect(classifySurface('node_modules/x/index.js')).toBe('other');
    expect(classifySurface('../escaped/x.ts')).toBe('other');
  });
});
