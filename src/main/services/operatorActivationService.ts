import path from 'node:path';
import { createScopedLogger } from '@core/logger';
import * as operatorRegistry from '@core/services/operatorRegistry';
import type { WorkspaceFileSystem } from '@core/workspaceFileSystem';
import { getWorkspaceFileSystem } from '@core/workspaceFileSystem';
import type {
  ActivateOperatorRequest,
  ActivateOperatorResponse,
} from '@shared/types/operators';

interface ActivationLogger {
  info(payload: Record<string, unknown>, message: string): void;
  warn(payload: Record<string, unknown>, message: string): void;
}

export interface OperatorActivationDeps {
  workspaceFileSystem: WorkspaceFileSystem;
  invalidateOperatorRegistry(): void;
  logger: ActivationLogger;
}

const log = createScopedLogger({ service: 'operatorActivationService' });

function resolveActivationPaths(operatorSlug: string): {
  operatorDirectoryRelativePath: string;
  operatorFileRelativePath: string;
} {
  const operatorDirectoryRelativePath = path.join('operators', operatorSlug);
  return {
    operatorDirectoryRelativePath,
    operatorFileRelativePath: path.join(operatorDirectoryRelativePath, 'OPERATOR.md'),
  };
}

export async function activateOperator(
  request: ActivateOperatorRequest,
  deps: Partial<OperatorActivationDeps> = {},
): Promise<ActivateOperatorResponse> {
  const workspaceFileSystem = deps.workspaceFileSystem ?? getWorkspaceFileSystem();
  const invalidateOperatorRegistry = deps.invalidateOperatorRegistry ?? operatorRegistry.invalidateOperatorRegistry;
  const logger = deps.logger ?? log;

  const operatorSlug = request.operatorSlug;
  const sourceSpacePath = path.resolve(request.sourceSpacePath);
  const targetSpacePath = path.resolve(request.targetSpacePath);
  const { operatorDirectoryRelativePath, operatorFileRelativePath } = resolveActivationPaths(operatorSlug);
  const activatedPath = path.join(targetSpacePath, operatorDirectoryRelativePath);
  const existingOperatorPath = path.resolve(targetSpacePath, operatorFileRelativePath);

  logger.info(
    {
      operatorSlug,
      targetSpacePath,
    },
    'operators:activation_started',
  );

  try {
    if (!(await workspaceFileSystem.exists(sourceSpacePath, operatorFileRelativePath))) {
      return { success: false, errorCode: 'source_not_found' };
    }
  } catch {
    return { success: false, errorCode: 'source_not_found' };
  }

  try {
    const targetStat = await workspaceFileSystem.stat(targetSpacePath, '.');
    if (!targetStat.isDirectory) {
      return { success: false, errorCode: 'target_not_writable' };
    }
  } catch {
    return { success: false, errorCode: 'target_not_writable' };
  }

  try {
    const existingOperatorInTargetSpace = await workspaceFileSystem.exists(targetSpacePath, operatorFileRelativePath);
    if (existingOperatorInTargetSpace) {
      return { success: false, errorCode: 'already_activated', existingOperatorPath };
    }
  } catch {
    return { success: false, errorCode: 'target_not_writable' };
  }

  let operatorContent: string;
  try {
    operatorContent = await workspaceFileSystem.readFile(sourceSpacePath, operatorFileRelativePath);
  } catch {
    return { success: false, errorCode: 'source_not_found' };
  }

  try {
    await workspaceFileSystem.writeFile(targetSpacePath, operatorFileRelativePath, operatorContent);
  } catch {
    return { success: false, errorCode: 'copy_failed' };
  }

  invalidateOperatorRegistry();
  logger.info({ operatorSlug, targetSpacePath }, 'operators:activation_copy_succeeded');

  return { success: true, activatedPath };
}
