#!/usr/bin/env npx tsx
/**
 * CI guard: Super-MCP startup entry points must use the retry-aware wrapper.
 *
 * Why: postmortem 251209_super_mcp_cache_corruption_recovery_partial_wiring
 * (prevention rec fingerprint 78c05d2721a6054f) left us with one invariant:
 * once `startSuperMcpWithRetries` / instance `startWithRetries` exists, every
 * external startup entry point must route through that wrapper. The deprecated
 * public `SuperMcpHttpManager.start()` method must only be reached by the
 * wrapper or the manager's own internal retry/restart machinery; a bare
 * `superMcpHttpManager.start()` bypasses retries, circuit breaker checks, port
 * reselection, and background recovery.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as ts from 'typescript';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MANAGER_FILE_PATH = 'src/core/services/superMcpHttpManager.ts';
const SINGLETON_EXPORT_NAME = 'superMcpHttpManager';
const WRAPPER_NAME = 'startSuperMcpWithRetries';
const POSTMORTEM_ID = '251209_super_mcp_cache_corruption_recovery_partial_wiring';

export interface SourceInput {
  readonly filePath: string;
  readonly sourceText: string;
}

export interface SuperMcpSingleStartupPathAllowlistEntry {
  readonly filePath: string;
  /** Stable marker: enclosing function name, IPC channel, or exact call context string. */
  readonly marker: string;
  readonly rationale: string;
}

/**
 * Deliberate external raw starts. This should stay empty unless a maintainer
 * documents an exceptional reason to bypass retry/recovery startup.
 */
export const DEFAULT_SUPER_MCP_SINGLE_STARTUP_PATH_ALLOWLIST: readonly SuperMcpSingleStartupPathAllowlistEntry[] = [];

export type GuardFailureKind =
  | 'unallowlisted_external_start'
  | 'stale_allowlist_entry'
  | 'duplicate_allowlist_entry'
  | 'missing_manager_file'
  | 'missing_singleton_export';

export interface GuardFailure {
  readonly kind: GuardFailureKind;
  readonly filePath: string;
  readonly detail: string;
  readonly remediation: string;
}

export interface SuperMcpStartOccurrence {
  readonly filePath: string;
  readonly line: number;
  readonly receiverText: string;
  readonly markers: readonly string[];
  readonly matchedAllowlistIndex: number | null;
}

export interface GuardResult {
  readonly failed: boolean;
  readonly failures: readonly GuardFailure[];
  readonly occurrences: readonly SuperMcpStartOccurrence[];
  readonly scannedFiles: number;
}

function normalizeRelativePath(filePath: string, root = REPO_ROOT): string {
  const normalized = filePath.replaceAll('\\', '/');
  const normalizedRoot = root.replaceAll('\\', '/').replace(/\/+$/, '');
  if (path.isAbsolute(filePath) && normalized.startsWith(`${normalizedRoot}/`)) {
    return normalized.slice(normalizedRoot.length + 1);
  }
  return normalized.replace(/^\.?\//, '');
}

function isProductionTsSource(relativePath: string): boolean {
  const normalized = relativePath.replaceAll('\\', '/');
  if (!normalized.startsWith('src/main/') && !normalized.startsWith('src/core/')) return false;
  if (!/\.(ts|tsx)$/.test(normalized)) return false;
  if (normalized.includes('/__tests__/')) return false;
  if (normalized.includes('/dist/')) return false;
  if (/(^|\.)(test|spec)\.tsx?$/.test(normalized)) return false;
  return true;
}

function collectScanSources(root: string): SourceInput[] {
  const sources: SourceInput[] = [];

  function walk(current: string, relativeRoot: string): void {
    if (!fs.existsSync(current)) return;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolutePath = path.join(current, entry.name);
      const relativePath = normalizeRelativePath(path.join(relativeRoot, entry.name), root);
      if (entry.isDirectory()) {
        if (entry.name === '__tests__' || entry.name === 'dist' || entry.name === 'node_modules') continue;
        walk(absolutePath, path.join(relativeRoot, entry.name));
        continue;
      }
      if (!isProductionTsSource(relativePath)) continue;
      sources.push({
        filePath: relativePath,
        sourceText: fs.readFileSync(absolutePath, 'utf8'),
      });
    }
  }

  walk(path.join(root, 'src', 'core'), 'src/core');
  walk(path.join(root, 'src', 'main'), 'src/main');

  return sources.sort((a, b) => a.filePath.localeCompare(b.filePath));
}

function createSourceFile(filePath: string, sourceText: string): ts.SourceFile {
  return ts.createSourceFile(
    filePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    filePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

function isSuperMcpManagerModule(moduleSpecifier: string): boolean {
  return moduleSpecifier === '@core/services/superMcpHttpManager'
    || moduleSpecifier === '@main/services/superMcpHttpManager'
    || moduleSpecifier.replaceAll('\\', '/').endsWith('/superMcpHttpManager');
}

function importString(node: ts.ImportDeclaration): string | null {
  const moduleSpecifier = node.moduleSpecifier;
  if (ts.isStringLiteral(moduleSpecifier)) return moduleSpecifier.text;
  return null;
}

function bindingNameText(name: ts.BindingName | ts.PropertyName | undefined): string | null {
  if (!name) return null;
  if (ts.isIdentifier(name)) return name.text;
  if (ts.isStringLiteral(name)) return name.text;
  return null;
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current)
    || ts.isAsExpression(current)
    || ts.isTypeAssertionExpression(current)
    || ts.isNonNullExpression(current)
    || ts.isSatisfiesExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function isSingletonNamespaceAccess(
  expression: ts.Expression,
  namespaceBindings: ReadonlySet<string>,
): boolean {
  const unwrapped = unwrapExpression(expression);
  return ts.isPropertyAccessExpression(unwrapped)
    && unwrapped.name.text === SINGLETON_EXPORT_NAME
    && ts.isIdentifier(unwrapExpression(unwrapped.expression))
    && namespaceBindings.has((unwrapExpression(unwrapped.expression) as ts.Identifier).text);
}

function collectSingletonBindings(sourceFile: ts.SourceFile, filePath: string): {
  readonly directBindings: Set<string>;
  readonly namespaceBindings: Set<string>;
} {
  const directBindings = new Set<string>();
  const namespaceBindings = new Set<string>();

  if (normalizeRelativePath(filePath) === MANAGER_FILE_PATH) {
    directBindings.add(SINGLETON_EXPORT_NAME);
  }

  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const moduleSpecifier = importString(statement);
    if (!moduleSpecifier || !isSuperMcpManagerModule(moduleSpecifier)) continue;

    const importClause = statement.importClause;
    if (!importClause) continue;
    if (importClause.name?.text === SINGLETON_EXPORT_NAME) {
      directBindings.add(importClause.name.text);
    }

    const namedBindings = importClause.namedBindings;
    if (!namedBindings) continue;
    if (ts.isNamespaceImport(namedBindings)) {
      namespaceBindings.add(namedBindings.name.text);
      continue;
    }

    for (const element of namedBindings.elements) {
      const importedName = element.propertyName?.text ?? element.name.text;
      if (importedName === SINGLETON_EXPORT_NAME) {
        directBindings.add(element.name.text);
      }
    }
  }

  function visit(node: ts.Node): void {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const initializer = unwrapExpression(node.initializer);
      if (
        (ts.isIdentifier(initializer) && directBindings.has(initializer.text))
        || isSingletonNamespaceAccess(initializer, namespaceBindings)
      ) {
        directBindings.add(node.name.text);
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return { directBindings, namespaceBindings };
}

function receiverMatchesSingleton(
  receiver: ts.Expression,
  directBindings: ReadonlySet<string>,
  namespaceBindings: ReadonlySet<string>,
): boolean {
  const unwrapped = unwrapExpression(receiver);
  if (ts.isIdentifier(unwrapped)) return directBindings.has(unwrapped.text);
  return isSingletonNamespaceAccess(unwrapped, namespaceBindings);
}

function enclosingFunctionName(node: ts.Node): string | null {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (ts.isFunctionDeclaration(current) || ts.isMethodDeclaration(current)) {
      return bindingNameText(current.name);
    }
    if (ts.isFunctionExpression(current) || ts.isArrowFunction(current)) {
      const parent = current.parent;
      if (ts.isVariableDeclaration(parent)) {
        return bindingNameText(parent.name);
      }
      if (ts.isPropertyAssignment(parent)) {
        return bindingNameText(parent.name);
      }
    }
    current = current.parent;
  }
  return null;
}

function collectRegisterHandlerChannels(node: ts.Node): string[] {
  const channels: string[] = [];
  let current: ts.Node | undefined = node;
  while (current) {
    if (ts.isCallExpression(current)) {
      const expression = current.expression;
      const calleeName = ts.isIdentifier(expression)
        ? expression.text
        : ts.isPropertyAccessExpression(expression)
          ? expression.name.text
          : null;
      if (calleeName === 'registerHandler' && current.arguments[0]) {
        const firstArg = current.arguments[0];
        if (ts.isStringLiteral(firstArg) || ts.isNoSubstitutionTemplateLiteral(firstArg)) {
          channels.push(firstArg.text);
        }
      }
    }
    current = current.parent;
  }
  return channels;
}

function occurrenceMarkers(node: ts.Node, sourceFile: ts.SourceFile, receiver: ts.Expression): string[] {
  const markers = new Set<string>();
  const fnName = enclosingFunctionName(node);
  if (fnName) markers.add(fnName);
  for (const channel of collectRegisterHandlerChannels(node)) {
    markers.add(channel);
  }
  markers.add(`${receiver.getText(sourceFile)}.start`);
  return [...markers];
}

function findExternalStartOccurrences(filePath: string, sourceText: string): SuperMcpStartOccurrence[] {
  const sourceFile = createSourceFile(filePath, sourceText);
  const { directBindings, namespaceBindings } = collectSingletonBindings(sourceFile, filePath);
  if (directBindings.size === 0 && namespaceBindings.size === 0) return [];

  const occurrences: SuperMcpStartOccurrence[] = [];

  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const propertyAccess = node.expression;
      if (
        propertyAccess.name.text === 'start'
        && receiverMatchesSingleton(propertyAccess.expression, directBindings, namespaceBindings)
      ) {
        const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
        occurrences.push({
          filePath,
          line: line + 1,
          receiverText: propertyAccess.expression.getText(sourceFile),
          markers: occurrenceMarkers(node, sourceFile, propertyAccess.expression),
          matchedAllowlistIndex: null,
        });
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return occurrences;
}

function hasSingletonExport(sourceText: string): boolean {
  const sourceFile = createSourceFile(MANAGER_FILE_PATH, sourceText);
  let found = false;

  function visit(node: ts.Node): void {
    if (
      ts.isVariableStatement(node)
      && node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
      && node.declarationList.declarations.some((declaration) => (
        ts.isIdentifier(declaration.name)
        && declaration.name.text === SINGLETON_EXPORT_NAME
        && declaration.initializer !== undefined
        && ts.isNewExpression(declaration.initializer)
        && ts.isIdentifier(declaration.initializer.expression)
        && declaration.initializer.expression.text === 'SuperMcpHttpManager'
      ))
    ) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return found;
}

function ensureStructureInvariant(sourceInputs: readonly SourceInput[], root: string): GuardFailure[] {
  const managerSource = sourceInputs.find(
    (input) => normalizeRelativePath(input.filePath, root) === MANAGER_FILE_PATH,
  );

  if (!managerSource) {
    return [
      {
        kind: 'missing_manager_file',
        filePath: MANAGER_FILE_PATH,
        detail: 'The canonical Super-MCP manager file was not found in the scan set.',
        remediation:
          'Update scripts/check-supermcp-single-startup-path.ts to the new manager location before allowing validate:fast to pass.',
      },
    ];
  }

  if (!hasSingletonExport(managerSource.sourceText)) {
    return [
      {
        kind: 'missing_singleton_export',
        filePath: MANAGER_FILE_PATH,
        detail:
          `Could not find \`export const ${SINGLETON_EXPORT_NAME} = new SuperMcpHttpManager()\`.`,
        remediation:
          'Update this guard to the new singleton construction before allowing validate:fast to pass.',
      },
    ];
  }

  return [];
}

function allowlistMatches(
  entry: SuperMcpSingleStartupPathAllowlistEntry,
  filePath: string,
  markers: readonly string[],
): boolean {
  if (normalizeRelativePath(entry.filePath) !== normalizeRelativePath(filePath)) return false;
  return markers.includes(entry.marker);
}

function ensureAllowlistIntegrity(
  allowlist: readonly SuperMcpSingleStartupPathAllowlistEntry[],
): GuardFailure[] {
  const failures: GuardFailure[] = [];
  const seen = new Set<string>();

  for (const entry of allowlist) {
    const key = `${normalizeRelativePath(entry.filePath)}::${entry.marker}`;
    if (seen.has(key)) {
      failures.push({
        kind: 'duplicate_allowlist_entry',
        filePath: normalizeRelativePath(entry.filePath),
        detail: `Allowlist entry "${entry.marker}" is registered more than once.`,
        remediation:
          'Keep exactly one allowlist entry per deliberate external raw start in scripts/check-supermcp-single-startup-path.ts.',
      });
    }
    seen.add(key);
  }

  return failures;
}

export function checkSuperMcpSingleStartupPath(options: {
  readonly repoRoot?: string;
  readonly allowlist?: readonly SuperMcpSingleStartupPathAllowlistEntry[];
  readonly sourceInputs?: readonly SourceInput[];
} = {}): GuardResult {
  const root = options.repoRoot ?? REPO_ROOT;
  const allowlist = options.allowlist ?? DEFAULT_SUPER_MCP_SINGLE_STARTUP_PATH_ALLOWLIST;
  const sourceInputs = options.sourceInputs ?? collectScanSources(root);
  const failures: GuardFailure[] = [
    ...ensureStructureInvariant(sourceInputs, root),
    ...ensureAllowlistIntegrity(allowlist),
  ];

  const allOccurrences: SuperMcpStartOccurrence[] = [];
  const matchedAllowlistIndices = new Set<number>();

  for (const input of sourceInputs) {
    const filePath = normalizeRelativePath(input.filePath, root);
    if (!isProductionTsSource(filePath)) continue;

    const fileOccurrences = findExternalStartOccurrences(filePath, input.sourceText);

    for (const occurrence of fileOccurrences) {
      let matchedIndex: number | null = null;
      for (let index = 0; index < allowlist.length; index += 1) {
        if (allowlistMatches(allowlist[index]!, filePath, occurrence.markers)) {
          matchedIndex = index;
          matchedAllowlistIndices.add(index);
          break;
        }
      }

      const recorded: SuperMcpStartOccurrence = {
        ...occurrence,
        matchedAllowlistIndex: matchedIndex,
      };
      allOccurrences.push(recorded);

      if (matchedIndex === null) {
        failures.push({
          kind: 'unallowlisted_external_start',
          filePath,
          detail:
            `External \`${occurrence.receiverText}.start(...)\` call at line ${occurrence.line} ` +
            `(markers: ${occurrence.markers.join(', ') || 'none'}). ` +
            `Bare starts bypass ${WRAPPER_NAME}, retries, circuit breaker checks, and recovery wiring.`,
          remediation:
            `Route startup through ${WRAPPER_NAME} (or the instance startWithRetries wrapper). ` +
            'If this bypass is truly intentional, add an allowlist entry with a stable marker and rationale.',
        });
      }
    }
  }

  for (let index = 0; index < allowlist.length; index += 1) {
    if (!matchedAllowlistIndices.has(index)) {
      const entry = allowlist[index]!;
      failures.push({
        kind: 'stale_allowlist_entry',
        filePath: normalizeRelativePath(entry.filePath),
        detail:
          `Allowlist entry "${entry.marker}" no longer matches any scanned \`${SINGLETON_EXPORT_NAME}.start(...)\` callsite.`,
        remediation:
          'Remove the stale allowlist entry or update its file/marker to match the live callsite.',
      });
    }
  }

  return {
    failed: failures.length > 0,
    failures,
    occurrences: allOccurrences,
    scannedFiles: sourceInputs.filter((input) => isProductionTsSource(normalizeRelativePath(input.filePath, root))).length,
  };
}

export function formatGuardResult(result: GuardResult): string {
  if (!result.failed) {
    return [
      'Super-MCP single startup path guard passed.',
      `Scanned ${result.scannedFiles} production TypeScript files in src/core and src/main.`,
      `External raw ${SINGLETON_EXPORT_NAME}.start(...) call sites: ${result.occurrences.length}.`,
    ].join('\n');
  }

  const lines = [
    'Super-MCP single startup path guard FAILED.',
    `External startup entry points must route through ${WRAPPER_NAME}; deprecated raw start() is internal-only.`,
    `Postmortem: ${POSTMORTEM_ID}`,
  ];

  for (const failure of result.failures) {
    lines.push(`✘ ${failure.filePath}: ${failure.detail}`);
    lines.push(`  Fix: ${failure.remediation}`);
  }

  return lines.join('\n');
}

export function runCli(): number {
  const result = checkSuperMcpSingleStartupPath();
  const report = formatGuardResult(result);
  if (result.failed) {
    process.stderr.write(`${report}\n`);
    return 1;
  }
  process.stdout.write(`${report}\n`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(runCli());
}
