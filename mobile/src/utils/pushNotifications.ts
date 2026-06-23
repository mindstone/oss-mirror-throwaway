/**
 * Push Notification Setup for Mobile
 *
 * Handles permission requests, token registration with the cloud service,
 * and incoming notification handling. Uses the existing cloud-service
 * push token registration endpoints.
 *
 * Wire payloads are validated against the shared schema in
 * `@shared/schemas/pushNotifications`. Unrecognised payloads are logged
 * (with sanitised metadata only — no raw fields, since cloud-client logger
 * forwards `data` to Sentry breadcrumbs) and dropped without routing.
 *
 * @see docs/plans/finished/260502_typed_push_notification_payload.md
 */

import * as Notifications from 'expo-notifications';
import Constants from 'expo-constants';
import { Platform } from 'react-native';
import { createLogger } from '@rebel/cloud-client';
import { router } from 'expo-router';
import {
  PushNotificationDataSchema,
  type PushNotificationData,
} from '@shared/schemas/pushNotifications';

const log = createLogger('push');

// Configure notification display behavior
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: true,
  }),
});

let _registered = false;

export async function registerForPushNotifications(cloudUrl: string, token: string): Promise<void> {
  if (_registered) return;

  // This function is fire-and-forget from the paired-state effect in
  // `app/_layout.tsx` (un-awaited), so it MUST own all of its failures and
  // never reject. The permission probes below call into ExpoModulesCore
  // (`getRegistrationInfoAsync`), which can fail natively on simulators,
  // restricted devices, or transient module errors — REBEL-1CN. An escaping
  // rejection became an unhandled-promise Sentry crash that retried on every
  // effect re-run (255 events / 2 users). The whole body is guarded so push
  // registration degrades gracefully (the app works without push).
  try {
    const { status: existingStatus } = await Notifications.getPermissionsAsync();
    let finalStatus = existingStatus;

    if (existingStatus !== 'granted') {
      const { status } = await Notifications.requestPermissionsAsync();
      finalStatus = status;
    }

    if (finalStatus !== 'granted') {
      log.info('Push notification permission not granted');
      return;
    }

    const projectId = Constants.expoConfig?.extra?.eas?.projectId;
    if (!projectId) {
      log.warn('No EAS projectId — cannot get push token');
      return;
    }

    const pushToken = await Notifications.getExpoPushTokenAsync({ projectId });
    const platform = Platform.OS === 'ios' ? 'ios' : 'android';

    const res = await fetch(`${cloudUrl.replace(/\/+$/, '')}/api/push/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ deviceToken: pushToken.data, platform }),
    });

    if (res.ok) {
      _registered = true;
      log.info('Push token registered', { platform });
    } else {
      log.warn('Failed to register push token', { status: res.status });
    }
  } catch (err) {
    log.error('Push token registration error', { error: err instanceof Error ? err.message : String(err) });
  }
}

export async function unregisterPushNotifications(cloudUrl: string, token: string): Promise<void> {
  if (!_registered) return;

  try {
    const projectId = Constants.expoConfig?.extra?.eas?.projectId;
    if (!projectId) return;

    const pushToken = await Notifications.getExpoPushTokenAsync({ projectId });

    await fetch(`${cloudUrl.replace(/\/+$/, '')}/api/push/unregister`, {
      method: 'DELETE',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ deviceToken: pushToken.data }),
    });

    _registered = false;
    log.info('Push token unregistered');
  } catch (err) {
    log.warn('Push token unregister error', { error: err instanceof Error ? err.message : String(err) });
  }
}

/**
 * Pure routing helper — exported for testing. Given a parsed push
 * payload, decides which screen the tap should land on. The exhaustive
 * `switch` over `data.type` makes new top-level types compile-fail
 * here until they're handled deliberately.
 *
 * Today's routing is type-level only; new `kind` values within an
 * existing `type` do not force a decoder change unless they need
 * kind-specific routing.
 */
export function routePushNotification(data: PushNotificationData): void {
  switch (data.type) {
    case 'conversation':
      router.push(`/conversation/${data.sessionId}`);
      return;
    case 'approval':
      if (data.sessionId) {
        router.push(`/conversation/${data.sessionId}`);
      } else {
        router.push('/(tabs)/inbox');
      }
      return;
    case 'coaching':
      // Coaching cards are anchored to a meeting/companion session; tap
      // routes to that session, falling back to inbox if absent. (This
      // path was previously dropped silently — bug fixed by this refactor.)
      if (data.sessionId) {
        router.push(`/conversation/${data.sessionId}`);
      } else {
        router.push('/(tabs)/inbox');
      }
      return;
    case 'meeting-analysis-complete':
      // Meeting analysis lives on the companion session view. (This
      // path was also previously dropped silently.)
      router.push(`/conversation/${data.sessionId}`);
      return;
    default: {
      // Exhaustiveness guard — new `type` literals will fail to compile here.
      // We log a sanitised marker only (no payload values, since this log
      // is forwarded to Sentry breadcrumbs by the cloud-client logger).
      const _exhaustive: never = data;
      void _exhaustive;
      log.warn('Unhandled push notification type (decoder out-of-date)');
    }
  }
}

/**
 * Pure dispatcher — exported for testing. Validates a raw push payload
 * (as delivered by `expo-notifications`'s response listener), routes it
 * via `routePushNotification` on success, and emits a sanitised
 * structured warn log on parse failure (without leaking raw payload
 * values into Sentry breadcrumbs).
 */
export function dispatchPushNotificationData(raw: unknown): void {
  const parsed = PushNotificationDataSchema.safeParse(raw);
  if (!parsed.success) {
    // Log sanitised metadata only. The cloud-client logger forwards
    // `warn` data to Sentry breadcrumbs (see cloud-client/src/utils/logger.ts),
    // so we must not include any raw payload values — not the
    // `sessionId`, not the `meetingTitle`, and not even `data.type`
    // (a stale or buggy cloud build could put an arbitrary string there).
    // Log shape metadata + key names only. Zod issue paths/messages are
    // structural and don't echo the rejected value.
    const rawObj: Record<string, unknown> | null =
      raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null;
    log.warn('Unrecognised push payload', {
      hasType: rawObj ? 'type' in rawObj : false,
      typeIsString: typeof rawObj?.type === 'string',
      hasSessionId: rawObj ? 'sessionId' in rawObj : false,
      keys: rawObj ? Object.keys(rawObj) : [],
      issues: parsed.error.flatten(),
    });
    return;
  }
  routePushNotification(parsed.data);
}

export function setupNotificationListeners(): () => void {
  // Handle notification taps (opens the relevant screen)
  const subscription = Notifications.addNotificationResponseReceivedListener((response) => {
    dispatchPushNotificationData(response.notification.request.content.data);
  });

  return () => subscription.remove();
}
