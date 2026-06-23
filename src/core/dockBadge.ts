import type { EventWindow } from '@core/types';

export interface DockBadge {
  initDockBadge(win: EventWindow | null): void;
  showUnreadDot(): void;
  clearUnreadDot(): void;
}

export type DockBadgeFactory = () => DockBadge;

let _factory: DockBadgeFactory | undefined;
let _instance: DockBadge | undefined;

export function setDockBadgeFactory(factory: DockBadgeFactory): void {
  _factory = factory;
  _instance = undefined;
}

export function getDockBadge(): DockBadge {
  if (_instance) return _instance;
  if (!_factory) {
    throw new Error('DockBadge not initialized. Call setDockBadgeFactory() before use.');
  }
  _instance = _factory();
  return _instance;
}
