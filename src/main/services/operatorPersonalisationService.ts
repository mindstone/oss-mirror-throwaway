import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { getBroadcastService } from '@core/broadcastService';
import { createScopedLogger } from '@core/logger';
import * as operatorRegistry from '@core/services/operatorRegistry';
import {
  CONVERSATIONS_START_REQUESTED_CHANNEL,
  type ConversationsStartRequestedEvent,
} from '@shared/ipc/broadcasts';
import {
  createOperatorId,
  type OperatorDefinition,
} from '@shared/types/operators';
import type { WorkspaceFileSystem } from '@core/workspaceFileSystem';
import { getWorkspaceFileSystem } from '@core/workspaceFileSystem';
import {
  buildPersonalisationPromptPrefix,
  type BuildPersonalisationPromptOutput,
} from './personalisationPromptTemplate';
import {
  clearPendingPersonalisationPrefix,
  registerPendingPersonalisationPrefix,
} from './pendingPersonalisationPrefixes';

const log = createScopedLogger({ service: 'operatorPersonalisationService' });

export interface StartOperatorPersonalisationRequest {
  operatorSlug: string;
  targetSpacePath: string;
}

export type StartOperatorPersonalisationResponse =
  | { success: true; sessionId: string }
  | { success: false; errorCode: 'operator_not_found' | 'broadcast_failed' };

export interface OperatorPersonalisationServiceDeps {
  registry: Pick<typeof operatorRegistry, 'getById' | 'listAvailable'>;
  workspaceFileSystem: WorkspaceFileSystem;
  broadcast(channel: typeof CONVERSATIONS_START_REQUESTED_CHANNEL, payload: ConversationsStartRequestedEvent): void;
  generateSessionId(): string;
  buildPrompt: typeof buildPersonalisationPromptPrefix;
  logger: Pick<ReturnType<typeof createScopedLogger>, 'info' | 'warn'>;
  registerTrustedPrefix(sessionId: string, prefix: string): void;
  clearTrustedPrefix(sessionId: string): void;
}

const defaultDeps: Omit<OperatorPersonalisationServiceDeps, 'workspaceFileSystem'> = {
  registry: operatorRegistry,
  broadcast: (channel, payload) => {
    // dynamic-broadcast-reviewed: dependency-injection seam — forwards the `channel` the service
    // passes (operator-personalisation channels declared at their own emit-sites); no channel of its own.
    getBroadcastService().sendToAllWindows(channel, payload);
  },
  generateSessionId: () => randomUUID(),
  buildPrompt: buildPersonalisationPromptPrefix,
  logger: log,
  registerTrustedPrefix: registerPendingPersonalisationPrefix,
  clearTrustedPrefix: clearPendingPersonalisationPrefix,
};

async function resolveOperator(
  request: StartOperatorPersonalisationRequest,
  deps: OperatorPersonalisationServiceDeps,
): Promise<OperatorDefinition | undefined> {
  const operatorId = createOperatorId(request.targetSpacePath, request.operatorSlug);
  const cached = deps.registry.getById(operatorId);
  if (cached) {
    return cached;
  }

  const available = await deps.registry.listAvailable([request.targetSpacePath]);
  return deps.registry.getById(operatorId)
    ?? available.find((operator) => operator.operatorSlug === request.operatorSlug && operator.spacePath === request.targetSpacePath);
}

export async function startOperatorPersonalisation(
  request: StartOperatorPersonalisationRequest,
  depsOverride: Partial<OperatorPersonalisationServiceDeps> = {},
): Promise<StartOperatorPersonalisationResponse> {
  const deps: OperatorPersonalisationServiceDeps = {
    ...defaultDeps,
    ...depsOverride,
    workspaceFileSystem: depsOverride.workspaceFileSystem ?? getWorkspaceFileSystem(),
  };
  const operatorSlug = request.operatorSlug;
  const targetSpacePath = path.resolve(request.targetSpacePath);

  deps.logger.info({ operatorSlug, targetSpacePath }, 'operators:personalisation_requested');

  const operator = await resolveOperator({ operatorSlug, targetSpacePath }, deps);
  if (!operator) {
    deps.logger.warn(
      { operatorSlug, targetSpacePath },
      'operators:personalisation_failed',
    );
    return { success: false, errorCode: 'operator_not_found' };
  }

  let currentOperatorMd = '';
  try {
    const operatorRelativePath = path.join('operators', operatorSlug, 'OPERATOR.md');
    currentOperatorMd = await deps.workspaceFileSystem.readFile(targetSpacePath, operatorRelativePath);
  } catch (error) {
    deps.logger.warn(
      {
        operatorSlug,
        targetSpacePath,
        error: error instanceof Error ? error.message : String(error),
      },
      'operators:personalisation_read_failed',
    );
    return { success: false, errorCode: 'operator_not_found' };
  }

  const operatorPath = operator.operatorFileAbsolutePath;
  const prompt: BuildPersonalisationPromptOutput = deps.buildPrompt({
    operatorName: operator.displayName ?? operator.name,
    operatorPath,
    currentOperatorMd,
  });

  const sessionId = deps.generateSessionId();
  const payload: ConversationsStartRequestedEvent = {
    sessionId,
    text: prompt.firstUserMessage,
    sendMessage: true,
    switchToConversation: true,
    origin: 'operator-personalisation',
    systemPromptPrefix: prompt.systemPromptPrefix,
  };

  deps.registerTrustedPrefix(sessionId, prompt.systemPromptPrefix);
  try {
    deps.broadcast(CONVERSATIONS_START_REQUESTED_CHANNEL, payload);
  } catch (error) {
    deps.clearTrustedPrefix(sessionId);
    deps.logger.warn(
      {
        operatorSlug,
        targetSpacePath,
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      },
      'operators:personalisation_broadcast_failed',
    );
    return { success: false, errorCode: 'broadcast_failed' };
  }

  deps.logger.info(
    { operatorSlug, targetSpacePath, sessionId },
    'operators:personalisation_broadcast_emitted',
  );
  return { success: true, sessionId };
}
