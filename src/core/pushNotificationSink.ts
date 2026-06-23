/**
 * PushNotificationSink — boundary interface for notification delivery.
 *
 * Shared services emit notification intents through this sink while each
 * surface wires an environment-specific delivery implementation.
 */

import type { PushNotificationData } from '@shared/schemas/pushNotifications';

export interface PushNotificationPayload {
  title: string;
  body: string;
  data: PushNotificationData;
}

export interface PushNotificationSink {
  canSendPushNotifications(): boolean;
  sendPushNotification(userId: string | null, payload: PushNotificationPayload): Promise<void>;
}

export type PushNotificationSinkFactory = () => PushNotificationSink;

let _factory: PushNotificationSinkFactory | undefined;
let _instance: PushNotificationSink | undefined;

export function setPushNotificationSinkFactory(factory: PushNotificationSinkFactory): void {
  _factory = factory;
  _instance = undefined;
}

export function getPushNotificationSink(): PushNotificationSink {
  if (_instance) return _instance;
  if (!_factory) {
    throw new Error(
      'PushNotificationSink not initialized. Call setPushNotificationSinkFactory() before sending push notifications.',
    );
  }
  _instance = _factory();
  return _instance;
}
