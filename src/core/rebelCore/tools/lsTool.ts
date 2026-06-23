/**
 * LS — built-in tool for listing directory contents.
 *
 * Always returns name + type + size + mtime per entry (verbose by default,
 * replacing common `ls -la` / `wc -l` invocations). Recursive mode uses
 * `safeWalkDirectory` from `@core/utils/safeWalkDirectory` with per-directory
 * `verifyNoSymlinkEscape` enforcement so recursive descent cannot enumerate
 * paths outside the workspace zone.
 *
 * @see docs/plans/260527_glob_ls_builtins_and_bash_offramp.md
 */

// All dereferencing fs (lstat/stat/readlink/readdir/access) routes through
// {@link workspaceFs} so a dead cloud mount can never hang `ls` — INCLUDING `readlink`,
// because a symlink's own inode lives ON the (possibly cloud) mount and reading it can
// block (S3 review F1). Recursive descent via `safeWalkDirectory` is bounded in Stage S4.
import path from 'node:path';
import { createScopedLogger } from '@core/logger';
import { workspaceFs } from '@core/services/boundedWorkspaceFs';
import { safeWalkDirectory } from '@core/utils/safeWalkDirectory';
import { ignoreBestEffortCleanup } from '@shared/utils/intentionalSwallow';
import type { BuiltinToolContext, ToolExecutionResult } from '../types';
import type { ToolDefinition } from '../modelTypes';
import { resolveToolPath, type ToolPathResolution } from '../toolPathResolver';
import { verifyNoSymlinkEscape } from './zoneSafety';

const log = createScopedLogger({ service: 'lsTool' });

interface LsEntry {
  name: string;
  relativePath: string;
  kind:
    | 'file'
    | 'directory'
    | 'symlink'
    | 'broken-symlink'
    | 'symlink-permission-denied'
    | 'reconnecting'
    | 'other';
  size: number;
  mtime: Date | null;
  symlinkTarget?: string;
}

export const LS_TOOL_DEFINITION: ToolDefinition = {
  name: 'LS',
  description:
    'List the contents of a directory. Returns name, type, size, and modification time for each entry. ' +
    'Use `recursive: true` only when you genuinely need the full subtree; for finding files by pattern prefer `Glob`. ' +
    'Symlinks are followed by default (workspaces use them extensively).',
  input_schema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Directory to list. Absolute or workspace-relative.',
      },
      recursive: {
        type: 'boolean',
        description: 'List the entire subtree (default false).',
      },
      includeHidden: {
        type: 'boolean',
        description: 'Include hidden entries (names starting with `.`). Default false.',
      },
      followSymlinks: {
        type: 'boolean',
        description: 'Follow symbolic links (default true).',
      },
    },
    required: ['path'],
  },
};

function formatMtime(mtime: Date | null): string {
  if (!mtime) return 'unknown';
  return mtime.toISOString();
}

function formatEntryLine(entry: LsEntry, useRelativePath: boolean): string {
  const display = useRelativePath ? entry.relativePath : entry.name;
  const mtimeIso = formatMtime(entry.mtime);
  switch (entry.kind) {
    case 'file':
      return `- ${display}  (file, ${entry.size} bytes, ${mtimeIso})`;
    case 'directory':
      return `- ${display}/  (directory, ${mtimeIso})`;
    case 'symlink':
      return `- ${display}  (symlink → ${entry.symlinkTarget ?? '?'}, ${entry.size} bytes, ${mtimeIso})`;
    case 'broken-symlink':
      return `- ${display}  (broken symlink → ${entry.symlinkTarget ?? '?'})`;
    case 'symlink-permission-denied':
      return `- ${display}  (symlink → ${entry.symlinkTarget ?? '?'}, permission denied)`;
    case 'reconnecting':
      return `- ${display}  (cloud drive reconnecting — details unavailable)`;
    case 'other':
    default:
      return `- ${display}  (other)`;
  }
}

async function describeEntry(
  parentDir: string,
  name: string,
  rootPath: string,
  followSymlinks: boolean,
): Promise<LsEntry> {
  const absolutePath = path.join(parentDir, name);
  const relativePath = path.relative(rootPath, absolutePath) || name;
  const lstatOutcome = await workspaceFs.lstat(absolutePath);
  if (lstatOutcome.status === 'reconnecting') {
    // Dead/slow cloud mount — surface the degraded state instead of hanging or
    // pretending the entry is missing.
    return { name, relativePath, kind: 'reconnecting', size: 0, mtime: null };
  }
  if (lstatOutcome.status === 'error') {
    return { name, relativePath, kind: 'other', size: 0, mtime: null };
  }
  const lstatInfo = lstatOutcome.value;

  if (lstatInfo.isSymbolicLink) {
    // readlink routes through the boundary too (a cloud symlink's inode is on the
    // mount). A reconnecting/error outcome simply omits the target — same effect as
    // the old best-effort catch.
    const targetOutcome = await workspaceFs.readlink(absolutePath);
    const target: string | undefined = targetOutcome.status === 'ok' ? targetOutcome.value : undefined;
    if (!followSymlinks) {
      return {
        name,
        relativePath,
        kind: 'symlink',
        size: lstatInfo.size,
        mtime: new Date(lstatInfo.mtimeMs),
        ...(target !== undefined ? { symlinkTarget: target } : {}),
      };
    }
    const resolvedOutcome = await workspaceFs.stat(absolutePath);
    if (resolvedOutcome.status === 'reconnecting') {
      return {
        name,
        relativePath,
        kind: 'reconnecting',
        size: 0,
        mtime: null,
        ...(target !== undefined ? { symlinkTarget: target } : {}),
      };
    }
    if (resolvedOutcome.status === 'error') {
      const code = resolvedOutcome.error.code;
      if (code === 'EACCES' || code === 'EPERM') {
        return {
          name,
          relativePath,
          kind: 'symlink-permission-denied',
          size: 0,
          mtime: null,
          ...(target !== undefined ? { symlinkTarget: target } : {}),
        };
      }
      return {
        name,
        relativePath,
        kind: 'broken-symlink',
        size: 0,
        mtime: null,
        ...(target !== undefined ? { symlinkTarget: target } : {}),
      };
    }
    const resolved = resolvedOutcome.value;
    if (resolved.isDirectory) {
      return {
        name,
        relativePath,
        kind: 'directory',
        size: 0,
        mtime: new Date(resolved.mtimeMs),
        ...(target !== undefined ? { symlinkTarget: target } : {}),
      };
    }
    if (resolved.isFile) {
      return {
        name,
        relativePath,
        kind: 'symlink',
        size: resolved.size,
        mtime: new Date(resolved.mtimeMs),
        ...(target !== undefined ? { symlinkTarget: target } : {}),
      };
    }
    return {
      name,
      relativePath,
      kind: 'symlink',
      size: 0,
      mtime: new Date(resolved.mtimeMs),
      ...(target !== undefined ? { symlinkTarget: target } : {}),
    };
  }

  if (lstatInfo.isDirectory) {
    return {
      name,
      relativePath,
      kind: 'directory',
      size: 0,
      mtime: new Date(lstatInfo.mtimeMs),
    };
  }
  if (lstatInfo.isFile) {
    return {
      name,
      relativePath,
      kind: 'file',
      size: lstatInfo.size,
      mtime: new Date(lstatInfo.mtimeMs),
    };
  }
  return {
    name,
    relativePath,
    kind: 'other',
    size: lstatInfo.size,
    mtime: new Date(lstatInfo.mtimeMs),
  };
}

async function listDirectoryNonRecursive(
  rootPath: string,
  includeHidden: boolean,
  followSymlinks: boolean,
): Promise<LsEntry[]> {
  const dirOutcome = await workspaceFs.readdir(rootPath);
  if (dirOutcome.status === 'reconnecting') {
    throw new Error('Cloud drive reconnecting — cannot list directory. Try again shortly.');
  }
  if (dirOutcome.status === 'error') {
    throw dirOutcome.error;
  }
  const names = dirOutcome.value;
  const filtered = includeHidden ? names : names.filter((n) => !n.startsWith('.'));
  filtered.sort((a, b) => a.localeCompare(b));
  const entries: LsEntry[] = [];
  for (const name of filtered) {
    entries.push(await describeEntry(rootPath, name, rootPath, followSymlinks));
  }
  return entries;
}

async function listDirectoryRecursive(
  rootPath: string,
  includeHidden: boolean,
  followSymlinks: boolean,
  ctx: BuiltinToolContext,
): Promise<{ entries: LsEntry[]; truncationReasons: readonly string[] }> {
  const entries: LsEntry[] = [];
  const zoneOpts = {
    ...(ctx.cwd ? { cwd: ctx.cwd } : {}),
    ...(ctx.homePath ? { homePath: ctx.homePath } : {}),
    ...(ctx.allowedSymlinkTargets ? { allowedSymlinkTargets: ctx.allowedSymlinkTargets } : {}),
  };

  const walkOptions: Parameters<typeof safeWalkDirectory>[1] = {
    onFile: async ({ absolutePath, name, parentDir, viaSymlink }) => {
      if (!followSymlinks && viaSymlink) return;
      if (!includeHidden && name.startsWith('.')) return;
      const rel = path.relative(rootPath, absolutePath) || name;
      if (!includeHidden && rel.split(path.sep).some((seg) => seg.startsWith('.'))) {
        return;
      }
      entries.push(await describeEntry(parentDir, name, rootPath, followSymlinks));
    },
    onDirectory: async ({ absolutePath, name, isSymbolicLink }) => {
      if (!followSymlinks && isSymbolicLink) return false;
      if (!includeHidden && name.startsWith('.')) return false;
      try {
        await verifyNoSymlinkEscape(absolutePath, zoneOpts);
      } catch (error) {
        ignoreBestEffortCleanup(error, {
          operation: 'lsTool.zoneCheck',
          reason: 'Refuse to descend into a directory whose realpath escapes the workspace zone.',
        });
        return false;
      }
      if (absolutePath !== rootPath) {
        const parentDir = path.dirname(absolutePath);
        entries.push(await describeEntry(parentDir, name, rootPath, followSymlinks));
      }
      return true;
    },
  };

  if (ctx.signal) {
    (walkOptions as { signal?: AbortSignal }).signal = ctx.signal;
  }

  const result = await safeWalkDirectory(rootPath, walkOptions);
  entries.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  return { entries, truncationReasons: result.truncatedReasons };
}

export async function executeLs(
  input: unknown,
  context: BuiltinToolContext,
): Promise<ToolExecutionResult> {
  if (input == null || typeof input !== 'object' || Array.isArray(input)) {
    return { output: 'LS requires a valid input object.', isError: true };
  }
  const params = input as Record<string, unknown>;
  const startTime = Date.now();

  const inputPath = typeof params.path === 'string' ? params.path.trim() : '';
  if (inputPath.length === 0) {
    return { output: 'LS requires a non-empty path.', isError: true };
  }

  const recursive = params.recursive === true;
  const includeHidden = params.includeHidden === true;
  const followSymlinks = params.followSymlinks !== false;

  let resolvedPath: string;
  try {
    const resolution: ToolPathResolution = resolveToolPath(inputPath, {
      ...(context.cwd ? { cwd: context.cwd } : {}),
      ...(context.homePath ? { homePath: context.homePath } : {}),
      tool: 'LS',
    });
    if (!resolution.ok) {
      return { output: `LS failed: ${resolution.error}`, isError: true };
    }
    resolvedPath = resolution.resolvedPath;
    await verifyNoSymlinkEscape(resolvedPath, {
      ...(context.cwd ? { cwd: context.cwd } : {}),
      ...(context.homePath ? { homePath: context.homePath } : {}),
      ...(context.allowedSymlinkTargets ? { allowedSymlinkTargets: context.allowedSymlinkTargets } : {}),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { output: `LS failed: ${message}`, isError: true };
  }

  const accessOutcome = await workspaceFs.access(resolvedPath);
  if (accessOutcome.status === 'reconnecting') {
    return {
      output: `Cloud drive reconnecting — cannot list ${resolvedPath}. Try again shortly.`,
      isError: true,
    };
  }
  if (accessOutcome.status === 'error') {
    return { output: `Directory not found: ${resolvedPath}`, isError: true };
  }
  const statOutcome = await workspaceFs.stat(resolvedPath);
  if (statOutcome.status === 'reconnecting') {
    return {
      output: `Cloud drive reconnecting — cannot list ${resolvedPath}. Try again shortly.`,
      isError: true,
    };
  }
  if (statOutcome.status === 'error') {
    return { output: `Cannot access path: ${resolvedPath}`, isError: true };
  }
  if (!statOutcome.value.isDirectory) {
    return { output: `Path is a file, not a directory: ${resolvedPath}`, isError: true };
  }

  log.info(
    { resolvedPath, recursive, includeHidden, followSymlinks },
    'LS: listing directory',
  );

  try {
    if (!recursive) {
      const entries = await listDirectoryNonRecursive(resolvedPath, includeHidden, followSymlinks);
      const lines = [
        `${resolvedPath} (${entries.length} ${entries.length === 1 ? 'entry' : 'entries'})`,
      ];
      for (const entry of entries) {
        lines.push(formatEntryLine(entry, false));
      }
      log.info({ entryCount: entries.length, durationMs: Date.now() - startTime }, 'LS: complete');
      return { output: lines.join('\n'), isError: false };
    }

    const { entries, truncationReasons } = await listDirectoryRecursive(
      resolvedPath,
      includeHidden,
      followSymlinks,
      context,
    );
    const lines = [
      `${resolvedPath} (${entries.length} ${entries.length === 1 ? 'entry' : 'entries'}, recursive)`,
    ];
    for (const entry of entries) {
      lines.push(formatEntryLine(entry, true));
    }
    if (truncationReasons.length > 0) {
      lines.push(`[some entries unreadable: ${truncationReasons.join(', ')}]`);
    }
    log.info(
      { entryCount: entries.length, durationMs: Date.now() - startTime, truncationReasons },
      'LS recursive: complete',
    );
    return { output: lines.join('\n'), isError: false };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn({ err: message }, 'LS: failed');
    return { output: `LS failed: ${message}`, isError: true };
  }
}
