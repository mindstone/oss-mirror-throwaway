import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scanRoots = ['src/core', 'src/main'].map((root) => path.join(repoRoot, root));
const helperPath = path.join(repoRoot, 'src/core/rebelCore/codexConnectivity.ts');

const forbiddenPatterns: ReadonlyArray<{ name: string; pattern: RegExp }> = [
  {
    name: 'codexConnectivity raw provider probe',
    pattern: /codexConnectivity\s*:\s*getCodexAuthProvider\(\)\.isConnected\(\)\s*\?/,
  },
  {
    name: 'codexConnectivity raw provider variable',
    pattern: /const\s+codexConnectivity\b[^=]*=\s*getCodexAuthProvider\(\)\.isConnected\(\)\s*\?/,
  },
  {
    name: 'raw provider probe to CodexConnectivity mapping',
    pattern: /getCodexAuthProvider\(\)\.isConnected\(\)\s*\?\s*['"]connected['"]\s*:\s*['"]disconnected['"]/,
  },
];

function* walk(dir: string): Generator<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(fullPath);
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      yield fullPath;
    }
  }
}

function lineNumberForIndex(text: string, index: number): number {
  return text.slice(0, index).split('\n').length;
}

const violations: string[] = [];

for (const root of scanRoots) {
  for (const filePath of walk(root)) {
    if (filePath === helperPath) continue;
    const text = fs.readFileSync(filePath, 'utf8');
    for (const { name, pattern } of forbiddenPatterns) {
      const match = pattern.exec(text);
      if (!match) continue;
      const relativePath = path.relative(repoRoot, filePath);
      violations.push(`${relativePath}:${lineNumberForIndex(text, match.index)} ${name}`);
    }
  }
}

if (violations.length > 0) {
  console.error('Codex connectivity routing probes must go through resolveCodexConnectivity():');
  for (const violation of violations) {
    console.error(`- ${violation}`);
  }
  process.exit(1);
}

console.log('Codex connectivity routing probe funnel clean.');
