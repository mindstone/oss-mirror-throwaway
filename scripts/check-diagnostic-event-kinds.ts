#!/usr/bin/env npx tsx
/**
 * CI Validation: Diagnostic Event Kinds Reconciliation
 *
 * Ensures that all `DiagnosticEventKind` literals are perfectly synchronized across
 * all required surfaces (ledgers, schemas, UI display maps, bundle allowlists).
 *
 * Run: npx tsx scripts/check-diagnostic-event-kinds.ts
 * Wired into: npm run validate:fast
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ts from 'typescript';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SRC_DIR = path.join(__dirname, '..', 'src');

function parseSourceFile(filePath: string): ts.SourceFile {
  const content = fs.readFileSync(filePath, 'utf8');
  return ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true);
}

function extractArrayElements(node: ts.ArrayLiteralExpression): string[] {
  const result: string[] = [];
  for (const element of node.elements) {
    if (ts.isStringLiteral(element)) {
      result.push(element.text);
    }
  }
  return result;
}

function unwrapExpression(expr: ts.Expression): ts.Expression {
  let cursor = expr;
  for (let i = 0; i < 5; i++) {
    if (ts.isAsExpression(cursor)) {
      cursor = cursor.expression;
    } else if (ts.isTypeAssertionExpression(cursor)) {
      cursor = cursor.expression;
    } else if (ts.isParenthesizedExpression(cursor)) {
      cursor = cursor.expression;
    } else if (ts.isSatisfiesExpression(cursor)) {
      cursor = cursor.expression;
    } else {
      break;
    }
  }
  return cursor;
}

// Extract `const VAR_NAME = ['a', 'b']`
function extractArrayLiterals(sourceFile: ts.SourceFile, variableName: string): string[] | null {
  let result: string[] | null = null;
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === variableName) {
      if (node.initializer) {
        const unwrapped = unwrapExpression(node.initializer);
        if (ts.isArrayLiteralExpression(unwrapped)) {
          result = extractArrayElements(unwrapped);
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return result;
}

// Extract `z.enum(['a', 'b'])`
function extractZodEnum(sourceFile: ts.SourceFile, variableName: string): string[] | null {
  let result: string[] | null = null;
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === variableName) {
      if (node.initializer && ts.isCallExpression(node.initializer)) {
        const call = node.initializer;
        if (ts.isPropertyAccessExpression(call.expression) && call.expression.name.text === 'enum') {
          const arg = call.arguments[0];
          if (arg && ts.isArrayLiteralExpression(arg)) {
            result = extractArrayElements(arg);
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return result;
}

// Extract `new Set(['a', 'b'])`
function extractSetElements(sourceFile: ts.SourceFile, variableName: string): string[] | null {
  let result: string[] | null = null;
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === variableName) {
      if (node.initializer && ts.isNewExpression(node.initializer)) {
        const newExpr = node.initializer;
        if (ts.isIdentifier(newExpr.expression) && newExpr.expression.text === 'Set') {
          const arg = newExpr.arguments?.[0];
          if (arg && ts.isArrayLiteralExpression(arg)) {
            result = extractArrayElements(arg);
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return result;
}

// Extract object-literal property names from `const VAR_NAME: <Type> = { a: ..., b: ... }`.
// Used for verifying total `Record<DiagnosticEventKind, ...>` mappings.
function extractRecordKeys(sourceFile: ts.SourceFile, variableName: string): string[] | null {
  let result: string[] | null = null;
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === variableName) {
      if (node.initializer && ts.isObjectLiteralExpression(node.initializer)) {
        const keys: string[] = [];
        for (const prop of node.initializer.properties) {
          if (ts.isPropertyAssignment(prop)) {
            if (ts.isIdentifier(prop.name)) {
              keys.push(prop.name.text);
            } else if (ts.isStringLiteral(prop.name)) {
              keys.push(prop.name.text);
            }
          }
        }
        result = keys;
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return result;
}

// Extract `case 'a':` inside `switch (event.kind)` inside `function functionName`
function extractSwitchCases(sourceFile: ts.SourceFile, functionName: string): string[] | null {
  let result: string[] | null = null;
  function visit(node: ts.Node) {
    if (ts.isFunctionDeclaration(node) && node.name && node.name.text === functionName) {
      if (node.body) {
        ts.forEachChild(node.body, function visitBody(childNode: ts.Node) {
          if (ts.isSwitchStatement(childNode)) {
            // Found the switch statement, collect cases
            result = [];
            for (const clause of childNode.caseBlock.clauses) {
              if (ts.isCaseClause(clause) && ts.isStringLiteral(clause.expression)) {
                result.push(clause.expression.text);
              }
            }
          } else {
            ts.forEachChild(childNode, visitBody);
          }
        });
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return result;
}

function symmetricDifference(setA: Set<string>, setB: Set<string>): { missingInB: string[], extraInB: string[] } {
  const missingInB = [...setA].filter(x => !setB.has(x));
  const extraInB = [...setB].filter(x => !setA.has(x));
  return { missingInB, extraInB };
}

function check(srcDir: string = SRC_DIR): boolean {
  console.log('Checking diagnostic event kinds reconciliation...\n');
  let hasErrors = false;

  // 1. Canonical source
  const ledgerPath = path.join(srcDir, 'core', 'services', 'diagnosticEventsLedger.ts');
  const ledgerSource = parseSourceFile(ledgerPath);
  const canonicalList = extractArrayLiterals(ledgerSource, 'DIAGNOSTIC_EVENT_KIND_LITERALS');
  
  if (!canonicalList) {
    console.error(`[FAIL] Could not find DIAGNOSTIC_EVENT_KIND_LITERALS in ${ledgerPath}`);
    return false;
  }
  
  const canonicalSet = new Set(canonicalList);
  console.log(`Canonical list: ${canonicalList.length} kinds.`);

  function verifySurface(name: string, filePath: string, foundList: string[] | null) {
    if (!foundList) {
      console.error(`[FAIL] Could not parse ${name} in ${filePath}`);
      hasErrors = true;
      return;
    }
    const foundSet = new Set(foundList);
    const { missingInB, extraInB } = symmetricDifference(canonicalSet, foundSet);
    
    if (missingInB.length > 0 || extraInB.length > 0) {
      console.error(`[FAIL] Mismatch in ${name} (${filePath}):`);
      if (missingInB.length > 0) console.error(`  Missing: ${missingInB.join(', ')}`);
      if (extraInB.length > 0) console.error(`  Extra: ${extraInB.join(', ')}`);
      hasErrors = true;
    } else {
      console.log(`[PASS] ${name} is in lockstep.`);
    }
  }

  // 2. Shared schema
  const sharedSchemaPath = path.join(srcDir, 'shared', 'diagnostics', 'recentDiagnosticContext.ts');
  const sharedSchemaSource = parseSourceFile(sharedSchemaPath);
  verifySurface('DiagnosticEventKindSchema', sharedSchemaPath, extractZodEnum(sharedSchemaSource, 'DiagnosticEventKindSchema'));

  // 3. Bundle allowlist
  const bundleServicePath = path.join(srcDir, 'core', 'services', 'diagnostics', 'diagnosticBundleService.ts');
  const bundleServiceSource = parseSourceFile(bundleServicePath);
  verifySurface('VALID_DIAGNOSTIC_EVENT_KINDS', bundleServicePath, extractSetElements(bundleServiceSource, 'VALID_DIAGNOSTIC_EVENT_KINDS'));

  // 4. Bundle event-kind -> section routing map (must be total: every kind explicitly placed)
  verifySurface('EVENT_KIND_TO_SECTION', bundleServicePath, extractRecordKeys(bundleServiceSource, 'EVENT_KIND_TO_SECTION'));

  // 5. Display map
  const displayMapPath = path.join(srcDir, 'core', 'services', 'diagnostics', 'diagnosticEventDisplay.ts');
  const displayMapSource = parseSourceFile(displayMapPath);
  verifySurface('getFriendlyEventDisplay switch cases', displayMapPath, extractSwitchCases(displayMapSource, 'getFriendlyEventDisplay'));

  if (hasErrors) {
    console.error('\nFAILED: Diagnostic event kinds are out of sync across surfaces.');
    console.error('All new DiagnosticEventKind variants must be added to the canonical list, schemas, allowlists, and display maps in lockstep.');
    return false;
  }

  console.log('\nPASSED: All surfaces are fully reconciled.');
  return true;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const success = check();
  process.exit(success ? 0 : 1);
}

export { check };
