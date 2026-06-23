import type { PowerSaveBlocker, PowerSaveBlockerStatus } from '@core/powerSaveBlocker';

const EMPTY_STATUS: PowerSaveBlockerStatus = {
  active: false,
  refCount: 0,
  reasons: {},
  startedAt: null,
  durationMs: null,
};

export class CloudPowerSaveBlocker implements PowerSaveBlocker {
  acquireBlock(_reason: string): void {
    // No-op in cloud.
  }

  releaseBlock(_reason: string): void {
    // No-op in cloud.
  }

  getBlockerStatus(): PowerSaveBlockerStatus {
    return EMPTY_STATUS;
  }

  dispose(): void {
    // No-op in cloud.
  }

  resetForTesting(): void {
    // No-op in cloud.
  }
}
