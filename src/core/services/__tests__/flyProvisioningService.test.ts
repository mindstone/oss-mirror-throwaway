import { describe, it, expect, vi, beforeEach } from 'vitest';
import { isTransientImagePullError, lookupFlyInstance, provisionCloudInstance } from '../flyProvisioningService';

// ---------------------------------------------------------------------------
// Mock global fetch
// ---------------------------------------------------------------------------

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

/** Helper to build a minimal Response-like object for mocked fetch. */
function mockResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as Response;
}

// ---------------------------------------------------------------------------
// URL matchers (for routing mock responses)
// ---------------------------------------------------------------------------

const appUrl = (app: string) => `https://api.machines.dev/v1/apps/${app}`;
const machinesUrl = (app: string) => `https://api.machines.dev/v1/apps/${app}/machines`;
const volumesUrl = (app: string) => `https://api.machines.dev/v1/apps/${app}/volumes`;

/**
 * Configure mockFetch to return different responses based on URL.
 * Accepts a map of URL → Response. Matches longest prefix first to avoid
 * ambiguity (e.g. /apps/my-app vs /apps/my-app/machines).
 * Falls back to 500 for unmatched URLs.
 */
function setupFetchRoutes(routes: Record<string, Response>) {
  const sortedPrefixes = Object.keys(routes).sort((a, b) => b.length - a.length);
  mockFetch.mockImplementation((url: string) => {
    for (const prefix of sortedPrefixes) {
      if (url.startsWith(prefix)) return Promise.resolve(routes[prefix]);
    }
    return Promise.resolve(mockResponse(500, { error: 'unmatched mock URL' }));
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('lookupFlyInstance', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('returns success for a valid token with one started machine', async () => {
    setupFetchRoutes({
      [appUrl('my-app')]: mockResponse(200, { name: 'my-app' }),
      [machinesUrl('my-app')]: mockResponse(200, [
        { id: 'mach-1', state: 'started', region: 'iad' },
      ]),
      [volumesUrl('my-app')]: mockResponse(200, []),
    });

    const result = await lookupFlyInstance('valid-token', 'my-app');

    expect(result).toEqual({
      success: true,
      appName: 'my-app',
      machineId: 'mach-1',
      region: 'iad',
      volumeId: undefined,
    });
  });

  it('returns success for a stopped machine (stopped machines are valid)', async () => {
    setupFetchRoutes({
      [appUrl('my-app')]: mockResponse(200, { name: 'my-app' }),
      [machinesUrl('my-app')]: mockResponse(200, [
        { id: 'mach-stopped', state: 'stopped', region: 'lhr' },
      ]),
      [volumesUrl('my-app')]: mockResponse(200, []),
    });

    const result = await lookupFlyInstance('valid-token', 'my-app');

    expect(result).toEqual({
      success: true,
      appName: 'my-app',
      machineId: 'mach-stopped',
      region: 'lhr',
      volumeId: undefined,
    });
  });

  it('prefers a started machine when multiple exist', async () => {
    setupFetchRoutes({
      [appUrl('my-app')]: mockResponse(200, { name: 'my-app' }),
      [machinesUrl('my-app')]: mockResponse(200, [
        { id: 'mach-stopped', state: 'stopped', region: 'iad' },
        { id: 'mach-started', state: 'started', region: 'lhr' },
        { id: 'mach-stopped-2', state: 'stopped', region: 'sin' },
      ]),
      [volumesUrl('my-app')]: mockResponse(200, []),
    });

    const result = await lookupFlyInstance('valid-token', 'my-app');

    expect(result.success).toBe(true);
    expect(result.machineId).toBe('mach-started');
    expect(result.region).toBe('lhr');
  });

  it('falls back to first machine when none are started', async () => {
    setupFetchRoutes({
      [appUrl('my-app')]: mockResponse(200, { name: 'my-app' }),
      [machinesUrl('my-app')]: mockResponse(200, [
        { id: 'mach-a', state: 'stopped', region: 'iad' },
        { id: 'mach-b', state: 'stopped', region: 'lhr' },
      ]),
      [volumesUrl('my-app')]: mockResponse(200, []),
    });

    const result = await lookupFlyInstance('valid-token', 'my-app');

    expect(result.success).toBe(true);
    expect(result.machineId).toBe('mach-a');
    expect(result.region).toBe('iad');
  });

  it('returns error when app has zero machines', async () => {
    setupFetchRoutes({
      [appUrl('empty-app')]: mockResponse(200, { name: 'empty-app' }),
      [machinesUrl('empty-app')]: mockResponse(200, []),
      [volumesUrl('empty-app')]: mockResponse(200, []),
    });

    const result = await lookupFlyInstance('valid-token', 'empty-app');

    expect(result.success).toBe(false);
    expect(result.error).toContain('no machines');
  });

  it('returns error for invalid token (401)', async () => {
    setupFetchRoutes({
      [appUrl('my-app')]: mockResponse(401, { error: 'unauthorized' }),
    });

    const result = await lookupFlyInstance('bad-token', 'my-app');

    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid Fly.io token');
  });

  it('returns error when app is not found (404)', async () => {
    setupFetchRoutes({
      [appUrl('ghost-app')]: mockResponse(404, { error: 'not found' }),
    });

    const result = await lookupFlyInstance('valid-token', 'ghost-app');

    expect(result.success).toBe(false);
    expect(result.error).toContain('ghost-app');
    expect(result.error).toContain('not found');
  });

  it('returns volumeId when a rebel_data volume exists', async () => {
    setupFetchRoutes({
      [appUrl('my-app')]: mockResponse(200, { name: 'my-app' }),
      [machinesUrl('my-app')]: mockResponse(200, [
        { id: 'mach-1', state: 'started', region: 'iad' },
      ]),
      [volumesUrl('my-app')]: mockResponse(200, [
        { id: 'vol-abc', name: 'rebel_data' },
      ]),
    });

    const result = await lookupFlyInstance('valid-token', 'my-app');

    expect(result.success).toBe(true);
    expect(result.volumeId).toBe('vol-abc');
  });

  it('returns success without volumeId when no rebel_data volume exists', async () => {
    setupFetchRoutes({
      [appUrl('my-app')]: mockResponse(200, { name: 'my-app' }),
      [machinesUrl('my-app')]: mockResponse(200, [
        { id: 'mach-1', state: 'started', region: 'iad' },
      ]),
      [volumesUrl('my-app')]: mockResponse(200, [
        { id: 'vol-other', name: 'some_other_volume' },
      ]),
    });

    const result = await lookupFlyInstance('valid-token', 'my-app');

    expect(result.success).toBe(true);
    expect(result.volumeId).toBeUndefined();
  });

  it('succeeds even when volume lookup fails (volumes are non-fatal)', async () => {
    setupFetchRoutes({
      [appUrl('my-app')]: mockResponse(200, { name: 'my-app' }),
      [machinesUrl('my-app')]: mockResponse(200, [
        { id: 'mach-1', state: 'started', region: 'iad' },
      ]),
      [volumesUrl('my-app')]: mockResponse(500, { error: 'internal server error' }),
    });

    const result = await lookupFlyInstance('valid-token', 'my-app');

    expect(result.success).toBe(true);
    expect(result.machineId).toBe('mach-1');
    expect(result.volumeId).toBeUndefined();
  });

  it('returns error when token validation returns a non-401 error', async () => {
    setupFetchRoutes({
      [appUrl('my-app')]: mockResponse(503, 'Service Unavailable'),
    });

    const result = await lookupFlyInstance('valid-token', 'my-app');

    expect(result.success).toBe(false);
    expect(result.error).toContain('Token validation failed');
  });

  it('returns error when machine listing returns a non-404 error', async () => {
    setupFetchRoutes({
      [appUrl('my-app')]: mockResponse(200, { name: 'my-app' }),
      [machinesUrl('my-app')]: mockResponse(500, 'Internal Server Error'),
    });

    const result = await lookupFlyInstance('valid-token', 'my-app');

    expect(result.success).toBe(false);
    expect(result.error).toContain('Could not access app');
  });

  it('returns error when fetch throws a network error during validation', async () => {
    mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));

    const result = await lookupFlyInstance('valid-token', 'my-app');

    expect(result.success).toBe(false);
    expect(result.error).toContain('Could not reach Fly.io');
  });
});

// ---------------------------------------------------------------------------
// provisionCloudInstance — marker emission on failure paths
// ---------------------------------------------------------------------------

const GRAPHQL_URL = 'https://api.fly.io/graphql';
const APPS_URL = 'https://api.machines.dev/v1/apps';

/**
 * These tests exercise the marker-emission branches that feed into
 * cloudErrorMapper. They short-circuit the provisioning flow at volume
 * creation, so the GraphQL and earlier fetches must succeed.
 */
describe('provisionCloudInstance marker emission', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  // Build a fetch mock that returns a custom response for a URL prefix and
  // success defaults for the earlier provisioning steps.
  function setupUntilVolume(volumeResp: Response, orgSlug = 'acme-org') {
    mockFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      // Step 1: GraphQL — org detection (POST https://api.fly.io/graphql)
      if (url === GRAPHQL_URL) {
        const bodyText = typeof init?.body === 'string' ? init.body : '';
        if (bodyText.includes('organizations')) {
          return mockResponse(200, {
            data: { organizations: { nodes: [{ slug: orgSlug, type: 'SHARED' }] } },
          });
        }
        // setSecrets mutation
        return mockResponse(200, { data: { setSecrets: { app: { name: 'rebel-cloud-xxxx' } } } });
      }
      // Step 1b: token validation — GET /v1/apps?org_slug=...
      if (url.startsWith(`${APPS_URL}?`)) {
        return mockResponse(200, []);
      }
      // Step 3: create app — POST /v1/apps
      if (url === APPS_URL) {
        return mockResponse(200, { name: 'rebel-cloud-xxxx' });
      }
      // Step 5: create volume — the branch we're testing
      if (url.includes('/volumes')) {
        return volumeResp;
      }
      // Cleanup DELETE
      if (url.includes('?force=true') && init?.method === 'DELETE') {
        return mockResponse(200, {});
      }
      return mockResponse(500, { error: 'unmatched mock URL: ' + url });
    });
  }

  it('emits a billing_required marker with the resolved org slug on 422 + payment method', async () => {
    setupUntilVolume(
      mockResponse(422, {
        error: 'To create more than 20GB in volumes please add a payment method',
      }),
      'my-cool-org',
    );

    const result = await provisionCloudInstance({ flyApiToken: 'token' });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/\[cloud:billing_required:my-cool-org\]/);
    expect(result.failedStep).toBe(5);
    expect(result.cleanupMessage).toBeTruthy();
  });

  it('emits billing marker on 402 even without "payment method" in body', async () => {
    setupUntilVolume(
      mockResponse(402, { error: 'Payment Required' }),
      'pay-me',
    );

    const result = await provisionCloudInstance({ flyApiToken: 'token' });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/\[cloud:billing_required:pay-me\]/);
  });

  it('matches payment-method messages case-insensitively', async () => {
    setupUntilVolume(
      mockResponse(422, { error: 'Please Add A Payment Method to continue' }),
      'mixed-case',
    );

    const result = await provisionCloudInstance({ flyApiToken: 'token' });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/\[cloud:billing_required:mixed-case\]/);
  });

  it('surfaces an actionable "try a different region" error on a 412 volume capacity failure', async () => {
    // Fly's host-affinity capacity signal: 412 "insufficient resources".
    // Must NOT fall through to the generic "Failed to create storage" message.
    setupUntilVolume(
      mockResponse(412, {
        error: "insufficient resources to create new machine with existing volume 'vol_abc'",
      }),
    );

    const result = await provisionCloudInstance({ flyApiToken: 'token', region: 'iad' });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not enough capacity in region "iad"/i);
    expect(result.error).toMatch(/try a different region/i);
    expect(result.failedStep).toBe(5);
  });

  it('still recognizes a 422 "capacity" volume failure as a region-capacity error', async () => {
    setupUntilVolume(mockResponse(422, { error: 'no capacity available in this region' }));

    const result = await provisionCloudInstance({ flyApiToken: 'token', region: 'iad' });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/try a different region/i);
    expect(result.failedStep).toBe(5);
  });

  it('surfaces an actionable "try a different region" error on a 412 machine capacity failure', async () => {
    // Volume creation succeeds; the 412 hits at machine create — the exact
    // shape the user reproduced (existing volume, no host can fit the machine).
    mockFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === GRAPHQL_URL) {
        const bodyText = typeof init?.body === 'string' ? init.body : '';
        if (bodyText.includes('organizations')) {
          return mockResponse(200, {
            data: { organizations: { nodes: [{ slug: 'acme-org', type: 'SHARED' }] } },
          });
        }
        return mockResponse(200, { data: {} });
      }
      if (url.startsWith(`${APPS_URL}?`)) return mockResponse(200, []);
      if (url === APPS_URL) return mockResponse(200, { name: 'rebel-cloud-xxxx' });
      if (url.includes('/volumes')) return mockResponse(200, { id: 'vol-1' });
      // Machine create fails with the 412 capacity signal.
      if (/\/machines$/.test(url) && init?.method === 'POST') {
        return mockResponse(412, {
          error: "insufficient resources to create new machine with existing volume 'vol_abc'",
        });
      }
      // Cleanup DELETE
      if (url.includes('?force=true') && init?.method === 'DELETE') return mockResponse(200, {});
      return mockResponse(500, { error: 'unmatched mock URL: ' + url });
    });

    const result = await provisionCloudInstance({ flyApiToken: 'token', region: 'iad' });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not enough capacity in region "iad"/i);
    expect(result.error).toMatch(/try a different region/i);
    expect(result.failedStep).toBe(6);
  });

  it('emits an sso_required marker when org lookup surfaces SSO rejection', async () => {
    mockFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === GRAPHQL_URL) {
        const bodyText = typeof init?.body === 'string' ? init.body : '';
        if (bodyText.includes('organizations')) {
          return mockResponse(200, {
            errors: [{ message: 'Single Sign On is required for this organization' }],
          });
        }
      }
      return mockResponse(500, { error: 'unexpected' });
    });

    const result = await provisionCloudInstance({ flyApiToken: 'token' });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/\[cloud:sso_required:fly\]/);
    expect(result.failedStep).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// provisionCloudInstance — SENTRY_DSN delivery into the machine env block
// (REBEL: OSS-scrub follow-up — cloud-service Sentry went dark because no
// delivery path injected SENTRY_DSN post-scrub. New machines get it via the
// machine-create config.env; absence of the option must leave the env clean
// so OSS builds never gain an empty/foreign key.)
// ---------------------------------------------------------------------------

describe('provisionCloudInstance SENTRY_DSN delivery', () => {
  const TEST_DSN = 'https://public@example.invalid/1';

  beforeEach(() => {
    mockFetch.mockReset();
  });

  /**
   * Full happy-path mock: org detection → token validation → app create →
   * secrets → volume → machine create → IP allocation → wait → health.
   */
  function setupHappyPath() {
    mockFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === GRAPHQL_URL) {
        const bodyText = typeof init?.body === 'string' ? init.body : '';
        if (bodyText.includes('organizations')) {
          return mockResponse(200, {
            data: { organizations: { nodes: [{ slug: 'acme-org', type: 'SHARED' }] } },
          });
        }
        // setSecrets + allocateIpAddress mutations
        return mockResponse(200, { data: {} });
      }
      if (url.startsWith(`${APPS_URL}?`)) {
        return mockResponse(200, []);
      }
      if (url === APPS_URL) {
        return mockResponse(200, { name: 'rebel-cloud-xxxx' });
      }
      if (url.includes('/volumes')) {
        return mockResponse(200, { id: 'vol-1' });
      }
      if (url.includes('/machines/mach-1/wait')) {
        return mockResponse(200, {});
      }
      if (url.includes('/machines')) {
        return mockResponse(200, { id: 'mach-1' });
      }
      if (url.includes('/api/health')) {
        return mockResponse(200, { status: 'ok' });
      }
      return mockResponse(500, { error: 'unmatched mock URL: ' + url });
    });
  }

  function capturedMachineCreateEnv(): Record<string, string> {
    const machineCreateCall = mockFetch.mock.calls.find(
      (call) => /\/machines$/.test(call[0] as string) && (call[1] as RequestInit | undefined)?.method === 'POST',
    );
    expect(machineCreateCall).toBeDefined();
    const body = JSON.parse((machineCreateCall![1] as RequestInit).body as string) as {
      config: { env: Record<string, string> };
    };
    return body.config.env;
  }

  it('includes SENTRY_DSN in the machine config env when the option carries a DSN', async () => {
    setupHappyPath();

    const result = await provisionCloudInstance({ flyApiToken: 'token', sentryDsn: TEST_DSN });

    expect(result.success).toBe(true);
    const env = capturedMachineCreateEnv();
    expect(env.SENTRY_DSN).toBe(TEST_DSN);
    // Baseline env must be preserved alongside the new key.
    expect(env.PORT).toBe('8080');
    expect(env.IS_CLOUD_SERVICE).toBe('1');
    expect(env.NODE_ENV).toBe('production');
  });

  it('omits the SENTRY_DSN key entirely when no DSN is provided (OSS no-phone-home)', async () => {
    setupHappyPath();

    const result = await provisionCloudInstance({ flyApiToken: 'token' });

    expect(result.success).toBe(true);
    const env = capturedMachineCreateEnv();
    expect(Object.keys(env)).not.toContain('SENTRY_DSN');
  });
});

describe('isTransientImagePullError', () => {
  it('returns true for "connection reset by peer" mid-blob-fetch', () => {
    const body =
      'failed to get blob, digest sha256:abc, ref ghcr.io/mindstone/rebel-cloud:latest@sha256:def: ' +
      'Get "https://pkg-containers.githubusercontent.com/...": ' +
      'read tcp [::1]:41576->[::1]:443: read: connection reset by peer';
    expect(isTransientImagePullError(400, body)).toBe(true);
  });

  it('returns true for i/o timeout during image pull', () => {
    expect(
      isTransientImagePullError(400, 'Failed to launch instance: failed to get blob: i/o timeout'),
    ).toBe(true);
  });

  it('returns false for unauthorized manifest fetch (real failure, not transient)', () => {
    expect(
      isTransientImagePullError(
        400,
        'failed to get manifest ghcr.io/mindstone/rebel-cloud:latest: unauthorized',
      ),
    ).toBe(false);
  });

  it('returns false for any status other than 400, even with matching body text', () => {
    // Tight allow-list: only 400 is retryable. 5xx in particular is excluded
    // because it leaves machine-create in an ambiguous state where the
    // first POST may have partially succeeded — a retry could duplicate.
    const body = 'failed to get blob: connection reset by peer';
    expect(isTransientImagePullError(401, body)).toBe(false);
    expect(isTransientImagePullError(402, body)).toBe(false);
    expect(isTransientImagePullError(403, body)).toBe(false);
    expect(isTransientImagePullError(422, body)).toBe(false);
    expect(isTransientImagePullError(500, body)).toBe(false);
    expect(isTransientImagePullError(502, body)).toBe(false);
    expect(isTransientImagePullError(503, body)).toBe(false);
    expect(isTransientImagePullError(504, body)).toBe(false);
  });

  it('returns false for unrelated bodies', () => {
    expect(isTransientImagePullError(400, 'volume capacity exceeded')).toBe(false);
    expect(isTransientImagePullError(400, '')).toBe(false);
  });
});
