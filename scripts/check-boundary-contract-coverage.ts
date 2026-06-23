#!/usr/bin/env npx tsx
/**
 * CI warn-gate: boundary seam → behavioral contract-test coverage.
 *
 * Background (Research A — `docs/plans/260604_testing-bug-catching/
 * subagent_reports/260604_000002_researcher-enforcement-gate.md`): the boundary
 * registry (`docs/project/boundary-registry.yaml`) names cross-process /
 * cross-module seams whose silent drift has caused regressions, but it does NOT
 * verify any *behavioral test coverage* of those seams. This gate closes the
 * "a registered seam has literally no contract test and nobody noticed" class
 * BY CONSTRUCTION, for the subset of entries that opt in by declaring a
 * `contract_test:` field.
 *
 * WHAT THIS GATE DOES (per OPTED-IN entry only)
 * ---------------------------------------------
 * For every `boundaries[]` entry that declares a `contract_test:` list, assert:
 *   (a) EXISTS       — each listed path resolves to a real file on disk.
 *                      A `contract_test` pointing at a moved/deleted file is an
 *                      ORPHAN violation (sk-allowlist drift-detection pattern).
 *   (b) TEST-SHAPED — each listed path is a `*.{test,spec}.{ts,tsx}` file. This
 *                      is NOT a claim the test is RUN by validate:fast: today
 *                      validate:fast runs only `tests/parity` + a tiebreaker,
 *                      NOT the general desktop suite, so the src/** cohort tests
 *                      are not executed by validate:fast. The honest claim is
 *                      only "this is a test-shaped file that imports the owner".
 *                      A real "actually-run-in-validate:fast reachability" check
 *                      is a FOLLOW-UP for enforce-promotion (not built here).
 *   (c) IMPORT-GRAPH FLOOR — the test file's SOURCE (parsed via the TypeScript
 *                      compiler API — so commented-out and string-literal
 *                      "imports" do NOT count) imports the entry's `owned_by`
 *                      module, by relative OR aliased (`@core/...`) specifier.
 *                      A test that doesn't even import the owning module clearly
 *                      doesn't exercise the seam (Research A risk R1 mitigation:
 *                      the cheap "is this theatre?" floor). `owned_by` may list
 *                      several modules joined by the literal ` + `; the floor is
 *                      satisfied if the test imports ANY of them. If `owned_by`
 *                      is absent, (c) is SKIPPED (noted in output).
 *
 * Entries that do NOT declare `contract_test:` (and have no waiver) are IGNORED
 * — this gate is strictly opt-in so the ~31 currently-untested seams are not
 * red-flagged. As coverage is backfilled, more entries declare the field.
 *
 * WAIVER ESCAPE HATCH
 * -------------------
 * An entry that is genuinely covered by construction (e.g. brand-typed
 * kill-by-construction) and has NO runtime contract test can carry
 * `contract_test_waiver: "<reason>"`. The reason must be >= 30 chars and free of
 * weak markers (TODO/FIXME/WIP/temp/later) — reusing the cross-surface-parity
 * rationale-strength discipline. A valid waiver opts the seam out of runtime
 * checks. Declaring BOTH `contract_test` and a waiver is a CONFIG ERROR
 * (bad-schema) — a waiver must not let a stale/orphaned declared test silently
 * stop mattering.
 *
 * MALFORMED OPT-IN (bad-schema)
 * -----------------------------
 * A malformed coverage opt-in — `contract_test` that is a scalar / empty array /
 * has a non-string element, a non-string `owned_by`/`contract_test_waiver`, or
 * both `contract_test` + waiver — is itself a violation (`bad-schema`), so a bad
 * edit cannot silently drop an entry out of enforcement. Like every other kind
 * it is warn-only (exit 0) by default and fails only under --enforce.
 *
 * POSTURE — ENFORCING (promoted 2026-06-06 after the warn-first soft-launch
 * validated 6 opted-in seams all passing)
 * ------------------------------------------------------------------------
 * The script's intrinsic DEFAULT is still WARN-ONLY (prints a clear
 * `[boundary-contract-coverage] ADVISORY` and exits 0 when run with no flag —
 * so running the file directly is non-blocking). Blocking is opted into with
 * EITHER:
 *   - env `BOUNDARY_CONTRACT_COVERAGE_ENFORCE=1`, OR
 *   - `--enforce` on the command line.
 * In enforce mode any violation (or an unparseable registry) exits 1.
 *
 * The `npm run validate:boundary-contract-coverage` script now passes
 * `--enforce`, so both standalone runs and `validate:fast` (which invokes that
 * script) BLOCK on a violation. An opted-in seam that loses its `contract_test`
 * or breaks the import-floor fails the build. NOTE: this enforces presence +
 * import-floor, NOT that the named test is actually run / non-vacuous — the
 * run-reachability check remains a deeper follow-up.
 */

import * as fsSync from 'node:fs';
import * as path from 'node:path';
import * as ts from 'typescript';
import { parse as parseYaml } from 'yaml';

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/** Env var that promotes the gate from warn-only to blocking. */
const ENV_ENFORCE = 'BOUNDARY_CONTRACT_COVERAGE_ENFORCE';

/**
 * Repo path aliases, mirrored from `vitest.config.ts` `sharedAliases` (and the
 * production renderer/tsconfig `paths`). A test that imports the owning module
 * via an alias (e.g. `@core/rebelCore/providerRouting`) must normalize to the
 * same repo-relative stem as a `../providerRouting` relative import, or the
 * import-graph floor would false-FAIL it. Longest prefixes are matched first so
 * `@rebel/shared` wins over a hypothetical `@rebel`. Keep in sync with
 * vitest.config.ts; `validate:alias-integrity` guards the canonical alias set.
 */
export const REPO_ALIASES: ReadonlyArray<readonly [alias: string, target: string]> = [
  ['@rebel/shared', 'packages/shared/src'],
  ['@rebel/cloud-client', 'cloud-client/src'],
  ['@core', 'src/core'],
  ['@shared', 'src/shared'],
  ['@main', 'src/main'],
  ['@renderer', 'src/renderer'],
  ['@', 'src/renderer'],
];

/** Registry path, repo-relative. */
export const REGISTRY_PATH = 'docs/project/boundary-registry.yaml';

/** Minimum waiver length, and weak markers that void a waiver. */
export const MIN_WAIVER_LENGTH = 30;
const WEAK_WAIVER_PATTERNS: readonly { pattern: RegExp; label: string }[] = [
  { pattern: /\bTODO\b/iu, label: 'TODO' },
  { pattern: /\bFIXME\b/iu, label: 'FIXME' },
  { pattern: /\bXXX\b/iu, label: 'XXX' },
  { pattern: /\bWIP\b/iu, label: 'WIP' },
  { pattern: /\btemp(orary)?\b/iu, label: 'temp/temporary' },
  { pattern: /\blater\b/iu, label: 'later' },
];

/**
 * Test-shaped basename: `*.{test,spec}.{ts,tsx}`. A `contract_test` MUST be a
 * test-shaped file — NOT merely something under `__tests__/`/`tests/` (a
 * `__tests__/helper.ts` is not a test file and would false-pass under a dir-only
 * rule). vitest discovers tests by this basename glob, so this is the honest
 * "is this a test file?" check.
 */
const TEST_BASENAME_RE = /\.(test|spec)\.(ts|tsx)$/u;

// ---------------------------------------------------------------------------
// Injectable fs (so the pure core is unit-testable with fakes)
// ---------------------------------------------------------------------------

export interface FsLike {
  /** Return file contents, or null if the path does not exist / is not a file. */
  readFile(repoRelativePath: string): string | null;
  /** True if the path exists (as a file). */
  exists(repoRelativePath: string): boolean;
}

/** Real, repo-rooted fs adapter. */
export function makeRealFs(repoRoot: string): FsLike {
  const abs = (p: string): string => path.resolve(repoRoot, p);
  return {
    readFile(p: string): string | null {
      try {
        const full = abs(p);
        if (!fsSync.existsSync(full) || !fsSync.statSync(full).isFile()) return null;
        return fsSync.readFileSync(full, 'utf8');
      } catch {
        return null;
      }
    },
    exists(p: string): boolean {
      try {
        const full = abs(p);
        return fsSync.existsSync(full) && fsSync.statSync(full).isFile();
      } catch {
        return false;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Waiver validation — pure, exported for testing
// ---------------------------------------------------------------------------

export type WaiverVerdict = { valid: true } | { valid: false; explanation: string };

export function validateWaiver(rawWaiver: string): WaiverVerdict {
  const trimmed = rawWaiver.trim();
  if (trimmed.length < MIN_WAIVER_LENGTH) {
    return {
      valid: false,
      explanation: `waiver is ${trimmed.length} chars; minimum ${MIN_WAIVER_LENGTH} required — state the concrete reason this seam is covered by construction (e.g. brand-typed kill-by-construction) and needs no runtime contract_test`,
    };
  }
  for (const { pattern, label } of WEAK_WAIVER_PATTERNS) {
    if (pattern.test(trimmed)) {
      return {
        valid: false,
        explanation: `waiver contains weak marker "${label}" — explain the actual reason a contract test is unnecessary, not a deferral`,
      };
    }
  }
  return { valid: true };
}

// ---------------------------------------------------------------------------
// Import-graph floor — pure, exported for testing
// ---------------------------------------------------------------------------

/**
 * Split an `owned_by` string into individual module paths. The registry joins
 * multiple owning modules with the literal ` + ` convention (e.g.
 * "src/core/rebelCore/providerRouteHeaders.ts + src/main/services/localModelProxyServer.ts").
 * Split on ` + ` (whitespace-bracketed plus) — NOT every `+` — so a path that
 * legitimately contains a `+` character is not corrupted.
 */
export function parseOwnedByModules(ownedBy: string | undefined): string[] {
  if (ownedBy === undefined) return [];
  return ownedBy
    .split(/\s+\+\s+/u)
    .map((m) => m.trim())
    .filter((m) => m.length > 0);
}

/** Strip a TS/TSX extension and trailing `/index` for comparison. */
function moduleStem(p: string): string {
  let s = p.replace(/\\/g, '/').replace(/\.(ts|tsx|js|jsx|mts|cts)$/u, '');
  if (s.endsWith('/index')) s = s.slice(0, -'/index'.length);
  return s;
}

/**
 * Resolve an import specifier (as it appears in a test) to a repo-relative,
 * extension-stripped stem, or null if it cannot be resolved to a repo path.
 *   - relative (`./`, `../`) → resolved against the importing file's directory.
 *   - aliased (`@core/...`, `@rebel/shared/...`, …) → mapped via REPO_ALIASES.
 *   - bare/package specifiers → null (cannot be a repo-relative owning module).
 */
export function resolveImportSpecifierToStem(importerRelPath: string, spec: string): string | null {
  if (spec.startsWith('.')) {
    const dir = path.posix.dirname(importerRelPath.replace(/\\/g, '/'));
    return moduleStem(path.posix.normalize(path.posix.join(dir, spec)));
  }
  for (const [alias, target] of REPO_ALIASES) {
    if (spec === alias) return moduleStem(target);
    if (spec.startsWith(`${alias}/`)) {
      const rest = spec.slice(alias.length + 1);
      return moduleStem(path.posix.normalize(path.posix.join(target, rest)));
    }
  }
  return null;
}

/**
 * Extract the set of repo-relative module stems a test file ACTUALLY imports,
 * using the TypeScript compiler API (not a raw regex). Walking the AST means a
 * commented-out import (`// import … from '../foo'`) or a specifier that only
 * appears inside a string literal is NOT counted — only real
 * `import`/`export …  from`, dynamic `import('…')`, and `require('…')` module
 * specifiers. Relative AND known-alias specifiers are normalized to repo-relative
 * stems; bare/package specifiers are dropped.
 */
export function extractImportedModuleStems(testRelPath: string, source: string): Set<string> {
  const stems = new Set<string>();
  const sourceFile = ts.createSourceFile(testRelPath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

  const add = (spec: string): void => {
    const stem = resolveImportSpecifierToStem(testRelPath, spec);
    if (stem !== null) stems.add(stem);
  };

  const visit = (node: ts.Node): void => {
    // `import … from 'spec'` and `export … from 'spec'`
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      add(node.moduleSpecifier.text);
    }
    // `import x = require('spec')`
    if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      node.moduleReference.expression !== undefined &&
      ts.isStringLiteral(node.moduleReference.expression)
    ) {
      add(node.moduleReference.expression.text);
    }
    // dynamic `import('spec')` and `require('spec')`
    if (ts.isCallExpression(node)) {
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require';
      if ((isDynamicImport || isRequire) && node.arguments.length > 0) {
        const arg = node.arguments[0];
        if (ts.isStringLiteral(arg)) add(arg.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return stems;
}

/**
 * True if the test source imports AT LEAST ONE of the owned modules. Comparison
 * is on extension-stripped repo-relative stems (relative + alias specifiers are
 * resolved/normalized first; comment- and string-literal "imports" are excluded
 * by the AST walk).
 */
export function testImportsOwnedModule(
  testRelPath: string,
  testSource: string,
  ownedModules: readonly string[],
): boolean {
  const importStems = extractImportedModuleStems(testRelPath, testSource);
  const ownedStems = ownedModules.map(moduleStem);
  for (const owned of ownedStems) {
    if (importStems.has(owned)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Discoverability — pure
// ---------------------------------------------------------------------------

/**
 * A `contract_test` must be a test-SHAPED file (`*.{test,spec}.{ts,tsx}`). Being
 * merely under `__tests__/`/`tests/` is NOT sufficient (a `__tests__/helper.ts`
 * is a helper, not a test, and would false-pass a dir-only rule).
 */
export function isDiscoverableTestPath(p: string): boolean {
  const norm = p.replace(/\\/g, '/');
  const basename = norm.slice(norm.lastIndexOf('/') + 1);
  return TEST_BASENAME_RE.test(basename);
}

// ---------------------------------------------------------------------------
// Registry model + core violation finder — pure, exported for testing
// ---------------------------------------------------------------------------

export interface RegistryEntry {
  readonly id: string;
  readonly owned_by?: string;
  readonly contract_test?: readonly string[];
  readonly contract_test_waiver?: string;
  /**
   * True when the raw YAML had a malformed coverage opt-in (e.g. `contract_test`
   * present but not a string array, non-string `owned_by`/`contract_test_waiver`).
   * The parser records this rather than silently coercing/dropping, so a bad
   * edit cannot silently disappear from enforcement. `schemaErrors` carries the
   * human-readable reasons; presence is also signalled even when the entry would
   * otherwise look opted-out.
   */
  readonly schemaErrors?: readonly string[];
}

export interface Violation {
  readonly entryId: string;
  readonly kind: 'orphan' | 'not-discoverable' | 'import-floor' | 'bad-waiver' | 'bad-schema';
  readonly message: string;
}

export interface CoverageReport {
  readonly violations: readonly Violation[];
  /** Entry ids that declared `contract_test:` and were checked. */
  readonly checkedEntryIds: readonly string[];
  /** Entry ids suppressed by a valid waiver. */
  readonly waivedEntryIds: readonly string[];
  /** Entry ids whose floor (c) was skipped because `owned_by` is absent. */
  readonly floorSkippedEntryIds: readonly string[];
}

export interface FindOptions {
  readonly fs: FsLike;
  /** Pre-parsed registry entries (the CLI parses YAML; tests can inject directly). */
  readonly entries: readonly RegistryEntry[];
}

/**
 * Core: evaluate every entry that declares `contract_test:`. Pure — all fs
 * access is via the injected `options.fs`.
 */
export function findContractCoverageViolations(options: FindOptions): CoverageReport {
  const { fs, entries } = options;
  const violations: Violation[] = [];
  const checkedEntryIds: string[] = [];
  const waivedEntryIds: string[] = [];
  const floorSkippedEntryIds: string[] = [];

  for (const entry of entries) {
    // F3: malformed opt-in schema is a violation in its own right — a bad edit
    // must NOT silently vanish from enforcement. Reported for any entry that
    // touched the coverage fields, regardless of whether it otherwise looks
    // opted-in.
    if (entry.schemaErrors !== undefined && entry.schemaErrors.length > 0) {
      if (!checkedEntryIds.includes(entry.id)) checkedEntryIds.push(entry.id);
      for (const reason of entry.schemaErrors) {
        violations.push({
          entryId: entry.id,
          kind: 'bad-schema',
          message: `seam "${entry.id}" has a malformed contract-coverage opt-in — ${reason}.`,
        });
      }
      // Don't try to run runtime checks on a malformed entry — the surfaced
      // schema error is the actionable signal.
      continue;
    }

    const declared = entry.contract_test;
    const hasWaiver = entry.contract_test_waiver !== undefined;

    // F5: a waiver is for entries with NO runtime contract_test ("covered by
    // construction"). Declaring BOTH is a config error — otherwise a stale /
    // orphaned declared test silently stops mattering behind waiver prose.
    if (declared !== undefined && declared.length > 0 && hasWaiver) {
      checkedEntryIds.push(entry.id);
      violations.push({
        entryId: entry.id,
        kind: 'bad-schema',
        message: `seam "${entry.id}" declares BOTH contract_test and contract_test_waiver — a waiver is only for seams with NO runtime contract test (covered by construction). Use one or the other.`,
      });
      continue;
    }

    if (declared === undefined || declared.length === 0) {
      // Waiver-only entry: a valid waiver opts the seam out of runtime checks.
      if (hasWaiver) {
        checkedEntryIds.push(entry.id);
        const verdict = validateWaiver(entry.contract_test_waiver as string);
        if (verdict.valid) {
          waivedEntryIds.push(entry.id);
        } else {
          violations.push({
            entryId: entry.id,
            kind: 'bad-waiver',
            message: `seam "${entry.id}" declares a contract_test_waiver but it is REJECTED — ${verdict.explanation}. The waiver does not suppress this entry.`,
          });
        }
      }
      continue; // opt-in only (no contract_test and no waiver → ignored)
    }

    // contract_test-only entry: run the runtime checks.
    checkedEntryIds.push(entry.id);

    const ownedModules = parseOwnedByModules(entry.owned_by);
    const floorApplies = ownedModules.length > 0;
    if (!floorApplies) floorSkippedEntryIds.push(entry.id);

    for (const testPath of declared) {
      // (a) EXISTS
      const source = fs.readFile(testPath);
      if (source === null) {
        violations.push({
          entryId: entry.id,
          kind: 'orphan',
          message: `seam "${entry.id}" declares contract_test "${testPath}" which does NOT exist (orphaned — was it moved/renamed/deleted? update the registry).`,
        });
        continue; // can't check (b)/(c) for a missing file
      }

      // (b) DISCOVERABLE
      if (!isDiscoverableTestPath(testPath)) {
        violations.push({
          entryId: entry.id,
          kind: 'not-discoverable',
          message: `seam "${entry.id}" contract_test "${testPath}" is not a test-shaped file (*.{test,spec}.{ts,tsx}) — point it at an actual test file, not a helper/fixture.`,
        });
      }

      // (c) IMPORT-GRAPH FLOOR (skipped when owned_by absent)
      if (floorApplies && !testImportsOwnedModule(testPath, source, ownedModules)) {
        violations.push({
          entryId: entry.id,
          kind: 'import-floor',
          message:
            `seam "${entry.id}" contract_test "${testPath}" does not import the owning module(s) ` +
            `[${ownedModules.join(', ')}] — a test that never imports the seam's owner cannot exercise it ` +
            `(import-graph floor). Point contract_test at a test that imports an owned_by module, or add a contract_test_waiver.`,
        });
      }
    }
  }

  return { violations, checkedEntryIds, waivedEntryIds, floorSkippedEntryIds };
}

// ---------------------------------------------------------------------------
// Registry parsing (for the CLI) — fail-closed only in enforce mode
// ---------------------------------------------------------------------------

export class RegistryParseError extends Error {}

export function parseRegistryEntries(yamlText: string): RegistryEntry[] {
  let doc: unknown;
  try {
    doc = parseYaml(yamlText);
  } catch (err) {
    throw new RegistryParseError(`YAML parse failed: ${(err as Error).message}`);
  }
  const root = doc as Record<string, unknown> | null;
  if (!root || !Array.isArray(root.boundaries)) {
    throw new RegistryParseError(`registry missing 'boundaries' array`);
  }
  return (root.boundaries as unknown[]).map((raw, i): RegistryEntry => {
    const e = (raw ?? {}) as Record<string, unknown>;
    const id = typeof e.id === 'string' ? e.id : `<entry[${i}]>`;
    const schemaErrors: string[] = [];

    // owned_by: optional, but if present must be a string. A non-string would
    // otherwise silently skip the import-graph floor.
    let ownedBy: string | undefined;
    if (e.owned_by !== undefined) {
      if (typeof e.owned_by === 'string') {
        ownedBy = e.owned_by;
      } else {
        schemaErrors.push(`owned_by must be a string when present (got ${typeof e.owned_by})`);
      }
    }

    // contract_test: optional, but if present must be a NON-EMPTY array of
    // strings. A scalar / empty / mixed-type list would otherwise be silently
    // dropped, removing the entry from enforcement with no signal.
    let contractTest: string[] | undefined;
    if (e.contract_test !== undefined) {
      if (!Array.isArray(e.contract_test)) {
        schemaErrors.push(`contract_test must be a non-empty array of strings (got ${typeof e.contract_test})`);
      } else if (e.contract_test.length === 0) {
        schemaErrors.push('contract_test is an empty array — remove it or list at least one test file');
      } else if (!e.contract_test.every((x) => typeof x === 'string')) {
        schemaErrors.push('contract_test must contain only string paths (found a non-string element)');
      } else {
        contractTest = e.contract_test as string[];
      }
    }

    // contract_test_waiver: optional, but if present must be a string.
    let waiver: string | undefined;
    if (e.contract_test_waiver !== undefined) {
      if (typeof e.contract_test_waiver === 'string') {
        waiver = e.contract_test_waiver;
      } else {
        schemaErrors.push(`contract_test_waiver must be a string when present (got ${typeof e.contract_test_waiver})`);
      }
    }

    return {
      id,
      owned_by: ownedBy,
      contract_test: contractTest,
      contract_test_waiver: waiver,
      schemaErrors: schemaErrors.length > 0 ? schemaErrors : undefined,
    };
  });
}

// ---------------------------------------------------------------------------
// CLI runner — skipped under Vitest / when imported
// ---------------------------------------------------------------------------

export function isEnforcing(argv: readonly string[]): boolean {
  if (argv.includes('--enforce')) return true;
  const env = process.env[ENV_ENFORCE];
  return env !== undefined && env !== '' && env !== '0' && env.toLowerCase() !== 'false';
}

export interface CliIo {
  readonly log: (msg: string) => void;
  readonly warn: (msg: string) => void;
  readonly error: (msg: string) => void;
}

const consoleIo: CliIo = {
  log: (m) => console.log(m),
  warn: (m) => console.warn(m),
  error: (m) => console.error(m),
};

/**
 * Pure-ish CLI: returns the intended exit code (0 = pass/warn, 1 = fail in
 * enforce mode) instead of calling `process.exit`, so it is unit-testable. The
 * real entry point below maps the returned code to `process.exit`.
 */
export function runCli(opts: {
  argv: readonly string[];
  fs: FsLike;
  registryText: string | null;
  io?: CliIo;
}): number {
  const io = opts.io ?? consoleIo;
  const enforce = isEnforcing(opts.argv);
  const mode = enforce ? 'ENFORCE (blocking)' : 'WARN (advisory, non-blocking)';

  io.log('[boundary-contract-coverage] boundary seam → contract-test coverage gate');
  io.log(`[boundary-contract-coverage] Mode: ${mode}`);

  if (opts.registryText === null) {
    const msg = `[boundary-contract-coverage] cannot read registry at ${REGISTRY_PATH}`;
    if (enforce) {
      io.error(msg);
      return 1;
    }
    io.warn(`${msg} — WARN mode, not failing.`);
    return 0;
  }

  let entries: RegistryEntry[];
  try {
    entries = parseRegistryEntries(opts.registryText);
  } catch (err) {
    const msg = `[boundary-contract-coverage] registry unparseable: ${(err as Error).message}`;
    if (enforce) {
      io.error(msg);
      return 1;
    }
    io.warn(`${msg} — WARN mode, not failing.`);
    return 0;
  }

  const report = findContractCoverageViolations({ fs: opts.fs, entries });

  io.log(
    `[boundary-contract-coverage] Checked ${report.checkedEntryIds.length} opted-in seam(s): ` +
      `${report.checkedEntryIds.join(', ') || '(none)'}`,
  );
  if (report.waivedEntryIds.length > 0) {
    io.log(`[boundary-contract-coverage] Waived (valid waiver): ${report.waivedEntryIds.join(', ')}`);
  }
  if (report.floorSkippedEntryIds.length > 0) {
    io.log(
      `[boundary-contract-coverage] Import-graph floor SKIPPED (no owned_by): ${report.floorSkippedEntryIds.join(', ')}`,
    );
  }

  if (report.violations.length === 0) {
    io.log(
      `[boundary-contract-coverage] OK — all ${report.checkedEntryIds.length} opted-in seam(s) name a test-shaped file (*.test/spec) that imports the owning module. (NOTE: this does NOT verify the test is actually run by validate:fast — that reachability check is a follow-up for enforce-promotion.)`,
    );
    return 0;
  }

  const detail = ['', '  Violations:', ...report.violations.map((v) => `    - [${v.kind}] ${v.message}`), ''].join('\n');

  if (enforce) {
    io.error(`[boundary-contract-coverage] FAIL — ${report.violations.length} violation(s).`);
    io.error(detail);
    return 1;
  }

  io.warn(
    `[boundary-contract-coverage] ADVISORY (warn-only) — ${report.violations.length} violation(s) in opted-in seams.`,
  );
  io.warn(detail);
  io.warn(
    `[boundary-contract-coverage] WARN mode — not failing. Set ${ENV_ENFORCE}=1 (or pass --enforce) to make this blocking.`,
  );
  // Intentionally return 0 so validate:fast is not failed during the soft launch.
  return 0;
}

function main(argv: readonly string[]): void {
  const repoRoot = path.resolve(__dirname, '..');
  const fs = makeRealFs(repoRoot);
  const code = runCli({ argv, fs, registryText: fs.readFile(REGISTRY_PATH) });
  if (code !== 0) process.exit(code);
}

if (require.main === module) {
  main(process.argv.slice(2));
}
