import path from 'node:path';
import { createScopedLogger } from '@core/logger';
import * as operatorRegistry from '@core/services/operatorRegistry';
import type { WorkspaceFileSystem } from '@core/workspaceFileSystem';
import { getWorkspaceFileSystem } from '@core/workspaceFileSystem';
import type {
  SetLiveMeetingEnabledRequest,
  SetLiveMeetingEnabledResponse,
} from '@shared/types/operators';
import { mutateOperatorMarkdown, readOperatorAttributes } from './operatorFrontmatterSerializer';
import { withOperatorFileMutation } from './operatorFileMutationLock';

interface RoleToggleLogger {
  info(payload: Record<string, unknown>, message: string): void;
  warn(payload: Record<string, unknown>, message: string): void;
}

export interface OperatorRoleToggleDeps {
  workspaceFileSystem: WorkspaceFileSystem;
  invalidateOperatorRegistry(): void;
  logger: RoleToggleLogger;
}

const log = createScopedLogger({ service: 'operatorRoleToggleService' });

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isBundledTarget(targetSpacePath: string): boolean {
  const normalized = path.resolve(targetSpacePath).replace(/\\/g, '/').toLowerCase();
  return normalized.endsWith('/rebel-system') || path.basename(normalized) === 'rebel-system';
}

function readRolesArray(attributes: Record<string, unknown>): string[] {
  const raw = attributes.roles;
  if (!Array.isArray(raw)) {
    // Schema-tolerant default mirrors `OperatorFrontmatterSchema.roles.default(['operator'])`
    // in `src/shared/schemas/operatorFrontmatter.ts`. A missing/non-array `roles`
    // field MUST behave as `['operator']` so toggling on never silently strips
    // the implicit operator role.
    return ['operator'];
  }
  const seen = new Set<string>();
  const result: string[] = [];
  for (const candidate of raw) {
    if (typeof candidate !== 'string') continue;
    const trimmed = candidate.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }
  if (result.length === 0) {
    return ['operator'];
  }
  return result;
}

function hasNonEmptyString(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

export async function setLiveMeetingEnabled(
  request: SetLiveMeetingEnabledRequest,
  deps: Partial<OperatorRoleToggleDeps> = {},
): Promise<SetLiveMeetingEnabledResponse> {
  const workspaceFileSystem = deps.workspaceFileSystem ?? getWorkspaceFileSystem();
  const invalidateOperatorRegistry =
    deps.invalidateOperatorRegistry ?? operatorRegistry.invalidateOperatorRegistry;
  const logger = deps.logger ?? log;

  const operatorSlug = request.operatorSlug;
  const targetSpacePath = path.resolve(request.targetSpacePath);
  const enabled = request.enabled;
  const operatorFileRelativePath = path.join('operators', operatorSlug, 'OPERATOR.md');

  logger.info(
    { operatorSlug, targetSpacePath, enabled },
    'operators:role_toggle_started',
  );

  if (isBundledTarget(targetSpacePath)) {
    logger.warn(
      { operatorSlug, targetSpacePath, enabled, errorCode: 'operator_not_found' },
      'operators:role_toggle_failed',
    );
    return { success: false, errorCode: 'operator_not_found' };
  }

  return withOperatorFileMutation(targetSpacePath, operatorFileRelativePath, async () => {
    try {
      if (!(await workspaceFileSystem.exists(targetSpacePath, operatorFileRelativePath))) {
        logger.warn(
          { operatorSlug, targetSpacePath, enabled, errorCode: 'operator_not_found' },
          'operators:role_toggle_failed',
        );
        return { success: false, errorCode: 'operator_not_found' };
      }
    } catch (error) {
      logger.warn(
        { operatorSlug, targetSpacePath, enabled, error: toErrorMessage(error), errorCode: 'operator_not_found' },
        'operators:role_toggle_failed',
      );
      return { success: false, errorCode: 'operator_not_found' };
    }

    let existingContent: string;
    try {
      existingContent = await workspaceFileSystem.readFile(targetSpacePath, operatorFileRelativePath);
    } catch (error) {
      logger.warn(
        { operatorSlug, targetSpacePath, enabled, error: toErrorMessage(error), errorCode: 'operator_not_found' },
        'operators:role_toggle_failed',
      );
      return { success: false, errorCode: 'operator_not_found' };
    }

    let attributes: Record<string, unknown>;
    try {
      attributes = readOperatorAttributes(existingContent);
    } catch (error) {
      logger.warn(
        { operatorSlug, targetSpacePath, enabled, error: toErrorMessage(error), errorCode: 'write_failed' },
        'operators:role_toggle_failed',
      );
      return { success: false, errorCode: 'write_failed' };
    }

    const currentRoles = readRolesArray(attributes);
    const hasLiveMeeting = currentRoles.includes('live_meeting');

    let nextRoles: string[];
    if (enabled) {
      if (!hasNonEmptyString(attributes.live_prompt)) {
        logger.warn(
          { operatorSlug, targetSpacePath, enabled, errorCode: 'live_prompt_missing' },
          'operators:role_toggle_failed',
        );
        return { success: false, errorCode: 'live_prompt_missing' };
      }
      if (hasLiveMeeting) {
        logger.info(
          { operatorSlug, targetSpacePath, enabled, noOp: true },
          'operators:role_toggle_succeeded',
        );
        return { success: true };
      }
      nextRoles = [...currentRoles, 'live_meeting'];
    } else {
      if (!hasLiveMeeting) {
        logger.info(
          { operatorSlug, targetSpacePath, enabled, noOp: true },
          'operators:role_toggle_succeeded',
        );
        return { success: true };
      }
      const remainingRoles = currentRoles.filter((role) => role !== 'live_meeting');
      if (remainingRoles.length === 0) {
        logger.warn(
          { operatorSlug, targetSpacePath, enabled, errorCode: 'roles_would_be_empty' },
          'operators:role_toggle_failed',
        );
        return { success: false, errorCode: 'roles_would_be_empty' };
      }
      nextRoles = remainingRoles;
    }

    let nextContent: string;
    try {
      nextContent = mutateOperatorMarkdown(existingContent, (api) => {
        api.set('roles', nextRoles);
      });
    } catch (error) {
      logger.warn(
        { operatorSlug, targetSpacePath, enabled, error: toErrorMessage(error), errorCode: 'write_failed' },
        'operators:role_toggle_failed',
      );
      return { success: false, errorCode: 'write_failed' };
    }

    try {
      await workspaceFileSystem.writeFile(targetSpacePath, operatorFileRelativePath, nextContent);
    } catch (error) {
      logger.warn(
        { operatorSlug, targetSpacePath, enabled, error: toErrorMessage(error), errorCode: 'write_failed' },
        'operators:role_toggle_failed',
      );
      return { success: false, errorCode: 'write_failed' };
    }

    try {
      invalidateOperatorRegistry();
    } catch (error) {
      logger.warn(
        { operatorSlug, targetSpacePath, enabled, error: toErrorMessage(error) },
        'operators:role_toggle_invalidate_failed',
      );
    }

    logger.info(
      { operatorSlug, targetSpacePath, enabled, nextRoles },
      'operators:role_toggle_succeeded',
    );
    return { success: true };
  });
}
