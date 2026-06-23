/**
 * SearchFiles — built-in tool for searching file contents.
 *
 * Uses a 3-tier fallback chain:
 *   1. `rg` (ripgrep) — fastest, structured JSON output
 *   2. `grep -rn` — available on macOS/Linux
 *   3. Pure Node.js — works everywhere (Windows, no CLI tools)
 *
 * @see docs/plans/260411_restore_web_and_search_builtin_tools.md
 */

import { execFile } from 'node:child_process';
import { open } from 'node:fs/promises';
import path from 'node:path';
import { createScopedLogger } from '@core/logger';
import { readFileLines, STOP_READING_FILE_LINES } from '@core/utils/readLines';
import { safeWalkDirectory } from '@core/utils/safeWalkDirectory';
import { workspaceFs } from '@core/services/boundedWorkspaceFs';
import { ignoreBestEffortCleanup } from '@shared/utils/intentionalSwallow';
import type { BuiltinToolContext, ToolExecutionResult } from '../types';
import type { ToolDefinition } from '../modelTypes';
import {
  buildGrepCloudExcludeArgs,
  buildRgCloudExcludeArgs,
  collectIncidentalCloudExclusions,
  type CloudExclusion,
} from './cloudSubprocessExclusion';

const log = createScopedLogger({ service: 'searchFilesTool' });

// ── Constants ──────────────────────────────────────────────────────────

const DEFAULT_MAX_RESULTS = 50;
const MAX_RESULTS_CAP = 200;
const CLI_TIMEOUT_MS = 30_000;
const NODE_MAX_FILES = 10_000;
const LINE_CONTENT_MAX_CHARS = 200;
const BINARY_CHECK_BYTES = 512;

/** Directories to always skip. */
const EXCLUDED_DIRS = ['.git', 'node_modules', '__pycache__', '.DS_Store'];

// ── Tool Definition ────────────────────────────────────────────────────

export const SEARCH_FILES_TOOL_DEFINITION: ToolDefinition = {
  name: 'SearchFiles',
  description:
    'Search for a text pattern across files in a directory. Returns matching lines with file paths and line numbers. ' +
    'Use this to find specific content, function definitions, or references across a codebase or document folder.',
  input_schema: {
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        description: 'The text pattern to search for (supports regular expressions).',
      },
      path: {
        type: 'string',
        description: 'Directory to search in. Defaults to the current workspace.',
      },
      maxResults: {
        type: 'integer',
        minimum: 1,
        description: 'Maximum number of matching lines to return (default 50, max 200).',
      },
      caseSensitive: {
        type: 'boolean',
        description: 'Whether the search should be case-sensitive (default false).',
      },
      followSymlinks: {
        type: 'boolean',
        description: 'Whether to follow symbolic links (default true).',
      },
      includeHidden: {
        type: 'boolean',
        description: 'Whether to include hidden files and directories (default false).',
      },
    },
    required: ['pattern'],
  },
};

// ── Types ──────────────────────────────────────────────────────────────

interface SearchFileResult {
  file: string;   // relative path from searchPath
  line: number;
  content: string; // truncated to LINE_CONTENT_MAX_CHARS
}

interface SearchParams {
  pattern: string;
  searchPath: string;
  maxResults: number;
  caseSensitive: boolean;
  followSymlinks: boolean;
  includeHidden: boolean;
}

// ── Helpers ────────────────────────────────────────────────────────────

/** Truncate a line to max chars, appending ellipsis if needed. */
function truncateLine(line: string): string {
  const trimmed = line.trimEnd();
  if (trimmed.length <= LINE_CONTENT_MAX_CHARS) return trimmed;
  return trimmed.slice(0, LINE_CONTENT_MAX_CHARS) + '...';
}

/** Check if a directory name should be excluded. */
function isExcludedDir(name: string): boolean {
  return EXCLUDED_DIRS.includes(name);
}

/** Format results as markdown output. */
function formatResults(
  results: SearchFileResult[],
  totalMatches: number,
  maxResults: number,
  truncationReasons: readonly string[] = [],
): string {
  if (results.length === 0) return '';

  // Group by file
  const byFile = new Map<string, SearchFileResult[]>();
  for (const r of results) {
    const existing = byFile.get(r.file);
    if (existing) {
      existing.push(r);
    } else {
      byFile.set(r.file, [r]);
    }
  }

  const lines: string[] = [];
  lines.push(`Found ${totalMatches} match${totalMatches === 1 ? '' : 'es'} in ${byFile.size} file${byFile.size === 1 ? '' : 's'}:`);
  lines.push('');

  for (const [file, matches] of byFile) {
    lines.push(`**${file}**`);
    for (const m of matches) {
      lines.push(`  Line ${m.line}: ${m.content}`);
    }
    lines.push('');
  }

  if (totalMatches > maxResults) {
    lines.push(`[${totalMatches - maxResults} more result${totalMatches - maxResults === 1 ? '' : 's'} omitted]`);
  }

  if (truncationReasons.length > 0) {
    lines.push(`[results may be incomplete: ${truncationReasons.join(', ')}]`);
  }

  return lines.join('\n').trimEnd();
}

// ── Tier 1: ripgrep ────────────────────────────────────────────────────

interface RgJsonMatch {
  type: string;
  data?: {
    path?: { text?: string };
    line_number?: number;
    lines?: { text?: string };
  };
}

function parseRgJson(stdout: string, searchPath: string, maxResults: number): { results: SearchFileResult[]; totalMatches: number } {
  const results: SearchFileResult[] = [];
  let totalMatches = 0;

  const lines = stdout.split('\n').filter(l => l.trim().length > 0);
  for (const line of lines) {
    let parsed: RgJsonMatch;
    try {
      parsed = JSON.parse(line) as RgJsonMatch;
    } catch {
      continue;
    }

    if (parsed.type !== 'match' || !parsed.data) continue;

    totalMatches++;
    if (results.length >= maxResults) continue;

    const filePath = parsed.data.path?.text ?? '';
    const lineNum = parsed.data.line_number ?? 0;
    const content = parsed.data.lines?.text ?? '';

    results.push({
      file: path.relative(searchPath, filePath),
      line: lineNum,
      content: truncateLine(content),
    });
  }

  return { results, totalMatches };
}

function tryRg(
  params: SearchParams,
  cloudExclusions: readonly CloudExclusion[],
): Promise<{ results: SearchFileResult[]; totalMatches: number } | null> {
  // Skip rg on Windows — rarely available
  if (process.platform === 'win32') return Promise.resolve(null);

  return new Promise((resolve) => {
    const args = [
      '--json', '-n',
      '--max-count', String(params.maxResults + 1),
      ...(params.followSymlinks ? ['--follow'] : []),
      ...(params.caseSensitive ? [] : ['-i']),
      ...(params.includeHidden ? ['--hidden'] : []),
      '--glob', '!.git',
      '--glob', '!node_modules',
      '--glob', '!__pycache__',
      '--glob', '!.DS_Store',
      // Cloud policy (Stage 9): exclude incidental cloud symlinks so `--follow`
      // never descends into a dead FUSE mount and hangs (readlink-only derived).
      ...buildRgCloudExcludeArgs(cloudExclusions),
      '-e', params.pattern,
      '--', params.searchPath,
    ];

    execFile('rg', args, { timeout: CLI_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        // ENOENT = rg not installed; exit code 1 = no matches (not an error)
        const code = (error as NodeJS.ErrnoException).code;
        const exitCode = error.code as unknown;
        if (code === 'ENOENT') {
          resolve(null); // Fall through to next tier
          return;
        }
        if (exitCode === 1 && (!stderr || stderr.trim().length === 0)) {
          // Exit code 1 with no stderr = no matches found
          resolve({ results: [], totalMatches: 0 });
          return;
        }
        if (stderr && stderr.trim().length > 0) {
          // Real error
          resolve(null);
          return;
        }
        resolve(null);
        return;
      }

      const parsed = parseRgJson(stdout, params.searchPath, params.maxResults);
      resolve(parsed);
    });
  });
}

// ── Tier 2: grep ───────────────────────────────────────────────────────

function parseGrepOutput(stdout: string, searchPath: string, maxResults: number): { results: SearchFileResult[]; totalMatches: number } {
  const results: SearchFileResult[] = [];
  let totalMatches = 0;

  const lines = stdout.split('\n').filter(l => l.trim().length > 0);
  for (const line of lines) {
    // grep output: file:line:content
    // On Windows paths, drive letter creates ambiguity: C:\path:10:content
    // We handle this by finding the first colon after the file path
    const match = /^(.+?):(\d+):(.*)$/.exec(line);
    if (!match) continue;

    const filePath = match[1];
    const lineNum = parseInt(match[2], 10);
    const content = match[3];

    totalMatches++;
    if (results.length >= maxResults) continue;

    results.push({
      file: path.relative(searchPath, filePath),
      line: lineNum,
      content: truncateLine(content),
    });
  }

  return { results, totalMatches };
}

function tryGrep(
  params: SearchParams,
  cloudExclusions: readonly CloudExclusion[],
): Promise<{ results: SearchFileResult[]; totalMatches: number } | null> {
  // Skip grep on Windows — not available
  if (process.platform === 'win32') return Promise.resolve(null);

  return new Promise((resolve) => {
    const args = [
      '-rn',
      ...(params.followSymlinks ? ['-L'] : []),
      ...(params.caseSensitive ? [] : ['-i']),
      '--binary-files=without-match',
      '--exclude-dir=.git',
      '--exclude-dir=node_modules',
      '--exclude-dir=__pycache__',
      // Cloud policy (Stage 9): exclude incidental cloud symlinks so `-L` (follow)
      // never descends into a dead FUSE mount and hangs (readlink-only derived).
      ...buildGrepCloudExcludeArgs(cloudExclusions),
      '-e', params.pattern,
      '--', params.searchPath,
    ];

    execFile('grep', args, { timeout: CLI_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        const code = (error as NodeJS.ErrnoException).code;
        const exitCode = error.code as unknown;
        if (code === 'ENOENT') {
          resolve(null); // Fall through to Node.js
          return;
        }
        if (exitCode === 1 && (!stderr || stderr.trim().length === 0)) {
          // Exit code 1 = no matches
          resolve({ results: [], totalMatches: 0 });
          return;
        }
        resolve(null);
        return;
      }

      const parsed = parseGrepOutput(stdout, params.searchPath, params.maxResults);
      resolve(parsed);
    });
  });
}

// ── Tier 3: Pure Node.js ───────────────────────────────────────────────

/** Check if a file is binary by examining first bytes for null characters. */
async function isBinaryFile(filePath: string): Promise<boolean> {
  let fileHandle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    fileHandle = await open(filePath, 'r');
    const buffer = Buffer.alloc(BINARY_CHECK_BYTES);
    const { bytesRead } = await fileHandle.read(buffer, 0, BINARY_CHECK_BYTES, 0);
    for (let i = 0; i < bytesRead; i++) {
      if (buffer[i] === 0) return true;
    }
    return false;
  } catch {
    return true; // If can't read, treat as binary
  } finally {
    if (fileHandle) {
      try {
        await fileHandle.close();
      } catch (error) {
        ignoreBestEffortCleanup(error, {
          operation: 'searchfiles-binary-sniff-close',
          reason: 'best effort cleanup after binary sniff read',
        });
      }
    }
  }
}

async function searchWithNode(
  params: SearchParams,
): Promise<{ results: SearchFileResult[]; totalMatches: number; truncationReasons: readonly string[] }> {
  const results: SearchFileResult[] = [];
  let totalMatches = 0;
  const startTime = Date.now();

  // Build regex from pattern
  let regex: RegExp;
  try {
    regex = new RegExp(params.pattern, params.caseSensitive ? '' : 'i');
  } catch {
    // Invalid regex — treat as literal string
    const escaped = params.pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    regex = new RegExp(escaped, params.caseSensitive ? '' : 'i');
  }

  // Collect files recursively via the shared `safeWalkDirectory` (Stage 9). This
  // is what gives the Node tier the SAME cloud policy as the rest of the app:
  //  - default-on `skipCloudSymlinkTargets` → an INCIDENTAL cloud symlink reached
  //    during descent is classified READLINK-ONLY and skipped (never `realpath`/
  //    `stat` the dead mount — the libuv-pool hang this walker could trigger today
  //    via its `stat(fullPath)` on a cloud symlink);
  //  - the explicit named-cloud-ROOT carve-out is preserved (the root is resolved
  //    up front and never hits the skip), so on-demand search of a folder the
  //    user named still works (bounded by the cloud budget);
  //  - admission (flag on + healthy verdict) descends into a healthy cloud space.
  // Cycle detection, depth/path-length/entries caps come for free. We preserve the
  // tool's prior semantics: excluded dirs, hidden-file filtering, the
  // `followSymlinks` contract, and the `NODE_MAX_FILES` collection cap.
  const filesToSearch: string[] = [];
  let hitFileCap = false;

  // Preserve the prior collection-phase wall-clock bound (a huge local tree must
  // not run unbounded): drive a timer-backed `AbortSignal` that `safeWalkDirectory`
  // honours between entries. The cloud-hang protection is structural (readlink-only
  // skip + cloud-budget bounds inside the walker); this timer is the local-tree
  // defence the old hand-rolled `Date.now()` check provided.
  const walkController = new AbortController();
  const walkTimer = setTimeout(() => walkController.abort(), CLI_TIMEOUT_MS);
  let walkResult: Awaited<ReturnType<typeof safeWalkDirectory>>;
  try {
    walkResult = await safeWalkDirectory(params.searchPath, {
      signal: walkController.signal,
      onFile: ({ absolutePath, name, viaSymlink }) => {
        if (hitFileCap) return;
        if (!params.followSymlinks && viaSymlink) return;
        if (!params.includeHidden && name.startsWith('.')) return;
        // Exclude entries under any excluded directory (matches the prior walker,
        // which skipped descending into them).
        const rel = path.relative(params.searchPath, absolutePath);
        const segments = rel.split(path.sep);
        if (segments.some((seg) => isExcludedDir(seg))) return;
        if (filesToSearch.length >= NODE_MAX_FILES) {
          hitFileCap = true;
          return;
        }
        filesToSearch.push(absolutePath);
      },
      onDirectory: ({ name, isSymbolicLink }) => {
        if (hitFileCap) return false;
        if (!params.followSymlinks && isSymbolicLink) return false;
        if (!params.includeHidden && name.startsWith('.')) return false;
        if (isExcludedDir(name)) return false;
        return true;
      },
    });
  } finally {
    clearTimeout(walkTimer);
  }

  // Search each file line by line
  let shouldStopScanning = false;
  for (const filePath of filesToSearch) {
    if (shouldStopScanning) break;
    if (Date.now() - startTime > CLI_TIMEOUT_MS) break;

    // Binary detection
    if (await isBinaryFile(filePath)) continue;

    try {
      await readFileLines(filePath, (line, lineNum) => {
        if (regex.test(line)) {
          totalMatches++;
          if (results.length < params.maxResults) {
            results.push({
              file: path.relative(params.searchPath, filePath),
              line: lineNum,
              content: truncateLine(line),
            });
          }
        }

        // Early exit if we have enough matches and don't need exact total
        if (totalMatches > params.maxResults + 100) {
          shouldStopScanning = true;
          return STOP_READING_FILE_LINES;
        }
        return undefined;
      }, {
        encoding: 'utf8',
        crlfDelay: Infinity,
      });
    } catch {
      // Skip files that can't be read
    }
  }

  // Surface the walk's incompleteness (F3, silent-failure rule). `safeWalkDirectory`
  // applies caps the prior hand-rolled walker lacked (MAX_DEPTH 12 / MAX_ENTRIES
  // 50_000 / MAX_PATH_LENGTH 900) plus permission/unreadable/abort/cloud reasons; a
  // tree deeper than 12 (or wider than 50k entries) would otherwise be silently
  // truncated. Pass the reasons through so the agent/user sees "results may be
  // incomplete", consistent with how Glob and lsTool report truncation.
  const truncationReasons: string[] = [...walkResult.truncatedReasons];
  if (hitFileCap) {
    truncationReasons.push(`hit SearchFiles' ${NODE_MAX_FILES}-file collection cap`);
  }

  return { results, totalMatches, truncationReasons };
}

// ── Executor ───────────────────────────────────────────────────────────

export async function executeSearchFiles(
  input: unknown,
  context: BuiltinToolContext,
): Promise<ToolExecutionResult> {
  if (input == null || typeof input !== 'object' || Array.isArray(input)) {
    return { output: 'SearchFiles requires a valid input object.', isError: true };
  }
  const params = input as Record<string, unknown>;
  const startTime = Date.now();

  // ── Validate input ─────────────────────────────────────────────────
  const pattern = params.pattern;
  if (typeof pattern !== 'string' || pattern.trim().length === 0) {
    return { output: 'SearchFiles requires a search pattern.', isError: true };
  }

  const maxResults = Math.min(
    typeof params.maxResults === 'number' && params.maxResults > 0
      ? Math.floor(params.maxResults)
      : DEFAULT_MAX_RESULTS,
    MAX_RESULTS_CAP,
  );

  const caseSensitive = params.caseSensitive === true;
  const followSymlinks = params.followSymlinks !== false; // default true
  const includeHidden = params.includeHidden === true;

  // ── Resolve search path ────────────────────────────────────────────
  const inputPath = typeof params.path === 'string' && params.path.trim().length > 0
    ? params.path.trim()
    : undefined;

  const searchPath = inputPath
    ? (path.isAbsolute(inputPath) ? inputPath : path.resolve(context.cwd ?? process.cwd(), inputPath))
    : (context.cwd ?? process.cwd());

  // Validate the requested root through the BOUNDED workspace-fs boundary (S5): a
  // configured cloud space addressed by its logical workspace path is containment-
  // cloud, so a bare `access`/`stat` here would dereference the symlink into a
  // possibly-dead mount and block before any bounded tier. The boundary routes it to
  // the killable cloud lane → a dead mount degrades to `reconnecting`, never a hang.
  const rootAccess = await workspaceFs.access(searchPath);
  if (rootAccess.status === 'reconnecting') {
    return { output: `Cannot access path (cloud space reconnecting): ${searchPath}`, isError: true };
  }
  if (rootAccess.status === 'error') {
    return { output: `Directory not found: ${searchPath}`, isError: true };
  }
  const rootStat = await workspaceFs.stat(searchPath);
  if (rootStat.status === 'reconnecting') {
    return { output: `Cannot access path (cloud space reconnecting): ${searchPath}`, isError: true };
  }
  if (rootStat.status === 'error') {
    return { output: `Cannot access path: ${searchPath}`, isError: true };
  }
  if (!rootStat.value.isDirectory) {
    return { output: `Path is not a directory: ${searchPath}`, isError: true };
  }

  const searchParams: SearchParams = {
    pattern,
    searchPath,
    maxResults,
    caseSensitive,
    followSymlinks,
    includeHidden,
  };

  // Log search metadata (never log pattern text or file contents)
  log.info(
    { searchPath, patternLength: pattern.length, maxResults, caseSensitive },
    'SearchFiles: starting search',
  );

  // Cloud policy (Stage 9): readlink-only exclusions for the rg/grep subprocess
  // tiers so `--follow` / `-L` never descend into an incidental dead cloud mount.
  // The Node tier (`searchWithNode` → `safeWalkDirectory`) enforces the same skip
  // by default, so it needs no exclusion list. An explicit named-cloud root
  // produces no exclusions (carve-out inside `collectIncidentalCloudExclusions`).
  const cloudExclusions = collectIncidentalCloudExclusions(searchPath);

  let result:
    | { results: SearchFileResult[]; totalMatches: number; truncationReasons?: readonly string[] }
    | null = null;
  let backend = 'unknown';

  try {
    // ── Tier 1: ripgrep ────────────────────────────────────────────
    result = await tryRg(searchParams, cloudExclusions);
    if (result !== null) {
      backend = 'rg';
    }

    // ── Tier 2: grep ───────────────────────────────────────────────
    if (result === null) {
      result = await tryGrep(searchParams, cloudExclusions);
      if (result !== null) {
        backend = 'grep';
      }
    }

    // ── Tier 3: Node.js ────────────────────────────────────────────
    if (result === null) {
      result = await searchWithNode(searchParams);
      backend = 'node';
    }

    const durationMs = Date.now() - startTime;
    log.info(
      { backend, resultCount: result.totalMatches, durationMs },
      'SearchFiles: search complete',
    );

    // ── Format output ──────────────────────────────────────────────
    const truncationReasons = result.truncationReasons ?? [];
    if (result.totalMatches === 0) {
      // Surface truncation even with zero matches: a walk truncated before it
      // could reach a deeper match must not read as a confident "not found".
      const base = `No matches found for the search pattern in ${searchPath}`;
      return {
        output: truncationReasons.length > 0
          ? `${base}\n\n[results may be incomplete: ${truncationReasons.join(', ')}]`
          : base,
        isError: false,
      };
    }

    const formatted = formatResults(result.results, result.totalMatches, maxResults, truncationReasons);
    return { output: formatted, isError: false };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const durationMs = Date.now() - startTime;

    log.warn({ durationMs, error: message }, 'SearchFiles: search failed');

    if (message.includes('aborted') || message.includes('abort')) {
      return { output: 'The search was cancelled.', isError: true };
    }

    return {
      output: `Search failed: ${message}`,
      isError: true,
    };
  }
}
