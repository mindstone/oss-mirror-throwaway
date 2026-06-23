/**
 * Hetzner Cloud Provider
 *
 * Implements CloudProvider interface for Hetzner Cloud servers.
 * Provisioning creates a Volume + Server (with cloud-init) + Firewall.
 * DNS registration handled by the VM itself during cloud-init boot.
 *
 * Cheapest option: cx22 (2 vCPU, 4 GB) at ~EUR 5.39/mo.
 */

import { createScopedLogger } from '@core/logger';
import { randomBytes } from 'crypto';
import { generateCloudInit } from '../cloudInitTemplate';
import { DEFAULT_VOLUME_SIZE_GB } from './volumeDefaults';
import type {
  CloudProvider,
  CloudProvisionOptions,
  CloudProvisionResult,
  CloudProvisionStep,
  CloudDeprovisionResult,
  CloudStatusResult,
} from './types';

const log = createScopedLogger({ service: 'hetzner-provider' });

const HZ_API_BASE = 'https://api.hetzner.cloud/v1';
const DEFAULT_LOCATION = 'fsn1';
const SERVER_TYPE = 'cx22';
const SERVER_IMAGE = 'ubuntu-24.04';
const VOLUME_NAME_PREFIX = 'rebel-data-';
const HEALTH_POLL_TIMEOUT_MS = 300_000;
const HEALTH_POLL_INTERVAL_MS = 5_000;
const SERVER_POLL_TIMEOUT_MS = 120_000;
const SERVER_POLL_INTERVAL_MS = 3_000;

async function hzFetch(
  token: string,
  path: string,
  options: RequestInit = {},
): Promise<Response> {
  return fetch(`${HZ_API_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
    signal: options.signal ?? AbortSignal.timeout(30_000),
  });
}

interface CreatedResources {
  volumeId?: number;
  serverId?: number;
  firewallId?: number;
}

async function cleanupResources(token: string, resources: CreatedResources): Promise<boolean> {
  let success = true;
  try {
    if (resources.firewallId) {
      const resp = await hzFetch(token, `/firewalls/${resources.firewallId}`, { method: 'DELETE' });
      if (!resp.ok && resp.status !== 404) success = false;
    }
    if (resources.serverId) {
      const resp = await hzFetch(token, `/servers/${resources.serverId}`, { method: 'DELETE' });
      if (!resp.ok && resp.status !== 404) success = false;
      if (resp.ok && resources.volumeId) {
        await waitForServerGone(token, resources.serverId);
      }
    }
    if (resources.volumeId) {
      const resp = await hzFetch(token, `/volumes/${resources.volumeId}`, { method: 'DELETE' });
      if (!resp.ok && resp.status !== 404) success = false;
    }
  } catch (err) {
    log.error({ err }, 'Error during resource cleanup');
    success = false;
  }
  return success;
}

async function waitForServerGone(token: string, serverId: number): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const resp = await hzFetch(token, `/servers/${serverId}`);
    if (resp.status === 404) return;
    await new Promise((r) => setTimeout(r, 3_000));
  }
}

export const hetznerProvider: CloudProvider = {
  config: {
    id: 'hetzner',
    name: 'Hetzner Cloud',
    authType: 'pat',
  },

  async provision(opts: CloudProvisionOptions): Promise<CloudProvisionResult> {
    const { token, region: location = DEFAULT_LOCATION, onProgress } = opts;
    const volumeSizeGb = opts.volumeSizeGb ?? DEFAULT_VOLUME_SIZE_GB;
    const created: CreatedResources = {};
    let currentStep = 0;

    const progress = (phase: CloudProvisionStep['phase'], message: string, pct: number) => {
      onProgress?.({ phase, message, progress: pct });
    };

    const cloudflareZoneId = opts.cloudflareZoneId;
    const cloudflareDnsToken = opts.cloudflareDnsToken;
    if (!cloudflareZoneId || !cloudflareDnsToken) {
      return { success: false, error: 'Cloudflare credentials required for DNS setup', failedStep: 0 };
    }

    try {
      // Step 1: Validate token (lightweight endpoint)
      currentStep = 1;
      progress('validating', 'Validating your Hetzner Cloud token...', 5);
      const validateResp = await hzFetch(token, '/locations?per_page=1');
      if (validateResp.status === 401) {
        return { success: false, error: 'Invalid Hetzner Cloud token. Generate one at console.hetzner.cloud → Security → API Tokens', failedStep: 1 };
      }
      if (!validateResp.ok) {
        const body = await validateResp.text();
        return { success: false, error: `Token validation failed: ${body}`, failedStep: 1 };
      }
      log.info('Hetzner token validated');

      // Step 2: Generate identifiers
      currentStep = 2;
      const suffix = randomBytes(4).toString('hex');
      const cloudToken = randomBytes(32).toString('hex');
      const volumeName = `${VOLUME_NAME_PREFIX}${suffix}`;
      const hostname = `${suffix}.cloud.mindstone.com`;

      // Step 3: Create volume
      currentStep = 3;
      progress('creating-volume', `Creating ${volumeSizeGb}GB storage volume...`, 20);
      const volumeResp = await hzFetch(token, '/volumes', {
        method: 'POST',
        body: JSON.stringify({
          size: volumeSizeGb,
          name: volumeName,
          location,
          format: 'ext4',
          labels: { app: 'rebel-cloud' },
        }),
      });
      if (!volumeResp.ok) {
        const body = await volumeResp.text();
        return { success: false, error: `Failed to create volume: ${body}`, failedStep: 3 };
      }
      const volumeData = (await volumeResp.json()) as {
        volume: { id: number; linux_device: string };
      };
      created.volumeId = volumeData.volume.id;
      const volumeDevice = volumeData.volume.linux_device;
      if (!volumeDevice) {
        const cleanedUp = await cleanupResources(token, created);
        return { success: false, error: 'Volume created but missing device path', failedStep: 3, cleanedUp };
      }
      log.info({ volumeId: created.volumeId, volumeName, location, volumeDevice }, 'Volume created');

      // Step 4: Generate cloud-init
      currentStep = 4;
      progress('creating-machine', 'Preparing cloud configuration...', 25);
      const userData = generateCloudInit({
        hostname,
        cloudToken,
        volumeDevice,
        needsDockerInstall: true,
        cloudflareZoneId,
        cloudflareDnsToken,
        sentryDsn: opts.sentryDsn,
      });

      // Step 5: Create server with cloud-init + volume
      currentStep = 5;
      progress('creating-machine', 'Launching Hetzner Cloud server...', 40);
      const serverResp = await hzFetch(token, '/servers', {
        method: 'POST',
        body: JSON.stringify({
          name: `rebel-cloud-${suffix}`,
          server_type: SERVER_TYPE,
          image: SERVER_IMAGE,
          location,
          volumes: [created.volumeId],
          user_data: userData,
          labels: { app: 'rebel-cloud' },
        }),
      });
      if (!serverResp.ok) {
        const body = await serverResp.text();
        log.error({ status: serverResp.status, body }, 'Failed to create server');
        const cleanedUp = await cleanupResources(token, created);
        return { success: false, error: `Failed to create server: ${body}`, failedStep: 5, cleanedUp };
      }
      const serverData = (await serverResp.json()) as { server: { id: number } };
      created.serverId = serverData.server.id;
      log.info({ serverId: created.serverId }, 'Server created');

      // Step 6: Poll server until running, get public IP
      currentStep = 6;
      progress('waiting', 'Waiting for server to become ready...', 55);
      let publicIp: string | undefined;
      const serverDeadline = Date.now() + SERVER_POLL_TIMEOUT_MS;
      while (Date.now() < serverDeadline) {
        const statusResp = await hzFetch(token, `/servers/${created.serverId}`);
        if (statusResp.ok) {
          const data = (await statusResp.json()) as {
            server: {
              status: string;
              public_net: { ipv4: { ip: string } };
            };
          };
          if (data.server.status === 'running') {
            publicIp = data.server.public_net.ipv4.ip;
            break;
          }
        }
        await new Promise((r) => setTimeout(r, SERVER_POLL_INTERVAL_MS));
      }
      if (!publicIp) {
        log.error({ serverId: created.serverId }, 'Server did not become ready or has no public IP');
        const cleanedUp = await cleanupResources(token, created);
        return { success: false, error: 'Server did not become ready in time', failedStep: 6, cleanedUp };
      }
      log.info({ serverId: created.serverId, publicIp }, 'Server running');

      // Step 7: Create firewall
      currentStep = 7;
      progress('waiting', 'Configuring firewall...', 65);
      const fwResp = await hzFetch(token, '/firewalls', {
        method: 'POST',
        body: JSON.stringify({
          name: `rebel-cloud-${suffix}`,
          labels: { app: 'rebel-cloud' },
          rules: [
            { direction: 'in', protocol: 'tcp', port: '80', source_ips: ['0.0.0.0/0', '::/0'] },
            { direction: 'in', protocol: 'tcp', port: '443', source_ips: ['0.0.0.0/0', '::/0'] },
            { direction: 'out', protocol: 'tcp', port: '1-65535', destination_ips: ['0.0.0.0/0', '::/0'] },
            { direction: 'out', protocol: 'udp', port: '1-65535', destination_ips: ['0.0.0.0/0', '::/0'] },
            { direction: 'out', protocol: 'icmp', destination_ips: ['0.0.0.0/0', '::/0'] },
          ],
          apply_to: [{ type: 'server', server: { id: created.serverId } }],
        }),
      });
      if (!fwResp.ok) {
        log.warn({ status: fwResp.status }, 'Failed to create firewall -- continuing without it');
      } else {
        const fwData = (await fwResp.json()) as { firewall: { id: number } };
        created.firewallId = fwData.firewall.id;
        log.info({ firewallId: created.firewallId }, 'Firewall created');
      }

      // Step 8: Poll health endpoint
      currentStep = 8;
      progress('health-check', 'Waiting for cloud service to start (DNS + HTTPS setup)...', 75);
      const cloudUrl = `https://${hostname}`;
      const healthDeadline = Date.now() + HEALTH_POLL_TIMEOUT_MS;
      let healthy = false;
      let lastHealthFailure: 'dns' | 'cert' | 'http' | 'unknown' = 'unknown';
      while (Date.now() < healthDeadline) {
        try {
          const healthResp = await fetch(`${cloudUrl}/api/health`, {
            signal: AbortSignal.timeout(5_000),
          });
          if (healthResp.ok) {
            healthy = true;
            break;
          }
          lastHealthFailure = 'http';
        } catch (healthErr) {
          const msg = healthErr instanceof Error ? healthErr.message : '';
          if (/ENOTFOUND|getaddrinfo/.test(msg)) {
            lastHealthFailure = 'dns';
          } else if (/cert|ssl|tls|ERR_TLS/i.test(msg)) {
            lastHealthFailure = 'cert';
          } else {
            lastHealthFailure = lastHealthFailure === 'unknown' ? 'dns' : lastHealthFailure;
          }
        }
        await new Promise((r) => setTimeout(r, HEALTH_POLL_INTERVAL_MS));
      }

      if (!healthy) {
        log.error({ hostname, lastHealthFailure }, 'Cloud service health check timed out');
        const cleanedUp = await cleanupResources(token, created);
        const markerMap = {
          dns: '[cloud:dns_resolution_failed]',
          cert: '[cloud:cert_issuance_failed]',
          http: '[cloud:service_boot_failed]',
          unknown: '[cloud:dns_timeout]',
        } as const;
        const marker = markerMap[lastHealthFailure];
        return { success: false, error: `${marker} Cloud service did not become healthy.`, failedStep: 8, cleanedUp };
      }

      // Step 9: Complete
      progress('complete', 'Hetzner Cloud instance is ready', 100);
      log.info({ hostname, serverId: created.serverId }, 'Hetzner provisioning complete');

      return {
        success: true,
        cloudUrl,
        cloudToken,
        instanceId: String(created.serverId),
        volumeId: String(created.volumeId),
        region: location,
        providerMetadata: {
          serverId: String(created.serverId),
          volumeId: String(created.volumeId ?? ''),
          ...(created.firewallId ? { firewallId: String(created.firewallId) } : {}),
          volumeName,
          hostname,
        },
      };
    } catch (err) {
      log.error({ err, step: currentStep }, 'Hetzner provisioning failed');
      const cleanedUp = await cleanupResources(token, created);
      return {
        success: false,
        error: (err as Error).message,
        failedStep: currentStep,
        cleanedUp,
      };
    }
  },

  async deprovision(
    token: string,
    instanceId: string,
    metadata?: Record<string, string>,
  ): Promise<CloudDeprovisionResult> {
    const serverId = metadata?.serverId ?? instanceId;
    const volumeId = metadata?.volumeId;
    const firewallId = metadata?.firewallId;
    const hostname = metadata?.hostname;

    // Step 1: DNS cleanup via cloud-service (best-effort)
    if (hostname) {
      try {
        const cloudUrl = `https://${hostname}`;
        const cloudToken = metadata?.cloudToken;
        if (cloudToken) {
          await fetch(`${cloudUrl}/api/admin/dns/cleanup`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${cloudToken}` },
            signal: AbortSignal.timeout(10_000),
          });
        }
      } catch {
        log.warn({ hostname }, 'DNS cleanup via cloud-service failed -- record may be orphaned');
      }
    }

    // Step 2: Delete firewall (best-effort, 404 = success)
    if (firewallId) {
      try {
        const resp = await hzFetch(token, `/firewalls/${firewallId}`, { method: 'DELETE' });
        if (!resp.ok && resp.status !== 404) {
          log.warn({ firewallId, status: resp.status }, 'Failed to delete firewall');
        }
      } catch (err) {
        log.warn({ err, firewallId }, 'Firewall deletion error');
      }
    }

    // Step 3: Delete server
    try {
      const resp = await hzFetch(token, `/servers/${serverId}`, { method: 'DELETE' });
      if (!resp.ok && resp.status !== 404) {
        const body = await resp.text();
        return { success: false, error: `Failed to delete server: ${body}` };
      }
    } catch (err) {
      return { success: false, error: `Server deletion failed: ${(err as Error).message}` };
    }

    // Step 4: Wait for server gone, then delete volume
    if (volumeId) {
      try {
        await waitForServerGone(token, Number(serverId));
      } catch (err) {
        log.warn({ err }, 'Server-gone polling failed -- attempting volume delete anyway');
      }

      try {
        const resp = await hzFetch(token, `/volumes/${volumeId}`, { method: 'DELETE' });
        if (!resp.ok && resp.status !== 404) {
          log.warn({ volumeId, status: resp.status }, 'Failed to delete volume -- may need manual cleanup');
        }
      } catch (err) {
        log.warn({ err, volumeId }, 'Volume deletion error');
      }
    }

    return { success: true };
  },

  async getStatus(
    token: string,
    instanceId: string,
  ): Promise<CloudStatusResult> {
    try {
      const resp = await hzFetch(token, `/servers/${instanceId}`);
      if (resp.status === 404) {
        return { state: 'unknown', error: 'Server not found' };
      }
      if (!resp.ok) {
        return { state: 'unknown', error: `HTTP ${resp.status}` };
      }
      const data = (await resp.json()) as { server: { status: string } };
      const statusMap: Record<string, string> = {
        running: 'started',
        off: 'stopped',
        initializing: 'starting',
        starting: 'starting',
        stopping: 'stopping',
        migrating: 'started',
        rebuilding: 'starting',
        deleting: 'stopping',
      };
      return { state: statusMap[data.server.status] ?? 'unknown' };
    } catch (err) {
      return { state: 'unknown', error: (err as Error).message };
    }
  },
};
