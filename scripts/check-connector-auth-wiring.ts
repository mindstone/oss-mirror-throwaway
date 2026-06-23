#!/usr/bin/env npx tsx
/**
 * Validates that connector-catalog `bundledConfig.authApi` values are wired
 * to production startup auth orchestration.
 *
 * The bug class this prevents: a connector advertises an auth API, its setup
 * tool returns the structured `auth_required` envelope, but app startup never
 * registers the host-side orchestrator that handles that envelope.
 *
 * Run via: npx tsx scripts/check-connector-auth-wiring.ts
 * Wired into: npm run validate:fast
 *
 * @see docs-private/postmortems/260529_slack_oss_stage7_auth_and_workspace_migration_gaps_postmortem.md
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ts from 'typescript';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.join(__dirname, '..');
const CATALOG_PATH = path.join(REPO_ROOT, 'resources', 'connector-catalog.json');
const MAIN_STARTUP_PATH = path.join(REPO_ROOT, 'src', 'main', 'index.ts');

export interface CatalogAuthApiUsage {
  readonly authApi: string;
  readonly connectorIds: readonly string[];
}

export interface StartupAuthRegistration {
  readonly authApi: string;
  readonly startupFunction: string;
  readonly modulePath: string;
  readonly line: number;
}

export interface AuthApiException {
  readonly authApi: string;
  readonly reason: string;
  readonly evidence: readonly string[];
}

export interface AuthApiViolation {
  readonly authApi: string;
  readonly connectorIds: readonly string[];
}

export interface ConnectorAuthWiringResult {
  readonly usages: readonly CatalogAuthApiUsage[];
  readonly registrations: readonly StartupAuthRegistration[];
  readonly exempt: readonly AuthApiException[];
  readonly violations: readonly AuthApiViolation[];
}

interface ImportedBinding {
  readonly importedName: string;
  readonly modulePath: string;
}

interface AnalyzeOptions {
  readonly catalog: unknown;
  readonly startupPath: string;
  readonly readFile: (filePath: string) => string;
  readonly fileExists?: (filePath: string) => boolean;
  readonly exceptions?: readonly AuthApiException[];
}

/**
 * `discourseApi` is intentionally not an `mcpService.registerAuthOrchestrator`
 * key. The Rebel Community Write connector uses a dedicated renderer/main IPC
 * auth flow: the settings UI calls `window.discourseApi.startAuth()`,
 * `registerDiscourseHandlers()` is wired during main startup, and the handler
 * writes the Discourse user API profile plus MCP config entry directly.
 */
export const AUTH_API_EXCEPTIONS: readonly AuthApiException[] = [
  {
    authApi: 'discourseApi',
    reason:
      'Dedicated Discourse IPC auth flow owns browser auth, profile write, and MCP registration; it does not use the structured auth_required orchestrator path.',
    evidence: [
      'src/renderer/features/settings/components/UnifiedConnectionsPanel.tsx',
      'src/main/ipc/discourseHandlers.ts',
      'src/main/index.ts',
    ],
  },
];

export function collectCatalogAuthApiUsages(catalog: unknown): CatalogAuthApiUsage[] {
  if (!isRecord(catalog) || !Array.isArray(catalog.connectors)) {
    throw new Error('connector catalog must have a top-level `connectors` array');
  }

  const connectorIdsByAuthApi = new Map<string, string[]>();

  for (const connector of catalog.connectors) {
    if (!isRecord(connector)) continue;

    const bundledConfig = connector.bundledConfig;
    if (!isRecord(bundledConfig) || typeof bundledConfig.authApi !== 'string') continue;

    const authApi = bundledConfig.authApi.trim();
    if (authApi.length === 0) continue;

    const connectorId = typeof connector.id === 'string' ? connector.id : '<unknown>';
    const connectorIds = connectorIdsByAuthApi.get(authApi) ?? [];
    connectorIds.push(connectorId);
    connectorIdsByAuthApi.set(authApi, connectorIds);
  }

  return [...connectorIdsByAuthApi.entries()]
    .map(([authApi, connectorIds]) => ({ authApi, connectorIds: [...new Set(connectorIds)].sort() }))
    .sort((a, b) => a.authApi.localeCompare(b.authApi));
}

export function collectStartupAuthRegistrations(
  startupPath: string,
  readFile: (filePath: string) => string,
  fileExists: (filePath: string) => boolean = existsSync,
): StartupAuthRegistration[] {
  const startupSource = readFile(startupPath);
  const startupFile = createSourceFile(startupPath, startupSource);
  const importedBindings = collectNamedImports(startupFile, startupPath, fileExists);
  const calledImportedFunctions = collectCalledImportedFunctions(startupFile, importedBindings);
  const registrations: StartupAuthRegistration[] = [];

  for (const [localName, binding] of calledImportedFunctions) {
    const moduleSource = readFile(binding.modulePath);
    const moduleFile = createSourceFile(binding.modulePath, moduleSource);
    const registrationCalls = collectRegisterAuthOrchestratorCallsInFunction(
      moduleFile,
      binding.importedName,
    );

    for (const registrationCall of registrationCalls) {
      registrations.push({
        authApi: registrationCall.authApi,
        startupFunction: localName,
        modulePath: path.relative(REPO_ROOT, binding.modulePath),
        line: registrationCall.line,
      });
    }
  }

  return registrations.sort((a, b) => a.authApi.localeCompare(b.authApi));
}

export function checkConnectorAuthWiring(options: AnalyzeOptions): ConnectorAuthWiringResult {
  const usages = collectCatalogAuthApiUsages(options.catalog);
  const registrations = collectStartupAuthRegistrations(
    options.startupPath,
    options.readFile,
    options.fileExists,
  );
  const registeredAuthApis = new Set(registrations.map((registration) => registration.authApi));
  const exceptionByAuthApi = new Map(
    (options.exceptions ?? AUTH_API_EXCEPTIONS).map((exception) => [exception.authApi, exception]),
  );
  const usedAuthApis = new Set(usages.map((usage) => usage.authApi));

  const exempt = [...exceptionByAuthApi.values()]
    .filter((exception) => usedAuthApis.has(exception.authApi))
    .sort((a, b) => a.authApi.localeCompare(b.authApi));

  const violations = usages
    .filter((usage) => !registeredAuthApis.has(usage.authApi) && !exceptionByAuthApi.has(usage.authApi))
    .map((usage) => ({ authApi: usage.authApi, connectorIds: usage.connectorIds }));

  return { usages, registrations, exempt, violations };
}

function collectNamedImports(
  sourceFile: ts.SourceFile,
  importerPath: string,
  fileExists: (filePath: string) => boolean,
): Map<string, ImportedBinding> {
  const imports = new Map<string, ImportedBinding>();

  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    if (!ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const namedBindings = statement.importClause?.namedBindings;
    if (!namedBindings || !ts.isNamedImports(namedBindings)) continue;

    const modulePath = resolveTsModulePath(importerPath, statement.moduleSpecifier.text, fileExists);
    if (!modulePath) continue;

    for (const element of namedBindings.elements) {
      imports.set(element.name.text, {
        importedName: element.propertyName?.text ?? element.name.text,
        modulePath,
      });
    }
  }

  return imports;
}

function collectCalledImportedFunctions(
  sourceFile: ts.SourceFile,
  importedBindings: Map<string, ImportedBinding>,
): Map<string, ImportedBinding> {
  const called = new Map<string, ImportedBinding>();
  const startupRoots = collectAppWhenReadyThenCallbackBodies(sourceFile);

  for (const root of startupRoots) {
    forEachUnconditionalCall(root, (call) => {
      if (!ts.isIdentifier(call.expression)) return;
      const binding = importedBindings.get(call.expression.text);
      if (binding) {
        called.set(call.expression.text, binding);
      }
    });
  }

  return called;
}

function collectAppWhenReadyThenCallbackBodies(sourceFile: ts.SourceFile): ts.Node[] {
  const bodies: ts.Node[] = [];

  walk(sourceFile, (node) => {
    if (!ts.isCallExpression(node)) return;
    if (!ts.isPropertyAccessExpression(node.expression) || node.expression.name.text !== 'then') return;
    if (!ts.isCallExpression(node.expression.expression)) return;

    const whenReadyCall = node.expression.expression;
    if (!ts.isPropertyAccessExpression(whenReadyCall.expression)) return;
    if (whenReadyCall.expression.name.text !== 'whenReady') return;
    if (!ts.isIdentifier(whenReadyCall.expression.expression) || whenReadyCall.expression.expression.text !== 'app') {
      return;
    }

    const [callback] = node.arguments;
    if (!callback || (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback))) return;
    bodies.push(callback.body);
  });

  return bodies;
}

function collectRegisterAuthOrchestratorCallsInFunction(
  sourceFile: ts.SourceFile,
  functionName: string,
): Array<{ authApi: string; line: number }> {
  const targetBodies: ts.Node[] = [];

  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name?.text === functionName && statement.body) {
      targetBodies.push(statement.body);
    }

    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (
          ts.isIdentifier(declaration.name)
          && declaration.name.text === functionName
          && declaration.initializer
          && (ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer))
          && declaration.initializer.body
        ) {
          targetBodies.push(declaration.initializer.body);
        }
      }
    }
  }

  const calls: Array<{ authApi: string; line: number }> = [];

  for (const body of targetBodies) {
    forEachUnconditionalCall(body, (call) => {
      if (!ts.isIdentifier(call.expression) || call.expression.text !== 'registerAuthOrchestrator') return;

      const [firstArg] = call.arguments;
      if (!firstArg || !ts.isStringLiteral(firstArg)) return;

      const { line } = sourceFile.getLineAndCharacterOfPosition(call.getStart(sourceFile));
      calls.push({ authApi: firstArg.text, line: line + 1 });
    });
  }

  return calls;
}

function resolveTsModulePath(
  importerPath: string,
  specifier: string,
  fileExists: (filePath: string) => boolean,
): string | null {
  if (!specifier.startsWith('.')) return null;

  const basePath = path.resolve(path.dirname(importerPath), specifier);
  const candidates = [
    ...(path.extname(basePath) ? [basePath] : []),
    `${basePath}.ts`,
    `${basePath}.tsx`,
    path.join(basePath, 'index.ts'),
  ];

  return candidates.find((candidate) => fileExists(candidate)) ?? null;
}

function createSourceFile(filePath: string, source: string): ts.SourceFile {
  return ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function walk(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node);
  ts.forEachChild(node, (child) => walk(child, visit));
}

/**
 * Visit only the call expressions that are UNCONDITIONALLY executed when a
 * function body runs: direct (optionally `await`ed) expression-statement calls
 * at the top level, and the same inside unconditional containers (plain blocks,
 * `try`/`finally`). It deliberately does NOT descend into conditional or
 * deferred contexts — `if`/`else`, `switch`, `catch`, loops, `&&`/`||`/`?:`, or
 * nested function/arrow declarations — so a registration hidden behind a feature
 * flag, `if (false)`, an error path, or an uncalled inner function does NOT count
 * as wired. This fails CLOSED (a conditionally-registered authApi reads as
 * missing → the check fails), which is the safe direction for a wiring gate.
 */
function forEachUnconditionalCall(body: ts.Node, visit: (call: ts.CallExpression) => void): void {
  const visitStatement = (stmt: ts.Node): void => {
    if (ts.isExpressionStatement(stmt)) {
      let expr: ts.Expression = stmt.expression;
      if (ts.isAwaitExpression(expr)) expr = expr.expression;
      if (ts.isCallExpression(expr)) visit(expr);
      return;
    }
    if (ts.isBlock(stmt)) {
      stmt.statements.forEach(visitStatement);
      return;
    }
    if (ts.isTryStatement(stmt)) {
      // try + finally run unconditionally; catch runs only on error (conditional).
      stmt.tryBlock.statements.forEach(visitStatement);
      stmt.finallyBlock?.statements.forEach(visitStatement);
      return;
    }
    // if / switch / loops / labeled / return-of-call / nested fn decls → not
    // guaranteed-unconditional → intentionally skipped (fail closed).
  };

  if (ts.isBlock(body)) {
    body.statements.forEach(visitStatement);
    return;
  }
  // Concise arrow body: `() => foo()` or `() => await foo()`.
  let expr: ts.Node = body;
  if (ts.isAwaitExpression(expr)) expr = expr.expression;
  if (ts.isCallExpression(expr)) visit(expr);
}

function printResult(result: ConnectorAuthWiringResult): void {
  console.log('Connector Catalog authApi -> startup orchestrator wiring check');
  console.log('===============================================================\n');

  console.log(`Catalog authApi values: ${result.usages.map((usage) => usage.authApi).join(', ') || '(none)'}`);
  console.log('');

  for (const usage of result.usages) {
    const registration = result.registrations.find((item) => item.authApi === usage.authApi);
    const exception = result.exempt.find((item) => item.authApi === usage.authApi);

    if (registration) {
      console.log(
        `[wired] ${usage.authApi} (${usage.connectorIds.join(', ')}) -> `
          + `${registration.startupFunction}() -> ${registration.modulePath}:${registration.line}`,
      );
      continue;
    }

    if (exception) {
      console.log(`[exempt] ${usage.authApi} (${usage.connectorIds.join(', ')}) -> ${exception.reason}`);
      for (const evidence of exception.evidence) {
        console.log(`         evidence: ${evidence}`);
      }
    }
  }

  console.log('');

  if (result.violations.length === 0) {
    console.log('PASS: every catalog authApi is wired to startup or has a documented exception.\n');
    return;
  }

  console.error(`FAIL: ${result.violations.length} catalog authApi value(s) have no startup orchestrator:\n`);
  for (const violation of result.violations) {
    console.error(`  - ${violation.authApi} (connectors: ${violation.connectorIds.join(', ')})`);
  }
  console.error(
    '\nFix: register a production AuthOrchestrator from src/main/index.ts startup, or add a narrow '
      + 'AUTH_API_EXCEPTIONS entry only when the connector has a documented non-orchestrator auth path.\n',
  );
}

function main(): void {
  const catalog = JSON.parse(readFileSync(CATALOG_PATH, 'utf8')) as unknown;
  const result = checkConnectorAuthWiring({
    catalog,
    startupPath: MAIN_STARTUP_PATH,
    readFile: (filePath) => readFileSync(filePath, 'utf8'),
  });

  printResult(result);

  if (result.violations.length > 0) {
    process.exit(1);
  }
}

const invokedDirectly = process.argv[1] === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main();
}
