// Fail-closed rule-presence smoke for `rebel-silent-swallow/no-silent-swallow`.
//
// Stage 2 of docs/plans/260612_silent-swallow-gate/PLAN.md (decision D2).
//
// Why this exists: Stage 3 retires the silent-swallow COUNT baselines
// (`BASELINE_SILENT_SWALLOW` + the per-surface budgets) in favour of the
// diff-scoped new-warning gate plus the existing `--max-warnings 3000` total
// cap as a coarse backstop. That cap catches a mass *spike*, but it is blind to
// a *disabled* rule: if someone turns the rule off (or drops a covered surface
// from the config) the warning count drops to 0 — comfortably UNDER any ceiling.
// The tight count baseline used to implicitly assert "the rule is present and
// firing"; this smoke is the explicit invariant that replaces that protection.
//
// What it asserts, for EACH covered surface (derived from the SSOT in
// scripts/silentSwallowSurfaceCoverage.mjs — never a hardcoded list):
//   1. WIRING: `rebel-silent-swallow/no-silent-swallow` resolves to warn-or-
//      error for a representative path on that surface, via the real
//      eslint.config.mjs (`ESLint.calculateConfigForFile`).
//   2. FIRES (GPT-r2-F2, REQUIRED): a known-bad swallow actually PRODUCES a
//      `rebel-silent-swallow/no-silent-swallow` diagnostic. Wiring alone is
//      insufficient — a rule could be "configured" yet never fire (e.g. a broken
//      rule implementation), so we execute the rule against bad code.
//
// This test goes RED if the rule is disabled/removed, or if a covered surface
// is dropped from the config (mirrors check-meeting-emit-eslint-scope.ts and
// the routing-selector presence pattern from 260612_ci-test-reliability).
//
// IMPORTANT — why FIRES does NOT lint through the full real config
// (260614_silent-swallow-smoke-ci-timeout): the `no-silent-swallow` rule is
// non-type-aware, but `src/**` and `private/**` paths resolve to a type-aware
// ESLint block (`parserOptions.project`). Linting a snippet at such a path via
// the FULL config forces a complete TypeScript program build (~5s/call locally),
// which under CI fork-pool contention blew the 60s worker budget — the worker was
// killed mid-lint and the empty result was misread as "rule didn't fire" (a
// CI-only, local-green failure that blocked the release pipeline). The
// type-aware cost is purely incidental: it is the co-located type-aware *rules*,
// not `no-silent-swallow`, that need the program. So FIRES now lints through a
// MINIMAL, non-type-aware ESLint instance (`firesEslint`) that mirrors only the
// silent-swallow block — same real rule module + parser, no `project`. This kills
// the timeout class by construction and is immune to future type-aware-rule
// additions. The WIRING check (1) still uses the REAL config, so a disabled rule,
// a dropped surface, or an `ignores` misconfiguration still goes RED there
// (`calculateConfigForFile` is cheap — it resolves config without linting).
//
// Representative path note: the representative source file is discovered
// dynamically per surface (so deleting any single file doesn't break the test)
// and used as the `filePath` for both checks — for config resolution in WIRING
// and for surface-honest snippet linting in FIRES.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import tsparser from '@typescript-eslint/parser';
import { ESLint, type Rule } from 'eslint';
import { beforeAll, describe, expect, it } from 'vitest';
import { coveredSilentSwallowSurfaces } from '../silentSwallowSurfaceCoverage.mjs';
// The real rule module — same one eslint.config.mjs registers under the
// `rebel-silent-swallow` plugin. Reused so the FIRES check exercises the actual
// rule, not a copy.
import noSilentSwallowRule from '../../eslint-rules/no-silent-swallow.js';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), '..', '..');

const RULE_ID = 'rebel-silent-swallow/no-silent-swallow';

// A known-bad swallow: a bare empty catch. By the rule's own design this is an
// `emptyCatch` violation, and it is parse-valid TypeScript on every surface.
const KNOWN_BAD_SWALLOW = [
  'function risky(): void {}',
  'try {',
  '  risky();',
  '} catch (error) {',
  '}',
  '',
].join('\n');

// First path segment(s) that map to each covered surface. Mirrors the surface
// roots in scripts/silentSwallowSurfaceCoverage.mjs (SURFACE_GLOBS) and the
// 1:1 first-segment mapping documented there. Kept here as a local lookup only
// to DISCOVER a representative real file; the authoritative covered-surface LIST
// still comes from coveredSilentSwallowSurfaces() so a dropped surface fails.
const SURFACE_SEARCH_ROOTS: Record<string, string[]> = {
  src: ['src'],
  private: ['private/mindstone/src'],
  'cloud-service': ['cloud-service/src'],
  'cloud-client': ['cloud-client/src'],
  mobile: ['mobile/src', 'mobile/app'],
};

function isLintableSource(filePath: string): boolean {
  if (!filePath.endsWith('.ts') && !filePath.endsWith('.tsx')) return false;
  if (filePath.endsWith('.d.ts')) return false;
  if (/\.(test|spec)\.tsx?$/.test(filePath)) return false;
  if (filePath.includes(`${path.sep}__tests__${path.sep}`)) return false;
  if (filePath.includes(`${path.sep}__fixtures__${path.sep}`)) return false;
  return true;
}

/**
 * Find a real, existing, lintable source file under a surface's roots, to use as
 * the representative path for that surface. Fails loudly (returns null) if none
 * found so the caller can surface a clear error rather than silently skip.
 */
function findRepresentativeFile(surface: string): string | null {
  const roots = SURFACE_SEARCH_ROOTS[surface];
  if (!roots) return null;
  for (const root of roots) {
    const absRoot = path.join(REPO_ROOT, root);
    if (!fs.existsSync(absRoot)) continue;
    const found = walkForFirstSource(absRoot);
    if (found) return found;
  }
  return null;
}

function walkForFirstSource(dir: string): string | null {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  // Deterministic order so the chosen representative is stable across runs.
  entries.sort((a, b) => a.name.localeCompare(b.name));
  const files = entries.filter((e) => e.isFile());
  for (const file of files) {
    const full = path.join(dir, file.name);
    if (isLintableSource(full)) return full;
  }
  const dirs = entries.filter(
    (e) => e.isDirectory() && e.name !== 'node_modules' && e.name !== '__tests__' && e.name !== '__fixtures__',
  );
  for (const sub of dirs) {
    const found = walkForFirstSource(path.join(dir, sub.name));
    if (found) return found;
  }
  return null;
}

function toSeverity(ruleConfig: unknown): number {
  if (typeof ruleConfig === 'number') return ruleConfig;
  if (typeof ruleConfig === 'string') {
    if (ruleConfig === 'off') return 0;
    if (ruleConfig === 'warn') return 1;
    if (ruleConfig === 'error') return 2;
    return 0;
  }
  if (Array.isArray(ruleConfig)) return toSeverity(ruleConfig[0]);
  return 0;
}

// WIRING instance: the REAL config. Used by check (1) via calculateConfigForFile.
let eslint: ESLint;
// FIRES instance: minimal, non-type-aware. Mirrors ONLY the silent-swallow block
// (same real rule module + parser, no `parserOptions.project`) so executing the
// rule never builds a TypeScript program. See the header note for why.
let firesEslint: ESLint;
const coveredSurfaces = coveredSilentSwallowSurfaces();

beforeAll(() => {
  // Allow overriding the config path so a mutation/non-vacuity check can point
  // the smoke at a config WITHOUT the rule and confirm it goes red.
  const configPath =
    process.env.SILENT_SWALLOW_SMOKE_CONFIG ?? path.join(REPO_ROOT, 'eslint.config.mjs');
  eslint = new ESLint({
    cwd: REPO_ROOT,
    overrideConfigFile: configPath,
    // Lint our snippet regardless of .eslintignore / ignore patterns; we are
    // probing config resolution + rule firing for the surface, not auditing.
    ignore: false,
  });

  // The rule module is plain (untyped) JS; cast to the ESLint Rule type so the
  // inline plugin satisfies ESLint's `Plugin` shape.
  const silentSwallowPlugin = {
    rules: { 'no-silent-swallow': noSilentSwallowRule as unknown as Rule.RuleModule },
  };
  firesEslint = new ESLint({
    cwd: REPO_ROOT,
    // Use only this inline config — do not discover eslint.config.mjs (which is
    // what drags in the type-aware blocks). `files` must match so the parser +
    // rule apply to the linted `.ts`/`.tsx` snippet path.
    overrideConfigFile: true,
    ignore: false,
    overrideConfig: [
      {
        files: ['**/*.ts', '**/*.tsx'],
        languageOptions: {
          parser: tsparser,
          parserOptions: {
            ecmaVersion: 'latest',
            sourceType: 'module',
            ecmaFeatures: { jsx: true },
          },
        },
        plugins: { 'rebel-silent-swallow': silentSwallowPlugin },
        rules: { [RULE_ID]: 'warn' },
      },
    ],
  });
});

describe('silent-swallow rule-presence smoke (D2)', () => {
  it('the SSOT reports at least one covered surface', () => {
    // Defends against a future SSOT edit that empties the covered set, which
    // would otherwise make this whole suite vacuously pass.
    expect(coveredSurfaces.length).toBeGreaterThan(0);
  });

  it.each(coveredSurfaces)(
    'surface "%s": rule is configured (warn|error) AND fires on a known-bad swallow',
    async (surface) => {
      const representative = findRepresentativeFile(surface);
      expect(
        representative,
        `No representative source file found for covered surface "${surface}". ` +
          'Update SURFACE_SEARCH_ROOTS or check the surface still has source files.',
      ).not.toBeNull();
      const filePath = representative as string;

      // (1) WIRING: the real config resolves the rule to warn-or-error here.
      const config = await eslint.calculateConfigForFile(filePath);
      const severity = toSeverity(config.rules?.[RULE_ID]);
      expect(
        severity,
        `Rule ${RULE_ID} is not configured (warn|error) for surface "${surface}" ` +
          `(representative: ${path.relative(REPO_ROOT, filePath)}). It must be ` +
          'warn or error — a disabled/removed rule is exactly what this smoke guards against.',
      ).toBeGreaterThanOrEqual(1);

      // (1b) PARSER PARITY: the real merged config must resolve this surface's
      // path to the SAME parser the minimal FIRES instance uses
      // (@typescript-eslint/parser). Because FIRES is decoupled from the full
      // config (see header), this is what keeps the most plausible accidental
      // drift covered: if a later real-config block swapped the parser for a
      // surface to something that can't produce the AST the rule reads, FIRES
      // (always tsparser) would mask it — but this check goes RED. Cheap: config
      // resolution only, no linting, so no TypeScript program build.
      const resolvedParserName = (
        config.languageOptions?.parser as { meta?: { name?: string } } | undefined
      )?.meta?.name;
      const expectedParserName = (tsparser as { meta?: { name?: string } }).meta?.name;
      expect(
        resolvedParserName,
        `Real config resolves surface "${surface}" (representative: ` +
          `${path.relative(REPO_ROOT, filePath)}) to parser "${resolvedParserName}", not ` +
          `the "${expectedParserName}" the FIRES check mirrors. The minimal instance would ` +
          'mask a parser regression here — re-align the mirror or the real config.',
      ).toBe(expectedParserName);

      // (2) FIRES: linting a known-bad swallow at this surface's path actually
      // produces the diagnostic (GPT-r2-F2 — wiring alone is insufficient).
      // Uses the minimal non-type-aware instance so the rule executes without a
      // TypeScript program build (see header note: full-config lint times out in CI).
      const results = await firesEslint.lintText(KNOWN_BAD_SWALLOW, { filePath });
      const messages = results[0]?.messages ?? [];
      const parseErrors = messages.filter((m) => m.ruleId === null);
      expect(
        parseErrors,
        `Known-bad fixture failed to parse on surface "${surface}": ` +
          parseErrors.map((m) => m.message).join('; '),
      ).toHaveLength(0);
      const fired = messages.filter((m) => m.ruleId === RULE_ID);
      expect(
        fired.length,
        `Rule ${RULE_ID} did NOT fire on a known-bad empty catch for surface ` +
          `"${surface}" (representative: ${path.relative(REPO_ROOT, filePath)}). ` +
          'The rule is configured but not actually firing here — the gate is ineffective.',
      ).toBeGreaterThanOrEqual(1);
    },
  );
});
