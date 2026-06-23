import type { DesktopNotificationParams, DesktopNotificationSink } from '@core/desktopNotificationSink';

export class CloudDesktopNotificationSink implements DesktopNotificationSink {
  showDesktopNotification(_params: DesktopNotificationParams): void {
    // No-op in cloud.
  }
}
