/**
 * DigitalOcean Cloud Provider
 *
 * Implements CloudProvider interface for DigitalOcean Droplets.
 * Provisioning creates a Volume + Droplet (with cloud-init) + Firewall.
 * DNS registration handled by the VM itself during cloud-init boot.
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

const log = createScopedLogger({ service: 'do-provider' });

const DO_API_BASE = 'https://api.digitalocean.com/v2';
const DEFAULT_REGION = 'nyc1';
const DROPLET_SIZE = 's-2vcpu-4gb';
const DROPLET_IMAGE = 'ubuntu-24-04-x64';
const VOLUME_NAME_PREFIX = 'rebel-data-';
const HEALTH_POLL_TIMEOUT_MS = 300_000; // 5 min (cloud-init + cert issuance)
const HEALTH_POLL_INTERVAL_MS = 5_000;
const DROPLET_POLL_TIMEOUT_MS = 120_000;
const DROPLET_POLL_INTERVAL_MS = 3_000;

async function doFetch(
  token: string,
  path: string,
  options: RequestInit = {},
): Promise<Response> {
  return fetch(`${DO_API_BASE}${path}`, {
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
  volumeId?: string;
  dropletId?: number;
  firewallId?: string;
}

async function cleanupResources(token: string, resources: CreatedResources): Promise<boolean> {
  let success = true;
  try {
    if (resources.firewallId) {
      const resp = await doFetch(token, `/firewalls/${resources.firewallId}`, { method: 'DELETE' });
      if (!resp.ok && resp.status !== 404) success = false;
    }
    if (resources.dropletId) {
      const resp = await doFetch(token, `/droplets/${resources.dropletId}`, { method: 'DELETE' });
      if (!resp.ok && resp.status !== 404) success = false;
      if (resp.ok && resources.volumeId) {
        await waitForDropletGone(token, resources.dropletId);
      }
    }
    if (resources.volumeId) {
      const resp = await doFetch(token, `/volumes/${resources.volumeId}`, { method: 'DELETE' });
      if (!resp.ok && resp.status !== 404) success = false;
    }
  } catch (err) {
    log.error({ err }, 'Error during resource cleanup');
    success = false;
  }
  return success;
}

async function waitForDropletGone(token: string, dropletId: number): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const resp = await doFetch(token, `/droplets/${dropletId}`);
    if (resp.status === 404) return;
    await new Promise((r) => setTimeout(r, 3_000));
  }
}

export const digitalOceanProvider: CloudProvider = {
  config: {
    id: 'digitalocean',
    name: 'DigitalOcean',
    authType: 'oauth',
  },

  async provision(opts: CloudProvisionOptions): Promise<CloudProvisionResult> {
    const { token, region = DEFAULT_REGION, onProgress } = opts;
    const volumeSizeGb = opts.volumeSizeGb ?? DEFAULT_VOLUME_SIZE_GB;
    const created: CreatedResources = {};
    let currentStep = 0;

    const progress = (phase: CloudProvisionStep['phase'], message: string, pct: number) => {
      onProgress?.({ phase, message, progress: pct });
    };

    // Cloudflare credentials for DNS self-registration in cloud-init
    const cloudflareZoneId = opts.cloudflareZoneId;
    const cloudflareDnsToken = opts.cloudflareDnsToken;
    if (!cloudflareZoneId || !cloudflareDnsToken) {
      return { success: false, error: 'Cloudflare credentials required for DNS setup', failedStep: 0 };
    }

    try {
      // Step 1: Validate PAT
      currentStep = 1;
      progress('validating', 'Validating your DigitalOcean token...', 5);
      const accountResp = await doFetch(token, '/account');
      if (accountResp.status === 401) {
        return { success: false, error: 'Invalid DigitalOcean token. Generate one at cloud.digitalocean.com/account/api/tokens', failedStep: 1 };
      }
      if (!accountResp.ok) {
        const body = await accountResp.text();
        return { success: false, error: `Token validation failed: ${body}`, failedStep: 1 };
      }
      log.info('DO PAT validated');

      // Step 2: Generate identifiers
      currentStep = 2;
      const suffix = randomBytes(4).toString('hex');
      const cloudToken = randomBytes(32).toString('hex');
      const volumeName = `${VOLUME_NAME_PREFIX}${suffix}`;
      const hostname = `${suffix}.cloud.mindstone.com`;

      // Step 3: Create volume
      currentStep = 3;
      progress('creating-volume', `Creating ${volumeSizeGb}GB storage volume...`, 20);
      const volumeResp = await doFetch(token, '/volumes', {
        method: 'POST',
        body: JSON.stringify({
          size_gigabytes: volumeSizeGb,
          name: volumeName,
          region,
          filesystem_type: 'ext4',
          description: 'Rebel Cloud data volume',
        }),
      });
      if (!volumeResp.ok) {
        const body = await volumeResp.text();
        return { success: false, error: `Failed to create volume: ${body}`, failedStep: 3 };
      }
      const volumeData = (await volumeResp.json()) as { volume: { id: string } };
      created.volumeId = volumeData.volume.id;
      log.info({ volumeId: created.volumeId, volumeName, region }, 'Volume created');

      // Step 4: Generate cloud-init
      currentStep = 4;
      progress('creating-machine', 'Preparing cloud configuration...', 25);
      const volumeDevice = `/dev/disk/by-id/scsi-0DO_Volume_${volumeName}`;
      const userData = generateCloudInit({
        hostname,
        cloudToken,
        volumeDevice,
        needsDockerInstall: true,
        cloudflareZoneId,
        cloudflareDnsToken,
        sentryDsn: opts.sentryDsn,
      });

      // Step 5: Create Droplet
      currentStep = 5;
      progress('creating-machine', 'Launching DigitalOcean Droplet...', 40);
      const dropletResp = await doFetch(token, '/droplets', {
        method: 'POST',
        body: JSON.stringify({
          name: `rebel-cloud-${suffix}`,
          region,
          size: DROPLET_SIZE,
          image: DROPLET_IMAGE,
          volumes: [created.volumeId],
          user_data: userData,
          tags: ['rebel-cloud'],
        }),
      });
      if (!dropletResp.ok) {
        const body = await dropletResp.text();
        log.error({ status: dropletResp.status, body }, 'Failed to create Droplet');
        const cleanedUp = await cleanupResources(token, created);
        return { success: false, error: `Failed to create Droplet: ${body}`, failedStep: 5, cleanedUp };
      }
      const dropletData = (await dropletResp.json()) as { droplet: { id: number } };
      created.dropletId = dropletData.droplet.id;
      log.info({ dropletId: created.dropletId }, 'Droplet created');

      // Step 6: Poll Droplet until active, get public IP
      currentStep = 6;
      progress('waiting', 'Waiting for Droplet to become active...', 55);
      let publicIp: string | undefined;
      const dropletDeadline = Date.now() + DROPLET_POLL_TIMEOUT_MS;
      while (Date.now() < dropletDeadline) {
        const statusResp = await doFetch(token, `/droplets/${created.dropletId}`);
        if (statusResp.ok) {
          const data = (await statusResp.json()) as {
            droplet: {
              status: string;
              networks: { v4: Array<{ ip_address: string; type: string }> };
            };
          };
          if (data.droplet.status === 'active') {
            const pubNet = data.droplet.networks.v4.find((n) => n.type === 'public');
            publicIp = pubNet?.ip_address;
            break;
          }
        }
        await new Promise((r) => setTimeout(r, DROPLET_POLL_INTERVAL_MS));
      }
      if (!publicIp) {
        log.error({ dropletId: created.dropletId }, 'Droplet did not become active or has no public IP');
        const cleanedUp = await cleanupResources(token, created);
        return { success: false, error: 'Droplet did not become active in time', failedStep: 6, cleanedUp };
      }
      log.info({ dropletId: created.dropletId, publicIp }, 'Droplet active');

      // Step 7: Create firewall
      currentStep = 7;
      progress('waiting', 'Configuring firewall...', 65);
      const fwResp = await doFetch(token, '/firewalls', {
        method: 'POST',
        body: JSON.stringify({
          name: `rebel-cloud-${suffix}`,
          droplet_ids: [created.dropletId],
          inbound_rules: [
            { protocol: 'tcp', ports: '80', sources: { addresses: ['0.0.0.0/0', '::/0'] } },
            { protocol: 'tcp', ports: '443', sources: { addresses: ['0.0.0.0/0', '::/0'] } },
          ],
          outbound_rules: [
            { protocol: 'tcp', ports: 'all', destinations: { addresses: ['0.0.0.0/0', '::/0'] } },
            { protocol: 'udp', ports: 'all', destinations: { addresses: ['0.0.0.0/0', '::/0'] } },
            { protocol: 'icmp', ports: 'all', destinations: { addresses: ['0.0.0.0/0', '::/0'] } },
          ],
        }),
      });
      if (!fwResp.ok) {
        log.warn({ status: fwResp.status }, 'Failed to create firewall -- continuing without it');
      } else {
        const fwData = (await fwResp.json()) as { firewall: { id: string } };
        created.firewallId = fwData.firewall.id;
        log.info({ firewallId: created.firewallId }, 'Firewall created');
      }

      // Step 8-9: Poll health endpoint
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

      // Step 10: Complete
      progress('complete', 'DigitalOcean cloud instance is ready', 100);
      log.info({ hostname, dropletId: created.dropletId }, 'DO provisioning complete');

      return {
        success: true,
        cloudUrl,
        cloudToken,
        instanceId: String(created.dropletId),
        volumeId: created.volumeId,
        region,
        providerMetadata: {
          dropletId: String(created.dropletId),
          volumeId: created.volumeId ?? '',
          ...(created.firewallId ? { firewallId: created.firewallId } : {}),
          volumeName,
          hostname,
        },
      };
    } catch (err) {
      log.error({ err, step: currentStep }, 'DO provisioning failed');
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
    const dropletId = metadata?.dropletId ?? instanceId;
    const volumeId = metadata?.volumeId;
    const firewallId = metadata?.firewallId;
    const hostname = metadata?.hostname;

    // Step 1: DNS cleanup via cloud-service (best-effort)
    if (hostname) {
      try {
        // Attempt to contact the cloud service to clean up its own DNS record
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

    // Step 2: Delete firewall (best-effort, treat 404 as success)
    if (firewallId) {
      try {
        const resp = await doFetch(token, `/firewalls/${firewallId}`, { method: 'DELETE' });
        if (!resp.ok && resp.status !== 404) {
          log.warn({ firewallId, status: resp.status }, 'Failed to delete firewall');
        }
      } catch (err) {
        log.warn({ err, firewallId }, 'Firewall deletion error');
      }
    }

    // Step 3: Delete Droplet
    try {
      const resp = await doFetch(token, `/droplets/${dropletId}`, { method: 'DELETE' });
      if (!resp.ok && resp.status !== 404) {
        const body = await resp.text();
        return { success: false, error: `Failed to delete Droplet: ${body}` };
      }
    } catch (err) {
      return { success: false, error: `Droplet deletion failed: ${(err as Error).message}` };
    }

    // Step 4: Wait for Droplet to be fully gone before deleting volume
    if (volumeId) {
      try {
        await waitForDropletGone(token, Number(dropletId));
      } catch (err) {
        log.warn({ err }, 'Droplet-gone polling failed -- attempting volume delete anyway');
      }

      try {
        const resp = await doFetch(token, `/volumes/${volumeId}`, { method: 'DELETE' });
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
      const resp = await doFetch(token, `/droplets/${instanceId}`);
      if (resp.status === 404) {
        return { state: 'unknown', error: 'Droplet not found' };
      }
      if (!resp.ok) {
        return { state: 'unknown', error: `HTTP ${resp.status}` };
      }
      const data = (await resp.json()) as { droplet: { status: string } };
      const statusMap: Record<string, string> = {
        active: 'started',
        off: 'stopped',
        archive: 'stopped',
        new: 'starting',
      };
      return { state: statusMap[data.droplet.status] ?? 'unknown' };
    } catch (err) {
      return { state: 'unknown', error: (err as Error).message };
    }
  },
};
