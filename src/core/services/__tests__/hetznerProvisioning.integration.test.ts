import { randomBytes } from 'crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { generateCloudInit } from '../cloud/cloudInitTemplate';
import { DEFAULT_VOLUME_SIZE_GB } from '../cloud/providers/volumeDefaults';

const SHOULD_RUN = process.env.RUN_HETZNER_INTEGRATION_TESTS === '1';
const HETZNER_API_TOKEN = process.env.HETZNER_API_TOKEN ?? '';
const CLOUDFLARE_ZONE_ID = process.env.CLOUDFLARE_ZONE_ID ?? '';
const CLOUDFLARE_DNS_TOKEN = process.env.CLOUDFLARE_DNS_TOKEN ?? '';
const HAS_DNS_CREDENTIALS = Boolean(CLOUDFLARE_ZONE_ID && CLOUDFLARE_DNS_TOKEN);
const HAS_PREREQUISITES = Boolean(HETZNER_API_TOKEN);

const HZ_API_BASE = 'https://api.hetzner.cloud/v1';
const LOCATION = 'fsn1';
const SERVER_TYPE = 'cx22';
const SERVER_IMAGE = 'ubuntu-24.04';
const VOLUME_SIZE_GB = DEFAULT_VOLUME_SIZE_GB;
const HEALTH_POLL_TIMEOUT_MS = 300_000;
const RESOURCE_POLL_TIMEOUT_MS = 120_000;
const POLL_INTERVAL_MS = 3_000;

async function hzFetch(path: string, options: RequestInit = {}): Promise<Response> {
  return fetch(`${HZ_API_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${HETZNER_API_TOKEN}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
    signal: options.signal ?? AbortSignal.timeout(30_000),
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForServerActive(serverId: number): Promise<string> {
  const deadline = Date.now() + RESOURCE_POLL_TIMEOUT_MS;
  let lastStatus = 'unknown';

  while (Date.now() < deadline) {
    const resp = await hzFetch(`/servers/${serverId}`);
    if (resp.ok) {
      const body = await resp.json() as {
        server: {
          status: string;
          public_net: { ipv4?: { ip?: string } };
        };
      };
      lastStatus = body.server.status;
      if (body.server.status === 'running' && body.server.public_net.ipv4?.ip) {
        return body.server.public_net.ipv4.ip;
      }
    }

    await sleep(POLL_INTERVAL_MS);
  }

  throw new Error(`Server ${serverId} did not become running with a public IP (last status: ${lastStatus}).`);
}

async function waitForHealth(target: string): Promise<void> {
  const deadline = Date.now() + HEALTH_POLL_TIMEOUT_MS;
  let lastError = 'no response';
  const isIp = /^\d+\.\d+\.\d+\.\d+$/.test(target);
  const healthUrl = isIp ? `http://${target}/api/health` : `https://${target}/api/health`;

  while (Date.now() < deadline) {
    try {
      const resp = await fetch(healthUrl, {
        signal: AbortSignal.timeout(5_000),
      });
      if (resp.ok) {
        const body = await resp.json() as { status?: string };
        if (body.status === 'ok') {
          return;
        }
        lastError = `Unexpected health payload: ${JSON.stringify(body)}`;
      } else {
        lastError = `HTTP ${resp.status}`;
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }

    await sleep(5_000);
  }

  throw new Error(`Health check failed for ${target}: ${lastError}`);
}

async function waitForResourceGone(path: string): Promise<void> {
  const deadline = Date.now() + RESOURCE_POLL_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const resp = await hzFetch(path);
    if (resp.status === 404) {
      return;
    }
    await sleep(POLL_INTERVAL_MS);
  }

  throw new Error(`Resource ${path} still exists after timeout.`);
}

async function cleanupDnsRecord(zoneId: string, dnsToken: string, hostname: string): Promise<void> {
  // Safety: only clean up DNS records matching the test hostname pattern (8-hex-char subdomain)
  if (!/^[a-f0-9]{8}\.cloud\.mindstone\.com$/.test(hostname)) return;
  const listResp = await fetch(`https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records?name=${hostname}&type=A`, {
    headers: { Authorization: `Bearer ${dnsToken}` },
  });
  if (!listResp.ok) return;
  const data = await listResp.json() as { result: Array<{ id: string }> };
  for (const record of data.result ?? []) {
    await fetch(`https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records/${record.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${dnsToken}` },
    });
  }
}

describe.skipIf(!SHOULD_RUN || !HAS_PREREQUISITES)('Hetzner Provisioning Integration Tests', () => {
  let suffix = '';
  let hostname = '';
  let _serverIp = '';
  let cloudToken = '';
  let volumeName = '';
  let volumeId: number | undefined;
  let serverId: number | undefined;
  let firewallId: number | undefined;
  let cloudInit = '';
  let deprovisioned = false;

  beforeAll(() => {
    suffix = randomBytes(4).toString('hex');
    hostname = `${suffix}.cloud.mindstone.com`;
    cloudToken = randomBytes(32).toString('hex');
    volumeName = `rebel-data-${suffix}`;
  });

  afterAll(async () => {
    if (!deprovisioned) {
      if (firewallId) {
        try {
          await hzFetch(`/firewalls/${firewallId}`, { method: 'DELETE' });
        } catch {
          // Best effort cleanup
        }
      }

      if (serverId) {
        try {
          await hzFetch(`/servers/${serverId}`, { method: 'DELETE' });
        } catch {
          // Best effort cleanup
        }
      }

      if (serverId) {
        try {
          await waitForResourceGone(`/servers/${serverId}`);
        } catch {
          // Best effort cleanup
        }
      }

      if (volumeId) {
        try {
          await hzFetch(`/volumes/${volumeId}`, { method: 'DELETE' });
        } catch {
          // Best effort cleanup
        }
      }
    }

    if (hostname && HAS_DNS_CREDENTIALS) {
      try {
        await cleanupDnsRecord(CLOUDFLARE_ZONE_ID, CLOUDFLARE_DNS_TOKEN, hostname);
      } catch {
        // Best effort cleanup
      }
    }
  }, 180_000);

  it('should validate the Hetzner API token', async () => {
    const resp = await hzFetch('/locations?per_page=1');
    expect(resp.status).toBe(200);
    const body = await resp.json() as { locations?: Array<{ id: number }> };
    expect((body.locations ?? []).length).toBeGreaterThan(0);
  }, 15_000);

  it('should create a volume', async () => {
    const resp = await hzFetch('/volumes', {
      method: 'POST',
      body: JSON.stringify({
        name: volumeName,
        location: LOCATION,
        size: VOLUME_SIZE_GB,
        format: 'ext4',
        automount: false,
      }),
    });

    expect([200, 201, 202]).toContain(resp.status);
    const body = await resp.json() as { volume: { id: number } };
    volumeId = body.volume.id;
    expect(volumeId).toBeGreaterThan(0);
  }, 30_000);

  it('should generate cloud-init config', () => {
    if (!volumeId) {
      throw new Error('Volume must be created before cloud-init generation.');
    }

    const volumeDevice = `/dev/disk/by-id/scsi-0HC_Volume_${volumeId}`;

    if (HAS_DNS_CREDENTIALS) {
      cloudInit = generateCloudInit({
        hostname,
        cloudToken,
        volumeDevice,
        needsDockerInstall: true,
        cloudflareZoneId: CLOUDFLARE_ZONE_ID,
        cloudflareDnsToken: CLOUDFLARE_DNS_TOKEN,
      });
      expect(cloudInit).toContain(hostname);
    } else {
      cloudInit = generateCloudInit({
        hostname,
        cloudToken,
        volumeDevice,
        needsDockerInstall: true,
        cloudflareZoneId: '00000000000000000000000000000000',
        cloudflareDnsToken: 'placeholder-token-dns-will-not-register',
      });
    }

    expect(cloudInit).toContain('#cloud-config');
    expect(cloudInit).toContain(cloudToken);
  });

  it('should create a server with cloud-init user_data', async () => {
    if (!volumeId) {
      throw new Error('Volume must be created before server creation.');
    }
    if (!cloudInit) {
      throw new Error('Cloud-init must be generated before server creation.');
    }

    const resp = await hzFetch('/servers', {
      method: 'POST',
      body: JSON.stringify({
        name: `rebel-cloud-${suffix}`,
        server_type: SERVER_TYPE,
        image: SERVER_IMAGE,
        location: LOCATION,
        user_data: cloudInit,
        volumes: [volumeId],
        labels: { app: 'rebel-cloud', purpose: 'integration-test' },
      }),
    });

    expect([200, 201, 202]).toContain(resp.status);
    const body = await resp.json() as { server: { id: number } };
    serverId = body.server.id;
    expect(serverId).toBeGreaterThan(0);
  }, 60_000);

  it('should wait for server to become running with a public IP', async () => {
    if (!serverId) {
      throw new Error('Server must be created before waiting for active state.');
    }

    const publicIp = await waitForServerActive(serverId);
    expect(publicIp).toMatch(/\d+\.\d+\.\d+\.\d+/);
    _serverIp = publicIp;
  }, 150_000);

  it('should create and attach a firewall allowing inbound 80/443', async () => {
    if (!serverId) {
      throw new Error('Server must be created before firewall creation.');
    }

    const createResp = await hzFetch('/firewalls', {
      method: 'POST',
      body: JSON.stringify({
        name: `rebel-cloud-${suffix}`,
        labels: { app: 'rebel-cloud', purpose: 'integration-test' },
        rules: [
          { direction: 'in', protocol: 'tcp', port: '80', source_ips: ['0.0.0.0/0', '::/0'] },
          { direction: 'in', protocol: 'tcp', port: '443', source_ips: ['0.0.0.0/0', '::/0'] },
          { direction: 'out', protocol: 'tcp', port: '1-65535', destination_ips: ['0.0.0.0/0', '::/0'] },
          { direction: 'out', protocol: 'udp', port: '1-65535', destination_ips: ['0.0.0.0/0', '::/0'] },
          { direction: 'out', protocol: 'icmp', destination_ips: ['0.0.0.0/0', '::/0'] },
        ],
      }),
    });

    expect([200, 201, 202]).toContain(createResp.status);
    const createBody = await createResp.json() as { firewall: { id: number } };
    firewallId = createBody.firewall.id;
    expect(firewallId).toBeGreaterThan(0);

    const applyResp = await hzFetch(`/firewalls/${firewallId}/actions/apply_to_resources`, {
      method: 'POST',
      body: JSON.stringify({
        apply_to: [{ type: 'server', server: { id: serverId } }],
      }),
    });
    expect([200, 201, 202]).toContain(applyResp.status);
  }, 45_000);

  it('should become healthy on /api/health', async () => {
    if (!HAS_DNS_CREDENTIALS) {
      return;
    }
    await waitForHealth(hostname);
  }, 320_000);

  it('should allow auth on GET /api/settings', async () => {
    if (!HAS_DNS_CREDENTIALS) {
      return;
    }
    const resp = await fetch(`https://${hostname}/api/settings`, {
      headers: { Authorization: `Bearer ${cloudToken}` },
      signal: AbortSignal.timeout(10_000),
    });
    expect(resp.status).toBe(200);
  }, 15_000);

  it('should deprovision firewall, server, and volume in order', async () => {
    if (firewallId) {
      const fwDeleteResp = await hzFetch(`/firewalls/${firewallId}`, { method: 'DELETE' });
      expect([204, 404]).toContain(fwDeleteResp.status);
    }

    if (!serverId) {
      throw new Error('Server ID missing during deprovision.');
    }
    const serverDeleteResp = await hzFetch(`/servers/${serverId}`, { method: 'DELETE' });
    expect([204, 404]).toContain(serverDeleteResp.status);
    await waitForResourceGone(`/servers/${serverId}`);

    if (!volumeId) {
      throw new Error('Volume ID missing during deprovision.');
    }
    const volumeDeleteResp = await hzFetch(`/volumes/${volumeId}`, { method: 'DELETE' });
    expect([204, 404]).toContain(volumeDeleteResp.status);
  }, 180_000);

  it('should verify all resources are gone', async () => {
    if (firewallId) {
      await waitForResourceGone(`/firewalls/${firewallId}`);
    }
    if (serverId) {
      await waitForResourceGone(`/servers/${serverId}`);
    }
    if (volumeId) {
      await waitForResourceGone(`/volumes/${volumeId}`);
    }

    deprovisioned = true;
  }, 150_000);
});
