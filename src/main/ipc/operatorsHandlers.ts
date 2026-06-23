import path from 'node:path';
import type { HandlerInvokeEvent } from '@core/handlerRegistry';
import { runConsult } from '@core/services/operatorConsultRunner';
import * as operatorDiaryStore from '@core/services/operatorDiaryStore';
import * as operatorRegistry from '@core/services/operatorRegistry';
import { parseOperatorId, type OperatorDefinition } from '@shared/types/operators';
import { operatorsChannels, type OperatorMetadata } from '@shared/ipc/channels/operators';
import { activateOperator as activateOperatorInSpace } from '../services/operatorActivationService';
import { setOperatorDisplayName } from '../services/operatorDisplayNameService';
import { duplicateOperator } from '../services/operatorDuplicateService';
import { removeOperator as removeOperatorFromSpace } from '../services/operatorRemovalService';
import { setLiveMeetingEnabled } from '../services/operatorRoleToggleService';
import { startOperatorPersonalisation } from '../services/operatorPersonalisationService';
import { registerHandler } from './utils/registerHandler';

function toMetadata(operator: OperatorDefinition): OperatorMetadata {
  const sourceSpacePath = operator.sourceSpacePath ?? operator.spacePath;
  return {
    id: operator.id,
    operatorSlug: operator.operatorSlug,
    spacePath: operator.spacePath,
    sourceSpacePath,
    category: operator.category ?? (
      sourceSpacePath.replace(/\\/g, '/').toLowerCase().endsWith('/rebel-system') ||
      path.basename(sourceSpacePath).toLowerCase() === 'rebel-system'
        ? 'bundled'
        : 'space'
    ),
    name: operator.name,
    description: operator.description,
    consult_when: operator.consult_when,
    kind: operator.kind,
    roles: operator.roles,
    ...(operator.proactiveIntervalMinutes !== undefined
      ? { proactiveIntervalMinutes: operator.proactiveIntervalMinutes }
      : {}),
    ...(operator.useCases ? { useCases: operator.useCases } : {}),
    ...(operator.displayName ? { displayName: operator.displayName } : {}),
    operatorFileAbsolutePath: operator.operatorFileAbsolutePath,
    groundingPath: operator.groundingPath,
    diaryPath: operator.diaryPath,
    ...(operator.warnings && operator.warnings.length > 0 ? { warnings: operator.warnings } : {}),
  };
}

function resolveSpacePathForOperator(operatorId: string): string {
  const cached = operatorRegistry.getById(operatorId);
  if (cached) {
    return cached.spacePath;
  }

  const parsed = parseOperatorId(operatorId);
  if (parsed.spacePath) {
    return parsed.spacePath;
  }

  throw new Error(`Operator '${operatorId}' was not found in the current registry.`);
}

export function registerOperatorsHandlers(): void {
  const listChannel = operatorsChannels['operators:list'];
  registerHandler(
    listChannel.channel,
    async (_event: HandlerInvokeEvent, request: unknown) => {
      const parsed = listChannel.request.parse(request);
      const diagnostics = await operatorRegistry.listAvailableWithDiagnostics(
        parsed.spacePaths,
        parsed.roleFilter ? { roleFilter: parsed.roleFilter } : undefined,
      );
      return {
        operators: diagnostics.operators.map(toMetadata),
        failures: diagnostics.failures.map((failure) => ({
          spacePath: failure.spacePath,
          operatorSlug: failure.operatorSlug,
          operatorFileAbsolutePath: failure.operatorFileAbsolutePath,
          errorCode: failure.errorCode,
          message: failure.message,
        })),
      };
    },
  );

  const diaryChannel = operatorsChannels['operators:get-diary'];
  registerHandler(
    diaryChannel.channel,
    async (_event: HandlerInvokeEvent, request: unknown) => {
      const parsed = diaryChannel.request.parse(request);
      const spacePath = resolveSpacePathForOperator(parsed.operatorId);
      const diary = await operatorDiaryStore.readDiary(parsed.operatorId, spacePath);
      return { operatorId: parsed.operatorId, diary };
    },
  );

  const activateChannel = operatorsChannels['operators:activate'];
  registerHandler(
    activateChannel.channel,
    async (_event: HandlerInvokeEvent, request: unknown) => {
      const parsed = activateChannel.request.parse(request);
      return activateOperatorInSpace(parsed);
    },
  );

  const removeChannel = operatorsChannels['operators:remove'];
  registerHandler(
    removeChannel.channel,
    async (_event: HandlerInvokeEvent, request: unknown) => {
      const parsed = removeChannel.request.parse(request);
      return removeOperatorFromSpace(parsed);
    },
  );

  const setDisplayNameChannel = operatorsChannels['operators:setDisplayName'];
  registerHandler(
    setDisplayNameChannel.channel,
    async (_event: HandlerInvokeEvent, request: unknown) => {
      const parsed = setDisplayNameChannel.request.parse(request);
      return setOperatorDisplayName(parsed);
    },
  );

  const duplicateChannel = operatorsChannels['operators:duplicate'];
  registerHandler(
    duplicateChannel.channel,
    async (_event: HandlerInvokeEvent, request: unknown) => {
      const parsed = duplicateChannel.request.parse(request);
      return duplicateOperator(parsed);
    },
  );

  const setLiveMeetingEnabledChannel = operatorsChannels['operators:setLiveMeetingEnabled'];
  registerHandler(
    setLiveMeetingEnabledChannel.channel,
    async (_event: HandlerInvokeEvent, request: unknown) => {
      const parsed = setLiveMeetingEnabledChannel.request.parse(request);
      return setLiveMeetingEnabled(parsed);
    },
  );

  const toggleEnabledChannel = operatorsChannels['operators:toggle-enabled'];
  registerHandler(
    toggleEnabledChannel.channel,
    async (_event: HandlerInvokeEvent, request: unknown) => {
      toggleEnabledChannel.request.parse(request);
      return { success: false, errorCode: 'not_implemented' };
    },
  );

  const testConsultChannel = operatorsChannels['operators:test-consult'];
  registerHandler(
    testConsultChannel.channel,
    async (_event: HandlerInvokeEvent, request: unknown) => {
      const parsed = testConsultChannel.request.parse(request);
      return runConsult(parsed, { surfaceCapability: 'desktop' });
    },
  );

  const startPersonalisationChannel = operatorsChannels['operators:startPersonalisation'];
  registerHandler(
    startPersonalisationChannel.channel,
    async (_event: HandlerInvokeEvent, request: unknown) => {
      const parsed = startPersonalisationChannel.request.parse(request);
      return startOperatorPersonalisation(parsed);
    },
  );
}
