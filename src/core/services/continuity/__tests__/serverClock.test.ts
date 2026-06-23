import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setErrorReporter } from '@core/errorReporter';
import { fnvHashBase36 as hashForBreadcrumb } from '@rebel/shared';
import {
  clearServerClockSession,
  resetServerClockForTests,
  seedServerClock,
  setServerNowForTests,
  stampCloudUpdatedAt,
} from '../serverClock';

describe('serverClock', () => {
  const breadcrumbs: Array<{ message: string; data?: Record<string, unknown> }> = [];

  beforeEach(() => {
    resetServerClockForTests();
    breadcrumbs.length = 0;
    setErrorReporter({
      captureException: () => {},
      captureMessage: () => {},
      addBreadcrumb: (breadcrumb) => {
        breadcrumbs.push({
          message: breadcrumb.message,
          data: breadcrumb.data,
        });
      },
    });
  });

  afterEach(() => {
    setErrorReporter({
      captureException: () => {},
      captureMessage: () => {},
      addBreadcrumb: () => {},
    });
  });

  it('stamps per-session monotonic cloudUpdatedAt and breadcrumbs backwards-clock events', () => {
    let now = 1_000;
    setServerNowForTests(() => now);

    const first = stampCloudUpdatedAt({ id: 'session-1' });
    expect(first.cloudUpdatedAt).toBe(1_000);

    now = 900;
    const second = stampCloudUpdatedAt({ id: 'session-1' });
    expect(second.cloudUpdatedAt).toBe(1_001);

    now = 850;
    const third = stampCloudUpdatedAt({ id: 'session-1' });
    expect(third.cloudUpdatedAt).toBe(1_002);

    expect(breadcrumbs).toHaveLength(1);
    expect(breadcrumbs[0].message).toBe('server-clock-backwards');
    expect(breadcrumbs[0].data).toMatchObject({
      reason: 'server-clock-backwards',
      sessionIdHash: hashForBreadcrumb('session-1'),
      serverNow: 900,
      lastStamped: 1_000,
      nextCloudUpdatedAt: 1_001,
    });
  });

  it('ensures cloudUpdatedAt is strictly increasing for same-millisecond writes', () => {
    const now = 2_500;
    setServerNowForTests(() => now);

    const first = stampCloudUpdatedAt({ id: 'same-ms' });
    const second = stampCloudUpdatedAt({ id: 'same-ms' });

    expect(first.cloudUpdatedAt).toBe(2_500);
    expect(second.cloudUpdatedAt).toBe(2_501);
    expect(second.cloudUpdatedAt).toBeGreaterThan(first.cloudUpdatedAt);
    expect(breadcrumbs).toHaveLength(0);
  });

  it('uses persisted cloudUpdatedAt baseline and supports seeding/clearing', () => {
    const now = 500;
    setServerNowForTests(() => now);

    const fromPersisted = stampCloudUpdatedAt({ id: 'session-2', cloudUpdatedAt: 1_200 });
    expect(fromPersisted.cloudUpdatedAt).toBe(1_201);

    seedServerClock('session-3', 5_000);
    const seeded = stampCloudUpdatedAt({ id: 'session-3' });
    expect(seeded.cloudUpdatedAt).toBe(5_001);

    clearServerClockSession('session-3');
    const cleared = stampCloudUpdatedAt({ id: 'session-3' });
    expect(cleared.cloudUpdatedAt).toBe(500);
  });

  it('tracks monotonic clocks independently per session', () => {
    let now = 2_000;
    setServerNowForTests(() => now);

    const a1 = stampCloudUpdatedAt({ id: 'a' });
    const b1 = stampCloudUpdatedAt({ id: 'b' });
    expect(a1.cloudUpdatedAt).toBe(2_000);
    expect(b1.cloudUpdatedAt).toBe(2_000);

    now = 1_000;
    const a2 = stampCloudUpdatedAt({ id: 'a' });
    const b2 = stampCloudUpdatedAt({ id: 'b' });
    expect(a2.cloudUpdatedAt).toBe(2_001);
    expect(b2.cloudUpdatedAt).toBe(2_001);
  });
});
