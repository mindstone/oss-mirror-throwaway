import { z } from 'zod';

/**
 * Push channel: behind-the-scenes structured-output bypass.
 *
 * Fired by the resolver when a chosen profile is silently swapped for the
 * default auxiliary model because of a stored
 * `jsonCompatibility: 'incompatible'` flag (see `executeWithStructuredOutputProfileFallback`
 * in `src/core/services/behindTheScenesClient.ts`). The bypass is logged on
 * every call, but the user otherwise has no way to discover that their chosen
 * model is being skipped — so we surface a one-time toast.
 */
export const BTS_STRUCTURED_OUTPUT_BYPASS_CHANNEL = 'bts:structured-output-bypassed';

export const BtsStructuredOutputBypassPayloadSchema = z.object({
  profileId: z.string(),
  profileName: z.string(),
  fellBackTo: z.string(),
  caller: z.string().nullable(),
});

export type BtsStructuredOutputBypassPayload = z.infer<
  typeof BtsStructuredOutputBypassPayloadSchema
>;
