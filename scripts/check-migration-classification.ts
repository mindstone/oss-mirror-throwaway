#!/usr/bin/env npx tsx
/**
 * CI Validation: Migration classification completeness.
 *
 * Every persistent desktop userData store must have exactly one migration
 * verdict before export/import services can use it. The source of truth is the
 * Stage-1 migration classification table; this script guards both the version
 * registry and live store construction call sites.
 */

import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { ALL_STORE_VERSIONS } from '../src/core/constants';
import {
  MIGRATION_CLASSIFICATION_BY_STORE_NAME,
  MIGRATION_CLASSIFICATION_BY_VERSION_KEY,
  MIGRATION_CLASSIFICATIONS,
  MIGRATION_CLASSIFICATION_VERDICTS,
  type MigrationClassificationEntry,
} from '../src/core/services/migration/migrationClassification';

const REPO_ROOT = path.resolve(__dirname, '..');
const SCAN_ROOTS = [
  path.join(REPO_ROOT, 'src', 'core'),
  path.join(REPO_ROOT, 'src', 'main'),
];

interface StoreCallsite {
  readonly storeName: string;
  readonly file: string;
  readonly line: number;
}

const EXCLUDED_FILE_PARTS = [
  `${path.sep}__tests__${path.sep}`,
  '.test.',
  '.spec.',
  `${path.sep}storeFactory.ts`,
];

function walkTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '__tests__') continue;
      out.push(...walkTsFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      if (EXCLUDED_FILE_PARTS.some((part) => fullPath.includes(part))) continue;
      out.push(fullPath);
    }
  }
  return out;
}

function propertyNameText(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  return null;
}

function objectLiteralNameValue(node: ts.ObjectLiteralExpression): string | null {
  for (const property of node.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    const propName = propertyNameText(property.name);
    if (propName !== 'name') continue;
    if (ts.isStringLiteralLike(property.initializer)) {
      return property.initializer.text;
    }
  }
  return null;
}

function buildObjectLiteralBindings(sourceFile: ts.SourceFile): Map<string, ts.ObjectLiteralExpression> {
  const bindings = new Map<string, ts.ObjectLiteralExpression>();
  function visit(node: ts.Node): void {
    if (
      ts.isVariableDeclaration(node)
      && ts.isIdentifier(node.name)
      && node.initializer
      && ts.isObjectLiteralExpression(node.initializer)
    ) {
      bindings.set(node.name.text, node.initializer);
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return bindings;
}

function callExpressionName(node: ts.Expression): string | null {
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  return null;
}

function resolveOptionsObject(
  expression: ts.Expression | undefined,
  bindings: Map<string, ts.ObjectLiteralExpression>,
): ts.ObjectLiteralExpression | null {
  if (!expression) return null;
  if (ts.isObjectLiteralExpression(expression)) return expression;
  if (ts.isIdentifier(expression)) return bindings.get(expression.text) ?? null;
  return null;
}

export function collectMigrationStoreCallsites(): StoreCallsite[] {
  const callsites: StoreCallsite[] = [];
  const seen = new Set<string>();

  for (const filePath of SCAN_ROOTS.flatMap(walkTsFiles)) {
    const sourceText = fs.readFileSync(filePath, 'utf8');
    const sourceFile = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true);
    const bindings = buildObjectLiteralBindings(sourceFile);

    function record(storeName: string, node: ts.Node): void {
      const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
      const relativeFile = path.relative(REPO_ROOT, filePath);
      const key = `${relativeFile}:${line + 1}:${storeName}`;
      if (seen.has(key)) return;
      seen.add(key);
      callsites.push({ storeName, file: relativeFile, line: line + 1 });
    }

    function visit(node: ts.Node): void {
      if (ts.isCallExpression(node)) {
        const name = callExpressionName(node.expression);
        if (name === 'createStore' || name === 'storeFactory') {
          const optionsObject = resolveOptionsObject(node.arguments[0], bindings);
          const storeName = optionsObject ? objectLiteralNameValue(optionsObject) : null;
          if (storeName) record(storeName, node);
        }
      } else if (ts.isNewExpression(node)) {
        const name = callExpressionName(node.expression);
        if (name === 'Store') {
          const optionsObject = resolveOptionsObject(node.arguments?.[0], bindings);
          const storeName = optionsObject ? objectLiteralNameValue(optionsObject) : null;
          if (storeName) record(storeName, node);
        }
      }
      ts.forEachChild(node, visit);
    }

    visit(sourceFile);
  }

  return callsites.sort((a, b) => a.storeName.localeCompare(b.storeName) || a.file.localeCompare(b.file));
}

function main(): void {
  let hasErrors = false;

  const duplicateChecks = new Map<string, string>();
  for (const entry of MIGRATION_CLASSIFICATIONS as readonly MigrationClassificationEntry[]) {
    if (!MIGRATION_CLASSIFICATION_VERDICTS.includes(entry.verdict)) {
      console.error(`INVALID: ${entry.id} has unknown verdict ${entry.verdict}`);
      hasErrors = true;
    }
    for (const field of ['versionKeys', 'storeNames', 'relPaths'] as const) {
      for (const value of entry[field] ?? []) {
        const key = `${field}:${String(value)}`;
        const previous = duplicateChecks.get(key);
        if (previous) {
          console.error(`DUPLICATE: ${key} is classified by both ${previous} and ${entry.id}`);
          hasErrors = true;
        }
        duplicateChecks.set(key, entry.id);
      }
    }
  }

  for (const versionKey of Object.keys(ALL_STORE_VERSIONS) as Array<keyof typeof ALL_STORE_VERSIONS>) {
    if (!MIGRATION_CLASSIFICATION_BY_VERSION_KEY.has(versionKey)) {
      console.error(`UNCLASSIFIED VERSION: ${versionKey} is missing from migration classification`);
      hasErrors = true;
    }
  }

  const callsites = collectMigrationStoreCallsites();
  for (const callsite of callsites) {
    if (!MIGRATION_CLASSIFICATION_BY_STORE_NAME.has(callsite.storeName)) {
      console.error(
        `UNCLASSIFIED STORE: ${callsite.storeName} at ${callsite.file}:${callsite.line} is missing from migration classification`,
      );
      hasErrors = true;
    }
  }

  console.log(`Migration classification entries: ${MIGRATION_CLASSIFICATIONS.length}`);
  console.log(`Store version keys checked: ${Object.keys(ALL_STORE_VERSIONS).length}`);
  console.log(`Store callsites checked: ${callsites.length}`);

  if (hasErrors) {
    console.error('\nFAILED: Migration classification is incomplete.');
    process.exit(1);
  }

  console.log('\nPASSED: Migration classification covers store versions and store callsites.');
}

if (require.main === module) {
  main();
}
