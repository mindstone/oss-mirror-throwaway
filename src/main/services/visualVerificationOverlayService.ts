import type { BrowserWindow } from 'electron';

type VisualVerificationOverlayPhase = 'navigating' | 'preparing' | 'captured';
type VisualVerificationRestoreTarget = {
  url: string;
  label: string;
};

type VisualVerificationOverlayEventDetail =
  | {
      action: 'show';
      phase: VisualVerificationOverlayPhase;
      message: string;
      autoHideMs?: number;
    }
  | {
      action: 'hide';
    };

const VISUAL_CAPTURE_OVERLAY_EVENT = 'rebel:visual-capture-overlay';
const RESTORE_AFTER_CAPTURE_MS = 5_000;
const OVERLAY_MIN_VISIBLE_MS = 450;

let pendingRestoreTarget: VisualVerificationRestoreTarget | null = null;
let pendingRestoreTimer: ReturnType<typeof setTimeout> | null = null;

export function registerVisualVerificationRestoreTarget(target: VisualVerificationRestoreTarget | null): void {
  pendingRestoreTarget = target;
  if (pendingRestoreTimer) {
    clearTimeout(pendingRestoreTimer);
    pendingRestoreTimer = null;
  }
}

export async function emitVisualVerificationOverlay(
  win: BrowserWindow,
  detail: VisualVerificationOverlayEventDetail,
): Promise<void> {
  if (win.isDestroyed()) return;

  try {
    await win.webContents.executeJavaScript(
      `window.dispatchEvent(new CustomEvent(${JSON.stringify(VISUAL_CAPTURE_OVERLAY_EVENT)}, { detail: ${JSON.stringify(detail)} }))`,
      true,
    );
  } catch {
    // This affordance must never block the actual navigation or screenshot.
  }
}

export async function waitForRendererPaint(win: BrowserWindow): Promise<void> {
  if (win.isDestroyed()) return;

  try {
    await win.webContents.executeJavaScript(
      'new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))',
      true,
    );
  } catch {
    // Best-effort paint wait only.
  }
}

export async function waitForVisualVerificationOverlayCue(win: BrowserWindow): Promise<void> {
  if (win.isDestroyed()) return;

  try {
    await win.webContents.executeJavaScript(
      `new Promise((resolve) => {
        requestAnimationFrame(() => {
          window.setTimeout(() => requestAnimationFrame(resolve), ${OVERLAY_MIN_VISIBLE_MS});
        });
      })`,
      true,
    );
  } catch {
    // Best-effort visibility delay only.
  }
}

export function scheduleVisualVerificationRestore(win: BrowserWindow): void {
  if (!pendingRestoreTarget || win.isDestroyed()) return;

  if (pendingRestoreTimer) {
    clearTimeout(pendingRestoreTimer);
  }

  pendingRestoreTimer = setTimeout(() => {
    const target = pendingRestoreTarget;
    pendingRestoreTarget = null;
    pendingRestoreTimer = null;

    if (!target || win.isDestroyed()) return;

    void (async () => {
      try {
        await emitVisualVerificationOverlay(win, {
          action: 'show',
          phase: 'navigating',
          message: `Returning to ${target.label}`,
          autoHideMs: 3_000,
        });
        await win.webContents.executeJavaScript(
          `globalThis.__rebelNavigateForTool?.(${JSON.stringify(target.url)})`,
          true,
        );
        await waitForRendererPaint(win);
      } finally {
        await emitVisualVerificationOverlay(win, { action: 'hide' });
      }
    })().catch(() => {
      // Restoring context is best-effort; failed restore should not crash the turn.
    });
  }, RESTORE_AFTER_CAPTURE_MS);
}
