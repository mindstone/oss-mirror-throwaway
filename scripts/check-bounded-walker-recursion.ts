#!/usr/bin/env tsx
/**
 * Bounded walker recursion ratchet.
 *
 * Raw recursive directory walkers are a recurring source of ENAMETOOLONG and
 * partial-walk bugs. New recursive `fs.readdir` / `fs.opendir` traversal must
 * use `safeWalkDirectory`; legacy sites are tracked with explicit annotations
 * and a monotonic baseline.
 *
 * Run: npx tsx scripts/check-bounded-walker-recursion.ts
 *
 * @see docs/plans/260503_s9_bounded_walker_resource_budget.md
 */

// Bounded-walker ratchet — prevents new raw recursive walkers and monotonically reduces the legacy count. See docs/plans/260503_s9_bounded_walker_resource_budget.md § Stage 6.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ts from 'typescript';

type SourceFileWithParseDiagnostics = ts.SourceFile & {
  readonly parseDiagnostics: readonly ts.Diagnostic[];
};

// 8 since 2026-06-22: pending dropped 12->8 when two raw-fs walkers were converted to the bounded
// `workspaceFs.readdirWithFileTypes` boundary — spaceService.scanWorkDirectory (1c392362b7) and three
// libraryHandlers walkers (validatePathForSpace/scanDirectory/collectFiles, 2323382754). Genuine
// conversions, not detector regression (the checker still flags raw fs.readdir/opendir). Monotonic-down
// ratchet: baseline lowered to lock the gain in (the prior 12 had been left stale after those landed).
export const BOUNDED_WALKER_PENDING_BASELINE = 8;
// 0 since S4.1a: safeWalkDirectory (the sole exempt walker) now reads via
// `workspaceFs.readdirWithFileTypes` (the bounded boundary), not raw `fs.readdir`, so this
// recursion checker no longer detects it as a raw-fs walker. Its no-raw-fs invariant is now
// enforced by the stricter workspace-fs boundary gate (`check-workspace-fs-boundary.ts`,
// BOUNDARY_GOVERNED_FILES). The `// bounded-walker-exempt` annotation is retained as a
// defensive tripwire (if raw fs ever reappears there it re-counts → exceeds this baseline).
export const BOUNDED_WALKER_EXEMPT_BASELINE = 0;

export const SCAN_ROOTS = [
  'src/core',
  'src/main',
  'src/renderer',
  'private/mindstone/src',
  'cloud-service/src',
] as const;

export type WalkerClassification = 'error' | 'pending' | 'exempt';

export interface WalkerViolation {
  file: string;
  line: number;
  functionName: string;
  classification: WalkerClassification;
  reason: string;
}

export interface ClassifiedWalkerResults {
  errors: WalkerViolation[];
  pending: WalkerViolation[];
  exempt: WalkerViolation[];
}

export interface FileScanResult {
  file: string;
  violations: WalkerViolation[];
}

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const READDIR_CALLEES = new Set([
  'fs.readdir',
  'fs.readdirSync',
  'fs.opendir',
  'fs.opendirSync',
  'readdir',
  'readdirSync',
  'opendir',
  'opendirSync',
]);
const READDIR_FUNCTION_NAMES = new Set([
  'readdir',
  'readdirSync',
  'opendir',
  'opendirSync',
]);

const DIRECTORY_EXCLUDES = new Set([
  'node_modules',
  'dist',
  'out',
  'build',
  'coverage',
  '__tests__',
  'super-mcp',
  'mobile',
]);

const PENDING_ANNOTATION = /\/\/\s*bounded-walker-pending:\s*(.+)/;
const EXEMPT_ANNOTATION = /\/\/\s*bounded-walker-exempt:\s*(.+)/;

function toPosixPath(filePath: string): string {
  return filePath.split(path.sep).join('/');
}

function displayPath(filePath: string): string {
  const relativePath = path.relative(REPO_ROOT, filePath);
  return toPosixPath(relativePath.startsWith('..') ? filePath : relativePath);
}

function isTestFile(filePath: string): boolean {
  const base = path.basename(filePath);
  return (
    base.endsWith('.test.ts') ||
    base.endsWith('.test.tsx') ||
    base.endsWith('.spec.ts') ||
    base.endsWith('.spec.tsx')
  );
}

function shouldSkipDirectory(directoryName: string): boolean {
  return DIRECTORY_EXCLUDES.has(directoryName);
}

function shouldScanFile(filePath: string): boolean {
  if (isTestFile(filePath)) return false;
  if (filePath.endsWith('.d.ts')) return false;
  return filePath.endsWith('.ts') || filePath.endsWith('.tsx');
}

function collectSourceFiles(scanRoots: readonly string[]): string[] {
  const files: string[] = [];
  const stack = scanRoots.map((scanRoot) =>
    path.isAbsolute(scanRoot) ? scanRoot : path.join(REPO_ROOT, scanRoot),
  );

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;

    let stat: fs.Stats;
    try {
      stat = fs.statSync(current);
    } catch (error) {
      console.warn(
        `[bounded-walker] WARN: unable to stat ${displayPath(current)}; skipping (${String(error)})`,
      );
      continue;
    }

    if (stat.isFile()) {
      if (shouldScanFile(current)) {
        files.push(current);
      }
      continue;
    }

    if (!stat.isDirectory()) {
      continue;
    }

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch (error) {
      console.warn(
        `[bounded-walker] WARN: unable to read ${displayPath(current)}; skipping (${String(error)})`,
      );
      continue;
    }

    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!shouldSkipDirectory(entry.name)) {
          stack.push(fullPath);
        }
        continue;
      }
      if (entry.isFile() && shouldScanFile(fullPath)) {
        files.push(fullPath);
      }
    }
  }

  return files.sort();
}

function annotationReason(sourceText: string): {
  classification: WalkerClassification;
  reason: string;
} {
  const exempt = sourceText.match(EXEMPT_ANNOTATION);
  if (exempt?.[1]) {
    return { classification: 'exempt', reason: exempt[1].trim() };
  }

  const pending = sourceText.match(PENDING_ANNOTATION);
  if (pending?.[1]) {
    return { classification: 'pending', reason: pending[1].trim() };
  }

  return {
    classification: 'error',
    reason:
      'raw recursive directory walker; migrate to safeWalkDirectory or add a reviewed bounded-walker annotation',
  };
}

function isGeneratedSource(sourceText: string): boolean {
  const header = sourceText.split('\n').slice(0, 12).join('\n');
  return /\/\/\s*@generated\b|<auto-generated/i.test(header);
}

function isFunctionLikeWithBody(
  node: ts.Node,
): node is ts.FunctionLikeDeclaration & { body: ts.ConciseBody } {
  return (
    (ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node) ||
      ts.isMethodDeclaration(node)) &&
    Boolean(node.body)
  );
}

function propertyNameToString(name: ts.PropertyName | undefined): string | null {
  if (!name) return null;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  return null;
}

function functionName(node: ts.FunctionLikeDeclaration): string | null {
  if (
    (ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isMethodDeclaration(node)) &&
    node.name
  ) {
    return propertyNameToString(node.name);
  }

  const parent = node.parent;
  if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
    return parent.name.text;
  }
  if (ts.isPropertyAssignment(parent)) {
    return propertyNameToString(parent.name);
  }

  return null;
}

function callExpressionName(node: ts.CallExpression): string | null {
  const expression = node.expression;
  if (ts.isIdentifier(expression)) {
    return expression.text;
  }
  if (ts.isPropertyAccessExpression(expression)) {
    const receiver = expression.expression;
    if (ts.isIdentifier(receiver)) {
      return `${receiver.text}.${expression.name.text}`;
    }
    return expression.name.text;
  }
  return null;
}

function hasPushInsideLoop(loop: ts.WhileStatement | ts.DoStatement): boolean {
  let found = false;

  function visit(node: ts.Node): void {
    if (found) return;
    if (isFunctionLikeWithBody(node)) return;

    if (ts.isCallExpression(node)) {
      const expression = node.expression;
      if (
        ts.isPropertyAccessExpression(expression) &&
        expression.name.text === 'push'
      ) {
        found = true;
        return;
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(loop.statement);
  return found;
}

function functionLooksLikeRecursiveWalker(
  node: ts.FunctionLikeDeclaration & { body: ts.ConciseBody },
  ownName: string | null,
): boolean {
  let callsReaddir = false;
  let callsSafeWalkDirectory = false;
  let selfRecursive = false;
  let loopWithPush = false;

  function visit(current: ts.Node): void {
    if (callsSafeWalkDirectory) return;
    if (current !== node.body && isFunctionLikeWithBody(current)) return;

    if (ts.isCallExpression(current)) {
      const callee = callExpressionName(current);
      if (callee === 'safeWalkDirectory') {
        callsSafeWalkDirectory = true;
        return;
      }
      if (callee && READDIR_CALLEES.has(callee)) {
        callsReaddir = true;
      }
      if (
        ownName &&
        !READDIR_FUNCTION_NAMES.has(ownName) &&
        (callee === ownName || callee?.endsWith(`.${ownName}`))
      ) {
        selfRecursive = true;
      }
    }

    if (
      (ts.isWhileStatement(current) || ts.isDoStatement(current)) &&
      hasPushInsideLoop(current)
    ) {
      loopWithPush = true;
    }

    ts.forEachChild(current, visit);
  }

  visit(node.body);
  if (callsSafeWalkDirectory) return false;
  return callsReaddir && (selfRecursive || loopWithPush);
}

export function findWalkerViolationsInSource(
  sourceText: string,
  filePath: string,
): WalkerViolation[] {
  if (isGeneratedSource(sourceText)) {
    return [];
  }

  const sourceFile = ts.createSourceFile(
    filePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    filePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );

  // TypeScript exposes parseDiagnostics at runtime but omits it from the public SourceFile type.
  const parseDiagnostics = (sourceFile as SourceFileWithParseDiagnostics).parseDiagnostics;
  if (parseDiagnostics.length > 0) {
    console.warn(
      `[bounded-walker] WARN: unable to parse ${displayPath(filePath)}; skipping (${parseDiagnostics.length} diagnostic(s))`,
    );
    return [];
  }

  const annotation = annotationReason(sourceText);
  const violations: WalkerViolation[] = [];

  function visit(node: ts.Node): void {
    if (isFunctionLikeWithBody(node)) {
      const name = functionName(node) ?? '<anonymous>';
      if (functionLooksLikeRecursiveWalker(node, name === '<anonymous>' ? null : name)) {
        const { line } = sourceFile.getLineAndCharacterOfPosition(
          node.getStart(sourceFile),
        );
        violations.push({
          file: displayPath(filePath),
          line: line + 1,
          functionName: name,
          classification: annotation.classification,
          reason: annotation.reason,
        });
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return violations;
}

export function runOne(filePath: string): FileScanResult {
  let sourceText: string;
  try {
    sourceText = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    console.warn(
      `[bounded-walker] WARN: unable to read ${displayPath(filePath)}; skipping (${String(error)})`,
    );
    return { file: displayPath(filePath), violations: [] };
  }

  return {
    file: displayPath(filePath),
    violations: findWalkerViolationsInSource(sourceText, filePath),
  };
}

export async function runWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R> | R,
): Promise<PromiseSettledResult<R>[]> {
  if (!Number.isFinite(concurrency) || concurrency <= 0) {
    throw new Error(`Invalid concurrency: ${concurrency}`);
  }
  if (items.length === 0) {
    return [];
  }

  const results: PromiseSettledResult<R>[] = new Array<PromiseSettledResult<R>>(
    items.length,
  );
  let nextIndex = 0;
  let active = 0;
  let completed = 0;

  return new Promise<PromiseSettledResult<R>[]>((resolve) => {
    const launchNext = (): void => {
      if (completed === items.length) {
        resolve(results);
        return;
      }

      while (active < concurrency && nextIndex < items.length) {
        const currentIndex = nextIndex;
        const item = items[currentIndex];
        nextIndex += 1;
        active += 1;

        Promise.resolve()
          .then(() => worker(item, currentIndex))
          .then(
            (value) => {
              results[currentIndex] = { status: 'fulfilled', value };
            },
            (reason: unknown) => {
              results[currentIndex] = { status: 'rejected', reason };
            },
          )
          .finally(() => {
            active -= 1;
            completed += 1;
            launchNext();
          });
      }
    };

    launchNext();
  });
}

export function findWalkerViolations(scanRoots: readonly string[]): WalkerViolation[] {
  return collectSourceFiles(scanRoots).flatMap((file) => runOne(file).violations);
}

export function classifyResults(
  violations: readonly WalkerViolation[],
): ClassifiedWalkerResults {
  return {
    errors: violations.filter((violation) => violation.classification === 'error'),
    pending: violations.filter(
      (violation) => violation.classification === 'pending',
    ),
    exempt: violations.filter((violation) => violation.classification === 'exempt'),
  };
}

function formatViolationList(title: string, violations: readonly WalkerViolation[]): string[] {
  if (violations.length === 0) return [];
  return [
    title,
    ...violations.map(
      (violation) =>
        `  - ${violation.file}:${violation.line} ${violation.functionName} (${violation.reason})`,
    ),
  ];
}

function buildReport(
  scannedRoots: readonly string[],
  results: ClassifiedWalkerResults,
): { ok: boolean; report: string } {
  const lines: string[] = [
    'Bounded walker recursion ratchet',
    `Scanned roots: ${scannedRoots.join(', ')}`,
    '',
  ];

  let failed = false;

  if (results.errors.length > 0) {
    failed = true;
    lines.push(
      `✘ Unannotated raw recursive walkers: ${results.errors.length}`,
      ...formatViolationList('New violations:', results.errors),
      '',
    );
  } else {
    lines.push('✔ Unannotated raw recursive walkers: 0');
  }

  if (results.pending.length > BOUNDED_WALKER_PENDING_BASELINE) {
    failed = true;
    lines.push(
      `✘ Pending annotated walkers: ${results.pending.length}/${BOUNDED_WALKER_PENDING_BASELINE} (baseline exceeded)`,
      ...formatViolationList('Pending walkers:', results.pending),
      '',
    );
  } else {
    lines.push(
      `✔ Pending annotated walkers: ${results.pending.length}/${BOUNDED_WALKER_PENDING_BASELINE}`,
    );
    if (results.pending.length < BOUNDED_WALKER_PENDING_BASELINE) {
      lines.push(
        `⚠ Pending walker count is below baseline ${BOUNDED_WALKER_PENDING_BASELINE}; lower BOUNDED_WALKER_PENDING_BASELINE.`,
      );
    }
  }

  if (results.exempt.length > BOUNDED_WALKER_EXEMPT_BASELINE) {
    failed = true;
    lines.push(
      `✘ Exempt annotated walkers: ${results.exempt.length}/${BOUNDED_WALKER_EXEMPT_BASELINE} (baseline exceeded)`,
      ...formatViolationList('Exempt walkers:', results.exempt),
      '',
    );
  } else {
    lines.push(
      `✔ Exempt annotated walkers: ${results.exempt.length}/${BOUNDED_WALKER_EXEMPT_BASELINE}`,
    );
    if (results.exempt.length < BOUNDED_WALKER_EXEMPT_BASELINE) {
      lines.push(
        `⚠ Exempt walker count is below baseline ${BOUNDED_WALKER_EXEMPT_BASELINE}; lower BOUNDED_WALKER_EXEMPT_BASELINE.`,
      );
    }
  }

  if (failed) {
    lines.push(
      '',
      'Migrate recursive directory traversal to safeWalkDirectory. Existing legacy sites must use bounded-walker-pending with a plan-doc reason; genuine bounded exceptions must use bounded-walker-exempt and receive PR review.',
    );
  }

  return { ok: !failed, report: lines.join('\n') };
}

export async function run(): Promise<{ ok: boolean; report: string }> {
  const runResults = await runWithConcurrency(
    collectSourceFiles(SCAN_ROOTS),
    4,
    (file) => runOne(file),
  );
  const violations: WalkerViolation[] = [];
  const rejected: unknown[] = [];

  for (const result of runResults) {
    if (result.status === 'fulfilled') {
      violations.push(...result.value.violations);
    } else {
      rejected.push(result.reason);
    }
  }

  const classified = classifyResults(violations);
  const report = buildReport(SCAN_ROOTS, classified);
  if (rejected.length === 0) {
    return report;
  }

  return {
    ok: false,
    report: [
      report.report,
      '',
      `✘ ${rejected.length} file scan worker(s) failed unexpectedly:`,
      ...rejected.map((reason) => `  - ${String(reason)}`),
    ].join('\n'),
  };
}

const invokedDirectly = process.argv[1] === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  run()
    .then(({ ok, report }) => {
      console.log(report);
      if (!ok) {
        process.exit(1);
      }
    })
    .catch((error: unknown) => {
      console.error('Unexpected error in check-bounded-walker-recursion:', error);
      process.exit(1);
    });
}
