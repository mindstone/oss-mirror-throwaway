#!/usr/bin/env npx tsx
/**
 * Guards active docs against legacy eval-token regressions.
 *
 * Stage 12 (260518 hermetic eval-config refactor) removed these tokens from
 * active operator/developer docs:
 *   - EVAL_APP_SETTINGS_PATH
 *   - .env.evals
 *   - the legacy eval defaults-file name
 *
 * Historical references in docs/plans remain allowed. This script scans:
 *   - Markdown files under docs/project/
 *   - Markdown files under coding-agent-instructions/
 *   - evals/AGENTS.md
 *   - active eval/script TypeScript sources for app-settings.json read paths
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const LEGACY_DOC_RULES = [
  { label: 'EVAL_APP_SETTINGS_PATH', regex: /EVAL_APP_SETTINGS_PATH/g },
  { label: '.env.evals', regex: /\.env\.evals/g },
  { label: '.config.defaults.json', regex: /\.config\.defaults\.json/g },
] as const;

const APP_SETTINGS_READ_RULES = [
  { label: 'EVAL_APP_SETTINGS_PATH', regex: /EVAL_APP_SETTINGS_PATH/g },
  {
    label: 'literal app-settings.json read',
    regex: /(?:readFileSync|readFile)\s*\([\s\S]{0,240}app-settings\.json/g,
  },
  {
    label: 'computed app-settings.json read',
    regex: /(?:readFileSync|readFile)\s*\([\s\S]{0,240}(?:resolveAppSettingsPath|getRebelSettingsPath|appSettingsPath)/g,
  },
] as const;

// Matches top-level (column 0) self-executing CLI patterns:
//   foo().catch(...)        — main().catch / mainCli().catch / verifySemanticIndex().catch
//   foo().then(...)         — main().then / etc.
//   void foo().catch(...)   — variant prefix
//   await foo()             — top-level await (legal in ESM tsx)
//   await foo();            — with trailing semicolon
//   void foo();             — void prefix
//   foo();                  — bare call
// The callee may take arguments: `main(opts)` matches the same way.
const STATIC_GUARD_SELF_EXECUTION_PATTERN = /^(await\s+|void\s+)?[a-zA-Z_][a-zA-Z0-9_]*\([\s\S]*?\)(\.(catch|then)\(|\s*;?\s*$)/;

const STATIC_GUARD_ALLOW_LIST = new Set<string>([
  'evals/run.ts',
  'evals/mcp-twins/server.ts',
  'evals/__tests__/concurrent-orchestrator.integration.test.ts',
  'evals/connector-build-loader.ts',
  'evals/verify-semantic-index.ts',
  // Bootstrap module: configures process-wide BTS dependencies (tracker,
  // handler registry, license tier) at import time. Top-level calls here
  // are intentional bootstrap setup, NOT harness self-execution; Phase B
  // fs-spy already verifies it does not read app-settings.json on import.
  'evals/knowledge-work-bootstrap.ts',
]);

const STATIC_GUARD_NON_TARGET_PREFIXES = [
  'evals/scripts/',
  'evals/benchmarks/',
  'evals/analyze-',
];

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'coverage',
]);

type Match = {
  readonly file: string;
  readonly line: number;
  readonly token: string;
};

type ScanRule = {
  readonly label: string;
  readonly regex: RegExp;
};

export type StaticGuardMatch = {
  readonly file: string;
  readonly line: number;
  readonly code: string;
};

function toPosix(input: string): string {
  return input.split(path.sep).join('/');
}

function listFilesWithExtension(dir: string, extension: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  const stack: string[] = [dir];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      if (SKIP_DIRS.has(entry.name)) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith(extension)) continue;
      out.push(full);
    }
  }

  return out;
}

function listMarkdownFiles(dir: string): string[] {
  return listFilesWithExtension(dir, '.md');
}

function listTypeScriptFiles(dir: string): string[] {
  return listFilesWithExtension(dir, '.ts');
}

function shouldScanEvalSelfExecution(absPath: string): boolean {
  const rel = toPosix(path.relative(ROOT, absPath));
  if (!rel.startsWith('evals/')) return false;
  if (rel.includes('/__tests__/')) return false;
  if (rel.includes('/.built') && rel.endsWith('.mjs')) return false;
  if (rel.includes('/build') && rel.endsWith('.mjs')) return false;
  return true;
}

function lineNumberAt(source: string, index: number): number {
  return source.slice(0, index).split('\n').length;
}

function scanFile(absPath: string, rules: readonly ScanRule[]): Match[] {
  let source: string;
  try {
    source = fs.readFileSync(absPath, 'utf8');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to read ${toPosix(path.relative(ROOT, absPath))}: ${message}`);
  }

  const rel = toPosix(path.relative(ROOT, absPath));
  const matches: Match[] = [];
  for (const rule of rules) {
    const regex = new RegExp(rule.regex.source, rule.regex.flags.includes('g') ? rule.regex.flags : `${rule.regex.flags}g`);
    let hit: RegExpExecArray | null;
    while ((hit = regex.exec(source)) !== null) {
      matches.push({
        file: rel,
        line: lineNumberAt(source, hit.index),
        token: rule.label,
      });
    }
  }
  return matches;
}

function isStaticGuardNonTarget(rel: string): boolean {
  return STATIC_GUARD_ALLOW_LIST.has(rel)
    || STATIC_GUARD_NON_TARGET_PREFIXES.some((prefix) => rel.startsWith(prefix));
}

function countBraceDelta(line: string): number {
  return [...line].reduce((delta, char) => {
    if (char === '{') return delta + 1;
    if (char === '}') return delta - 1;
    return delta;
  }, 0);
}

function isInsideRecentMainEntrypointGuard(lines: readonly string[], lineIndex: number): boolean {
  const firstPrecedingLine = Math.max(0, lineIndex - 5);
  for (let guardIndex = lineIndex - 1; guardIndex >= firstPrecedingLine; guardIndex -= 1) {
    if (!lines[guardIndex].includes('if (isMainEntrypoint(')) continue;
    let braceDepth = 0;
    for (let i = guardIndex; i < lineIndex; i += 1) {
      braceDepth += countBraceDelta(lines[i]);
    }
    return braceDepth > 0;
  }
  return false;
}

export function scanEvalSelfExecutionGuards(absPath: string, sourceOrLines?: string | readonly string[]): StaticGuardMatch[] {
  const sourceLines = (() => {
    if (typeof sourceOrLines === 'string') {
      return sourceOrLines.split('\n');
    }
    if (Array.isArray(sourceOrLines)) {
      return sourceOrLines;
    }
    let source: string;
    try {
      source = fs.readFileSync(absPath, 'utf8');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to read ${toPosix(path.relative(ROOT, absPath))}: ${message}`);
    }
    return source.split('\n');
  })();
  const rel = toPosix(path.relative(ROOT, absPath));
  const matches: StaticGuardMatch[] = [];
  for (const [index, line] of sourceLines.entries()) {
    if (!STATIC_GUARD_SELF_EXECUTION_PATTERN.test(line)) continue;
    if (isInsideRecentMainEntrypointGuard(sourceLines, index)) continue;
    if (isStaticGuardNonTarget(rel)) continue;
    matches.push({
      file: rel,
      line: index + 1,
      code: line.trim(),
    });
  }
  return matches;
}

function shouldScanSource(absPath: string): boolean {
  const rel = toPosix(path.relative(ROOT, absPath));
  if (rel.includes('/__tests__/')) return false;
  if (rel === 'scripts/check-no-legacy-eval-tokens.ts') return false;
  // env-capture-core is the canonical app-settings reader (260611 unify-key-capture
  // extraction); capture-keys.ts now reads through it and needs no exemption.
  if (rel === 'evals/env-capture-core.ts') return false;
  if (rel === 'scripts/eval/snapshot-live-settings.ts') return false;
  return true;
}

export function main(): void {
  const docTargets = [
    ...listMarkdownFiles(path.join(ROOT, 'docs/project')),
    ...listMarkdownFiles(path.join(ROOT, 'coding-agent-instructions')),
    path.join(ROOT, 'evals/AGENTS.md'),
  ];
  const sourceTargets = [
    ...listTypeScriptFiles(path.join(ROOT, 'evals')),
    ...listTypeScriptFiles(path.join(ROOT, 'scripts', 'eval')),
  ].filter(shouldScanSource);

  const docMatches = docTargets
    .filter((target) => fs.existsSync(target))
    .flatMap((target) => scanFile(target, LEGACY_DOC_RULES));
  const sourceMatches = sourceTargets
    .filter((target) => fs.existsSync(target))
    .flatMap((target) => scanFile(target, APP_SETTINGS_READ_RULES));
  const selfExecutionMatches = listTypeScriptFiles(path.join(ROOT, 'evals'))
    .filter(shouldScanEvalSelfExecution)
    .flatMap((target) => scanEvalSelfExecutionGuards(target))
    .sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.code.localeCompare(b.code));
  const allMatches = [...docMatches, ...sourceMatches]
    .sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.token.localeCompare(b.token));

  if (allMatches.length > 0 || selfExecutionMatches.length > 0) {
    if (selfExecutionMatches.length > 0) {
      console.error('❌ Unguarded eval harness self-execution detected:');
      for (const match of selfExecutionMatches) {
        console.error(`   ${match.file}:${match.line}  ${match.code}`);
      }
      console.error('');
      console.error('Gate top-level execution with if (isMainEntrypoint(import.meta.url)) { ... }');
      console.error('or add a documented rationale to STATIC_GUARD_ALLOW_LIST for intentional self-executors.');
      console.error('');
    }

    if (allMatches.length === 0) {
      process.exit(1);
    }

    console.error('❌ Legacy eval tokens/read paths detected in active surfaces:');
    for (const match of allMatches) {
      console.error(`   ${match.file}:${match.line}  ${match.token}`);
    }
    console.error('');
    console.error('Allowed historical-doc location: docs/plans/**/*.md');
    console.error('Allowed live settings readers: evals/env-capture-core.ts and scripts/eval/snapshot-live-settings.ts');
    process.exit(1);
  }

  console.log('PASS — no legacy eval tokens/read paths or unguarded eval harness self-executions found in active surfaces.');
}

const invokedDirectly = process.argv[1] === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main();
}
