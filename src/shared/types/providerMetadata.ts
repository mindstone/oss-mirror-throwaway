import { z } from 'zod';

export const FulfillmentTransport = z.enum([
  'openrouter',
  'anthropic-direct',
  'openai-direct',
  'codex',
  'local',
  'unknown',
]);
export type FulfillmentTransport = z.infer<typeof FulfillmentTransport>;

export const FulfillmentSource = z.enum([
  'or-body',
  'or-header',
  'or-sse',
  'response-body-echo',
  'response-headers-hints',
  'unknown',
]);
export type FulfillmentSource = z.infer<typeof FulfillmentSource>;

export const FULFILLMENT_SERVER_HINT_ALLOWLIST = [
  'cf-ray',
  'x-served-by',
  'openai-version',
  'openai-processing-ms',
] as const;

const FULFILLMENT_SERVER_HINT_ALLOWLIST_SET = new Set<string>(FULFILLMENT_SERVER_HINT_ALLOWLIST);

export const FulfillmentServerHintsSchema = z.record(z.string(), z.string()).superRefine((hints, ctx) => {
  for (const key of Object.keys(hints)) {
    if (!FULFILLMENT_SERVER_HINT_ALLOWLIST_SET.has(key)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Unsupported fulfillment server hint key: ${key}`,
      });
    }
  }
});

export const FulfillmentProviderSchema = z.object({
  /**
   * Upstream physical provider name (for example, Fireworks / DeepInfra).
   * Must not include account identifiers.
   */
  name: z.string().nullable(),
  transport: FulfillmentTransport,
  source: FulfillmentSource,
  serverHints: FulfillmentServerHintsSchema.optional(),
});
export type FulfillmentProvider = z.infer<typeof FulfillmentProviderSchema>;

export const FulfillmentReceiptSchema = z.object({
  provider: FulfillmentProviderSchema.nullable(),
  /** Full ordered list of provider names observed for this unit of record, deduped at write time. */
  providersSeen: z.array(z.string()),
  observationCount: z.number().int().min(0),
});
export type FulfillmentReceipt = z.infer<typeof FulfillmentReceiptSchema>;
