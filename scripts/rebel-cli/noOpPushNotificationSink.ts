import type { PushNotificationPayload, PushNotificationSink } from '@core/pushNotificationSink';

export class NoOpPushNotificationSink implements PushNotificationSink {
  canSendPushNotifications(): boolean {
    return false;
  }

  async sendPushNotification(
    _userId: string | null,
    _payload: PushNotificationPayload,
  ): Promise<void> {
    // Intentionally no-op for standalone CLI.
  }
}
