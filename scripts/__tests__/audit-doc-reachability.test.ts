import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  stripTargetSuffix,
  isGlobOrPlaceholder,
  looksLikePath,
  extractLinks,
  resolveOnDisk,
  resolveTarget,
  isTestOrFixturePath,
  isExcludedStaleRef,
  isHistoricalDoc,
  riskTier,
  bfsHops,
  type DocGraph,
} from '../audit-doc-reachability';

describe('stripTargetSuffix', () => {
  it('strips anchors, line numbers, and symbol suffixes', () => {
    expect(stripTargetSuffix('docs/X.md#section')).toBe('docs/X.md');
    expect(stripTargetSuffix('src/main/index.ts:42')).toBe('src/main/index.ts');
    expect(stripTargetSuffix('src/a.ts:executeAgentTurn()')).toBe('src/a.ts');
    expect(stripTargetSuffix('foo()')).toBe('foo');
    expect(stripTargetSuffix('<src/a.ts>')).toBe('src/a.ts');
  });
});

describe('isGlobOrPlaceholder', () => {
  it('flags globs and placeholders', () => {
    expect(isGlobOrPlaceholder('mobile/**')).toBe(true);
    expect(isGlobOrPlaceholder('src/renderer/features/<feature>/hooks/')).toBe(true);
    expect(isGlobOrPlaceholder('@mindstone/mcp-server-*')).toBe(true);
    expect(isGlobOrPlaceholder('src/renderer/.../store/sessionStore.ts')).toBe(true); // `...` elision
    expect(isGlobOrPlaceholder('../../src/core/platform.ts')).toBe(false); // `..` relative is fine
    expect(isGlobOrPlaceholder('src/core/platform.ts')).toBe(false);
  });
});

describe('looksLikePath', () => {
  it('accepts repo paths and known aliases, rejects npm scopes / globs / prose', () => {
    expect(looksLikePath('src/core/platform.ts')).toBe(true);
    expect(looksLikePath('@core/storeFactory')).toBe(true);
    expect(looksLikePath('docs/project/UI_OVERVIEW.md')).toBe(true);
    expect(looksLikePath('@rebel/cloud-client')).toBe(false); // npm scope, not a tsconfig alias
    expect(looksLikePath('mobile/**')).toBe(false);
    expect(looksLikePath('just some words')).toBe(false);
    expect(looksLikePath('useState')).toBe(false);
  });
});

describe('extractLinks', () => {
  it('pulls markdown links and path-like backticks', () => {
    const md = 'See [the doc](./FOO.md) and `src/main/index.ts` and `useMemo` and [ext](https://x.com).';
    const links = extractLinks(md);
    const raws = links.map((l) => l.raw);
    expect(raws).toContain('./FOO.md');
    expect(raws).toContain('src/main/index.ts');
    expect(raws).toContain('https://x.com'); // markdown links are extracted; resolveTarget drops external
    expect(raws).not.toContain('useMemo'); // not path-like
  });
  it('does not treat code like `makeApi[method](req)` as a markdown link', () => {
    const links = extractLinks('The real path: `makeDomainApi[method](req)` ← invoke');
    expect(links.map((l) => l.raw)).not.toContain('req');
  });
  it('still finds inline path backticks after a fenced code block (no mis-pairing)', () => {
    const md = [
      'Intro.',
      '```ts',
      'const x = `not a path`; // backticks inside a fence',
      '```',
      'Now the real ref: `src/core/services/foo/bar.ts` matters.',
    ].join('\n');
    expect(extractLinks(md).map((l) => l.raw)).toContain('src/core/services/foo/bar.ts');
  });
});

describe('isTestOrFixturePath', () => {
  it('flags test/fixture/mock dirs', () => {
    expect(isTestOrFixturePath('src/core/services/__tests__')).toBe(true);
    expect(isTestOrFixturePath('src/x/__lint_fixtures__')).toBe(true);
    expect(isTestOrFixturePath('src/x/fixtures')).toBe(true);
    expect(isTestOrFixturePath('src/core/services/automation')).toBe(false);
  });
});

describe('isExcludedStaleRef', () => {
  it('excludes build/generated artifacts and top-level package-relative src refs', () => {
    expect(isExcludedStaleRef('cloud-service/dist/server.mjs')).toBe(true);
    expect(isExcludedStaleRef('src/preload/generated/ipcBridge.ts')).toBe(true);
    expect(isExcludedStaleRef('evals/.built.mjs')).toBe(true);
    expect(isExcludedStaleRef('src/index.ts')).toBe(true); // package-relative MCP ref shape
    expect(isExcludedStaleRef('evals/results/knowledge-work/')).toBe(true); // generated eval output
    expect(isExcludedStaleRef('evals/analysis/')).toBe(true);
    expect(isExcludedStaleRef('src/main/services/authService.ts')).toBe(false); // genuine in-repo
  });
});

describe('isHistoricalDoc', () => {
  it('detects deprecated/historical frontmatter status', () => {
    expect(isHistoricalDoc('---\ndescription: "x"\nstatus: historical\n---\nbody')).toBe(true);
    expect(isHistoricalDoc('---\nstatus: "deprecated"\n---')).toBe(true);
    expect(isHistoricalDoc('---\ndescription: "x"\nlast_updated: "2026-06-14"\n---')).toBe(false);
  });
});

describe('riskTier', () => {
  it('uses path heuristics then fan-in', () => {
    expect(riskTier('src/main/services/auth', 0)).toBe('high');
    expect(riskTier('src/main/services', 0)).toBe('high'); // trailing segment matches
    expect(riskTier('src/core/store', 0)).toBe('high');
    expect(riskTier('src/core/providerRouting', 0)).toBe('high');
    expect(riskTier('src/shared/ipc', 0)).toBe('high');
    expect(riskTier('src/renderer/components/ui', 99)).toBe('low'); // low pattern wins over fan-in
    expect(riskTier('src/core/util/random', 20)).toBe('high'); // fan-in escalates
    expect(riskTier('src/core/util/random', 5)).toBe('medium');
    expect(riskTier('src/core/util/random', 1)).toBe('low');
  });
});

describe('bfsHops', () => {
  it('computes hop distance over doc edges', () => {
    const graph: DocGraph = {
      docEdges: new Map([
        ['AGENTS.md', new Set(['docs/A_OVERVIEW.md'])],
        ['docs/A_OVERVIEW.md', new Set(['docs/A_DETAIL.md'])],
        ['docs/A_DETAIL.md', new Set()],
        ['docs/ORPHAN.md', new Set()],
      ]),
      codeRefs: new Map(),
      staleRefs: new Map(),
    };
    const hops = bfsHops(graph, 'AGENTS.md');
    expect(hops.get('AGENTS.md')).toBe(0);
    expect(hops.get('docs/A_OVERVIEW.md')).toBe(1);
    expect(hops.get('docs/A_DETAIL.md')).toBe(2);
    expect(hops.has('docs/ORPHAN.md')).toBe(false); // unreachable from root
  });
});

describe('resolveOnDisk + resolveTarget (filesystem fixture)', () => {
  let tmp: string;
  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'reach-'));
    fs.mkdirSync(path.join(tmp, 'src', 'core'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'cloud-service', 'src'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'src', 'feature'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'src', 'core', 'platform.ts'), '');
    fs.writeFileSync(path.join(tmp, 'cloud-service', 'src', 'server.ts'), '');
    fs.writeFileSync(path.join(tmp, 'src', 'feature', 'index.ts'), '');
  });
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('applies extension fallback for bare module refs', () => {
    expect(resolveOnDisk(tmp, 'src/core/platform')).toBe('src/core/platform.ts');
  });
  it('resolves a bare dir via index.*', () => {
    expect(resolveOnDisk(tmp, 'src/feature')).toBe('src/feature');
  });
  it('canonicalises trailing-slash dir links (so they match enumerated units)', () => {
    expect(resolveOnDisk(tmp, 'src/feature/')).toBe('src/feature');
    const r = resolveTarget('../../src/feature/', 'docs/project', {}, tmp);
    expect(r.relPath).toBe('src/feature');
    expect(r.kind).toBe('code');
  });
  it('returns null for truly missing paths', () => {
    expect(resolveOnDisk(tmp, 'src/core/ghost')).toBeNull();
  });
  it('resolves `src/server.ts` inside a nested AGENTS.md against the doc dir', () => {
    const r = resolveTarget('src/server.ts', 'cloud-service', {}, tmp);
    expect(r.relPath).toBe('cloud-service/src/server.ts');
    expect(r.kind).toBe('code');
  });
  it('falls back to repo-root when doc-relative does not exist', () => {
    const r = resolveTarget('src/core/platform', 'cloud-service', {}, tmp);
    expect(r.relPath).toBe('src/core/platform.ts');
    expect(r.kind).toBe('code');
  });
  it('reports a missing src/... ref under its code root (not the doc-relative mask)', () => {
    // A docs/project doc backticking a now-deleted `src/...` path: the missing relPath must be
    // code-rooted (src/...) so under-code-root stale detection catches it, not `docs/project/src/...`.
    const r = resolveTarget('src/main/services/authService.ts', 'docs/project', {}, tmp);
    expect(r.kind).toBe('missing');
    expect(r.relPath).toBe('src/main/services/authService.ts');
  });
});
