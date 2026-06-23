import type { PowerSaveBlocker, PowerSaveBlockerStatus } from '@core/powerSaveBlocker';

const EMPTY_STATUS: PowerSaveBlockerStatus = {
  active: false,
  refCount: 0,
  reasons: {},
  startedAt: null,
  durationMs: null,
};

export class StandalonePowerSaveBlocker implements PowerSaveBlocker {
  acquireBlock(_reason: string): void {
    // No-op in standalone CLI.
  }

  releaseBlock(_reason: string): void {
    // No-op in standalone CLI.
  }

  getBlockerStatus(): PowerSaveBlockerStatus {
    return EMPTY_STATUS;
  }

  dispose(): void {
    // No-op in standalone CLI.
  }

  resetForTesting(): void {
    // No-op in standalone CLI.
  }
}
