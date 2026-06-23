/**
 * Mock-contract guard for heavily-mocked shared modules (Stage 10 of
 * docs/plans/260610_testing-recs-drain; rec 8b4e50eb91b72dfd, the
 * `manual_vitest_mock_staleness` family — see
 * docs-private/postmortems/260607_add_missing_recordknownconditionledgeronly_mock_export_in_038fa2a_postmortem.md).
 *
 * The incident class: a curated shared module gains a production-called
 * export; sibling test files that `vi.mock()` the module with a hand-written
 * factory don't provide it, so any tested path calling the new export throws
 * `No <name> export is defined on the mock` — but only when that suite runs,
 * which merge-gated related-test selection routinely skips. This guard makes
 * the drift visible at validate:fast time instead.
 *
 * Contract (per Amendment A1's Stage-10 rescope — zero-baseline full-export
 * enforcement was measured DOA at 82/82 violations): a `vi.mock()` factory for
 * a curated module is OK when it
 *   (a) spreads the real module (`importOriginal` / `vi.importActual`), OR
 *   (b) carries a `// mock-contract: partial — <reason>` annotation within the
 *       3 lines above the `vi.mock(` call, OR
 *   (c) provides every export in the module's curated production-called set.
 * Anything else is a violation. Pre-existing violations are grandfathered in
 * scripts/checks/mockContractsBaseline.json (a ratchet: entries are exact
 * `file :: module :: missingExport` triples, so when a curated module gains a
 * NEW production-called export, every stale factory is a NEW violation and
 * fails — replaying the 038fa2a incident — while the legacy tail stays green).
 *
 * Ratchet maintenance: fixing a factory (or deleting a test) leaves stale
 * baseline entries, which FAIL with a remove-this-line message (mirrors the
 * orphaned-tests stale-allowlist behaviour; keeps the ratchet monotone).
 * Regenerate after legitimate ratchet-down with:
 *   npx tsx scripts/checks/checkMockContracts.ts --update-baseline
 * (Review the diff: the baseline must only ever shrink, except when a curated
 * module/export is deliberately added to the registry below.)
 *
 * Detection is heuristic-by-design (text scan, string/comment-aware paren
 * matching — not a full AST): factories that build their object via an
 * out-of-scope helper variable may be flagged even if the helper provides the
 * exports. The `mock-contract: partial` annotation is the escape hatch.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { gitCapture } from '../lib/git-exec';
import type { GuardRunResult, TestingGuardModule } from './types';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BASELINE_PATH = path.join(REPO_ROOT, 'scripts', 'checks', 'mockContractsBaseline.json');

// ---------------------------------------------------------------------------
// Curated module registry (first-class data)
// ---------------------------------------------------------------------------

export interface MockContractModuleEntry {
  /** The alias spelling tests use in `vi.mock('<modulePath>')`. */
  readonly modulePath: string;
  /**
   * Additional specifier suffixes that resolve to the same module (relative
   * imports). Disambiguating — at least one parent dir, never a bare
   * basename (scripts/rebel-cli/errorReporter.ts is a different module).
   */
  readonly specifierSuffixes: readonly string[];
  /**
   * The CURATED production-called export set — exports that production code
   * paths actually call, so a factory omitting them breaks under vitest's
   * strict mock contract. Deliberately NOT "all exports" (A1 rescope: e.g.
   * `__resetGuardLatchesForTesting` / `KnownConditionGuardError` are not
   * required of every factory). When production code starts calling a new
   * export of a curated module, ADD IT HERE — that is what makes every stale
   * sibling factory fail (the incident replay).
   */
  readonly productionCalledExports: readonly string[];
}

export const MOCK_CONTRACT_REGISTRY: readonly MockContractModuleEntry[] = [
  {
    modulePath: '@core/sentry/captureKnownCondition',
    specifierSuffixes: ['sentry/captureKnownCondition'],
    // recordKnownConditionLedgerOnly is the 038fa2a incident export.
    productionCalledExports: ['captureKnownCondition', 'recordKnownConditionLedgerOnly'],
  },
  {
    modulePath: '@core/errorReporter',
    specifierSuffixes: ['core/errorReporter'],
    productionCalledExports: ['setErrorReporter', 'getErrorReporter'],
  },
];

// ---------------------------------------------------------------------------
// Factory extraction (string/comment-aware paren matching)
// ---------------------------------------------------------------------------

export interface MockFactorySite {
  /** Module specifier as written in the test. */
  readonly specifier: string;
  /** 1-based line of the `vi.mock(` call. */
  readonly line: number;
  /** Second-argument source text, or null for bare `vi.mock('m')` (automock). */
  readonly factoryText: string | null;
  /** The 3 source lines immediately above the call (annotation window). */
  readonly precedingLines: readonly string[];
}

const VI_MOCK_RE = /\bvi\.mock\(\s*(['"])([^'"]+)\1/g;

/**
 * Find the index just past the `)` matching the `(` at `openParen`,
 * skipping over string literals (incl. template literals) and comments.
 * Returns -1 when unbalanced (malformed source) — callers treat the
 * factory as absent rather than guessing.
 */
function findMatchingParenEnd(source: string, openParen: number): number {
  let depth = 0;
  let i = openParen;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '/' && source[i + 1] === '/') {
      const nl = source.indexOf('\n', i);
      if (nl === -1) return -1;
      i = nl + 1;
      continue;
    }
    if (ch === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      if (end === -1) return -1;
      i = end + 2;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      i += 1;
      while (i < source.length && source[i] !== ch) {
        if (source[i] === '\\') i += 1;
        i += 1;
      }
      i += 1;
      continue;
    }
    if (ch === '(') depth += 1;
    if (ch === ')') {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
    i += 1;
  }
  return -1;
}

export function extractMockFactories(source: string): MockFactorySite[] {
  const sites: MockFactorySite[] = [];
  const lines = source.split('\n');
  VI_MOCK_RE.lastIndex = 0;
  for (let match = VI_MOCK_RE.exec(source); match !== null; match = VI_MOCK_RE.exec(source)) {
    const callStart = match.index;
    const openParen = source.indexOf('(', callStart);
    const end = findMatchingParenEnd(source, openParen);
    if (end === -1) continue; // unbalanced — skip rather than misclassify
    const inner = source.slice(openParen + 1, end - 1);
    // Everything after the specifier's closing quote within the call.
    const afterSpecifier = inner.slice(inner.indexOf(match[2]) + match[2].length + 1);
    const trimmed = afterSpecifier.replace(/^\s*,/, '').trim();
    const lineNumber = source.slice(0, callStart).split('\n').length;
    sites.push({
      specifier: match[2],
      line: lineNumber,
      factoryText: trimmed.length > 0 ? trimmed : null,
      precedingLines: lines.slice(Math.max(0, lineNumber - 4), lineNumber - 1),
    });
  }
  return sites;
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

export type FactoryClassification =
  /** Bare vi.mock('m') — vitest automocks every real export; contract holds. */
  | { readonly kind: 'automock' }
  /** Factory spreads importOriginal / vi.importActual — real exports flow through. */
  | { readonly kind: 'spreads-original' }
  /** Explicit `// mock-contract: partial — <reason>` annotation above the call. */
  | { readonly kind: 'annotated-partial' }
  /** Provides every curated production-called export. */
  | { readonly kind: 'provides-all' }
  | { readonly kind: 'violation'; readonly missingExports: readonly string[] };

export const PARTIAL_ANNOTATION_RE = /\/\/\s*mock-contract:\s*partial\s*[—–-]\s*\S/;

function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');
}

/**
 * Accepted "spreads the original" grammar (over comment-stripped factory
 * text). A factory qualifies as `spreads-original` ONLY when it actually
 * SPREADS the real module, in one of two shapes:
 *
 *   (1) DIRECT spread of the awaited original (optional type args, optional
 *       parens around the await expression, optional `vi.` receiver):
 *         ...(await importOriginal())
 *         ...(await importOriginal<typeof import('m')>())
 *         ...(await vi.importActual('m'))
 *         ...await importOriginal()
 *
 *   (2) BOUND-then-spread: an identifier bound from the awaited original,
 *       later spread:
 *         const actual = await vi.importActual<T>('m');
 *         return { ...actual };
 *       (also `let`/`var`; the binding must be a plain identifier — a
 *       destructuring binding does not spread the module and falls through
 *       to the provides-every-curated-export check.)
 *
 * Merely MENTIONING importOriginal/importActual — an unused factory
 * parameter, or awaiting the original without spreading it — does NOT
 * qualify (the GPT-review F1 false-pass: such a factory is exactly the
 * 038fa2a stale shape and must reach the export check). Heuristic residue
 * (documented, accepted): the `...name` occurrence is not verified to sit
 * inside the RETURNED object literal (regex scan, not AST), so spreading the
 * bound original into e.g. a call's arguments would still qualify — but the
 * spread identifier MUST be one bound from the awaited original; spreading
 * an unrelated identifier never qualifies.
 */
const DIRECT_ORIGINAL_SPREAD_RE =
  /\.\.\.\s*\(?\s*await\s+(?:vi\s*\.\s*)?import(?:Original|Actual)\b/;
const ORIGINAL_BINDING_RE =
  /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*await\s+(?:vi\s*\.\s*)?import(?:Original|Actual)\b/g;

function escapeForRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function spreadsOriginal(bodyNoComments: string): boolean {
  if (DIRECT_ORIGINAL_SPREAD_RE.test(bodyNoComments)) return true;
  ORIGINAL_BINDING_RE.lastIndex = 0;
  for (
    let match = ORIGINAL_BINDING_RE.exec(bodyNoComments);
    match !== null;
    match = ORIGINAL_BINDING_RE.exec(bodyNoComments)
  ) {
    const spreadRe = new RegExp(String.raw`\.\.\.\s*${escapeForRegExp(match[1])}\b`);
    if (spreadRe.test(bodyNoComments)) return true;
  }
  return false;
}

/**
 * Does the factory text provide `name` as a property KEY (quoted, shorthand, or
 * method)? Key position requires a preceding `{` or `,` (whitespace allowed in
 * between) — a bare-whitespace prefix would also match VALUE position
 * (`{ makeWidget: resetWidget }` "providing" resetWidget), which false-passes
 * the guard's core contract (Phase 7 final-review F1).
 */
function providesExport(factoryTextNoComments: string, name: string): boolean {
  const re = new RegExp(
    String.raw`(?:^|[{,])\s*(?:(?:async|get|set)\s+)?(['"]?)${name}\1\s*[:,}(]`,
  );
  return re.test(factoryTextNoComments);
}

export function classifyFactory(
  site: MockFactorySite,
  productionCalledExports: readonly string[],
): FactoryClassification {
  if (site.factoryText === null) return { kind: 'automock' };
  if (site.precedingLines.some((line) => PARTIAL_ANNOTATION_RE.test(line))) {
    return { kind: 'annotated-partial' };
  }
  const body = stripComments(site.factoryText);
  if (spreadsOriginal(body)) {
    return { kind: 'spreads-original' };
  }
  const missing = productionCalledExports.filter((name) => !providesExport(body, name));
  if (missing.length === 0) return { kind: 'provides-all' };
  return { kind: 'violation', missingExports: missing };
}

// ---------------------------------------------------------------------------
// Scanning (pure over source text — unit-testable)
// ---------------------------------------------------------------------------

export interface MockContractViolation {
  /** Repo-relative posix path of the test file. */
  readonly file: string;
  readonly modulePath: string;
  readonly missingExport: string;
  readonly line: number;
}

export interface SourceScanResult {
  readonly violations: readonly MockContractViolation[];
  /** Count of factories for curated modules found in this source (any classification). */
  readonly curatedFactories: number;
}

function matchRegistryEntry(
  specifier: string,
  registry: readonly MockContractModuleEntry[],
): MockContractModuleEntry | undefined {
  return registry.find(
    (entry) =>
      specifier === entry.modulePath ||
      entry.specifierSuffixes.some(
        (suffix) => specifier.startsWith('.') && specifier.endsWith(suffix),
      ),
  );
}

export function scanSourceForViolations(
  file: string,
  source: string,
  registry: readonly MockContractModuleEntry[] = MOCK_CONTRACT_REGISTRY,
): SourceScanResult {
  const violations: MockContractViolation[] = [];
  let curatedFactories = 0;
  for (const site of extractMockFactories(source)) {
    const entry = matchRegistryEntry(site.specifier, registry);
    if (!entry) continue;
    curatedFactories += 1;
    const classification = classifyFactory(site, entry.productionCalledExports);
    if (classification.kind !== 'violation') continue;
    for (const missingExport of classification.missingExports) {
      violations.push({ file, modulePath: entry.modulePath, missingExport, line: site.line });
    }
  }
  return { violations, curatedFactories };
}

// ---------------------------------------------------------------------------
// Baseline ratchet (exact `file :: module :: missingExport` triples)
// ---------------------------------------------------------------------------

export function violationKey(v: Pick<MockContractViolation, 'file' | 'modulePath' | 'missingExport'>): string {
  return `${v.file} :: ${v.modulePath} :: ${v.missingExport}`;
}

export interface BaselineEvaluation {
  readonly newViolations: readonly MockContractViolation[];
  /** Baseline entries that are no longer violations — remove them (ratchet down). */
  readonly staleEntries: readonly string[];
}

export function evaluateAgainstBaseline(
  violations: readonly MockContractViolation[],
  baselineEntries: readonly string[],
): BaselineEvaluation {
  const baseline = new Set(baselineEntries);
  const current = new Set(violations.map(violationKey));
  return {
    newViolations: violations.filter((v) => !baseline.has(violationKey(v))),
    staleEntries: baselineEntries.filter((entry) => !current.has(entry)),
  };
}

interface BaselineFile {
  readonly comment?: string;
  readonly entries: readonly string[];
}

export function readBaseline(baselinePath = BASELINE_PATH): readonly string[] {
  if (!fs.existsSync(baselinePath)) return [];
  const parsed = JSON.parse(fs.readFileSync(baselinePath, 'utf8')) as BaselineFile;
  return parsed.entries ?? [];
}

// ---------------------------------------------------------------------------
// Repo scan (IO)
// ---------------------------------------------------------------------------

const SOURCE_EXT_RE = /\.[cm]?[jt]sx?$/;

/**
 * Candidate files: tracked files containing `vi.mock(` (git grep, submodules
 * included) plus untracked-but-not-ignored source files that mention it.
 */
export function collectCandidateFiles(repoRoot = REPO_ROOT): string[] {
  const files = new Set<string>();
  try {
    const out = gitCapture(
      ['grep', '-l', '--recurse-submodules', '-e', 'vi.mock(', '--', '*.ts', '*.tsx', '*.mts', '*.cts', '*.js', '*.jsx', '*.mjs', '*.cjs'],
      { cwd: repoRoot },
    );
    for (const line of out.split('\n')) {
      if (line.trim().length > 0) files.add(line.trim());
    }
  } catch {
    // git grep exits 1 on zero matches — an empty candidate set is valid.
  }
  const untracked = gitCapture(['ls-files', '--others', '--exclude-standard', '-z'], {
    cwd: repoRoot,
  });
  for (const file of untracked.split('\0')) {
    if (!SOURCE_EXT_RE.test(file)) continue;
    const abs = path.join(repoRoot, file);
    if (!fs.existsSync(abs)) continue;
    if (fs.readFileSync(abs, 'utf8').includes('vi.mock(')) files.add(file);
  }
  return [...files].sort((a, b) => a.localeCompare(b));
}

export interface RepoScanOutcome {
  readonly violations: readonly MockContractViolation[];
  readonly curatedFactories: number;
  readonly scannedFiles: number;
}

export function scanRepo(
  repoRoot = REPO_ROOT,
  registry: readonly MockContractModuleEntry[] = MOCK_CONTRACT_REGISTRY,
): RepoScanOutcome {
  const candidates = collectCandidateFiles(repoRoot);
  const violations: MockContractViolation[] = [];
  let curatedFactories = 0;
  for (const file of candidates) {
    const abs = path.join(repoRoot, file);
    if (!fs.existsSync(abs)) continue;
    const result = scanSourceForViolations(file, fs.readFileSync(abs, 'utf8'), registry);
    violations.push(...result.violations);
    curatedFactories += result.curatedFactories;
  }
  return { violations, curatedFactories, scannedFiles: candidates.length };
}

// ---------------------------------------------------------------------------
// Guard module
// ---------------------------------------------------------------------------

export async function runMockContractsCheck(repoRoot = REPO_ROOT): Promise<GuardRunResult> {
  const outcome = scanRepo(repoRoot);
  const { newViolations, staleEntries } = evaluateAgainstBaseline(
    outcome.violations,
    readBaseline(),
  );

  const failures: string[] = [];
  for (const v of newViolations) {
    failures.push(
      `MOCK CONTRACT: ${v.file}:${v.line} mocks '${v.modulePath}' without providing production-called export '${v.missingExport}'.\n` +
        `    Add \`${v.missingExport}: vi.fn()\` to the factory, spread importOriginal, or annotate the line above the vi.mock call with \`// mock-contract: partial — <reason>\`.`,
    );
  }
  for (const stale of staleEntries) {
    failures.push(
      `stale mock-contract baseline entry: \`${stale}\` is no longer a violation — remove it from scripts/checks/mockContractsBaseline.json ` +
        `(or run \`npx tsx scripts/checks/checkMockContracts.ts --update-baseline\` and review the shrink).`,
    );
  }

  const baselined = outcome.violations.length - newViolations.length;
  return {
    ok: failures.length === 0,
    failures,
    summary:
      `scanned ${outcome.scannedFiles} vi.mock-using files; ${outcome.curatedFactories} factories for ${MOCK_CONTRACT_REGISTRY.length} curated modules; ` +
      `${newViolations.length} new violation(s), ${baselined} baselined, ${staleEntries.length} stale baseline entr(y/ies).`,
  };
}

export const mockContractsGuard: TestingGuardModule = {
  name: 'mock-contracts',
  run: () => runMockContractsCheck(),
};

// ---------------------------------------------------------------------------
// CLI (report / --update-baseline for ratchet-down maintenance)
// ---------------------------------------------------------------------------

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const outcome = scanRepo();
  if (process.argv.includes('--update-baseline')) {
    const entries = [...new Set(outcome.violations.map(violationKey))].sort((a, b) =>
      a.localeCompare(b),
    );
    const payload: BaselineFile = {
      comment:
        'Grandfathered mock-contract violations (ratchet — may only shrink; see scripts/checks/checkMockContracts.ts). ' +
        'Each entry is `file :: module :: missingExport`; new violations are NOT baselined, fix or annotate them.',
      entries,
    };
    fs.writeFileSync(BASELINE_PATH, `${JSON.stringify(payload, null, 2)}\n`);
    process.stdout.write(`wrote ${entries.length} baseline entries to ${path.relative(REPO_ROOT, BASELINE_PATH)}\n`);
  } else {
    runMockContractsCheck().then(
      (result) => {
        process.stdout.write(`${result.summary}\n`);
        for (const failure of result.failures) process.stderr.write(`✘ ${failure}\n`);
        process.exit(result.ok ? 0 : 1);
      },
      (error) => {
        process.stderr.write(`checkMockContracts crashed: ${String(error)}\n`);
        process.exit(1);
      },
    );
  }
}
