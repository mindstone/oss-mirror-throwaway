import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setErrorReporter } from '@core/errorReporter';
import {
  getOutboxStallMonitor,
  resetOutboxStallMonitorForTests,
} from '../outboxStallMonitor';

const breadcrumbs: Array<{ category: string; message: string; data?: Record<string, unknown> }> = [];
const capturedExceptions: Array<{ error: unknown; context?: Record<string, unknown> }> = [];

beforeEach(() => {
  breadcrumbs.length = 0;
  capturedExceptions.length = 0;
  setErrorReporter({
    captureException: (error, context) => {
      capturedExceptions.push({ error, context });
    },
    captureMessage: () => {},
    addBreadcrumb: (breadcrumb) => {
      breadcrumbs.push({
        category: breadcrumb.category,
        message: breadcrumb.message,
        data: breadcrumb.data,
      });
    },
  });
  resetOutboxStallMonitorForTests();
});

afterEach(() => {
  resetOutboxStallMonitorForTests();
  setErrorReporter({
    captureException: () => {},
    captureMessage: () => {},
    addBreadcrumb: () => {},
  });
});

describe('outboxStallMonitor', () => {
  it('emits stuck-outbox breadcrumb and escalation when depth is stale', () => {
    let now = 0;
    const monitor = getOutboxStallMonitor();
    monitor.setNowProviderForTests(() => now);

    monitor.recordDrainStarted('device-a');
    now = (10 * 60 * 1_000) + 1;
    monitor.checkForStalls();

    expect(breadcrumbs).toHaveLength(1);
    expect(breadcrumbs[0]).toMatchObject({
      category: 'continuity.continuity-state',
      message: 'stuck-outbox',
    });
    expect(capturedExceptions).toHaveLength(1);
    expect(capturedExceptions[0].error).toBeInstanceOf(Error);
    expect((capturedExceptions[0].error as Error).message).toBe(
      'Continuity outbox appears stuck',
    );
    expect(capturedExceptions[0].context).toMatchObject({
      tags: {
        condition: 'cloud_outbox_stuck',
        continuity_event: 'continuity-state:stuck-outbox',
        surface: 'cloud',
      },
      level: 'warning',
      fingerprint: ['cloud-outbox-stuck'],
      _knownConditionWrapped: true,
      extra: {
        reason: 'stuck-outbox',
        depth: 1,
      },
    });
  });

  it('throttles stuck-outbox escalations to once per hour per device', () => {
    let now = 0;
    const monitor = getOutboxStallMonitor();
    monitor.setNowProviderForTests(() => now);

    monitor.recordDrainStarted('device-a');
    now = (10 * 60 * 1_000) + 1;
    monitor.checkForStalls();
    expect(capturedExceptions).toHaveLength(1);

    now += 5 * 60 * 1_000;
    monitor.checkForStalls();
    expect(capturedExceptions).toHaveLength(1);

    now += (60 * 60 * 1_000) + 1;
    monitor.checkForStalls();
    expect(capturedExceptions).toHaveLength(2);
  });

  it('does not emit stuck-outbox when queue drains', () => {
    let now = 0;
    const monitor = getOutboxStallMonitor();
    monitor.setNowProviderForTests(() => now);

    monitor.recordDrainStarted('device-a');
    monitor.recordDrainCompleted('device-a', 1);

    now = (15 * 60 * 1_000);
    monitor.checkForStalls();

    expect(breadcrumbs).toHaveLength(0);
    expect(capturedExceptions).toHaveLength(0);
  });
});
