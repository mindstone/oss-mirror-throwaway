import path from 'node:path';
import { createScopedLogger } from '@core/logger';
import * as operatorRegistry from '@core/services/operatorRegistry';
import type { WorkspaceFileSystem } from '@core/workspaceFileSystem';
import { getWorkspaceFileSystem } from '@core/workspaceFileSystem';
import type {
  SetOperatorDisplayNameRequest,
  SetOperatorDisplayNameResponse,
} from '@shared/types/operators';
import { mutateOperatorMarkdown, readOperatorAttributes } from './operatorFrontmatterSerializer';

const HARD_MAX_DISPLAY_NAME = 120;

interface DisplayNameLogger {
  info(payload: Record<string, unknown>, message: string): void;
}

export interface OperatorDisplayNameDeps {
  workspaceFileSystem: WorkspaceFileSystem;
  invalidateOperatorRegistry(): void;
  logger: DisplayNameLogger;
}

const log = createScopedLogger({ service: 'operatorDisplayNameService' });

function normalizeDisplayName(input: string | null): { value?: string; tooLong: boolean } {
  const trimmed = input?.trim() ?? '';
  if (!trimmed) {
    return { value: undefined, tooLong: false };
  }
  if (trimmed.length > HARD_MAX_DISPLAY_NAME) {
    return { value: undefined, tooLong: true };
  }
  return { value: trimmed, tooLong: false };
}

export async function setOperatorDisplayName(
  request: SetOperatorDisplayNameRequest,
  deps: Partial<OperatorDisplayNameDeps> = {},
): Promise<SetOperatorDisplayNameResponse> {
  const workspaceFileSystem = deps.workspaceFileSystem ?? getWorkspaceFileSystem();
  const invalidateOperatorRegistry = deps.invalidateOperatorRegistry ?? operatorRegistry.invalidateOperatorRegistry;
  const logger = deps.logger ?? log;

  const operatorSlug = request.operatorSlug;
  const targetSpacePath = path.resolve(request.targetSpacePath);
  const operatorFileRelativePath = path.join('operators', operatorSlug, 'OPERATOR.md');

  const normalizedDisplayName = normalizeDisplayName(request.displayName);
  if (normalizedDisplayName.tooLong) {
    return { success: false, errorCode: 'display_name_too_long' };
  }

  try {
    if (!(await workspaceFileSystem.exists(targetSpacePath, operatorFileRelativePath))) {
      return { success: false, errorCode: 'operator_not_found' };
    }
  } catch {
    return { success: false, errorCode: 'operator_not_found' };
  }

  let existingContent: string;
  try {
    existingContent = await workspaceFileSystem.readFile(targetSpacePath, operatorFileRelativePath);
  } catch {
    return { success: false, errorCode: 'operator_not_found' };
  }

  let attributes: Record<string, unknown>;
  try {
    attributes = readOperatorAttributes(existingContent);
  } catch {
    return { success: false, errorCode: 'write_failed' };
  }

  const currentDisplayName = typeof attributes.display_name === 'string'
    ? attributes.display_name.trim()
    : undefined;
  const targetDisplayName = normalizedDisplayName.value;
  const unchanged = currentDisplayName === targetDisplayName;

  if (!unchanged) {
    let nextContent: string;
    try {
      nextContent = mutateOperatorMarkdown(existingContent, (api) => {
        if (targetDisplayName) {
          api.set('display_name', targetDisplayName);
        } else {
          api.delete('display_name');
        }
      });
    } catch {
      return { success: false, errorCode: 'write_failed' };
    }
    try {
      await workspaceFileSystem.writeFile(targetSpacePath, operatorFileRelativePath, nextContent);
    } catch {
      return { success: false, errorCode: 'write_failed' };
    }
    invalidateOperatorRegistry();
  }

  logger.info({ operatorSlug, targetSpacePath }, 'operators:display_name_updated');
  return { success: true };
}
