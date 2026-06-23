import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import path from 'node:path';

/**
 * RN-import guard (PLAN docs/plans/260612_cloud-analytics-monitoring, Stage 7).
 *
 * INVARIANT (Refactor Assessment RN-safety + R7 mobile harmonization):
 *   No mobile / cloud-client / RN-bundled module has a transitive import path —
 *   static OR dynamic `import()` — to the Node-only RudderStack SDK
 *   `@rudderstack/rudder-sdk-node`.
 *
 * Why this framing (PLAN Amendment A1 "Guard test scope"): the SDK lives in
 * `src/main/analytics.ts` and is intentionally shared with `cloud-service` (both
 * Node surfaces). It must NEVER reach React Native's Metro bundle. The naive
 * "the SDK is imported in exactly one module" assertion became false once cloud
 * imported `src/main/analytics.ts`, so the durable invariant is reachability,
 * not import-site count. We also CANNOT assume `@core/*` never touches
 * `src/main/*`: e.g. `src/core/cli/runCli.ts` → `headlessRuntime.ts` reaches
 * `src/main/analytics.ts`. Those are Node/CLI-only core entrypoints that mobile
 * never imports — so the walk must start from what mobile ACTUALLY imports, not
 * from all of `src/core`.
 *
 * Implementation: a source-text transitive walk (no module execution) from the
 * real RN-reachable roots, resolving the repo's TS path aliases + relative
 * specifiers and following static imports, re-exports, dynamic `import('…')`,
 * and `require('…')`. This is the same source-text-assertion discipline as
 * `src/main/oss/private-mindstone-stub/__tests__/modePurity.test.ts`, extended
 * to be transitive.
 *
 * The test PASSES today and FAILS if a future change makes the SDK reachable
 * from any RN-reachable module (e.g. someone imports `@main/analytics` or
 * `src/main/analytics.ts` from an `@core` module that mobile pulls in).
 */

const REPO_ROOT = path.resolve(__dirname, '../../..');
const SDK_SPECIFIER = '@rudderstack/rudder-sdk-node';

// Repo TS path aliases (see tsconfig.json + vitest.config.ts sharedAliases).
// Ordered longest-prefix-first so `@rebel/cloud-client/x` wins over a bare
// `@rebel/cloud-client` match.
const ALIASES: ReadonlyArray<readonly [string, string]> = [
  ['@core/', 'src/core/'],
  ['@main/', 'src/main/'],
  ['@shared/', 'src/shared/'],
  ['@renderer/', 'src/renderer/'],
  ['@/', 'src/renderer/'],
  ['@rebel/cloud-client/', 'cloud-client/src/'],
  ['@rebel/cloud-client', 'cloud-client/src/index'],
  ['@rebel/shared/', 'packages/shared/src/'],
  ['@rebel/shared', 'packages/shared/src/index'],
  ['@private/mindstone/', 'src/main/oss/private-mindstone-stub/'],
];

const RESOLVE_EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json'];

function resolveToFile(base: string): string | null {
  if (existsSync(base) && statSync(base).isFile()) return base;
  for (const ext of RESOLVE_EXTS) {
    if (existsSync(base + ext)) return base + ext;
  }
  if (existsSync(base) && statSync(base).isDirectory()) {
    for (const ext of RESOLVE_EXTS) {
      const idx = path.join(base, `index${ext}`);
      if (existsSync(idx)) return idx;
    }
  }
  return null;
}

/**
 * Resolve an import specifier to an absolute repo file path, or `null` for a
 * bare third-party package (the SDK itself is matched separately by string so a
 * `null` here just means "not a first-party module we walk into").
 */
function resolveSpecifier(spec: string, fromFile: string): string | null {
  if (spec.startsWith('.')) {
    return resolveToFile(path.resolve(path.dirname(fromFile), spec));
  }
  for (const [prefix, target] of ALIASES) {
    const isPrefixAlias = prefix.endsWith('/');
    if (isPrefixAlias ? spec.startsWith(prefix) : spec === prefix) {
      const rest = isPrefixAlias ? spec.slice(prefix.length) : '';
      return resolveToFile(path.join(REPO_ROOT, target + rest));
    }
  }
  return null;
}

// Matches, in order of alternation:
//   1. `import … from 'x'` / `export … from 'x'`           → group 1
//   2. dynamic `import('x')`                                → group 2
//   3. `require('x')`                                       → group 3
//   4. side-effect `import 'x'` (no bindings, no `from`)    → group 4
// Group 4 must come last and is anchored to start-of-line (after whitespace) so
// it does not mis-capture the `'x'` tail of a `from 'x'` already matched above.
const IMPORT_RE =
  /(?:import|export)\b[^'"]*?\bfrom\s*['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)|\brequire\(\s*['"]([^'"]+)['"]\s*\)|^\s*import\s+['"]([^'"]+)['"]/gm;

function extractSpecifiers(file: string): string[] {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const out: string[] = [];
  IMPORT_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = IMPORT_RE.exec(text)) !== null) {
    out.push(m[1] ?? m[2] ?? m[3] ?? m[4]);
  }
  return out;
}

function isFirstPartyWalkable(file: string): boolean {
  return /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(file);
}

/**
 * Collect the RN-reachable entry specifiers: every first-party alias module
 * that `mobile/src` imports, plus the `@rebel/cloud-client` package index
 * (mobile imports the whole package). Derived dynamically so the guard stays
 * accurate as mobile's import surface evolves.
 */
function collectMobileEntrySpecifiers(): string[] {
  const mobileSrc = path.join(REPO_ROOT, 'mobile/src');
  const specs = new Set<string>(['@rebel/cloud-client']);
  if (!existsSync(mobileSrc)) return [...specs];

  const ALIAS_IMPORT_RE = /\bfrom\s*['"](@core\/[^'"]+|@shared\/[^'"]+|@rebel\/[^'"]+)['"]/g;
  const stack = [mobileSrc];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fp = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules') continue;
        stack.push(fp);
      } else if (/\.(ts|tsx)$/.test(entry.name)) {
        const text = readFileSync(fp, 'utf8');
        ALIAS_IMPORT_RE.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = ALIAS_IMPORT_RE.exec(text)) !== null) {
          specs.add(m[1]);
        }
      }
    }
  }
  return [...specs];
}

/**
 * Transitively walk from the given entry files, returning the first reachable
 * chain that imports the SDK (or null if unreachable). Chains help debugging a
 * regression.
 */
function findSdkReachableChain(entryFiles: string[]): string[] | null {
  const visited = new Set<string>();

  function dfs(file: string, chain: string[]): string[] | null {
    if (visited.has(file)) return null;
    visited.add(file);
    const nextChain = [...chain, file];
    for (const spec of extractSpecifiers(file)) {
      if (spec === SDK_SPECIFIER) {
        return [...nextChain, SDK_SPECIFIER];
      }
      const resolved = resolveSpecifier(spec, file);
      if (resolved && isFirstPartyWalkable(resolved)) {
        const hit = dfs(resolved, nextChain);
        if (hit) return hit;
      }
    }
    return null;
  }

  for (const entry of entryFiles) {
    const hit = dfs(entry, []);
    if (hit) return hit;
  }
  return null;
}

describe('analytics RudderStack Node SDK is unreachable from RN/cloud-client', () => {
  it('SDK is statically imported in exactly src/main/analytics.ts (Node surface only)', () => {
    // Sanity anchor: the guard's premise is that the SDK lives behind the
    // src/main analytics module. If the import site moves, this fails loudly so
    // the reachability roots below can be re-evaluated.
    const analytics = path.join(REPO_ROOT, 'src/main/analytics.ts');
    expect(existsSync(analytics)).toBe(true);
    expect(extractSpecifiers(analytics)).toContain(SDK_SPECIFIER);
  });

  it('no mobile-reachable module has a transitive path to the Node RudderStack SDK', () => {
    const entrySpecs = collectMobileEntrySpecifiers();
    expect(entrySpecs.length).toBeGreaterThan(0);

    const entryFiles: string[] = [];
    const unresolved: string[] = [];
    const pseudoFrom = path.join(REPO_ROOT, 'mobile/src/__guard_entry__.ts');
    for (const spec of entrySpecs) {
      const resolved = resolveSpecifier(spec, pseudoFrom);
      if (resolved) entryFiles.push(resolved);
      else unresolved.push(spec);
    }
    // Every first-party entry specifier must resolve; an unresolved one would
    // silently shrink the guarded surface.
    expect(unresolved, `unresolved RN entry specifiers: ${unresolved.join(', ')}`).toEqual([]);
    expect(entryFiles.length).toBeGreaterThan(0);

    const chain = findSdkReachableChain(entryFiles);
    const rel = (p: string) => (p === SDK_SPECIFIER ? p : path.relative(REPO_ROOT, p));
    expect(
      chain,
      chain
        ? `RN-reachable import path to ${SDK_SPECIFIER} found — the Node SDK must NOT enter the mobile bundle:\n  ${chain
            .map(rel)
            .join('\n    -> ')}`
        : '',
    ).toBeNull();
  });
});
