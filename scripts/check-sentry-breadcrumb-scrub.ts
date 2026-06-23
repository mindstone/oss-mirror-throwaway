#!/usr/bin/env npx tsx
/**
 * Static privacy guard for Sentry breadcrumb data scrubbing.
 *
 * PM: 260607_allowlist_log_breadcrumbs_scrub_server_name
 *
 * Log-category breadcrumbs carry structured logger bindings. Generic pattern
 * redaction is insufficient for those bindings because content under benign
 * keys can leak. This guard keeps log breadcrumb `data` on a deny-by-default
 * allowlist path by construction.
 *
 * Scope / known limitation (deliberately narrow — broad guards get disabled):
 * it matches the INLINE shapes that exist today (an `if`/ternary on a
 * `breadcrumb.category` log-category test whose log branch assigns
 * `breadcrumb.data = redactLogBreadcrumbData(breadcrumb.data)` or deletes
 * `breadcrumb.data`). A hook that delegates scrubbing to a HELPER
 * function (e.g. `scrubBreadcrumb(breadcrumb)`) is not followed into the helper,
 * so it would pass without enforcement. The durable net is the completeness
 * check: a `beforeBreadcrumb` hook in any SCAN_ROOTS file not in
 * KNOWN_BREADCRUMB_HOOKS fails — so a new scrubber must be classified here, at
 * which point the inline invariant (or an explicit decision) is forced. If a
 * known hook is ever refactored to delegate to a helper, extend this guard to
 * follow that call.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PM_REFERENCE = '260607_allowlist_log_breadcrumbs_scrub_server_name';
const INVARIANT =
  'Log-category Sentry breadcrumb data must use redactLogBreadcrumbData(...) or delete breadcrumb.data; it must not fall through to redactObjectDeep(...).';

// Keep this deliberately tiny. Only log breadcrumbs need the deny-by-default
// logger allowlist; other Sentry breadcrumb categories keep generic redaction.
export const LOG_CATEGORIES = new Set(['log', 'renderer.log']);

export const KNOWN_BREADCRUMB_HOOKS = [
  'src/main/sentry.ts',
  'src/renderer/src/sentry.ts',
  'cloud-service/src/bootstrap.ts',
  'mobile/src/utils/sentry.ts',
] as const;

// Roots scanned for `beforeBreadcrumb` hooks. These are the surfaces that
// initialise Sentry (desktop main+renderer under src/, the cloud service under
// cloud-service/src, mobile under mobile/src). A `beforeBreadcrumb` hook
// discovered in any of these outside KNOWN_BREADCRUMB_HOOKS fails the
// completeness check — so a new Sentry surface can't ship an unclassified
// breadcrumb scrubber.
export const SCAN_ROOTS = ['src', 'cloud-service/src', 'mobile/src'] as const;

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts']);
const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'out',
  'release',
  'build',
  '.electron-vite',
  '.vite',
  'coverage',
]);

export interface BreadcrumbScrubViolation {
  readonly filePath: string;
  readonly line: number;
  readonly column: number;
  readonly problem: string;
  readonly fix: string;
}

export interface BreadcrumbHookAnalysisResult {
  readonly filePath: string;
  readonly hooksFound: number;
  readonly violations: readonly BreadcrumbScrubViolation[];
}

interface LogBranch {
  readonly category: string;
  readonly test: ts.Expression;
  readonly logBranch: ts.Node;
  readonly nonLogBranch: ts.Node | null;
}

function normalizePath(filePath: string): string {
  return filePath.replace(/\\/g, '/').replace(/^\.\//, '');
}

function sourceKindForPath(filePath: string): ts.ScriptKind {
  if (filePath.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (filePath.endsWith('.jsx')) return ts.ScriptKind.JSX;
  return ts.ScriptKind.TS;
}

function createSourceFile(source: string, filePath: string): ts.SourceFile {
  return ts.createSourceFile(
    filePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    sourceKindForPath(filePath),
  );
}

function propertyNameText(name: ts.PropertyName | ts.BindingName | undefined): string | null {
  if (!name) return null;
  if (ts.isIdentifier(name)) return name.text;
  if (ts.isStringLiteralLike(name)) return name.text;
  if (ts.isNumericLiteral(name)) return name.text;
  return null;
}

function isBeforeBreadcrumbName(name: ts.PropertyName | ts.BindingName | undefined): boolean {
  return propertyNameText(name) === 'beforeBreadcrumb';
}

function hookBodyFromDeclaration(node: ts.Node): ts.ConciseBody | ts.Block | null {
  if (ts.isFunctionDeclaration(node) && node.name?.text === 'beforeBreadcrumb') {
    return node.body ?? null;
  }

  if (ts.isMethodDeclaration(node) && isBeforeBreadcrumbName(node.name)) {
    return node.body ?? null;
  }

  if (
    ts.isPropertyAssignment(node) &&
    isBeforeBreadcrumbName(node.name) &&
    (ts.isFunctionExpression(node.initializer) || ts.isArrowFunction(node.initializer))
  ) {
    return node.initializer.body;
  }

  if (
    ts.isVariableDeclaration(node) &&
    isBeforeBreadcrumbName(node.name) &&
    node.initializer &&
    (ts.isFunctionExpression(node.initializer) || ts.isArrowFunction(node.initializer))
  ) {
    return node.initializer.body;
  }

  return null;
}

function collectHookBodies(sourceFile: ts.SourceFile): Array<ts.ConciseBody | ts.Block> {
  const hooks: Array<ts.ConciseBody | ts.Block> = [];

  const visit = (node: ts.Node): void => {
    const body = hookBodyFromDeclaration(node);
    if (body) {
      hooks.push(body);
      return;
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return hooks;
}

function stripExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isTypeAssertionExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function isBreadcrumbDataAccess(node: ts.Node): boolean {
  if (!ts.isPropertyAccessExpression(node)) return false;
  return node.name.text === 'data' && ts.isIdentifier(node.expression) && node.expression.text === 'breadcrumb';
}

function isBreadcrumbCategoryAccess(node: ts.Node): boolean {
  if (!ts.isPropertyAccessExpression(node)) return false;
  return node.name.text === 'category' && ts.isIdentifier(node.expression) && node.expression.text === 'breadcrumb';
}

function logCategoryFromStrictEquality(test: ts.Expression): string | null {
  const expression = stripExpression(test);
  if (!ts.isBinaryExpression(expression)) return null;
  if (expression.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsEqualsToken) return null;

  const left = stripExpression(expression.left);
  const right = stripExpression(expression.right);

  if (isBreadcrumbCategoryAccess(left) && ts.isStringLiteralLike(right) && LOG_CATEGORIES.has(right.text)) {
    return right.text;
  }

  if (isBreadcrumbCategoryAccess(right) && ts.isStringLiteralLike(left) && LOG_CATEGORIES.has(left.text)) {
    return left.text;
  }

  return null;
}

function logCategoryFromStartsWith(test: ts.Expression): string | null {
  const expression = stripExpression(test);
  if (!ts.isCallExpression(expression)) return null;

  const callTarget = stripExpression(expression.expression);
  if (!ts.isPropertyAccessExpression(callTarget)) return null;
  if (callTarget.name.text !== 'startsWith') return null;
  if (!isBreadcrumbCategoryAccess(stripExpression(callTarget.expression))) return null;

  const prefix = expression.arguments[0];
  if (!prefix || !ts.isStringLiteralLike(prefix)) return null;
  if (
    prefix.text !== 'log' &&
    prefix.text !== 'log.' &&
    prefix.text !== 'renderer.log' &&
    prefix.text !== 'renderer.log.'
  ) {
    return null;
  }
  return prefix.text;
}

function logCategoryFromTest(test: ts.Expression): string | null {
  const expression = stripExpression(test);

  if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.BarBarToken) {
    return logCategoryFromTest(expression.left) ?? logCategoryFromTest(expression.right);
  }

  return logCategoryFromStrictEquality(expression) ?? logCategoryFromStartsWith(expression);
}

function containsNode(root: ts.Node, predicate: (node: ts.Node) => boolean): boolean {
  if (predicate(root)) return true;
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (predicate(node)) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(root, visit);
  return found;
}

function collectNodes<T extends ts.Node>(
  root: ts.Node,
  predicate: (node: ts.Node) => node is T,
): T[] {
  const nodes: T[] = [];
  const visit = (node: ts.Node): void => {
    if (predicate(node)) nodes.push(node);
    ts.forEachChild(node, visit);
  };
  visit(root);
  return nodes;
}

function isWithin(node: ts.Node, ancestor: ts.Node): boolean {
  let current: ts.Node | undefined = node;
  while (current) {
    if (current === ancestor) return true;
    current = current.parent;
  }
  return false;
}

function callName(call: ts.CallExpression): string | null {
  const expression = stripExpression(call.expression);
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  return null;
}

function containsBreadcrumbData(root: ts.Node): boolean {
  return containsNode(root, isBreadcrumbDataAccess);
}

function isRedactLogBreadcrumbDataCallWithBreadcrumbData(node: ts.Node): node is ts.CallExpression {
  if (!ts.isCallExpression(node)) return false;
  if (callName(node) !== 'redactLogBreadcrumbData') return false;
  return node.arguments.some(containsBreadcrumbData);
}

function assignmentTargetForExpression(expression: ts.Expression): ts.Expression | null {
  let current: ts.Node = expression;
  while (
    current.parent &&
    (ts.isAsExpression(current.parent) ||
      ts.isSatisfiesExpression(current.parent) ||
      ts.isParenthesizedExpression(current.parent) ||
      ts.isNonNullExpression(current.parent) ||
      ts.isTypeAssertionExpression(current.parent))
  ) {
    current = current.parent;
  }

  if (
    current.parent &&
    ts.isBinaryExpression(current.parent) &&
    current.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    current.parent.right === current
  ) {
    return current.parent.left;
  }

  return null;
}

function assignmentTargetForScrubResult(expression: ts.Expression): ts.Expression | null {
  let current: ts.Node = expression;

  while (current.parent) {
    const parent = current.parent;

    if (
      ts.isAsExpression(parent) ||
      ts.isSatisfiesExpression(parent) ||
      ts.isParenthesizedExpression(parent) ||
      ts.isNonNullExpression(parent) ||
      ts.isTypeAssertionExpression(parent)
    ) {
      current = parent;
      continue;
    }

    if (
      ts.isConditionalExpression(parent) &&
      (parent.whenTrue === current || parent.whenFalse === current)
    ) {
      current = parent;
      continue;
    }

    if (
      ts.isBinaryExpression(parent) &&
      parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      parent.right === current
    ) {
      return parent.left;
    }

    return null;
  }

  return null;
}

function isRedactLogBreadcrumbDataFlowToBreadcrumbData(node: ts.Node): node is ts.CallExpression {
  if (!isRedactLogBreadcrumbDataCallWithBreadcrumbData(node)) return false;
  const assignmentTarget = assignmentTargetForScrubResult(node);
  return assignmentTarget !== null && containsBreadcrumbData(assignmentTarget);
}

function isBreadcrumbDataGenericRedactorCall(node: ts.Node): node is ts.CallExpression {
  if (!ts.isCallExpression(node)) return false;
  if (callName(node) !== 'redactObjectDeep') return false;
  if (node.arguments.some(containsBreadcrumbData)) return true;

  const assignmentTarget = assignmentTargetForExpression(node);
  return assignmentTarget ? containsBreadcrumbData(assignmentTarget) : false;
}

function isAttachLogBreadcrumbDataSink(node: ts.Node): node is ts.CallExpression {
  // attachLogBreadcrumbData(breadcrumb, redactLogBreadcrumbData(breadcrumb.data ...))
  // is the branded-seam equivalent of `breadcrumb.data = redactLogBreadcrumbData(...)`:
  // the attach helper only accepts SafeTelemetryBreadcrumbData, so the redact call
  // is required by the type system to be the producer.
  if (!ts.isCallExpression(node)) return false;
  if (callName(node) !== 'attachLogBreadcrumbData') return false;
  return node.arguments.some((argument) =>
    containsNode(argument, isRedactLogBreadcrumbDataCallWithBreadcrumbData),
  );
}

function isAllowlistedSink(node: ts.Node): boolean {
  if (ts.isDeleteExpression(node) && isBreadcrumbDataAccess(stripExpression(node.expression))) {
    return true;
  }

  if (isRedactLogBreadcrumbDataFlowToBreadcrumbData(node)) {
    return true;
  }

  if (isAttachLogBreadcrumbDataSink(node)) {
    return true;
  }

  if (isBreadcrumbDataAssignment(node)) {
    return containsNode(node.right, isRedactLogBreadcrumbDataFlowToBreadcrumbData);
  }

  return false;
}

function isBreadcrumbDataAssignment(node: ts.Node): node is ts.BinaryExpression {
  return (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    isBreadcrumbDataAccess(stripExpression(node.left))
  );
}

function collectLogBranches(root: ts.Node): LogBranch[] {
  const branches: LogBranch[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isIfStatement(node)) {
      const category = logCategoryFromTest(node.expression);
      if (category) {
        branches.push({
          category,
          test: node.expression,
          logBranch: node.thenStatement,
          nonLogBranch: node.elseStatement ?? null,
        });
      }
    }

    if (ts.isConditionalExpression(node)) {
      const category = logCategoryFromTest(node.condition);
      if (category) {
        branches.push({
          category,
          test: node.condition,
          logBranch: node.whenTrue,
          nonLogBranch: node.whenFalse,
        });
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(root);
  return branches;
}

function lineColumn(sourceFile: ts.SourceFile, node: ts.Node): Pick<BreadcrumbScrubViolation, 'line' | 'column'> {
  const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return { line: position.line + 1, column: position.character + 1 };
}

function makeViolation(
  sourceFile: ts.SourceFile,
  filePath: string,
  node: ts.Node,
  problem: string,
  fix: string,
): BreadcrumbScrubViolation {
  return {
    filePath,
    ...lineColumn(sourceFile, node),
    problem,
    fix,
  };
}

export function analyzeBreadcrumbHookSource(
  source: string,
  filePath: string,
  knownHooks: readonly string[] = KNOWN_BREADCRUMB_HOOKS,
): BreadcrumbHookAnalysisResult {
  const normalizedPath = normalizePath(filePath);
  const knownHookSet = new Set(knownHooks.map(normalizePath));
  const sourceFile = createSourceFile(source, normalizedPath);
  const hookBodies = collectHookBodies(sourceFile);
  const violations: BreadcrumbScrubViolation[] = [];

  if (hookBodies.length > 0 && !knownHookSet.has(normalizedPath)) {
    violations.push({
      filePath: normalizedPath,
      line: 1,
      column: 1,
      problem: `Found beforeBreadcrumb hook in an unclassified file: ${normalizedPath}.`,
      fix: `Add this file to KNOWN_BREADCRUMB_HOOKS in scripts/check-sentry-breadcrumb-scrub.ts and make the log breadcrumb scrub path explicit.`,
    });
    return { filePath: normalizedPath, hooksFound: hookBodies.length, violations };
  }

  if (knownHookSet.has(normalizedPath) && hookBodies.length === 0) {
    violations.push({
      filePath: normalizedPath,
      line: 1,
      column: 1,
      problem: `KNOWN_BREADCRUMB_HOOKS lists ${normalizedPath}, but no beforeBreadcrumb hook definition was found.`,
      fix: `Update KNOWN_BREADCRUMB_HOOKS if the hook moved, or restore the beforeBreadcrumb guard in this file.`,
    });
    return { filePath: normalizedPath, hooksFound: 0, violations };
  }

  for (const body of hookBodies) {
    const logBranches = collectLogBranches(body);
    const genericRedactorCalls = collectNodes(body, isBreadcrumbDataGenericRedactorCall);
    const dataAssignments = collectNodes(body, isBreadcrumbDataAssignment);

    if (logBranches.length === 0 && (genericRedactorCalls.length > 0 || dataAssignments.length > 0)) {
      violations.push(
        makeViolation(
          sourceFile,
          normalizedPath,
          genericRedactorCalls[0] ?? dataAssignments[0] ?? body,
          'This beforeBreadcrumb hook handles breadcrumb.data without a log-category guard.',
          'Branch on breadcrumb.category for log/renderer.log before assigning breadcrumb.data; use redactLogBreadcrumbData(...) or delete breadcrumb.data on the log branch.',
        ),
      );
      continue;
    }

    for (const branch of logBranches) {
      if (!containsNode(branch.logBranch, isAllowlistedSink)) {
        violations.push(
          makeViolation(
            sourceFile,
            normalizedPath,
            branch.test,
            `The ${branch.category} breadcrumb branch does not clearly use an allowlisted breadcrumb.data sink.`,
            'Route the log branch through redactLogBreadcrumbData(breadcrumb.data as Record<string, unknown>) or delete breadcrumb.data.',
          ),
        );
      }
    }

    for (const call of genericRedactorCalls) {
      const insideNonLogBranch = logBranches.some(
        (branch) => branch.nonLogBranch !== null && isWithin(call, branch.nonLogBranch),
      );
      const insideLogBranch = logBranches.some((branch) => isWithin(call, branch.logBranch));

      if (!insideNonLogBranch || insideLogBranch) {
        violations.push(
          makeViolation(
            sourceFile,
            normalizedPath,
            call,
            'redactObjectDeep(...) is applied to breadcrumb.data outside a clearly non-log branch.',
            'Keep redactObjectDeep(...) only in the else/non-log branch; use redactLogBreadcrumbData(...) or delete breadcrumb.data for log breadcrumbs.',
          ),
        );
      }
    }

    for (const assignment of dataAssignments) {
      const insideLogBranch = logBranches.some((branch) => isWithin(assignment, branch.logBranch));
      if (insideLogBranch && !containsNode(assignment.right, isAllowlistedSink)) {
        violations.push(
          makeViolation(
            sourceFile,
            normalizedPath,
            assignment,
            'breadcrumb.data is assigned inside a log branch without the sanctioned allowlist scrubber.',
            'Use redactLogBreadcrumbData(...) for assigned log breadcrumb data, or delete breadcrumb.data in renderer-only log branches.',
          ),
        );
      }
    }
  }

  return { filePath: normalizedPath, hooksFound: hookBodies.length, violations };
}

function extensionOf(filePath: string): string {
  const dot = filePath.lastIndexOf('.');
  return dot === -1 ? '' : filePath.slice(dot);
}

function discoverSourceFiles(rootDir: string): string[] {
  const files: string[] = [];

  const walk = (absoluteDir: string): void => {
    for (const entry of readdirSync(absoluteDir)) {
      if (SKIP_DIRS.has(entry)) continue;

      const absolutePath = resolve(absoluteDir, entry);
      const stat = statSync(absolutePath);
      if (stat.isDirectory()) {
        walk(absolutePath);
        continue;
      }
      if (!stat.isFile()) continue;
      if (!SOURCE_EXTENSIONS.has(extensionOf(entry))) continue;

      files.push(normalizePath(relative(rootDir, absolutePath)));
    }
  };

  walk(rootDir);
  return files.sort();
}

// The brand constructor must stay confined to the sanctioned sanitizer modules:
// any other importer could bless unsanitized data into SafeTelemetryBreadcrumbData
// and silently defeat the branded attach seam. Tests are exempt (they exercise the
// seam itself). Defining module is implicitly allowed (it is not an importer).
const BRAND_HELPER_NAME = 'brandSanitizedLogBreadcrumbData';
const BRAND_HELPER_ALLOWED_IMPORTERS = new Set(
  ['src/core/utils/logFieldFilter.ts', 'mobile/src/utils/logFilter.ts'].map(normalizePath),
);

export function collectBrandImportViolations(
  files: ReadonlyArray<{ filePath: string; source: string }>,
): BreadcrumbScrubViolation[] {
  const violations: BreadcrumbScrubViolation[] = [];
  for (const { filePath, source } of files) {
    const normalizedPath = normalizePath(filePath);
    if (BRAND_HELPER_ALLOWED_IMPORTERS.has(normalizedPath)) continue;
    if (/(^|\/)__tests__\//.test(normalizedPath) || /\.test\.tsx?$/.test(normalizedPath)) continue;
    if (normalizedPath.endsWith('/safeTelemetryBreadcrumbData.ts')) continue;
    if (!source.includes(BRAND_HELPER_NAME)) continue;

    const sourceFile = createSourceFile(source, normalizedPath);
    sourceFile.forEachChild((node) => {
      if (!ts.isImportDeclaration(node)) return;
      const namedBindings = node.importClause?.namedBindings;
      if (!namedBindings || !ts.isNamedImports(namedBindings)) return;
      for (const element of namedBindings.elements) {
        if ((element.propertyName ?? element.name).text !== BRAND_HELPER_NAME) continue;
        violations.push(
          makeViolation(
            sourceFile,
            normalizedPath,
            element,
            `${BRAND_HELPER_NAME} imported outside the sanctioned sanitizer modules.`,
            `Only ${[...BRAND_HELPER_ALLOWED_IMPORTERS].join(', ')} may import the brand constructor; produce SafeTelemetryBreadcrumbData via redactLogBreadcrumbData(...) instead, or extend BRAND_HELPER_ALLOWED_IMPORTERS for a new sanctioned sanitizer.`,
          ),
        );
      }
    });
  }
  return violations;
}

function analyzeRealHooks(): BreadcrumbHookAnalysisResult[] {
  const discoveredHookFiles = new Set<string>();
  const brandImportCandidates: Array<{ filePath: string; source: string }> = [];

  for (const root of SCAN_ROOTS) {
    const absoluteRoot = resolve(REPO_ROOT, root);
    if (!existsSync(absoluteRoot)) continue;
    for (const relativeFile of discoverSourceFiles(absoluteRoot)) {
      const repoRelativeFile = normalizePath(`${root}/${relativeFile}`);
      const source = readFileSync(resolve(REPO_ROOT, repoRelativeFile), 'utf8');
      const sourceFile = createSourceFile(source, repoRelativeFile);
      if (collectHookBodies(sourceFile).length > 0) {
        discoveredHookFiles.add(repoRelativeFile);
      }
      if (source.includes(BRAND_HELPER_NAME)) {
        brandImportCandidates.push({ filePath: repoRelativeFile, source });
      }
    }
  }

  const brandViolations = collectBrandImportViolations(brandImportCandidates);

  const filesToAnalyze = new Set<string>([
    ...KNOWN_BREADCRUMB_HOOKS.map(normalizePath),
    ...discoveredHookFiles,
  ]);

  const hookResults = [...filesToAnalyze].sort().map((filePath) => {
    const absolutePath = resolve(REPO_ROOT, filePath);
    if (!existsSync(absolutePath)) {
      return {
        filePath,
        hooksFound: 0,
        violations: [
          {
            filePath,
            line: 1,
            column: 1,
            problem: `Known beforeBreadcrumb hook file does not exist: ${filePath}.`,
            fix: 'Update KNOWN_BREADCRUMB_HOOKS if the hook moved, or restore the expected Sentry breadcrumb hook file.',
          },
        ],
      };
    }

    return analyzeBreadcrumbHookSource(readFileSync(absolutePath, 'utf8'), filePath);
  });

  if (brandViolations.length > 0) {
    hookResults.push({ filePath: 'brand-import-allowlist', hooksFound: 0, violations: brandViolations });
  }

  return hookResults;
}

function formatViolation(violation: BreadcrumbScrubViolation): string {
  return [
    `${violation.filePath}:${violation.line}:${violation.column}`,
    `Invariant: ${INVARIANT}`,
    `PM: ${PM_REFERENCE}`,
    `Problem: ${violation.problem}`,
    `Fix: ${violation.fix}`,
  ].join('\n');
}

function main(): void {
  const results = analyzeRealHooks();
  const violations = results.flatMap((result) => result.violations);

  if (violations.length > 0) {
    console.error(
      [
        `[sentry-breadcrumb-scrub] ERROR: ${violations.length} violation(s) found.`,
        '',
        ...violations.map(formatViolation),
      ].join('\n\n'),
    );
    process.exit(1);
  }

  const hooksChecked = results.reduce((count, result) => count + result.hooksFound, 0);
  console.log(
    `[sentry-breadcrumb-scrub] OK: ${hooksChecked} hooks checked, all log breadcrumbs use the allowlist/delete path.`,
  );
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main();
}
