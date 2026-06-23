// CORE-MOVE-EXEMPT: Desktop-only adapter that requires Electron Notification/BrowserWindow APIs.
import { Notification, type BrowserWindow } from 'electron';
import { createScopedLogger } from '@core/logger';
import type {
  DesktopNotificationParams,
  DesktopNotificationSink,
} from '@core/desktopNotificationSink';
import { getSettings } from '@core/services/settingsStore';
import { fireAndForget } from '@shared/utils/fireAndForget';
import { isRebelTestMode } from '../../utils/testIsolation';
import {
  ensureNotificationMainWindow,
  getLiveNotificationMainWindow,
  recordNotificationClickIntent,
} from './notificationClickIntent';

const log = createScopedLogger({ service: 'desktopNotification' });
const MAX_RETAINED_NOTIFICATIONS = 50;
const retainedNotifications = new Set<Notification>();

function retainNotification(notification: Notification): void {
  retainedNotifications.add(notification);
  while (retainedNotifications.size > MAX_RETAINED_NOTIFICATIONS) {
    const oldest = retainedNotifications.values().next().value;
    if (!oldest) {
      return;
    }
    retainedNotifications.delete(oldest);
  }
}

function releaseNotification(notification: Notification): void {
  retainedNotifications.delete(notification);
}

function focusAndNudgeMainWindow(win: BrowserWindow): void {
  if (win.isDestroyed() || win.webContents.isDestroyed()) {
    return;
  }
  if (!win.isVisible()) {
    win.show();
  }
  if (win.isMinimized()) {
    win.restore();
  }
  win.focus();
  win.webContents.send('notification:clicked');
}

export class ElectronDesktopNotificationSink implements DesktopNotificationSink {
  showDesktopNotification(params: DesktopNotificationParams): void {
    try {
      const { title, body, sessionId, filePath } = params;
      if (!title || (!sessionId && !filePath)) {
        log.debug({ params }, 'Missing required notification fields');
        return;
      }

      if (isRebelTestMode()) {
        log.debug('Notifications suppressed in rebel-test mode');
        return;
      }

      if (getSettings().notifications?.enabled !== true) {
        log.debug('Notifications disabled in settings');
        return;
      }

      if (!Notification.isSupported()) {
        log.debug('Notifications not supported on this platform');
        return;
      }

      const notification = new Notification({
        title,
        body: body || '',
      });

      notification.on('click', () => {
        releaseNotification(notification);
        try {
          recordNotificationClickIntent({ sessionId, filePath });
          fireAndForget((async () => {
            const win = getLiveNotificationMainWindow() ?? await ensureNotificationMainWindow();
            if (!win) {
              log.warn({ sessionId, filePath }, 'Notification clicked but no main window was available');
              return;
            }
            focusAndNudgeMainWindow(win);
          })(), 'desktopNotification.click.ensureMainWindow');

          log.info({ sessionId, filePath }, 'Notification clicked');
        } catch (err) {
          log.warn({ err, sessionId, filePath }, 'Error handling notification click');
        }
      });
      // Deliberately NOT released on 'close': macOS can emit it when a banner
      // auto-dismisses to Notification Center, which is exactly the
      // delayed-click case this retention exists for. The size-capped set
      // bounds the cost of retaining instead.
      notification.on('failed', () => releaseNotification(notification));

      notification.show();
      retainNotification(notification);
      log.info({ sessionId, filePath, title }, 'Desktop notification shown');
    } catch (err) {
      log.debug({ err, params }, 'Failed to show desktop notification');
    }
  }
}
