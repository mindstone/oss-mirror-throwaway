import {
  getDesktopNotificationSink,
  type DesktopNotificationParams,
} from '@core/desktopNotificationSink';

export type { DesktopNotificationParams };

export function showDesktopNotification(params: DesktopNotificationParams): void {
  getDesktopNotificationSink().showDesktopNotification(params);
}
