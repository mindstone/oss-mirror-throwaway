import { getDockBadge } from '@core/dockBadge';
import type { EventWindow } from '@core/types';

export function initDockBadge(win: EventWindow): void {
  getDockBadge().initDockBadge(win);
}

export function showUnreadDot(): void {
  getDockBadge().showUnreadDot();
}

export function clearUnreadDot(): void {
  getDockBadge().clearUnreadDot();
}
