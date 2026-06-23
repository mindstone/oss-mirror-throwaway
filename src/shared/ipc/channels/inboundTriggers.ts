import { z } from 'zod';
import { defineInvokeChannel } from '../schemas/common';

// ---------------------------------------------------------------------------
// Shared Zod schemas
// ---------------------------------------------------------------------------

const InboundTriggerSourceStateSchema = z.object({
  lastSeenTs: z.string().nullable(),
  lastProcessedIds: z.array(z.string()),
});

const InboundTriggerAdapterStateSchema = z.object({
  enabled: z.boolean(),
  lastPollAt: z.number().nullable(),
  lastErrorAt: z.number().nullable(),
  lastError: z.string().nullable(),
  pollCount: z.number(),
  triggerCount: z.number(),
  sources: z.record(z.string(), InboundTriggerSourceStateSchema),
});

const InboundTriggerStoreStateSchema = z.object({
  version: z.number(),
  adapters: z.record(z.string(), InboundTriggerAdapterStateSchema),
});

// ---------------------------------------------------------------------------
// Channel definitions
// ---------------------------------------------------------------------------

export const inboundTriggersChannels = {
  'inbound-triggers:get-state': defineInvokeChannel({
    channel: 'inbound-triggers:get-state',
    request: z.void(),
    response: InboundTriggerStoreStateSchema,
    description: 'Get current state of all inbound trigger adapters',
  }),

  'inbound-triggers:set-adapter-enabled': defineInvokeChannel({
    channel: 'inbound-triggers:set-adapter-enabled',
    request: z.object({
      adapterId: z.string(),
      enabled: z.boolean(),
    }),
    response: z.void(),
    description: 'Enable or disable a specific inbound trigger adapter',
  }),

  'inbound-triggers:get-adapter-state': defineInvokeChannel({
    channel: 'inbound-triggers:get-adapter-state',
    request: z.object({
      adapterId: z.string(),
    }),
    response: InboundTriggerAdapterStateSchema.nullable(),
    description: 'Get state for a specific inbound trigger adapter',
  }),

  'inbound-triggers:check-prerequisites': defineInvokeChannel({
    channel: 'inbound-triggers:check-prerequisites',
    request: z.object({
      adapterId: z.string(),
    }),
    response: z.object({
      ready: z.boolean(),
      reason: z.string().nullable(),
    }),
    description: 'Check if an adapter has all prerequisites to be enabled',
  }),
};
