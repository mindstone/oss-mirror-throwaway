/**
 * Global suppression flag for toasts and notifications.
 * Used during onboarding coach to keep parallel work a surprise.
 */

let suppressed = false;

export function setSuppressNotifications(value: boolean): void {
  suppressed = value;
}

export function isNotificationsSuppressed(): boolean {
  return suppressed;
}
