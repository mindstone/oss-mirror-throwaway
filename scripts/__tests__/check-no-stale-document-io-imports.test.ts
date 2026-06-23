import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const repoRoot = join(__dirname, '..', '..');
const srcRoot = join(repoRoot, 'src');
const staleNames = [
  'classifyError',
  'ErrorClassifier',
  'WriteFailureError',
  'errnoToUserMessage',
  'writeErrorToUserMessage',
  'ACTIONABLE_WRITE_ERRNOS',
];

function collectSourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const absPath = join(dir, entry);
    const stat = statSync(absPath);
    if (stat.isDirectory()) {
      if (entry === '__tests__' || entry === '__mocks__') continue;
      files.push(...collectSourceFiles(absPath));
      continue;
    }
    if (!/\.(ts|tsx)$/.test(entry) || /\.test\.(ts|tsx)$/.test(entry)) continue;
    files.push(absPath);
  }
  return files;
}

function importsStaleDocumentIoName(source: string, name: string): boolean {
  const importPattern = /import\s+(?:type\s+)?\{([\s\S]*?)\}\s+from\s+['"][^'"]*hooks\/useDocumentFileIO['"]/g;
  for (const match of source.matchAll(importPattern)) {
    const namedImports = match[1] ?? '';
    const namePattern = new RegExp(`(?:^|[,\\s])(?:type\\s+)?${name}(?:\\s+as\\s+\\w+)?(?:$|[,\\s])`);
    if (namePattern.test(namedImports)) {
      return true;
    }
  }
  return false;
}

describe('document I/O shared primitive imports', () => {
  it('does not import removed document I/O re-exports from useDocumentFileIO', () => {
    const staleImports: string[] = [];

    for (const absPath of collectSourceFiles(srcRoot)) {
      const source = readFileSync(absPath, 'utf8');
      for (const name of staleNames) {
        if (importsStaleDocumentIoName(source, name)) {
          staleImports.push(`${relative(repoRoot, absPath)} imports ${name}`);
        }
      }
    }

    expect(staleImports).toEqual([]);
  });
});
