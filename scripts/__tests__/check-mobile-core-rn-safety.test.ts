/**
 * Unit tests for the mobile-reachable Node-only RN-safety reachability checker.
 *
 * Two layers:
 *   1. `analyzeSource()` — the pure AST detector (poison reasons + value edges),
 *      driven with source strings (mirrors check-mobile-barrel-imports.test.ts).
 *   2. `walkReachability()` — the bounded BFS, driven with an in-memory
 *      `FileSystemLike` fixture so the four spike-demonstrated behaviors are
 *      tested WITHOUT mutating real source:
 *        (a) a poison import in a mobile-reachable core module is FLAGGED w/ chain;
 *        (b) a type-only import is NOT flagged;
 *        (c) the clean tree (legit RN-safe @core imports) yields ZERO;
 *        (d) a transitive leak via the cloud-client barrel IS flagged.
 *
 * @see scripts/check-mobile-core-rn-safety.ts
 * @see docs/plans/260622_mobile-core-boundary-lint/PLAN.md (Stage C2)
 */
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  analyzeSource,
  buildAliasRules,
  resolveSpecifier,
  walkReachability,
  filterAllowlisted,
  ALLOWLIST,
  type AliasRule,
  type FileSystemLike,
  type Violation,
} from '../check-mobile-core-rn-safety';

// ---------------------------------------------------------------------------
// Layer 1: analyzeSource — pure AST detector
// ---------------------------------------------------------------------------

describe('analyzeSource — poison detection (value imports flag)', () => {
  it('flags a value import of a node:* builtin', () => {
    const { poisonReasons } = analyzeSource(`import fs from 'node:fs';`, 'src/core/x.ts');
    expect(poisonReasons).toContain("imports Node builtin 'node:fs'");
  });

  it('flags a side-effect import of a node:* builtin', () => {
    const { poisonReasons } = analyzeSource(`import 'node:async_hooks';`, 'src/core/x.ts');
    expect(poisonReasons).toContain("imports Node builtin 'node:async_hooks'");
  });

  it("flags a value import of 'pino'", () => {
    const { poisonReasons } = analyzeSource(`import pino from 'pino';`, 'src/core/x.ts');
    expect(poisonReasons).toContain("imports 'pino'");
  });

  it('flags import.meta usage (Hermes parse-fatal)', () => {
    const { poisonReasons } = analyzeSource(
      `const u = import.meta.url; void u;`,
      'src/core/x.ts',
    );
    expect(poisonReasons).toContain('uses import.meta');
  });

  it('flags createRequire usage', () => {
    const src = `import { createRequire } from 'node:module';\nconst r = createRequire(import.meta.url); void r;`;
    const { poisonReasons } = analyzeSource(src, 'src/core/x.ts');
    expect(poisonReasons).toContain('uses createRequire');
  });

  it('flags a require() of a node builtin', () => {
    const { poisonReasons } = analyzeSource(`const os = require('node:os');`, 'src/core/x.ts');
    expect(poisonReasons).toContain("imports Node builtin 'node:os'");
  });

  it('flags a dynamic import() of pino', () => {
    const { poisonReasons } = analyzeSource(`const p = await import('pino');`, 'src/core/x.ts');
    expect(poisonReasons).toContain("imports 'pino'");
  });

  // F1: bare Node builtins (no node: prefix) are poison too — src/core uses
  // bare `os`/`fs`/`path`/`crypto`, and Metro polyfills none of them.
  it('flags a value import of a BARE node builtin (fs)', () => {
    const { poisonReasons } = analyzeSource(`import fs from 'fs';`, 'src/core/x.ts');
    expect(poisonReasons).toContain("imports Node builtin 'fs'");
  });

  it('flags a bare-builtin require() and a bare-builtin dynamic import()', () => {
    expect(analyzeSource(`const os = require('os');`, 'src/core/x.ts').poisonReasons).toContain(
      "imports Node builtin 'os'",
    );
    expect(analyzeSource(`const p = await import('path');`, 'src/core/x.ts').poisonReasons).toContain(
      "imports Node builtin 'path'",
    );
  });

  it('flags a value import of bare `crypto` / `module` / `events`', () => {
    for (const m of ['crypto', 'module', 'events']) {
      const { poisonReasons } = analyzeSource(`import x from '${m}';`, 'src/core/x.ts');
      expect(poisonReasons).toContain(`imports Node builtin '${m}'`);
    }
  });
});

describe('analyzeSource — type-only / non-poison (no flag)', () => {
  it('does NOT flag a whole-statement type-only import of node:* ', () => {
    const { poisonReasons } = analyzeSource(
      `import type { PathLike } from 'node:fs';`,
      'src/core/x.ts',
    );
    expect(poisonReasons).toEqual([]);
  });

  it('does NOT flag a pure inline-type import of pino', () => {
    const { poisonReasons } = analyzeSource(
      `import { type Logger } from 'pino';`,
      'src/core/x.ts',
    );
    expect(poisonReasons).toEqual([]);
  });

  // F1: bare-builtin type-only import erases at compile → no runtime dep → not poison.
  it('does NOT flag a type-only import of a BARE node builtin (fs)', () => {
    const { poisonReasons } = analyzeSource(
      `import type { PathLike } from 'fs';`,
      'src/core/x.ts',
    );
    expect(poisonReasons).toEqual([]);
  });

  // F4: a same-named LOCAL createRequire helper (not the node:module builtin,
  // no import.meta) must NOT be flagged.
  it('does NOT flag a local non-node createRequire helper (F4)', () => {
    const src = [
      `function createRequire(base: string) { return (id: string) => base + id; }`,
      `const r = createRequire('/root/'); void r('./x');`,
    ].join('\n');
    expect(analyzeSource(src, 'src/core/x.ts').poisonReasons).toEqual([]);
  });

  // F4: still flags the real builtin createRequire (bound from node:module).
  it('still flags createRequire bound from node:module (F4)', () => {
    const src = `import { createRequire } from 'node:module';\nconst r = createRequire('/x'); void r;`;
    const { poisonReasons } = analyzeSource(src, 'src/core/x.ts');
    expect(poisonReasons).toContain('uses createRequire');
  });

  // F4: still flags createRequire paired with import.meta (the ESM idiom).
  it('still flags createRequire paired with import.meta (F4)', () => {
    const src = `const r = createRequire(import.meta.url); void r;`;
    const { poisonReasons } = analyzeSource(src, 'src/core/x.ts');
    expect(poisonReasons).toContain('uses createRequire');
  });

  it('does NOT flag node:/pino strings appearing only in comments', () => {
    const src = [
      `// this module deliberately avoids importing node:fs / pino`,
      `/* see import.meta and createRequire notes */`,
      `export const x = 1;`,
    ].join('\n');
    expect(analyzeSource(src, 'src/core/x.ts').poisonReasons).toEqual([]);
  });

  it('does NOT flag a plain RN-safe @core value import', () => {
    const { poisonReasons, edges } = analyzeSource(
      `import { finishLine } from '@core/finishLine';`,
      'mobile/src/x.ts',
    );
    expect(poisonReasons).toEqual([]);
    expect(edges.map((e) => e.specifier)).toEqual(['@core/finishLine']);
  });
});

describe('analyzeSource — edges (what the walk follows)', () => {
  it('records value import, dynamic import, require, import-equals, and value re-exports as edges', () => {
    const src = [
      `import { a } from './a';`,
      `import '@core/side';`,
      `const m = await import('@core/dyn');`,
      `const r = require('@core/req');`,
      `import eq = require('@core/eq');`,
      `export * from '@core/star';`,
      `export { y } from '@core/named';`,
    ].join('\n');
    const specs = analyzeSource(src, 'mobile/src/x.ts').edges.map((e) => e.specifier).sort();
    expect(specs).toEqual(
      ['./a', '@core/dyn', '@core/eq', '@core/named', '@core/req', '@core/side', '@core/star'].sort(),
    );
  });

  it('does NOT record a type-only import or type-only re-export as an edge', () => {
    const src = [
      `import type { A } from '@core/typeonly';`,
      `export type { B } from '@core/typestar';`,
    ].join('\n');
    expect(analyzeSource(src, 'mobile/src/x.ts').edges).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Layer 2: walkReachability — bounded BFS over an in-memory fixture
// ---------------------------------------------------------------------------

/**
 * Build an in-memory FileSystemLike from a `{ relPath: source }` map. relPaths
 * are repo-relative POSIX; we materialise absolute paths under a synthetic repo
 * root so the alias resolver + entry/frontier split behave exactly as in prod.
 */
const REPO = '/repo';
const MOBILE = path.join(REPO, 'mobile');

function makeFs(files: Record<string, string>): {
  fs: FileSystemLike;
  abs: (rel: string) => string;
} {
  const abs = (rel: string): string => path.join(REPO, rel);
  const fileSet = new Map<string, string>();
  const dirSet = new Set<string>();
  for (const rel of Object.keys(files)) {
    const a = abs(rel);
    fileSet.set(a, files[rel]);
    let dir = path.dirname(a);
    while (dir && dir !== path.dirname(dir)) {
      dirSet.add(dir);
      dir = path.dirname(dir);
    }
  }
  const fs: FileSystemLike = {
    existsSync: (p) => fileSet.has(p) || dirSet.has(p),
    isFile: (p) => fileSet.has(p),
    isDirectory: (p) => dirSet.has(p) && !fileSet.has(p),
    readFileSync: (p) => {
      const s = fileSet.get(p);
      if (s === undefined) throw new Error(`fixture: no such file ${p}`);
      return s;
    },
  };
  return { fs, abs };
}

// Alias rules mirroring mobile/tsconfig.json (baseUrl = mobile/, targets '../src/...').
const RULES: AliasRule[] = buildAliasRules(
  {
    '@core/*': ['../src/core/*'],
    '@shared/*': ['../src/shared/*'],
    '@rebel/cloud-client': ['../cloud-client/src'],
    '@rebel/cloud-client/*': ['../cloud-client/src/*'],
    '@rebel/shared': ['../packages/shared/src'],
    '@rebel/shared/*': ['../packages/shared/src/*'],
    '@/*': ['./src/*'],
  },
  MOBILE,
);

function run(files: Record<string, string>): readonly Violation[] {
  const { fs, abs } = makeFs(files);
  const entryFiles = Object.keys(files)
    .filter((rel) => rel.startsWith('mobile/app/') || rel.startsWith('mobile/src/'))
    .map(abs);
  return walkReachability(entryFiles, RULES, { repoRoot: REPO, mobileRoot: MOBILE, fs }).violations;
}

describe('walkReachability — alias resolution sanity', () => {
  it('resolves @core/* to src/core/* and finds index files / extensions', () => {
    const { fs, abs } = makeFs({
      'mobile/src/x.ts': '',
      'src/core/foo.ts': '',
      'src/core/bar/index.ts': '',
    });
    expect(resolveSpecifier('@core/foo', abs('mobile/src/x.ts'), RULES, fs)).toBe(abs('src/core/foo.ts'));
    expect(resolveSpecifier('@core/bar', abs('mobile/src/x.ts'), RULES, fs)).toBe(abs('src/core/bar/index.ts'));
  });

  it('returns null for an out-of-frontier (node_modules / unknown) specifier', () => {
    const { fs, abs } = makeFs({ 'mobile/src/x.ts': '' });
    expect(resolveSpecifier('react-native', abs('mobile/src/x.ts'), RULES, fs)).toBeNull();
    expect(resolveSpecifier('node:fs', abs('mobile/src/x.ts'), RULES, fs)).toBeNull();
  });
});

describe('walkReachability — the four spike behaviors', () => {
  // (a) poison import in a mobile-reachable core module IS flagged with the chain
  it('(a) FLAGS a poison node:* import reached transitively, printing the chain', () => {
    const violations = run({
      'mobile/src/utils/diagnosticBundle.ts': `import { buildBundle } from '@core/services/diagnostics/diagnosticBundleService';\nvoid buildBundle;`,
      'src/core/services/diagnostics/diagnosticBundleService.ts': `import { createScopedLogger } from '@core/logger';\nexport const buildBundle = () => createScopedLogger();`,
      'src/core/logger.ts': `import fs from 'node:fs';\nimport pino from 'pino';\nexport const createScopedLogger = () => pino({ fs } as never);`,
    });
    expect(violations).toHaveLength(1);
    expect(violations[0].poison).toBe('src/core/logger.ts');
    expect(violations[0].reasons).toContain("imports Node builtin 'node:fs'");
    expect(violations[0].reasons).toContain("imports 'pino'");
    expect(violations[0].chain).toEqual([
      'mobile/src/utils/diagnosticBundle.ts',
      'src/core/services/diagnostics/diagnosticBundleService.ts',
      'src/core/logger.ts',
    ]);
  });

  // (b) a type-only import is NOT flagged
  it('(b) does NOT flag a type-only import of a poison module', () => {
    const violations = run({
      'mobile/src/utils/diagnosticBundle.ts': `import { buildBundle } from '@core/services/diagnostics/diagnosticBundleService';\nvoid buildBundle;`,
      // type-only edge into logger — erases at compile, pulls no runtime dep
      'src/core/services/diagnostics/diagnosticBundleService.ts': `import type { Logger } from '@core/logger';\nexport const buildBundle = (): Logger | null => null;`,
      'src/core/logger.ts': `import fs from 'node:fs';\nimport pino from 'pino';\nexport type Logger = ReturnType<typeof pino>;\nexport const createScopedLogger = () => pino({ fs } as never);`,
    });
    expect(violations).toEqual([]);
  });

  // (c) clean tree (legit RN-safe @core imports) → zero
  it('(c) yields ZERO on a clean tree of legit RN-safe @core value imports', () => {
    const violations = run({
      'mobile/src/x.ts': `import { finishLine } from '@core/finishLine';\nimport { cloudErrorCatalog } from '@core/cloudErrorCatalog';\nvoid finishLine; void cloudErrorCatalog;`,
      // RN-safe @core leaves: no node:*/pino/import.meta/createRequire anywhere
      'src/core/finishLine.ts': `export const finishLine = (s: string) => s.trim();`,
      'src/core/cloudErrorCatalog.ts': `import { fmt } from '@shared/fmt';\nexport const cloudErrorCatalog = { fmt };`,
      'src/shared/fmt.ts': `export const fmt = (s: string) => s;`,
    });
    expect(violations).toEqual([]);
  });

  // (d) a transitive leak via the cloud-client barrel IS flagged
  it('(d) FLAGS a poison edge reached via the @rebel/cloud-client export-* barrel', () => {
    const violations = run({
      'mobile/app/(e2e)/pair.tsx': `import { useAgentTurn } from '@rebel/cloud-client';\nvoid useAgentTurn;`,
      // cloud-client barrel re-exports a hook that value-imports an in-core module
      'cloud-client/src/index.ts': `export * from './hooks/useAgentTurn';`,
      'cloud-client/src/hooks/useAgentTurn.ts': `import { reducer } from '@core/services/agentTurnReducer';\nexport const useAgentTurn = () => reducer;`,
      'src/core/services/agentTurnReducer/index.ts': `import { createRequire } from 'node:module';\nconst r = createRequire(import.meta.url);\nexport const reducer = r;`,
    });
    expect(violations).toHaveLength(1);
    expect(violations[0].poison).toBe('src/core/services/agentTurnReducer/index.ts');
    expect(violations[0].reasons).toContain('uses createRequire');
    expect(violations[0].reasons).toContain('uses import.meta');
    expect(violations[0].chain).toEqual([
      'mobile/app/(e2e)/pair.tsx',
      'cloud-client/src/index.ts',
      'cloud-client/src/hooks/useAgentTurn.ts',
      'src/core/services/agentTurnReducer/index.ts',
    ]);
  });
});

describe('walkReachability — poison directly in an ENTRY root (F2)', () => {
  // F2: a mobile/src|app root file directly importing a Node builtin is the
  // bundle — it must be flagged, not silently skipped because it's an entry.
  it('FLAGS a node:* import directly in a mobile/src entry file', () => {
    const violations = run({
      'mobile/src/leaky.ts': `import fs from 'node:fs';\nexport const u = fs;`,
    });
    expect(violations).toHaveLength(1);
    expect(violations[0].poison).toBe('mobile/src/leaky.ts');
    expect(violations[0].reasons).toContain("imports Node builtin 'node:fs'");
    expect(violations[0].chain).toEqual(['mobile/src/leaky.ts']);
  });

  it('FLAGS a bare-builtin import + import.meta directly in a mobile/app entry file', () => {
    const violations = run({
      'mobile/app/index.tsx': `import os from 'os';\nconst u = import.meta.url; export const x = { os, u };`,
    });
    expect(violations).toHaveLength(1);
    expect(violations[0].poison).toBe('mobile/app/index.tsx');
    expect(violations[0].reasons).toContain("imports Node builtin 'os'");
    expect(violations[0].reasons).toContain('uses import.meta');
  });

  it('does NOT flag a clean mobile entry file', () => {
    const violations = run({
      'mobile/src/clean.ts': `import { finishLine } from '@core/finishLine';\nvoid finishLine;`,
      'src/core/finishLine.ts': `export const finishLine = (s: string) => s.trim();`,
    });
    expect(violations).toEqual([]);
  });
});

describe('walkReachability — does not flag poison OUTSIDE the mobile frontier', () => {
  it('ignores a poison core module that no mobile entry can reach', () => {
    const violations = run({
      'mobile/src/x.ts': `import { safe } from '@core/safe';\nvoid safe;`,
      'src/core/safe.ts': `export const safe = 1;`,
      // unreachable from any mobile entry — must NOT flag
      'src/core/unreached.ts': `import fs from 'node:fs';\nexport const u = fs;`,
    });
    expect(violations).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Allowlist + ratchet semantics
// ---------------------------------------------------------------------------

describe('allowlist semantics', () => {
  it('ships with an empty allowlist (zero violations today)', () => {
    expect(ALLOWLIST).toHaveLength(0);
  });

  it('suppresses a violation only when EVERY reason is allowlisted', () => {
    const v: Violation = {
      poison: 'src/core/poison.ts',
      reasons: ["imports Node builtin 'node:os'"],
      chain: ['mobile/src/x.ts', 'src/core/poison.ts'],
    };
    // matching allowlist entry (entry + poison + reason) → suppressed
    expect(
      filterAllowlisted(
        [v],
        [{ entry: 'mobile/src/x.ts', poison: 'src/core/poison.ts', reason: 'node:os', justification: 'metro polyfills os' }],
      ),
    ).toEqual([]);
    // wrong reason → still flagged
    expect(
      filterAllowlisted(
        [v],
        [{ entry: 'mobile/src/x.ts', poison: 'src/core/poison.ts', reason: 'node:fs', justification: 'unrelated' }],
      ),
    ).toEqual([v]);
  });

  it('does NOT suppress when only some reasons are allowlisted', () => {
    const v: Violation = {
      poison: 'src/core/poison.ts',
      reasons: ["imports Node builtin 'node:os'", "imports 'pino'"],
      chain: ['mobile/src/x.ts', 'src/core/poison.ts'],
    };
    expect(
      filterAllowlisted(
        [v],
        [{ entry: 'mobile/src/x.ts', poison: 'src/core/poison.ts', reason: 'node:os', justification: 'partial only' }],
      ),
    ).toEqual([v]);
  });

  // F3: (entry, poison) precision — an allowlist entry only suppresses chains
  // STARTING at its `entry`, never the same poison reached via a different entry.
  it('does NOT suppress the same poison reached via a DIFFERENT entry (F3 precision)', () => {
    const fromA: Violation = {
      poison: 'src/core/poison.ts',
      reasons: ["imports Node builtin 'node:os'"],
      chain: ['mobile/src/a.ts', 'src/core/poison.ts'],
    };
    const fromB: Violation = {
      poison: 'src/core/poison.ts',
      reasons: ["imports Node builtin 'node:os'"],
      chain: ['mobile/src/b.ts', 'src/core/poison.ts'],
    };
    // allowlist only entry a → a suppressed, b still flagged
    expect(
      filterAllowlisted(
        [fromA, fromB],
        [{ entry: 'mobile/src/a.ts', poison: 'src/core/poison.ts', reason: 'node:os', justification: 'audited RN-safe on a' }],
      ),
    ).toEqual([fromB]);
  });
});
