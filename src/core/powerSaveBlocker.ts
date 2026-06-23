export interface PowerSaveBlockerStatus {
  active: boolean;
  refCount: number;
  reasons: Record<string, number>;
  startedAt: number | null;
  durationMs: number | null;
}

export interface PowerSaveBlocker {
  acquireBlock(reason: string): void;
  releaseBlock(reason: string): void;
  getBlockerStatus(): PowerSaveBlockerStatus;
  dispose(): void;
  resetForTesting?(): void;
}

export type PowerSaveBlockerFactory = () => PowerSaveBlocker;

let _factory: PowerSaveBlockerFactory | undefined;
let _instance: PowerSaveBlocker | undefined;

export function setPowerSaveBlockerFactory(factory: PowerSaveBlockerFactory): void {
  _factory = factory;
  _instance = undefined;
}

export function getPowerSaveBlocker(): PowerSaveBlocker {
  if (_instance) return _instance;
  if (!_factory) {
    throw new Error(
      'PowerSaveBlocker not initialized. Call setPowerSaveBlockerFactory() before use.',
    );
  }
  _instance = _factory();
  return _instance;
}
