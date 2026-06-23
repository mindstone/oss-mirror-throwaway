import { getPowerSaveBlocker } from '@core/powerSaveBlocker';
function resolvePowerSaveBlocker() {
  return getPowerSaveBlocker();
}

export function acquireBlock(reason: string): void {
  resolvePowerSaveBlocker().acquireBlock(reason);
}

export function releaseBlock(reason: string): void {
  resolvePowerSaveBlocker().releaseBlock(reason);
}

export function getBlockerStatus(): {
  active: boolean;
  refCount: number;
  reasons: Record<string, number>;
  startedAt: number | null;
  durationMs: number | null;
} {
  return resolvePowerSaveBlocker().getBlockerStatus();
}

export function dispose(): void {
  resolvePowerSaveBlocker().dispose();
}

/** @internal Exposed for testing only. */
export function _resetForTesting(): void {
  resolvePowerSaveBlocker().resetForTesting?.();
}
