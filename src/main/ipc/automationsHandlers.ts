/**
 * Automations Domain IPC Handlers
 *
 * Handles automation definition CRUD and execution.
 */

import type { HandlerInvokeEvent } from '@core/handlerRegistry';
import { z } from 'zod';
import type { AutomationScheduler, AutomationDefinitionPatch } from '../services/automationScheduler';
import { registerHandler } from './utils/registerHandler';
import { isNonEmptyString } from '@shared/utils/validators';
import { getSettings } from '@core/services/settingsStore';
import { validateAutomationFilePath } from '../utils/automationFileValidation';
import { createScopedLogger } from '@core/logger';
import { AutomationDefinitionPatchSchema } from '@shared/ipc/schemas/automations';
import { AutomationSchedule } from '@shared/utils/automationSchedule';

const log = createScopedLogger({ ipc: 'automations' });

export interface AutomationsHandlerDeps {
  getScheduler: () => AutomationScheduler;
}

export function registerAutomationsHandlers(deps: AutomationsHandlerDeps): void {
  const { getScheduler } = deps;

  registerHandler('automations:state', (_event: HandlerInvokeEvent) => {
    return getScheduler().getState();
  });

  registerHandler('automations:provider-readiness-summary', (_event: HandlerInvokeEvent) => {
    return getScheduler().getProviderReadinessSummary();
  });

  registerHandler('automations:upsert', async (_event: HandlerInvokeEvent, payload: AutomationDefinitionPatch) => {
    // BLOCKER 1 fix: extract schedule as unknown FIRST so legacy MCP/import shapes
    // (event_type, legacy `trigger`, every_n_days without anchorDate) reach
    // fromUntrusted before the strict AutomationScheduleSchema runs. Validating
    // the rest of the patch via .omit({ schedule: true }) keeps strictness on
    // every other field. Renderer callers go through AutomationSchedule.*
    // constructors, so this only affects boundary callers that bypassed them.
    const rawPayload = (payload ?? {}) as Record<string, unknown>;
    const { schedule: rawSchedule, ...payloadWithoutScheduleRaw } = rawPayload;
    const PatchWithoutScheduleSchema = AutomationDefinitionPatchSchema.omit({ schedule: true });

    let parsedPatchWithoutSchedule: z.infer<typeof PatchWithoutScheduleSchema>;
    try {
      parsedPatchWithoutSchedule = PatchWithoutScheduleSchema.parse(payloadWithoutScheduleRaw);
    } catch (error) {
      if (error instanceof z.ZodError) {
        throw new Error(error.message);
      }
      throw error;
    }

    const scheduler = getScheduler();
    const existing = parsedPatchWithoutSchedule.id
      ? scheduler.getState().definitions.find((definition) => definition.id === parsedPatchWithoutSchedule.id)
      : undefined;

    // Validate filePath existence when it's being set or changed
    const newFilePath = parsedPatchWithoutSchedule.filePath?.trim();
    if (newFilePath) {
      let shouldValidate = true;
      if (existing && existing.filePath === newFilePath) {
        shouldValidate = false; // filePath unchanged, skip validation
      }
      if (shouldValidate) {
        const settings = getSettings();
        if (settings.coreDirectory) {
          await validateAutomationFilePath(newFilePath, settings.coreDirectory);
        }
      }
    }

    let normalizedScheduleForUpsert: AutomationDefinitionPatch['schedule'] | undefined;
    if (rawSchedule !== undefined) {
      const normalizedSchedule = AutomationSchedule.fromUntrusted(rawSchedule, {
        source: 'ipc',
        existingCreatedAt: existing?.createdAt,
        now: Date.now(),
      });

      if (!normalizedSchedule.ok) {
        log.warn(
          { id: parsedPatchWithoutSchedule.id, reason: normalizedSchedule.error.kind },
          'Rejected automation upsert: schedule validation failed',
        );
        const fieldSuffix = normalizedSchedule.error.field ? ` (${normalizedSchedule.error.field})` : '';
        throw new Error(`Invalid schedule${fieldSuffix}: ${normalizedSchedule.error.message}`);
      }

      normalizedScheduleForUpsert = normalizedSchedule.value;
    }

    const payloadForScheduler: AutomationDefinitionPatch = normalizedScheduleForUpsert
      ? { ...parsedPatchWithoutSchedule, schedule: normalizedScheduleForUpsert }
      : parsedPatchWithoutSchedule;

    return scheduler.upsertDefinition(payloadForScheduler);
  });

  registerHandler('automations:delete', (_event: HandlerInvokeEvent, id: string) => {
    if (!isNonEmptyString(id)) {
      return getScheduler().getState();
    }
    return getScheduler().deleteDefinition(id);
  });

  registerHandler('automations:run-now', async (_event: HandlerInvokeEvent, id: string) => {
    if (!isNonEmptyString(id)) {
      return null;
    }
    return await getScheduler().runNow(id, 'manual');
  });

  registerHandler('automations:set-session-type-filter', (_event: HandlerInvokeEvent, filter: string) => {
    // Validate filter value
    const validFilters = ['all', 'conversations', 'automations'] as const;
    const normalizedFilter = validFilters.includes(filter as typeof validFilters[number])
      ? (filter as typeof validFilters[number])
      : 'all';
    return getScheduler().setSessionTypeFilter(normalizedFilter);
  });
}
