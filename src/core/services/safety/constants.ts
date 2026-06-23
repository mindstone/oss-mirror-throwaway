import path from 'node:path';
import { toPortablePath } from '@core/utils/portablePath';

/**
 * Safety-related constants shared across hooks.
 */

/**
 * File write tools that should be intercepted for safety checks.
 * These names are part of our agent runtime message/tool contract and
 * are now maintained locally in the codebase.
 */
export const FILE_WRITE_TOOLS = [
  'Edit',
  'Create',
  'Write',
  'str_replace_editor',
  'write_file',
] as const;

export type FileWriteTool = (typeof FILE_WRITE_TOOLS)[number];

/**
 * The directory name for bundled system files (read-only at runtime).
 * Used by both memoryWriteHook and cosPendingService for write protection.
 */
export const REBEL_SYSTEM_DIR = 'rebel-system';
export const REBEL_MANAGED_DIR = '.rebel';

// =============================================================================
// Error / denial prefixes (relocated from accessRulesManager.ts)
// =============================================================================

/** Prefix added to security denial reasons when the block was caused by an evaluation error
 *  (parse failure, network timeout, etc.) rather than a genuine policy violation.
 *  Used by shouldSuggestRulesUpdate() to filter transient errors. */
export const EVALUATION_ERROR_PREFIX = '[evaluation-error] ';

/** Prefix used by the automation circuit breaker when it halts a run due to
 *  too many consecutive safety blocks. Used in automationScheduler to distinguish
 *  genuine security-halted runs from failures that happen to have denials. */
export const CIRCUIT_BREAKER_DENIAL_PREFIX = 'Circuit breaker:';

/**
 * Check whether a file path targets a protected system directory.
 *
 * rebel-system/ is bundled with the app and must never be written to by agents.
 * .rebel/ stores managed collaboration data (history, notifications) and must
 * not be directly mutated by agent file tools.
 * This helper is the single source of truth for those invariants, shared across
 * memoryWriteHook and related write-protection flows.
 *
 * Handles both absolute and relative paths, and is case-insensitive on
 * macOS/Windows (matching filesystem behavior).
 */
export function isProtectedSystemPath(filePath: string, coreDirectory?: string): boolean {
  const absolute = coreDirectory && !path.isAbsolute(filePath)
    ? path.resolve(coreDirectory, filePath)
    : path.resolve(filePath);
  const normalized = toPortablePath(absolute);

  const comparePath = process.platform === 'linux' ? normalized : normalized.toLowerCase();
  const protectedDirs = [REBEL_SYSTEM_DIR, REBEL_MANAGED_DIR];

  return protectedDirs.some((dirName) => {
    const compareName = process.platform === 'linux' ? dirName : dirName.toLowerCase();
    const segment = `/${compareName}/`;
    const segmentExact = `/${compareName}`;
    return comparePath.includes(segment) || comparePath.endsWith(segmentExact);
  });
}
