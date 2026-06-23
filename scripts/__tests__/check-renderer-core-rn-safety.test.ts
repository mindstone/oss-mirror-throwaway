/**
 * Unit tests for the renderer-reachable Node-only RN-safety reachability checker.
 *
 * The renderer check REUSES the mobile check's graph engine (analyzeSource /
 * walkReachability / filterAllowlisted) — those are tested in
 * check-mobile-core-rn-safety.test.ts. This suite covers the renderer-SPECIFIC
 * parts:
 *   1. `filterRendererPoison()` — the surface difference: Node built-ins / pino
 *      are poison, but `import.meta` / `createRequire` are NOT (browser/Vite
 *      runs them fine; only Hermes parse-fatals on import.meta).
 *   2. `readRendererAliasRules()` — parses tsconfig.renderer.json (JSONC, with the
 *      `/*` in path globs like "@/*") and resolves `@core/*` → src/core, repo-relative.
 *   3. An end-to-end `walkReachability` + `filterRendererPoison` over an in-memory
 *      fixture proving the Stage-2 leak shape (renderer → core → @core/logger →
 *      node:fs) is FLAGGED while a browser-safe import.meta use is NOT.
 *
 * @see scripts/check-renderer-core-rn-safety.ts
 * @see scripts/check-mobile-core-rn-safety.ts (the shared engine)
 * @see docs/plans/260622_fix-message-render-drop/PLAN.md Stage 4
 */
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  analyzeSource,
  buildAliasRules,
  walkReachability,
  type AliasRule,
  type FileSystemLike,
  type Violation,
} from '../check-mobile-core-rn-safety';
import {
  filterRendererPoison,
  readRendererAliasRules,
} from '../check-renderer-core-rn-safety';

// ---------------------------------------------------------------------------
// filterRendererPoison — the surface difference
// ---------------------------------------------------------------------------

describe('filterRendererPoison — renderer poison subset', () => {
  const v = (reasons: string[]): Violation => ({
    poison: 'src/core/x.ts',
    reasons,
    chain: ['src/renderer/a.tsx', 'src/core/x.ts'],
  });

  it('keeps a node:* builtin reason (renderer-fatal)', () => {
    const out = filterRendererPoison([v(["imports Node builtin 'node:fs'"])]);
    expect(out).toHaveLength(1);
    expect(out[0].reasons).toEqual(["imports Node builtin 'node:fs'"]);
  });

  it('keeps a bare Node builtin reason', () => {
    const out = filterRendererPoison([v(["imports Node builtin 'path'"])]);
    expect(out).toHaveLength(1);
  });

  it("keeps a 'pino' reason", () => {
    const out = filterRendererPoison([v(["imports 'pino'"])]);
    expect(out).toHaveLength(1);
  });

  it('DROPS an import.meta-only violation (browser/Vite-safe, not Hermes)', () => {
    const out = filterRendererPoison([v(['uses import.meta'])]);
    expect(out).toHaveLength(0);
  });

  it('DROPS a createRequire-only violation (browser-safe on this surface)', () => {
    const out = filterRendererPoison([v(['uses createRequire'])]);
    expect(out).toHaveLength(0);
  });

  it('keeps only the Node-only reasons on a mixed violation (drops import.meta, keeps node:fs)', () => {
    const out = filterRendererPoison([
      v(['uses import.meta', "imports Node builtin 'node:fs'", 'uses createRequire']),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].reasons).toEqual(["imports Node builtin 'node:fs'"]);
  });
});

// ---------------------------------------------------------------------------
// readRendererAliasRules — parses the real tsconfig.renderer.json (JSONC)
// ---------------------------------------------------------------------------

describe('readRendererAliasRules — real tsconfig.renderer.json', () => {
  it('parses JSONC (path globs with /*) and resolves @core/* to src/core repo-relative', () => {
    const rules = readRendererAliasRules();
    const core = rules.find((r) => r.prefix === '@core/');
    expect(core).toBeDefined();
    expect(core!.exact).toBe(false);
    expect(core!.targetBase.replaceAll('\\', '/')).toMatch(/\/src\/core$/);

    const shared = rules.find((r) => r.prefix === '@shared/');
    expect(shared).toBeDefined();
    expect(shared!.targetBase.replaceAll('\\', '/')).toMatch(/\/src\/shared$/);
  });
});

// ---------------------------------------------------------------------------
// End-to-end: walkReachability + filterRendererPoison over a fixture
// ---------------------------------------------------------------------------

describe('renderer reachability (engine + renderer poison filter) over a fixture', () => {
  const REPO = '/repo';
  const RENDERER = path.join(REPO, 'src', 'renderer');

  // Mirror the renderer alias layout (repo-relative, baseDir = repo root).
  const rules: AliasRule[] = buildAliasRules(
    {
      '@core/*': ['./src/core/*'],
      '@shared/*': ['./src/shared/*'],
    },
    REPO,
  );

  const isRendererEntry = (p: string): boolean => p.startsWith(RENDERER);

  function makeFs(files: Record<string, string>): FileSystemLike {
    const norm = (p: string) => p.replaceAll('\\', '/');
    const set = new Set(Object.keys(files).map(norm));
    return {
      existsSync: (p) => set.has(norm(p)),
      isFile: (p) => set.has(norm(p)),
      isDirectory: () => false,
      readFileSync: (p) => files[norm(p)] ?? '',
    };
  }

  it('FLAGS the Stage-2 leak shape: renderer → core guard → @core/logger → node:fs', () => {
    const files: Record<string, string> = {
      [`${RENDERER}/store/sessionStore.ts`]:
        `import { guard } from '@core/services/sessionMergeUtils';\nexport const x = guard;`,
      [`${REPO}/src/core/services/sessionMergeUtils.ts`]:
        `import { log } from '@core/logger';\nexport const guard = () => log;`,
      [`${REPO}/src/core/logger.ts`]:
        `import fs from 'node:fs';\nexport const log = fs;`,
    };
    const fs = makeFs(files);
    const result = walkReachability([`${RENDERER}/store/sessionStore.ts`], rules, {
      repoRoot: REPO,
      isEntry: isRendererEntry,
      fs,
    });
    const rendererViolations = filterRendererPoison(result.violations);
    expect(rendererViolations).toHaveLength(1);
    expect(rendererViolations[0].poison).toBe('src/core/logger.ts');
    expect(rendererViolations[0].reasons).toContain("imports Node builtin 'node:fs'");
    expect(rendererViolations[0].chain).toEqual([
      'src/renderer/store/sessionStore.ts',
      'src/core/services/sessionMergeUtils.ts',
      'src/core/logger.ts',
    ]);
  });

  it('does NOT flag a renderer-safe @core import that only uses import.meta (the clean Stage-2 fix shape)', () => {
    const files: Record<string, string> = {
      [`${RENDERER}/store/sessionStore.ts`]:
        `import { guard } from '@core/services/sessionIngestGuard';\nexport const x = guard;`,
      [`${REPO}/src/core/services/sessionIngestGuard.ts`]:
        `import { isValidSeq } from '@shared/utils/eventIdentity';\nexport const guard = isValidSeq;`,
      [`${REPO}/src/shared/utils/eventIdentity.ts`]:
        `const u = import.meta.url; void u;\nexport const isValidSeq = (n: number) => n > 0;`,
    };
    const fs = makeFs(files);
    const result = walkReachability([`${RENDERER}/store/sessionStore.ts`], rules, {
      repoRoot: REPO,
      isEntry: isRendererEntry,
      fs,
    });
    // The engine records the import.meta use, but the renderer filter drops it.
    expect(filterRendererPoison(result.violations)).toHaveLength(0);
  });

  it('does NOT flag a type-only import of @core/logger (erased, no runtime pull)', () => {
    const files: Record<string, string> = {
      [`${RENDERER}/store/sessionStore.ts`]:
        `import type { Logger } from '@core/logger';\nexport type X = Logger;`,
      [`${REPO}/src/core/logger.ts`]:
        `import fs from 'node:fs';\nexport type Logger = typeof fs;`,
    };
    const fs = makeFs(files);
    const result = walkReachability([`${RENDERER}/store/sessionStore.ts`], rules, {
      repoRoot: REPO,
      isEntry: isRendererEntry,
      fs,
    });
    // The type-only edge is not followed, so logger.ts is never reached.
    expect(filterRendererPoison(result.violations)).toHaveLength(0);
  });

  // Precedent false-negative #1 (pinned for the renderer surface): a renderer
  // ENTRY file that DIRECTLY imports a poison module must be flagged — not
  // silently skipped because it is an entry root (the mobile engine's F2 fix).
  it('FLAGS a renderer entry file that DIRECTLY imports node:fs (entry-file poison)', () => {
    const files: Record<string, string> = {
      [`${RENDERER}/main.tsx`]: `import fs from 'node:fs';\nexport const x = fs;`,
    };
    const fs = makeFs(files);
    const result = walkReachability([`${RENDERER}/main.tsx`], rules, {
      repoRoot: REPO,
      isEntry: isRendererEntry,
      fs,
    });
    const violations = filterRendererPoison(result.violations);
    expect(violations).toHaveLength(1);
    expect(violations[0].poison).toBe('src/renderer/main.tsx');
    expect(violations[0].reasons).toContain("imports Node builtin 'node:fs'");
  });

  // Precedent false-negative #2 (pinned): a renderer-reachable barrel that
  // re-exports a poison module via `export * from` must be flagged — the engine
  // follows value re-export edges (incl. `export *`), so the poison is reached
  // transitively through the barrel.
  it('FLAGS a renderer-reachable `export * from` barrel that re-exports a poison module', () => {
    const files: Record<string, string> = {
      [`${RENDERER}/store/sessionStore.ts`]:
        `import { something } from '@core/services/barrel';\nexport const x = something;`,
      [`${REPO}/src/core/services/barrel.ts`]:
        `export * from '@core/logger';`,
      [`${REPO}/src/core/logger.ts`]:
        `import fs from 'node:fs';\nexport const something = fs;`,
    };
    const fs = makeFs(files);
    const result = walkReachability([`${RENDERER}/store/sessionStore.ts`], rules, {
      repoRoot: REPO,
      isEntry: isRendererEntry,
      fs,
    });
    const violations = filterRendererPoison(result.violations);
    expect(violations).toHaveLength(1);
    expect(violations[0].poison).toBe('src/core/logger.ts');
    expect(violations[0].reasons).toContain("imports Node builtin 'node:fs'");
    // The chain runs through the barrel via the export-* edge.
    expect(violations[0].chain).toEqual([
      'src/renderer/store/sessionStore.ts',
      'src/core/services/barrel.ts',
      'src/core/logger.ts',
    ]);
  });

  it('sanity: analyzeSource still detects node:fs and import.meta (engine unchanged)', () => {
    expect(analyzeSource(`import fs from 'node:fs';`, 'x.ts').poisonReasons).toContain(
      "imports Node builtin 'node:fs'",
    );
    expect(analyzeSource(`const u = import.meta.url; void u;`, 'x.ts').poisonReasons).toContain(
      'uses import.meta',
    );
  });
});
