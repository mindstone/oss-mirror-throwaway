#!/usr/bin/env npx tsx
/**
 * validate:startup-ipc-ordering
 *
 * Ensures startup IPC/domain registrations are not introduced after the first
 * executable `createWindow()` call in startup entrypoints. This catches
 * "handler not ready" startup races where renderer code can outpace main-process
 * registration.
 *
 * Scope:
 * - Files: src/main/index.ts, src/main/bootstrap.ts
 * - Rules after first createWindow():
 *   1) `ipcMain.handle(...)` -> always violation
 *   2) `register*Handlers(...)` -> always violation
 *   3) `ipcMain.on(...)` -> allowed only with a substantive prior sentinel:
 *      // STARTUP_LATE_REGISTRATION_OK: <reason>
 * - Exemptions:
 *   1) Registration is inside app.on('activate'|'second-instance', ...)
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { stripComments } from './lib/source-text';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

export const FILES_TO_CHECK = [
  'src/main/index.ts',
  'src/main/bootstrap.ts',
] as const;

const IPC_MAIN_HANDLE_REGEX = /\bipcMain\.handle\s*\(/u;
const IPC_MAIN_ON_REGEX = /\bipcMain\.on\s*\(/u;
const REGISTER_HANDLERS_REGEX = /\bregister[A-Za-z0-9_]*Handlers\s*\(/u;
const CREATE_WINDOW_CALL_REGEX = /(^|[^\w$.])(?:await\s+|void\s+)?createWindow\s*\(/u;
const CREATE_WINDOW_DECLARATION_REGEX = /\b(?:const|let|var|function)\s+createWindow\b/u;
const ALLOWED_APP_ON_REGEX = /\bapp\.on\s*\(\s*['"](activate|second-instance)['"]/gu;
const STARTUP_LATE_REGISTRATION_SENTINEL_REGEX =
  /^\s*\/\/\s*STARTUP_LATE_REGISTRATION_OK:\s*(\S.*)$/u;
const WEAK_SENTINEL_REASON_REGEX = /\b(?:todo|fixme|temp|temporary|wip|later|tbd|n\/a)\b/iu;
const SENTINEL_LOOKBACK_LINES = 3;

interface LineRange {
  startLine: number; // 0-based
  endLine: number;   // 0-based
}

export interface StartupIpcOrderingViolation {
  file: string;
  line: number; // 1-based
  createWindowLine: number; // 1-based
  kind: 'ipcMain.handle' | 'register*Handlers' | 'ipcMain.on';
  reason?: string;
  code: string;
}

export interface StartupIpcOrderingFileResult {
  file: string;
  createWindowLine: number | null; // 1-based
  violations: StartupIpcOrderingViolation[];
}

export interface StartupIpcOrderingResult {
  fileResults: StartupIpcOrderingFileResult[];
  violations: StartupIpcOrderingViolation[];
}

function stripStringLiteralsPreserveLayout(source: string): string {
  const out: string[] = [];
  let i = 0;

  while (i < source.length) {
    const ch = source[i];

    if (ch === '\'' || ch === '"' || ch === '`') {
      const quote = ch;
      out.push(' ');
      i += 1;

      while (i < source.length) {
        const current = source[i];

        if (current === '\\' && i + 1 < source.length) {
          out.push(' ');
          i += 1;
          const escaped = source[i];
          out.push(escaped === '\n' ? '\n' : ' ');
          i += 1;
          continue;
        }

        if (current === quote) {
          out.push(' ');
          i += 1;
          break;
        }

        if (current === '\n') {
          out.push('\n');
          i += 1;
          if (quote !== '`') break;
          continue;
        }

        out.push(' ');
        i += 1;
      }

      continue;
    }

    out.push(ch);
    i += 1;
  }

  return out.join('');
}

function computeLineStarts(source: string): number[] {
  const starts = [0];
  for (let i = 0; i < source.length; i += 1) {
    if (source[i] === '\n') starts.push(i + 1);
  }
  return starts;
}

function indexToLine(index: number, lineStarts: readonly number[]): number {
  let low = 0;
  let high = lineStarts.length - 1;

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const lineStart = lineStarts[mid];
    const nextLineStart = mid + 1 < lineStarts.length ? lineStarts[mid + 1] : Number.POSITIVE_INFINITY;

    if (index >= lineStart && index < nextLineStart) return mid;
    if (index < lineStart) {
      high = mid - 1;
    } else {
      low = mid + 1;
    }
  }

  return lineStarts.length - 1;
}

function findMatchingBraceEnd(source: string, startIndex: number): number | null {
  const openBraceIndex = source.indexOf('{', startIndex);
  if (openBraceIndex === -1) return null;

  let depth = 0;
  for (let i = openBraceIndex; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '{') depth += 1;
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }

  return null;
}

function findAllowedAppOnRanges(
  sourceForPatternMatch: string,
  sourceForBraceScan: string,
): LineRange[] {
  const ranges: LineRange[] = [];
  const lineStarts = computeLineStarts(sourceForBraceScan);
  ALLOWED_APP_ON_REGEX.lastIndex = 0;

  let match: RegExpExecArray | null;
  while ((match = ALLOWED_APP_ON_REGEX.exec(sourceForPatternMatch)) !== null) {
    const startIndex = match.index;
    const endIndex = findMatchingBraceEnd(sourceForBraceScan, startIndex);
    if (endIndex === null) continue;

    ranges.push({
      startLine: indexToLine(startIndex, lineStarts),
      endLine: indexToLine(endIndex, lineStarts),
    });
  }

  return ranges;
}

function isInLineRange(lineIndex: number, range: LineRange): boolean {
  return lineIndex >= range.startLine && lineIndex <= range.endLine;
}

export function findSentinelReason(rawLines: readonly string[], lineIndex: number): string | null {
  const lookbackStart = Math.max(0, lineIndex - SENTINEL_LOOKBACK_LINES);
  for (let i = lineIndex - 1; i >= lookbackStart; i -= 1) {
    const match = STARTUP_LATE_REGISTRATION_SENTINEL_REGEX.exec(rawLines[i] ?? '');
    if (match?.[1]) return match[1].trim();
  }
  return null;
}

export function hasSubstantiveSentinelReason(reason: string | null): boolean {
  if (!reason) return false;
  const trimmed = reason.trim();
  if (trimmed.length < 20) return false;
  if (WEAK_SENTINEL_REASON_REGEX.test(trimmed)) return false;
  return true;
}

export function findFirstCreateWindowCallLine(lines: readonly string[]): number {
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.includes('createWindow')) continue;
    if (CREATE_WINDOW_DECLARATION_REGEX.test(line)) continue;
    if (CREATE_WINDOW_CALL_REGEX.test(line)) return i;
  }
  return -1;
}

export function scanSourceForStartupIpcOrdering(
  sourceText: string,
  filePath: string,
): StartupIpcOrderingFileResult {
  const stripped = stripComments(sourceText);
  const sanitized = stripStringLiteralsPreserveLayout(stripped);
  const scanLines = sanitized.split('\n');
  const rawLines = sourceText.split('\n');

  const createWindowLineIndex = findFirstCreateWindowCallLine(scanLines);
  if (createWindowLineIndex === -1) {
    return { file: filePath, createWindowLine: null, violations: [] };
  }

  const allowedRanges = findAllowedAppOnRanges(stripped, sanitized);
  const violations: StartupIpcOrderingViolation[] = [];

  for (let lineIndex = createWindowLineIndex + 1; lineIndex < scanLines.length; lineIndex += 1) {
    const line = scanLines[lineIndex];
    if (allowedRanges.some((range) => isInLineRange(lineIndex, range))) continue;

    const isLateHandle = IPC_MAIN_HANDLE_REGEX.test(line);
    const isLateRegisterHandlers = REGISTER_HANDLERS_REGEX.test(line);
    const isLateIpcOn = IPC_MAIN_ON_REGEX.test(line);
    if (!isLateHandle && !isLateRegisterHandlers && !isLateIpcOn) continue;

    if (isLateIpcOn) {
      const sentinelReason = findSentinelReason(rawLines, lineIndex);
      if (hasSubstantiveSentinelReason(sentinelReason)) continue;
      violations.push({
        file: filePath,
        line: lineIndex + 1,
        createWindowLine: createWindowLineIndex + 1,
        kind: 'ipcMain.on',
        reason: sentinelReason ?? undefined,
        code: (rawLines[lineIndex] ?? '').trim(),
      });
      continue;
    }

    violations.push({
      file: filePath,
      line: lineIndex + 1,
      createWindowLine: createWindowLineIndex + 1,
      kind: isLateHandle ? 'ipcMain.handle' : 'register*Handlers',
      code: (rawLines[lineIndex] ?? '').trim(),
    });
  }

  return {
    file: filePath,
    createWindowLine: createWindowLineIndex + 1,
    violations,
  };
}

export function findStartupIpcOrderingViolations(options: {
  filesToCheck?: readonly string[];
  repoRoot?: string;
} = {}): StartupIpcOrderingResult {
  const filesToCheck = options.filesToCheck ?? FILES_TO_CHECK;
  const repoRoot = options.repoRoot ?? REPO_ROOT;

  const fileResults = filesToCheck.map((relativePath) => {
    const absolutePath = path.join(repoRoot, relativePath);
    const sourceText = readFileSync(absolutePath, 'utf8');
    return scanSourceForStartupIpcOrdering(sourceText, relativePath);
  });

  const violations = fileResults.flatMap((result) => result.violations);
  return { fileResults, violations };
}

export function main(): void {
  const result = findStartupIpcOrderingViolations();

  if (result.violations.length === 0) {
    console.log('✅ validate:startup-ipc-ordering passed');
    for (const fileResult of result.fileResults) {
      if (fileResult.createWindowLine == null) {
        console.log(`  • ${fileResult.file}: no createWindow() call found (skipped)`);
        continue;
      }
      console.log(`  • ${fileResult.file}: first createWindow() call at line ${fileResult.createWindowLine}`);
    }
    return;
  }

  console.error(`❌ validate:startup-ipc-ordering failed (${result.violations.length} violation(s))`);
  for (const violation of result.violations) {
    const suffix = violation.kind === 'ipcMain.on' && violation.reason
      ? ` (non-substantive sentinel reason: "${violation.reason}")`
      : '';
    console.error(`  • ${violation.file}:${violation.line} — ${violation.kind} after createWindow() at line ${violation.createWindowLine}${suffix}`);
    console.error(`    ${violation.code}`);
  }

  console.error('\nFix one of the following:');
  console.error('  1) Move registration above the first createWindow() call.');
  console.error("  2) Register inside app.on('activate'|'second-instance', ...) callback.");
  console.error('  3) For a late one-way ipcMain.on() only, add // STARTUP_LATE_REGISTRATION_OK: <substantive reason> within 3 lines above it.');
  process.exit(1);
}

const invokedDirectly = process.argv[1] === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main();
}
