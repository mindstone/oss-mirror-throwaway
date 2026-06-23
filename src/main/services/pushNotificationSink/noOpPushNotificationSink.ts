// CORE-MOVE-EXEMPT: Desktop/CLI surface adapter for the core PushNotificationSink boundary.
import type { PushNotificationPayload, PushNotificationSink } from '@core/pushNotificationSink';

export class NoOpPushNotificationSink implements PushNotificationSink {
  canSendPushNotifications(): boolean {
    return false;
  }

  async sendPushNotification(
    _userId: string | null,
    _payload: PushNotificationPayload,
  ): Promise<void> {
    // Intentionally no-op on desktop/CLI surfaces.
  }
}
