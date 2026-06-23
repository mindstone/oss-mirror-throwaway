/**
 * Space Permission Hook
 *
 * PreToolUse hook that blocks write operations to read-only spaces.
 * Read-only spaces are typically shared cloud storage folders (Google Drive,
 * OneDrive, Dropbox) where the user only has viewer access.
 *
 * Lives in src/core/ because it uses no Electron APIs — follows core-first
 * architecture.
 */

import path from 'pathe';
import type { HookJSONOutput } from '@core/agentRuntimeTypes';
import { createScopedLogger } from '@core/logger';
import { matchPathToSpace } from '../spacePathMatcher';
import { FILE_WRITE_TOOLS } from './constants';

const log = createScopedLogger({ service: 'spacePermissionHook' });

export interface SpacePermissionHookOptions {
  /** Returns writable status for a file path: false = read-only, true/undefined = allow */
  getWritableForPath: (filePath: string) => boolean | undefined;
}

export interface SpaceWritablePathInfo {
  path: string;
  sourcePath?: string | undefined;
  writable?: boolean | undefined;
}

export function getWritableForSpacePath<T extends SpaceWritablePathInfo>(
  filePath: string,
  spaces: readonly T[],
  coreDirectory: string,
): boolean | undefined {
  const matchableSpaces = spaces.map(space => ({
    ...space,
    absolutePath: path.resolve(coreDirectory, space.path),
  }));

  return matchPathToSpace(filePath, matchableSpaces, coreDirectory)?.writable;
}

/**
 * Create a PreToolUse hook that blocks write operations to read-only spaces.
 *
 * Unlike readOnlyHook (which blocks ALL writes), this hook only blocks writes
 * to spaces that have been detected as read-only (writable === false). Writes
 * to writable spaces or paths outside any space are allowed through.
 *
 * @example
 * ```typescript
 * const hook = createSpacePermissionHook({
 *   getWritableForPath: (filePath) => {
 *     const space = resolveSpaceForPath(filePath);
 *     return space?.writable;
 *   },
 * });
 * ```
 */
export function createSpacePermissionHook(options: SpacePermissionHookOptions) {
  const { getWritableForPath } = options;

  return async (
    input: { tool_name?: string; tool_input?: Record<string, unknown>; tool_use_id?: string },
    _toolUseID: string | undefined,
    _hookOptions: { signal: AbortSignal },
  ): Promise<HookJSONOutput> => {
    const toolName = input.tool_name ?? '';

    // Only intercept file write tools
    if (!FILE_WRITE_TOOLS.includes(toolName as (typeof FILE_WRITE_TOOLS)[number])) {
      return {};
    }

    // Extract file path from tool input (tools use file_path or path)
    const filePath = (input.tool_input?.file_path ?? input.tool_input?.path ?? '') as string;
    if (!filePath) return {};

    const writable = getWritableForPath(filePath);

    if (writable === false) {
      log.info(
        { toolName, filePath, blocked: true },
        'Space permission hook blocked write to read-only space',
      );

      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse' as const,
          permissionDecision: 'deny' as const,
          permissionDecisionReason:
            `This file is in a read-only space. The space is linked to a shared cloud storage folder ` +
            `where the user has viewer-only access — this is a cloud permission, not a bug or setup issue. ` +
            `Do not attempt to write here or suggest the user "initialise" or "fix" the space. ` +
            `Use Chief-of-Staff or another writable space for your outputs instead.`,
        },
      };
    }

    return {};
  };
}
