import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('../cloud/cloudInitTemplate', () => ({
  generateCloudInit: vi.fn(() => '#cloud-config\nmocked: true'),
}));

import { hetznerProvider } from '../cloud/providers/hetznerProvider';

function mockFetchResponses(responses: Array<{ status: number; body?: unknown; ok?: boolean }>) {
  let callIndex = 0;
  return vi.fn(async () => {
    const resp = responses[callIndex] ?? { status: 500, body: { error: { message: 'No more mocked responses' } } };
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
  token: 'hz-test-token',
  region: 'fsn1',
  cloudflareZoneId: 'cf-zone-123',
  cloudflareDnsToken: 'cf-dns-token-abc',
};

describe('hetznerProvider', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe('config', () => {
    it('has correct provider metadata', () => {
      expect(hetznerProvider.config).toEqual({
        id: 'hetzner',
        name: 'Hetzner Cloud',
        authType: 'pat',
      });
    });
  });

  describe('provision', () => {
    it('returns error when cloudflare credentials are missing', async () => {
      const result = await hetznerProvider.provision({ token: 'test-token' });
      expect(result.success).toBe(false);
      expect(result.error).toContain('Cloudflare credentials');
    });

    it('returns error for invalid token (401)', async () => {
      globalThis.fetch = mockFetchResponses([
        { status: 401, body: { error: { code: 'unauthorized', message: 'unauthorized' } } },
      ]);

      const result = await hetznerProvider.provision(VALID_OPTS);
      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid Hetzner Cloud token');
      expect(result.failedStep).toBe(1);
    });

    it('returns error when volume creation fails', async () => {
      globalThis.fetch = mockFetchResponses([
        { status: 200, body: { locations: [] } },
        { status: 422, body: { error: { code: 'invalid_input', message: 'Location not available' } } },
      ]);

      const result = await hetznerProvider.provision(VALID_OPTS);
      expect(result.success).toBe(false);
      expect(result.error).toContain('Failed to create volume');
      expect(result.failedStep).toBe(3);
    });

    it('cleans up volume when server creation fails', async () => {
      globalThis.fetch = mockFetchResponses([
        { status: 200, body: { locations: [] } },
        { status: 201, body: { volume: { id: 100, linux_device: '/dev/disk/by-id/scsi-0HC_Volume_100' } } },
        { status: 422, body: { error: { code: 'resource_limit_exceeded', message: 'Server limit reached' } } },
        // Cleanup: delete volume
        { status: 204 },
      ]);

      const result = await hetznerProvider.provision(VALID_OPTS);
      expect(result.success).toBe(false);
      expect(result.failedStep).toBe(5);
    });

    it('completes provisioning successfully', async () => {
      globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
        const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;

        if (urlStr.includes('.cloud.mindstone.com')) {
          return { ok: true, status: 200, json: async () => ({ status: 'ok' }), text: async () => '{"status":"ok"}' };
        }

        // Hetzner API calls -- sequential
        if (urlStr.includes('/locations')) {
          return { ok: true, status: 200, json: async () => ({ locations: [] }), text: async () => '{}' };
        }
        if (urlStr.includes('/volumes') && !urlStr.includes('/volumes/')) {
          return { ok: true, status: 201, json: async () => ({ volume: { id: 200, linux_device: '/dev/disk/by-id/scsi-0HC_Volume_200' } }), text: async () => '{}' };
        }
        if (urlStr.includes('/servers') && !urlStr.includes('/servers/')) {
          return { ok: true, status: 201, json: async () => ({ server: { id: 5000 } }), text: async () => '{}' };
        }
        if (urlStr.match(/\/servers\/\d+$/)) {
          return {
            ok: true, status: 200,
            json: async () => ({ server: { status: 'running', public_net: { ipv4: { ip: '5.6.7.8' } } } }),
            text: async () => '{}',
          };
        }
        if (urlStr.includes('/firewalls')) {
          return { ok: true, status: 201, json: async () => ({ firewall: { id: 300 } }), text: async () => '{}' };
        }

        return { ok: false, status: 500, json: async () => ({}), text: async () => '{}' };
      }) as unknown as typeof globalThis.fetch;

      const progressSteps: Array<{ phase: string; progress: number }> = [];
      const result = await hetznerProvider.provision({
        ...VALID_OPTS,
        onProgress: (step) => progressSteps.push({ phase: step.phase, progress: step.progress }),
      });

      expect(result.success).toBe(true);
      expect(result.cloudUrl).toMatch(/^https:\/\/.+\.cloud\.mindstone\.com$/);
      expect(result.cloudToken).toBeDefined();
      expect(result.instanceId).toBe('5000');
      expect(result.providerMetadata?.serverId).toBe('5000');
      expect(result.providerMetadata?.volumeId).toBe('200');
      expect(result.providerMetadata?.firewallId).toBe('300');
      expect(result.providerMetadata?.hostname).toMatch(/\.cloud\.mindstone\.com$/);
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

        if (urlStr.includes('.cloud.mindstone.com')) {
          return { ok: true, status: 200, json: async () => ({}), text: async () => '{}' };
        }
        if (method === 'GET' && urlStr.includes('/servers/')) {
          return { ok: false, status: 404, json: async () => ({}), text: async () => '{}' };
        }
        return { ok: true, status: 204, json: async () => ({}), text: async () => '' };
      }) as unknown as typeof globalThis.fetch;

      const result = await hetznerProvider.deprovision('hz-token', '5000', {
        serverId: '5000',
        volumeId: '200',
        firewallId: '300',
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
        json: async () => ({ error: { code: 'not_found' } }),
        text: async () => 'not found',
      })) as unknown as typeof globalThis.fetch;

      const result = await hetznerProvider.deprovision('hz-token', '5000', {
        serverId: '5000',
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

      const result = await hetznerProvider.deprovision('hz-token', '5000');
      expect(result.success).toBe(true);
    });
  });

  describe('getStatus', () => {
    it('maps "running" to "started"', async () => {
      globalThis.fetch = mockFetchResponses([
        { status: 200, body: { server: { status: 'running' } } },
      ]);
      const result = await hetznerProvider.getStatus('hz-token', '5000');
      expect(result.state).toBe('started');
    });

    it('maps "off" to "stopped"', async () => {
      globalThis.fetch = mockFetchResponses([
        { status: 200, body: { server: { status: 'off' } } },
      ]);
      const result = await hetznerProvider.getStatus('hz-token', '5000');
      expect(result.state).toBe('stopped');
    });

    it('maps "initializing" to "starting"', async () => {
      globalThis.fetch = mockFetchResponses([
        { status: 200, body: { server: { status: 'initializing' } } },
      ]);
      const result = await hetznerProvider.getStatus('hz-token', '5000');
      expect(result.state).toBe('starting');
    });

    it('returns unknown for 404', async () => {
      globalThis.fetch = mockFetchResponses([
        { status: 404, body: { error: { code: 'not_found' } } },
      ]);
      const result = await hetznerProvider.getStatus('hz-token', '99999');
      expect(result.state).toBe('unknown');
      expect(result.error).toContain('not found');
    });

    it('returns unknown on fetch error', async () => {
      globalThis.fetch = vi.fn(async () => {
        throw new Error('Network timeout');
      }) as unknown as typeof globalThis.fetch;

      const result = await hetznerProvider.getStatus('hz-token', '5000');
      expect(result.state).toBe('unknown');
      expect(result.error).toContain('Network timeout');
    });
  });
});
