import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PNG } from 'pngjs';
import { ANTHROPIC_IMAGE_BYTE_LIMIT, IMAGE_HARD_DIMENSION_LIMIT } from '@shared/attachmentLimits';
import { calculateNextByteAwareDimensions, calculateThumbnailSize, captureRebelWindow } from './screenshotService';

const electronMock = vi.hoisted(() => ({
  focusedWindow: null as import('electron').BrowserWindow | null,
  allWindows: [] as import('electron').BrowserWindow[],
  getSources: vi.fn(),
  getCursorScreenPoint: vi.fn(),
  getDisplayNearestPoint: vi.fn(),
  getMediaAccessStatus: vi.fn(() => 'granted'),
  createFromBuffer: vi.fn(),
}));

const fsMock = vi.hoisted(() => ({
  mkdir: vi.fn(),
  readdir: vi.fn(),
  writeFile: vi.fn(),
  rename: vi.fn(),
  stat: vi.fn(),
  unlink: vi.fn(),
}));

const cryptoMock = vi.hoisted(() => ({
  randomUUID: vi.fn(),
}));

const overlayMock = vi.hoisted(() => ({
  emitVisualVerificationOverlay: vi.fn(),
  scheduleVisualVerificationRestore: vi.fn(),
  waitForRendererPaint: vi.fn(),
  waitForVisualVerificationOverlayCue: vi.fn(),
}));

 
vi.mock('electron', () => ({
  BrowserWindow: {
    getFocusedWindow: vi.fn(() => electronMock.focusedWindow),
    getAllWindows: vi.fn(() => electronMock.allWindows),
  },
  desktopCapturer: {
    getSources: electronMock.getSources,
  },
  screen: {
    getCursorScreenPoint: electronMock.getCursorScreenPoint,
    getDisplayNearestPoint: electronMock.getDisplayNearestPoint,
  },
  systemPreferences: {
    getMediaAccessStatus: electronMock.getMediaAccessStatus,
  },
  nativeImage: {
    createFromBuffer: electronMock.createFromBuffer,
  },
}));

 
vi.mock('node:fs/promises', () => ({
  mkdir: fsMock.mkdir,
  readdir: fsMock.readdir,
  writeFile: fsMock.writeFile,
  rename: fsMock.rename,
  stat: fsMock.stat,
  unlink: fsMock.unlink,
}));

 
vi.mock('node:crypto', () => ({
  randomUUID: cryptoMock.randomUUID,
}));

vi.mock('./visualVerificationOverlayService', () => ({
  emitVisualVerificationOverlay: overlayMock.emitVisualVerificationOverlay,
  scheduleVisualVerificationRestore: overlayMock.scheduleVisualVerificationRestore,
  waitForRendererPaint: overlayMock.waitForRendererPaint,
  waitForVisualVerificationOverlayCue: overlayMock.waitForVisualVerificationOverlayCue,
}));

type MockNativeImage = {
  isEmpty: ReturnType<typeof vi.fn>;
  getSize: ReturnType<typeof vi.fn>;
  resize: ReturnType<typeof vi.fn>;
  toPNG: ReturnType<typeof vi.fn>;
};

function createMockNativeImage(width: number, height: number, byteDivisor = 10, rgba = [0, 0, 0, 0]): MockNativeImage {
  const image: MockNativeImage = {
    isEmpty: vi.fn(() => false),
    getSize: vi.fn(() => ({ width, height })),
    resize: vi.fn(({ width: nextWidth, height: nextHeight }: { width: number; height: number }) =>
      createMockNativeImage(nextWidth, nextHeight, byteDivisor),
    ),
    toPNG: vi.fn(() => {
      if (byteDivisor === 0) {
        const png = new PNG({ width, height });
        for (let offset = 0; offset < png.data.length; offset += 4) {
          png.data[offset] = rgba[0] ?? 0;
          png.data[offset + 1] = rgba[1] ?? 0;
          png.data[offset + 2] = rgba[2] ?? 0;
          png.data[offset + 3] = rgba[3] ?? 255;
        }
        return PNG.sync.write(png);
      }
      const byteLength = Math.max(1, Math.floor((width * height) / byteDivisor));
      return Buffer.alloc(byteLength, 1);
    }),
  };
  return image;
}

function createEmptyMockNativeImage(): MockNativeImage {
  return {
    isEmpty: vi.fn(() => true),
    getSize: vi.fn(() => ({ width: 0, height: 0 })),
    resize: vi.fn(),
    toPNG: vi.fn(),
  };
}

function createMockWindow(options?: {
  minimized?: boolean;
  hidden?: boolean;
  destroyed?: boolean;
  currentTheme?: 'light' | 'dark';
  currentSurface?: string;
  captureImage?: MockNativeImage;
  captureImages?: MockNativeImage[];
  executeJavaScript?: ReturnType<typeof vi.fn>;
}): import('electron').BrowserWindow {
  const captureImage = options?.captureImage ?? createMockNativeImage(1700, 1100, 12);
  const currentTheme = options?.currentTheme ?? 'dark';
  const currentSurface = options?.currentSurface ?? 'home';
  const captureImages = [...(options?.captureImages ?? [])];
  return {
    isVisible: vi.fn(() => !options?.hidden),
    isMinimized: vi.fn(() => !!options?.minimized),
    isDestroyed: vi.fn(() => !!options?.destroyed),
    capturePage: vi.fn(async () => captureImages.shift() ?? captureImage),
    webContents: {
      executeJavaScript: options?.executeJavaScript ?? vi.fn(async (script: string) => {
        if (script.includes('__rebelGetCurrentSurfaceForTool')) {
          return currentSurface;
        }
        return currentTheme;
      }),
    },
  } as unknown as import('electron').BrowserWindow;
}

beforeEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  electronMock.focusedWindow = null;
  electronMock.allWindows = [];
  fsMock.mkdir.mockResolvedValue(undefined);
  fsMock.readdir.mockResolvedValue([]);
  fsMock.writeFile.mockResolvedValue(undefined);
  fsMock.rename.mockResolvedValue(undefined);
  fsMock.stat.mockResolvedValue({ mtimeMs: Date.now() });
  fsMock.unlink.mockResolvedValue(undefined);
  cryptoMock.randomUUID.mockReturnValue('00000000-0000-0000-0000-abcdef123456');
  electronMock.createFromBuffer.mockImplementation((buffer: Buffer) => {
    const decoded = PNG.sync.read(buffer);
    return {
      isEmpty: vi.fn(() => false),
      getSize: vi.fn(() => ({ width: decoded.width, height: decoded.height })),
      resize: vi.fn(({ width: nextWidth, height: nextHeight }: { width: number; height: number }) =>
        createMockNativeImage(nextWidth, nextHeight, 0),
      ),
      toPNG: vi.fn(() => buffer),
    };
  });
  overlayMock.emitVisualVerificationOverlay.mockResolvedValue(undefined);
  overlayMock.waitForRendererPaint.mockResolvedValue(undefined);
  overlayMock.waitForVisualVerificationOverlayCue.mockResolvedValue(undefined);
});

/**
 * Regression coverage for FOX-3173 / REBEL-4ZQ — limit-only image resize.
 *
 * Before the fix, screenshots were unconditionally downscaled to 1568 px on
 * the longest side, destroying OCR-quality text legibility on Retina captures.
 * The fix replaces that with a limit-only policy: images at or below
 * `IMAGE_HARD_DIMENSION_LIMIT` (Anthropic's 8000 px ceiling) pass through
 * untouched; only oversize captures are scaled to fit.
 *
 * `calculateThumbnailSize` is the pure dimension-math used by both the
 * screenshot capture path and (mirrored) the renderer/cloud-client
 * `resizeImage` helpers, so pinning its behaviour locks the policy.
 */
describe('calculateThumbnailSize — limit-only resize policy (FOX-3173)', () => {
  it('passes a typical 1920×1200 Retina screenshot through unchanged (would have been resized to 1568×980 under the old 1568 px cap)', () => {
    expect(calculateThumbnailSize(1920, 1200)).toEqual({ width: 1920, height: 1200 });
  });

  it('passes a 1700×1100 capture through unchanged (would have been resized to 1568×1015 under the old 1568 px cap — primary regression assertion)', () => {
    expect(calculateThumbnailSize(1700, 1100)).toEqual({ width: 1700, height: 1100 });
  });

  it('passes 2992×1934 (Apple M1 Pro built-in display @ 2x) through unchanged (the exact source size from the user-reported Sentry event)', () => {
    expect(calculateThumbnailSize(2992, 1934)).toEqual({ width: 2992, height: 1934 });
  });

  it('passes a square 1568×1568 capture through unchanged at both old and new caps', () => {
    expect(calculateThumbnailSize(1568, 1568)).toEqual({ width: 1568, height: 1568 });
  });

  it('caps a 9000×6000 landscape capture at the 8000 px ceiling, preserving aspect ratio', () => {
    expect(calculateThumbnailSize(9000, 6000)).toEqual({ width: 8000, height: 5333 });
  });

  it('caps a portrait 6000×9000 capture at the 8000 px ceiling, preserving aspect ratio', () => {
    expect(calculateThumbnailSize(6000, 9000)).toEqual({ width: 5333, height: 8000 });
  });

  it('uses the shared IMAGE_HARD_DIMENSION_LIMIT constant rather than a local magic number', () => {
    // A capture exactly at the limit must pass through; one pixel over must be capped.
    expect(calculateThumbnailSize(IMAGE_HARD_DIMENSION_LIMIT, IMAGE_HARD_DIMENSION_LIMIT)).toEqual({
      width: IMAGE_HARD_DIMENSION_LIMIT,
      height: IMAGE_HARD_DIMENSION_LIMIT,
    });
    const oversize = calculateThumbnailSize(IMAGE_HARD_DIMENSION_LIMIT + 1, IMAGE_HARD_DIMENSION_LIMIT + 1);
    expect(Math.max(oversize.width, oversize.height)).toBeLessThanOrEqual(IMAGE_HARD_DIMENSION_LIMIT);
  });
});

describe('calculateNextByteAwareDimensions — Anthropic byte-aware ladder', () => {
  it('converges below 5MB for an 8K-class landscape screenshot within 5 passes (area-estimate simulation)', () => {
    let width = 8000;
    let height = 4500;
    let estimatedBase64Bytes = 12_494_812;

    for (let i = 0; i < 5; i++) {
      if (estimatedBase64Bytes <= ANTHROPIC_IMAGE_BYTE_LIMIT) break;
      const next = calculateNextByteAwareDimensions(
        width,
        height,
        estimatedBase64Bytes,
        ANTHROPIC_IMAGE_BYTE_LIMIT,
      );
      if (!next) break;

      const ratio = next.width / width;
      width = next.width;
      height = next.height;
      estimatedBase64Bytes = Math.ceil(estimatedBase64Bytes * ratio * ratio);
    }

    expect(estimatedBase64Bytes).toBeLessThanOrEqual(ANTHROPIC_IMAGE_BYTE_LIMIT);
  });

  it('converges below 5MB for an 8K-class portrait screenshot within 5 passes (area-estimate simulation)', () => {
    let width = 4500;
    let height = 8000;
    let estimatedBase64Bytes = 12_494_812;

    for (let i = 0; i < 5; i++) {
      if (estimatedBase64Bytes <= ANTHROPIC_IMAGE_BYTE_LIMIT) break;
      const next = calculateNextByteAwareDimensions(
        width,
        height,
        estimatedBase64Bytes,
        ANTHROPIC_IMAGE_BYTE_LIMIT,
      );
      if (!next) break;

      const ratio = next.height / height;
      width = next.width;
      height = next.height;
      estimatedBase64Bytes = Math.ceil(estimatedBase64Bytes * ratio * ratio);
    }

    expect(estimatedBase64Bytes).toBeLessThanOrEqual(ANTHROPIC_IMAGE_BYTE_LIMIT);
  });

  it('returns null when dimensions are already at floor and still over the byte target', () => {
    expect(calculateNextByteAwareDimensions(512, 512, ANTHROPIC_IMAGE_BYTE_LIMIT * 3, ANTHROPIC_IMAGE_BYTE_LIMIT)).toBeNull();
  });
});

describe('captureRebelWindow', () => {
  it('applies the capture resize ladder for normal, oversize, and byte-heavy captures', async () => {
    const workspaceRoot = '/tmp/rebel-workspace';

    electronMock.focusedWindow = createMockWindow({
      captureImage: createMockNativeImage(1700, 1100, 14),
      currentTheme: 'dark',
    });
    const normalResult = await captureRebelWindow({
      theme: 'current',
      label: 'normal',
      workspaceRoot,
    });

    expect(normalResult.kind).toBe('ok');
    if (normalResult.kind === 'ok') {
      expect(normalResult.width).toBe(1700);
      expect(normalResult.height).toBe(1100);
      expect(normalResult.theme).toBe('dark');
      expect(normalResult.currentSurface).toBe('home');
    }

    electronMock.focusedWindow = createMockWindow({
      captureImage: createMockNativeImage(9000, 6000, 10),
      currentTheme: 'dark',
    });
    const oversizeResult = await captureRebelWindow({
      theme: 'light',
      label: 'oversize',
      workspaceRoot,
    });

    expect(oversizeResult.kind).toBe('ok');
    if (oversizeResult.kind === 'ok') {
      expect(oversizeResult.width).toBeLessThanOrEqual(8000);
      expect(oversizeResult.height).toBeLessThanOrEqual(5333);
      expect(oversizeResult.theme).toBe('light');
    }

    electronMock.focusedWindow = createMockWindow({
      captureImage: createMockNativeImage(8000, 8000, 8),
      currentTheme: 'dark',
    });
    const byteHeavyResult = await captureRebelWindow({
      theme: 'dark',
      label: 'byte-heavy',
      workspaceRoot,
    });

    expect(byteHeavyResult.kind).toBe('ok');
    if (byteHeavyResult.kind === 'ok') {
      expect(byteHeavyResult.base64Data.length).toBeLessThanOrEqual(ANTHROPIC_IMAGE_BYTE_LIMIT);
    }
  });

  it('returns window-not-capturable for minimized windows and never captures a blank frame', async () => {
    const minimizedWindow = createMockWindow({ minimized: true });
    electronMock.focusedWindow = minimizedWindow;

    const result = await captureRebelWindow({
      theme: 'current',
      label: 'minimized-check',
      workspaceRoot: '/tmp/rebel-workspace',
    });

    expect(result).toEqual({
      kind: 'error',
      errorCode: 'window-not-capturable',
      detail: {
        minimized: true,
        hidden: false,
        destroyed: false,
      },
    });
    expect(minimizedWindow.capturePage).not.toHaveBeenCalled();
  });

  it('rejects invalid labels with invalid-label instead of silently sanitizing', async () => {
    const activeWindow = createMockWindow();
    electronMock.focusedWindow = activeWindow;

    const result = await captureRebelWindow({
      theme: 'dark',
      label: '../../etc/passwd',
      workspaceRoot: '/tmp/rebel-workspace',
    });

    expect(result).toEqual({
      kind: 'error',
      errorCode: 'invalid-label',
      detail: { label: '../../etc/passwd' },
    });
    expect(activeWindow.capturePage).not.toHaveBeenCalled();
    expect(fsMock.writeFile).not.toHaveBeenCalled();
    expect(overlayMock.scheduleVisualVerificationRestore).toHaveBeenCalledTimes(1);
  });

  it('schedules navigation restore when capture fails after visual navigation', async () => {
    electronMock.focusedWindow = createMockWindow({
      captureImage: createEmptyMockNativeImage(),
      currentTheme: 'dark',
    });

    const result = await captureRebelWindow({
      theme: 'current',
      label: 'empty',
      workspaceRoot: '/tmp/rebel-workspace',
    });

    expect(result).toEqual({
      kind: 'error',
      errorCode: 'capture-failed',
      detail: { reason: 'empty-native-image' },
    });
    expect(overlayMock.scheduleVisualVerificationRestore).toHaveBeenCalledTimes(1);
  });

  it('prunes old captured screenshots and caps retained screenshots after a successful capture', async () => {
    const workspaceRoot = '/tmp/rebel-workspace';
    const screenshotsDir = `${workspaceRoot}/.rebel/screenshots`;
    electronMock.focusedWindow = createMockWindow({
      captureImage: createMockNativeImage(1600, 1000, 12),
      currentTheme: 'dark',
    });

    const freshEntries = Array.from({ length: 51 }, (_, index) => ({
      name: `fresh-${index}.png`,
      isFile: () => true,
    }));
    fsMock.readdir.mockResolvedValue([
      { name: 'old.png', isFile: () => true },
      ...freshEntries,
      { name: 'ignore.tmp', isFile: () => true },
    ]);
    const now = Date.now();
    fsMock.stat.mockImplementation(async (filePath: string) => ({
      mtimeMs: filePath.endsWith('old.png')
        ? now - (8 * 24 * 60 * 60 * 1000)
        : filePath.endsWith('fresh-0.png')
          ? now - 1_000
        : now,
    }));

    const result = await captureRebelWindow({
      theme: 'current',
      label: 'cleanup',
      workspaceRoot,
    });

    expect(result.kind).toBe('ok');
    expect(fsMock.readdir).toHaveBeenCalledWith(screenshotsDir, { withFileTypes: true });
    expect(fsMock.unlink).toHaveBeenCalledWith(`${screenshotsDir}/old.png`);
    expect(fsMock.unlink).toHaveBeenCalledWith(`${screenshotsDir}/fresh-0.png`);
    expect(fsMock.unlink).not.toHaveBeenCalledWith(`${screenshotsDir}/ignore.tmp`);
  });

  it('produces distinct filenames for parallel captures in the same second', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-30T12:34:56.000Z'));

    cryptoMock.randomUUID
      .mockReturnValueOnce('00000000-0000-0000-0000-abcdef123456')
      .mockReturnValueOnce('00000000-0000-0000-0000-fedcba654321');

    electronMock.focusedWindow = createMockWindow({
      captureImage: createMockNativeImage(1600, 1000, 12),
      currentTheme: 'dark',
    });

    const [first, second] = await Promise.all([
      captureRebelWindow({
        theme: 'dark',
        label: 'parallel',
        workspaceRoot: '/tmp/rebel-workspace',
      }),
      captureRebelWindow({
        theme: 'dark',
        label: 'parallel',
        workspaceRoot: '/tmp/rebel-workspace',
      }),
    ]);

    expect(first.kind).toBe('ok');
    expect(second.kind).toBe('ok');
    if (first.kind === 'ok' && second.kind === 'ok') {
      expect(first.path).not.toEqual(second.path);
      expect(first.path).toMatch(/_dark_parallel_[a-f0-9]{6}\.png$/);
      expect(second.path).toMatch(/_dark_parallel_[a-f0-9]{6}\.png$/);
    }
  });

  it('returns one stitched full-page image when scroll mode is requested and restores the original scroll position', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-30T15:34:50.000Z'));

    const workspaceRoot = '/tmp/rebel-workspace';
    const executeJavaScript = vi.fn(async (script: string) => {
      if (script.includes('__rebelGetCurrentSurfaceForTool')) {
        return 'settings';
      }
      if (script.includes('document.body?.classList.contains')) {
        return 'dark';
      }
      if (script.includes('__rebelVisualCaptureScrollTarget = target')) {
        return {
          available: true,
          originalScrollTop: 125,
          maxScrollTop: 1000,
          viewportHeight: 900,
          targetRect: { x: 307, y: 92, width: 628, height: 900 },
        };
      }
      return undefined;
    });
    cryptoMock.randomUUID
      .mockReturnValueOnce('00000000-0000-0000-0000-444444444444');

    const activeWindow = createMockWindow({
      captureImages: [
        createMockNativeImage(10, 900, 0, [255, 0, 0, 255]),
        createMockNativeImage(10, 900, 0, [0, 255, 0, 255]),
        createMockNativeImage(10, 900, 0, [0, 0, 255, 255]),
      ],
      executeJavaScript,
    });
    electronMock.focusedWindow = activeWindow;

    const result = await captureRebelWindow({
      theme: 'current',
      label: 'settings',
      workspaceRoot,
      captureMode: 'scroll',
      maxScreenshots: 3,
    });

    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.path).toBe('.rebel/screenshots/260430_153450_dark_settings-full_444444.png');
      expect(result.width).toBe(10);
      expect(result.height).toBe(1900);
      expect(result.captures).toBeUndefined();
    }
    expect(activeWindow.capturePage).toHaveBeenCalledTimes(3);
    expect(activeWindow.capturePage).toHaveBeenCalledWith({ x: 307, y: 92, width: 628, height: 900 });
    expect(fsMock.writeFile).toHaveBeenCalledTimes(1);
    const stitchedBuffer = fsMock.writeFile.mock.calls[0]?.[1];
    expect(Buffer.isBuffer(stitchedBuffer)).toBe(true);
    const stitchedPng = PNG.sync.read(stitchedBuffer as Buffer);
    const getPixel = (y: number) => Array.from(stitchedPng.data.slice(y * stitchedPng.width * 4, y * stitchedPng.width * 4 + 4));
    expect(getPixel(0)).toEqual([255, 0, 0, 255]);
    expect(getPixel(899)).toEqual([255, 0, 0, 255]);
    expect(getPixel(900)).toEqual([0, 255, 0, 255]);
    expect(getPixel(1399)).toEqual([0, 255, 0, 255]);
    expect(getPixel(1400)).toEqual([0, 0, 255, 255]);
    expect(getPixel(1899)).toEqual([0, 0, 255, 255]);
    expect(executeJavaScript).toHaveBeenCalledWith(expect.stringContaining('target.scrollTop = 125'), true);
  });
});
