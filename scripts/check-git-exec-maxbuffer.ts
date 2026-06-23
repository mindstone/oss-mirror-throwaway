#!/usr/bin/env npx tsx
/**
 * CI validation: enforce the shared git capture maxBuffer helper in scripts/**.
 *
 * Raw child_process git capture defaults to Node's 1 MiB maxBuffer unless every
 * caller remembers to override it. New git stdout captures in scripts/** should
 * route through `gitCapture` / `gitCaptureShell` from `scripts/lib/git-exec.ts`.
 *
 * Escape hatch: put `// git-exec-allow: <reason>` on the flagged line or the
 * immediately preceding line. The reason must be non-empty, at least 15
 * characters, and must not be a TODO/FIXME/WIP-style placeholder.
 *
 * Known limitation: this is a regex source scan, not an AST data-flow rule. It
 * catches direct literal forms such as `execSync('git status')`,
 * `execFileSync('git', ...)`, and `spawnSync('git', ...)`. It does not reliably
 * catch commands assembled earlier, e.g. `const cmd = `git status`;
 * execSync(cmd)`. That tradeoff keeps this validate:fast gate cheap and aimed
 * at the direct forms that have actually shipped.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gitCapture } from './lib/git-exec.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PREFIX = '[check-git-exec-maxbuffer]';

const SOURCE_EXTENSIONS = new Set(['.cjs', '.cts', '.js', '.mjs', '.mts', '.ts', '.tsx']);
const EXCLUDED_PATH_PATTERNS: readonly RegExp[] = [
  /(^|\/)node_modules\//u,
  /(^|\/)__tests__\//u,
  /(?:^|\/)[^/]+\.test\.tsx?$/u,
  /^scripts\/lib\/git-exec\.ts$/u,
];

export const GIT_EXEC_ALLOW_REGEX = /\/\/\s*git-exec-allow:\s*(\S.*)$/u;
export const MIN_ALLOW_REASON_LENGTH = 15;
export const WEAK_ALLOW_REASON_PATTERNS: ReadonlyArray<{ pattern: RegExp; label: string }> = [
  { pattern: /\bTODO\b/iu, label: 'TODO' },
  { pattern: /\bFIXME\b/iu, label: 'FIXME' },
  { pattern: /\bXXX\b/iu, label: 'XXX' },
  { pattern: /\bWIP\b/iu, label: 'WIP' },
  { pattern: /\btemp(orary)?\b/iu, label: 'temp/temporary' },
  { pattern: /\blater\b/iu, label: 'later' },
];

const DIRECT_ARRAY_GIT_CAPTURE_REGEX =
  /\b(?:execFileSync|spawnSync)\s*\(\s*(['"`])git\1(?=\s*[,)\n])/u;
const DIRECT_STRING_GIT_CAPTURE_REGEX =
  /\bexecSync\s*\(\s*(?:(['"])git(?:\s|\1)|`git(?:\s|`|\$\{))/u;
const INVOCATION_START_REGEX = /\b(?:execSync|execFileSync|spawnSync)\s*\(/u;
const CONTEXT_LINE_COUNT = 4;

export interface GitExecMaxbufferViolation {
  readonly file: string;
  readonly line: number;
  readonly snippet: string;
  readonly reason: string;
}

interface AllowCommentResult {
  readonly valid: boolean;
  readonly problem?: string;
}

function normalizePath(filePath: string): string {
  return filePath.replace(/\\/g, '/');
}

function isCommentOnlyLine(line: string): boolean {
  const trimmed = line.trim();
  return (
    trimmed.startsWith('//') ||
    trimmed.startsWith('*') ||
    trimmed.startsWith('/*') ||
    trimmed.startsWith('*/')
  );
}

export function validateAllowReason(reason: string): string | null {
  const trimmed = reason.trim();
  if (trimmed.length < MIN_ALLOW_REASON_LENGTH) {
    return `escape-hatch reason must be at least ${MIN_ALLOW_REASON_LENGTH} characters`;
  }

  const weakPattern = WEAK_ALLOW_REASON_PATTERNS.find(({ pattern }) => pattern.test(trimmed));
  if (weakPattern) {
    return `escape-hatch reason contains weak placeholder "${weakPattern.label}"`;
  }

  return null;
}

function allowCommentForLine(lines: readonly string[], index: number): AllowCommentResult | null {
  for (const candidateIndex of [index, index - 1]) {
    if (candidateIndex < 0) continue;

    const match = lines[candidateIndex].match(GIT_EXEC_ALLOW_REGEX);
    if (!match) continue;

    const problem = validateAllowReason(match[1]);
    if (problem) return { valid: false, problem };
    return { valid: true };
  }

  return null;
}

function lineContext(lines: readonly string[], index: number): string {
  return lines.slice(index, index + CONTEXT_LINE_COUNT).join('\n');
}

function matchesRawGitCapture(context: string): boolean {
  return (
    DIRECT_ARRAY_GIT_CAPTURE_REGEX.test(context) ||
    DIRECT_STRING_GIT_CAPTURE_REGEX.test(context)
  );
}

export function findGitExecMaxbufferViolations(
  sourceText: string,
  file = '<fixture>',
): GitExecMaxbufferViolation[] {
  const lines = sourceText.split(/\r?\n/u);
  const violations: GitExecMaxbufferViolation[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (isCommentOnlyLine(line)) continue;
    if (!INVOCATION_START_REGEX.test(line)) continue;

    const context = lineContext(lines, index);
    if (!matchesRawGitCapture(context)) continue;

    const allowComment = allowCommentForLine(lines, index);
    if (allowComment?.valid) continue;

    const reason = allowComment?.problem ?? 'raw child_process git capture bypasses scripts/lib/git-exec.ts';
    violations.push({
      file,
      line: index + 1,
      snippet: line.trim() || context.trim().split(/\r?\n/u)[0]?.trim() || '<empty line>',
      reason,
    });
  }

  return violations;
}

function shouldScanTrackedFile(file: string): boolean {
  const normalized = normalizePath(file);
  if (!normalized.startsWith('scripts/')) return false;
  if (!SOURCE_EXTENSIONS.has(extname(normalized))) return false;
  if (!existsSync(resolve(repoRoot, normalized))) return false;
  return !EXCLUDED_PATH_PATTERNS.some((pattern) => pattern.test(normalized));
}

function listTrackedScriptSourceFiles(): string[] {
  return gitCapture(['ls-files', 'scripts'], { cwd: repoRoot })
    .split('\n')
    .map((file) => normalizePath(file.trim()))
    .filter(Boolean)
    .filter(shouldScanTrackedFile);
}

function main(): number {
  const files = listTrackedScriptSourceFiles();
  const violations = files.flatMap((file) => {
    const sourceText = readFileSync(resolve(repoRoot, file), 'utf8');
    return findGitExecMaxbufferViolations(sourceText, file);
  });

  if (violations.length > 0) {
    console.error(`${PREFIX} FAIL: found ${violations.length} raw git capture violation(s).`);
    for (const violation of violations) {
      console.error(`\n${violation.file}:${violation.line}`);
      console.error(`  ${violation.snippet}`);
      console.error(`  reason: ${violation.reason}`);
      console.error(
        '  fix: route via gitCapture/gitCaptureShell from scripts/lib/git-exec.ts, ' +
          'or add `// git-exec-allow: <reason>`.',
      );
    }
    return 1;
  }

  console.log(`${PREFIX} PASS: scanned ${files.length} tracked scripts source file(s).`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main());
}
