import type { DockBadge } from '@core/dockBadge';
import type { EventWindow } from '@core/types';

export class CloudDockBadge implements DockBadge {
  initDockBadge(_win: EventWindow | null): void {
    // No-op in cloud.
  }

  showUnreadDot(): void {
    // No-op in cloud.
  }

  clearUnreadDot(): void {
    // No-op in cloud.
  }
}
