/**
 * Shared per-Fly-machine operation lock.
 *
 * Fly machine restarts are safe when serialized, but overlapping control-plane
 * operations on the same machine (tier change + volume resize) can race in ways
 * that make verification misleading. This module is intentionally tiny and
 * process-local: it prevents same-desktop overlap while Fly's own optimistic
 * locking still handles cross-desktop races.
 */

export type FlyOperationKind = 'tier-change' | 'volume-resize';

export interface FlyOperationLockHandle {
  key: string;
  kind: FlyOperationKind;
  release: () => void;
}

const inFlightFlyOperations = new Map<string, FlyOperationKind>();

export function flyOperationKey(flyAppName: string, flyMachineId: string): string {
  return `${flyAppName}:${flyMachineId}`;
}

export function acquireFlyOperationLock(params: {
  flyAppName: string;
  flyMachineId: string;
  kind: FlyOperationKind;
}): FlyOperationLockHandle | null {
  const key = flyOperationKey(params.flyAppName, params.flyMachineId);
  if (inFlightFlyOperations.has(key)) {
    return null;
  }
  inFlightFlyOperations.set(key, params.kind);
  let released = false;
  return {
    key,
    kind: params.kind,
    release: () => {
      if (released) return;
      released = true;
      if (inFlightFlyOperations.get(key) === params.kind) {
        inFlightFlyOperations.delete(key);
      }
    },
  };
}

export function getInFlightFlyOperation(
  flyAppName: string,
  flyMachineId: string,
): FlyOperationKind | undefined {
  return inFlightFlyOperations.get(flyOperationKey(flyAppName, flyMachineId));
}

/** Test seam only. */
export function __resetFlyOperationLocksForTesting(): void {
  inFlightFlyOperations.clear();
}
