import { z } from 'zod';
import {
  defineInvokeChannel,
  AutomationStoreStateSchema,
  AutomationDefinitionSchema,
  AutomationDefinitionPatchSchema,
  AutomationProviderReadinessSummarySchema,
  AutomationRunSchema,
  SessionTypeFilterSchema,
} from '../schemas';

export const automationsChannels = {
  'automations:state': defineInvokeChannel({
    channel: 'automations:state',
    request: z.void(),
    response: AutomationStoreStateSchema,
    description: 'Get the current automation store state',
  }),

  'automations:provider-readiness-summary': defineInvokeChannel({
    channel: 'automations:provider-readiness-summary',
    request: z.void(),
    response: AutomationProviderReadinessSummarySchema,
    description: 'Get aggregate provider-readiness block summary for automations',
  }),

  'automations:upsert': defineInvokeChannel({
    channel: 'automations:upsert',
    request: AutomationDefinitionPatchSchema,
    response: AutomationDefinitionSchema,
    description: 'Create or update an automation definition',
  }),

  'automations:delete': defineInvokeChannel({
    channel: 'automations:delete',
    request: z.string(),
    response: AutomationStoreStateSchema,
    description: 'Delete an automation definition',
  }),

  'automations:run-now': defineInvokeChannel({
    channel: 'automations:run-now',
    request: z.string(),
    response: AutomationRunSchema.nullable(),
    description: 'Trigger an automation to run immediately',
  }),

  'automations:set-session-type-filter': defineInvokeChannel({
    channel: 'automations:set-session-type-filter',
    request: SessionTypeFilterSchema,
    response: AutomationStoreStateSchema,
    description: 'Set the session type filter for sidebar (all, conversations, automations)',
  }),
} as const;
