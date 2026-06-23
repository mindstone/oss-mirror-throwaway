import { z } from 'zod';
import { defineInvokeChannel } from '../schemas/common';

export const SubscriptionTierSchema = z.enum(['dash', 'rogue']);
export type SubscriptionTierPayload = z.infer<typeof SubscriptionTierSchema>;

export const SubscriptionCheckoutOriginSchema = z.enum(['settings', 'onboarding', 'resubscribe']);
export type SubscriptionCheckoutOrigin = z.infer<typeof SubscriptionCheckoutOriginSchema>;

export const SubscriptionStateSchema = z.object({
  tier: SubscriptionTierSchema,
  status: z.enum(['active', 'past_due', 'canceled', 'incomplete', 'trialing', 'inactive']),
  currentPeriodEnd: z.string().nullable(),
  cancelAtPeriodEnd: z.boolean(),
  pastDueSince: z.string().nullable(),
  graceEndsAt: z.string().nullable(),
  routingAvailable: z.boolean(),
});

/**
 * Payload of the `subscription:callback` push event (main → renderer, after a
 * Stripe checkout deep-link returns). This is a manual `webContents.send` /
 * `ipcRenderer.on` event, NOT an invoke channel — so it lives here as a shared
 * schema + type rather than in `subscriptionChannels`. Both the emit site
 * (`src/main/index.ts`) and the bridge (`src/preload/index.ts`) use this single
 * definition so the `expectedTier` carried across the seam can't drift between
 * producer and consumer (the cross-process variant of the predicate-drift bug
 * this run hardens). `status` is intentionally a free string (Stripe sends
 * `success` | `cancel` | other), matched at the consumer.
 */
export const SubscriptionCallbackPayloadSchema = z.object({
  status: z.string(),
  expectedTier: SubscriptionTierSchema.optional(),
});
export type SubscriptionCallbackPayload = z.infer<typeof SubscriptionCallbackPayloadSchema>;

/**
 * Tolerant coercion of a raw `subscription:callback` IPC payload, used by the
 * preload bridge. Returns the validated payload on a schema match; on a miss
 * degrades to status-only when a string `status` is present (so a future
 * payload variant — e.g. a new tier the schema doesn't know yet — never
 * silently drops the callback, only loses the unparseable `expectedTier`);
 * returns null when there's nothing usable. Centralised here so the bridge's
 * parse is the single chokepoint and unit-testable without importing preload.
 */
export function coerceSubscriptionCallbackPayload(data: unknown): SubscriptionCallbackPayload | null {
  const parsed = SubscriptionCallbackPayloadSchema.safeParse(data);
  if (parsed.success) return parsed.data;
  const status = (data as { status?: unknown } | null | undefined)?.status;
  return typeof status === 'string' ? { status } : null;
}

export const subscriptionChannels = {
  'subscription:create-checkout': defineInvokeChannel({
    channel: 'subscription:create-checkout',
    request: z.object({
      tier: SubscriptionTierSchema,
      origin: SubscriptionCheckoutOriginSchema,
    }),
    response: z.object({ url: z.string() }),
    description: 'Create Stripe checkout session for subscription tier',
  }),

  'subscription:create-portal': defineInvokeChannel({
    channel: 'subscription:create-portal',
    request: z.void(),
    response: z.object({ url: z.string() }),
    description: 'Create Stripe customer portal session for subscription management',
  }),

  'subscription:get-status': defineInvokeChannel({
    channel: 'subscription:get-status',
    request: z.void(),
    response: z.object({ subscription: SubscriptionStateSchema.nullable() }),
    description: 'Get current subscription status',
  }),
};
