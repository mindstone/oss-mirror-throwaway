import { beforeEach, describe, expect, it, vi } from 'vitest';
import { desktopAppNavigationService } from './desktopAppNavigationService';

const electronMock = vi.hoisted(() => ({
  focusedWindow: null as import('electron').BrowserWindow | null,
  allWindows: [] as import('electron').BrowserWindow[],
}));

const overlayMock = vi.hoisted(() => ({
  emitVisualVerificationOverlay: vi.fn(),
  registerVisualVerificationRestoreTarget: vi.fn(),
  waitForRendererPaint: vi.fn(),
  waitForVisualVerificationOverlayCue: vi.fn(),
}));

 
vi.mock('electron', () => ({
  BrowserWindow: {
    getFocusedWindow: vi.fn(() => electronMock.focusedWindow),
    getAllWindows: vi.fn(() => electronMock.allWindows),
  },
}));

vi.mock('./visualVerificationOverlayService', () => ({
  emitVisualVerificationOverlay: overlayMock.emitVisualVerificationOverlay,
  registerVisualVerificationRestoreTarget: overlayMock.registerVisualVerificationRestoreTarget,
  waitForRendererPaint: overlayMock.waitForRendererPaint,
  waitForVisualVerificationOverlayCue: overlayMock.waitForVisualVerificationOverlayCue,
}));

function createWindowMock(previousSurface = 'home'): import('electron').BrowserWindow {
  const executeJavaScript = vi.fn(async (script: string) => {
    if (script.includes("typeof globalThis.__rebelNavigateForTool === 'function'")) {
      return true;
    }
    if (script.includes('__rebelGetCurrentSurfaceForTool')) {
      return previousSurface;
    }
    if (script.includes('__rebelNavigateForTool')) {
      return true;
    }
    return undefined;
  });

  return {
    isDestroyed: vi.fn(() => false),
    webContents: {
      executeJavaScript,
    },
  } as unknown as import('electron').BrowserWindow;
}

describe('desktopAppNavigationService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    overlayMock.waitForRendererPaint.mockResolvedValue(undefined);
    electronMock.focusedWindow = createWindowMock();
    electronMock.allWindows = [];
  });

  it('navigates plain settings requests to the settings surface', async () => {
    const result = await desktopAppNavigationService.navigateApp({ destination: 'settings' });
    const win = electronMock.focusedWindow!;

    expect(result).toEqual({ kind: 'ok', destination: 'settings' });
    expect(win.webContents.executeJavaScript).toHaveBeenCalledWith(
      'globalThis.__rebelNavigateForTool?.("rebel://settings")',
      true,
    );
    expect(overlayMock.waitForRendererPaint).toHaveBeenCalledWith(win);
  });

  it('navigates settings tab requests to the matching settings deep link', async () => {
    const result = await desktopAppNavigationService.navigateApp({
      destination: 'settings',
      settingsTab: 'meetings',
      settingsSection: 'advanced',
    });
    const win = electronMock.focusedWindow!;

    expect(result).toEqual({
      kind: 'ok',
      destination: 'settings',
      settingsTab: 'meetings',
      settingsSection: 'advanced',
    });
    expect(win.webContents.executeJavaScript).toHaveBeenCalledWith(
      'globalThis.__rebelNavigateForTool?.("rebel://settings/meetings#advanced")',
      true,
    );
    expect(overlayMock.emitVisualVerificationOverlay).toHaveBeenCalledWith(
      win,
      expect.objectContaining({
        message: 'Opening Settings > Meetings for a screenshot',
      }),
    );
  });

  it('rejects settings modifiers on non-settings destinations before touching the renderer bridge', async () => {
    const result = await desktopAppNavigationService.navigateApp({
      destination: 'actions',
      settingsTab: 'meetings',
    });
    const win = electronMock.focusedWindow!;

    expect(result).toEqual({
      kind: 'error',
      errorCode: 'invalid-destination-modifiers',
      detail: {
        reason: 'settingsTab and settingsSection can only be used when destination is settings',
        destination: 'actions',
      },
    });
    expect(win.webContents.executeJavaScript).not.toHaveBeenCalled();
  });

  it('waits for the renderer navigation bridge before navigating', async () => {
    const executeJavaScript = vi
      .fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce('home')
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined);
    electronMock.focusedWindow = {
      isDestroyed: vi.fn(() => false),
      webContents: {
        executeJavaScript,
      },
    } as unknown as import('electron').BrowserWindow;

    const result = await desktopAppNavigationService.navigateApp({ destination: 'actions' });

    expect(result).toEqual({ kind: 'ok', destination: 'actions' });
    expect(executeJavaScript).toHaveBeenCalledWith(
      `typeof globalThis.__rebelNavigateForTool === 'function' && typeof globalThis.__rebelGetCurrentSurfaceForTool === 'function'`,
      true,
    );
    expect(executeJavaScript).toHaveBeenCalledWith(
      'globalThis.__rebelNavigateForTool?.("rebel://tasks")',
      true,
    );
  });
});
