import { ignoreBestEffortCleanup } from '@shared/utils/intentionalSwallow';

export function deferNativeCleanup(fn: () => void | Promise<void>): void {
  queueMicrotask(() => {
    void Promise.resolve().then(fn).catch((e) => ignoreBestEffortCleanup(e, {
      operation: 'deferNativeCleanup',
      reason: 'native handle may already be torn down during unmount',
      severity: 'warn',
    }));
  });
}
