#!/usr/bin/env npx tsx
/**
 * CI guard: the legacy provider resolver must not return to production code.
 *
 * Stage 3.3 of the model/provider hardening work deleted the resolved-target
 * bridge (`ResolvedTarget`, `resolveTargetForModel`, `createClientFromTarget`,
 * and `targetNeedsProxy`). Production routing should go through route-plan
 * client creation instead. Test mocks may still mention the old keys while
 * migrated production code no longer imports them.
 *
 * Wired into: npm run validate:fast
 */
import fs from 'node:fs';
import path from 'node:path';

const REPO_ROOT = process.cwd();
// Scan both production roots that import the client factory: `src/` and `evals/`
// (the eval harness is a separate ts-ratchet project and a real facade caller —
// see evals/rebel-core-planner.ts). Test files are excluded below.
const SCAN_ROOTS = ['src', 'evals'].map((dir) => path.join(REPO_ROOT, dir));
const LEGACY_SYMBOLS = [
  'ResolvedTarget',
  'resolveTargetForModel',
  'createClientFromTarget',
  'targetNeedsProxy',
] as const;

function toPosix(relativePath: string): string {
  return relativePath.split(path.sep).join('/');
}

function isTypeScriptFile(filePath: string): boolean {
  return /\.(?:ts|tsx)$/.test(filePath);
}

function isTestFile(relativePath: string): boolean {
  const normalized = toPosix(relativePath);
  return (
    normalized.includes('/__tests__/') ||
    normalized.endsWith('.test.ts') ||
    normalized.endsWith('.test.tsx') ||
    normalized.endsWith('.spec.ts') ||
    normalized.endsWith('.spec.tsx')
  );
}

function shouldSkipDir(dirName: string): boolean {
  return new Set([
    '.git',
    '.local',
    'node_modules',
    'dist',
    'out',
    'coverage',
    'tmp',
  ]).has(dirName);
}

function walkFiles(root: string): string[] {
  if (!fs.existsSync(root)) return [];

  const files: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!shouldSkipDir(entry.name)) {
          stack.push(path.join(current, entry.name));
        }
        continue;
      }
      if (!entry.isFile()) continue;
      const absolutePath = path.join(current, entry.name);
      const relativePath = toPosix(path.relative(REPO_ROOT, absolutePath));
      if (isTypeScriptFile(absolutePath) && !isTestFile(relativePath)) {
        files.push(absolutePath);
      }
    }
  }
  return files.sort();
}

function legacySymbolPattern(): RegExp {
  return new RegExp(`\\b(?:${LEGACY_SYMBOLS.join('|')})\\b`);
}

const symbolRe = legacySymbolPattern();
const violations = SCAN_ROOTS.flatMap(walkFiles).flatMap((absolutePath) => {
  const relativePath = toPosix(path.relative(REPO_ROOT, absolutePath));
  return fs.readFileSync(absolutePath, 'utf8')
    .split('\n')
    .map((line, index) => ({ line, lineNumber: index + 1 }))
    .filter(({ line }) => symbolRe.test(line))
    .map(({ line, lineNumber }) => `${relativePath}:${lineNumber}: ${line.trim()}`);
});

if (violations.length > 0) {
  console.error(
    `ERROR: legacy provider resolver symbols were found in production src code:\n` +
      `${violations.join('\n')}\n\n` +
      `Stage 3.3 removed ${LEGACY_SYMBOLS.join(', ')}. ` +
      `Use route-plan-backed client creation (` +
      `createClientForModel / createClientFromRoutePlan / createModelClient) instead. ` +
      `Tests may keep mock-only keys, but production src/** must not re-declare, export, or import these symbols.`,
  );
  process.exit(1);
}

console.log('✓ no legacy provider resolver symbols in production src code');
