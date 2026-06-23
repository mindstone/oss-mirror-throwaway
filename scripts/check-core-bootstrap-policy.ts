#!/usr/bin/env npx tsx
/**
 * CI Validation: Core Bootstrap Policy (OSS boot-crash class)
 *
 * AST-based gate that prevents regressions of the OSS desktop boot crash where
 * a module under src/core/** evaluated a PlatformConfig-reading accessor at
 * MODULE-LOAD (import) time, before bootstrap called setPlatformConfig().
 *
 * The bug: toolIndexService.ts evaluated `getNativeModuleRequire()` at module
 * top-level, which calls `isPackaged()` -> `getPlatformConfig()`. When the
 * module was imported before bootstrap wired PlatformConfig (the OSS desktop
 * build path), getPlatformConfig() threw "PlatformConfig not initialized",
 * crashing the app at startup. The fix made that read lazy. This gate keeps the
 * whole of src/core honest: no production module under src/core/** may read a
 * PlatformConfig-backed accessor at import time.
 *
 * What this gate catches:
 *   (1) DIRECT ACCESSOR — a MODULE-SCOPE (import-time) CALL to any of:
 *     getPlatformConfig, isPackaged, getDataPath, getAppVersion, getAppRoot,
 *     getNativeModuleRequire
 *   in any production file under src/core/** (tests excluded). "Module scope /
 *   import time" means the call executes when the module is first imported:
 *     - top-level `const/let/var x = <call>()`            (initializer)
 *     - top-level bare call expression `<call>()`          (side-effecting)
 *     - module-scope IIFE bodies `(() => { <call>() })()`  (run at import)
 *     - module-scope object/array literal initializers calling these
 *   It is NOT flagged when the call lives inside a function / method / arrow /
 *   getter body, or a class constructor/method — those run on invocation, not
 *   at import. The toolIndex fix (a lazy closure that calls the accessor on
 *   first use) is therefore correctly NOT flagged.
 *
 *   (2) LOGGER USE (kind A) — a MODULE-SCOPE member access on a module logger
 *   binding, e.g. `log.info(...)` or even a bare read `log.level`. A scoped
 *   logger (`createScopedLogger` / `createTurnSessionLogger`) returns a lazy
 *   proxy: ANY property GET on it drives getRootLogger() -> ensureLogDirectory()
 *   -> getDataPath() -> getPlatformConfig(). So touching the logger at import
 *   time crashes the same way. The DECLARATION (`const log =
 *   createScopedLogger(...)`) is import-SAFE (it's just the lazy proxy) and is
 *   NOT flagged — only USE at module scope is.
 *
 *   (3) TAINTED LOCAL CALL (kind B) — a MODULE-SCOPE CALL to a bare-identifier
 *   function DECLARED IN THIS FILE whose body SYNCHRONOUSLY (i) calls a forbidden
 *   accessor, (ii) uses a module logger binding, or (iii) calls another tainted
 *   local function. This is the live settingsStore bug: a top-level
 *   `hardenSettingsStoreFilePermissions();` whose body calls `log.warn(...)` in a
 *   catch block. The function set is computed via an intra-file fixpoint; any
 *   module-scope call to a member of that set is flagged.
 *
 *   Kind B is SYNCHRONOUS-AWARE on two axes:
 *     - NESTED CLOSURES: a logger/accessor use inside a NESTED callback that is
 *       merely defined or passed as an argument — `setInterval(() =>
 *       log.info(...))`, a returned closure, an event-observer callback — runs
 *       LATER, so it does NOT taint the enclosing function. (A synchronous IIFE
 *       inside the body still counts.)
 *     - ASYNC PREFIX: an `async function` runs SYNCHRONOUSLY only up to its first
 *       `await`. So uses in that synchronous prefix (before the first pre-order
 *       await) DO taint and CAN crash the import — `async function boot(){
 *       log.info('x'); await y } boot()` is flagged — while uses at-or-after the
 *       first await are deferred to a later microtask and do NOT taint. (A sync
 *       function has no await, so its whole body counts.)
 *   The crash only happens when the logger/accessor is reached during the
 *   synchronous import-time call.
 *
 * KNOWN LIMITATIONS (deliberate — closing them needs dataflow / symbol
 * resolution, over-engineering for this gate):
 *   - Only BARE-IDENTIFIER calls are detected (`getDataPath()`), matching the
 *     realistic accidental-regression shape (a copy-pasted top-level call). A
 *     namespace/property call (`dataPaths.getDataPath()`) or an aliased binding
 *     (`const g = getPlatformConfig; g()`) is NOT flagged.
 *   - `new X(...)` at module scope is OUT OF SCOPE: a constructor that reads an
 *     accessor internally can't be resolved statically by an AST-only walker.
 *     The accessor call inside the constructor body is itself unflagged (it's a
 *     method body), so this is a deliberate gap, not a false negative we can
 *     cheaply close.
 *   - Kind B's ASYNC PREFIX uses a PRE-ORDER first-await cut, which is unsound
 *     only for the rarer shape where an `await` sits in a LEADING conditional
 *     branch before the use: `async function f(){ if (c) { await x } log.info('y')
 *     } f()`. If `c` is false no await runs and `log.info` executes
 *     synchronously, but the pre-order await precedes the use, so it is NOT
 *     flagged. Closing this needs control-flow dominance analysis (out of scope
 *     for an AST-only gate); the launch boot-smoke is the backstop. (Kind A —
 *     direct module-scope logger member access — is always synchronous and
 *     unaffected.)
 *   This mirrors the bare-identifier + lexical-scope posture of the sibling
 *   gate (scripts/check-cloud-bootstrap-policy.ts rule 5).
 *
 * Modes:
 *   - default (gate)   `npx tsx scripts/check-core-bootstrap-policy.ts`
 *   - list scanned     `npx tsx scripts/check-core-bootstrap-policy.ts --list`
 *
 * Wired into `npm run validate:fast` via scripts/run-validate-fast.ts
 * (see `validate:core-bootstrap-policy`).
 *
 * @see scripts/check-cloud-bootstrap-policy.ts (sibling AST pattern — rule 5)
 * @see src/core/services/toolIndex/toolIndexService.ts (the fixed module)
 * @see src/core/services/toolIndex/__tests__/toolIndexService.platformConfigBoot.test.ts
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ts from 'typescript';

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

/**
 * Bare-identifier accessor names that read getPlatformConfig() (directly or
 * transitively) and therefore throw "PlatformConfig not initialized" when
 * called before bootstrap wires PlatformConfig. Calling any of these at module
 * scope re-introduces the OSS boot-crash class.
 */
export const FORBIDDEN_PLATFORM_ACCESSORS: readonly string[] = [
  'getPlatformConfig',
  'isPackaged',
  'getDataPath',
  'getAppVersion',
  'getAppRoot',
  'getNativeModuleRequire',
];

const ACCESSOR_SET = new Set(FORBIDDEN_PLATFORM_ACCESSORS);

/**
 * Logger factory names that return a LAZY scoped-logger proxy. The proxy reads
 * getRootLogger() (-> ensureLogDirectory() -> getDataPath() ->
 * getPlatformConfig()) on the FIRST property access of any kind, so touching the
 * binding at module scope re-introduces the boot-crash class. The factory CALL
 * itself is safe (it only builds the proxy); only later property access is not.
 */
export const LOGGER_FACTORY_NAMES: readonly string[] = [
  'createScopedLogger',
  'createTurnSessionLogger',
];

const LOGGER_FACTORY_SET = new Set(LOGGER_FACTORY_NAMES);

/**
 * Names imported from '@core/logger' that are themselves a ready-to-use logger
 * proxy (not a factory): `import { logger } from '@core/logger'`. Any property
 * access on such a binding at module scope is a violation.
 */
const LOGGER_IMPORT_NAMES = new Set(['logger']);

const LOGGER_IMPORT_MODULE = '@core/logger';

const SCANNED_ROOT = 'src/core';

// ---------------------------------------------------------------------------
// Pure detection (unit-testable)
// ---------------------------------------------------------------------------

export interface CorePolicyViolation {
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly accessor: string;
  readonly detail: string;
}

function normalisePath(filePath: string): string {
  return filePath.split(path.sep).join('/');
}

function getLine(sourceFile: ts.SourceFile, node: ts.Node): { line: number; column: number } {
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return { line: line + 1, column: character + 1 };
}

/**
 * Return true if `node` is at MODULE SCOPE — i.e. it executes when the module
 * is first imported, NOT on later invocation. We walk parent pointers and:
 *   - return FALSE the moment we cross a function/method/arrow/getter/setter/
 *     constructor boundary (the call runs on invocation, not at import);
 *   - return TRUE if we reach the SourceFile without crossing one.
 *
 * Module-scope IIFEs are handled correctly by virtue of the call being parsed
 * normally: the accessor call INSIDE an IIFE body is inside a function
 * expression, so it is NOT flagged here — but that's acceptable for our threat
 * model. Wait: an IIFE body DOES run at import time, so we must NOT stop at the
 * arrow/function boundary if that function is IMMEDIATELY invoked at module
 * scope. We special-case that below (isImmediatelyInvokedAtModuleScope).
 */
function isModuleScope(node: ts.Node): boolean {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (
      ts.isFunctionDeclaration(current) ||
      ts.isFunctionExpression(current) ||
      ts.isArrowFunction(current) ||
      ts.isMethodDeclaration(current) ||
      ts.isGetAccessorDeclaration(current) ||
      ts.isSetAccessorDeclaration(current) ||
      ts.isConstructorDeclaration(current)
    ) {
      // Crossed a function boundary. This is import-time-executed ONLY if the
      // boundary is a module-scope IIFE (an arrow/function expression that is
      // the callee of a call expression that is itself at module scope).
      if (isImmediatelyInvokedAtModuleScope(current)) {
        // The IIFE runs at import; keep ascending to confirm the IIFE itself is
        // module-scoped (handled by the recursive isModuleScope on the call).
        current = current.parent;
        continue;
      }
      return false;
    }
    if (ts.isSourceFile(current)) {
      return true;
    }
    current = current.parent;
  }
  return true;
}

/**
 * True if `fn` is a function expression / arrow that is the callee of an IIFE:
 *   (function () { ... })()   |   (() => { ... })()
 * AND that IIFE call is itself at module scope. This is what lets us flag an
 * accessor call inside a top-level IIFE body (which runs at import) while still
 * NOT flagging the same call inside an ordinary function that merely happens to
 * be defined at module scope.
 */
function isImmediatelyInvokedAtModuleScope(fn: ts.Node): boolean {
  if (!isImmediatelyInvoked(fn)) return false;
  // The IIFE call itself must be at module scope (recurse on the call node).
  let candidate: ts.Node = fn;
  while (candidate.parent && ts.isParenthesizedExpression(candidate.parent)) {
    candidate = candidate.parent;
  }
  const call = candidate.parent as ts.CallExpression;
  return isModuleScope(call);
}

/**
 * True if `fn` is a function expression / arrow that is the callee of a call
 * (an IIFE: `(() => {...})()` or `(function(){...})()`), regardless of where
 * that call sits. Used by both the module-scope IIFE check and the synchronous
 * taint analysis (an IIFE body inside a function runs synchronously when that
 * function is called).
 */
function isImmediatelyInvoked(fn: ts.Node): boolean {
  if (!ts.isFunctionExpression(fn) && !ts.isArrowFunction(fn)) return false;
  // The function may be wrapped in parens: `(() => {})()`.
  let candidate: ts.Node = fn;
  while (candidate.parent && ts.isParenthesizedExpression(candidate.parent)) {
    candidate = candidate.parent;
  }
  const call = candidate.parent;
  return Boolean(call && ts.isCallExpression(call) && call.expression === candidate);
}

/**
 * Collect the names of module logger bindings declared in this source file:
 *   - `const <id> = createScopedLogger(...)` / `createTurnSessionLogger(...)`
 *     (variable declarations, at any scope — the proxy is lazy regardless of
 *     where it's declared; what matters is where it is USED).
 *   - a named import of a ready-made logger proxy from '@core/logger', e.g.
 *     `import { logger } from '@core/logger'` (honours `as` aliases).
 */
function collectLoggerBindings(sourceFile: ts.SourceFile): Set<string> {
  const names = new Set<string>();

  const visit = (node: ts.Node): void => {
    // const x = createScopedLogger(...) / createTurnSessionLogger(...)
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      ts.isCallExpression(node.initializer) &&
      ts.isIdentifier(node.initializer.expression) &&
      LOGGER_FACTORY_SET.has(node.initializer.expression.text)
    ) {
      names.add(node.name.text);
    }

    // import { logger } from '@core/logger'  (with optional `as` alias)
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      node.moduleSpecifier.text === LOGGER_IMPORT_MODULE &&
      node.importClause?.namedBindings &&
      ts.isNamedImports(node.importClause.namedBindings)
    ) {
      for (const spec of node.importClause.namedBindings.elements) {
        const importedName = (spec.propertyName ?? spec.name).text;
        if (LOGGER_IMPORT_NAMES.has(importedName)) {
          names.add(spec.name.text);
        }
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return names;
}

/**
 * True if `node` is a property/element access whose root object is one of the
 * given logger binding names (e.g. `log.info`, `log.level`, `logger['warn']`).
 * Returns the binding name when matched, else undefined.
 */
function loggerAccessTarget(
  node: ts.Node,
  loggerNames: ReadonlySet<string>,
): string | undefined {
  if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
    const obj = node.expression;
    if (ts.isIdentifier(obj) && loggerNames.has(obj.text)) {
      return obj.text;
    }
  }
  return undefined;
}

/** True if a function node is async. */
function isAsyncFunction(fn: ts.Node): boolean {
  if (!ts.canHaveModifiers(fn)) return false;
  return ts.getModifiers(fn)?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword) ?? false;
}

/**
 * Map of locally-declared functions to their function NODES, keyed by binding
 * name. Covers `function f(){}` and `const f = () => {}` / `const f =
 * function(){}`, INCLUDING async functions: an async function runs
 * SYNCHRONOUSLY up to its first `await`, so logger/accessor use in that
 * synchronous prefix can still crash the import (handled in analyseFunctionBody).
 * We collect any named local function so transitive (intra-file) call
 * resolution works.
 */
function collectLocalFunctions(sourceFile: ts.SourceFile): Map<string, ts.Node> {
  const fns = new Map<string, ts.Node>();

  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name && node.body) {
      fns.set(node.name.text, node);
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
    ) {
      fns.set(node.name.text, node.initializer);
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return fns;
}

/**
 * Collect the taint signals that execute SYNCHRONOUSLY when `fn` is called:
 * bare-identifier function calls it makes (intra-file edges), whether it
 * directly calls a forbidden accessor, and whether it accesses a module logger
 * binding.
 *
 * SYNCHRONOUS-AWARE on two axes:
 *   - NESTED CLOSURES: we do NOT descend into a nested function expression /
 *     arrow / function declaration unless it is a SYNCHRONOUS IIFE. A use inside
 *     a callback that is merely defined or passed as an argument
 *     (`setInterval(() => log.info(...))`, a returned closure) runs LATER, so it
 *     must not taint. (An async IIFE also defers past its first await; we don't
 *     descend.)
 *   - AWAIT PREFIX: for an async function, only the SYNCHRONOUS PREFIX counts —
 *     everything BEFORE the first `await` reached in a pre-order traversal. At
 *     and after that first await, the body runs in a later microtask, so uses
 *     there do NOT taint. (A sync function has no await, so its whole body
 *     counts.) `await`s inside nested non-IIFE closures don't count as the outer
 *     function's first await because we don't descend into them.
 *
 * The first-await cut is a pre-order approximation; see the header
 * known-limitation for the residual unsound case (a leading conditional await).
 */
function analyseFunctionBody(
  fn: ts.Node,
  loggerNames: ReadonlySet<string>,
): { callees: Set<string>; usesAccessor: boolean; usesLogger: boolean } {
  const callees = new Set<string>();
  let usesAccessor = false;
  let usesLogger = false;
  // Once we cross the first pre-order `await`, the rest of this function body
  // runs in a later microtask and can no longer crash the import synchronously.
  let pastFirstAwait = false;

  const body =
    (ts.isFunctionDeclaration(fn) || ts.isFunctionExpression(fn) || ts.isArrowFunction(fn)
      ? fn.body
      : undefined) ?? fn;

  const visit = (node: ts.Node): void => {
    if (pastFirstAwait) return;

    // The first `await` in pre-order cuts the synchronous prefix. The await's
    // OPERAND still runs synchronously (it's evaluated before suspension), so we
    // descend into the operand first, THEN stop. Visit children, then flip.
    if (ts.isAwaitExpression(node)) {
      visit(node.expression);
      pastFirstAwait = true;
      return;
    }

    // A nested function boundary defers execution unless it is a sync IIFE.
    if (
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node) ||
      ts.isFunctionDeclaration(node)
    ) {
      const isSyncIife =
        (ts.isFunctionExpression(node) || ts.isArrowFunction(node)) &&
        isImmediatelyInvoked(node) &&
        !isAsyncFunction(node);
      if (!isSyncIife) {
        return; // runs later, not during the synchronous call — does not taint
      }
      // Sync IIFE: fall through and descend into its body (runs synchronously).
    }

    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const name = node.expression.text;
      if (ACCESSOR_SET.has(name)) {
        usesAccessor = true;
      } else {
        callees.add(name);
      }
    }
    if (loggerAccessTarget(node, loggerNames) !== undefined) {
      usesLogger = true;
    }
    ts.forEachChild(node, visit);
  };

  // Walk children of the body (the body itself is a Block/expression; its
  // contents are what execute on invocation).
  ts.forEachChild(body, visit);
  return { callees, usesAccessor, usesLogger };
}

/**
 * Compute the set of locally-declared functions that, when invoked, transitively
 * reach a forbidden accessor or a module logger binding. Intra-file fixpoint.
 */
function computeTaintedFunctions(
  localFns: ReadonlyMap<string, ts.Node>,
  loggerNames: ReadonlySet<string>,
): Set<string> {
  const analysis = new Map<
    string,
    { callees: Set<string>; usesAccessor: boolean; usesLogger: boolean }
  >();
  for (const [name, fnNode] of localFns) {
    analysis.set(name, analyseFunctionBody(fnNode, loggerNames));
  }

  const tainted = new Set<string>();
  // Seed: directly uses an accessor or a logger binding.
  for (const [name, a] of analysis) {
    if (a.usesAccessor || a.usesLogger) tainted.add(name);
  }

  // Propagate: a function calling a tainted local function is itself tainted.
  let changed = true;
  while (changed) {
    changed = false;
    for (const [name, a] of analysis) {
      if (tainted.has(name)) continue;
      for (const callee of a.callees) {
        if (tainted.has(callee)) {
          tainted.add(name);
          changed = true;
          break;
        }
      }
    }
  }

  return tainted;
}

/**
 * Pure detection: parse `source` and return any module-scope (import-time)
 * boot-crash hazards under src/core/**:
 *   (1) direct forbidden-accessor calls,
 *   (2) member access on a module logger binding (kind A),
 *   (3) calls to a tainted local function (kind B).
 */
export function findCoreBootstrapPolicyViolations(
  source: string,
  filePath: string,
): CorePolicyViolation[] {
  const violations: CorePolicyViolation[] = [];
  const normalisedFile = normalisePath(filePath);

  const sourceFile = ts.createSourceFile(
    filePath,
    source,
    ts.ScriptTarget.ES2022,
    /* setParentNodes */ true,
    ts.ScriptKind.TS,
  );

  const loggerNames = collectLoggerBindings(sourceFile);
  const localFns = collectLocalFunctions(sourceFile);
  const taintedFns = computeTaintedFunctions(localFns, loggerNames);

  const push = (node: ts.Node, accessor: string, detail: string): void => {
    const { line, column } = getLine(sourceFile, node);
    violations.push({ file: normalisedFile, line, column, accessor, detail });
  };

  const visit = (node: ts.Node): void => {
    // (1) Direct forbidden-accessor call at module scope (existing rule).
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const calleeName = node.expression.text;
      if (ACCESSOR_SET.has(calleeName) && isModuleScope(node)) {
        push(node, calleeName, `${calleeName}() called at module scope (import time)`);
      } else if (
        // (3) Kind B — module-scope call to a tainted local function.
        taintedFns.has(calleeName) &&
        isModuleScope(node)
      ) {
        push(
          node,
          calleeName,
          `${calleeName}() called at module scope reaches the module logger / a `
            + 'platform accessor (transitively -> getPlatformConfig at import time)',
        );
      }
    }

    // (2) Kind A — member access on a module logger binding at module scope.
    // We match the access expression (`log.info`) rather than the surrounding
    // call so a bare property read (`log.level`) is caught too.
    const loggerTarget = loggerAccessTarget(node, loggerNames);
    if (loggerTarget !== undefined && isModuleScope(node)) {
      const accessorLabel = ts.isPropertyAccessExpression(node)
        ? `${loggerTarget}.${node.name.text}`
        : `${loggerTarget}[...]`;
      push(
        node,
        accessorLabel,
        `${accessorLabel} used at module scope: touching the scoped logger proxy at import `
          + 'time drives getRootLogger() -> getDataPath() -> getPlatformConfig()',
      );
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return violations;
}

// ---------------------------------------------------------------------------
// File discovery
// ---------------------------------------------------------------------------

const PROD_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts']);

/** A file is a TEST (excluded) if it is under a __tests__ dir or *.test/*.spec. */
function isTestFile(relPath: string): boolean {
  const p = normalisePath(relPath);
  if (p.includes('/__tests__/')) return true;
  return /\.(test|spec)\.(ts|tsx|mts|cts)$/.test(p);
}

/** A file is a type-declaration file (excluded — no runtime). */
function isDeclarationFile(relPath: string): boolean {
  return /\.d\.ts$/.test(relPath);
}

function collectCoreFiles(repoRoot: string): string[] {
  const root = path.join(repoRoot, SCANNED_ROOT);
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules') continue;
        walk(abs);
        continue;
      }
      if (!entry.isFile()) continue;
      const ext = path.extname(entry.name);
      if (!PROD_EXTENSIONS.has(ext)) continue;
      const rel = normalisePath(path.relative(repoRoot, abs));
      if (isDeclarationFile(rel) || isTestFile(rel)) continue;
      out.push(abs);
    }
  };
  if (!fs.existsSync(root)) return out;
  walk(root);
  return out;
}

// ---------------------------------------------------------------------------
// CLI runner — skipped under VITEST so the pure helpers stay importable.
// ---------------------------------------------------------------------------

function formatViolation(v: CorePolicyViolation): string {
  return `  ${v.file}:${v.line}:${v.column}  ${v.detail}`;
}

function runListMode(repoRoot: string): number {
  const files = collectCoreFiles(repoRoot)
    .map((f) => normalisePath(path.relative(repoRoot, f)))
    .sort((a, b) => a.localeCompare(b));
  for (const f of files) console.log(`  ${f}`);
  console.log(`\nTotal production files under ${SCANNED_ROOT}/: ${files.length}`);
  return 0;
}

function runGate(repoRoot: string): number {
  const files = collectCoreFiles(repoRoot);
  const allViolations: CorePolicyViolation[] = [];
  for (const abs of files) {
    const source = fs.readFileSync(abs, 'utf8');
    const rel = normalisePath(path.relative(repoRoot, abs));
    allViolations.push(...findCoreBootstrapPolicyViolations(source, rel));
  }

  if (allViolations.length === 0) {
    console.log(
      `✓ Core bootstrap policy: ${files.length} production files under ${SCANNED_ROOT}/ scanned, `
      + 'no module-load-time platform-config reads.',
    );
    return 0;
  }

  console.error(
    `✗ Core bootstrap policy violations (${allViolations.length}): module-load-time platform-config `
    + 'reads under src/core/**\n',
  );
  for (const v of allViolations) {
    console.error(formatViolation(v));
  }
  console.error(
    '\nReading a PlatformConfig-backed accessor '
    + `(${FORBIDDEN_PLATFORM_ACCESSORS.join(', ')}) at module scope — directly, via a scoped-logger `
    + `binding (${LOGGER_FACTORY_NAMES.join(', ')} or an imported \`logger\`), or via a local `
    + 'function that transitively reaches one — throws "PlatformConfig not initialized" when the '
    + 'module is imported before bootstrap calls setPlatformConfig(): the OSS desktop boot-crash class '
    + '(see src/core/services/toolIndex/toolIndexService.ts and src/core/services/settingsStore for '
    + 'fixes).\n'
    + 'FIX: defer the read/log into a function/closure that runs on first use, not at import time.',
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
    return (
      process.argv[1] !== undefined && process.argv[1].endsWith('check-core-bootstrap-policy.ts')
    );
  }
}

if (isDirectInvocation()) {
  const args = process.argv.slice(2);
  const repoRoot = repoRootFromHere();
  let exitCode = 0;
  try {
    if (args.includes('--list')) {
      exitCode = runListMode(repoRoot);
    } else if (args.includes('--help') || args.includes('-h')) {
      process.stdout.write(
        [
          'Usage: npx tsx scripts/check-core-bootstrap-policy.ts [--list]',
          '',
          'Default mode: gate. Exits non-zero if any production file under src/core/**',
          'reads a PlatformConfig-backed accessor at module-load (import) time.',
          '',
          'Options:',
          '  --list   Print the production files under src/core/ that are scanned.',
          '  --help   Print this help.',
        ].join('\n') + '\n',
      );
      exitCode = 0;
    } else {
      exitCode = runGate(repoRoot);
    }
  } catch (err) {
    console.error('check-core-bootstrap-policy: unexpected error:', err);
    exitCode = 1;
  }
  process.exit(exitCode);
}
