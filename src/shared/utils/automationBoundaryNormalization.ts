import type { AutomationDefinition, AutomationStoreState } from '@shared/types';
import { AutomationSchedule as ScheduleConstructors } from './automationSchedule';

type AutomationDefinitionBoundary = Omit<AutomationDefinition, 'schedule'> & {
  schedule: unknown;
};

type AutomationStoreStateBoundary = Omit<AutomationStoreState, 'definitions'> & {
  definitions: AutomationDefinitionBoundary[];
};

function normalizeAutomationDefinition(definition: AutomationDefinitionBoundary): AutomationDefinition {
  const normalizedSchedule = ScheduleConstructors.fromUntrusted(definition.schedule, {
    source: 'ipc',
    now: Date.now(),
    existingCreatedAt: definition.createdAt,
  });
  if (!normalizedSchedule.ok) {
    throw new Error(`Invalid automation schedule for "${definition.id}": ${normalizedSchedule.error.message}`);
  }
  return {
    ...definition,
    schedule: normalizedSchedule.value,
  };
}

export function normalizeAutomationDefinitionFromBoundary(
  definition: AutomationDefinitionBoundary,
): AutomationDefinition {
  return normalizeAutomationDefinition(definition);
}

export function normalizeAutomationStoreStateFromBoundary(
  state: AutomationStoreStateBoundary,
): AutomationStoreState {
  return {
    ...state,
    definitions: state.definitions.map(normalizeAutomationDefinition),
  };
}
