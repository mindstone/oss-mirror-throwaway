jest.mock('@rebel/cloud-client', () => ({
  hashForBreadcrumb: (value: string) => `hashed-${value}`,
}));

import {
  __resetQueueLifecycleContinuityForTests,
  buildQueueDrainLifecycleBreadcrumb,
  didDeviceRebootSince,
  estimateBootTimeMs,
  shouldRecordLifecycleBreadcrumb,
} from '../utils/queueLifecycleContinuity';

describe('buildQueueDrainLifecycleBreadcrumb', () => {
  beforeEach(() => {
    __resetQueueLifecycleContinuityForTests();
  });

  it('builds foreground drain lifecycle breadcrumbs', () => {
    const event = buildQueueDrainLifecycleBreadcrumb({
      reason: 'lifecycle-drain-foreground',
      direction: 'mobile-foreground',
      cloudUrl: 'https://cloud.example.test',
      online: true,
    });

    expect(event).toEqual({
      family: 'continuity-state',
      message: 'transition',
      data: {
        sessionIdHash: 'hashed-https://cloud.example.test',
        from: 'cloud_active',
        to: 'cloud_active',
        reason: 'lifecycle-drain-foreground',
        direction: 'mobile-foreground',
        label: 'online',
      },
    });
  });

  it('falls back to a synthetic scope key when cloudUrl is unavailable', () => {
    const event = buildQueueDrainLifecycleBreadcrumb({
      reason: 'lifecycle-resume-post-reboot',
      direction: 'mobile-startup',
      cloudUrl: null,
      online: false,
    });

    // `event.data` is a wide breadcrumb union on the production type; cast to the
    // transition shape at the assertion boundary (test-only, no prod change).
    const data = event.data as { sessionIdHash: string; reason: string; label: string };
    expect(data.sessionIdHash).toBe('hashed-mobile-queue-lifecycle');
    expect(data.reason).toBe('lifecycle-resume-post-reboot');
    expect(data.label).toBe('offline');
  });

  it('throttles lifecycle breadcrumbs per reason and device scope', () => {
    expect(shouldRecordLifecycleBreadcrumb({
      reason: 'lifecycle-drain-foreground',
      cloudUrl: 'https://cloud.example.test',
      now: 1_000,
    })).toBe(true);

    expect(shouldRecordLifecycleBreadcrumb({
      reason: 'lifecycle-drain-foreground',
      cloudUrl: 'https://cloud.example.test',
      now: 2_000,
    })).toBe(false);

    expect(shouldRecordLifecycleBreadcrumb({
      reason: 'lifecycle-resume-post-reboot',
      cloudUrl: 'https://cloud.example.test',
      now: 2_000,
    })).toBe(true);
  });

  it('detects reboot by comparing last drain timestamp against estimated boot time', () => {
    const bootTimeMs = estimateBootTimeMs(10_000, 2_000);
    expect(bootTimeMs).toBe(8_000);
    expect(didDeviceRebootSince(7_999, bootTimeMs)).toBe(true);
    expect(didDeviceRebootSince(8_001, bootTimeMs)).toBe(false);
  });
});
