import type { DesktopNotificationParams, DesktopNotificationSink } from '@core/desktopNotificationSink';

export class StandaloneDesktopNotificationSink implements DesktopNotificationSink {
  showDesktopNotification(_params: DesktopNotificationParams): void {
    // No-op in standalone CLI.
  }
}
