import { beforeEach, describe, expect, it } from 'vitest';
import {
  __resetFlyOperationLocksForTesting,
  acquireFlyOperationLock,
  getInFlightFlyOperation,
} from '../flyOperationLock';

describe('flyOperationLock', () => {
  beforeEach(() => {
    __resetFlyOperationLocksForTesting();
  });

  it('acquires and releases a per-machine lock', () => {
    const lock = acquireFlyOperationLock({ flyAppName: 'app-a', flyMachineId: 'machine-a', kind: 'tier-change' });
    expect(lock).not.toBeNull();
    expect(getInFlightFlyOperation('app-a', 'machine-a')).toBe('tier-change');

    lock?.release();
    expect(getInFlightFlyOperation('app-a', 'machine-a')).toBeUndefined();
  });

  it('rejects double-acquire for the same machine', () => {
    const first = acquireFlyOperationLock({ flyAppName: 'app-a', flyMachineId: 'machine-a', kind: 'tier-change' });
    const second = acquireFlyOperationLock({ flyAppName: 'app-a', flyMachineId: 'machine-a', kind: 'volume-resize' });

    expect(first).not.toBeNull();
    expect(second).toBeNull();
  });

  it('isolates unrelated machines', () => {
    const first = acquireFlyOperationLock({ flyAppName: 'app-a', flyMachineId: 'machine-a', kind: 'tier-change' });
    const second = acquireFlyOperationLock({ flyAppName: 'app-a', flyMachineId: 'machine-b', kind: 'volume-resize' });

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(getInFlightFlyOperation('app-a', 'machine-a')).toBe('tier-change');
    expect(getInFlightFlyOperation('app-a', 'machine-b')).toBe('volume-resize');
  });
});
