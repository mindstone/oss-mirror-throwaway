#!/usr/bin/env npx tsx
/**
 * CI validation: direct session PUTs must funnel through pushFullSessionWithCapabilityGate.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import ts from 'typescript';

export const SCAN_ROOTS = [
  'src/main',
  'cloud-client/src',
  'cloud-service/src',
  'mobile/src',
  'mobile/app',
  'web-companion/src',
] as const;

export interface DirectSessionPutViolation {
  file: string;
  line: number;
  column: number;
  text: string;
}

function isTestFile(filePath: string): boolean {
  return /\.test\.tsx?$|\.spec\.tsx?$|__tests__/.test(filePath);
}

function walkTsFiles(dir: string, out: string[]): void {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'build') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkTsFiles(full, out);
    } else if ((entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) && !isTestFile(full)) {
      out.push(full);
    }
  }
}

function stringLiteralText(node: ts.Node): string | undefined {
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) ? node.text : undefined;
}

function routeText(node: ts.Node | undefined): string | undefined {
  if (!node) return undefined;
  const literal = stringLiteralText(node);
  if (literal !== undefined) return literal;
  if (ts.isTemplateExpression(node)) return node.head.text;
  return undefined;
}

function isSessionPath(raw: string | undefined): boolean {
  return raw === '/api/sessions' || raw?.startsWith('/api/sessions/') === true;
}

function hasDisableCommentOnPreviousLine(sourceText: string, lineNumber: number): boolean {
  const lines = sourceText.split(/\r?\n/);
  const previousLine = lines[lineNumber - 2] ?? '';
  return /(?:eslint-disable-next-line\s+)?direct-session-put\s+--\s+\S/.test(previousLine);
}

function isInsideAllowedFunction(node: ts.Node): boolean {
  let current: ts.Node | undefined = node;
  while (current) {
    if (
      ts.isFunctionDeclaration(current)
      && current.name?.text === 'pushFullSessionWithCapabilityGate'
    ) {
      return true;
    }
    current = current.parent;
  }
  return false;
}

function isDirectSessionPutCall(node: ts.CallExpression): boolean {
  if (
    ts.isPropertyAccessExpression(node.expression)
    && node.expression.name.text === 'put'
  ) {
    return isSessionPath(routeText(node.arguments[0]));
  }

  if (
    ts.isIdentifier(node.expression)
    && node.expression.text === 'request'
    && routeText(node.arguments[0]) === 'PUT'
  ) {
    return isSessionPath(routeText(node.arguments[1]));
  }

  return false;
}

export function checkFile(filePath: string, rootDir = process.cwd()): DirectSessionPutViolation[] {
  if (isTestFile(filePath)) return [];
  const sourceText = fs.readFileSync(filePath, 'utf8');
  const sourceFile = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true);
  const violations: DirectSessionPutViolation[] = [];

  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node) && isDirectSessionPutCall(node) && !isInsideAllowedFunction(node)) {
      const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
      const lineNumber = line + 1;
      if (!hasDisableCommentOnPreviousLine(sourceText, lineNumber)) {
        violations.push({
          file: path.relative(rootDir, filePath),
          line: lineNumber,
          column: character + 1,
          text: node.getText(sourceFile),
        });
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return violations;
}

export function checkDirectSessionPuts(options: { rootDir?: string; scanRoots?: readonly string[] } = {}): DirectSessionPutViolation[] {
  const rootDir = options.rootDir ?? path.resolve(__dirname, '..');
  const scanRoots = options.scanRoots ?? SCAN_ROOTS;
  const files: string[] = [];
  for (const root of scanRoots) {
    walkTsFiles(path.join(rootDir, root), files);
  }
  return files.flatMap((file) => checkFile(file, rootDir));
}

export function main(): void {
  const violations = checkDirectSessionPuts();
  if (violations.length === 0) {
    console.log('Direct session PUT check passed.');
    return;
  }

  console.error('Direct session PUT check failed. Use pushFullSessionWithCapabilityGate instead:');
  for (const violation of violations) {
    console.error(`- ${violation.file}:${violation.line}:${violation.column} ${violation.text}`);
  }
  process.exit(1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  main();
}
