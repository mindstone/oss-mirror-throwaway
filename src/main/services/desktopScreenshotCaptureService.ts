import type { ScreenshotCaptureService } from '@core/screenshotCaptureService';
import { captureRebelWindow } from './screenshotService';

const CAPTURE_LOCK_TIMEOUT_MS = 5_000;

let isCaptureInProgress = false;
const captureQueue: Array<() => void> = [];

async function acquireCaptureLock(timeoutMs: number): Promise<boolean> {
  if (!isCaptureInProgress) {
    isCaptureInProgress = true;
    return true;
  }

  return new Promise((resolve) => {
    let settled = false;
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    const grantLock = (): void => {
      if (settled) return;
      settled = true;
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
      isCaptureInProgress = true;
      resolve(true);
    };

    timeoutHandle = setTimeout(() => {
      if (settled) return;
      settled = true;
      const queueIndex = captureQueue.indexOf(grantLock);
      if (queueIndex >= 0) {
        captureQueue.splice(queueIndex, 1);
      }
      resolve(false);
    }, timeoutMs);

    captureQueue.push(grantLock);
  });
}

function releaseCaptureLock(): void {
  const next = captureQueue.shift();
  if (!next) {
    isCaptureInProgress = false;
    return;
  }

  isCaptureInProgress = false;
  next();
}

export const desktopScreenshotCaptureService: ScreenshotCaptureService = {
  async captureRebelWindow(input) {
    const lockAcquired = await acquireCaptureLock(CAPTURE_LOCK_TIMEOUT_MS);
    if (!lockAcquired) {
      return { kind: 'error', errorCode: 'capture-busy' };
    }

    try {
      return await captureRebelWindow(input);
    } finally {
      releaseCaptureLock();
    }
  },
};
