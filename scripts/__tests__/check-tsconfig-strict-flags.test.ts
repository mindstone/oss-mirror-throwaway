import path from 'node:path';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * Universal strict-TypeScript-flag coverage across the superproject's owned
 * project tsconfigs.
 *
 * Why this test exists
 * --------------------
 * Postmortem `260529_switch_default_bypass_lint_block_wrap`: a strict flag
 * (`noFallthroughCasesInSwitch`) was advertised as universal and flipped on in
 * `tsconfig.base.json`, but the `mobile` and `cloud` STANDALONE tsconfigs do not
 * inherit from that base, so they silently missed the flag. The original guard
 * (a 4-file hardcoded list) only checked a handful of surfaces; this is the
 * generalized version: for ANY flag advertised as universal, prove EVERY owned
 * standalone tsconfig sets it (directly, or via an in-repo `extends` chain we
 * can resolve and verify) rather than relying on base-config inheritance
 * assumptions.
 *
 * Scope: the superproject's own owned tsconfigs (the app, cloud, mobile, eval,
 * worker, and shared-package surfaces). Submodules (`mcp-servers/`,
 * `super-mcp/`, `rebel-system/`), `node_modules`, build output, test fixtures,
 * and bundled starter templates are out of scope — they carry their own TS
 * config contracts and (for submodules) their own CI. Exemptions are exact-path,
 * reasoned, and count-pinned so adding/removing one is a visible diff.
 */

const REPO_ROOT = path.resolve(__dirname, '..', '..');

/** Flags advertised as universal — every owned tsconfig must set each. */
const UNIVERSAL_STRICT_FLAGS = ['noFallthroughCasesInSwitch'] as const;
type UniversalFlag = (typeof UNIVERSAL_STRICT_FLAGS)[number];

/**
 * Repo-relative directories to scan for `tsconfig*.json` files (single level
 * per directory, not recursive). Deliberately enumerates the superproject's own
 * TS project surfaces and excludes submodule + vendored (node_modules) trees.
 * '' is the repo root.
 */
const OWNED_TSCONFIG_DIRS: readonly string[] = [
  '',
  'cloud-client',
  'cloud-service',
  'evals/gui',
  'meeting-bot-worker',
  'mobile',
  'packages/browser-extension',
  'packages/shared',
  'web-companion',
];

/**
 * Critical standalone surfaces that MUST stay in the discovered owned set. These
 * are exactly the standalone-tsconfig surfaces from the 260529 regression (mobile
 * + cloud) plus the worker/eval standalones that don't inherit from the in-repo
 * base. A count floor alone would silently lose coverage if a glob were removed;
 * pinning these names makes that a visible failure.
 */
const REQUIRED_OWNED_TSCONFIGS: readonly string[] = [
  'mobile/tsconfig.json',
  'cloud-service/tsconfig.json',
  'cloud-client/tsconfig.json',
  'meeting-bot-worker/tsconfig.json',
  'evals/gui/tsconfig.json',
  'tsconfig.base.json',
];

/**
 * Exact-path exemptions with reasons. Count-pinned below. A config belongs here
 * only if it genuinely does not type-check source through its own options
 * (solution/aggregator files) or is a vendored/bundled surface outside the
 * superproject's universal-flag contract.
 */
const EXEMPT: ReadonlyArray<{ relPath: string; reason: string }> = [
  {
    relPath: 'tsconfig.json',
    reason:
      'Solution/aggregator file: "files": [] + project references only — compiles no source through its own compilerOptions; the universal flag is enforced on the referenced projects (tsconfig.node.json / tsconfig.renderer.json via tsconfig.base.json).',
  },
];

const EXEMPT_COUNT = 1;

function readRawCompilerOptionsAndExtends(absPath: string): {
  compilerOptions: Record<string, unknown>;
  extends: string | undefined;
} {
  const raw = readFileSync(absPath, 'utf8');
  const parsed = ts.parseConfigFileTextToJson(absPath, raw);
  if (parsed.error) {
    throw new Error(
      `Failed to parse ${path.relative(REPO_ROOT, absPath)}: ${ts.flattenDiagnosticMessageText(parsed.error.messageText, '\n')}`,
    );
  }
  const config = parsed.config as {
    compilerOptions?: Record<string, unknown>;
    extends?: string | string[];
  };
  return { compilerOptions: config.compilerOptions ?? {}, extends: config.extends };
}

/**
 * Resolve a flag's effective value by walking the `extends` chain, but ONLY
 * through in-repo bases we can read (so inheritance is *proven*, not assumed).
 * If `extends` points at an out-of-repo package (e.g. `expo/tsconfig.base`) or
 * a path we can't resolve, the chain stops there: the config itself must set the
 * flag. Returns the effective boolean, or `undefined` if never set along the
 * resolvable chain.
 */
function resolveEffectiveFlag(absPath: string, flag: UniversalFlag, seen = new Set<string>()): unknown {
  if (seen.has(absPath)) return undefined; // cycle guard
  seen.add(absPath);

  const { compilerOptions, extends: ext } = readRawCompilerOptionsAndExtends(absPath);
  if (flag in compilerOptions) {
    return compilerOptions[flag];
  }
  if (!ext) return undefined;

  // `extends` may be a single string or (TS 5.0+) an array of bases applied in
  // order, with LATER entries winning. Resolve each in-repo base; the last base
  // that defines the flag wins. Bare package specifiers (e.g. "expo/tsconfig.base")
  // are out-of-repo: we cannot prove they set the flag, so we do NOT follow them —
  // the local config must set it explicitly.
  const bases = Array.isArray(ext) ? ext : [ext];
  let resolved: unknown = undefined;
  for (const base of bases) {
    if (!base.startsWith('.') && !base.startsWith('/')) {
      continue; // out-of-repo base — cannot prove inheritance
    }
    let basePath = path.resolve(path.dirname(absPath), base);
    if (!basePath.endsWith('.json')) basePath += '.json';
    if (!existsSync(basePath)) continue;
    const fromBase = resolveEffectiveFlag(basePath, flag, seen);
    if (fromBase !== undefined) resolved = fromBase; // later base wins
  }
  return resolved;
}

/**
 * Discover `tsconfig*.json` files one level deep in each owned directory.
 * readdirSync (not fs.globSync) — portable to the Node 20 CI legs; globSync is
 * only stable from Node 22.
 */
function discoverOwnedTsconfigs(): string[] {
  const found = new Set<string>();
  for (const dir of OWNED_TSCONFIG_DIRS) {
    const absDir = path.resolve(REPO_ROOT, dir);
    let entries: string[];
    try {
      entries = readdirSync(absDir);
    } catch {
      continue; // directory absent (e.g. submodule not checked out) — skip
    }
    for (const name of entries) {
      if (!name.startsWith('tsconfig') || !name.endsWith('.json')) continue;
      const rel = (dir ? `${dir}/${name}` : name).split(path.sep).join('/');
      // Defensive: never reach into vendored/build trees.
      if (
        rel.includes('node_modules') ||
        rel.startsWith('mcp-servers/') ||
        rel.startsWith('super-mcp/') ||
        rel.startsWith('rebel-system/') ||
        rel.includes('__tests__/fixtures/') ||
        rel.includes('/dist/') ||
        rel.includes('/.vite/')
      ) {
        continue;
      }
      found.add(rel);
    }
  }
  return [...found].sort();
}

describe('Universal strict TypeScript flags are set across owned project tsconfigs', () => {
  const exemptPaths = new Set(EXEMPT.map((e) => e.relPath));

  it('the exempt list is count-pinned (adding/removing an exemption is a visible diff)', () => {
    expect(EXEMPT.length).toBe(EXEMPT_COUNT);
  });

  it('every exempt path actually exists (no rotted exemptions)', () => {
    for (const { relPath } of EXEMPT) {
      expect(existsSync(path.resolve(REPO_ROOT, relPath)), `exempt path missing: ${relPath}`).toBe(true);
    }
  });

  const owned = discoverOwnedTsconfigs();

  it('discovers a non-trivial set of owned tsconfigs', () => {
    // Sanity floor: if a glob breaks and we find ~nothing, fail loudly rather
    // than vacuously pass.
    expect(owned.length).toBeGreaterThanOrEqual(10);
  });

  it('discovers every critical standalone surface (no silent coverage loss)', () => {
    const ownedSet = new Set(owned);
    for (const required of REQUIRED_OWNED_TSCONFIGS) {
      expect(
        ownedSet.has(required),
        `${required} dropped from discovered owned tsconfigs — a glob was likely removed, silently losing the 260529 regression coverage`,
      ).toBe(true);
    }
  });

  for (const relPath of owned) {
    if (exemptPaths.has(relPath)) continue;
    for (const flag of UNIVERSAL_STRICT_FLAGS) {
      it(`${relPath}: ${flag} effectively true`, () => {
        const value = resolveEffectiveFlag(path.resolve(REPO_ROOT, relPath), flag);
        expect(
          value,
          `${relPath} must set ${flag}: true (directly or via an in-repo extends chain). ` +
            `Standalone configs that do not inherit it from an in-repo base must set it explicitly — ` +
            `this is the 260529 mobile/cloud regression class.`,
        ).toBe(true);
      });
    }
  }
});
