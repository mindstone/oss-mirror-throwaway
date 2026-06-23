export type CaptureErrorCode =
  | 'window-not-found'
  | 'window-not-capturable'
  | 'capture-failed'
  | 'capture-storage-full'
  | 'theme-cycling-unavailable'
  | 'screenshot-not-supported-on-this-surface'
  | 'visual-app-access-denied'
  | 'surface-mismatch'
  | 'capture-busy'
  | 'invalid-label';

export type CaptureMode = 'viewport' | 'scroll';

export interface CaptureImageResult {
  path: string;
  width: number;
  height: number;
  bytes: number;
  base64Data: string;
  mimeType: 'image/png';
  index?: number;
  scrollTop?: number;
}

export type CaptureResult =
  | {
      kind: 'ok';
      path: string;
      width: number;
      height: number;
      theme: 'light' | 'dark';
      bytes: number;
      label?: string;
      currentSurface: string;
      base64Data: string;
      mimeType: 'image/png';
      captures?: CaptureImageResult[];
    }
  | {
      kind: 'error';
      errorCode: CaptureErrorCode;
      detail?: unknown;
    };

export interface ScreenshotCaptureService {
  // See docs/project/UI_CHIEF_DESIGNER_VISUAL_VERIFICATION.md for why capture is a core boundary.
  captureRebelWindow(input: {
    theme: 'current' | 'light' | 'dark';
    label?: string;
    captureMode?: CaptureMode;
    maxScreenshots?: number;
  }): Promise<CaptureResult>;
}

let _screenshotCaptureService: ScreenshotCaptureService | null = null;

// CROSS_SURFACE_PARITY_EXEMPT: Desktop-only: requires Electron desktopCapturer + BrowserWindow APIs to capture the Rebel app's own window content; cloud has no GUI surface and mobile uses distinct React Native screen-capture APIs; safe because getScreenshotCaptureService() returns null on cloud/mobile and callers handle graceful no-op (screenshot-not-supported-on-this-surface error code). Baseline acknowledgement at gate rollout (260516).
export function setScreenshotCaptureService(service: ScreenshotCaptureService): void {
  _screenshotCaptureService = service;
}

export function getScreenshotCaptureService(): ScreenshotCaptureService | null {
  // Cloud/mobile intentionally leave this unset; callers must handle graceful no-op.
  // Unlike getPlatformConfig(), cloud/mobile legitimately leave this unset.
  return _screenshotCaptureService;
}
