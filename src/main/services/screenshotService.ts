/**
 * Screenshot Service
 *
 * Captures screenshots of the active display for use with the global voice activation hotkey.
 * Uses Electron's desktopCapturer API.
 *
 * Features:
 * - Captures the display under the cursor
 * - Resizes only when source exceeds Anthropic hard limits (8000 px dimension
 *   and 5 MB base64 payload), preserving native resolution when possible.
 * - Returns base64 data directly (no temp files)
 * - Handles macOS screen recording permission
 */

import { randomUUID } from 'node:crypto';
import { mkdir, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { BrowserWindow, desktopCapturer, nativeImage, screen, systemPreferences, type NativeImage, type Rectangle } from 'electron';
import { PNG } from 'pngjs';
import { logger } from '@core/logger';
import type { CaptureImageResult, CaptureResult } from '@core/screenshotCaptureService';
import {
  IMAGE_HARD_DIMENSION_LIMIT,
  ANTHROPIC_IMAGE_BYTE_LIMIT,
  nextDimensionForByteTarget,
} from '@shared/attachmentLimits';
import {
  emitVisualVerificationOverlay,
  scheduleVisualVerificationRestore,
  waitForRendererPaint,
  waitForVisualVerificationOverlayCue,
} from './visualVerificationOverlayService';

const MAX_DIMENSION = IMAGE_HARD_DIMENSION_LIMIT;
const CAPTURED_SCREENSHOTS_DIR = '.rebel/screenshots';
const CAPTURE_LABEL_PATTERN = /^[a-z0-9-]{0,32}$/;
const SCREENSHOT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_RETAINED_SCREENSHOTS = 50;
const DEFAULT_SCROLL_SCREENSHOTS = 4;
const MAX_SCROLL_SCREENSHOTS = 6;

export type ScreenshotError = 'screen-permission' | 'capture-failed';

export interface ScreenshotData {
  base64Data: string;
  width: number;
  height: number;
  sizeBytes: number;
}

export type ScreenshotResult =
  | { screenshot: ScreenshotData; error?: undefined }
  | { screenshot: null; error?: ScreenshotError };

export interface CaptureRebelWindowOptions {
  theme: 'current' | 'light' | 'dark';
  label?: string;
  workspaceRoot?: string;
  captureMode?: 'viewport' | 'scroll';
  maxScreenshots?: number;
}

interface ScrollCaptureState {
  available: boolean;
  originalScrollTop: number;
  maxScrollTop: number;
  viewportHeight: number;
  targetRect: Rectangle;
}

interface EncodedCapture {
  width: number;
  height: number;
  bytes: number;
  base64Data: string;
  pngBuffer: Buffer;
  mimeType: 'image/png';
}

interface EncodedScrollCapture {
  encoded: EncodedCapture;
  index: number;
  scrollTop: number;
}

/**
 * Check if screen recording permission is granted (macOS only).
 * On other platforms, always returns true.
 */
function hasScreenRecordingPermission(): boolean {
  if (process.platform !== 'darwin') {
    return true;
  }
  const status = systemPreferences.getMediaAccessStatus('screen');
  return status === 'granted';
}

/**
 * Calculate thumbnail size that fits within MAX_DIMENSION while maintaining aspect ratio.
 *
 * Exported for regression coverage of the limit-only resize policy
 * (FOX-3173 / REBEL-4ZQ): screenshots at or below the hard ceiling must
 * pass through at native resolution; only oversize captures are scaled.
 */
export function calculateThumbnailSize(displayWidth: number, displayHeight: number): { width: number; height: number } {
  if (displayWidth <= MAX_DIMENSION && displayHeight <= MAX_DIMENSION) {
    return { width: displayWidth, height: displayHeight };
  }

  const aspectRatio = displayWidth / displayHeight;
  if (displayWidth > displayHeight) {
    return {
      width: MAX_DIMENSION,
      height: Math.round(MAX_DIMENSION / aspectRatio),
    };
  }
  return {
    width: Math.round(MAX_DIMENSION * aspectRatio),
    height: MAX_DIMENSION,
  };
}

export function calculateNextByteAwareDimensions(
  width: number,
  height: number,
  currentBase64Bytes: number,
  targetMaxBytes: number,
): { width: number; height: number } | null {
  const currentMaxDim = Math.max(width, height);
  const nextMaxDim = nextDimensionForByteTarget(currentMaxDim, currentBase64Bytes, targetMaxBytes);
  if (nextMaxDim >= currentMaxDim) {
    return null;
  }
  const ratio = nextMaxDim / currentMaxDim;
  return {
    width: Math.max(1, Math.floor(width * ratio)),
    height: Math.max(1, Math.floor(height * ratio)),
  };
}

function formatCaptureTimestamp(now: Date): string {
  const yy = String(now.getUTCFullYear() % 100).padStart(2, '0');
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(now.getUTCDate()).padStart(2, '0');
  const hh = String(now.getUTCHours()).padStart(2, '0');
  const min = String(now.getUTCMinutes()).padStart(2, '0');
  const ss = String(now.getUTCSeconds()).padStart(2, '0');
  return `${yy}${mm}${dd}_${hh}${min}${ss}`;
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error;
}

async function pruneCapturedScreenshots(screenshotsDir: string, now = Date.now()): Promise<void> {
  try {
    const entries = await readdir(screenshotsDir, { withFileTypes: true });
    const candidates = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith('.png'))
        .map(async (entry) => {
          const filePath = path.join(screenshotsDir, entry.name);
          const stats = await stat(filePath);
          return { filePath, mtimeMs: stats.mtimeMs };
        }),
    );

    const cutoff = now - SCREENSHOT_RETENTION_MS;
    const freshCandidates: typeof candidates = [];
    for (const candidate of candidates) {
      if (candidate.mtimeMs < cutoff) {
        await unlink(candidate.filePath);
      } else {
        freshCandidates.push(candidate);
      }
    }

    if (freshCandidates.length <= MAX_RETAINED_SCREENSHOTS) {
      return;
    }

    const overflow = freshCandidates
      .sort((a, b) => a.mtimeMs - b.mtimeMs)
      .slice(0, freshCandidates.length - MAX_RETAINED_SCREENSHOTS);
    await Promise.all(overflow.map((candidate) => unlink(candidate.filePath)));
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') {
      return;
    }
    logger.warn({ err: error, screenshotsDir }, 'Failed to prune captured screenshots');
  }
}

function encodeCapturedImage(capturedImage: NativeImage): EncodedCapture | null {
  if (!capturedImage || capturedImage.isEmpty()) {
    return null;
  }

  let image = capturedImage;
  const currentSize = image.getSize();
  const thumbnailSize = calculateThumbnailSize(currentSize.width, currentSize.height);
  if (thumbnailSize.width !== currentSize.width || thumbnailSize.height !== currentSize.height) {
    image = image.resize(thumbnailSize);
  }

  let pngBuffer = image.toPNG();
  let base64Data = pngBuffer.toString('base64');
  let currentEncodedBytes = base64Data.length;

  if (currentEncodedBytes > ANTHROPIC_IMAGE_BYTE_LIMIT) {
    for (let i = 0; i < 5; i++) {
      if (currentEncodedBytes <= ANTHROPIC_IMAGE_BYTE_LIMIT) break;
      const imageSize = image.getSize();
      const nextSize = calculateNextByteAwareDimensions(
        imageSize.width,
        imageSize.height,
        currentEncodedBytes,
        ANTHROPIC_IMAGE_BYTE_LIMIT,
      );
      if (!nextSize) break;
      image = image.resize({ width: nextSize.width, height: nextSize.height });
      pngBuffer = image.toPNG();
      base64Data = pngBuffer.toString('base64');
      currentEncodedBytes = base64Data.length;
    }
  }

  const finalSize = image.getSize();
  return {
    width: finalSize.width,
    height: finalSize.height,
    bytes: pngBuffer.length,
    base64Data,
    pngBuffer,
    mimeType: 'image/png',
  };
}

async function persistCaptureImage(input: {
  workspaceRoot: string;
  screenshotsDir: string;
  resolvedTheme: 'light' | 'dark';
  label?: string;
  suffix?: string;
  encoded: EncodedCapture;
  index?: number;
  scrollTop?: number;
}): Promise<CaptureImageResult> {
  const labelSegments = [
    input.label ?? '',
    input.suffix ?? '',
    input.index !== undefined ? `p${String(input.index + 1).padStart(2, '0')}` : '',
  ].filter(Boolean);
  const labelSegment = labelSegments.join('-');
  const filename = `${formatCaptureTimestamp(new Date())}_${input.resolvedTheme}_${labelSegment}_${randomUUID().replace(/-/g, '').slice(-6)}.png`;
  const absolutePath = path.join(input.screenshotsDir, filename);
  const tempPath = `${absolutePath}.tmp`;

  await writeFile(tempPath, input.encoded.pngBuffer, { flag: 'wx' });
  await rename(tempPath, absolutePath);

  return {
    path: path.relative(input.workspaceRoot, absolutePath).split(path.sep).join('/'),
    width: input.encoded.width,
    height: input.encoded.height,
    bytes: input.encoded.bytes,
    base64Data: input.encoded.base64Data,
    mimeType: input.encoded.mimeType,
    ...(input.index !== undefined ? { index: input.index } : {}),
    ...(input.scrollTop !== undefined ? { scrollTop: input.scrollTop } : {}),
  };
}

function buildScrollPositions(state: ScrollCaptureState, maxScreenshots: number): number[] {
  if (!state.available || state.maxScrollTop <= 0 || maxScreenshots <= 1) {
    return [0];
  }

  const stepBasedScreens = Math.ceil(state.maxScrollTop / Math.max(1, Math.floor(state.viewportHeight * 0.85))) + 1;
  const captureCount = Math.max(2, Math.min(maxScreenshots, stepBasedScreens));
  return Array.from({ length: captureCount }, (_, index) => {
    if (index === 0) return 0;
    if (index === captureCount - 1) return state.maxScrollTop;
    return Math.round((state.maxScrollTop * index) / (captureCount - 1));
  });
}

async function getScrollCaptureState(win: BrowserWindow): Promise<ScrollCaptureState> {
  return win.webContents.executeJavaScript(
    `(() => {
      const scrollingElement = document.scrollingElement || document.documentElement;
      const candidates = [scrollingElement, ...Array.from(document.querySelectorAll('*'))]
        .filter((element, index, all) => element && all.indexOf(element) === index)
        .map((element) => {
          const rect = element.getBoundingClientRect();
          const style = window.getComputedStyle(element);
          const overflowY = style.overflowY;
          const scrollableByStyle = overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay';
          const scrollableBySize = element.scrollHeight > element.clientHeight + 32;
          const visible = rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
          const isDocument = element === scrollingElement;
          if (!visible || !scrollableBySize || (!scrollableByStyle && !isDocument)) return null;
          const visibleWidth = Math.min(rect.right, window.innerWidth) - Math.max(rect.left, 0);
          const visibleHeight = Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0);
          const visibleArea = Math.max(0, visibleWidth) * Math.max(0, visibleHeight);
          return {
            element,
            score: visibleArea + Math.max(0, element.scrollHeight - element.clientHeight),
          };
        })
        .filter(Boolean)
        .sort((a, b) => b.score - a.score);

      const target = candidates[0]?.element || scrollingElement;
      const targetRect = target === scrollingElement
        ? { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight }
        : target.getBoundingClientRect();
      const captureLeft = Math.max(0, targetRect.left);
      const captureTop = Math.max(0, targetRect.top);
      const captureRight = Math.min(window.innerWidth, targetRect.right);
      const captureBottom = Math.min(window.innerHeight, targetRect.bottom);
      const captureWidth = Math.max(1, Math.round(captureRight - captureLeft));
      const captureHeight = Math.max(1, Math.round(captureBottom - captureTop));
      const maxScrollTop = Math.max(0, target.scrollHeight - target.clientHeight);
      window.__rebelVisualCaptureScrollTarget = target;
      return {
        available: maxScrollTop > 32,
        originalScrollTop: target.scrollTop,
        maxScrollTop,
        viewportHeight: captureHeight,
        targetRect: {
          x: Math.round(captureLeft),
          y: Math.round(captureTop),
          width: captureWidth,
          height: captureHeight,
        },
      };
    })()`,
    true,
  ) as Promise<ScrollCaptureState>;
}

async function setScrollCapturePosition(win: BrowserWindow, scrollTop: number): Promise<void> {
  await win.webContents.executeJavaScript(
    `(() => {
      const target = window.__rebelVisualCaptureScrollTarget || document.scrollingElement || document.documentElement;
      target.scrollTop = ${JSON.stringify(scrollTop)};
      target.dispatchEvent(new Event('scroll', { bubbles: true }));
      window.dispatchEvent(new Event('scroll'));
    })()`,
    true,
  );
}

async function restoreScrollCapturePosition(win: BrowserWindow, originalScrollTop: number): Promise<void> {
  await win.webContents.executeJavaScript(
    `(() => {
      const target = window.__rebelVisualCaptureScrollTarget || document.scrollingElement || document.documentElement;
      target.scrollTop = ${JSON.stringify(originalScrollTop)};
      target.dispatchEvent(new Event('scroll', { bubbles: true }));
      window.dispatchEvent(new Event('scroll'));
      delete window.__rebelVisualCaptureScrollTarget;
    })()`,
    true,
  );
}

async function captureViewportEncoded(win: BrowserWindow, rect?: Rectangle): Promise<EncodedCapture | null> {
  const capturedImage = await win.capturePage(rect);
  return encodeCapturedImage(capturedImage);
}

async function stitchScrollCaptureImages(input: {
  captures: EncodedScrollCapture[];
  viewportHeight: number;
  workspaceRoot: string;
  screenshotsDir: string;
  resolvedTheme: 'light' | 'dark';
  label?: string;
}): Promise<CaptureImageResult | null> {
  if (input.captures.length <= 1) {
    return null;
  }

  const decodedCaptures = input.captures.map((capture) => ({
    ...capture,
    png: PNG.sync.read(capture.encoded.pngBuffer),
  }));
  const segments = decodedCaptures
    .map((capture, arrayIndex) => {
      const previousCapture = decodedCaptures[arrayIndex - 1];
      const cssOverlap = previousCapture
        ? Math.max(0, previousCapture.scrollTop + input.viewportHeight - capture.scrollTop)
        : 0;
      const cssToImageScale = capture.png.height / Math.max(1, input.viewportHeight);
      const cropTop = Math.min(capture.png.height, Math.round(cssOverlap * cssToImageScale));
      const cropHeight = capture.png.height - cropTop;
      return { png: capture.png, cropTop, cropHeight };
    })
    .filter((segment) => segment.cropHeight > 0);

  if (segments.length === 0) {
    return null;
  }

  const stitchedWidth = Math.max(...segments.map((segment) => segment.png.width));
  const stitchedHeight = segments.reduce((height, segment) => height + segment.cropHeight, 0);
  const stitchedPng = new PNG({ width: stitchedWidth, height: stitchedHeight });

  let yOffset = 0;
  for (const segment of segments) {
    for (let row = 0; row < segment.cropHeight; row += 1) {
      const sourceStart = (segment.cropTop + row) * segment.png.width * 4;
      const sourceEnd = sourceStart + segment.png.width * 4;
      const targetStart = ((yOffset + row) * stitchedWidth) * 4;
      segment.png.data.copy(stitchedPng.data, targetStart, sourceStart, sourceEnd);
    }
    yOffset += segment.cropHeight;
  }

  const stitchedBuffer = PNG.sync.write(stitchedPng);
  const encoded = encodeCapturedImage(nativeImage.createFromBuffer(stitchedBuffer));
  if (!encoded) {
    return null;
  }

  return persistCaptureImage({
    workspaceRoot: input.workspaceRoot,
    screenshotsDir: input.screenshotsDir,
    resolvedTheme: input.resolvedTheme,
    label: input.label,
    suffix: 'full',
    encoded,
  });
}

function scheduleRestoreAndReturn(win: BrowserWindow, result: CaptureResult): CaptureResult {
  scheduleVisualVerificationRestore(win);
  return result;
}

function scheduleFocusedWindowRestoreAndReturn(result: CaptureResult): CaptureResult {
  // eslint-disable-next-line no-restricted-syntax -- window-scan-send-allowlisted: screenshot restore targets focused window fallback, not renderer send; migrate later to explicit capture-window helper if needed.
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  if (win && !win.isDestroyed()) {
    scheduleVisualVerificationRestore(win);
  }
  return result;
}

async function resolveCurrentWindowTheme(win: BrowserWindow): Promise<'light' | 'dark' | null> {
  try {
    const detectedTheme = await win.webContents.executeJavaScript(
      `(() => {
        if (document.body?.classList.contains('light')) return 'light';
        if (document.body?.classList.contains('dark')) return 'dark';
        if (document.documentElement?.style?.colorScheme === 'light') return 'light';
        if (document.documentElement?.style?.colorScheme === 'dark') return 'dark';
        return null;
      })()`,
      true,
    );

    if (detectedTheme === 'light' || detectedTheme === 'dark') {
      return detectedTheme;
    }
    return null;
  } catch (error) {
    logger.warn({ err: error }, 'Failed to resolve current Rebel theme from renderer state');
    return null;
  }
}

async function resolveCurrentWindowSurface(win: BrowserWindow): Promise<string | null> {
  try {
    const currentSurface = await win.webContents.executeJavaScript(
      `globalThis.__rebelGetCurrentSurfaceForTool?.() ?? null`,
      true,
    );

    if (typeof currentSurface === 'string' && currentSurface.trim().length > 0) {
      return currentSurface;
    }

    logger.warn({ currentSurface }, 'Failed to resolve current Rebel surface from renderer state');
    return null;
  } catch (error) {
    logger.warn({ err: error }, 'Failed to resolve current Rebel surface from renderer state');
    return null;
  }
}

async function resolveCaptureTheme(
  win: BrowserWindow,
  requestedTheme: 'current' | 'light' | 'dark',
): Promise<'light' | 'dark' | null> {
  if (requestedTheme !== 'current') {
    return requestedTheme;
  }
  return resolveCurrentWindowTheme(win);
}

/**
 * Capture the Rebel app window and persist the PNG into the workspace.
 * Used by the in-app visual verification loop capability layer.
 */
export async function captureRebelWindow(opts: CaptureRebelWindowOptions): Promise<CaptureResult> {
  if (opts.label !== undefined && !CAPTURE_LABEL_PATTERN.test(opts.label)) {
    return scheduleFocusedWindowRestoreAndReturn({
      kind: 'error',
      errorCode: 'invalid-label',
      detail: { label: opts.label },
    });
  }

  // eslint-disable-next-line no-restricted-syntax -- window-scan-send-allowlisted: screenshot capture targets focused window fallback, not renderer send; migrate later to explicit capture-window helper if needed.
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  if (!win) {
    return { kind: 'error', errorCode: 'window-not-found' };
  }

  const minimized = win.isMinimized();
  const hidden = !win.isVisible();
  const destroyed = win.isDestroyed();
  if (minimized || hidden || destroyed) {
    return scheduleRestoreAndReturn(win, {
      kind: 'error',
      errorCode: 'window-not-capturable',
      detail: { minimized, hidden, destroyed },
    });
  }

  const resolvedTheme = await resolveCaptureTheme(win, opts.theme);
  if (!resolvedTheme) {
    return scheduleRestoreAndReturn(win, {
      kind: 'error',
      errorCode: 'capture-failed',
      detail: { reason: 'unable-to-resolve-current-theme' },
    });
  }

  try {
    const captureMode = opts.captureMode ?? 'viewport';
    const maxScreenshots = Math.min(
      opts.maxScreenshots ?? (captureMode === 'scroll' ? DEFAULT_SCROLL_SCREENSHOTS : 1),
      MAX_SCROLL_SCREENSHOTS,
    );
    await emitVisualVerificationOverlay(win, {
      action: 'show',
      phase: 'preparing',
      message: captureMode === 'scroll'
        ? 'Taking full-page screenshots'
        : 'Taking a screenshot',
      autoHideMs: 6_000,
    });
    await waitForVisualVerificationOverlayCue(win);
    await emitVisualVerificationOverlay(win, { action: 'hide' });
    await waitForRendererPaint(win);

    const workspaceRoot = opts.workspaceRoot ?? process.cwd();
    const screenshotsDir = path.join(workspaceRoot, CAPTURED_SCREENSHOTS_DIR);
    await mkdir(screenshotsDir, { recursive: true });

    let primaryCapture: CaptureImageResult | null = null;
    if (captureMode === 'scroll') {
      const scrollState = await getScrollCaptureState(win);
      const scrollPositions = buildScrollPositions(scrollState, maxScreenshots);
      const scrollCaptures: EncodedScrollCapture[] = [];
      try {
        for (let index = 0; index < scrollPositions.length; index += 1) {
          const scrollTop = scrollPositions[index];
          await setScrollCapturePosition(win, scrollTop);
          await waitForRendererPaint(win);
          const encoded = await captureViewportEncoded(win, scrollState.targetRect);
          if (!encoded) {
            return scheduleRestoreAndReturn(win, {
              kind: 'error',
              errorCode: 'capture-failed',
              detail: { reason: 'empty-native-image', index },
            });
          }
          scrollCaptures.push({ encoded, index, scrollTop });
        }
      } finally {
        await restoreScrollCapturePosition(win, scrollState.originalScrollTop);
        await waitForRendererPaint(win);
      }

      if (scrollCaptures.length > 1) {
        primaryCapture = await stitchScrollCaptureImages({
          captures: scrollCaptures,
          viewportHeight: scrollState.viewportHeight,
          workspaceRoot,
          screenshotsDir,
          resolvedTheme,
          label: opts.label,
        });
        if (!primaryCapture) {
          return scheduleRestoreAndReturn(win, {
            kind: 'error',
            errorCode: 'capture-failed',
            detail: { reason: 'stitch-failed' },
          });
        }
      } else if (scrollCaptures[0]) {
        primaryCapture = await persistCaptureImage({
          workspaceRoot,
          screenshotsDir,
          resolvedTheme,
          label: opts.label,
          suffix: 'full',
          encoded: scrollCaptures[0].encoded,
        });
      }
    } else {
      const encoded = await captureViewportEncoded(win);
      if (!encoded) {
        return scheduleRestoreAndReturn(win, {
          kind: 'error',
          errorCode: 'capture-failed',
          detail: { reason: 'empty-native-image' },
        });
      }
      primaryCapture = await persistCaptureImage({
        workspaceRoot,
        screenshotsDir,
        resolvedTheme,
        label: opts.label,
        encoded,
      });
    }

    await pruneCapturedScreenshots(screenshotsDir);

    if (!primaryCapture) {
      return scheduleRestoreAndReturn(win, {
        kind: 'error',
        errorCode: 'capture-failed',
        detail: { reason: 'no-captures-created' },
      });
    }

    const currentSurface = await resolveCurrentWindowSurface(win);
    if (!currentSurface) {
      return scheduleRestoreAndReturn(win, {
        kind: 'error',
        errorCode: 'capture-failed',
        detail: { reason: 'current-surface-unavailable' },
      });
    }

    await emitVisualVerificationOverlay(win, {
      action: 'show',
      phase: 'captured',
      message: captureMode === 'scroll' ? 'Full page captured' : 'Screenshot captured',
      autoHideMs: 1_400,
    });
    scheduleVisualVerificationRestore(win);

    return {
      kind: 'ok',
      path: primaryCapture.path,
      width: primaryCapture.width,
      height: primaryCapture.height,
      theme: resolvedTheme,
      bytes: primaryCapture.bytes,
      ...(opts.label !== undefined ? { label: opts.label } : {}),
      currentSurface,
      base64Data: primaryCapture.base64Data,
      mimeType: primaryCapture.mimeType,
    };
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOSPC') {
      return scheduleRestoreAndReturn(win, {
        kind: 'error',
        errorCode: 'capture-storage-full',
        detail: { code: error.code },
      });
    }
    logger.error({ err: error }, 'Failed to capture Rebel window screenshot');
    return scheduleRestoreAndReturn(win, { kind: 'error', errorCode: 'capture-failed' });
  }
}

/**
 * Capture the active display (the one containing the cursor).
 * Returns screenshot data or null with an error code.
 */
export async function captureActiveDisplay(): Promise<ScreenshotResult> {
  try {
    // Check macOS permission first
    if (!hasScreenRecordingPermission()) {
      logger.info('Screenshot capture denied: screen recording permission not granted');
      return { screenshot: null, error: 'screen-permission' };
    }

    // Get the display under the cursor
    const cursorPoint = screen.getCursorScreenPoint();
    const activeDisplay = screen.getDisplayNearestPoint(cursorPoint);

    // Calculate optimal thumbnail size (capped at MAX_DIMENSION)
    const thumbnailSize = calculateThumbnailSize(
      activeDisplay.size.width * activeDisplay.scaleFactor,
      activeDisplay.size.height * activeDisplay.scaleFactor
    );

    // Capture screen sources
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize,
    });

    if (sources.length === 0) {
      logger.warn('No screen sources available for screenshot');
      return { screenshot: null, error: 'capture-failed' };
    }

    // Find the source matching our active display
    // display_id is a string representation of the display id
    const activeSource = sources.find((s) => s.display_id === String(activeDisplay.id));
    const source = activeSource ?? sources[0]; // Fallback to first source if no match

    if (!source.thumbnail || source.thumbnail.isEmpty()) {
      logger.warn('Screenshot thumbnail is empty (may indicate permission issue on macOS)');
      return { screenshot: null, error: 'screen-permission' };
    }

    // Convert to PNG and run byte-aware downscale when needed.
    // Compare against ANTHROPIC_IMAGE_BYTE_LIMIT using the actual base64
    // string length (what Anthropic measures), not the decoded PNG size.
    let thumbnail = source.thumbnail;
    let pngBuffer = thumbnail.toPNG();
    let base64Data = pngBuffer.toString('base64');
    let currentEncodedBytes = base64Data.length;

    if (currentEncodedBytes > ANTHROPIC_IMAGE_BYTE_LIMIT) {
      for (let i = 0; i < 5; i++) {
        if (currentEncodedBytes <= ANTHROPIC_IMAGE_BYTE_LIMIT) break;
        const currentSize = thumbnail.getSize();
        const nextSize = calculateNextByteAwareDimensions(
          currentSize.width,
          currentSize.height,
          currentEncodedBytes,
          ANTHROPIC_IMAGE_BYTE_LIMIT,
        );
        if (!nextSize) break;
        thumbnail = thumbnail.resize({ width: nextSize.width, height: nextSize.height });
        pngBuffer = thumbnail.toPNG();
        base64Data = pngBuffer.toString('base64');
        currentEncodedBytes = base64Data.length;
      }
      logger.info(
        {
          finalSize: thumbnail.getSize(),
          finalPngBytes: pngBuffer.length,
          finalEncodedBytes: currentEncodedBytes,
          withinLimit: currentEncodedBytes <= ANTHROPIC_IMAGE_BYTE_LIMIT,
        },
        'Screenshot byte-aware downscale engaged'
      );
    }

    const size = thumbnail.getSize();

    logger.info(
      { width: size.width, height: size.height, pngBytes: pngBuffer.length, base64Bytes: base64Data.length },
      'Screenshot captured successfully'
    );

    return {
      screenshot: {
        base64Data,
        width: size.width,
        height: size.height,
        // sizeBytes follows the project-wide decoded-bytes convention
        // (matches `useFileAttachments.resizeImage` and the existing field
        // semantics on `ImageAttachmentPayload.sizeBytes`).
        sizeBytes: pngBuffer.length,
      },
    };
  } catch (error) {
    logger.error({ err: error }, 'Failed to capture screenshot');
    return { screenshot: null, error: 'capture-failed' };
  }
}
