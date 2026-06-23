#!/usr/bin/env npx tsx
/**
 * CI validation: enforce boundary-registry forbidden_terms on changed lines.
 *
 * Default mode scans only added lines from `git diff -U0 HEAD` (or staged diff
 * via --staged). `--all-files` scans every tracked line in matched files for
 * baseline rollouts.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadRegistry,
  matchPaths,
  normalize,
  type CompiledEntry,
} from './boundary-hints.js';
import { gitCapture } from './lib/git-exec.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_REGISTRY_PATH = join(repoRoot, 'docs/project/boundary-registry.yaml');
const HUNK_HEADER_REGEX = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;
const ESCAPE_HATCH_REGEX = /\/\/\s*boundary-allow:\s*([a-z0-9][a-z0-9-]*)\s*—\s*(.+)$/u;

export interface Violation {
  file: string;
  line: number;
  entryId: string;
  pattern: string;
  matchedText: string;
}

export interface ChangedLine {
  file: string;
  line: number;
  text: string;
}

type DiffQuery =
  | { mode: 'name-only'; staged: boolean }
  | { mode: 'file-diff'; staged: boolean; file: string };

export type DiffProvider = (query: DiffQuery, cwd: string) => string;

function defaultDiffProvider(query: DiffQuery, cwd: string): string {
  if (query.mode === 'name-only') {
    const args = query.staged
      ? ['diff', '--cached', '--name-only']
      : ['diff', '--name-only', 'HEAD'];
    return gitCapture(args, { cwd });
  }

  const args = query.staged
    ? ['diff', '--cached', '-U0', '--', query.file]
    : ['diff', '-U0', 'HEAD', '--', query.file];
  return gitCapture(args, { cwd });
}

function defaultTrackedFilesProvider(cwd: string): string[] {
  const output = gitCapture(['ls-files'], { cwd });
  return output
    .split('\n')
    .filter(Boolean)
    .map((file) => normalize(file));
}

function parsePatchPath(rawPath: string): string | null {
  const trimmed = rawPath.trim();
  if (!trimmed || trimmed === '/dev/null') return null;
  if (trimmed.startsWith('a/') || trimmed.startsWith('b/')) {
    return normalize(trimmed.slice(2));
  }
  return normalize(trimmed);
}

/**
 * Parse unified diff output and return only added lines (+), each with target
 * file + target line number.
 */
export function parseUnifiedDiff(diffOutput: string): ChangedLine[] {
  const changedLines: ChangedLine[] = [];
  const lines = diffOutput.split('\n');

  let currentFile: string | null = null;
  let currentLineNumber = 0;
  let inHunk = false;

  for (const line of lines) {
    if (line.startsWith('+++ ')) {
      currentFile = parsePatchPath(line.slice(4));
      inHunk = false;
      continue;
    }

    if (line.startsWith('@@ ')) {
      const match = line.match(HUNK_HEADER_REGEX);
      if (!match) {
        inHunk = false;
        continue;
      }
      currentLineNumber = Number.parseInt(match[1], 10);
      inHunk = true;
      continue;
    }

    if (!inHunk || !currentFile) continue;

    if (line.startsWith('+') && !line.startsWith('+++')) {
      changedLines.push({
        file: currentFile,
        line: currentLineNumber,
        text: line.slice(1),
      });
      currentLineNumber += 1;
      continue;
    }

    if (line.startsWith('-') && !line.startsWith('---')) {
      continue;
    }

    if (line.startsWith(' ')) {
      currentLineNumber += 1;
    }
  }

  return changedLines;
}

export function hasEscapeHatch(lineText: string, entryId: string): boolean {
  const match = lineText.match(ESCAPE_HATCH_REGEX);
  if (!match) return false;
  const [, matchedEntryId, reason] = match;
  return matchedEntryId === entryId && reason.trim().length > 0;
}

export function checkLineAgainstEntry(line: ChangedLine, entry: CompiledEntry): Violation | null {
  if (hasEscapeHatch(line.text, entry.id)) return null;

  const patterns = entry.forbidden_terms ?? [];
  for (let i = 0; i < entry.forbiddenRegexes.length; i += 1) {
    const regex = entry.forbiddenRegexes[i];
    regex.lastIndex = 0;
    const match = regex.exec(line.text);
    if (!match) continue;

    return {
      file: line.file,
      line: line.line,
      entryId: entry.id,
      pattern: patterns[i] ?? regex.source,
      matchedText: match[0],
    };
  }

  return null;
}

function parseNameOnlyOutput(output: string): string[] {
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((file) => normalize(file));
}

function getFullFileLines(file: string, cwd: string, fileReader: (path: string) => string): ChangedLine[] {
  const absolutePath = resolve(cwd, file);
  if (!existsSync(absolutePath)) return [];

  const source = fileReader(absolutePath);
  const lines = source.split(/\r?\n/);
  return lines.map((text, index) => ({
    file,
    line: index + 1,
    text,
  }));
}

async function fileMatchesEntry(file: string, entry: CompiledEntry, cwd: string): Promise<boolean> {
  return matchPaths(entry.match.paths, entry.match.exclude_paths ?? [], new Set([file]), cwd);
}

export async function findForbiddenTermViolations(opts: {
  allFiles?: boolean;
  staged?: boolean;
  registryPath?: string;
  cwdOverride?: string;
  diffProvider?: DiffProvider;
  fileReader?: (path: string) => string;
  trackedFilesProvider?: (cwd: string) => string[];
} = {}): Promise<{ violations: Violation[]; warnings: string[] }> {
  const cwd = opts.cwdOverride ?? repoRoot;
  const staged = opts.staged ?? false;
  const registryPath = opts.registryPath
    ? resolve(cwd, opts.registryPath)
    : DEFAULT_REGISTRY_PATH;

  const loaded = await loadRegistry(registryPath, cwd);
  // loadRegistry already compiles entries (regexes, validation). Filter to
  // entries that have forbidden_terms — no need to recompile.
  const entries = loaded.entries
    .filter((entry) => entry.forbidden_terms && entry.forbidden_terms.length > 0);

  if (entries.length === 0) {
    return { violations: [], warnings: loaded.warnings };
  }

  const diffProvider = opts.diffProvider ?? defaultDiffProvider;
  const fileReader = opts.fileReader ?? ((path) => readFileSync(path, 'utf8'));
  const trackedFilesProvider = opts.trackedFilesProvider ?? defaultTrackedFilesProvider;

  const candidateFiles = opts.allFiles
    ? trackedFilesProvider(cwd)
    : parseNameOnlyOutput(diffProvider({ mode: 'name-only', staged }, cwd));

  const uniqueFiles = [...new Set(candidateFiles.map((file) => normalize(file)))];
  const linesByFile = new Map<string, ChangedLine[]>();
  for (const file of uniqueFiles) {
    const lines = opts.allFiles
      ? getFullFileLines(file, cwd, fileReader)
      : parseUnifiedDiff(diffProvider({ mode: 'file-diff', staged, file }, cwd)).filter(
        (line) => normalize(line.file) === file
      );
    if (lines.length > 0) {
      linesByFile.set(file, lines);
    }
  }

  const violations: Violation[] = [];

  for (const entry of entries) {
    for (const [file, linesToScan] of linesByFile) {
      if (!(await fileMatchesEntry(file, entry, cwd))) continue;

      for (const line of linesToScan) {
        const violation = checkLineAgainstEntry(line, entry);
        if (violation) violations.push(violation);
      }
    }
  }

  return { violations, warnings: loaded.warnings };
}

interface CliArgs {
  allFiles: boolean;
  staged: boolean;
  registryPath?: string;
}

function parseCliArgs(argv: string[]): CliArgs {
  const args: CliArgs = { allFiles: false, staged: false };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--all-files') {
      args.allFiles = true;
      continue;
    }
    if (arg === '--staged') {
      args.staged = true;
      continue;
    }
    if (arg === '--registry') {
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) {
        throw new Error('--registry requires a path value');
      }
      args.registryPath = next;
      i += 1;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      process.stdout.write(
        'Usage: npx tsx scripts/check-boundary-forbidden-terms.ts [--all-files] [--staged] [--registry <path>]\n'
      );
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (args.registryPath !== undefined && !args.registryPath.trim()) {
    throw new Error('--registry requires a non-empty path');
  }

  return args;
}

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2));
  const result = await findForbiddenTermViolations({
    allFiles: args.allFiles,
    staged: args.staged,
    registryPath: args.registryPath,
  });

  for (const warning of result.warnings) {
    process.stderr.write(`[boundary-forbidden-terms] warning: ${warning}\n`);
  }

  if (result.violations.length > 0) {
    for (const violation of result.violations) {
      process.stderr.write(
        `${violation.file}:${violation.line} [${violation.entryId}] matched: ${violation.pattern}\n`
      );
    }
    process.exit(1);
  }

  process.stdout.write('Boundary forbidden terms check passed.\n');
  process.exit(0);
}

const invokedAsScript = (() => {
  if (!process.argv[1]) return false;
  try {
    const entry = resolve(process.argv[1]);
    const thisFile = fileURLToPath(import.meta.url);
    return entry === thisFile;
  } catch {
    return false;
  }
})();

if (invokedAsScript) {
  main().catch((error) => {
    process.stderr.write(`[boundary-forbidden-terms] ${String(error)}\n`);
    process.exit(2);
  });
}
