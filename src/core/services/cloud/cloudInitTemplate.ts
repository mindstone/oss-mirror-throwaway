/**
 * Cloud-Init Template Generator
 *
 * Generates a #cloud-config YAML string for bootstrapping a DO/Hetzner VM
 * with Docker, Caddy (HTTPS), rebel-cloud container, and self-update watcher.
 *
 * Architecture:
 * - VM self-registers its DNS record during boot (CF creds in cloud-init, NOT in desktop app)
 * - Docker compose manages the rebel-cloud container
 * - systemd PathChanged watcher triggers updates when /data/.update-signal changes
 * - Durable tag state in /data/rebel-cloud.tag
 * - DNS recordId stored in /data/.dns-record-id for cleanup on deprovision
 */

export interface CloudInitOptions {
  hostname: string;
  cloudToken: string;
  volumeDevice: string;
  imageTag?: string;
  needsDockerInstall: boolean;
  cloudflareZoneId: string;
  cloudflareDnsToken: string;
  /**
   * Sentry DSN injected into the rebel-cloud compose environment. Undefined
   * (OSS/dev builds) omits the env line entirely — OSS no-phone-home by
   * construction. Validated strictly when present: this template interpolates
   * into a shell heredoc, so every input is allowlist-validated.
   */
  sentryDsn?: string;
}

const CLOUD_IMAGE = 'ghcr.io/mindstone/rebel-cloud';
const HETZNER_USER_DATA_LIMIT = 32_768;

const HOSTNAME_RE = /^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/i;
const DEVICE_RE = /^\/dev\/[a-zA-Z0-9/_.-]+$/;
const TOKEN_RE = /^[a-zA-Z0-9_-]+$/;
const TAG_RE = /^(prod|dev)-([a-f0-9]+|latest)$/;
const ZONE_ID_RE = /^[a-f0-9]{32}$/;
// Sentry DSN shape: https://<publicKey>@<host>[:port]/<projectId>. Tight
// allowlist (no quotes/spaces/$/backticks/newlines) — injection guard for the
// compose-env interpolation below, same stance as the other input regexes.
const SENTRY_DSN_RE = /^https:\/\/[a-zA-Z0-9]+@[a-zA-Z0-9.-]+(?::\d+)?\/\d+$/;

function validateInputs(opts: CloudInitOptions & { imageTag: string }): void {
  if (!HOSTNAME_RE.test(opts.hostname)) {
    throw new Error(`Invalid hostname: ${opts.hostname}`);
  }
  if (!DEVICE_RE.test(opts.volumeDevice)) {
    throw new Error(`Invalid volume device path: ${opts.volumeDevice}`);
  }
  if (!TOKEN_RE.test(opts.cloudToken)) {
    throw new Error('Invalid cloud token format');
  }
  if (!TAG_RE.test(opts.imageTag)) {
    throw new Error(`Invalid image tag: ${opts.imageTag}`);
  }
  if (!ZONE_ID_RE.test(opts.cloudflareZoneId)) {
    throw new Error('Invalid Cloudflare zone ID format');
  }
  if (!TOKEN_RE.test(opts.cloudflareDnsToken)) {
    throw new Error('Invalid Cloudflare DNS token format');
  }
  if (opts.sentryDsn !== undefined && !SENTRY_DSN_RE.test(opts.sentryDsn)) {
    throw new Error('Invalid Sentry DSN format');
  }
}

export function generateCloudInit(opts: CloudInitOptions): string {
  const {
    hostname,
    cloudToken,
    volumeDevice,
    needsDockerInstall,
    cloudflareZoneId,
    cloudflareDnsToken,
    sentryDsn,
  } = opts;
  const imageTag = opts.imageTag ?? 'prod-latest';

  validateInputs({ ...opts, imageTag });

  const fullImage = `${CLOUD_IMAGE}:${imageTag}`;
  // Omitted entirely when no DSN (OSS/dev) — see CloudInitOptions.sentryDsn.
  const sentryEnvLine = sentryDsn ? `\n          - SENTRY_DSN=${sentryDsn}` : '';

  const packages = needsDockerInstall
    ? `packages:
  - docker.io
  - docker-compose-v2
  - caddy`
    : `packages:
  - caddy`;

  // System files written by write_files (before runcmd).
  // Data files written in runcmd AFTER volume mount.
  const yaml = `#cloud-config
${packages}

write_files:
  - path: /etc/caddy/Caddyfile
    content: |
      ${hostname} {
        reverse_proxy localhost:8080
      }

  - path: /etc/systemd/system/rebel-cloud.service
    content: |
      [Unit]
      Description=Rebel Cloud Service
      After=docker.service
      Requires=docker.service

      [Service]
      Type=oneshot
      RemainAfterExit=yes
      WorkingDirectory=/data
      ExecStart=/usr/bin/docker compose -f /data/docker-compose.yml up -d
      ExecStop=/usr/bin/docker compose -f /data/docker-compose.yml down

      [Install]
      WantedBy=multi-user.target

  - path: /usr/local/bin/rebel-update.sh
    permissions: "0755"
    content: |
      #!/bin/bash
      set -euo pipefail
      exec 9>/data/.update.lock
      flock -n 9 || { echo "[rebel-update] Another update in progress"; exit 0; }
      TAG=$(cat /data/rebel-cloud.tag 2>/dev/null || echo "prod-latest")
      IMAGE="${CLOUD_IMAGE}:$TAG"
      echo "[rebel-update] Pulling $IMAGE"
      docker pull "$IMAGE" || { echo "[rebel-update] Pull failed"; exit 1; }
      sed -i "s|image:.*|image: $IMAGE|" /data/docker-compose.yml
      docker compose -f /data/docker-compose.yml up -d
      echo "[rebel-update] Update complete"

  - path: /etc/systemd/system/rebel-update-watcher.path
    content: |
      [Unit]
      Description=Watch for rebel cloud update signal

      [Path]
      PathChanged=/data/.update-signal

      [Install]
      WantedBy=multi-user.target

  - path: /etc/systemd/system/rebel-update-watcher.service
    content: |
      [Unit]
      Description=Apply rebel cloud update

      [Service]
      Type=oneshot
      ExecStart=/usr/local/bin/rebel-update.sh

  - path: /usr/local/bin/rebel-dns-register.sh
    permissions: "0755"
    content: |
      #!/bin/bash
      set -euo pipefail
      PUBLIC_IP=$(curl -s -4 --max-time 10 https://ifconfig.me || curl -s -4 --max-time 10 https://api.ipify.org)
      if [ -z "$PUBLIC_IP" ]; then
        echo "[dns-register] Failed to discover public IP"
        exit 1
      fi
      echo "[dns-register] Public IP: $PUBLIC_IP"
      RESULT=$(curl -s -X POST \\
        "https://api.cloudflare.com/client/v4/zones/${cloudflareZoneId}/dns_records" \\
        -H "Authorization: Bearer ${cloudflareDnsToken}" \\
        -H "Content-Type: application/json" \\
        -d "{
          \\"type\\": \\"A\\",
          \\"name\\": \\"${hostname}\\",
          \\"content\\": \\"$PUBLIC_IP\\",
          \\"ttl\\": 60,
          \\"proxied\\": false,
          \\"comment\\": \\"rebel-cloud auto-provisioned\\"
        }")
      SUCCESS=$(echo "$RESULT" | grep -o '"success":true' || true)
      RECORD_ID=$(echo "$RESULT" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)
      if [ -n "$SUCCESS" ] && [ -n "$RECORD_ID" ]; then
        echo "$RECORD_ID" > /data/.dns-record-id
        echo "[dns-register] DNS record created: $RECORD_ID for $PUBLIC_IP"
      else
        echo "[dns-register] DNS registration failed: $RESULT"
        exit 1
      fi

runcmd:
  - mkdir -p /data
  - |
    if ! mountpoint -q /data; then
      mkfs.ext4 -F ${volumeDevice} 2>/dev/null || true
      mount -o discard,defaults ${volumeDevice} /data
      echo '${volumeDevice} /data ext4 discard,nofail,defaults 0 0' >> /etc/fstab
    fi
  - "mountpoint -q /data || { echo 'FATAL: /data not mounted'; exit 1; }"
  - chown -R 1001:1001 /data
  - |
    cat > /data/docker-compose.yml << 'COMPOSE_EOF'
    services:
      rebel-cloud:
        image: ${fullImage}
        container_name: rebel-cloud
        restart: unless-stopped
        ports:
          - "8080:8080"
        volumes:
          - /data:/data
        environment:
          - PORT=8080
          - IS_CLOUD_SERVICE=1
          - NODE_ENV=production
          - REBEL_CLOUD_TOKEN=${cloudToken}
          - REBEL_USER_DATA=/data
          - CLOUDFLARE_ZONE_ID=${cloudflareZoneId}
          - CLOUDFLARE_DNS_TOKEN=${cloudflareDnsToken}
          - REBEL_CLOUD_HOSTNAME=${hostname}${sentryEnvLine}
    COMPOSE_EOF
  - echo '${imageTag}' > /data/rebel-cloud.tag
  - bash /usr/local/bin/rebel-dns-register.sh
  - systemctl daemon-reload
  - systemctl enable --now caddy
  - systemctl enable --now rebel-cloud
  - systemctl enable --now rebel-update-watcher.path
`;

  const byteLength = Buffer.byteLength(yaml, 'utf-8');
  if (byteLength > HETZNER_USER_DATA_LIMIT) {
    throw new Error(
      `Cloud-init template exceeds Hetzner 32 KiB limit: ${byteLength} bytes`
    );
  }

  return yaml;
}
