#!/usr/bin/env npx tsx
/**
 * Guard bound BTS evals against reintroducing local generation prompt/schema mirrors.
 *
 * This intentionally scans only evals listed in evals/bts-bound-eval-contracts.manifest.ts.
 * Judge prompts, scoring schemas, fixture validation, and other eval-local code are allowed;
 * the guard only inspects manifest generation model calls with structured outputFormat.
 *
 * Threat model: ACCIDENTAL copy-paste reintroduction of a local prompt/schema mirror
 * (the way the original drift arose). The AST walker catches inline object-literals,
 * local-var object-literal initializers, and local SYSTEM_PROMPT/buildPrompt-style
 * generation prompts. It does NOT chase a schema returned from a helper function, a
 * spread `{ ...fmt }`, or an oddly-named prompt builder — a determined refactor can
 * still bypass it. The runtime identity test (evals/__tests__/evalContractBinding.test.ts)
 * is the complementary backstop (it asserts the eval contract IS the production object).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import {
  btsBoundEvalContractManifest,
  type BoundBtsEvalContractManifestEntry,
} from '../evals/bts-bound-eval-contracts.manifest';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export interface BoundBtsEvalContractViolation {
  readonly id: string;
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly kind: 'local-generation-schema' | 'local-generation-prompt';
  readonly message: string;
}

type LocalDeclaration = {
  readonly name: string;
  readonly node: ts.Node;
  readonly initializer?: ts.Expression;
  readonly importedFrom?: string;
};

type ScanContext = {
  readonly entry: BoundBtsEvalContractManifestEntry;
  readonly sourceFile: ts.SourceFile;
  readonly declarations: ReadonlyMap<string, LocalDeclaration>;
  readonly importedProductionExports: ReadonlySet<string>;
};

function toPosix(input: string): string {
  return input.split(path.sep).join('/');
}

function normalizeImportPath(importPath: string, fromFile: string): string {
  if (!importPath.startsWith('.')) {
    return importPath;
  }

  const fromDir = path.dirname(fromFile);
  const resolved = toPosix(path.normalize(path.join(fromDir, importPath)));
  return resolved.endsWith('.ts') ? resolved : `${resolved}.ts`;
}

function location(
  context: ScanContext,
  node: ts.Node,
  kind: BoundBtsEvalContractViolation['kind'],
  message: string,
): BoundBtsEvalContractViolation {
  const { line, character } = context.sourceFile.getLineAndCharacterOfPosition(
    node.getStart(context.sourceFile),
  );
  return {
    id: context.entry.id,
    file: context.entry.evalFile,
    line: line + 1,
    column: character + 1,
    kind,
    message,
  };
}

function walk(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node);
  ts.forEachChild(node, (child) => walk(child, visit));
}

function propertyNameText(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  return undefined;
}

function getObjectProperty(
  objectLiteral: ts.ObjectLiteralExpression,
  name: string,
): ts.Expression | undefined {
  for (const property of objectLiteral.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    if (propertyNameText(property.name) !== name) continue;
    return property.initializer;
  }
  return undefined;
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (ts.isAsExpression(current) || ts.isSatisfiesExpression(current) || ts.isParenthesizedExpression(current)) {
    current = current.expression;
  }
  return current;
}

function collectDeclarations(
  sourceFile: ts.SourceFile,
  entry: BoundBtsEvalContractManifestEntry,
): {
  declarations: ReadonlyMap<string, LocalDeclaration>;
  importedProductionExports: ReadonlySet<string>;
} {
  const declarations = new Map<string, LocalDeclaration>();
  const importedProductionExports = new Set<string>();

  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      const importedFrom = normalizeImportPath(statement.moduleSpecifier.text, entry.evalFile);
      const namedBindings = statement.importClause?.namedBindings;
      if (!namedBindings || !ts.isNamedImports(namedBindings)) continue;

      for (const element of namedBindings.elements) {
        const importedName = element.propertyName?.text ?? element.name.text;
        const localName = element.name.text;
        declarations.set(localName, { name: localName, node: element, importedFrom });
        if (
          importedFrom === entry.productionModule
          && entry.productionContractExports.includes(importedName)
        ) {
          importedProductionExports.add(localName);
        }
      }
    }
  }

  walk(sourceFile, (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      declarations.set(node.name.text, {
        name: node.name.text,
        node: node.name,
        initializer: node.initializer,
      });
    }

    if (ts.isFunctionDeclaration(node) && node.name) {
      declarations.set(node.name.text, {
        name: node.name.text,
        node: node.name,
      });
    }
  });

  return { declarations, importedProductionExports };
}

function calledFunctionName(expression: ts.Expression): string | undefined {
  const unwrapped = unwrapExpression(expression);
  if (ts.isIdentifier(unwrapped)) return unwrapped.text;
  if (ts.isPropertyAccessExpression(unwrapped)) return unwrapped.name.text;
  return undefined;
}

function objectLiteralFromExpression(
  expression: ts.Expression | undefined,
  declarations: ReadonlyMap<string, LocalDeclaration>,
): ts.ObjectLiteralExpression | undefined {
  if (!expression) return undefined;
  const unwrapped = unwrapExpression(expression);
  if (ts.isObjectLiteralExpression(unwrapped)) return unwrapped;
  if (ts.isIdentifier(unwrapped)) {
    const initializer = declarations.get(unwrapped.text)?.initializer;
    if (initializer) return objectLiteralFromExpression(initializer, declarations);
  }
  return undefined;
}

function hasOutputFormat(options: ts.ObjectLiteralExpression): boolean {
  return getObjectProperty(options, 'outputFormat') !== undefined;
}

function collectGenerationCalls(context: ScanContext): ts.CallExpression[] {
  const calls: ts.CallExpression[] = [];

  walk(context.sourceFile, (node) => {
    if (!ts.isCallExpression(node)) return;
    const functionName = calledFunctionName(node.expression);
    if (!functionName || !context.entry.generationModelCallFunctions.includes(functionName)) return;

    const options = objectLiteralFromExpression(node.arguments[2], context.declarations);
    if (!options || !hasOutputFormat(options)) return;
    calls.push(node);
  });

  return calls;
}

function isObjectLiteralMirror(
  expression: ts.Expression | undefined,
  declarations: ReadonlyMap<string, LocalDeclaration>,
): boolean {
  if (!expression) return false;
  const unwrapped = unwrapExpression(expression);
  if (ts.isObjectLiteralExpression(unwrapped)) return true;
  if (!ts.isIdentifier(unwrapped)) return false;

  const declaration = declarations.get(unwrapped.text);
  if (!declaration?.initializer || declaration.importedFrom) return false;
  return ts.isObjectLiteralExpression(unwrapExpression(declaration.initializer));
}

function schemaExpressionFromCall(
  call: ts.CallExpression,
  declarations: ReadonlyMap<string, LocalDeclaration>,
): ts.Expression | undefined {
  const options = objectLiteralFromExpression(call.arguments[2], declarations);
  const outputFormat = objectLiteralFromExpression(
    options ? getObjectProperty(options, 'outputFormat') : undefined,
    declarations,
  );
  return outputFormat ? getObjectProperty(outputFormat, 'schema') : undefined;
}

function isPromptishName(name: string): boolean {
  return /(?:^|_)SYSTEM_PROMPT$/.test(name)
    || /(?:^|_)PROMPT$/.test(name)
    || /^buildPrompt$/.test(name)
    || /^build[A-Z].*Prompt$/.test(name);
}

function isLocalPromptMirrorExpression(
  expression: ts.Expression,
  declarations: ReadonlyMap<string, LocalDeclaration>,
  importedProductionExports: ReadonlySet<string>,
): boolean {
  const unwrapped = unwrapExpression(expression);

  if (ts.isIdentifier(unwrapped)) {
    if (importedProductionExports.has(unwrapped.text)) return false;
    const declaration = declarations.get(unwrapped.text);
    if (!declaration || declaration.importedFrom) return false;
    if (isPromptishName(unwrapped.text)) return true;
    if (declaration.initializer) {
      const initializer = unwrapExpression(declaration.initializer);
      return ts.isStringLiteral(initializer)
        || ts.isNoSubstitutionTemplateLiteral(initializer)
        || ts.isTemplateExpression(initializer)
        || isLocalPromptMirrorExpression(initializer, declarations, importedProductionExports);
    }
    return false;
  }

  if (ts.isCallExpression(unwrapped)) {
    const functionName = calledFunctionName(unwrapped.expression);
    if (!functionName) return false;
    if (importedProductionExports.has(functionName)) return false;
    const declaration = declarations.get(functionName);
    return Boolean(declaration && !declaration.importedFrom && isPromptishName(functionName));
  }

  if (ts.isTemplateExpression(unwrapped) || ts.isNoSubstitutionTemplateLiteral(unwrapped)) {
    return true;
  }

  return false;
}

function collectPromptExpressions(
  node: ts.Node,
  declarations: ReadonlyMap<string, LocalDeclaration>,
): ts.Expression[] {
  const expressions: ts.Expression[] = [];

  function collectFromValue(propertyName: string, value: ts.Expression): void {
    if (propertyName === 'system' || propertyName === 'content') {
      expressions.push(value);
      return;
    }

    if (propertyName === 'messages') {
      const unwrapped = unwrapExpression(value);
      if (ts.isIdentifier(unwrapped)) {
        const initializer = declarations.get(unwrapped.text)?.initializer;
        if (initializer) collectFromValue(propertyName, initializer);
        return;
      }
      if (!ts.isArrayLiteralExpression(unwrapped)) return;
      for (const element of unwrapped.elements) {
        const message = objectLiteralFromExpression(element as ts.Expression, declarations);
        if (!message) continue;
        const content = getObjectProperty(message, 'content');
        if (content) expressions.push(content);
      }
    }
  }

  const options = ts.isCallExpression(node)
    ? objectLiteralFromExpression(node.arguments[2], declarations)
    : objectLiteralFromExpression(node as ts.Expression, declarations);
  if (!options) return expressions;

  for (const property of options.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    const name = propertyNameText(property.name);
    if (!name) continue;
    collectFromValue(name, property.initializer);
  }

  return expressions;
}

export function scanBoundBtsEvalContractSource(
  entry: BoundBtsEvalContractManifestEntry,
  sourceText: string,
): BoundBtsEvalContractViolation[] {
  const sourceFile = ts.createSourceFile(entry.evalFile, sourceText, ts.ScriptTarget.Latest, true);
  const { declarations, importedProductionExports } = collectDeclarations(sourceFile, entry);
  const context: ScanContext = {
    entry,
    sourceFile,
    declarations,
    importedProductionExports,
  };
  const violations: BoundBtsEvalContractViolation[] = [];

  for (const call of collectGenerationCalls(context)) {
    const schemaExpression = schemaExpressionFromCall(call, declarations);
    if (isObjectLiteralMirror(schemaExpression, declarations)) {
      violations.push(
        location(
          context,
          schemaExpression ?? call,
          'local-generation-schema',
          'Bound BTS eval generation outputFormat.schema must use the production contract from the manifest, not a local object literal mirror.',
        ),
      );
    }

    for (const promptExpression of collectPromptExpressions(call, declarations)) {
      if (!isLocalPromptMirrorExpression(promptExpression, declarations, importedProductionExports)) continue;
      violations.push(
        location(
          context,
          promptExpression,
          'local-generation-prompt',
          'Bound BTS eval generation prompt must use the production contract from the manifest, not a local SYSTEM_PROMPT/buildPrompt mirror.',
        ),
      );
    }
  }

  return violations;
}

export function checkBoundBtsEvalContracts(
  entries: readonly BoundBtsEvalContractManifestEntry[] = btsBoundEvalContractManifest,
  rootDir = REPO_ROOT,
): BoundBtsEvalContractViolation[] {
  return entries.flatMap((entry) => {
    const filePath = path.join(rootDir, entry.evalFile);
    const sourceText = fs.readFileSync(filePath, 'utf8');
    return scanBoundBtsEvalContractSource(entry, sourceText);
  });
}

function main(): void {
  const violations = checkBoundBtsEvalContracts();
  if (violations.length === 0) {
    console.log(`Bound BTS eval contract check passed (${btsBoundEvalContractManifest.length} manifest evals).`);
    return;
  }

  console.error('Bound BTS eval contract check failed.');
  for (const violation of violations) {
    console.error(
      `${violation.file}:${violation.line}:${violation.column} [${violation.id}] ${violation.kind}: ${violation.message}`,
    );
  }
  process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
