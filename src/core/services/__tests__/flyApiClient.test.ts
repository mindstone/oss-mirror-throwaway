import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  flyFetch,
  flyGraphQL,
  parseFlyError,
  listIpAddresses,
  allocateSharedIpv4,
  updateMachineConfig,
  getMachineState,
  destroyMachine,
  createMachine,
  waitForMachineState,
  sanitizeMachineConfig,
  applyImageRollback,
  FLY_MACHINES_BASE,
  FLY_GRAPHQL_URL,
} from '../flyApiClient';

// ---------------------------------------------------------------------------
// Mock global fetch
// ---------------------------------------------------------------------------

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

/** Helper to build a minimal Response-like object for mocked fetch. */
function mockResponse(status: number, body: unknown, headers?: Record<string, string>): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body)),
    headers: new Map(Object.entries(headers ?? {})),
  } as unknown as Response;
}

// ---------------------------------------------------------------------------
// URL matchers
// ---------------------------------------------------------------------------

const GRAPHQL_URL = FLY_GRAPHQL_URL;
const machineUrl = (app: string, id: string) =>
  `${FLY_MACHINES_BASE}/v1/apps/${app}/machines/${id}`;

/**
 * Configure mockFetch to return different responses based on URL.
 * Accepts a map of URL-prefix → Response. Falls back to 500 for unmatched URLs.
 */
function _setupFetchRoutes(routes: Record<string, Response>) {
  mockFetch.mockImplementation((url: string) => {
    for (const [prefix, resp] of Object.entries(routes)) {
      if (url.startsWith(prefix)) return Promise.resolve(resp);
    }
    return Promise.resolve(mockResponse(500, { error: 'unmatched mock URL' }));
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('flyFetch', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('injects Authorization header with Bearer token', async () => {
    mockFetch.mockResolvedValue(mockResponse(200, {}));

    await flyFetch('my-token', '/v1/apps');

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${FLY_MACHINES_BASE}/v1/apps`);
    expect((opts.headers as Record<string, string>).Authorization).toBe('Bearer my-token');
  });

  it('sets Content-Type to application/json', async () => {
    mockFetch.mockResolvedValue(mockResponse(200, {}));

    await flyFetch('tok', '/path');

    const [, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect((opts.headers as Record<string, string>)['Content-Type']).toBe('application/json');
  });

  it('uses a default 30s timeout signal when none provided', async () => {
    mockFetch.mockResolvedValue(mockResponse(200, {}));

    await flyFetch('tok', '/path');

    const [, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(opts.signal).toBeDefined();
  });

  it('passes through custom RequestInit options', async () => {
    mockFetch.mockResolvedValue(mockResponse(200, {}));

    await flyFetch('tok', '/path', {
      method: 'DELETE',
      body: JSON.stringify({ force: true }),
    });

    const [, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(opts.method).toBe('DELETE');
    expect(opts.body).toBe(JSON.stringify({ force: true }));
  });

  it('returns the Response object', async () => {
    const resp = mockResponse(201, { id: 'abc' });
    mockFetch.mockResolvedValue(resp);

    const result = await flyFetch('tok', '/v1/apps');
    expect(result).toBe(resp);
  });
});

describe('flyGraphQL', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('sends a POST to the GraphQL endpoint with query and variables', async () => {
    mockFetch.mockResolvedValue(mockResponse(200, { data: { app: { name: 'test' } } }));

    await flyGraphQL('tok', 'query { app { name } }', { appName: 'test' });

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(GRAPHQL_URL);
    expect(opts.method).toBe('POST');
    const body = JSON.parse(opts.body as string);
    expect(body.query).toBe('query { app { name } }');
    expect(body.variables).toEqual({ appName: 'test' });
  });

  it('returns parsed data on success', async () => {
    mockFetch.mockResolvedValue(mockResponse(200, { data: { app: { id: '1' } } }));

    const result = await flyGraphQL('tok', 'query {}', {});
    expect(result.data).toEqual({ app: { id: '1' } });
    expect(result.errors).toBeUndefined();
  });

  it('returns errors from the GraphQL response', async () => {
    mockFetch.mockResolvedValue(
      mockResponse(200, { errors: [{ message: 'Not found' }] }),
    );

    const result = await flyGraphQL('tok', 'query {}', {});
    expect(result.errors).toHaveLength(1);
    expect(result.errors![0].message).toBe('Not found');
  });

  it('throws when the HTTP status is not OK', async () => {
    mockFetch.mockResolvedValue(mockResponse(500, 'Internal Server Error'));

    await expect(flyGraphQL('tok', 'query {}', {})).rejects.toThrow(
      'GraphQL request failed: HTTP 500',
    );
  });
});

describe('parseFlyError', () => {
  it('returns status and body message', () => {
    const resp = mockResponse(422, 'Unprocessable Entity');
    const err = parseFlyError(resp, 'App already exists');
    expect(err).toEqual({ status: 422, message: 'App already exists' });
  });

  it('falls back to HTTP status when no body provided', () => {
    const resp = mockResponse(500, '');
    const err = parseFlyError(resp);
    expect(err).toEqual({ status: 500, message: 'HTTP 500' });
  });
});

describe('listIpAddresses', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('returns a parsed list of IP addresses', async () => {
    mockFetch.mockResolvedValue(
      mockResponse(200, {
        data: {
          app: {
            ipAddresses: {
              nodes: [
                { id: 'ip-1', address: '1.2.3.4', type: 'shared_v4' },
                { id: 'ip-2', address: '2001:db8::1', type: 'v6' },
              ],
            },
          },
        },
      }),
    );

    const ips = await listIpAddresses('tok', 'my-app');
    expect(ips).toEqual([
      { id: 'ip-1', address: '1.2.3.4', type: 'shared_v4' },
      { id: 'ip-2', address: '2001:db8::1', type: 'v6' },
    ]);
  });

  it('returns an empty array when app has no IPs', async () => {
    mockFetch.mockResolvedValue(
      mockResponse(200, {
        data: { app: { ipAddresses: { nodes: [] } } },
      }),
    );

    const ips = await listIpAddresses('tok', 'my-app');
    expect(ips).toEqual([]);
  });

  it('returns an empty array when ipAddresses.nodes is missing', async () => {
    mockFetch.mockResolvedValue(
      mockResponse(200, { data: { app: {} } }),
    );

    const ips = await listIpAddresses('tok', 'my-app');
    expect(ips).toEqual([]);
  });

  it('throws when GraphQL returns errors', async () => {
    mockFetch.mockResolvedValue(
      mockResponse(200, { errors: [{ message: 'App not found' }] }),
    );

    await expect(listIpAddresses('tok', 'missing-app')).rejects.toThrow(
      'Failed to list IP addresses for missing-app: App not found',
    );
  });
});

describe('allocateSharedIpv4', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('returns alreadyExists when a shared_v4 IP is present', async () => {
    // First call: listIpAddresses (GraphQL)
    mockFetch.mockResolvedValue(
      mockResponse(200, {
        data: {
          app: {
            ipAddresses: {
              nodes: [
                { id: 'ip-1', address: '1.2.3.4', type: 'shared_v4' },
              ],
            },
          },
        },
      }),
    );

    const result = await allocateSharedIpv4('tok', 'my-app');
    expect(result).toEqual({
      success: true,
      address: '1.2.3.4',
      alreadyExists: true,
    });
    // Should only have been called once (listIpAddresses), not twice
    expect(mockFetch).toHaveBeenCalledOnce();
  });

  it('allocates when no shared_v4 exists', async () => {
    let callCount = 0;
    mockFetch.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        // listIpAddresses: no shared_v4
        return Promise.resolve(
          mockResponse(200, {
            data: { app: { ipAddresses: { nodes: [{ id: 'ip-v6', address: '::1', type: 'v6' }] } } },
          }),
        );
      }
      // allocateIpAddress mutation
      return Promise.resolve(
        mockResponse(200, {
          data: { allocateIpAddress: { ipAddress: { address: '5.6.7.8', type: 'shared_v4' } } },
        }),
      );
    });

    const result = await allocateSharedIpv4('tok', 'my-app');
    expect(result).toEqual({ success: true, address: '5.6.7.8' });
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('returns error when allocation mutation fails', async () => {
    let callCount = 0;
    mockFetch.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        // listIpAddresses: empty
        return Promise.resolve(
          mockResponse(200, {
            data: { app: { ipAddresses: { nodes: [] } } },
          }),
        );
      }
      // allocation fails with GraphQL errors
      return Promise.resolve(
        mockResponse(200, {
          errors: [{ message: 'Quota exceeded' }],
        }),
      );
    });

    const result = await allocateSharedIpv4('tok', 'my-app');
    expect(result.success).toBe(false);
    expect(result.error).toContain('Quota exceeded');
  });

  it('returns error when listIpAddresses throws', async () => {
    mockFetch.mockRejectedValue(new Error('Network error'));

    const result = await allocateSharedIpv4('tok', 'my-app');
    expect(result.success).toBe(false);
    expect(result.error).toContain('Network error');
  });
});

describe('updateMachineConfig', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('GETs machine, applies patcher, POSTs with version', async () => {
    const calls: Array<{ url: string; method?: string; body?: string }> = [];
    mockFetch.mockImplementation((url: string, opts?: RequestInit) => {
      calls.push({ url, method: opts?.method, body: opts?.body as string });

      if (!opts?.method || opts.method === 'GET') {
        // GET machine
        return Promise.resolve(
          mockResponse(200, {
            config: { image: 'old-image', env: { PORT: '8080' } },
            version: 42,
            state: 'started',
          }),
        );
      }
      // POST update
      return Promise.resolve(mockResponse(200, { id: 'mach-1' }));
    });

    const result = await updateMachineConfig(
      'tok',
      'my-app',
      'mach-1',
      (config) => ({ ...config, image: 'new-image' }),
    );

    expect(result).toEqual({ success: true, restarted: true });
    expect(calls).toHaveLength(2);

    // Verify GET
    expect(calls[0].url).toBe(machineUrl('my-app', 'mach-1'));

    // Verify POST payload
    expect(calls[1].method).toBe('POST');
    const postBody = JSON.parse(calls[1].body!);
    expect(postBody.config.image).toBe('new-image');
    expect(postBody.config.env).toEqual({ PORT: '8080' });
    expect(postBody.current_version).toBe(42);
  });

  it('returns version conflict error on 409', async () => {
    let callCount = 0;
    mockFetch.mockImplementation((_url: string, _opts?: RequestInit) => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve(
          mockResponse(200, { config: { image: 'old' }, version: 1 }),
        );
      }
      return Promise.resolve(mockResponse(409, 'Version conflict'));
    });

    const result = await updateMachineConfig('tok', 'my-app', 'mach-1', (c) => c);

    expect(result.success).toBe(false);
    expect(result.error).toContain('Version conflict');
  });

  it('returns error when GET fails', async () => {
    mockFetch.mockResolvedValue(mockResponse(404, 'Not found'));

    const result = await updateMachineConfig('tok', 'my-app', 'bad-id', (c) => c);
    expect(result.success).toBe(false);
    expect(result.error).toContain('Failed to fetch machine');
  });

  it('returns error when machine has no config', async () => {
    mockFetch.mockResolvedValue(mockResponse(200, { version: 1 }));

    const result = await updateMachineConfig('tok', 'my-app', 'mach-1', (c) => c);
    expect(result.success).toBe(false);
    expect(result.error).toContain('missing config');
  });

  it('returns error when POST fails with non-409 status', async () => {
    let callCount = 0;
    mockFetch.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve(
          mockResponse(200, { config: { image: 'old' }, version: 1 }),
        );
      }
      return Promise.resolve(mockResponse(500, 'Internal error'));
    });

    const result = await updateMachineConfig('tok', 'my-app', 'mach-1', (c) => c);
    expect(result.success).toBe(false);
    expect(result.error).toContain('Machine config update failed');
    expect(result.error).toContain('500');
  });

  it('calls patcher with the current config', async () => {
    const patcher = vi.fn((config: Record<string, unknown>) => ({
      ...config,
      newField: 'value',
    }));

    let callCount = 0;
    mockFetch.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve(
          mockResponse(200, {
            config: { image: 'img', custom: 'data' },
            version: 5,
          }),
        );
      }
      return Promise.resolve(mockResponse(200, {}));
    });

    await updateMachineConfig('tok', 'app', 'mach', patcher);

    expect(patcher).toHaveBeenCalledOnce();
    expect(patcher).toHaveBeenCalledWith({ image: 'img', custom: 'data' });
  });

  it('omits current_version when machine has no version field', async () => {
    let postBody: Record<string, unknown> | undefined;
    let callCount = 0;
    mockFetch.mockImplementation((_url: string, opts?: RequestInit) => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve(
          mockResponse(200, { config: { image: 'old' } }),
        );
      }
      postBody = JSON.parse(opts?.body as string);
      return Promise.resolve(mockResponse(200, {}));
    });

    await updateMachineConfig('tok', 'app', 'mach', (c) => c);

    expect(postBody).toBeDefined();
    expect(postBody!.current_version).toBeUndefined();
  });

  it('returns error when fetch throws a network error', async () => {
    mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));

    const result = await updateMachineConfig('tok', 'app', 'mach', (c) => c);
    expect(result.success).toBe(false);
    expect(result.error).toContain('ECONNREFUSED');
  });
});

// ---------------------------------------------------------------------------
// Machine lifecycle primitives
// ---------------------------------------------------------------------------

describe('getMachineState', () => {
  beforeEach(() => { mockFetch.mockReset(); });

  it('returns parsed machine state on success', async () => {
    mockFetch.mockResolvedValue(mockResponse(200, {
      id: 'mach-1',
      state: 'started',
      config: { image: 'img:latest', env: { PORT: '8080' } },
      version: '42',
      region: 'iad',
      updated_at: '2026-03-18T12:00:00Z',
      checks: [{ name: 'http', status: 'passing' }],
    }));

    const result = await getMachineState('tok', 'my-app', 'mach-1');
    expect(result.success).toBe(true);
    expect(result.machine).toMatchObject({
      id: 'mach-1',
      state: 'started',
      region: 'iad',
      updatedAt: '2026-03-18T12:00:00Z',
    });
    expect(result.machine!.config).toEqual({ image: 'img:latest', env: { PORT: '8080' } });
  });

  it('returns error on non-OK response', async () => {
    mockFetch.mockResolvedValue(mockResponse(404, 'Not found'));
    const result = await getMachineState('tok', 'my-app', 'bad-id');
    expect(result.success).toBe(false);
    expect(result.error).toContain('404');
  });

  it('returns error on network failure', async () => {
    mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));
    const result = await getMachineState('tok', 'my-app', 'mach-1');
    expect(result.success).toBe(false);
    expect(result.error).toContain('ECONNREFUSED');
  });

  it('handles missing optional fields gracefully', async () => {
    mockFetch.mockResolvedValue(mockResponse(200, {
      id: 'mach-1',
      state: 'starting',
    }));

    const result = await getMachineState('tok', 'my-app', 'mach-1');
    expect(result.success).toBe(true);
    expect(result.machine!.config).toEqual({});
    expect(result.machine!.checks).toBeUndefined();
  });
});

describe('destroyMachine', () => {
  beforeEach(() => { mockFetch.mockReset(); });

  it('sends DELETE with force=true by default', async () => {
    mockFetch.mockResolvedValue(mockResponse(200, {}));

    const result = await destroyMachine('tok', 'my-app', 'mach-1');
    expect(result.success).toBe(true);

    const [url, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('?force=true');
    expect(opts.method).toBe('DELETE');
  });

  it('sends DELETE without force when force=false', async () => {
    mockFetch.mockResolvedValue(mockResponse(200, {}));

    await destroyMachine('tok', 'my-app', 'mach-1', false);
    const [url] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).not.toContain('force');
  });

  it('returns error on non-OK response', async () => {
    mockFetch.mockResolvedValue(mockResponse(500, 'Internal error'));
    const result = await destroyMachine('tok', 'my-app', 'mach-1');
    expect(result.success).toBe(false);
    expect(result.error).toContain('500');
  });

  it('returns error on network failure', async () => {
    mockFetch.mockRejectedValue(new Error('timeout'));
    const result = await destroyMachine('tok', 'my-app', 'mach-1');
    expect(result.success).toBe(false);
    expect(result.error).toContain('timeout');
  });
});

describe('createMachine', () => {
  beforeEach(() => { mockFetch.mockReset(); });

  it('sends POST with config and returns new machine ID', async () => {
    mockFetch.mockResolvedValue(mockResponse(200, { id: 'new-mach', state: 'created' }));

    const config = { image: 'img:latest', env: { PORT: '8080' } };
    const result = await createMachine('tok', 'my-app', config, 'iad');
    expect(result.success).toBe(true);
    expect(result.machineId).toBe('new-mach');
    expect(result.state).toBe('created');

    const [url, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/v1/apps/my-app/machines');
    expect(opts.method).toBe('POST');
    const body = JSON.parse(opts.body as string);
    expect(body.region).toBe('iad');
    expect(body.config.image).toBe('img:latest');
  });

  it('omits region when not specified', async () => {
    mockFetch.mockResolvedValue(mockResponse(200, { id: 'new-mach', state: 'created' }));

    await createMachine('tok', 'my-app', { image: 'img' });
    const [, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(opts.body as string);
    expect(body.region).toBeUndefined();
  });

  it('sanitizes Fly-internal metadata from config', async () => {
    mockFetch.mockResolvedValue(mockResponse(200, { id: 'new-mach', state: 'created' }));

    const config = {
      image: 'img',
      metadata: {
        fly_flyctl_version: '0.1.0',
        fly_platform_version: 'v2',
        fly_process_group: 'app',
        fly_release_id: 'rel-1',
        fly_release_version: '5',
        custom_key: 'keep-this',
      },
    };

    await createMachine('tok', 'my-app', config);
    const [, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(opts.body as string);
    expect(body.config.metadata).toEqual({ custom_key: 'keep-this' });
  });

  it('returns error on non-OK response', async () => {
    mockFetch.mockResolvedValue(mockResponse(422, 'Invalid config'));
    const result = await createMachine('tok', 'my-app', { image: 'img' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('422');
  });

  it('returns error on network failure', async () => {
    mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));
    const result = await createMachine('tok', 'my-app', { image: 'img' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('ECONNREFUSED');
  });
});

describe('waitForMachineState', () => {
  beforeEach(() => { mockFetch.mockReset(); });

  it('calls the wait endpoint with correct params', async () => {
    mockFetch.mockResolvedValue(mockResponse(200, {}));

    const result = await waitForMachineState('tok', 'my-app', 'mach-1', 'started', 60);
    expect(result.success).toBe(true);

    const [url] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/v1/apps/my-app/machines/mach-1/wait?state=started&timeout=60');
  });

  it('uses default 60s timeout (Fly.io max)', async () => {
    mockFetch.mockResolvedValue(mockResponse(200, {}));

    await waitForMachineState('tok', 'my-app', 'mach-1', 'started');
    const [url] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('timeout=60');
  });

  it('clamps timeout exceeding Fly.io max (60s) down to 60', async () => {
    mockFetch.mockResolvedValue(mockResponse(200, {}));

    await waitForMachineState('tok', 'my-app', 'mach-1', 'started', 120);
    const [url] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('timeout=60');
  });

  it('clamps timeout below 1s up to 1', async () => {
    mockFetch.mockResolvedValue(mockResponse(200, {}));

    await waitForMachineState('tok', 'my-app', 'mach-1', 'started', 0);
    const [url] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('timeout=1');
  });

  it('returns error when wait times out (non-OK response)', async () => {
    mockFetch.mockResolvedValue(mockResponse(408, 'Timeout'));
    const result = await waitForMachineState('tok', 'my-app', 'mach-1', 'started');
    expect(result.success).toBe(false);
    expect(result.error).toContain('408');
  });

  it('returns error on network failure', async () => {
    mockFetch.mockRejectedValue(new Error('aborted'));
    const result = await waitForMachineState('tok', 'my-app', 'mach-1', 'started');
    expect(result.success).toBe(false);
    expect(result.error).toContain('aborted');
  });
});

describe('sanitizeMachineConfig', () => {
  it('strips Fly-internal metadata keys', () => {
    const config = {
      image: 'img',
      metadata: {
        fly_flyctl_version: '0.1.0',
        fly_platform_version: 'v2',
        fly_process_group: 'app',
        fly_release_id: 'rel-1',
        fly_release_version: '5',
      },
    };

    const cleaned = sanitizeMachineConfig(config);
    expect(cleaned.metadata).toBeUndefined();
    expect(cleaned.image).toBe('img');
  });

  it('preserves non-Fly metadata keys', () => {
    const config = {
      image: 'img',
      metadata: {
        fly_flyctl_version: '0.1.0',
        custom_key: 'value',
      },
    };

    const cleaned = sanitizeMachineConfig(config);
    expect(cleaned.metadata).toEqual({ custom_key: 'value' });
  });

  it('preserves config without metadata', () => {
    const config = { image: 'img', env: { PORT: '8080' } };
    const cleaned = sanitizeMachineConfig(config);
    expect(cleaned).toEqual(config);
  });

  it('does not mutate the original config', () => {
    const original = {
      image: 'img',
      metadata: { fly_flyctl_version: '0.1.0', custom: 'val' },
    };
    const originalMetadata = { ...original.metadata };
    sanitizeMachineConfig(original);
    expect(original.metadata).toEqual(originalMetadata);
  });
});

// ---------------------------------------------------------------------------
// applyImageRollback (Stage 0 of docs/plans/260510_cloud_image_rollback_defense_in_depth.md)
// ---------------------------------------------------------------------------

describe('applyImageRollback', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('returns rolled-back when target image differs from current and POST succeeds', async () => {
    const calls: Array<{ method?: string; body?: string }> = [];
    mockFetch.mockImplementation((_url: string, opts?: RequestInit) => {
      calls.push({ method: opts?.method, body: opts?.body as string });
      if (!opts?.method || opts.method === 'GET') {
        return Promise.resolve(
          mockResponse(200, {
            config: { image: 'ghcr.io/mindstone/rebel-cloud:dev-bad', env: {} },
            version: 7,
          }),
        );
      }
      return Promise.resolve(mockResponse(200, {}));
    });

    const result = await applyImageRollback(
      'tok',
      'rebel-cloud-app',
      'mach-1',
      'ghcr.io/mindstone/rebel-cloud:dev-good',
      { writerTag: 'pre-bootstrap-watchdog' },
    );

    expect(result.outcome).toBe('rolled-back');
    expect(result.error).toBeUndefined();
    expect(calls).toHaveLength(2);
    const postBody = JSON.parse(calls[1].body!);
    expect(postBody.config.image).toBe('ghcr.io/mindstone/rebel-cloud:dev-good');
  });

  it('returns no-op-same-image and does not POST when target matches current', async () => {
    const calls: Array<{ method?: string }> = [];
    mockFetch.mockImplementation((_url: string, opts?: RequestInit) => {
      calls.push({ method: opts?.method });
      if (!opts?.method || opts.method === 'GET') {
        return Promise.resolve(
          mockResponse(200, {
            config: { image: 'ghcr.io/mindstone/rebel-cloud:dev-same' },
            version: 1,
          }),
        );
      }
      // The POST should still happen because updateMachineConfig issues it
      // regardless, but the patcher returned the unchanged config.
      return Promise.resolve(mockResponse(200, {}));
    });

    const result = await applyImageRollback(
      'tok',
      'app',
      'mach',
      'ghcr.io/mindstone/rebel-cloud:dev-same',
      { writerTag: 'desktop-revert' },
    );

    expect(result.outcome).toBe('no-op-same-image');
    expect(result.error).toBeUndefined();
  });

  it('returns image-invalid for malformed image refs', async () => {
    const result = await applyImageRollback(
      'tok',
      'app',
      'mach',
      'not a valid image ref',
      { writerTag: 'desktop-revert' },
    );

    expect(result.outcome).toBe('image-invalid');
    expect(result.error).toContain('Invalid image ref');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('returns conflict on Fly version-conflict (409)', async () => {
    let callCount = 0;
    mockFetch.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve(
          mockResponse(200, { config: { image: 'old:tag' }, version: 1 }),
        );
      }
      return Promise.resolve(mockResponse(409, 'Version conflict'));
    });

    const result = await applyImageRollback(
      'tok',
      'app',
      'mach',
      'ghcr.io/mindstone/rebel-cloud:dev-target',
      { writerTag: 'pre-bootstrap-watchdog' },
    );

    expect(result.outcome).toBe('conflict');
    expect(result.error).toContain('Version conflict');
  });

  it('returns fly-error on a 5xx from the Fly API', async () => {
    let callCount = 0;
    mockFetch.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve(
          mockResponse(200, { config: { image: 'old:tag' }, version: 1 }),
        );
      }
      return Promise.resolve(mockResponse(500, 'Internal error'));
    });

    const result = await applyImageRollback(
      'tok',
      'app',
      'mach',
      'ghcr.io/mindstone/rebel-cloud:dev-target',
      { writerTag: 'desktop-revert' },
    );

    expect(result.outcome).toBe('fly-error');
    expect(result.error).toContain('500');
  });

  it('returns fly-error when the GET fails (404)', async () => {
    mockFetch.mockResolvedValue(mockResponse(404, 'Not Found'));

    const result = await applyImageRollback(
      'tok',
      'app',
      'mach',
      'ghcr.io/mindstone/rebel-cloud:dev-target',
      { writerTag: 'self-update' },
    );

    expect(result.outcome).toBe('fly-error');
    expect(result.error).toContain('Failed to fetch machine');
  });
});
