#!/usr/bin/env npx tsx
/**
 * CI Validation: mobile test-runner import guard.
 *
 * Mobile tests run under Jest (`mobile/package.json` -> `"test": "jest"`,
 * with the `jest-expo` preset). `vitest` imports under `mobile/**` crash at
 * module load because the mobile install tree does not provide Vitest as the
 * test runner. This guard keeps that runner boundary explicit in validate:fast.
 *
 * Run: npx tsx scripts/check-mobile-test-runner.ts
 * @see docs/postmortems/260502_mobile_queuecopy_vitest_import_postmortem.md
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const MOBILE_ROOT = path.join(REPO_ROOT, 'mobile');

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx']);
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'out', 'coverage']);

export interface VitestImportViolation {
  relativePath: string;
  line: number;
  specifier: string;
}

interface VitestImportOccurrence {
  line: number;
  specifier: string;
}

function normalisePath(filePath: string): string {
  return filePath.replaceAll('\\', '/');
}

function isVitestPackageSpecifier(specifier: string): boolean {
  return specifier === 'vitest' || specifier.startsWith('vitest/');
}

function scriptKindForPath(filePath: string): ts.ScriptKind {
  if (filePath.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (filePath.endsWith('.jsx')) return ts.ScriptKind.JSX;
  if (filePath.endsWith('.js')) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function findVitestImportOccurrences(sourceText: string, sourcePath = 'fixture.ts'): VitestImportOccurrence[] {
  const sourceFile = ts.createSourceFile(
    sourcePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    scriptKindForPath(sourcePath),
  );
  const occurrences: VitestImportOccurrence[] = [];

  function addOccurrence(moduleSpecifier: ts.StringLiteralLike): void {
    const specifier = moduleSpecifier.text;
    if (!isVitestPackageSpecifier(specifier)) return;

    const { line } = sourceFile.getLineAndCharacterOfPosition(moduleSpecifier.getStart(sourceFile));
    occurrences.push({
      line: line + 1,
      specifier,
    });
  }

  function visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
      addOccurrence(node.moduleSpecifier);
    } else if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'require' &&
      node.arguments.length === 1 &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      addOccurrence(node.arguments[0]);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      ts.isStringLiteralLike(node.moduleReference.expression)
    ) {
      addOccurrence(node.moduleReference.expression);
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return occurrences;
}

export function findVitestImports(sourceText: string): string[] {
  return findVitestImportOccurrences(sourceText).map((occurrence) => occurrence.specifier);
}

function walkAndScan(rootDir: string, violations: VitestImportViolation[]): void {
  const entries = readdirSync(rootDir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(rootDir, entry.name);

    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const stats = statSync(fullPath, { throwIfNoEntry: false });
      if (!stats || !stats.isDirectory()) continue;
      walkAndScan(fullPath, violations);
      continue;
    }

    if (!entry.isFile()) continue;
    if (!SOURCE_EXTENSIONS.has(path.extname(entry.name))) continue;

    const relativePath = normalisePath(path.relative(REPO_ROOT, fullPath));
    const sourceText = readFileSync(fullPath, 'utf-8');

    for (const occurrence of findVitestImportOccurrences(sourceText, relativePath)) {
      violations.push({
        relativePath,
        line: occurrence.line,
        specifier: occurrence.specifier,
      });
    }
  }
}

export function findMobileVitestImportViolations(): VitestImportViolation[] {
  const violations: VitestImportViolation[] = [];
  walkAndScan(MOBILE_ROOT, violations);
  return violations;
}

function main(): void {
  const violations = findMobileVitestImportViolations();

  if (violations.length > 0) {
    const formatted = violations
      .map((violation) => `  ${violation.relativePath}:${violation.line} imports '${violation.specifier}'`)
      .join('\n');

    process.stderr.write(
      'Forbidden Vitest import under mobile/**:\n' +
        `${formatted}\n\n` +
        'Mobile uses Jest (`mobile/package.json` -> `"test": "jest"` with the `jest-expo` preset), ' +
        'so importing from `vitest` crashes the Mobile Runtime Integrity CI at module load. ' +
        'Use Jest globals instead (describe/it/expect are available without a test-framework import), ' +
        'then validate the changed test with `cd mobile && npx jest <path>`.\n\n' +
        'See docs/postmortems/260502_mobile_queuecopy_vitest_import_postmortem.md.\n',
    );
    process.exitCode = 1;
    return;
  }

  process.stdout.write('✔ check-mobile-test-runner: no Vitest imports found under mobile/**.\n');
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Failed to check mobile test-runner imports: ${message}\n`);
    process.exitCode = 1;
  }
}
