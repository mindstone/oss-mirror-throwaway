import path from 'node:path';
import fs from 'node:fs/promises';
import { createScopedLogger } from '@core/logger';
import * as operatorRegistry from '@core/services/operatorRegistry';
import type { WorkspaceFileSystem } from '@core/workspaceFileSystem';
import { getWorkspaceFileSystem } from '@core/workspaceFileSystem';
import { ignoreBestEffortCleanup } from '@shared/utils/intentionalSwallow';
import type {
  DuplicateOperatorRequest,
  DuplicateOperatorResponse,
} from '@shared/types/operators';
import { mutateOperatorMarkdown } from './operatorFrontmatterSerializer';

const HARD_MAX_DISPLAY_NAME = 120;
const MAX_SUFFIX_ATTEMPTS = 99;

interface DuplicateLogger {
  info(payload: Record<string, unknown>, message: string): void;
  warn(payload: Record<string, unknown>, message: string): void;
}

export interface OperatorDuplicateDeps {
  workspaceFileSystem: WorkspaceFileSystem;
  invalidateOperatorRegistry(): void;
  logger: DuplicateLogger;
}

const log = createScopedLogger({ service: 'operatorDuplicateService' });

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function slugify(input: string): string {
  const normalized = input
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '');
  return normalized || 'operator';
}

function operatorFileRelativePath(slug: string): string {
  return path.join('operators', slug, 'OPERATOR.md');
}

function operatorDirectoryRelativePath(slug: string): string {
  return path.join('operators', slug);
}

async function pickFreeSlug(
  workspaceFileSystem: WorkspaceFileSystem,
  spacePath: string,
  baseSlug: string,
): Promise<string | null> {
  const baseTaken = await workspaceFileSystem.exists(spacePath, operatorFileRelativePath(baseSlug));
  if (!baseTaken) {
    return baseSlug;
  }
  for (let suffix = 2; suffix <= MAX_SUFFIX_ATTEMPTS; suffix += 1) {
    const candidate = `${baseSlug}-${suffix}`;
    if (!(await workspaceFileSystem.exists(spacePath, operatorFileRelativePath(candidate)))) {
      return candidate;
    }
  }
  return null;
}

export async function duplicateOperator(
  request: DuplicateOperatorRequest,
  deps: Partial<OperatorDuplicateDeps> = {},
): Promise<DuplicateOperatorResponse> {
  const workspaceFileSystem = deps.workspaceFileSystem ?? getWorkspaceFileSystem();
  const invalidateOperatorRegistry = deps.invalidateOperatorRegistry ?? operatorRegistry.invalidateOperatorRegistry;
  const logger = deps.logger ?? log;

  const sourceSlug = request.sourceSlug;
  const sourceSpacePath = path.resolve(request.sourceSpacePath);
  const newDisplayName = request.newDisplayName.trim();

  logger.info({ sourceSlug, sourceSpacePath }, 'operators:duplicate_started');

  if (newDisplayName.length === 0 || newDisplayName.length > HARD_MAX_DISPLAY_NAME) {
    logger.warn(
      { sourceSlug, sourceSpacePath, displayNameLength: newDisplayName.length },
      'operators:duplicate_failed',
    );
    return { success: false, errorCode: 'display_name_too_long' };
  }

  const sourceFileRelativePath = operatorFileRelativePath(sourceSlug);
  try {
    if (!(await workspaceFileSystem.exists(sourceSpacePath, sourceFileRelativePath))) {
      logger.warn({ sourceSlug, sourceSpacePath }, 'operators:duplicate_failed');
      return { success: false, errorCode: 'source_not_found' };
    }
  } catch {
    return { success: false, errorCode: 'source_not_found' };
  }

  let sourceContent: string;
  try {
    sourceContent = await workspaceFileSystem.readFile(sourceSpacePath, sourceFileRelativePath);
  } catch {
    return { success: false, errorCode: 'source_not_found' };
  }

  const baseSlug = slugify(newDisplayName);
  const newSlug = await pickFreeSlug(workspaceFileSystem, sourceSpacePath, baseSlug);
  if (!newSlug) {
    logger.warn({ sourceSlug, sourceSpacePath, baseSlug }, 'operators:duplicate_failed');
    return { success: false, errorCode: 'slug_collision_unresolvable' };
  }
  // Invariant: pickFreeSlug returns a slug whose OPERATOR.md does not yet exist; sourceSlug's file
  // exists (we already verified above), so newSlug !== sourceSlug here.

  const targetFileRelativePath = operatorFileRelativePath(newSlug);
  let nextContent: string;
  try {
    nextContent = mutateOperatorMarkdown(sourceContent, (api) => {
      api.set('display_name', newDisplayName);
    });
  } catch (error) {
    logger.warn(
      { sourceSlug, sourceSpacePath, error: toErrorMessage(error) },
      'operators:duplicate_failed',
    );
    return { success: false, errorCode: 'copy_failed' };
  }

  try {
    await workspaceFileSystem.writeFile(sourceSpacePath, targetFileRelativePath, nextContent);
  } catch (error) {
    logger.warn(
      { sourceSlug, newSlug, sourceSpacePath, error: toErrorMessage(error) },
      'operators:duplicate_failed',
    );
    try {
      await workspaceFileSystem.deleteFile(sourceSpacePath, targetFileRelativePath);
    } catch (cleanupError) {
      ignoreBestEffortCleanup(cleanupError, {
        operation: 'operators:duplicate_rollback_file',
        reason: 'operator file may not have been written before failure',
      });
    }
    try {
      const directoryRelativePath = operatorDirectoryRelativePath(newSlug);
      if (await workspaceFileSystem.exists(sourceSpacePath, directoryRelativePath)) {
        const entries = await workspaceFileSystem.listDirectory(sourceSpacePath, directoryRelativePath);
        if (entries.length === 0) {
          try {
            await workspaceFileSystem.deleteFile(sourceSpacePath, directoryRelativePath);
          } catch (deleteError) {
            ignoreBestEffortCleanup(deleteError, {
              operation: 'operators:duplicate_rollback_directory_deleteFile',
              reason: 'workspaceFileSystem.deleteFile rejected on the empty operator directory; falling back to fs.rmdir',
            });
            const directoryRealPath = await workspaceFileSystem.realPath(sourceSpacePath, directoryRelativePath);
            try {
              await fs.rmdir(directoryRealPath);
            } catch (rmdirError) {
              ignoreBestEffortCleanup(rmdirError, {
                operation: 'operators:duplicate_rollback_directory_rmdir',
                reason: 'fs.rmdir fallback failed after deleteFile already rejected; leaving empty directory orphaned',
              });
            }
          }
        }
      }
    } catch (cleanupError) {
      ignoreBestEffortCleanup(cleanupError, {
        operation: 'operators:duplicate_rollback_directory',
        reason: 'directory cleanup after failed duplicate is best-effort',
      });
    }
    return { success: false, errorCode: 'copy_failed' };
  }

  invalidateOperatorRegistry();
  logger.info({ sourceSlug, newSlug, sourceSpacePath }, 'operators:duplicate_succeeded');
  return { success: true, newSlug };
}
