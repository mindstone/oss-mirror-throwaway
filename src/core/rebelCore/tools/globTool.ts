/**
 * Glob — built-in tool for finding files by name/path pattern.
 *
 * Uses a 3-tier fallback chain:
 *   1. `rg --files --follow -g <pattern>` — fastest path; rg's `-g` understands
 *      gitignore-style globs including `**`.
 *   2. `find -L <path> -type f` + post-filter via picomatch — covers Linux/macOS
 *      where rg isn't installed.
 *   3. `safeWalkDirectory` from `@core/utils/safeWalkDirectory` + picomatch —
 *      pure-Node fallback that also runs on Windows. Per-directory zone
 *      enforcement via `verifyNoSymlinkEscape` ensures the recursive walk
 *      cannot enumerate paths outside the workspace zone.
 *
 * @see docs/plans/260527_glob_ls_builtins_and_bash_offramp.md
 */

import { execFile } from 'node:child_process';
import path from 'node:path';
import picomatch from 'picomatch';
import { createScopedLogger } from '@core/logger';
import { safeWalkDirectory } from '@core/utils/safeWalkDirectory';
import { workspaceFs } from '@core/services/boundedWorkspaceFs';
import { ignoreBestEffortCleanup } from '@shared/utils/intentionalSwallow';
import type { BuiltinToolContext, ToolExecutionResult } from '../types';
import type { ToolDefinition } from '../modelTypes';
import { resolveToolPath, type ToolPathResolution } from '../toolPathResolver';
import { verifyNoSymlinkEscape } from './zoneSafety';
import {
  buildFindCloudPruneArgs,
  buildRgCloudExcludeArgs,
  collectIncidentalCloudExclusions,
  type CloudExclusion,
} from './cloudSubprocessExclusion';

const log = createScopedLogger({ service: 'globTool' });

const DEFAULT_MAX_RESULTS = 100;
const MAX_RESULTS_CAP = 500;
const CLI_TIMEOUT_MS = 30_000;
const NODE_MAX_FILES = 10_000;

/** Directories to always skip in tier-2 / tier-3 fallbacks. */
const EXCLUDED_DIRS = new Set(['.git', 'node_modules', '__pycache__', '.DS_Store']);

interface GlobParams {
  pattern: string;
  searchPath: string;
  maxResults: number;
  includeHidden: boolean;
  followSymlinks: boolean;
  sortBy: 'name' | 'mtime';
}

interface GlobMatch {
  absolutePath: string;
  mtimeMs: number;
}

interface GlobMatchResult {
  matches: GlobMatch[];
  truncationReasons: readonly string[];
}

interface ZoneOpts {
  cwd?: string;
  homePath?: string;
  allowedSymlinkTargets?: string[];
}

function buildZoneOpts(ctx: BuiltinToolContext): ZoneOpts {
  return {
    ...(ctx.cwd ? { cwd: ctx.cwd } : {}),
    ...(ctx.homePath ? { homePath: ctx.homePath } : {}),
    ...(ctx.allowedSymlinkTargets ? { allowedSymlinkTargets: ctx.allowedSymlinkTargets } : {}),
  };
}

async function filterZoneEscapingPaths(
  paths: string[],
  zoneOpts: ZoneOpts,
): Promise<string[]> {
  const accepted: string[] = [];
  for (const candidate of paths) {
    try {
      await verifyNoSymlinkEscape(candidate, zoneOpts);
      accepted.push(candidate);
    } catch (error) {
      ignoreBestEffortCleanup(error, {
        operation: 'globTool.zoneFilter',
        reason: 'Drop a candidate path whose realpath escapes the workspace zone.',
      });
    }
  }
  return accepted;
}

export const GLOB_TOOL_DEFINITION: ToolDefinition = {
  name: 'Glob',
  description:
    'Find files by name or path pattern. Returns matching file paths under the given directory. ' +
    'Supports gitignore-style globs: `**` (recursive), `*`, `?`, `{a,b,c}` (brace expansion), `[abc]` (character class), ' +
    'and a leading `!` to negate the whole pattern. ' +
    'Examples: `**/*.ts` (every TypeScript file), `**/SKILL.md` (every SKILL.md anywhere under path), `{src,tests}/**/*.tsx`. ' +
    'Use this to find files by name; use `SearchFiles` to find content matches inside files; use `LS` to list a single directory.',
  input_schema: {
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        description: 'Gitignore-style glob pattern (supports **, *, ?, brace expansion, character classes, leading !).',
      },
      path: {
        type: 'string',
        description: 'Directory to search in. Defaults to the current workspace.',
      },
      maxResults: {
        type: 'integer',
        minimum: 1,
        description: 'Maximum number of file paths to return (default 100, max 500).',
      },
      includeHidden: {
        type: 'boolean',
        description: 'Include hidden files and directories (default false).',
      },
      followSymlinks: {
        type: 'boolean',
        description: 'Follow symbolic links (default true).',
      },
      sortBy: {
        type: 'string',
        enum: ['name', 'mtime'],
        description: 'Sort order for the returned paths. Defaults to name (deterministic).',
      },
    },
    required: ['pattern'],
  },
};

/**
 * Validate a glob pattern up front so an unclosed bracket / brace fails loudly
 * instead of silently degrading to a literal-match fallback inside picomatch.
 */
function validateGlobPattern(pattern: string): { ok: true } | { ok: false; reason: string } {
  const stripped = pattern.startsWith('!') ? pattern.slice(1) : pattern;
  if (stripped.trim().length === 0) {
    return { ok: false, reason: 'pattern is empty after stripping leading "!"' };
  }
  let openBrackets = 0;
  let openBraces = 0;
  let i = 0;
  while (i < stripped.length) {
    const ch = stripped[i];
    if (ch === '\\' && i + 1 < stripped.length) {
      i += 2;
      continue;
    }
    if (ch === '[') openBrackets += 1;
    else if (ch === ']') openBrackets = Math.max(0, openBrackets - 1);
    else if (ch === '{') openBraces += 1;
    else if (ch === '}') openBraces = Math.max(0, openBraces - 1);
    i += 1;
  }
  if (openBrackets !== 0) {
    return { ok: false, reason: 'unbalanced character class brackets ("[" without "]")' };
  }
  if (openBraces !== 0) {
    return { ok: false, reason: 'unbalanced brace expansion ("{" without "}")' };
  }
  try {
    picomatch.makeRe(stripped, { dot: true, basename: false, nocase: false });
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : 'parse error' };
  }
  return { ok: true };
}

/**
 * Apply gitignore-style match semantics to a path relative to the search root.
 * `pattern` may begin with `!` to negate the result; the harness, not picomatch,
 * is the canonical place for negation so all three tiers behave identically.
 */
function buildMatcher(pattern: string, includeHidden: boolean): (relPath: string) => boolean {
  const negate = pattern.startsWith('!');
  const stripped = negate ? pattern.slice(1) : pattern;
  // Canonical grammar: gitignore-style. The matcher receives paths normalised
  // to forward slashes (handled in the caller below), so picomatch needs no
  // platform-specific options. `dot` lets picomatch consider hidden segments
  // when the caller asked for them. `basename: false` keeps full-path
  // matching aligned with rg's `-g` semantics.
  const isMatch = picomatch(stripped, {
    dot: includeHidden,
    basename: false,
    nocase: false,
  });
  return (relPath: string) => {
    const normalized = relPath.split(path.sep).join('/');
    const matched = isMatch(normalized);
    return negate ? !matched : matched;
  };
}

async function tryRg(
  params: GlobParams,
  zoneOpts: ZoneOpts,
  cloudExclusions: readonly CloudExclusion[],
): Promise<GlobMatchResult | null> {
  if (process.platform === 'win32') return null;
  // rg has no flag to disable symlink following while still walking; the only
  // safe answer when the caller wants symlinks ignored is to skip rg/find and
  // hand the walk to the Node tier where we can inspect each entry.
  if (!params.followSymlinks) return null;

  const stdout = await new Promise<string | null>((resolve) => {
    const args = [
      '--files',
      '--follow',
      '-g',
      params.pattern,
      ...(params.includeHidden ? ['--hidden'] : []),
      '--glob',
      '!.git',
      '--glob',
      '!node_modules',
      '--glob',
      '!__pycache__',
      '--glob',
      '!.DS_Store',
      // Cloud policy (Stage 9): exclude incidental cloud symlinks so `--follow`
      // never descends into a dead FUSE mount and hangs. Derived readlink-only
      // FROM the containment classification (no realpath/stat of the target).
      ...buildRgCloudExcludeArgs(cloudExclusions),
      '--',
      params.searchPath,
    ];

    execFile('rg', args, { timeout: CLI_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024 }, (error, out, stderr) => {
      if (error) {
        const code = (error as NodeJS.ErrnoException).code;
        const exitCode = error.code as unknown;
        if (code === 'ENOENT') {
          resolve(null);
          return;
        }
        if (exitCode === 1 && (!stderr || stderr.trim().length === 0)) {
          resolve('');
          return;
        }
        resolve(null);
        return;
      }
      resolve(out);
    });
  });

  if (stdout === null) return null;

  const candidates = stdout.split('\n').filter((line) => line.trim().length > 0);
  const filtered = await filterZoneEscapingPaths(candidates, zoneOpts);
  const matches = filtered.map((line) => ({ absolutePath: line, mtimeMs: 0 }));
  return { matches, truncationReasons: [] };
}

async function tryFind(
  params: GlobParams,
  zoneOpts: ZoneOpts,
  cloudExclusions: readonly CloudExclusion[],
): Promise<GlobMatchResult | null> {
  if (process.platform === 'win32') return null;

  const findOutcome = await new Promise<{ stdout: string; partial: boolean } | null>((resolve) => {
    // Cloud policy (Stage 9): prune incidental cloud symlinks BEFORE the `-type f`
    // test so `-L` (follow) never descends into a dead FUSE mount and hangs. The
    // pruned branch is `\( -path <abs> -prune -false \) -o` (after the start path,
    // before the test): the `-false` keeps `find`'s implicit `-print` from emitting
    // the pruned symlink's own path, so a basename-matching pattern can't later
    // realpath the dead mount in `filterZoneEscapingPaths` (see buildFindCloudPruneArgs).
    const prune = buildFindCloudPruneArgs(cloudExclusions);
    const args = params.followSymlinks
      ? ['-L', params.searchPath, ...prune, '-type', 'f']
      : [params.searchPath, ...prune, '-type', 'f'];
    execFile('find', args, { timeout: CLI_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') {
          resolve(null);
          return;
        }
        // find exits non-zero when individual entries are unreadable; surface
        // those as a "partial" walk so the agent doesn't trust a missing match
        // as proof of absence. If find produced no output at all, fall through
        // to the next tier.
        if (!stdout || stdout.trim().length === 0) {
          resolve(null);
          return;
        }
        const stderrHasMessages = !!stderr && stderr.trim().length > 0;
        resolve({ stdout, partial: stderrHasMessages });
        return;
      }
      resolve({ stdout, partial: false });
    });
  });

  if (findOutcome === null) return null;

  const matcher = buildMatcher(params.pattern, params.includeHidden);
  const lines = findOutcome.stdout.split('\n').filter((line) => line.trim().length > 0);
  const candidatePaths: string[] = [];
  for (const line of lines) {
    const rel = path.relative(params.searchPath, line);
    if (rel === '' || rel.startsWith('..')) continue;
    if (!params.includeHidden) {
      const segments = rel.split(path.sep);
      if (segments.some((seg) => seg.startsWith('.'))) continue;
    }
    const segments = rel.split(path.sep);
    if (segments.some((seg) => EXCLUDED_DIRS.has(seg))) continue;
    if (!matcher(rel)) continue;
    candidatePaths.push(line);
  }
  const filtered = await filterZoneEscapingPaths(candidatePaths, zoneOpts);
  const matches = filtered.map((p) => ({ absolutePath: p, mtimeMs: 0 }));
  const truncationReasons = findOutcome.partial ? ['traversal errors'] : [];
  return { matches, truncationReasons };
}

async function tryNodeWalker(
  params: GlobParams,
  zoneOpts: ZoneOpts,
  signal: AbortSignal | undefined,
): Promise<GlobMatchResult> {
  const matcher = buildMatcher(params.pattern, params.includeHidden);
  const matches: GlobMatch[] = [];
  let earlyStop = false;
  let hitMatchCap = false;

  const walkOptions: Parameters<typeof safeWalkDirectory>[1] = {
    onFile: ({ absolutePath, viaSymlink }) => {
      if (earlyStop) return;
      if (!params.followSymlinks && viaSymlink) return;
      if (matches.length >= NODE_MAX_FILES) {
        earlyStop = true;
        hitMatchCap = true;
        return;
      }
      const rel = path.relative(params.searchPath, absolutePath);
      if (rel === '' || rel.startsWith('..')) return;
      if (!params.includeHidden) {
        const segments = rel.split(path.sep);
        if (segments.some((seg) => seg.startsWith('.'))) return;
      }
      const segments = rel.split(path.sep);
      if (segments.some((seg) => EXCLUDED_DIRS.has(seg))) return;
      if (matcher(rel)) {
        matches.push({ absolutePath, mtimeMs: 0 });
      }
    },
    onDirectory: async ({ absolutePath, name, isSymbolicLink }) => {
      if (earlyStop) return false;
      if (!params.followSymlinks && isSymbolicLink) return false;
      if (!params.includeHidden && name.startsWith('.')) return false;
      if (EXCLUDED_DIRS.has(name)) return false;
      try {
        await verifyNoSymlinkEscape(absolutePath, zoneOpts);
        return true;
      } catch (error) {
        ignoreBestEffortCleanup(error, {
          operation: 'globTool.zoneCheck',
          reason: 'Refuse to descend into a directory whose realpath escapes the workspace zone.',
        });
        return false;
      }
    },
  };

  if (signal) {
    (walkOptions as { signal?: AbortSignal }).signal = signal;
  }

  const result = await safeWalkDirectory(params.searchPath, walkOptions);
  const truncationReasons: string[] = [...result.truncatedReasons];
  if (hitMatchCap) {
    truncationReasons.push(`hit Glob's ${NODE_MAX_FILES}-match cap`);
  }
  return { matches, truncationReasons };
}

async function fillMtimes(matches: GlobMatch[]): Promise<void> {
  await Promise.all(
    matches.map(async (match) => {
      // Bounded stat (S5): a match inside an admitted cloud space that died after
      // enumeration must not block the mtime fill — the boundary's cloud lane
      // degrades to `reconnecting`. Treat reconnecting/error as mtime 0 (sorts last),
      // exactly as the prior bare-`stat` catch did.
      const outcome = await workspaceFs.stat(match.absolutePath);
      match.mtimeMs = outcome.status === 'ok' ? outcome.value.mtimeMs : 0;
    }),
  );
}

function formatMatches(
  matches: GlobMatch[],
  params: GlobParams,
  truncationReasons: readonly string[],
): string {
  const sorted = [...matches];
  if (params.sortBy === 'mtime') {
    sorted.sort((a, b) => b.mtimeMs - a.mtimeMs);
  } else {
    sorted.sort((a, b) => a.absolutePath.localeCompare(b.absolutePath));
  }

  const total = sorted.length;
  const limited = sorted.slice(0, params.maxResults);

  if (total === 0) {
    const base = `No files matching '${params.pattern}' under '${params.searchPath}'`;
    return truncationReasons.length > 0
      ? `${base}\n\n[results may be incomplete: ${truncationReasons.join(', ')}]`
      : base;
  }

  const lines: string[] = [];
  lines.push(`Found ${total} file${total === 1 ? '' : 's'} matching '${params.pattern}' under '${params.searchPath}':`);
  lines.push('');
  for (const match of limited) {
    const rel = path.relative(params.searchPath, match.absolutePath);
    lines.push(rel.length > 0 ? rel : path.basename(match.absolutePath));
  }
  if (total > params.maxResults) {
    lines.push('');
    lines.push(`[${total - params.maxResults} more match${total - params.maxResults === 1 ? '' : 'es'} omitted]`);
  }
  if (truncationReasons.length > 0) {
    lines.push('');
    lines.push(`[results may be incomplete: ${truncationReasons.join(', ')}]`);
  }
  return lines.join('\n');
}

export async function executeGlob(
  input: unknown,
  context: BuiltinToolContext,
): Promise<ToolExecutionResult> {
  if (input == null || typeof input !== 'object' || Array.isArray(input)) {
    return { output: 'Glob requires a valid input object.', isError: true };
  }
  const params = input as Record<string, unknown>;
  const startTime = Date.now();

  const pattern = params.pattern;
  if (typeof pattern !== 'string' || pattern.trim().length === 0) {
    return { output: 'Glob requires a non-empty pattern.', isError: true };
  }

  const validation = validateGlobPattern(pattern);
  if (!validation.ok) {
    return { output: `Invalid glob pattern: ${validation.reason}`, isError: true };
  }

  const maxResultsRaw = typeof params.maxResults === 'number' && params.maxResults > 0
    ? Math.floor(params.maxResults)
    : DEFAULT_MAX_RESULTS;
  const maxResults = Math.min(maxResultsRaw, MAX_RESULTS_CAP);
  const includeHidden = params.includeHidden === true;
  const followSymlinks = params.followSymlinks !== false;
  const sortBy: 'name' | 'mtime' = params.sortBy === 'mtime' ? 'mtime' : 'name';

  const inputPath = typeof params.path === 'string' && params.path.trim().length > 0
    ? params.path.trim()
    : context.cwd ?? process.cwd();

  let resolvedPath: string;
  try {
    const resolution: ToolPathResolution = resolveToolPath(inputPath, {
      ...(context.cwd ? { cwd: context.cwd } : {}),
      ...(context.homePath ? { homePath: context.homePath } : {}),
      tool: 'Glob',
    });
    if (!resolution.ok) {
      return { output: `Glob failed: ${resolution.error}`, isError: true };
    }
    resolvedPath = resolution.resolvedPath;
    await verifyNoSymlinkEscape(resolvedPath, {
      ...(context.cwd ? { cwd: context.cwd } : {}),
      ...(context.homePath ? { homePath: context.homePath } : {}),
      ...(context.allowedSymlinkTargets ? { allowedSymlinkTargets: context.allowedSymlinkTargets } : {}),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { output: `Glob failed: ${message}`, isError: true };
  }

  // Validate the requested root through the BOUNDED workspace-fs boundary (S5): a
  // configured cloud space addressed by its logical workspace path is containment-
  // cloud, so a bare `access`/`stat` here would dereference the symlink into a
  // possibly-dead mount and block before any bounded tier. The boundary routes it to
  // the killable cloud lane → a dead mount degrades to `reconnecting`, never a hang.
  const rootAccess = await workspaceFs.access(resolvedPath);
  if (rootAccess.status === 'reconnecting') {
    return { output: `Cannot access path (cloud space reconnecting): ${resolvedPath}`, isError: true };
  }
  if (rootAccess.status === 'error') {
    return { output: `Directory not found: ${resolvedPath}`, isError: true };
  }
  const rootStat = await workspaceFs.stat(resolvedPath);
  if (rootStat.status === 'reconnecting') {
    return { output: `Cannot access path (cloud space reconnecting): ${resolvedPath}`, isError: true };
  }
  if (rootStat.status === 'error') {
    return { output: `Cannot access path: ${resolvedPath}`, isError: true };
  }
  if (!rootStat.value.isDirectory) {
    return { output: `Path is not a directory: ${resolvedPath}`, isError: true };
  }

  const globParams: GlobParams = {
    pattern,
    searchPath: resolvedPath,
    maxResults,
    includeHidden,
    followSymlinks,
    sortBy,
  };

  log.info(
    { searchPath: resolvedPath, patternLength: pattern.length, maxResults, sortBy },
    'Glob: starting search',
  );

  const zoneOpts = buildZoneOpts(context);

  // Cloud policy (Stage 9): readlink-only exclusions for the subprocess tiers so
  // `rg --follow` / `find -L` never descend into an incidental dead cloud mount.
  // The Node tier (`safeWalkDirectory`) enforces the same skip by default, so it
  // needs no exclusion list. Explicit named-cloud roots produce no exclusions
  // (the carve-out is inside `collectIncidentalCloudExclusions`).
  const cloudExclusions = collectIncidentalCloudExclusions(resolvedPath);

  let result: GlobMatchResult | null = null;
  let backend = 'unknown';

  try {
    result = await tryRg(globParams, zoneOpts, cloudExclusions);
    if (result !== null) {
      backend = 'rg';
    }
    if (result === null) {
      result = await tryFind(globParams, zoneOpts, cloudExclusions);
      if (result !== null) {
        backend = 'find';
      }
    }
    if (result === null) {
      result = await tryNodeWalker(globParams, zoneOpts, context.signal);
      backend = 'node';
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn({ err: message }, 'Glob: search failed');
    return { output: `Glob failed: ${message}`, isError: true };
  }

  if (sortBy === 'mtime') {
    await fillMtimes(result.matches);
  }

  const formatted = formatMatches(result.matches, globParams, result.truncationReasons);
  log.info(
    { backend, matchCount: result.matches.length, durationMs: Date.now() - startTime },
    'Glob: search complete',
  );
  return { output: formatted, isError: false };
}
