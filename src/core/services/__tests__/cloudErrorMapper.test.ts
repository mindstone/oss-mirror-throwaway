import { describe, it, expect } from 'vitest';
import { mapCloudError, type CloudErrorCategory, type CloudErrorInfo } from '../cloudErrorMapper';

function expectCategory(info: CloudErrorInfo, category: CloudErrorCategory) {
  expect(info.category).toBe(category);
  expect(info.userMessage).toBeTruthy();
  expect(info.guidance).toBeTruthy();
  // User messages should never contain raw HTTP codes/JSON
  expect(info.userMessage).not.toMatch(/\b[45]\d{2}\b/);
  expect(info.userMessage).not.toMatch(/^\{/);
}

describe('cloudErrorMapper', () => {
  // --- Auth ---
  describe('auth_invalid', () => {
    it('matches 401 status', () => {
      expectCategory(mapCloudError('HTTP error', { httpStatus: 401 }), 'auth_invalid');
    });

    it('matches "Invalid Fly.io token" message', () => {
      expectCategory(
        mapCloudError('Invalid Fly.io token. Check it at fly.io/user/personal_access_tokens'),
        'auth_invalid',
      );
    });

    it('matches "Invalid DigitalOcean token" message', () => {
      expectCategory(
        mapCloudError('Invalid DigitalOcean token. Generate one at cloud.digitalocean.com/account/api/tokens', { failedStep: 1 }),
        'auth_invalid',
      );
    });

    it('matches "Invalid Hetzner Cloud token" message', () => {
      expectCategory(
        mapCloudError('Invalid Hetzner Cloud token. Generate one at console.hetzner.cloud'),
        'auth_invalid',
      );
    });

    it('returns token_help helpKey', () => {
      const info = mapCloudError('Invalid Fly.io token.');
      expect(info.helpKey).toBe('token_help');
    });
  });

  describe('auth_insufficient', () => {
    it('matches 403 status', () => {
      expectCategory(mapCloudError('Forbidden', { httpStatus: 403 }), 'auth_insufficient');
    });

    it('matches permission-related messages', () => {
      expectCategory(
        mapCloudError('Could not access app "rebel-cloud-xxx" on Fly.io. Your token may not have permission.'),
        'auth_insufficient',
      );
    });
  });

  // --- Billing required ---
  describe('billing_required', () => {
    it('matches Fly payment-method 422 message', () => {
      expectCategory(
        mapCloudError('Failed to create 50GB storage volume in region "iad": To create more than 20GB in volumes please add a payment method. See fly.io/dashboard/your-org/billing'),
        'billing_required',
      );
    });

    it('matches bracketed marker with org slug and extracts providerContext', () => {
      const info = mapCloudError('[cloud:billing_required:acme-org] Fly.io requires a payment method before it can create storage over 20GB. Add a card at fly.io/dashboard/acme-org/billing, then try again.');
      expectCategory(info, 'billing_required');
      expect(info.providerContext?.orgSlug).toBe('acme-org');
    });

    it('matches HTTP 402', () => {
      expectCategory(
        mapCloudError('Payment Required', { httpStatus: 402 }),
        'billing_required',
      );
    });

    it('matches DigitalOcean-style billing message', () => {
      expectCategory(
        mapCloudError('Billing is required before you can create droplets'),
        'billing_required',
      );
    });

    it('sets helpKey to provider_billing', () => {
      const info = mapCloudError('payment method not on file');
      expect(info.helpKey).toBe('provider_billing');
    });

    it('does not set providerContext when marker has generic provider only', () => {
      const info = mapCloudError('[cloud:billing_required:fly] needs a card');
      expect(info.providerContext).toBeUndefined();
    });
  });

  // --- SSO required ---
  describe('sso_required', () => {
    it('matches bracketed SSO marker', () => {
      expectCategory(
        mapCloudError('[cloud:sso_required:fly] Your Fly organization requires SSO'),
        'sso_required',
      );
    });

    it('matches natural-language "single sign-on"', () => {
      expectCategory(
        mapCloudError('This org requires single sign-on; tokens cannot be created here'),
        'sso_required',
      );
    });

    it('sets helpKey to sso_token_help (not the generic personal-token page)', () => {
      const info = mapCloudError('[cloud:sso_required:fly] SSO required');
      expect(info.helpKey).toBe('sso_token_help');
    });

    it('takes precedence over auth_invalid when both would match', () => {
      const info = mapCloudError('[cloud:sso_required:fly] token creation blocked: requires SSO');
      expect(info.category).toBe('sso_required');
    });
  });

  // --- Rate Limiting ---
  describe('rate_limited', () => {
    it('matches 429 status', () => {
      expectCategory(mapCloudError('Too many requests', { httpStatus: 429 }), 'rate_limited');
    });

    it('matches "rate limit" in message', () => {
      expectCategory(mapCloudError('API rate limit exceeded'), 'rate_limited');
    });

    it('is a warning, not an error', () => {
      expect(mapCloudError('rate limit exceeded').severity).toBe('warning');
    });
  });

  // --- Managed cloud ---
  describe('managed_self_service_rejected', () => {
    it('matches managed self-service rejection copy and uses the refined guidance', () => {
      const info = mapCloudError('Managed instances are maintained automatically.');
      expectCategory(info, 'managed_self_service_rejected');
      expect(info.userMessage).toBe('Managed cloud keeps itself up to date. No action needed here.');
      expect(info.guidance).toContain('Check status');
      expect(info.severity).toBe('warning');
    });
  });

  describe('managed_update_interrupted', () => {
    it('matches the stale-updating reset variant', () => {
      const info = mapCloudError(
        'Reset from stale updating state — worker interrupted before completion (likely request timeout)',
      );
      expectCategory(info, 'managed_update_interrupted');
      expect(info.userMessage).toContain("didn't finish cleanly");
      expect(info.guidance).toContain('Update now');
      expect(info.severity).toBe('warning');
      expect(info.helpKey).toBeUndefined();
    });

    it('matches the worker interrupted variant on its own', () => {
      const info = mapCloudError('Managed cloud worker interrupted before completion during deploy');
      expectCategory(info, 'managed_update_interrupted');
    });
  });

  // --- Cloudflare ---
  describe('cloudflare_missing', () => {
    it('matches Cloudflare credentials error', () => {
      expectCategory(
        mapCloudError('Cloudflare credentials required for DNS setup', { failedStep: 0 }),
        'cloudflare_missing',
      );
    });
  });

  // --- DNS / Certificate / Health (bracketed markers from Stage 4) ---
  describe('dns_resolution_failed', () => {
    it('matches bracketed marker', () => {
      expectCategory(
        mapCloudError('[cloud:dns_resolution_failed] DNS did not resolve after 5 minutes'),
        'dns_resolution_failed',
      );
    });
  });

  describe('cert_issuance_failed', () => {
    it('matches bracketed marker', () => {
      expectCategory(
        mapCloudError('[cloud:cert_issuance_failed] TLS certificate not issued'),
        'cert_issuance_failed',
      );
    });
  });

  describe('service_boot_failed', () => {
    it('matches bracketed marker', () => {
      expectCategory(
        mapCloudError('[cloud:service_boot_failed] Health endpoint returned 502'),
        'service_boot_failed',
      );
    });
  });

  describe('dns_timeout', () => {
    it('matches bracketed marker', () => {
      expectCategory(
        mapCloudError('[cloud:dns_timeout] Timed out waiting for DNS propagation'),
        'dns_timeout',
      );
    });

    it('matches legacy DO/Hetzner message', () => {
      expectCategory(
        mapCloudError('Cloud service did not become healthy. DNS or certificate setup may have failed.', { failedStep: 8 }),
        'dns_timeout',
      );
    });
  });

  describe('health_check_timeout', () => {
    it('matches "did not become healthy"', () => {
      expectCategory(
        mapCloudError('Cloud service did not become healthy after 5 minutes'),
        'health_check_timeout',
      );
    });

    it('matches "not yet healthy"', () => {
      expectCategory(
        mapCloudError('Cloud service is starting but not yet healthy'),
        'health_check_timeout',
      );
    });

    it('is a warning, not error', () => {
      expect(mapCloudError('Service did not become healthy').severity).toBe('warning');
    });
  });

  // --- Machine / Server ---
  describe('machine_not_started', () => {
    it('matches "did not become active"', () => {
      expectCategory(
        mapCloudError('Droplet did not become active in time', { failedStep: 6 }),
        'machine_not_started',
      );
    });

    it('matches "did not become ready"', () => {
      expectCategory(
        mapCloudError('Server did not become ready in time', { failedStep: 6 }),
        'machine_not_started',
      );
    });
  });

  // --- Manifest ---
  describe('manifest_error', () => {
    it('matches "manifest unknown"', () => {
      expectCategory(mapCloudError('manifest unknown'), 'manifest_error');
    });

    it('matches GHCR unauthorized manifest fetch during machine create (image moved/private)', () => {
      const raw =
        'Failed to launch cloud instance in region "iad": failed to get manifest ghcr.io/mindstone/rebel-cloud:latest: unauthorized';
      const info = mapCloudError(raw, { failedStep: 6 });
      expectCategory(info, 'manifest_error');
      expect(info.userMessage).toMatch(/cloud image isn't available/i);
      expect(info.guidance).toMatch(/update/i);
    });

    it('matches "401 Unauthorized" in a manifest-fetch body during machine create (must beat auth_invalid)', () => {
      // Regression: auth_invalid would otherwise win on `\b401\b`, sending
      // the user to "regenerate your token" — but the unauthorized is from
      // the registry, not the user's Fly PAT.
      const raw = 'Failed to launch: failed to get manifest ghcr.io/...: 401 Unauthorized';
      expectCategory(mapCloudError(raw, { failedStep: 6 }), 'manifest_error');
    });

    it('does not match the unauthorized-manifest rule outside resource-creation steps', () => {
      // Token validation lives at failedStep 1 — auth_invalid should win there.
      const raw = 'failed to get manifest: unauthorized';
      const info = mapCloudError(raw, { failedStep: 1 });
      expect(info.category).not.toBe('manifest_error');
    });
  });

  // --- Image pull transient (network glitch between Fly and GHCR CDN) ---
  describe('image_pull_transient', () => {
    it('matches "connection reset by peer" while fetching a blob', () => {
      const raw =
        'failed to get blob, digest sha256:abc, ref ghcr.io/mindstone/rebel-cloud:latest@sha256:def: ' +
        'Get "https://pkg-containers.githubusercontent.com/...": ' +
        'read tcp [::1]:41576->[::1]:443: read: connection reset by peer';
      const info = mapCloudError(raw, { failedStep: 6 });
      expectCategory(info, 'image_pull_transient');
      expect(info.severity).toBe('warning');
      expect(info.userMessage).toMatch(/network glitch/i);
    });

    it('matches i/o timeout during blob fetch', () => {
      const raw = 'Failed to launch instance: failed to get blob: i/o timeout';
      expectCategory(mapCloudError(raw, { failedStep: 6 }), 'image_pull_transient');
    });

    it('does not match when failedStep is outside 3-6', () => {
      const raw = 'failed to get blob: connection reset by peer';
      const info = mapCloudError(raw, { failedStep: 1 });
      expect(info.category).not.toBe('image_pull_transient');
    });

    it('takes precedence over generic resource_creation_failed', () => {
      // Same raw error would otherwise match resource_creation_failed; the
      // transient-network rule must run first so the user sees actionable
      // "try again" guidance instead of the generic failure copy.
      const raw =
        'Failed to launch cloud instance in region "iad": failed to get blob: ' +
        'read tcp [::1]:41576->[::1]:443: read: connection reset by peer';
      expectCategory(mapCloudError(raw, { failedStep: 6 }), 'image_pull_transient');
    });
  });

  // --- Network ---
  describe('network_unreachable', () => {
    it('matches ENOTFOUND', () => {
      expectCategory(mapCloudError('getaddrinfo ENOTFOUND api.machines.dev'), 'network_unreachable');
    });

    it('matches "Could not reach Fly.io"', () => {
      expectCategory(
        mapCloudError('Could not reach Fly.io. Check your internet connection and try again.'),
        'network_unreachable',
      );
    });

    it('matches ECONNREFUSED', () => {
      expectCategory(mapCloudError('connect ECONNREFUSED 127.0.0.1:443'), 'network_unreachable');
    });
  });

  // --- Capacity ---
  describe('capacity', () => {
    it('maps the machine-create "Not enough capacity" message to capacity (not unknown)', () => {
      const info = mapCloudError(
        'Not enough capacity in region "iad" for this machine size. Try a different region.',
        { failedStep: 6 },
      );
      expectCategory(info, 'capacity');
      expect(info.guidance).toMatch(/different region/i);
    });

    it('maps the volume-create "Not enough capacity" message to capacity', () => {
      const info = mapCloudError(
        'Not enough capacity in region "iad" for a 50GB volume. Try a different region.',
        { failedStep: 5 },
      );
      expectCategory(info, 'capacity');
    });

    it('maps a raw Fly "insufficient resources" body to capacity', () => {
      const info = mapCloudError(
        "insufficient resources to create new machine with existing volume 'vol_abc'",
        { failedStep: 6 },
      );
      expectCategory(info, 'capacity');
    });

    it('takes precedence over generic resource_creation_failed', () => {
      // A capacity failure must not be mapped to the generic "wait and retry"
      // copy — that sends the user straight back into the same wall.
      const info = mapCloudError(
        'Failed to launch: no capacity available in region iad',
        { failedStep: 6 },
      );
      expectCategory(info, 'capacity');
    });
  });

  // --- Resource Creation ---
  describe('resource_creation_failed', () => {
    it('matches "Failed to create" with failedStep', () => {
      expectCategory(
        mapCloudError('Failed to create storage: {"error":"quota exceeded"}', { failedStep: 5 }),
        'resource_creation_failed',
      );
    });

    it('matches "Failed to launch instance" with failedStep', () => {
      expectCategory(
        mapCloudError('Failed to launch instance: internal server error', { failedStep: 6 }),
        'resource_creation_failed',
      );
    });

    it('does not match without appropriate failedStep', () => {
      const info = mapCloudError('Failed to create volume: quota exceeded', { failedStep: 1 });
      expect(info.category).not.toBe('resource_creation_failed');
    });
  });

  // --- Unknown fallback ---
  describe('unknown', () => {
    it('catches unrecognized errors', () => {
      const info = mapCloudError('Something completely unexpected happened');
      expectCategory(info, 'unknown');
      expect(info.helpKey).toBe('export_diagnostics');
    });

    it('preserves raw error in technicalDetail', () => {
      const raw = 'xyzzy: obscure provider error 9001';
      const info = mapCloudError(raw);
      expect(info.technicalDetail).toBe(raw);
    });

    it('exposes a human-readable provider detail when raw text is clean', () => {
      const info = mapCloudError('The account quota is too low for this operation in region eu-west.');
      expect(info.category).toBe('unknown');
      expect(info.providerDetail).toBe('The account quota is too low for this operation in region eu-west.');
    });

    it('does not expose providerDetail for raw JSON', () => {
      const info = mapCloudError('{"error":"mystery_failure","details":"unknown"}');
      expect(info.category).toBe('unknown');
      expect(info.providerDetail).toBeUndefined();
    });

    it('does not expose providerDetail when raw embeds an HTTP 4xx/5xx code', () => {
      const info = mapCloudError('Upstream failure: status 503 at provider');
      expect(info.category).toBe('unknown');
      expect(info.providerDetail).toBeUndefined();
    });
  });

  // --- General contract ---
  describe('contract', () => {
    it('always returns technicalDetail with the raw error', () => {
      const info = mapCloudError('Token validation failed: {"error":"bad_token"}', { failedStep: 1 });
      expect(info.technicalDetail).toBe('Token validation failed: {"error":"bad_token"}');
    });

    it('user messages never contain raw JSON', () => {
      const inputs = [
        'Token validation failed: {"error":"bad_token"}',
        '{"message":"rate_limit"}',
        'Failed to create volume: {"id":"error","message":"insufficient_resources"}',
      ];
      for (const raw of inputs) {
        const info = mapCloudError(raw);
        expect(info.userMessage).not.toMatch(/^\{/);
        expect(info.userMessage).not.toMatch(/\{.*\}/);
      }
    });
  });
});
