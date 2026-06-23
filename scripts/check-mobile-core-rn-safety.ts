#!/usr/bin/env npx tsx
/**
 * CI Validation: Mobile-reachable Node-only "poison" reachability boundary.
 *
 * Kills the `renderer_node_core_import_leak` class on the MOBILE surface by
 * construction. The invariant is NOT "mobile must not import @core" — mobile is
 * core-first by design and legitimately value-imports RN-safe `@core` modules.
 * The true invariant is narrower:
 *
 *   No module reachable from the mobile bundle may pull in Node-only APIs
 *   (`node:*`, `import.meta`, `createRequire`, `pino`).
 *
 * This is a TRANSITIVE-REACHABILITY invariant, which is why ESLint is the wrong
 * tool (it sees one import statement, not a graph) and why the dangerous edge of
 * the 2026-06-17→22 outage (`diagnosticBundleService.ts → @core/logger`) lived
 * *inside core*, two hops from any `mobile/**` file — invisible to any
 * `mobile/**`-scoped lint. See docs/plans/260622_mobile-core-boundary-lint/PLAN.md
 * (Option A rejected; Option C — this script — recommended; the shipped
 * `production-bundle-smoke` job remains the authoritative backstop).
 *
 * What it does:
 *   1. Reads alias rules from `mobile/tsconfig.json` paths at runtime (no
 *      hardcoding; tracks alias drift, which `check-alias-integrity.ts` pins).
 *   2. BFS-walks the import graph from the mobile entry roots
 *      (`mobile/app/**`, `mobile/src/**`) across only the in-repo alias frontier
 *      (`@core` / `@shared` / `@rebel/cloud-client` / `@rebel/shared` / `@/*`),
 *      following VALUE edges (static / side-effect / namespace / dynamic
 *      `import()` / `require()` / `import =` / value re-export incl. `export *`).
 *      It does NOT descend into node_modules — that is the bundler's concern and
 *      not where OUR core's RN-safety lives; this keeps the walk bounded to the
 *      hundreds-of-files alias frontier (not the full ~2700-file Metro graph).
 *   3. Flags any reached in-frontier module whose source uses a Node-only poison
 *      API. The poison set is DERIVED from source patterns (value-import of
 *      `node:*`/`pino`, `import.meta`, `createRequire`), so it tracks new
 *      Node-only core modules automatically — no hardcoded denylist to rot.
 *
 * CRITICAL — AST, not regex (mirrors scripts/check-mobile-barrel-imports.ts):
 *   - Type-only imports (`import type { Logger } from '@core/logger'`,
 *     `import { type X } from ...`) erase at compile and pull NO runtime dep, so
 *     they are exempt — both for edge-following and for poison detection. A
 *     regex would false-positive on these AND on `node:`/`@core/logger` strings
 *     appearing in comments (the fix-documenting comments in
 *     diagnosticBundleService.ts are exactly such a trap).
 *
 * Allowlist semantics: exact `(entry, poison)` pairs — EMPTY at ship (the spike
 * found zero violations on the clean tree, so nothing is grandfathered). A legit
 * future RN-safe exception (e.g. a genuinely-polyfilled builtin mobile relies on)
 * must be an explicit, commented entry; `--expected-count` ratchets the
 * allowlist length so an entry can't be slipped in silently. Default-deny: keep
 * the poison set broad, allowlist the audited exception, never narrow the set.
 *
 * Run: npx tsx scripts/check-mobile-core-rn-safety.ts
 * Wired into: npm run validate:fast (validate:mobile-core-rn-safety)
 *
 * @see scripts/check-mobile-barrel-imports.ts (sibling AST-walk + allowlist/ratchet shape)
 * @see scripts/check-cross-surface-imports.ts (sibling allowlist/ratchet shape)
 * @see docs/plans/260622_mobile-core-boundary-lint/PLAN.md (design + Option A rejection)
 * @see docs/project/RELEASE_TO_MOBILE.md §5 (the 2026-06-17→22 outage gotchas)
 */
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { builtinModules } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const MOBILE_ROOT = path.join(REPO_ROOT, 'mobile');

const SOURCE_EXTS = ['.ts', '.tsx', '.js', '.jsx'];
const INDEX_BASENAMES = SOURCE_EXTS.map((e) => `index${e}`);
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'out', 'coverage', '__tests__', '__mocks__']);

// ---------------------------------------------------------------------------
// Allowlist + ratchet (mirror scripts/check-mobile-barrel-imports.ts)
// ---------------------------------------------------------------------------

export interface MobileCoreRnSafetyAllowlistEntry {
  /**
   * Repo-relative path of the MOBILE ENTRY ROOT (the first link of the chain)
   * this exemption applies to. Default-deny + precise: an exemption suppresses
   * the poison only on chains that START at this entry, never on every chain
   * reaching the same poison module (cross-family review F3). e.g.
   * "mobile/app/(e2e)/pair.tsx".
   */
  readonly entry: string;
  /** Repo-relative path of the poison module being exempted. */
  readonly poison: string;
  /** The poison reason (substring match) this exemption covers, e.g. "node:os". */
  readonly reason: string;
  /** Why this is provably RN-safe despite matching a poison pattern. */
  readonly justification: string;
}

/**
 * EMPTY at ship — the C1 spike found zero Node-only poison modules reachable
 * from the mobile bundle on the clean tree. Each future entry must encode a
 * justified, audited RN-safe exception (e.g. a `node:*` builtin Metro genuinely
 * polyfills that mobile relies on) and bump `--expected-count` in lockstep.
 * Default-deny: do NOT narrow the poison set to silence a false positive —
 * add a commented allowlist entry instead, so the exemption stays visible.
 */
export const ALLOWLIST: ReadonlyArray<MobileCoreRnSafetyAllowlistEntry> = [];

// ---------------------------------------------------------------------------
// Poison patterns
// ---------------------------------------------------------------------------

const POISON_BUILTIN_PREFIXES = ['node:'];

/**
 * Bare Node builtin module names (`fs`, `path`, `os`, `crypto`, `module`,
 * `events`, `stream`, …), derived from Node's own `builtinModules` so the set
 * never rots as Node adds builtins. `node:`-prefixed forms are handled by
 * POISON_BUILTIN_PREFIXES; here we also fold in the prefixed forms (Node lists
 * some builtins, e.g. `node:test`, ONLY in prefixed form) for completeness.
 *
 * Why bare builtins are poison too: there is NO repo-wide "always use the
 * `node:` protocol" invariant — production `src/core` still imports bare `os`
 * (nativeArch.ts), `fs`/`path` (versionMarker.ts), `crypto`
 * (flyProvisioningService.ts), etc. A future mobile-reachable core module using
 * a bare builtin would otherwise slip past this gate (cross-family review F1).
 * Metro does NOT polyfill these (mobile/metro.config.js extraNodeModules maps
 * only @core/@shared/react/zustand, never a builtin) — so a flag here is a real
 * RN-safety problem, not a false positive.
 */
const POISON_BARE_MODULES = new Set<string>([
  'pino',
  ...builtinModules,
  ...builtinModules.map((m) => `node:${m}`),
]);

// ---------------------------------------------------------------------------
// Alias resolution (read mobile/tsconfig.json paths; mirror metro extraNodeModules)
// ---------------------------------------------------------------------------

export interface AliasRule {
  /** e.g. '@core/' (prefix form) or '@rebel/cloud-client' (exact form). */
  readonly prefix: string;
  readonly exact: boolean;
  /** Absolute target base, e.g. <repo>/src/core. */
  readonly targetBase: string;
}

/**
 * Build alias rules from a tsconfig `paths` map, resolved against the mobile
 * baseUrl. Exported (with an injectable `paths` arg) so tests can drive the
 * resolver with fixture aliases instead of the real tsconfig.
 */
export function buildAliasRules(
  paths: Record<string, string[]>,
  baseDir: string = MOBILE_ROOT,
): AliasRule[] {
  const rules: AliasRule[] = [];
  for (const [pattern, targets] of Object.entries(paths)) {
    const target = targets[0];
    if (!target) continue;
    if (pattern.endsWith('/*')) {
      const targetBase = path.resolve(baseDir, target.slice(0, -2)); // strip '/*'
      rules.push({ prefix: pattern.slice(0, -1), exact: false, targetBase }); // keep trailing '/'
    } else {
      rules.push({ prefix: pattern, exact: true, targetBase: path.resolve(baseDir, target) });
    }
  }
  // Longest-prefix first so '@rebel/cloud-client/*' beats '@rebel/shared/*' etc.
  rules.sort((a, b) => b.prefix.length - a.prefix.length);
  return rules;
}

function readMobileAliasRules(): AliasRule[] {
  const tsconfig = JSON.parse(
    readFileSync(path.join(MOBILE_ROOT, 'tsconfig.json'), 'utf-8'),
  ) as { compilerOptions?: { paths?: Record<string, string[]> } };
  return buildAliasRules(tsconfig.compilerOptions?.paths ?? {});
}

/** A filesystem abstraction so the walk is testable against in-memory fixtures. */
export interface FileSystemLike {
  existsSync(p: string): boolean;
  isFile(p: string): boolean;
  isDirectory(p: string): boolean;
  readFileSync(p: string): string;
}

const realFs: FileSystemLike = {
  existsSync: (p) => existsSync(p),
  isFile: (p) => {
    const st = statSync(p, { throwIfNoEntry: false });
    return !!st && st.isFile();
  },
  isDirectory: (p) => {
    const st = statSync(p, { throwIfNoEntry: false });
    return !!st && st.isDirectory();
  },
  readFileSync: (p) => readFileSync(p, 'utf-8'),
};

/**
 * Resolve a module specifier to an absolute file path if it lands in the
 * in-repo alias frontier (or is a relative edge inside an already-resolved
 * file); else null (node_modules / builtin / unknown — out of frontier).
 */
export function resolveSpecifier(
  specifier: string,
  fromFile: string,
  rules: readonly AliasRule[],
  fs: FileSystemLike = realFs,
): string | null {
  let candidateBase: string | null = null;

  if (specifier.startsWith('.')) {
    candidateBase = path.resolve(path.dirname(fromFile), specifier);
  } else {
    for (const rule of rules) {
      if (rule.exact) {
        if (specifier === rule.prefix) {
          candidateBase = rule.targetBase;
          break;
        }
      } else if (specifier.startsWith(rule.prefix)) {
        candidateBase = path.join(rule.targetBase, specifier.slice(rule.prefix.length));
        break;
      } else if (specifier === rule.prefix.slice(0, -1)) {
        // bare alias root e.g. '@core' matching prefix '@core/'
        candidateBase = rule.targetBase;
        break;
      }
    }
  }

  if (candidateBase === null) return null;
  return resolveFileFromBase(candidateBase, fs);
}

function resolveFileFromBase(base: string, fs: FileSystemLike): string | null {
  if (fs.existsSync(base) && fs.isFile(base)) return base;
  for (const ext of SOURCE_EXTS) {
    const withExt = base + ext;
    if (fs.existsSync(withExt) && fs.isFile(withExt)) return withExt;
  }
  if (fs.existsSync(base) && fs.isDirectory(base)) {
    for (const idx of INDEX_BASENAMES) {
      const candidate = path.join(base, idx);
      if (fs.existsSync(candidate) && fs.isFile(candidate)) return candidate;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Poison detection + edge extraction (AST, VALUE imports only)
// ---------------------------------------------------------------------------

export interface FileAnalysis {
  /** value-import/re-export specifiers (edges to attempt to follow). */
  readonly edges: ReadonlyArray<{ readonly specifier: string; readonly line: number }>;
  /** non-empty if this file itself uses a Node-only poison API. */
  readonly poisonReasons: ReadonlyArray<string>;
}

function scriptKindForPath(filePath: string): ts.ScriptKind {
  if (filePath.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (filePath.endsWith('.jsx')) return ts.ScriptKind.JSX;
  if (filePath.endsWith('.js')) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

/** Mirror of check-mobile-barrel-imports.ts isValueImportClause. */
function isValueImportClause(node: ts.ImportDeclaration): boolean {
  const clause = node.importClause;
  if (!clause) return true; // side-effect import: runtime pull
  if (clause.isTypeOnly) return false;
  if (clause.name) return true;
  const bindings = clause.namedBindings;
  if (!bindings) return true;
  if (ts.isNamespaceImport(bindings)) return true;
  if (ts.isNamedImports(bindings)) return bindings.elements.some((el) => !el.isTypeOnly);
  return true;
}

/** Mirror of check-mobile-barrel-imports.ts valueReExportKind (value vs erased). */
function isValueReExport(node: ts.ExportDeclaration): boolean {
  if (node.isTypeOnly) return false;
  const clause = node.exportClause;
  if (!clause) return true; // export * from
  if (ts.isNamespaceExport(clause)) return true;
  if (ts.isNamedExports(clause)) return clause.elements.some((el) => !el.isTypeOnly);
  return true;
}

/**
 * Pure AST analysis over a single source file's text. Exported for tests —
 * returns the value edges to follow and any Node-only poison reasons.
 */
export function analyzeSource(source: string, filePath: string): FileAnalysis {
  const sf = ts.createSourceFile(
    filePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    scriptKindForPath(filePath),
  );

  const edges: { specifier: string; line: number }[] = [];
  const poisonReasons: string[] = [];

  // F4: only treat a `createRequire(...)` call as poison when it is actually the
  // Node builtin — i.e. bound from `node:module` / `module`, or paired with
  // `import.meta` (the canonical ESM createRequire idiom) — never a same-named
  // local helper. We collect signals across the whole file, then decide.
  let sawCreateRequireCall = false;
  let createRequireFromNodeModule = false;
  let sawImportMeta = false;
  /** Names bound to the `module`/`node:module` builtin's createRequire export. */
  const moduleSpecifiers = new Set(['module', 'node:module']);

  const lineOf = (node: ts.Node): number =>
    sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;

  function recordPoisonSpecifier(spec: string): void {
    if (POISON_BUILTIN_PREFIXES.some((p) => spec.startsWith(p))) {
      poisonReasons.push(`imports Node builtin '${spec}'`);
    } else if (POISON_BARE_MODULES.has(spec)) {
      // pino vs a bare Node builtin (fs/path/os/…): keep the builtin phrasing
      // consistent with the node:-prefixed branch so the allowlist `reason`
      // substring matches either form.
      poisonReasons.push(
        spec === 'pino' ? `imports 'pino'` : `imports Node builtin '${spec}'`,
      );
    }
  }

  function visit(node: ts.Node): void {
    // import.meta (Hermes parse-fatal) via AST MetaProperty.
    if (ts.isMetaProperty(node) && node.keywordToken === ts.SyntaxKind.ImportKeyword) {
      poisonReasons.push('uses import.meta');
      sawImportMeta = true;
    }

    if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
      if (isValueImportClause(node)) {
        const spec = node.moduleSpecifier.text;
        recordPoisonSpecifier(spec); // value import of node:* / pino = poison
        if (moduleSpecifiers.has(spec)) createRequireFromNodeModule = true;
        edges.push({ specifier: spec, line: lineOf(node) });
      }
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      if (isValueReExport(node)) {
        const spec = node.moduleSpecifier.text;
        recordPoisonSpecifier(spec);
        edges.push({ specifier: spec, line: lineOf(node) });
      }
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      ts.isStringLiteralLike(node.moduleReference.expression)
    ) {
      const spec = node.moduleReference.expression.text;
      recordPoisonSpecifier(spec);
      if (moduleSpecifiers.has(spec)) createRequireFromNodeModule = true;
      edges.push({ specifier: spec, line: lineOf(node) });
    } else if (ts.isCallExpression(node)) {
      const arg = node.arguments[0];
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword && arg && ts.isStringLiteralLike(arg)) {
        recordPoisonSpecifier(arg.text);
        if (moduleSpecifiers.has(arg.text)) createRequireFromNodeModule = true;
        edges.push({ specifier: arg.text, line: lineOf(node) });
      } else if (
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'require' &&
        arg &&
        ts.isStringLiteralLike(arg)
      ) {
        recordPoisonSpecifier(arg.text);
        if (moduleSpecifiers.has(arg.text)) createRequireFromNodeModule = true;
        edges.push({ specifier: arg.text, line: lineOf(node) });
      } else if (ts.isIdentifier(node.expression) && node.expression.text === 'createRequire') {
        // F4: defer — only poison if this createRequire is the Node builtin
        // (bound from node:module/module, or paired with import.meta), not a
        // same-named local helper. Decided after the full-file walk below.
        sawCreateRequireCall = true;
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sf);

  // F4 decision: a createRequire call is poison only when it's the Node builtin.
  if (sawCreateRequireCall && (createRequireFromNodeModule || sawImportMeta)) {
    poisonReasons.push('uses createRequire');
  }

  return { edges, poisonReasons: [...new Set(poisonReasons)] };
}

// ---------------------------------------------------------------------------
// Reachability walk (BFS over the bounded alias frontier)
// ---------------------------------------------------------------------------

export interface Violation {
  /** Repo-relative path of the reached poison module. */
  readonly poison: string;
  readonly reasons: ReadonlyArray<string>;
  /** Repo-relative chain entry → … → poison. */
  readonly chain: ReadonlyArray<string>;
}

export interface WalkResult {
  readonly entryCount: number;
  readonly visitedCount: number;
  readonly frontierCount: number;
  readonly violations: ReadonlyArray<Violation>;
}

/**
 * BFS the import graph from the entry files across the in-repo alias frontier,
 * flagging any reached non-entry (in-frontier) file that uses a Node-only
 * poison API. `repoRoot`/`mobileRoot` parameterize the entry vs frontier split
 * and the rel() display; `fs` is injectable for fixtures.
 */
export function walkReachability(
  entryFiles: readonly string[],
  rules: readonly AliasRule[],
  opts: {
    readonly repoRoot: string;
    /**
     * Mobile entry-root base. Used to derive the default entry/frontier split
     * (`<mobileRoot>/app` + `<mobileRoot>/src`). Optional when a surface passes
     * its own `isEntry` (e.g. the renderer reuse — `check-renderer-core-rn-safety.ts`).
     */
    readonly mobileRoot?: string;
    /**
     * Optional entry/frontier predicate override. A surface whose entry roots do
     * not match the mobile `app`/`src` layout (e.g. the renderer, whose entry
     * graph is `src/renderer/**`) supplies its own. Only affects the frontier
     * COUNT + chain-root display — poison is flagged for every reached module
     * regardless (F2). Defaults to the mobile `app`/`src` split.
     */
    readonly isEntry?: (absPath: string) => boolean;
    readonly fs?: FileSystemLike;
  },
): WalkResult {
  const fs = opts.fs ?? realFs;
  const rel = (p: string): string => path.relative(opts.repoRoot, p).replaceAll('\\', '/');
  const isEntry =
    opts.isEntry ??
    ((p: string): boolean =>
      opts.mobileRoot !== undefined &&
      (p.startsWith(path.join(opts.mobileRoot, 'app')) ||
        p.startsWith(path.join(opts.mobileRoot, 'src'))));

  const analysisCache = new Map<string, FileAnalysis>();
  const analyze = (file: string): FileAnalysis => {
    const cached = analysisCache.get(file);
    if (cached) return cached;
    const a = analyzeSource(fs.readFileSync(file), file);
    analysisCache.set(file, a);
    return a;
  };

  const visited = new Map<string, string[]>();
  const queue: { file: string; chain: string[] }[] = [];
  for (const entry of entryFiles) {
    if (!visited.has(entry)) {
      const chain = [rel(entry)];
      visited.set(entry, chain);
      queue.push({ file: entry, chain });
    }
  }

  const violations: Violation[] = [];
  const frontier = new Set<string>();

  while (queue.length > 0) {
    const { file, chain } = queue.shift()!;
    const analysis = analyze(file);

    if (!isEntry(file)) {
      frontier.add(file);
    }
    // F2: record poison regardless of entry vs frontier. The printed invariant
    // is "no module REACHABLE FROM the mobile bundle pulls in Node-only APIs" —
    // an entry root (mobile/app|src/**) directly importing node:fs / import.meta
    // is the bundle, so it must be flagged too, not silently skipped. Test/spec
    // files are already excluded by collectMobileEntryFiles(), so this does not
    // false-positive on tests.
    if (analysis.poisonReasons.length > 0) {
      violations.push({ poison: rel(file), reasons: analysis.poisonReasons, chain });
    }

    for (const edge of analysis.edges) {
      const resolved = resolveSpecifier(edge.specifier, file, rules, fs);
      if (!resolved) continue; // out of frontier (node_modules, builtin, unknown)
      if (!visited.has(resolved)) {
        const childChain = [...chain, rel(resolved)];
        visited.set(resolved, childChain);
        queue.push({ file: resolved, chain: childChain });
      }
    }
  }

  return {
    entryCount: entryFiles.length,
    visitedCount: visited.size,
    frontierCount: frontier.size,
    violations,
  };
}

/**
 * Apply the allowlist: a violation is suppressed iff EVERY reason is covered by
 * an allowlist entry matching BOTH the chain's entry root (`chain[0]`) AND the
 * poison module. The (entry, poison) pairing (F3) keeps exemptions precise —
 * an audited RN-safe exception on one entry never silences the same poison
 * reached via a different entry.
 */
export function filterAllowlisted(
  violations: readonly Violation[],
  allowlist: ReadonlyArray<MobileCoreRnSafetyAllowlistEntry>,
): Violation[] {
  return violations.filter((v) => {
    const entryRoot = v.chain[0];
    const allowedReasons = allowlist
      .filter((entry) => entry.poison === v.poison && entry.entry === entryRoot)
      .map((entry) => entry.reason);
    if (allowedReasons.length === 0) return true;
    return !v.reasons.every((reason) => allowedReasons.some((a) => reason.includes(a)));
  });
}

// ---------------------------------------------------------------------------
// CLI runner
// ---------------------------------------------------------------------------

function collectMobileEntryFiles(): string[] {
  const roots = [path.join(MOBILE_ROOT, 'app'), path.join(MOBILE_ROOT, 'src')];
  const results: string[] = [];
  function walk(dir: string): void {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        walk(path.join(dir, entry.name));
      } else if (entry.isFile()) {
        const n = entry.name;
        if (n.endsWith('.test.ts') || n.endsWith('.test.tsx') || n.endsWith('.spec.ts') || n.endsWith('.spec.tsx')) {
          continue;
        }
        if (SOURCE_EXTS.includes(path.extname(n))) results.push(path.join(dir, n));
      }
    }
  }
  roots.forEach(walk);
  return results;
}

function parseExpectedCount(args: readonly string[]): number | null {
  const inline = args.find((arg) => arg.startsWith('--expected-count='));
  const splitIndex = args.indexOf('--expected-count');
  const raw = inline
    ? inline.slice('--expected-count='.length)
    : splitIndex >= 0
      ? args[splitIndex + 1]
      : undefined;
  if (raw === undefined) return null;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`Invalid --expected-count value: ${raw}`);
  }
  return parsed;
}

/** Detect direct invocation so this module can be imported by tests safely. */
export function isDirectInvocation(): boolean {
  if (process.env.VITEST) return false;
  try {
    return process.argv[1] === fileURLToPath(import.meta.url);
  } catch {
    return process.argv[1] !== undefined && process.argv[1].endsWith('check-mobile-core-rn-safety.ts');
  }
}

const FAILURE_GUIDANCE =
  'A module reachable from the MOBILE bundle pulls in a Node-only API (node:*,\n' +
  'import.meta, createRequire, or pino) that React Native / Hermes cannot run —\n' +
  'this breaks the mobile build (cf. the 2026-06-17→22 outage: @core/logger reached\n' +
  'the bundle via diagnosticBundleService.ts).\n\n' +
  'NOTE: such a node:* import is perfectly LEGAL for the desktop/cloud core — the\n' +
  'problem is only that this core module is ALSO mobile-reachable. The fix is NOT to\n' +
  'remove the Node mechanics from core; it is to move them behind a boundary the\n' +
  'mobile graph never crosses — inject a logger/seam instead of importing Node-only\n' +
  'code into a mobile-reachable module. Precedent: DiagnosticBundleLogger (the\n' +
  'injected, default-no-op seam) in\n' +
  '  src/core/services/diagnostics/diagnosticBundleService.ts\n' +
  'and the console-only @core/errorReporter.\n\n' +
  'See docs/project/RELEASE_TO_MOBILE.md §5 and\n' +
  '    docs/plans/260622_mobile-core-boundary-lint/PLAN.md.\n\n' +
  'The shipped production-bundle-smoke CI job is the authoritative backstop; this\n' +
  'check is the faster, edit-time complement. A genuinely RN-safe exception can be\n' +
  'grandfathered via the commented ALLOWLIST in scripts/check-mobile-core-rn-safety.ts\n' +
  '(bump --expected-count in lockstep) — never narrow the poison set to force green.';

function main(): void {
  let expectedCount: number | null = null;
  try {
    expectedCount = parseExpectedCount(process.argv.slice(2));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
    return;
  }

  if (expectedCount !== null && expectedCount !== ALLOWLIST.length) {
    console.error(
      `✗ Allowlist count mismatch: expected ${expectedCount}, actual ${ALLOWLIST.length}.\n` +
        'Update ALLOWLIST and --expected-count together.',
    );
    process.exitCode = 1;
    return;
  }

  const rules = readMobileAliasRules();
  const entryFiles = collectMobileEntryFiles();

  console.log('Checking mobile-reachable Node-only RN-safety boundary...\n');
  console.log(`Allowlist: ${ALLOWLIST.length} entries`);

  const result = walkReachability(entryFiles, rules, {
    repoRoot: REPO_ROOT,
    mobileRoot: MOBILE_ROOT,
  });
  const violations = filterAllowlisted(result.violations, ALLOWLIST);

  console.log(`Mobile entry files: ${result.entryCount}`);
  console.log(`Total files visited (entry + frontier): ${result.visitedCount}`);
  console.log(`In-repo alias frontier files reached: ${result.frontierCount}\n`);

  if (violations.length === 0) {
    console.log('✓ ZERO Node-only poison modules reachable from the mobile bundle.');
    return;
  }

  console.error(`✗ ${violations.length} Node-only poison module(s) reachable from mobile:\n`);
  for (const v of violations) {
    console.error(`  POISON: ${v.poison}`);
    console.error(`    reasons: ${v.reasons.join('; ')}`);
    console.error(`    chain:   ${v.chain.join('\n             → ')}`);
    console.error('');
  }
  console.error(FAILURE_GUIDANCE);
  process.exitCode = 1;
}

if (isDirectInvocation()) {
  try {
    main();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Failed to check mobile core RN-safety: ${message}`);
    process.exitCode = 1;
  }
}
