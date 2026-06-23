import { randomBytes } from 'crypto';
import fs from 'fs';
import path from 'path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { generateCloudInit } from '../cloud/cloudInitTemplate';
import { DEFAULT_VOLUME_SIZE_GB } from '../cloud/providers/volumeDefaults';
/* eslint-disable no-console -- integration test diagnostic output */

function readClaudeApiKey(): string | null {
  if (process.env.TEST_CLAUDE_API_KEY) return process.env.TEST_CLAUDE_API_KEY;
  const settingsPath = path.join(
    process.env.HOME || '',
    'Library',
    'Application Support',
    'mindstone-rebel',
    'app-settings.json',
  );
  try {
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as { claude?: { apiKey?: string } };
    // SKIP-GATE-INTENT: cloud-provisioning integration test reads the persisted Anthropic API key as a fallback only; this test casts to a minimal local shape rather than depending on @core/rebelCore/settingsAccessors and never reaches the model-resolution path the 260507 hazard guards.
    return settings?.claude?.apiKey ?? null;
  } catch {
    return null;
  }
}

const SHOULD_RUN = process.env.RUN_DO_INTEGRATION_TESTS === '1';
const DO_API_TOKEN = process.env.DO_API_TOKEN ?? '';
const CLOUDFLARE_ZONE_ID = process.env.CLOUDFLARE_ZONE_ID ?? '';
const CLOUDFLARE_DNS_TOKEN = process.env.CLOUDFLARE_DNS_TOKEN ?? '';
const HAS_DNS_CREDENTIALS = Boolean(CLOUDFLARE_ZONE_ID && CLOUDFLARE_DNS_TOKEN);
const HAS_PREREQUISITES = Boolean(DO_API_TOKEN);

const DO_API_BASE = 'https://api.digitalocean.com/v2';
const REGION = 'nyc1';
const DROPLET_SIZE = 's-2vcpu-4gb';
const DROPLET_IMAGE = 'ubuntu-24-04-x64';
const VOLUME_SIZE_GB = DEFAULT_VOLUME_SIZE_GB;
const HEALTH_POLL_TIMEOUT_MS = 900_000; // 15 min — cloud-init: apt install Docker + pull ~1 GB image
const RESOURCE_POLL_TIMEOUT_MS = 120_000;
const POLL_INTERVAL_MS = 3_000;

async function doFetch(path: string, options: RequestInit = {}): Promise<Response> {
  return fetch(`${DO_API_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${DO_API_TOKEN}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
    signal: options.signal ?? AbortSignal.timeout(30_000),
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForDropletActive(dropletId: number): Promise<string> {
  const deadline = Date.now() + RESOURCE_POLL_TIMEOUT_MS;
  let lastStatus = 'unknown';

  while (Date.now() < deadline) {
    const resp = await doFetch(`/droplets/${dropletId}`);
    if (resp.ok) {
      const body = await resp.json() as {
        droplet: {
          status: string;
          networks: { v4: Array<{ ip_address: string; type: string }> };
        };
      };
      lastStatus = body.droplet.status;
      if (body.droplet.status === 'active') {
        const publicNetwork = body.droplet.networks.v4.find((network) => network.type === 'public');
        if (publicNetwork?.ip_address) {
          return publicNetwork.ip_address;
        }
      }
    }

    await sleep(POLL_INTERVAL_MS);
  }

  throw new Error(`Droplet ${dropletId} did not become active with a public IP (last status: ${lastStatus}).`);
}

async function waitForHealth(target: string): Promise<void> {
  const deadline = Date.now() + HEALTH_POLL_TIMEOUT_MS;
  let lastError = 'no response';
  let attempts = 0;
  const healthUrl = `http://${target}/api/health`;

  while (Date.now() < deadline) {
    attempts++;
    try {
      const resp = await fetch(healthUrl, {
        signal: AbortSignal.timeout(5_000),
      });
      if (resp.ok) {
        const body = await resp.json() as { status?: string };
        if (body.status === 'ok') {
          console.log(`Health OK after ${attempts} attempts (${Math.round((Date.now() - deadline + HEALTH_POLL_TIMEOUT_MS) / 1000)}s)`);
          return;
        }
        lastError = `Unexpected health payload: ${JSON.stringify(body)}`;
      } else {
        lastError = `HTTP ${resp.status}`;
      }
    } catch (error) {
      const msg = error instanceof Error ? (error.cause as { code?: string })?.code ?? error.message : String(error);
      if (msg !== lastError) {
        const elapsed = Math.round((Date.now() - deadline + HEALTH_POLL_TIMEOUT_MS) / 1000);
        console.log(`[health ${elapsed}s] ${msg}`);
        lastError = msg;
      }
    }

    // Every 60s, probe other ports for diagnostics
    if (attempts % 12 === 0) {
      const ip = target.split(':')[0];
      const probes = await Promise.allSettled([
        fetch(`http://${ip}:22/`, { signal: AbortSignal.timeout(2000) }).then(r => `HTTP ${r.status}`),
        fetch(`http://${ip}:80/`, { signal: AbortSignal.timeout(2000) }).then(r => `HTTP ${r.status}`),
      ]);
      const ssh = probes[0].status === 'fulfilled' ? probes[0].value : (probes[0].reason?.cause?.code ?? 'unreachable');
      const http = probes[1].status === 'fulfilled' ? probes[1].value : (probes[1].reason?.cause?.code ?? 'unreachable');
      const elapsed = Math.round((Date.now() - deadline + HEALTH_POLL_TIMEOUT_MS) / 1000);
      console.log(`[diag ${elapsed}s] ssh:22=${ssh} http:80=${http} service:8080=${lastError}`);
    }

    await sleep(5_000);
  }

  throw new Error(`Health check failed for ${target} after ${attempts} attempts: ${lastError}`);
}

async function waitForResourceGone(path: string): Promise<void> {
  const deadline = Date.now() + RESOURCE_POLL_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const resp = await doFetch(path);
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

describe.skipIf(!SHOULD_RUN || !HAS_PREREQUISITES)('DigitalOcean Provisioning Integration Tests', () => {
  let suffix = '';
  let hostname = '';
  let dropletIp = '';
  let cloudToken = '';
  let volumeName = '';
  let volumeId: string | undefined;
  let dropletId: number | undefined;
  let firewallId: string | undefined;
  let cloudInit = '';
  let deprovisioned = false;
  let sessionIdFromTurn: string | null = null;

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
          await doFetch(`/firewalls/${firewallId}`, { method: 'DELETE' });
        } catch {
          // Best effort cleanup
        }
      }

      if (dropletId) {
        try {
          await doFetch(`/droplets/${dropletId}`, { method: 'DELETE' });
        } catch {
          // Best effort cleanup
        }
      }

      if (dropletId) {
        try {
          await waitForResourceGone(`/droplets/${dropletId}`);
        } catch {
          // Best effort cleanup
        }
      }

      if (volumeId) {
        try {
          await doFetch(`/volumes/${volumeId}`, { method: 'DELETE' });
        } catch {
          // Best effort cleanup
        }
      }
    }

    if (hostname && HAS_DNS_CREDENTIALS && CLOUDFLARE_ZONE_ID && CLOUDFLARE_DNS_TOKEN) {
      try {
        await cleanupDnsRecord(CLOUDFLARE_ZONE_ID, CLOUDFLARE_DNS_TOKEN, hostname);
      } catch {
        // Best effort cleanup
      }
    }
  }, 180_000);

  it('should validate the DigitalOcean API token', async () => {
    const resp = await doFetch('/account');
    expect(resp.status).toBe(200);
    const body = await resp.json() as { account?: { uuid?: string } };
    expect(body.account?.uuid).toBeTruthy();
  }, 15_000);

  it('should create a volume', async () => {
    const resp = await doFetch('/volumes', {
      method: 'POST',
      body: JSON.stringify({
        name: volumeName,
        region: REGION,
        size_gigabytes: VOLUME_SIZE_GB,
        filesystem_type: 'ext4',
        description: 'Rebel cloud integration test volume',
      }),
    });

    expect([200, 201, 202]).toContain(resp.status);
    const body = await resp.json() as { volume: { id: string } };
    volumeId = body.volume.id;
    expect(volumeId).toBeTruthy();
  }, 30_000);

  it('should generate cloud-init config', () => {
    const volumeDevice = `/dev/disk/by-id/scsi-0DO_Volume_${volumeName}`;

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
      // Without DNS credentials, generate a minimal cloud-init that skips DNS registration
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

  it('should create a droplet with cloud-init user_data', async () => {
    if (!volumeId) {
      throw new Error('Volume must be created before droplet creation.');
    }
    if (!cloudInit) {
      throw new Error('Cloud-init must be generated before droplet creation.');
    }

    const resp = await doFetch('/droplets', {
      method: 'POST',
      body: JSON.stringify({
        name: `rebel-cloud-${suffix}`,
        region: REGION,
        size: DROPLET_SIZE,
        image: DROPLET_IMAGE,
        user_data: cloudInit,
        volumes: [volumeId],
        tags: ['rebel-cloud', 'integration-test'],
      }),
    });

    expect([200, 201, 202]).toContain(resp.status);
    const body = await resp.json() as { droplet: { id: number } };
    dropletId = body.droplet.id;
    expect(dropletId).toBeGreaterThan(0);
  }, 60_000);

  it('should wait for droplet to become active with a public IP', async () => {
    if (!dropletId) {
      throw new Error('Droplet must be created before waiting for active state.');
    }

    const publicIp = await waitForDropletActive(dropletId);
    expect(publicIp).toMatch(/\d+\.\d+\.\d+\.\d+/);
    dropletIp = publicIp;
  }, 150_000);

  it('should become healthy on /api/health', async () => {
    // Hit cloud-service directly on port 8080 (HTTP) — no DNS/TLS needed.
    // DO droplets are fully open until a firewall is attached, so the service
    // is reachable as soon as cloud-init finishes installing Docker + pulling the image.
    await waitForHealth(`${dropletIp}:8080`);
  }, 920_000);

  it('should allow auth on GET /api/settings', async () => {
    const resp = await fetch(`http://${dropletIp}:8080/api/settings`, {
      headers: { Authorization: `Bearer ${cloudToken}` },
      signal: AbortSignal.timeout(10_000),
    });
    expect(resp.status).toBe(200);
  }, 15_000);

  it('should run an agent turn via websocket', async () => {
    const claudeApiKey = readClaudeApiKey();
    if (!claudeApiKey) {
      console.log('Skipping WS agent turn: no Claude API key found (set TEST_CLAUDE_API_KEY or have app-settings.json).');
      return;
    }

    const baseUrl = `http://${dropletIp}:8080`;

    // Inject Claude API key into cloud service settings
    const settingsResp = await fetch(`${baseUrl}/api/settings`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${cloudToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ claude: { apiKey: claudeApiKey } }),
      signal: AbortSignal.timeout(30_000),
    });
    expect(settingsResp.status).toBe(200);

     
    const WebSocket = require('ws');
    const ws = new WebSocket(`ws://${dropletIp}:8080/api/agent/turn`, {
      headers: { Authorization: `Bearer ${cloudToken}` },
    });

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('WS connect timeout')), 15_000);
      ws.on('open', () => { clearTimeout(timeout); resolve(); });
      ws.on('error', (err: Error) => { clearTimeout(timeout); reject(err); });
    });

    sessionIdFromTurn = `do-vertical-${Date.now()}`;
    const events: Array<{ type?: string; text?: string; error?: string }> = [];

    ws.send(JSON.stringify({
      sessionId: sessionIdFromTurn,
      prompt: 'Reply with exactly the word "cloud" and nothing else',
    }));

    const terminalEvent = await new Promise<{ type?: string; text?: string; error?: string }>((resolve, reject) => {
      const timeout = setTimeout(() => {
        ws.close();
        reject(new Error(`Turn timed out. Events: ${events.map((e) => e.type).join(', ')}`));
      }, 60_000);

      ws.on('message', (data: Buffer) => {
        const event = JSON.parse(data.toString()) as { type?: string; text?: string; error?: string };
        events.push(event);
        if (event.type === 'result' || event.type === 'error') {
          clearTimeout(timeout);
          resolve(event);
        }
      });

      ws.on('error', (err: Error) => { clearTimeout(timeout); reject(err); });
    });

    if (ws.readyState === WebSocket.OPEN) ws.close();

    expect(terminalEvent.type).toBe('result');
    const responseText = events
      .map((e) => (typeof e.text === 'string' ? e.text : ''))
      .join(' ')
      .toLowerCase();
    expect(responseText).toContain('cloud');
  }, 90_000);

  it('should expose the session in summaries for cross-device visibility', async () => {
    if (!sessionIdFromTurn) {
      console.log('Skipping session visibility: agent turn did not run.');
      return;
    }

    // Session persistence may take a moment after the turn completes
    let sessionIds: string[] = [];
    for (let attempt = 0; attempt < 10; attempt++) {
      const resp = await fetch(`http://${dropletIp}:8080/api/sessions?summaries=true`, {
        headers: { Authorization: `Bearer ${cloudToken}` },
        signal: AbortSignal.timeout(30_000),
      });
      expect(resp.status).toBe(200);

      const body = await resp.json() as Array<{ id?: string }>;
      sessionIds = (Array.isArray(body) ? body : []).map((s) => s.id ?? '').filter(Boolean);
      if (sessionIds.includes(sessionIdFromTurn)) break;
      await sleep(2_000);
    }
    expect(sessionIds).toContain(sessionIdFromTurn);
  }, 60_000);

  it('should create a firewall allowing inbound 80/443/8080', async () => {
    if (!dropletId) {
      throw new Error('Droplet must be created before firewall creation.');
    }

    const resp = await doFetch('/firewalls', {
      method: 'POST',
      body: JSON.stringify({
        name: `rebel-cloud-${suffix}`,
        droplet_ids: [dropletId],
        inbound_rules: [
          { protocol: 'tcp', ports: '80', sources: { addresses: ['0.0.0.0/0', '::/0'] } },
          { protocol: 'tcp', ports: '443', sources: { addresses: ['0.0.0.0/0', '::/0'] } },
          { protocol: 'tcp', ports: '8080', sources: { addresses: ['0.0.0.0/0', '::/0'] } },
        ],
        outbound_rules: [
          { protocol: 'tcp', ports: 'all', destinations: { addresses: ['0.0.0.0/0', '::/0'] } },
          { protocol: 'udp', ports: 'all', destinations: { addresses: ['0.0.0.0/0', '::/0'] } },
        ],
      }),
    });

    expect([200, 201, 202]).toContain(resp.status);
    const body = await resp.json() as { firewall: { id: string } };
    firewallId = body.firewall.id;
    expect(firewallId).toBeTruthy();
  }, 30_000);

  it('should deprovision firewall, droplet, and volume in order', async () => {
    if (firewallId) {
      const fwDeleteResp = await doFetch(`/firewalls/${firewallId}`, { method: 'DELETE' });
      expect([204, 404]).toContain(fwDeleteResp.status);
    }

    if (!dropletId) {
      throw new Error('Droplet ID missing during deprovision.');
    }
    const dropletDeleteResp = await doFetch(`/droplets/${dropletId}`, { method: 'DELETE' });
    expect([204, 404]).toContain(dropletDeleteResp.status);
    await waitForResourceGone(`/droplets/${dropletId}`);

    if (!volumeId) {
      throw new Error('Volume ID missing during deprovision.');
    }
    const volumeDeleteResp = await doFetch(`/volumes/${volumeId}`, { method: 'DELETE' });
    expect([204, 404]).toContain(volumeDeleteResp.status);
  }, 180_000);

  it('should verify all resources are gone', async () => {
    if (firewallId) {
      await waitForResourceGone(`/firewalls/${firewallId}`);
    }
    if (dropletId) {
      await waitForResourceGone(`/droplets/${dropletId}`);
    }
    if (volumeId) {
      await waitForResourceGone(`/volumes/${volumeId}`);
    }

    deprovisioned = true;
  }, 150_000);
});
