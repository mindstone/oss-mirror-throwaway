/**
 * Quick Capture Active State
 *
 * Extracted from quickCaptureHandlers to break circular dependencies.
 * Both localRecordingService and physicalRecordingService need to check
 * whether quick capture is active (mutual exclusion), but importing
 * from quickCaptureHandlers creates cycles since it imports from them.
 */

let isCapturing = false;

export function isQuickCaptureActive(): boolean {
  return isCapturing;
}

export function setQuickCaptureActive(active: boolean): void {
  isCapturing = active;
}
