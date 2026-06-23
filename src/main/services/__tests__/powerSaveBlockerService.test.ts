import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { setPowerSaveBlockerFactory } from '@core/powerSaveBlocker';
import { ElectronPowerSaveBlocker } from '../powerSaveBlocker/electronPowerSaveBlocker';

// Mock electron before importing the service
vi.mock('electron', () => {
  let nextBlockerId = 1;
  const startedBlockers = new Set<number>();
  return {
    powerSaveBlocker: {
      start: vi.fn((_type: string) => {
        const id = nextBlockerId++;
        startedBlockers.add(id);
        return id;
      }),
      stop: vi.fn((id: number) => {
        startedBlockers.delete(id);
      }),
      isStarted: vi.fn((id: number) => startedBlockers.has(id)),
    },
  };
});

vi.mock('@core/logger', () => ({
  createScopedLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  }),
}));

import {
  acquireBlock,
  releaseBlock,
  getBlockerStatus,
  _resetForTesting,
} from '../powerSaveBlockerService';
import { powerSaveBlocker } from 'electron';

describe('powerSaveBlockerService', () => {
  beforeEach(() => {
    setPowerSaveBlockerFactory(() => new ElectronPowerSaveBlocker());
    vi.useFakeTimers();
    _resetForTesting();
    vi.clearAllMocks();
  });

  afterEach(() => {
    _resetForTesting();
    vi.useRealTimers();
  });

  it('starts blocker on first acquire and stops on last release', () => {
    expect(getBlockerStatus().active).toBe(false);

    acquireBlock('turn:abc');
    expect(getBlockerStatus().active).toBe(true);
    expect(getBlockerStatus().refCount).toBe(1);
    expect(powerSaveBlocker.start).toHaveBeenCalledWith('prevent-app-suspension');

    releaseBlock('turn:abc');
    expect(getBlockerStatus().active).toBe(false);
    expect(getBlockerStatus().refCount).toBe(0);
  });

  it('ref-counts multiple acquires with same reason', () => {
    acquireBlock('turn:a');
    acquireBlock('turn:a');
    expect(getBlockerStatus().refCount).toBe(2);
    expect(getBlockerStatus().reasons).toEqual({ 'turn:a': 2 });

    releaseBlock('turn:a');
    expect(getBlockerStatus().active).toBe(true);
    expect(getBlockerStatus().refCount).toBe(1);

    releaseBlock('turn:a');
    expect(getBlockerStatus().active).toBe(false);
  });

  it('tracks multiple different reasons independently', () => {
    acquireBlock('turn:a');
    acquireBlock('turn:b');
    expect(getBlockerStatus().refCount).toBe(2);
    expect(getBlockerStatus().reasons).toEqual({ 'turn:a': 1, 'turn:b': 1 });

    releaseBlock('turn:a');
    expect(getBlockerStatus().active).toBe(true);
    expect(getBlockerStatus().reasons).toEqual({ 'turn:b': 1 });

    releaseBlock('turn:b');
    expect(getBlockerStatus().active).toBe(false);
  });

  it('force-releases on 30min watchdog timeout', () => {
    acquireBlock('turn:long');
    expect(getBlockerStatus().active).toBe(true);

    vi.advanceTimersByTime(30 * 60 * 1000);
    expect(getBlockerStatus().active).toBe(false);
    expect(getBlockerStatus().refCount).toBe(0);
  });

  it('handles release without acquire gracefully', () => {
    expect(() => releaseBlock('turn:nonexistent')).not.toThrow();
    expect(getBlockerStatus().active).toBe(false);
  });

  it('reports duration in status', () => {
    acquireBlock('turn:timed');
    vi.advanceTimersByTime(5000);
    const status = getBlockerStatus();
    expect(status.durationMs).toBeGreaterThanOrEqual(5000);
    releaseBlock('turn:timed');
  });
});
