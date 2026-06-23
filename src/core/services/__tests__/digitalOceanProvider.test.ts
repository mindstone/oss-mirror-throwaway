import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('../cloud/cloudInitTemplate', () => ({
  generateCloudInit: vi.fn(() => '#cloud-config\nmocked: true'),
}));

import { digitalOceanProvider } from '../cloud/providers/digitalOceanProvider';

function mockFetchResponses(responses: Array<{ status: number; body?: unknown; ok?: boolean }>) {
  let callIndex = 0;
  return vi.fn(async () => {
    const resp = responses[callIndex] ?? { status: 500, body: { message: 'No more mocked responses' } };
    callIndex++;
    return {
      ok: resp.ok ?? (resp.status >= 200 && resp.status < 300),
      status: resp.status,
      json: async () => resp.body,
      text: async () => JSON.stringify(resp.body),
    };
  }) as unknown as typeof globalThis.fetch;
}

const VALID_OPTS = {
  token: 'do-test-pat',
  region: 'nyc1',
  cloudflareZoneId: 'cf-zone-123',
  cloudflareDnsToken: 'cf-dns-token-abc',
};

describe('digitalOceanProvider', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe('config', () => {
    it('has correct provider metadata', () => {
      expect(digitalOceanProvider.config).toEqual({
        id: 'digitalocean',
        name: 'DigitalOcean',
        authType: 'oauth',
      });
    });
  });

  describe('provision', () => {
    it('returns error when cloudflare credentials are missing', async () => {
      const result = await digitalOceanProvider.provision({
        token: 'test-token',
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain('Cloudflare credentials');
    });

    it('returns error for invalid DO token (401)', async () => {
      globalThis.fetch = mockFetchResponses([
        { status: 401, body: { message: 'Unauthorized' } },
      ]);

      const result = await digitalOceanProvider.provision(VALID_OPTS);
      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid DigitalOcean token');
      expect(result.failedStep).toBe(1);
    });

    it('returns error when volume creation fails', async () => {
      globalThis.fetch = mockFetchResponses([
        // Step 1: Validate PAT
        { status: 200, body: { account: { status: 'active' } } },
        // Step 3: Create volume -- fails
        { status: 422, body: { message: 'Region not available' } },
      ]);

      const result = await digitalOceanProvider.provision(VALID_OPTS);
      expect(result.success).toBe(false);
      expect(result.error).toContain('Failed to create volume');
      expect(result.failedStep).toBe(3);
    });

    it('cleans up volume when Droplet creation fails', async () => {
      const fetchMock = mockFetchResponses([
        // Step 1: Validate PAT
        { status: 200, body: { account: { status: 'active' } } },
        // Step 3: Create volume
        { status: 201, body: { volume: { id: 'vol-123' } } },
        // Step 5: Create Droplet -- fails
        { status: 422, body: { message: 'Insufficient resources' } },
        // Cleanup: Delete volume (no firewall or droplet to delete)
        { status: 204 },
      ]);
      globalThis.fetch = fetchMock;

      const result = await digitalOceanProvider.provision(VALID_OPTS);
      expect(result.success).toBe(false);
      expect(result.failedStep).toBe(5);
    });

    it('completes provisioning successfully', async () => {
      const _healthFetch = vi.fn();
      let fetchCallCount = 0;

      globalThis.fetch = vi.fn(async (url: string | URL | Request, _init?: RequestInit) => {
        const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;

        // Health check calls go to the hostname
        if (urlStr.includes('.cloud.mindstone.com')) {
          return { ok: true, status: 200, json: async () => ({ status: 'ok' }), text: async () => '{"status":"ok"}' };
        }

        // DO API calls
        fetchCallCount++;
        const responses: Record<number, { status: number; body: unknown }> = {
          1: { status: 200, body: { account: { status: 'active' } } }, // validate PAT
          2: { status: 201, body: { volume: { id: 'vol-abc123' } } }, // create volume
          3: { status: 202, body: { droplet: { id: 12345 } } }, // create droplet
          4: { status: 200, body: { droplet: { status: 'active', networks: { v4: [{ ip_address: '1.2.3.4', type: 'public' }] } } } }, // poll droplet
          5: { status: 202, body: { firewall: { id: 'fw-xyz' } } }, // create firewall
        };
        const resp = responses[fetchCallCount] ?? { status: 500, body: {} };
        return {
          ok: resp.status >= 200 && resp.status < 300,
          status: resp.status,
          json: async () => resp.body,
          text: async () => JSON.stringify(resp.body),
        };
      }) as unknown as typeof globalThis.fetch;

      const progressSteps: Array<{ phase: string; progress: number }> = [];
      const result = await digitalOceanProvider.provision({
        ...VALID_OPTS,
        onProgress: (step) => progressSteps.push({ phase: step.phase, progress: step.progress }),
      });

      expect(result.success).toBe(true);
      expect(result.cloudUrl).toMatch(/^https:\/\/.+\.cloud\.mindstone\.com$/);
      expect(result.cloudToken).toBeDefined();
      expect(result.instanceId).toBe('12345');
      expect(result.providerMetadata?.dropletId).toBe('12345');
      expect(result.providerMetadata?.volumeId).toBe('vol-abc123');
      expect(result.providerMetadata?.firewallId).toBe('fw-xyz');
      expect(result.providerMetadata?.hostname).toMatch(/\.cloud\.mindstone\.com$/);

      expect(progressSteps.length).toBeGreaterThan(0);
      expect(progressSteps[progressSteps.length - 1]?.progress).toBe(100);
    });
  });

  describe('deprovision', () => {
    it('deletes all resources in order', async () => {
      const calls: string[] = [];
      globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
        const method = init?.method ?? 'GET';
        calls.push(`${method} ${urlStr}`);

        // DNS cleanup
        if (urlStr.includes('.cloud.mindstone.com')) {
          return { ok: true, status: 200, json: async () => ({}), text: async () => '{}' };
        }

        // Droplet GET (for waitForDropletGone) -- return 404
        if (method === 'GET' && urlStr.includes('/droplets/')) {
          return { ok: false, status: 404, json: async () => ({}), text: async () => '{}' };
        }

        // DELETE calls
        return { ok: true, status: 204, json: async () => ({}), text: async () => '' };
      }) as unknown as typeof globalThis.fetch;

      const result = await digitalOceanProvider.deprovision('do-token', '12345', {
        dropletId: '12345',
        volumeId: 'vol-abc',
        firewallId: 'fw-xyz',
        hostname: 'test.cloud.mindstone.com',
        cloudToken: 'cloud-token-123',
      });

      expect(result.success).toBe(true);
      expect(calls).toContainEqual(expect.stringContaining('dns/cleanup'));
      expect(calls).toContainEqual(expect.stringContaining('DELETE'));
    });

    it('treats 404 as success during deprovision', async () => {
      globalThis.fetch = vi.fn(async () => ({
        ok: false,
        status: 404,
        json: async () => ({ id: 'not_found' }),
        text: async () => 'not found',
      })) as unknown as typeof globalThis.fetch;

      const result = await digitalOceanProvider.deprovision('do-token', '12345', {
        dropletId: '12345',
      });

      expect(result.success).toBe(true);
    });

    it('handles deprovision with minimal metadata gracefully', async () => {
      globalThis.fetch = vi.fn(async () => ({
        ok: true,
        status: 204,
        json: async () => ({}),
        text: async () => '',
      })) as unknown as typeof globalThis.fetch;

      const result = await digitalOceanProvider.deprovision('do-token', '12345');
      expect(result.success).toBe(true);
    });
  });

  describe('getStatus', () => {
    it('maps "active" to "started"', async () => {
      globalThis.fetch = mockFetchResponses([
        { status: 200, body: { droplet: { status: 'active' } } },
      ]);

      const result = await digitalOceanProvider.getStatus('do-token', '12345');
      expect(result.state).toBe('started');
    });

    it('maps "off" to "stopped"', async () => {
      globalThis.fetch = mockFetchResponses([
        { status: 200, body: { droplet: { status: 'off' } } },
      ]);

      const result = await digitalOceanProvider.getStatus('do-token', '12345');
      expect(result.state).toBe('stopped');
    });

    it('maps "new" to "starting"', async () => {
      globalThis.fetch = mockFetchResponses([
        { status: 200, body: { droplet: { status: 'new' } } },
      ]);

      const result = await digitalOceanProvider.getStatus('do-token', '12345');
      expect(result.state).toBe('starting');
    });

    it('returns unknown for 404', async () => {
      globalThis.fetch = mockFetchResponses([
        { status: 404, body: { id: 'not_found' } },
      ]);

      const result = await digitalOceanProvider.getStatus('do-token', '99999');
      expect(result.state).toBe('unknown');
      expect(result.error).toContain('not found');
    });

    it('returns unknown on fetch error', async () => {
      globalThis.fetch = vi.fn(async () => {
        throw new Error('Network timeout');
      }) as unknown as typeof globalThis.fetch;

      const result = await digitalOceanProvider.getStatus('do-token', '12345');
      expect(result.state).toBe('unknown');
      expect(result.error).toContain('Network timeout');
    });
  });
});
