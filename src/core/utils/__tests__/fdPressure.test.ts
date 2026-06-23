import { describe, expect, it } from 'vitest';
import {
  DARWIN_OPEN_MAX_FD,
  FD_PRESSURE_COUNT_FLOOR,
  _resetFdPressureStateForTesting,
  assessFdPressureBand,
  getCachedOpenFileSoftLimit,
  readFdPressure,
  selectNextFdPressureBand,
  type FdPressureBand,
} from '../fdPressure';

describe('readFdPressure', () => {
  it('reads /dev/fd on darwin and returns open count + max fd number', () => {
    let seenPath = '';
    const result = readFdPressure({
      platform: 'darwin',
      readdirSync: (path) => {
        seenPath = path;
        return ['0', '1', '2', '9', 'stdout'];
      },
    });

    expect(seenPath).toBe('/dev/fd');
    expect(result).toEqual({
      status: 'ok',
      source: 'darwin-dev-fd',
      openFdCount: 5,
      maxFdNumber: 9,
    });
  });

  it('reads /proc/self/fd on linux and returns open count + max fd number', () => {
    let seenPath = '';
    const result = readFdPressure({
      platform: 'linux',
      readdirSync: (path) => {
        seenPath = path;
        return ['0', '3', '12', 'not-an-fd'];
      },
    });

    expect(seenPath).toBe('/proc/self/fd');
    expect(result).toEqual({
      status: 'ok',
      source: 'linux-proc-self-fd',
      openFdCount: 4,
      maxFdNumber: 12,
    });
  });

  it('returns unsupported on win32 with an explicit reason', () => {
    const result = readFdPressure({ platform: 'win32' });
    expect(result.status).toBe('unsupported');
    expect(result).toMatchObject({
      reason: expect.stringContaining('win32'),
    });
  });

  it('returns unavailable when fd directory read throws', () => {
    const result = readFdPressure({
      platform: 'darwin',
      readdirSync: () => {
        throw new Error('permission denied');
      },
    });
    expect(result).toEqual({
      status: 'unavailable',
      error: 'permission denied',
    });
  });

  it('reads the real fd directory on darwin/linux runners', () => {
    if (process.platform !== 'darwin' && process.platform !== 'linux') {
      return;
    }

    const result = readFdPressure();
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') {
      return;
    }

    expect(result.openFdCount).toBeGreaterThan(0);
    expect(result.maxFdNumber).toBeGreaterThanOrEqual(0);
  });
});

describe('assessFdPressureBand / selectNextFdPressureBand', () => {
  it('handles 49 -> 51 -> 76 -> 91 progression and dedups repeated ticks per band', () => {
    const seen = new Set<FdPressureBand>();
    const readAt = (openFdCount: number) => selectNextFdPressureBand({
      assessment: assessFdPressureBand({
        platform: 'linux',
        openFdCount,
        maxFdNumber: 0,
        softLimit: 1_000,
      }),
      seenBands: seen,
    });

    expect(readAt(490)).toBeNull();

    const at51 = readAt(513);
    expect(at51?.band).toBe(50);
    seen.add(at51!.band);

    const at76 = readAt(760);
    expect(at76?.band).toBe(75);
    seen.add(at76!.band);

    const at91 = readAt(910);
    expect(at91?.band).toBe(90);
    seen.add(at91!.band);

    expect(readAt(920)).toBeNull();
  });

  it('does not re-fire a band on drop-and-reclimb (once per band per process)', () => {
    const seen = new Set<FdPressureBand>();
    const readAt = (openFdCount: number) => selectNextFdPressureBand({
      assessment: assessFdPressureBand({
        platform: 'linux',
        openFdCount,
        maxFdNumber: 0,
        softLimit: 1_000,
      }),
      seenBands: seen,
    });

    const first = readAt(760);
    expect(first?.band).toBe(75);
    seen.add(first!.band);

    // Pressure drops well below the band, then climbs back over it:
    expect(readAt(400)).toBeNull();
    expect(readAt(760)).toBeNull();
    // A HIGHER band still fires:
    expect(readAt(910)?.band).toBe(90);
  });

  it('applies the 512 floor only to the count axis', () => {
    const countOnly = assessFdPressureBand({
      platform: 'linux',
      openFdCount: FD_PRESSURE_COUNT_FLOOR - 1,
      maxFdNumber: 0,
      softLimit: FD_PRESSURE_COUNT_FLOOR,
    });
    expect(countOnly).toBeNull();

    const numberAxisStillApplies = assessFdPressureBand({
      platform: 'darwin',
      openFdCount: FD_PRESSURE_COUNT_FLOOR - 1,
      maxFdNumber: Math.floor(DARWIN_OPEN_MAX_FD * 0.8),
      softLimit: FD_PRESSURE_COUNT_FLOOR,
    });
    expect(numberAxisStillApplies?.band).toBe(75);
    expect(numberAxisStillApplies?.triggerAxes).toEqual(['fd-number']);
  });
});

describe('getCachedOpenFileSoftLimit', () => {
  it('reads process.report once and caches the parsed soft limit', () => {
    _resetFdPressureStateForTesting();
    let calls = 0;
    const readProcessReport = () => {
      calls += 1;
      return {
        userLimits: {
          open_files: {
            soft: 2_048,
            hard: 'unlimited',
          },
        },
      };
    };

    expect(getCachedOpenFileSoftLimit(readProcessReport)).toBe(2_048);
    expect(getCachedOpenFileSoftLimit(readProcessReport)).toBe(2_048);
    expect(calls).toBe(1);
  });

  it('returns null when report shape is missing/invalid', () => {
    _resetFdPressureStateForTesting();
    expect(getCachedOpenFileSoftLimit(() => ({ userLimits: { open_files: { soft: 'unlimited' } } }))).toBeNull();
  });
});
