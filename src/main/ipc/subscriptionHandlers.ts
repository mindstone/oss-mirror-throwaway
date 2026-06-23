import type { IpcMainInvokeEvent } from 'electron';
import { shell } from 'electron';
import {
  subscriptionChannels,
  type SubscriptionTierPayload,
  type SubscriptionCheckoutOrigin,
} from '@shared/ipc/channels/subscription';
import { createScopedLogger } from '@core/logger';
import { registerHandler } from './utils/registerHandler';
import { getRebelAuthProvider } from '@core/rebelAuth';
import { MINDSTONE_API_URL as API_URL } from '@core/services/mindstoneApiUrl';
import { mainTracking } from '../tracking';
import {
  parseStripeSessionId,
  recordPendingCheckout,
} from '../services/pendingCheckoutTier';

const log = createScopedLogger({ ipc: 'subscription' });

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function getErrorMessage(data: unknown, fallback: string): string {
  const record = asRecord(data);
  return typeof record?.error === 'string' ? record.error : fallback;
}

function getUrl(data: unknown): string {
  const record = asRecord(data);
  if (typeof record?.url !== 'string') {
    throw new Error('Server response did not include a subscription URL');
  }
  return record.url;
}

export function registerSubscriptionHandlers(): void {
  registerHandler(
    subscriptionChannels['subscription:create-checkout'].channel,
    async (
      _event: IpcMainInvokeEvent,
      payload: { tier: SubscriptionTierPayload; origin: SubscriptionCheckoutOrigin },
    ) => {
      try {
        const accessToken = await getRebelAuthProvider().getAccessToken();
        if (!accessToken) throw new Error('Not authenticated');

        const response = await fetch(`${API_URL}/api/subscription/checkout`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ tier: payload.tier, origin: payload.origin }),
        });

        if (!response.ok) {
          const data: unknown = await response.json().catch(() => ({}));
          throw new Error(getErrorMessage(data, `Server error: ${response.status}`));
        }

        const data: unknown = await response.json();
        const url = getUrl(data);
        const sessionId = parseStripeSessionId(url);
        recordPendingCheckout({ tier: payload.tier, sessionId });
        await shell.openExternal(url);
        mainTracking.subscription.checkoutStarted({ tier: payload.tier, origin: payload.origin });
        return { url };
      } catch (error) {
        log.error({ error }, 'Failed to create checkout session');
        throw error;
      }
    },
  );

  registerHandler(
    subscriptionChannels['subscription:create-portal'].channel,
    async (_event: IpcMainInvokeEvent) => {
      try {
        const accessToken = await getRebelAuthProvider().getAccessToken();
        if (!accessToken) throw new Error('Not authenticated');

        const response = await fetch(`${API_URL}/api/subscription/portal`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
        });

        if (!response.ok) {
          const data: unknown = await response.json().catch(() => ({}));
          throw new Error(getErrorMessage(data, `Server error: ${response.status}`));
        }

        const data: unknown = await response.json();
        const url = getUrl(data);
        await shell.openExternal(url);
        mainTracking.subscription.portalOpened();
        return { url };
      } catch (error) {
        log.error({ error }, 'Failed to create portal session');
        throw error;
      }
    },
  );

  registerHandler(
    subscriptionChannels['subscription:get-status'].channel,
    async (_event: IpcMainInvokeEvent) => {
      const accessToken = await getRebelAuthProvider().getAccessToken();
      if (!accessToken) {
        // Not authenticated — genuinely no subscription to check.
        return { subscription: null };
      }

      try {
        const response = await fetch(`${API_URL}/api/subscription/status`, {
          method: 'GET',
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
        });

        if (!response.ok) {
          const data: unknown = await response.json().catch(() => ({}));
          throw new Error(getErrorMessage(data, `Server error: ${response.status}`));
        }

        const data: unknown = await response.json();
        return data;
      } catch (error) {
        log.error({ error }, 'Failed to get subscription status');
        // Re-throw so the renderer can distinguish fetch failure from "no subscription".
        throw error;
      }
    },
  );

  log.info('Subscription IPC handlers registered');
}
