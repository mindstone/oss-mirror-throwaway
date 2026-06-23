// CORE-MOVE-EXEMPT: Desktop-only adapter that requires Electron dock/taskbar APIs.
import { app, nativeImage, type NativeImage } from 'electron';
import { createScopedLogger } from '@core/logger';
import type { DockBadge } from '@core/dockBadge';
import type { EventWindow } from '@core/types';
import { isRebelTestMode } from '../../utils/testIsolation';

const log = createScopedLogger({ service: 'dockBadge' });

export class ElectronDockBadge implements DockBadge {
  private mainWindowRef: EventWindow | null = null;
  private windowsOverlayIcon: NativeImage | null = null;
  private badgeActive = false;

  initDockBadge(win: EventWindow | null): void {
    this.mainWindowRef = win;
  }

  showUnreadDot(): void {
    if (this.badgeActive || isRebelTestMode()) return;

    try {
      const overlayWindow = this.getOverlayWindow();
      if (process.platform === 'darwin') {
        app.dock?.setBadge('•');
        log.info('Dock badge shown');
      } else if (process.platform === 'win32' && overlayWindow) {
        overlayWindow.setOverlayIcon(this.getWindowsOverlayIcon(), 'Conversation ready');
        log.info('Taskbar overlay shown');
      } else {
        return;
      }
      this.badgeActive = true;
    } catch (err) {
      log.warn({ err }, 'Failed to set dock badge');
    }
  }

  clearUnreadDot(): void {
    if (!this.badgeActive) return;
    this.badgeActive = false;

    try {
      const overlayWindow = this.getOverlayWindow();
      if (process.platform === 'darwin') {
        app.dock?.setBadge('');
        log.info('Dock badge cleared');
      } else if (process.platform === 'win32' && overlayWindow) {
        overlayWindow.setOverlayIcon(null, '');
        log.info('Taskbar overlay cleared');
      }
    } catch (err) {
      this.badgeActive = true;
      log.warn({ err }, 'Failed to clear dock badge');
    }
  }

  private getOverlayWindow(): (EventWindow & { setOverlayIcon: (icon: NativeImage | null, description: string) => void }) | null {
    if (
      this.mainWindowRef
      && !this.mainWindowRef.isDestroyed()
      && 'setOverlayIcon' in this.mainWindowRef
      && typeof (this.mainWindowRef as { setOverlayIcon?: unknown }).setOverlayIcon === 'function'
    ) {
      return this.mainWindowRef as EventWindow & { setOverlayIcon: (icon: NativeImage | null, description: string) => void };
    }
    return null;
  }

  private getWindowsOverlayIcon(): NativeImage {
    if (this.windowsOverlayIcon) return this.windowsOverlayIcon;

    const size = 16;
    const canvas = Buffer.alloc(size * size * 4);
    const cx = size / 2;
    const cy = size / 2;
    const r = 6;

    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const dx = x - cx + 0.5;
        const dy = y - cy + 0.5;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const offset = (y * size + x) * 4;

        if (dist <= r) {
          const alpha = dist > r - 1 ? Math.round(255 * (r - dist)) : 255;
          canvas[offset] = 239;
          canvas[offset + 1] = 68;
          canvas[offset + 2] = 68;
          canvas[offset + 3] = alpha;
        }
      }
    }

    this.windowsOverlayIcon = nativeImage.createFromBuffer(canvas, { width: size, height: size });
    return this.windowsOverlayIcon;
  }
}
