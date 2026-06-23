import type { BrowserWindow } from 'electron';
import { createScopedLogger } from '@core/logger';

const NOTIFICATION_CLICK_INTENT_TTL_MS = 5 * 60 * 1000;
const log = createScopedLogger({ service: 'notificationClickIntent' });

export interface NotificationClickDestination {
  sessionId?: string;
  filePath?: string;
}

export interface NotificationClickIntent extends NotificationClickDestination {
  clickedAt: number;
}

export type NotificationClickIntentMissReason = 'miss-empty' | 'miss-expired';

export type NotificationClickIntentConsumeResult =
  | { intent: NotificationClickIntent; intentAgeMs: number; missReason?: never }
  | { intent: null; intentAgeMs: null; missReason: 'miss-empty' }
  | { intent: null; intentAgeMs: number; missReason: 'miss-expired' };

interface NotificationWindowTarget {
  getMainWindow: () => BrowserWindow | null;
  ensureMainWindow: () => Promise<BrowserWindow | null>;
}

let pendingIntent: NotificationClickIntent | null = null;
let notificationWindowTarget: NotificationWindowTarget = {
  getMainWindow: () => {
    log.warn('Notification window target used before wiring');
    return null;
  },
  ensureMainWindow: async () => {
    log.warn('Notification window ensure used before wiring');
    return null;
  },
};

export function recordNotificationClickIntent(
  payload: NotificationClickDestination,
  clickedAt = Date.now(),
): NotificationClickIntent {
  if (!payload.sessionId && !payload.filePath) {
    throw new Error('Notification click intent requires a sessionId or filePath.');
  }

  const intent: NotificationClickIntent = { clickedAt };
  if (payload.sessionId) {
    intent.sessionId = payload.sessionId;
  }
  if (payload.filePath) {
    intent.filePath = payload.filePath;
  }
  pendingIntent = intent;
  return intent;
}

export function consumePendingNotificationClickIntentResult(now = Date.now()): NotificationClickIntentConsumeResult {
  const intent = pendingIntent;
  pendingIntent = null;

  if (!intent) {
    return { intent: null, intentAgeMs: null, missReason: 'miss-empty' };
  }

  const intentAgeMs = now - intent.clickedAt;
  if (intentAgeMs > NOTIFICATION_CLICK_INTENT_TTL_MS) {
    return { intent: null, intentAgeMs, missReason: 'miss-expired' };
  }

  return { intent, intentAgeMs };
}

export function consumePendingNotificationClickIntent(now = Date.now()): NotificationClickIntent | null {
  return consumePendingNotificationClickIntentResult(now).intent;
}

export function setNotificationWindowTarget(target: NotificationWindowTarget): void {
  notificationWindowTarget = target;
}

export function getLiveNotificationMainWindow(): BrowserWindow | null {
  const win = notificationWindowTarget.getMainWindow();
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) {
    return null;
  }
  return win;
}

export async function ensureNotificationMainWindow(): Promise<BrowserWindow | null> {
  const win = await notificationWindowTarget.ensureMainWindow();
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) {
    return null;
  }
  return win;
}
