#!/usr/bin/env npx tsx
/**
 * CI Validation: plan-doc pointer comments.
 *
 * Source comments often signpost future agents to load-bearing planning docs.
 * This check keeps those comments honest by verifying that every
 * `docs/plans/*.md` reference found in source comments resolves to a real file.
 *
 * Run: npx tsx scripts/check-pointer-comments.ts
 * Wired into: npm run validate:fast
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fg from 'fast-glob';

export const DEFAULT_SOURCE_GLOBS = ['src/**/*.ts', 'src/**/*.tsx'] as const;

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PLAN_POINTER_PATTERN = /\bdocs\/plans\/[A-Za-z0-9._/-]+?\.md\b/g;

export interface PointerComment {
  file: string;
  line: number;
  pointerPath: string;
}

export interface PointerCommentCheckOptions {
  repoRoot?: string;
  sourceGlobs?: readonly string[];
}

export interface PointerCommentCheckResult {
  ok: boolean;
  pointers: PointerComment[];
  missingPointers: PointerComment[];
  report: string;
}

interface SourceComment {
  text: string;
  start: number;
}

function toPosixPath(filePath: string): string {
  return filePath.split(path.sep).join('/');
}

function displayPath(repoRoot: string, filePath: string): string {
  const relativePath = path.relative(repoRoot, filePath);
  return toPosixPath(relativePath.startsWith('..') ? filePath : relativePath);
}

function resolvePointer(repoRoot: string, pointerPath: string): string {
  return path.resolve(repoRoot, pointerPath);
}

function pointerExists(repoRoot: string, pointerPath: string): boolean {
  const resolvedPath = resolvePointer(repoRoot, pointerPath);
  const normalizedRoot = path.resolve(repoRoot);
  if (resolvedPath !== normalizedRoot && !resolvedPath.startsWith(`${normalizedRoot}${path.sep}`)) {
    return false;
  }

  try {
    return fs.statSync(resolvedPath).isFile();
  } catch {
    return false;
  }
}

export function findPointerCommentsInSource(
  source: string,
  filePath: string,
): PointerComment[] {
  const comments = extractSourceComments(source);
  const lineStarts = computeLineStarts(source);
  const pointers: PointerComment[] = [];

  for (const comment of comments) {
    PLAN_POINTER_PATTERN.lastIndex = 0;

    let match: RegExpExecArray | null;
    while ((match = PLAN_POINTER_PATTERN.exec(comment.text)) !== null) {
      const pointerPath = match[0];
      pointers.push({
        file: filePath,
        line: lineNumberAtPosition(lineStarts, comment.start + match.index),
        pointerPath,
      });
    }
  }

  return pointers;
}

function extractSourceComments(source: string): SourceComment[] {
  const comments: SourceComment[] = [];
  let index = 0;

  while (index < source.length) {
    const current = source[index];
    const next = source[index + 1];

    if (current === '/' && next === '/') {
      const start = index;
      index += 2;
      while (index < source.length && source[index] !== '\n' && source[index] !== '\r') {
        index += 1;
      }
      comments.push({ text: source.slice(start, index), start });
      continue;
    }

    if (current === '/' && next === '*') {
      const start = index;
      index += 2;
      while (index < source.length && !(source[index] === '*' && source[index + 1] === '/')) {
        index += 1;
      }
      index = Math.min(index + 2, source.length);
      comments.push({ text: source.slice(start, index), start });
      continue;
    }

    if (current === '"' || current === '\'' || current === '`') {
      index = skipQuotedLiteral(source, index, current);
      continue;
    }

    index += 1;
  }

  return comments;
}

function skipQuotedLiteral(source: string, start: number, quote: string): number {
  let index = start + 1;
  while (index < source.length) {
    if (source[index] === '\\') {
      index += 2;
      continue;
    }
    if (source[index] === quote) {
      return index + 1;
    }
    index += 1;
  }
  return source.length;
}

function computeLineStarts(source: string): number[] {
  const starts = [0];
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === '\n') {
      starts.push(index + 1);
    }
  }
  return starts;
}

function lineNumberAtPosition(lineStarts: readonly number[], position: number): number {
  let low = 0;
  let high = lineStarts.length - 1;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    if (lineStarts[mid] <= position) {
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return high + 1;
}

async function collectSourceFiles(
  repoRoot: string,
  sourceGlobs: readonly string[],
): Promise<string[]> {
  const files = await fg([...sourceGlobs], {
    cwd: repoRoot,
    absolute: true,
    onlyFiles: true,
    unique: true,
    ignore: [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '**/.vite/**',
    ],
  });

  return files.sort((a, b) => a.localeCompare(b));
}

function buildReport(
  repoRoot: string,
  pointers: PointerComment[],
  missingPointers: PointerComment[],
): string {
  const verifiedCount = pointers.length - missingPointers.length;
  const lines = [
    'Plan pointer comments check',
    '===========================',
    `Pointers found: ${pointers.length}`,
    `Pointers verified: ${verifiedCount}`,
    `Pointers failed: ${missingPointers.length}`,
  ];

  if (missingPointers.length > 0) {
    lines.push('', 'Missing plan-doc pointer target(s):');
    for (const pointer of missingPointers) {
      lines.push(
        `  - ${displayPath(repoRoot, pointer.file)}:${pointer.line} -> ${pointer.pointerPath}`,
      );
    }
  }

  return lines.join('\n');
}

export async function checkPointerComments(
  options: PointerCommentCheckOptions = {},
): Promise<PointerCommentCheckResult> {
  const repoRoot = path.resolve(options.repoRoot ?? REPO_ROOT);
  const sourceGlobs = options.sourceGlobs ?? DEFAULT_SOURCE_GLOBS;
  const files = await collectSourceFiles(repoRoot, sourceGlobs);
  const pointers: PointerComment[] = [];

  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    pointers.push(...findPointerCommentsInSource(source, file));
  }

  const missingPointers = pointers.filter((pointer) =>
    !pointerExists(repoRoot, pointer.pointerPath),
  );

  return {
    ok: missingPointers.length === 0,
    pointers,
    missingPointers,
    report: buildReport(repoRoot, pointers, missingPointers),
  };
}

function parseArgs(argv: readonly string[]): PointerCommentCheckOptions {
  const options: PointerCommentCheckOptions = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--repo-root') {
      const value = argv[index + 1];
      if (!value) {
        throw new Error('--repo-root requires a path argument');
      }
      options.repoRoot = value;
      index += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

const invokedDirectly = process.argv[1] === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  let options: PointerCommentCheckOptions;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }

  checkPointerComments(options)
    .then((result) => {
      const output = result.ok ? console.log : console.error;
      output(result.report);
      if (!result.ok) {
        process.exit(1);
      }
    })
    .catch((error: unknown) => {
      console.error('Unexpected error in check-pointer-comments:', error);
      process.exit(1);
    });
}
