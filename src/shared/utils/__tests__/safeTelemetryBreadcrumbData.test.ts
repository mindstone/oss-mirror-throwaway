import { describe, expect, it } from 'vitest';

import { redactLogBreadcrumbData } from '@core/utils/logFieldFilter';

import type { SafeTelemetryBreadcrumbData } from '../../types/safeTelemetryBreadcrumbData';
import { attachLogBreadcrumbData } from '../safeTelemetryBreadcrumbData';

describe('SafeTelemetryBreadcrumbData', () => {
  it('rejects raw logger bindings at the breadcrumb-attachment seam', () => {
    const breadcrumb: { data?: Record<string, unknown> } = {};
    const rawBindings: Record<string, unknown> = {
      server_name: 'leaky-host',
      sampleMeetings: [{ title: 'standup' }],
    };

    // @ts-expect-error Raw logger bindings must pass through redactLogBreadcrumbData first.
    attachLogBreadcrumbData(breadcrumb, rawBindings);

    attachLogBreadcrumbData(
      breadcrumb,
      redactLogBreadcrumbData({ server_name: 'leaky-host', component: 'calendar' }),
    );
    expect(breadcrumb.data).toEqual({ component: 'calendar' });
    expect(breadcrumb.data).not.toHaveProperty('server_name');
    expect(breadcrumb.data).not.toHaveProperty('sampleMeetings');
  });

  it('accepts sanitizer output at the breadcrumb-attachment seam', () => {
    const breadcrumb: { data?: Record<string, unknown> } = {};
    const sanitized: SafeTelemetryBreadcrumbData = redactLogBreadcrumbData({
      server_name: 'leaky-host',
      component: 'calendar',
      title: 'user-owned title',
    });

    attachLogBreadcrumbData(breadcrumb, sanitized);

    expect(breadcrumb.data).toEqual({ component: 'calendar' });
    expect(breadcrumb.data).not.toHaveProperty('server_name');
    expect(breadcrumb.data).not.toHaveProperty('title');
  });

  it('scrubs known-sensitive keys via the approved sanitizer', () => {
    const sanitized = redactLogBreadcrumbData({
      server_name: 'intranet.example',
      providers: ['google', 'outlook'],
      component: 'settings',
    });

    expect(sanitized).toEqual({ component: 'settings' });
    expect(sanitized).not.toHaveProperty('server_name');
    expect(sanitized).not.toHaveProperty('providers');
  });
});
