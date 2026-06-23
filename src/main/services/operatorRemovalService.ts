import fs from 'node:fs/promises';
import path from 'node:path';
import { createScopedLogger } from '@core/logger';
import * as operatorRegistry from '@core/services/operatorRegistry';
import type { WorkspaceFileSystem } from '@core/workspaceFileSystem';
import { getWorkspaceFileSystem } from '@core/workspaceFileSystem';
import type {
  RemoveOperatorRequest,
  RemoveOperatorResponse,
} from '@shared/types/operators';

type RemoveFailedStep =
  | 'preflight-space-check'
  | 'preflight-operator-check'
  | 'delete-operator-md'
  | 'delete-directory';

interface RemovalLogger {
  info(payload: Record<string, unknown>, message: string): void;
  warn(payload: Record<string, unknown>, message: string): void;
}

export interface OperatorRemovalDeps {
  workspaceFileSystem: WorkspaceFileSystem;
  invalidateOperatorRegistry(): void;
  logger: RemovalLogger;
}

const log = createScopedLogger({ service: 'operatorRemovalService' });

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function resolveRemovalPaths(operatorSlug: string): {
  operatorDirectoryRelativePath: string;
  operatorFileRelativePath: string;
} {
  const operatorDirectoryRelativePath = path.join('operators', operatorSlug);
  return {
    operatorDirectoryRelativePath,
    operatorFileRelativePath: path.join(operatorDirectoryRelativePath, 'OPERATOR.md'),
  };
}

async function deleteIfExists(
  workspaceFileSystem: WorkspaceFileSystem,
  root: string,
  relativePath: string,
): Promise<void> {
  if (!(await workspaceFileSystem.exists(root, relativePath))) {
    return;
  }
  await workspaceFileSystem.deleteFile(root, relativePath);
}

async function removeDirectoryIfEmpty(
  workspaceFileSystem: WorkspaceFileSystem,
  root: string,
  relativePath: string,
): Promise<void> {
  if (!(await workspaceFileSystem.exists(root, relativePath))) {
    return;
  }
  const entries = await workspaceFileSystem.listDirectory(root, relativePath);
  if (entries.length > 0) {
    return;
  }

  try {
    await workspaceFileSystem.deleteFile(root, relativePath);
    return;
  } catch (deleteError) {
    const directoryRealPath = await workspaceFileSystem.realPath(root, relativePath);
    try {
      await fs.rmdir(directoryRealPath);
      return;
    } catch (rmdirError) {
      throw new Error(`${toErrorMessage(deleteError)}; ${toErrorMessage(rmdirError)}`);
    }
  }
}

function removeFailedResponse(
  logger: RemovalLogger,
  input: {
    operatorSlug: string;
    targetSpacePath: string;
    failedStep: RemoveFailedStep;
    error: unknown;
  },
): RemoveOperatorResponse {
  logger.warn(
    {
      operatorSlug: input.operatorSlug,
      targetSpacePath: input.targetSpacePath,
      failedStep: input.failedStep,
      error: toErrorMessage(input.error),
    },
    'operators:remove_failed',
  );
  return { success: false, errorCode: 'delete_failed' };
}

export async function removeOperator(
  request: RemoveOperatorRequest,
  deps: Partial<OperatorRemovalDeps> = {},
): Promise<RemoveOperatorResponse> {
  const workspaceFileSystem = deps.workspaceFileSystem ?? getWorkspaceFileSystem();
  const invalidateOperatorRegistry = deps.invalidateOperatorRegistry ?? operatorRegistry.invalidateOperatorRegistry;
  const logger = deps.logger ?? log;

  const operatorSlug = request.operatorSlug;
  const targetSpacePath = path.resolve(request.targetSpacePath);
  const {
    operatorDirectoryRelativePath,
    operatorFileRelativePath,
  } = resolveRemovalPaths(operatorSlug);

  logger.info({ operatorSlug, targetSpacePath }, 'operators:remove_started');

  try {
    const targetStat = await workspaceFileSystem.stat(targetSpacePath, '.');
    if (!targetStat.isDirectory) {
      logger.warn(
        {
          operatorSlug,
          targetSpacePath,
          failedStep: 'preflight-space-check',
          error: 'target space path is not a directory',
        },
        'operators:remove_failed',
      );
      return { success: false, errorCode: 'space_not_found' };
    }
  } catch {
    logger.warn(
      {
        operatorSlug,
        targetSpacePath,
        failedStep: 'preflight-space-check',
        error: 'target space path not found',
      },
      'operators:remove_failed',
    );
    return { success: false, errorCode: 'space_not_found' };
  }

  try {
    if (!(await workspaceFileSystem.exists(targetSpacePath, operatorFileRelativePath))) {
      logger.warn(
        {
          operatorSlug,
          targetSpacePath,
          failedStep: 'preflight-operator-check',
          error: 'operator file not found in target space',
        },
        'operators:remove_failed',
      );
      return { success: false, errorCode: 'operator_not_found' };
    }
  } catch {
    logger.warn(
      {
        operatorSlug,
        targetSpacePath,
        failedStep: 'preflight-operator-check',
        error: 'operator existence check failed',
      },
      'operators:remove_failed',
    );
    return { success: false, errorCode: 'operator_not_found' };
  }

  try {
    await deleteIfExists(workspaceFileSystem, targetSpacePath, operatorFileRelativePath);
  } catch (error) {
    return removeFailedResponse(logger, {
      operatorSlug,
      targetSpacePath,
      failedStep: 'delete-operator-md',
      error,
    });
  }

  try {
    await removeDirectoryIfEmpty(workspaceFileSystem, targetSpacePath, operatorDirectoryRelativePath);
  } catch (error) {
    return removeFailedResponse(logger, {
      operatorSlug,
      targetSpacePath,
      failedStep: 'delete-directory',
      error,
    });
  }

  invalidateOperatorRegistry();

  logger.info({ operatorSlug, targetSpacePath }, 'operators:remove_succeeded');
  return { success: true };
}
