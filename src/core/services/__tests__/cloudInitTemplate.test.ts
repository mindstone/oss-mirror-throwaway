import { describe, it, expect } from 'vitest';
import { generateCloudInit, type CloudInitOptions } from '../cloud/cloudInitTemplate';

function baseOpts(overrides?: Partial<CloudInitOptions>): CloudInitOptions {
  return {
    hostname: 'test123.cloud.mindstone.com',
    cloudToken: 'test-cloud-token',
    volumeDevice: '/dev/disk/by-id/scsi-0DO_Volume_rebel',
    imageTag: 'prod-abc123',
    needsDockerInstall: true,
    cloudflareZoneId: 'abcdef0123456789abcdef0123456789',
    cloudflareDnsToken: 'dns-token-456',
    ...overrides,
  };
}

describe('generateCloudInit', () => {
  it('returns valid cloud-config header', () => {
    const result = generateCloudInit(baseOpts());
    expect(result).toMatch(/^#cloud-config\n/);
  });

  it('fits within Hetzner 32 KiB limit', () => {
    const result = generateCloudInit(baseOpts());
    expect(Buffer.byteLength(result, 'utf-8')).toBeLessThan(32_768);
  });

  it('includes docker packages for DO variant', () => {
    const result = generateCloudInit(baseOpts({ needsDockerInstall: true }));
    expect(result).toContain('docker.io');
    expect(result).toContain('docker-compose-v2');
    expect(result).toContain('caddy');
  });

  it('omits docker packages for Hetzner variant', () => {
    const result = generateCloudInit(baseOpts({ needsDockerInstall: false }));
    const packagesSection = result.split('write_files:')[0];
    expect(packagesSection).not.toContain('docker.io');
    expect(packagesSection).not.toContain('docker-compose-v2');
    expect(packagesSection).toContain('caddy');
  });

  it('includes Caddyfile with hostname', () => {
    const result = generateCloudInit(baseOpts());
    expect(result).toContain('test123.cloud.mindstone.com {');
    expect(result).toContain('reverse_proxy localhost:8080');
  });

  it('includes systemd rebel-cloud service', () => {
    const result = generateCloudInit(baseOpts());
    expect(result).toContain('rebel-cloud.service');
    expect(result).toContain('docker compose -f /data/docker-compose.yml up -d');
    expect(result).toContain('docker compose -f /data/docker-compose.yml down');
  });

  it('includes update watcher path and service units', () => {
    const result = generateCloudInit(baseOpts());
    expect(result).toContain('rebel-update-watcher.path');
    expect(result).toContain('PathChanged=/data/.update-signal');
    expect(result).toContain('rebel-update-watcher.service');
    expect(result).toContain('rebel-update.sh');
  });

  it('includes DNS registration script with CF credentials', () => {
    const result = generateCloudInit(baseOpts());
    expect(result).toContain('rebel-dns-register.sh');
    expect(result).toContain('abcdef0123456789abcdef0123456789');
    expect(result).toContain('dns-token-456');
    expect(result).toContain('.dns-record-id');
  });

  it('includes volume mount and verification in runcmd', () => {
    const result = generateCloudInit(baseOpts());
    expect(result).toContain('mkdir -p /data');
    expect(result).toContain('mountpoint -q /data');
    expect(result).toContain(baseOpts().volumeDevice);
    expect(result).toContain('FATAL: /data not mounted');
  });

  it('creates docker-compose.yml in runcmd after mount', () => {
    const result = generateCloudInit(baseOpts());
    expect(result).toContain('docker-compose.yml');
    expect(result).toContain('ghcr.io/mindstone/rebel-cloud:prod-abc123');
    expect(result).toContain('REBEL_CLOUD_TOKEN=test-cloud-token');
  });

  it('writes durable tag file in runcmd', () => {
    const result = generateCloudInit(baseOpts());
    expect(result).toContain("echo 'prod-abc123' > /data/rebel-cloud.tag");
  });

  it('uses default image tag when not specified', () => {
    const result = generateCloudInit(baseOpts({ imageTag: undefined }));
    expect(result).toContain('ghcr.io/mindstone/rebel-cloud:prod-latest');
    expect(result).toContain("echo 'prod-latest' > /data/rebel-cloud.tag");
  });

  it('enables systemd services in correct order', () => {
    const result = generateCloudInit(baseOpts());
    const runcmdSection = result.split('runcmd:')[1];
    const dnsIdx = runcmdSection.indexOf('rebel-dns-register.sh');
    const caddyIdx = runcmdSection.indexOf('enable --now caddy');
    const cloudIdx = runcmdSection.indexOf('enable --now rebel-cloud');
    const watcherIdx = runcmdSection.indexOf('enable --now rebel-update-watcher.path');
    expect(dnsIdx).toBeLessThan(caddyIdx);
    expect(caddyIdx).toBeLessThan(cloudIdx);
    expect(cloudIdx).toBeLessThan(watcherIdx);
  });

  it('includes all expected write_files paths', () => {
    const result = generateCloudInit(baseOpts());
    expect(result).toContain('path: /etc/caddy/Caddyfile');
    expect(result).toContain('path: /etc/systemd/system/rebel-cloud.service');
    expect(result).toContain('path: /usr/local/bin/rebel-update.sh');
    expect(result).toContain('path: /etc/systemd/system/rebel-update-watcher.path');
    expect(result).toContain('path: /etc/systemd/system/rebel-update-watcher.service');
    expect(result).toContain('path: /usr/local/bin/rebel-dns-register.sh');
  });

  it('sets proxied to false for direct Caddy cert issuance', () => {
    const result = generateCloudInit(baseOpts());
    expect(result).toMatch(/proxied.*false/);
  });

  it('update script reads from durable tag file', () => {
    const result = generateCloudInit(baseOpts());
    expect(result).toContain('cat /data/rebel-cloud.tag');
  });

  it('update script uses set -euo pipefail for safety', () => {
    const result = generateCloudInit(baseOpts());
    expect(result).toContain('set -euo pipefail');
  });

  it('update script uses flock to prevent concurrent updates', () => {
    const result = generateCloudInit(baseOpts());
    expect(result).toContain('flock -n 9');
    expect(result).toContain('.update.lock');
  });

  it('rejects hostname with shell metacharacters', () => {
    expect(() => generateCloudInit(baseOpts({ hostname: 'test; rm -rf /' }))).toThrow('Invalid hostname');
  });

  it('rejects hostname with newlines', () => {
    expect(() => generateCloudInit(baseOpts({ hostname: 'test\nevil.com' }))).toThrow('Invalid hostname');
  });

  it('rejects volume device with shell injection', () => {
    expect(() => generateCloudInit(baseOpts({ volumeDevice: '/dev/sda; rm -rf /' }))).toThrow('Invalid volume device');
  });

  it('rejects cloud token with special characters', () => {
    expect(() => generateCloudInit(baseOpts({ cloudToken: 'token$(evil)' }))).toThrow('Invalid cloud token');
  });

  it('rejects invalid image tag format', () => {
    expect(() => generateCloudInit(baseOpts({ imageTag: 'my-custom-tag' }))).toThrow('Invalid image tag');
  });

  it('rejects invalid Cloudflare zone ID format', () => {
    expect(() => generateCloudInit(baseOpts({ cloudflareZoneId: 'not-a-hex-id' }))).toThrow('Invalid Cloudflare zone ID');
  });

  it('accepts valid 32-char hex zone ID', () => {
    expect(() =>
      generateCloudInit(baseOpts({ cloudflareZoneId: 'abcdef0123456789abcdef0123456789' })),
    ).not.toThrow();
  });

  // SENTRY_DSN delivery (OSS-scrub follow-up): the docker-compose environment
  // block is the only delivery path for new DO/Hetzner VMs.
  it('includes SENTRY_DSN in the compose environment when a DSN is provided', () => {
    const result = generateCloudInit(baseOpts({ sentryDsn: 'https://public@example.invalid/1' }));
    expect(result).toContain('- SENTRY_DSN=https://public@example.invalid/1');
  });

  it('omits SENTRY_DSN entirely when no DSN is provided (OSS no-phone-home)', () => {
    const result = generateCloudInit(baseOpts());
    expect(result).not.toContain('SENTRY_DSN');
  });

  it('rejects a malformed Sentry DSN (injection guard at the template boundary)', () => {
    expect(() =>
      generateCloudInit(baseOpts({ sentryDsn: 'https://public@example.invalid/1\nevil: yes' })),
    ).toThrow('Invalid Sentry DSN');
    expect(() =>
      generateCloudInit(baseOpts({ sentryDsn: 'not-a-dsn $(evil)' })),
    ).toThrow('Invalid Sentry DSN');
  });
});
