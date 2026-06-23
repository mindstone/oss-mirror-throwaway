#!/usr/bin/env npx tsx
/**
 * CI Validation: Cloud Bootstrap Policy (Stage A3)
 *
 * AST-based gate that prevents regressions of the 2026-05-27 cloud OOM
 * incident (postmortem: docs-private/postmortems/260527_cloud_oom_warmup_4gb_postmortem.md).
 * The bugfix made the cloud's super-mcp warmup, embedding-pipeline init, and
 * tool-index init lazy. This gate keeps them lazy.
 *
 * What this gate catches in `cloud-service/src/bootstrap.ts`:
 *   1. Forbidden CALL patterns (regression class) — e.g. `<x>.warmup(...)`,
 *      `initializeToolIndex(...)`, `refreshToolIndex(...)`. These represent
 *      eager bootstrap work that must instead be scheduled via
 *      `cloudBootstrapWarmup.ensureWarm(...)` (deferred until first request
 *      or idle window).
 *   2. Forbidden STATIC imports — e.g. `@huggingface/transformers`. The ML
 *      runtime must only be imported lazily inside a method body
 *      (currently `CloudEmbeddingGenerator.initializePipeline()`).
 *   3. Forbidden DYNAMIC imports of the same forbidden specifiers.
 *      AST analysis is the whole point here — a regex would miss
 *      multi-line dynamic imports, identifier-aliased import bindings,
 *      and string-template specifiers.
 *   4. Cross-surface drift — `@main/*` imports in bootstrap.ts that are
 *      NOT already documented in the cross-surface allowlist
 *      (`scripts/check-cross-surface-imports.ts`). Reusing the existing
 *      allowlist avoids drifting two policy files.
 *   5. Unguarded pre-init singleton accessors (the `cloud_bootstrap_singleton_init_asymmetry`
 *      family — 260220 / 260311 / REBEL-63K). A BARE-IDENTIFIER call to a
 *      PlatformConfig-reading accessor (`getSystemSettingsPath`, `getDataPath`,
 *      `getAppRoot`, `getAppVersion`, `getPlatformConfig`) that is lexically
 *      inside the `bootstrap()` function body but NOT inside a REAL try/catch
 *      guard. A "real guard" is a `try` with a `catch` clause whose body does
 *      NOT unconditionally re-throw — a catch-less `try`/`finally` and a
 *      rethrowing `catch (e) { throw e }` both let the accessor's throw escape,
 *      so they are NOT guards (F2). In production server.ts wires PlatformConfig
 *      before bootstrap(); the cloud bootstrap test harnesses run bootstrap()
 *      UNWIRED by design (`vi.resetModules()` → fresh `@core/platform` with
 *      `_config === undefined`), so an eager, unguarded accessor throws
 *      `PlatformConfig not initialized` and breaks the harnesses — exactly the
 *      reverted REBEL-63K Stage 3. The fix is the try/catch posture of the
 *      analytics-init guard; this rule keeps it mandatory. Function-scoped (not
 *      file-scoped) so legitimate accessor calls in module-scope lazy closures
 *      and OTHER functions are not flagged.
 *
 *      KNOWN LIMITATIONS (deliberate — closing them needs dataflow / symbol
 *      resolution, over-engineering for this gate; see CLOUD_BOOTSTRAP_POLICY.md):
 *        - Only BARE-IDENTIFIER calls are detected. A namespace/property call
 *          (`dataPaths.getDataPath()`), an aliased binding
 *          (`const g = getPlatformConfig; g()`), or the accessor called from a
 *          nested named helper that bootstrap() invokes are NOT flagged.
 *        - A `catch` that re-throws only conditionally (inside an `if`/loop) is
 *          conservatively treated as a real guard.
 *      The realistic accidental-regression — a bare unguarded accessor call
 *      copy-pasted into bootstrap() — is exactly what this rule catches.
 *
 * Modes:
 *   - default (gate)   `npx tsx scripts/check-cloud-bootstrap-policy.ts`
 *   - list reachability `npx tsx scripts/check-cloud-bootstrap-policy.ts --list`
 *
 * Wired into `npm run validate:fast` via
 * `scripts/run-validate-fast.ts` (see `validate:cloud-bootstrap-policy`).
 *
 * Why AST not grep:
 *   - regex misses multi-line `await\n  import(\n    '@huggingface/transformers'\n  )`;
 *   - regex misses dynamic `import(specifierVariable)` (we report top-level
 *     dynamic imports against the forbidden specifier list only when the
 *     argument is a string-literal — AST also lets us distinguish that
 *     cleanly);
 *   - regex cannot tell whether `.warmup()` is on an embedding generator or
 *     an unrelated symbol; AST gives us property-access shape.
 *
 * @see docs/project/CLOUD_BOOTSTRAP_POLICY.md
 * @see docs-private/postmortems/260527_cloud_oom_warmup_4gb_postmortem.md
 * @see docs/plans/260527_cloud_capacity_optimisation_and_pressure_surfacing.md (Stage A3)
 * @see scripts/check-cross-surface-imports.ts (sibling AST pattern)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ts from 'typescript';

import {
  ALLOWLIST as CROSS_SURFACE_ALLOWLIST,
  type AllowlistEntry as CrossSurfaceAllowlistEntry,
} from './check-cross-surface-imports';

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

export interface ForbiddenCall {
  /** Property name for `<x>.callee()` / Identifier name for `callee()`. */
  readonly callee: string;
  /** Match an identifier callsite (`foo()`) or a property access (`x.foo()`). */
  readonly matcher: 'identifier' | 'method';
  readonly reason: string;
  readonly suggestion: string;
}

export interface ForbiddenImport {
  readonly specifier: string;
  readonly reason: string;
  readonly suggestion: string;
}

/**
 * A pre-init singleton accessor that reads `getPlatformConfig()` at call time
 * and therefore throws when PlatformConfig is unwired. Calling one EAGERLY (not
 * inside a try) within `bootstrap()` re-introduces the
 * `cloud_bootstrap_singleton_init_asymmetry` footgun.
 */
export interface ForbiddenPreInitAccessor {
  /** Bare identifier name of the accessor (e.g. `getSystemSettingsPath`). */
  readonly callee: string;
  readonly reason: string;
  readonly suggestion: string;
}

export interface CloudBootstrapPolicy {
  /**
   * The boot-path file the gate scans. Every forbidden-call entry below is
   * applied ONLY to this file (peer modules like `cloudBootstrapWarmup.ts`
   * legitimately call `initializeToolIndex` etc. — we want to police the boot
   * path, not the deferred-warmup module that owns the work).
   */
  readonly bootstrapEntryPath: string;
  readonly forbiddenBootstrapCalls: readonly ForbiddenCall[];
  readonly forbiddenStaticImports: readonly ForbiddenImport[];
  readonly forbiddenDynamicImports: readonly ForbiddenImport[];
  /** Existing cross-surface allowlist (file, specifier) pairs we honour. */
  readonly crossSurfaceAllowlist: readonly CrossSurfaceAllowlistEntry[];
  /**
   * Accessors that must not be called unguarded inside the `bootstrap()`
   * function body. The name of the function whose body is policed is
   * `bootstrapFunctionName`.
   */
  readonly forbiddenPreInitAccessors: readonly ForbiddenPreInitAccessor[];
  /** The bootstrap entry-point function whose body is scoped for rule 5. */
  readonly bootstrapFunctionName: string;
}

const BOOTSTRAP_ENTRY = 'cloud-service/src/bootstrap.ts';

const FORBIDDEN_BOOTSTRAP_CALLS: readonly ForbiddenCall[] = [
  {
    callee: 'warmup',
    matcher: 'method',
    reason:
      'Eager <embedding-generator>.warmup() at bootstrap defeats the lazy-on-first-use contract '
      + 'and re-introduces the 1.25 GB anon-rss / fp32 model load that triggered the 2026-05-27 OOM cycle.',
    suggestion:
      'Schedule warmup via `cloudBootstrapWarmup.ensureWarm(\'first-request\')` or rely on '
      + 'CloudEmbeddingGenerator\'s lazy `initializePipeline()` (called automatically by '
      + '`generateEmbeddings()` on first use).',
  },
  {
    callee: 'initializeToolIndex',
    matcher: 'identifier',
    reason:
      'initializeToolIndex() at boot regresses the 2026-05-27 fix that deferred tool-index '
      + 'init to after super-mcp child spawn finishes. The deferred-warmup module owns this work.',
    suggestion:
      'Let `cloudBootstrapWarmup` call `initializeToolIndex()` from its lazy `runWarmupSequence()`. '
      + 'If you genuinely need eager init, use the `REBEL_CLOUD_WARMUP_EAGER=1` env override; do not '
      + 'inline the call into bootstrap.ts.',
  },
  {
    callee: 'refreshToolIndex',
    matcher: 'identifier',
    reason:
      'refreshToolIndex() at boot is the eager-warmup pattern that the 2026-05-27 bugfix '
      + 'serialised and Stage A1 deferred. Bootstrap must not call it directly.',
    suggestion:
      'Let `cloudBootstrapWarmup.runWarmupSequence()` call `refreshToolIndex()` (or '
      + '`refreshToolIndexFromCatalogData()`) on first request / idle.',
  },
  {
    callee: 'refreshToolIndexFromCatalogData',
    matcher: 'identifier',
    reason:
      'refreshToolIndexFromCatalogData() called in bootstrap.ts re-eagerifies the catalog-fed '
      + 'embedding refresh path that Stage A1 explicitly moved into cloudBootstrapWarmup.',
    suggestion:
      'Use `cloudBootstrapWarmup` for catalog warmup. The lazy module already feeds catalog data '
      + 'into `refreshToolIndexFromCatalogData()` once super-mcp `/api/tools` returns.',
  },
];

const FORBIDDEN_HEAVY_ML_SPECIFIER: ForbiddenImport = {
  specifier: '@huggingface/transformers',
  reason:
    'Importing @huggingface/transformers from cloud bootstrap loads ~80 MB of ONNX weights at '
    + 'boot time. The 2026-05-27 OOM postmortem requires this to be lazy-imported inside a method '
    + 'body that runs only on first embedding call.',
  suggestion:
    'Move the import inside an async method body. See '
    + '`cloud-service/src/services/cloudEmbeddingGenerator.ts::initializePipeline()` for the '
    + 'canonical lazy pattern (`const { env, pipeline } = await import(\'@huggingface/transformers\');`).',
};

const FORBIDDEN_STATIC_IMPORTS: readonly ForbiddenImport[] = [FORBIDDEN_HEAVY_ML_SPECIFIER];
const FORBIDDEN_DYNAMIC_IMPORTS: readonly ForbiddenImport[] = [FORBIDDEN_HEAVY_ML_SPECIFIER];

const BOOTSTRAP_FUNCTION_NAME = 'bootstrap';

const PREINIT_ACCESSOR_SUGGESTION =
  'Wrap the call in a try/catch that mirrors the analytics-init guard '
  + '(cloud-service/src/bootstrap.ts — `try { initAnalytics(); } catch (err) { bootstrapLog.error(...) }`). '
  + 'In production server.ts wires PlatformConfig via ./platformInit before bootstrap() runs; the cloud '
  + 'bootstrap test harnesses run bootstrap() UNWIRED (vi.resetModules() → fresh @core/platform), so an '
  + 'eager call throws "PlatformConfig not initialized". The guard makes that non-fatal (logged loud). If '
  + 'the value is genuinely needed unconditionally, resolve it lazily on first use instead of at boot.';

const FORBIDDEN_PREINIT_ACCESSORS: readonly ForbiddenPreInitAccessor[] = [
  {
    callee: 'getSystemSettingsPath',
    reason:
      'getSystemSettingsPath() → isPackaged()/getAppRoot() read getPlatformConfig() at call time and throw '
      + '"PlatformConfig not initialized" when unwired. Calling it unguarded in bootstrap() is the reverted '
      + 'REBEL-63K Stage 3 (34 broken cloud bootstrap tests) and the cloud_bootstrap_singleton_init_asymmetry '
      + 'family (260220 / 260311).',
    suggestion: PREINIT_ACCESSOR_SUGGESTION,
  },
  {
    callee: 'getPlatformConfig',
    reason:
      'getPlatformConfig() throws "PlatformConfig not initialized" when unwired. An unguarded call in '
      + 'bootstrap() breaks the cloud bootstrap harnesses (which run bootstrap() unwired by design).',
    suggestion: PREINIT_ACCESSOR_SUGGESTION,
  },
  {
    callee: 'getDataPath',
    reason:
      'getDataPath() falls back to getPlatformConfig().userDataPath when REBEL_USER_DATA is unset; an '
      + 'unguarded call in bootstrap() throws when both are absent (the unwired-harness footgun). The '
      + 'harnesses set REBEL_USER_DATA today, but the guard keeps the call honest if that ever changes.',
    suggestion: PREINIT_ACCESSOR_SUGGESTION,
  },
  {
    callee: 'getAppRoot',
    reason:
      'getAppRoot() reads getPlatformConfig().appPath (it does swallow the throw and fall back to cwd today, '
      + 'but that silent fallback is itself a singleton-asymmetry smell in boot work). Guard it so the '
      + 'PlatformConfig dependency is explicit rather than silently cwd-dependent.',
    suggestion: PREINIT_ACCESSOR_SUGGESTION,
  },
  {
    callee: 'getAppVersion',
    reason:
      'getAppVersion() falls back to getPlatformConfig().version when REBEL_VERSION is unset; an unguarded '
      + 'call in bootstrap() throws when both are absent (the unwired-harness footgun).',
    suggestion: PREINIT_ACCESSOR_SUGGESTION,
  },
];

export const DEFAULT_POLICY: CloudBootstrapPolicy = {
  bootstrapEntryPath: BOOTSTRAP_ENTRY,
  forbiddenBootstrapCalls: FORBIDDEN_BOOTSTRAP_CALLS,
  forbiddenStaticImports: FORBIDDEN_STATIC_IMPORTS,
  forbiddenDynamicImports: FORBIDDEN_DYNAMIC_IMPORTS,
  crossSurfaceAllowlist: CROSS_SURFACE_ALLOWLIST,
  forbiddenPreInitAccessors: FORBIDDEN_PREINIT_ACCESSORS,
  bootstrapFunctionName: BOOTSTRAP_FUNCTION_NAME,
};

// ---------------------------------------------------------------------------
// Pure detection (unit-testable)
// ---------------------------------------------------------------------------

export type ViolationKind =
  | 'forbidden-call'
  | 'forbidden-static-import'
  | 'forbidden-dynamic-import'
  | 'forbidden-main-import'
  | 'unguarded-preinit-accessor';

export interface PolicyViolation {
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly kind: ViolationKind;
  readonly detail: string;
  readonly reason: string;
  readonly suggestion: string;
}

function normalisePath(filePath: string): string {
  return filePath.split(path.sep).join('/');
}

function getLine(sourceFile: ts.SourceFile, node: ts.Node): { line: number; column: number } {
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return { line: line + 1, column: character + 1 };
}

/**
 * Walk parent pointers from `node` (requires `setParentNodes: true`) and return
 * true if `node` is lexically inside a function declaration / expression named
 * `functionName`. Used to scope rule 5 to the `bootstrap()` body specifically —
 * NOT module-scope closures or other functions in the same file.
 *
 * Stops at the first enclosing named function: a call nested inside a closure
 * that is itself defined inside `bootstrap()` still counts as "inside
 * bootstrap()" only if that inner closure isn't separately named — which is the
 * correct semantics (an inline arrow/closure in bootstrap() runs as part of
 * boot work; a separately-declared named helper is a different scope and its own
 * concern). Concretely: `getDataPath()` inside `bootstrap()`'s body → flagged;
 * inside a `function foo()` declared at module scope → not flagged.
 */
function isInsideNamedFunction(node: ts.Node, functionName: string): boolean {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (ts.isFunctionDeclaration(current) && current.name?.text === functionName) {
      return true;
    }
    // A variable-assigned function expression / arrow:
    //   const bootstrap = async () => { ... }
    if (
      (ts.isFunctionExpression(current) || ts.isArrowFunction(current))
      && ts.isVariableDeclaration(current.parent)
      && ts.isIdentifier(current.parent.name)
      && current.parent.name.text === functionName
    ) {
      return true;
    }
    // Stop ascending once we hit ANY other named function boundary — a call in
    // a separately-named helper invoked by bootstrap() is that helper's concern,
    // not bootstrap()'s lexical body.
    if (ts.isFunctionDeclaration(current) && current.name) return false;
    current = current.parent;
  }
  return false;
}

/**
 * Return true if `catchClause`'s body UNCONDITIONALLY re-throws — i.e. the very
 * first statement is a `throw` (`catch (e) { throw e; }` or `catch { throw new
 * Error(...); }`). Such a catch is fatal-equivalent: the accessor's throw still
 * propagates out of the try, so wrapping it changes nothing. We treat the
 * common, realistic shapes — a `throw` as any top-level statement of the catch
 * body (`catch (e) { throw e }` or `catch (e) { log(e); throw e }`) — as "not a
 * real guard". A catch that throws only inside a nested `if`/loop is
 * conservatively treated as a real guard (the re-throw is conditional); fully
 * proving reachability would need dataflow analysis, which is out of scope (see
 * Known limitations in docs/project/CLOUD_BOOTSTRAP_POLICY.md).
 */
function catchUnconditionallyRethrows(catchClause: ts.CatchClause): boolean {
  // A top-level `throw` ANYWHERE in the catch body lets the accessor's throw
  // escape (logging before re-throwing doesn't change that), so the surrounding
  // `try` is not a real guard.
  return catchClause.block.statements.some((s) => ts.isThrowStatement(s));
}

/**
 * Return true if `node` is lexically enclosed by a `try` block that is a REAL
 * guard. The analytics guard posture (`try { initAnalytics(); } catch (err) {
 * bootstrapLog.error(...) }`) is the canonical shape this rule requires for
 * pre-init singleton accessors.
 *
 * A `try` only counts as a guard when it has a `catch` clause whose body does
 * NOT unconditionally re-throw. A catch-less `try` (e.g. `try { … } finally {
 * … }`) and a rethrowing catch (`catch (e) { throw e; }`) are NOT guards — the
 * accessor's throw still escapes the try and remains fatal, so flagging the
 * accessor is correct (F2).
 */
function isInsideRealGuard(node: ts.Node): boolean {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (ts.isTryStatement(current) && current.tryBlock && rangeContains(current.tryBlock, node)) {
      // Catch-less try (try/finally) → not a guard; the throw still escapes.
      if (!current.catchClause) return false;
      // Rethrowing catch → not a guard; the throw still escapes.
      if (!catchUnconditionallyRethrows(current.catchClause)) {
        return true;
      }
      // This try is not a real guard, but an OUTER try might still wrap it —
      // keep ascending rather than returning false outright.
    }
    current = current.parent;
  }
  return false;
}

function rangeContains(container: ts.Node, node: ts.Node): boolean {
  return node.getStart() >= container.getStart() && node.getEnd() <= container.getEnd();
}

function isCrossSurfaceAllowlisted(
  filePath: string,
  specifier: string,
  allowlist: readonly CrossSurfaceAllowlistEntry[],
): boolean {
  const normalisedFile = normalisePath(filePath);
  return allowlist.some(
    (entry) => entry.file === normalisedFile && entry.specifier === specifier,
  );
}

/**
 * Pure detection: parse `source` with the TypeScript compiler API and
 * return any policy violations.
 *
 * The forbidden-call list is applied ONLY when `filePath` matches the
 * configured `bootstrapEntryPath`. Other files reachable from bootstrap
 * (e.g. cloudBootstrapWarmup.ts) legitimately call `initializeToolIndex`
 * — they own the deferred path. Use cross-surface checks for those.
 */
export function findCloudBootstrapPolicyViolations(
  source: string,
  filePath: string,
  policy: CloudBootstrapPolicy = DEFAULT_POLICY,
): PolicyViolation[] {
  const violations: PolicyViolation[] = [];
  const normalisedFile = normalisePath(filePath);
  const isBootstrapEntry = normalisedFile === policy.bootstrapEntryPath;

  const sourceFile = ts.createSourceFile(
    filePath,
    source,
    ts.ScriptTarget.ES2022,
    /* setParentNodes */ true,
    ts.ScriptKind.TS,
  );

  const visit = (node: ts.Node): void => {
    // -- Static `import ... from '...'` ------------------------------------
    if (
      ts.isImportDeclaration(node)
      && ts.isStringLiteral(node.moduleSpecifier)
      && !node.importClause?.isTypeOnly
    ) {
      const specifier = node.moduleSpecifier.text;
      const { line, column } = getLine(sourceFile, node);

      // Forbidden heavy-ML / similar specifiers.
      for (const pattern of policy.forbiddenStaticImports) {
        if (specifier === pattern.specifier) {
          violations.push({
            file: normalisedFile,
            line,
            column,
            kind: 'forbidden-static-import',
            detail: `import ... from '${specifier}'`,
            reason: pattern.reason,
            suggestion: pattern.suggestion,
          });
        }
      }

      // Cross-surface drift: @main/* import not in the existing allowlist.
      if (isBootstrapEntry && specifier.startsWith('@main/')) {
        if (!isCrossSurfaceAllowlisted(filePath, specifier, policy.crossSurfaceAllowlist)) {
          violations.push({
            file: normalisedFile,
            line,
            column,
            kind: 'forbidden-main-import',
            detail: `import ... from '${specifier}'`,
            reason:
              'Cloud bootstrap may not import from src/main/ unless the (file, specifier) pair '
              + 'is explicitly allowlisted in scripts/check-cross-surface-imports.ts as a deferred '
              + 'migration. New @main/* imports re-couple cloud to Electron-only services.',
            suggestion:
              'Use the @core/* boundary interface (StoreFactory, HandlerRegistry, ProcessSpawner, '
              + 'EmbeddingGenerator, etc.). If a temporary coupling is unavoidable, add the (file, '
              + 'specifier) pair to scripts/check-cross-surface-imports.ts ALLOWLIST with a reason.',
          });
        }
      }
    }

    // -- `export ... from '...'` (re-exports treated as static imports) ----
    if (
      ts.isExportDeclaration(node)
      && node.moduleSpecifier
      && ts.isStringLiteral(node.moduleSpecifier)
      && !node.isTypeOnly
    ) {
      const specifier = node.moduleSpecifier.text;
      const { line, column } = getLine(sourceFile, node);
      for (const pattern of policy.forbiddenStaticImports) {
        if (specifier === pattern.specifier) {
          violations.push({
            file: normalisedFile,
            line,
            column,
            kind: 'forbidden-static-import',
            detail: `export ... from '${specifier}'`,
            reason: pattern.reason,
            suggestion: pattern.suggestion,
          });
        }
      }
    }

    // -- Call expressions: dynamic import + forbidden call patterns --------
    if (ts.isCallExpression(node)) {
      const expr = node.expression;
      const { line, column } = getLine(sourceFile, node);

      // Dynamic import: `import('...')` or `` import(`...`) ``
      if (expr.kind === ts.SyntaxKind.ImportKeyword && node.arguments.length > 0) {
        const arg = node.arguments[0];
        if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) {
          const specifier = arg.text;
          for (const pattern of policy.forbiddenDynamicImports) {
            if (specifier === pattern.specifier) {
              violations.push({
                file: normalisedFile,
                line,
                column,
                kind: 'forbidden-dynamic-import',
                detail: `import('${specifier}')`,
                reason: pattern.reason,
                suggestion: pattern.suggestion,
              });
            }
          }
          if (isBootstrapEntry && specifier.startsWith('@main/')) {
            if (!isCrossSurfaceAllowlisted(filePath, specifier, policy.crossSurfaceAllowlist)) {
              violations.push({
                file: normalisedFile,
                line,
                column,
                kind: 'forbidden-main-import',
                detail: `await import('${specifier}')`,
                reason:
                  'Dynamic @main/* import in cloud bootstrap re-couples cloud to Electron-only '
                  + 'services. Per scripts/check-cross-surface-imports.ts, only allowlisted '
                  + '(file, specifier) pairs are permitted.',
                suggestion:
                  'Use the @core/* boundary interface or add the (file, specifier) pair to the '
                  + 'cross-surface allowlist with a reason.',
              });
            }
          }
        }
      }

      // Forbidden call patterns — bootstrap.ts only.
      if (isBootstrapEntry) {
        // Property access: x.callee()
        if (ts.isPropertyAccessExpression(expr)) {
          const calleeName = expr.name.text;
          for (const pattern of policy.forbiddenBootstrapCalls) {
            if (pattern.matcher === 'method' && calleeName === pattern.callee) {
              const receiver = expr.expression.getText(sourceFile);
              violations.push({
                file: normalisedFile,
                line,
                column,
                kind: 'forbidden-call',
                detail: `${receiver}.${calleeName}(...)`,
                reason: pattern.reason,
                suggestion: pattern.suggestion,
              });
            }
          }
        }
        // Bare identifier call: callee()
        if (ts.isIdentifier(expr)) {
          const calleeName = expr.text;
          for (const pattern of policy.forbiddenBootstrapCalls) {
            if (pattern.matcher === 'identifier' && calleeName === pattern.callee) {
              violations.push({
                file: normalisedFile,
                line,
                column,
                kind: 'forbidden-call',
                detail: `${calleeName}(...)`,
                reason: pattern.reason,
                suggestion: pattern.suggestion,
              });
            }
          }

          // Rule 5: unguarded pre-init singleton accessor inside bootstrap().
          // Scoped to the bootstrap() function body (not module-scope closures
          // or other functions) AND only flagged when NOT inside a try block.
          for (const accessor of policy.forbiddenPreInitAccessors) {
            if (
              calleeName === accessor.callee
              && isInsideNamedFunction(node, policy.bootstrapFunctionName)
              && !isInsideRealGuard(node)
            ) {
              violations.push({
                file: normalisedFile,
                line,
                column,
                kind: 'unguarded-preinit-accessor',
                detail: `${calleeName}(...) (unguarded, inside ${policy.bootstrapFunctionName}())`,
                reason: accessor.reason,
                suggestion: accessor.suggestion,
              });
            }
          }
        }
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return violations;
}

// ---------------------------------------------------------------------------
// Transitive reachability walker (used by --list mode and to surface drift in
// reachable modules' static imports of forbidden specifiers).
// ---------------------------------------------------------------------------

interface ResolvedFile {
  readonly absolutePath: string;
  readonly relativePath: string;
}

interface TraversalResult {
  /** Files reachable via static imports from the bootstrap entry. */
  readonly reachable: ResolvedFile[];
  /**
   * Imports that could not be resolved against the cloud-service tsconfig
   * (typically external npm packages). Surfaced for `--list` mode.
   */
  readonly unresolved: Array<{ from: string; specifier: string }>;
}

function loadTsConfig(repoRoot: string): {
  options: ts.CompilerOptions;
  rootDir: string;
} {
  const tsconfigPath = path.join(repoRoot, 'cloud-service', 'tsconfig.json');
  const configFile = ts.readConfigFile(tsconfigPath, (p) => fs.readFileSync(p, 'utf8'));
  if (configFile.error) {
    throw new Error(
      `Failed to read ${tsconfigPath}: ${ts.flattenDiagnosticMessageText(configFile.error.messageText, '\n')}`,
    );
  }
  const parsed = ts.parseJsonConfigFileContent(
    configFile.config,
    ts.sys,
    path.dirname(tsconfigPath),
  );
  return { options: parsed.options, rootDir: path.dirname(tsconfigPath) };
}

export function collectImportSpecifiers(sourceFile: ts.SourceFile): string[] {
  const out: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      // Top-level `import type` is erased at runtime — don't drag the target
      // module into the reachability graph.
      if (!node.importClause?.isTypeOnly) {
        // If every named binding is per-specifier type-only
        // (`import { type A, type B } from '...'`), the whole import is
        // effectively erased. If at least one binding is runtime, fall through.
        const namedBindings = node.importClause?.namedBindings;
        const allSpecifiersTypeOnly =
          namedBindings
          && ts.isNamedImports(namedBindings)
          && namedBindings.elements.length > 0
          && namedBindings.elements.every((el) => el.isTypeOnly);
        if (!allSpecifiersTypeOnly) {
          out.push(node.moduleSpecifier.text);
        }
      }
    }
    if (
      ts.isExportDeclaration(node)
      && node.moduleSpecifier
      && ts.isStringLiteral(node.moduleSpecifier)
      && !node.isTypeOnly
    ) {
      // `export { type A, type B } from '...'` is also erased.
      const exportClause = node.exportClause;
      const allSpecifiersTypeOnly =
        exportClause
        && ts.isNamedExports(exportClause)
        && exportClause.elements.length > 0
        && exportClause.elements.every((el) => el.isTypeOnly);
      if (!allSpecifiersTypeOnly) {
        out.push(node.moduleSpecifier.text);
      }
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const arg = node.arguments[0];
      if (arg && (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg))) {
        out.push(arg.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return out;
}

function walkBootstrapReachability(
  repoRoot: string,
  entryRelative: string,
): TraversalResult {
  const { options } = loadTsConfig(repoRoot);
  const moduleResolutionHost: ts.ModuleResolutionHost = {
    fileExists: (p) => fs.existsSync(p),
    readFile: (p) => fs.readFileSync(p, 'utf8'),
    directoryExists: (p) => fs.existsSync(p) && fs.statSync(p).isDirectory(),
    realpath: (p) => fs.realpathSync(p),
    getCurrentDirectory: () => repoRoot,
    useCaseSensitiveFileNames: true,
  };

  const visited = new Set<string>();
  const queue: string[] = [];
  const unresolved: Array<{ from: string; specifier: string }> = [];

  const entryAbs = path.join(repoRoot, entryRelative);
  queue.push(entryAbs);
  visited.add(entryAbs);

  const reachable: ResolvedFile[] = [];

  while (queue.length > 0) {
    const filePath = queue.shift() as string;
    if (!fs.existsSync(filePath)) continue;
    const source = fs.readFileSync(filePath, 'utf8');
    const sf = ts.createSourceFile(
      filePath,
      source,
      ts.ScriptTarget.ES2022,
      true,
      ts.ScriptKind.TS,
    );
    reachable.push({
      absolutePath: filePath,
      relativePath: normalisePath(path.relative(repoRoot, filePath)),
    });

    const specifiers = collectImportSpecifiers(sf);
    for (const specifier of specifiers) {
      const resolved = ts.resolveModuleName(
        specifier,
        filePath,
        options,
        moduleResolutionHost,
      );
      const found = resolved.resolvedModule;
      if (!found) {
        unresolved.push({ from: normalisePath(path.relative(repoRoot, filePath)), specifier });
        continue;
      }
      if (found.isExternalLibraryImport) continue;
      const abs = path.resolve(found.resolvedFileName);
      if (visited.has(abs)) continue;
      visited.add(abs);
      // Only walk into project files (skip external libs and declaration-only files).
      if (abs.endsWith('.d.ts')) continue;
      // Stay inside the repo root.
      if (!abs.startsWith(repoRoot + path.sep)) continue;
      queue.push(abs);
    }
  }

  return { reachable, unresolved };
}

// ---------------------------------------------------------------------------
// CLI runner — skipped under VITEST so the pure-detection helpers above are
// importable for unit tests without firing the side-effectful walker.
// ---------------------------------------------------------------------------

function formatViolation(v: PolicyViolation): string {
  return [
    `  ${v.file}:${v.line}:${v.column} [${v.kind}]`,
    `    detail:     ${v.detail}`,
    `    reason:     ${v.reason}`,
    `    suggestion: ${v.suggestion}`,
  ].join('\n');
}

function runListMode(repoRoot: string, policy: CloudBootstrapPolicy): number {
  console.log(`Cloud bootstrap reachability graph (entry: ${policy.bootstrapEntryPath})\n`);
  let result: TraversalResult;
  try {
    result = walkBootstrapReachability(repoRoot, policy.bootstrapEntryPath);
  } catch (err) {
    console.error('Failed to walk bootstrap reachability:', err);
    return 1;
  }
  const sorted = result.reachable
    .map((entry) => entry.relativePath)
    .sort((a, b) => a.localeCompare(b));
  for (const filePath of sorted) {
    console.log(`  ${filePath}`);
  }
  console.log(`\nTotal reachable modules: ${sorted.length}`);
  if (result.unresolved.length > 0) {
    console.log(`\nUnresolved (likely external) imports: ${result.unresolved.length}`);
    const grouped = new Map<string, number>();
    for (const u of result.unresolved) {
      grouped.set(u.specifier, (grouped.get(u.specifier) ?? 0) + 1);
    }
    const top = [...grouped.entries()]
      .sort(([, a], [, b]) => b - a)
      .slice(0, 25);
    for (const [spec, count] of top) {
      console.log(`  ${spec} (${count})`);
    }
  }
  return 0;
}

function runGate(repoRoot: string, policy: CloudBootstrapPolicy): number {
  const allViolations: PolicyViolation[] = [];

  // 1. Bootstrap entry: full policy including call patterns + dynamic imports.
  const entryAbs = path.join(repoRoot, policy.bootstrapEntryPath);
  if (!fs.existsSync(entryAbs)) {
    console.error(
      `✗ Cannot find bootstrap entry: ${policy.bootstrapEntryPath}. Update DEFAULT_POLICY in `
      + 'scripts/check-cloud-bootstrap-policy.ts.',
    );
    return 1;
  }
  const entrySource = fs.readFileSync(entryAbs, 'utf8');
  allViolations.push(
    ...findCloudBootstrapPolicyViolations(entrySource, policy.bootstrapEntryPath, policy),
  );

  // 2. Reachable modules: STATIC import-pattern checks only.
  //    - Dynamic imports inside reachable modules are skipped because they
  //      typically live inside lazy method bodies (e.g.
  //      `CloudEmbeddingGenerator.initializePipeline()` does
  //      `await import('@huggingface/transformers')` — that's the canonical
  //      lazy pattern this gate is *defending*, not regressing).
  //    - Call-pattern checks are skipped because the deferred-warmup module
  //      (`cloudBootstrapWarmup.ts`) legitimately calls `initializeToolIndex`
  //      etc. on first request / idle.
  //    - Cross-surface `@main/*` checks are deferred to
  //      `scripts/check-cross-surface-imports.ts` to avoid double-firing.
  const reachable = walkBootstrapReachability(repoRoot, policy.bootstrapEntryPath);
  const reachablePolicy: CloudBootstrapPolicy = {
    ...policy,
    forbiddenBootstrapCalls: [], // import-only sweep
    forbiddenDynamicImports: [], // dynamic imports in lazy method bodies are fine
    forbiddenPreInitAccessors: [], // bootstrap-entry-only (rule already file-scoped)
  };
  for (const entry of reachable.reachable) {
    if (entry.relativePath === policy.bootstrapEntryPath) continue;
    const source = fs.readFileSync(entry.absolutePath, 'utf8');
    const fileViolations = findCloudBootstrapPolicyViolations(
      source,
      entry.relativePath,
      reachablePolicy,
    );
    // Only forward forbidden static-import violations — see the policy
    // rationale above for why dynamic imports / call patterns / @main checks
    // are bootstrap-entry-only.
    for (const v of fileViolations) {
      if (v.kind === 'forbidden-static-import') {
        allViolations.push(v);
      }
    }
  }

  if (allViolations.length === 0) {
    console.log(
      `✓ Cloud bootstrap policy: ${reachable.reachable.length} reachable modules scanned, no `
      + 'violations.',
    );
    return 0;
  }

  console.error(`✗ Cloud bootstrap policy violations (${allViolations.length}):\n`);
  for (const v of allViolations) {
    console.error(formatViolation(v));
    console.error('');
  }
  console.error(
    'See docs/project/CLOUD_BOOTSTRAP_POLICY.md for the rationale and how to fix.\n'
    + 'See docs-private/postmortems/260527_cloud_oom_warmup_4gb_postmortem.md for the bug class this gate '
    + 'prevents.',
  );
  return 1;
}

function repoRootFromHere(): string {
  return path.resolve(__dirname, '..');
}

function isDirectInvocation(): boolean {
  if (process.env.VITEST) return false;
  try {
    return process.argv[1] === fileURLToPath(import.meta.url);
  } catch {
    return process.argv[1] !== undefined && process.argv[1].endsWith('check-cloud-bootstrap-policy.ts');
  }
}

if (isDirectInvocation()) {
  const args = process.argv.slice(2);
  const repoRoot = repoRootFromHere();

  let exitCode = 0;
  try {
    if (args.includes('--list')) {
      exitCode = runListMode(repoRoot, DEFAULT_POLICY);
    } else if (args.includes('--help') || args.includes('-h')) {
      process.stdout.write(
        [
          'Usage: npx tsx scripts/check-cloud-bootstrap-policy.ts [--list]',
          '',
          'Default mode: gate. Exits non-zero if cloud bootstrap regresses to eager warmup.',
          '',
          'Options:',
          '  --list   Print the reachable-module graph from cloud-service/src/bootstrap.ts.',
          '  --help   Print this help.',
          '',
          'See docs/project/CLOUD_BOOTSTRAP_POLICY.md for the policy rationale.',
        ].join('\n') + '\n',
      );
      exitCode = 0;
    } else {
      exitCode = runGate(repoRoot, DEFAULT_POLICY);
    }
  } catch (err) {
    console.error('check-cloud-bootstrap-policy: unexpected error:', err);
    exitCode = 1;
  }
  process.exit(exitCode);
}
