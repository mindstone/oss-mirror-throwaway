/**
 * Cloud Provider Abstraction Types
 *
 * Defines the CloudProvider interface for multi-cloud support.
 * Extracted FROM the working Fly.io implementation — if the abstraction
 * doesn't fit Fly.io perfectly, the abstraction is wrong.
 *
 * Phase 1: Only the Fly.io provider is implemented. DigitalOcean and
 * Hetzner will be added in subsequent phases.
 */

export type CloudProviderId = 'fly' | 'digitalocean' | 'hetzner' | 'mindstone';

export interface CloudProviderConfig {
  id: CloudProviderId;
  name: string;
  authType: 'oauth' | 'pat';
}

export interface CloudProvisionOptions {
  token: string;
  region?: string;
  onProgress?: (step: CloudProvisionStep) => void;
  /** Cloudflare zone ID for DNS self-registration (DO/Hetzner only) */
  cloudflareZoneId?: string;
  /** Cloudflare DNS API token for DNS self-registration (DO/Hetzner only) */
  cloudflareDnsToken?: string;
  /**
   * Sentry DSN for the provisioned cloud-service instance. Commercial builds
   * thread the desktop's own resolved DSN from main
   * (`resolveCommercialCloudSentryDsn()`, hard-gated off for OSS builds);
   * undefined (OSS/dev) means the instance env never gains the key —
   * fail-open-to-off per the OSS no-phone-home contract.
   */
  sentryDsn?: string;
  /**
   * Desired data-volume size in GB. When omitted, the provider falls back
   * to `DEFAULT_VOLUME_SIZE_GB` (see `./volumeDefaults.ts`). Stage 3 will
   * derive this from a footprint measurement; Stage 2 merely plumbs it.
   */
  volumeSizeGb?: number;
  /**
   * Desired Fly VM tier ID ('standard' | 'faster' | 'heavy-work').
   *
   * Fly-only today — only `flyProvider` consults this field; other providers
   * (DigitalOcean, Hetzner) ignore it. When a second BYOK provider gains a
   * tier catalog of its own, restructure this into a discriminated
   * per-provider tier-id map (e.g. `tierIds?: { fly?: FlyTierId; digitalocean?: DoTierId }`)
   * so each provider's catalog stays its own source of truth and the type
   * stops looking like a global concept.
   */
  vmTierId?: string;
}

export interface CloudProvisionStep {
  phase: string;
  message: string;
  progress: number;
  failedStep?: number;
}

export interface CloudProvisionResult {
  success: boolean;
  cloudUrl?: string;
  cloudToken?: string;
  instanceId?: string;
  volumeId?: string;
  region?: string;
  vmTierId?: 'standard' | 'faster' | 'heavy-work';
  providerMetadata?: Record<string, string>;
  error?: string;
  warning?: string;
  failedStep?: number;
  cleanedUp?: boolean;
  /**
   * Optional user-facing note describing whether a partial/failed provision
   * was cleanly rolled back on the provider. Surfaces under the error in
   * the UI so users know if anything is left behind (e.g. to pay for).
   */
  cleanupMessage?: string;
}

export interface CloudDeprovisionResult {
  success: boolean;
  error?: string;
}

export interface CloudStatusResult {
  state: string;
  error?: string;
}

export interface CloudProvider {
  readonly config: CloudProviderConfig;

  provision(opts: CloudProvisionOptions): Promise<CloudProvisionResult>;

  deprovision(
    token: string,
    instanceId: string,
    metadata?: Record<string, string>,
  ): Promise<CloudDeprovisionResult>;

  getStatus(
    token: string,
    instanceId: string,
    metadata?: Record<string, string>,
  ): Promise<CloudStatusResult>;
}
