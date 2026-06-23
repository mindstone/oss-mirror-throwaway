import type { DockBadge } from '@core/dockBadge';
import type { EventWindow } from '@core/types';

export class StandaloneDockBadge implements DockBadge {
  initDockBadge(_win: EventWindow | null): void {
    // No-op in standalone CLI.
  }

  showUnreadDot(): void {
    // No-op in standalone CLI.
  }

  clearUnreadDot(): void {
    // No-op in standalone CLI.
  }
}
