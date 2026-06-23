import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { app } from 'electron';
import { atomicCredentialWrite } from '@core/utils/atomicCredentialWrite';
import { getErrorReporter } from '@core/errorReporter';
import { createScopedLogger } from '@core/logger';
import { getPlatformConfig } from '@core/platform';

const log = createScopedLogger({ service: 'hubspot-telemetry' });
const HUBSPOT_PACKAGE_VERSION = '0.1.0';
const TELEMETRY_SALT_FILE = 'telemetry-salt.bin';

export const HUBSPOT_TELEMETRY_EVENTS = [
  'hubspot.refresh.start',
  'hubspot.refresh.success',
  'hubspot.refresh.invalid_grant',
  'hubspot.refresh.transient',
  'hubspot.refresh.rate_limited',
  'hubspot.refresh.persist_failed',
  'hubspot.refresh.lock_failed',
  'hubspot.auth_required.emitted',
  'hubspot.auth_required.dispatched',
  'hubspot.auth_required.browser_opened',
  'hubspot.auth_required.callback_success',
  'hubspot.auth_required.callback_failed',
  'hubspot.migration.instance.start',
  'hubspot.migration.instance.success',
  'hubspot.migration.instance.failed',
  'hubspot.migration.instance.skipped',
  'hubspot.scope_tier.fallback',
  'hubspot.quarantine.quarantined',
  'hubspot.quarantine.recovered',
  'hubspot.catalog_override.activated',
  'hubspot.catalog_override.rejected',
] as const;

export type HubSpotTelemetryEvent = typeof HUBSPOT_TELEMETRY_EVENTS[number];
export type HubSpotTelemetrySurface = 'desktop' | 'cloud';
export type HubSpotRefreshAuthority = 'desktop' | 'cloud';

export interface HubSpotTelemetryDimensions extends Record<string, unknown> {
  connector: 'hubspot';
  surface: HubSpotTelemetrySurface;
  package_version: string;
  account_hash?: string;
  refresh_authority?: HubSpotRefreshAuthority;
  error_code?: string;
  rotation_detected?: boolean;
  instance_id?: string;
  quarantined_count?: number;
  catalog_override_active?: boolean;
  catalog_override_status?: 'activated' | 'rejected';
}

export interface HubSpotTelemetryPayload {
  event: HubSpotTelemetryEvent;
  dimensions: HubSpotTelemetryDimensions;
}

export interface HubSpotTelemetryInput {
  event: HubSpotTelemetryEvent;
  accountEmail?: string;
  surface?: HubSpotTelemetrySurface;
  refreshAuthority?: HubSpotRefreshAuthority;
  errorCode?: string;
  rotationDetected?: boolean;
  instanceId?: string;
  quarantinedCount?: number;
}

let cachedSaltHex: string | null = null;
let saltInitPromise: Promise<string> | null = null;
let testSaltHex: string | null = null;
let testUserDataDir: string | null = null;
let catalogOverrideStatus: 'activated' | 'rejected' | null = null;

function getUserDataDir(): string {
  return testUserDataDir ?? app.getPath('userData');
}

function resolveSurface(): HubSpotTelemetrySurface {
  try {
    return getPlatformConfig().surface === 'cloud' ? 'cloud' : 'desktop';
  } catch {
    return 'desktop';
  }
}

/**
 * Cross-process note:
 * During first-run install/setup there can be a tiny accepted race where two
 * processes initialize telemetry salt concurrently. We re-read from disk after
 * write and cache that value to converge quickly. This is install-boundary
 * noise and accepted for Stage 5.
 */
async function initializeTelemetrySaltHex(): Promise<string> {
  const saltPath = path.join(getUserDataDir(), TELEMETRY_SALT_FILE);
  try {
    const existing = (await fs.readFile(saltPath, 'utf8')).trim();
    if (/^[a-f0-9]{64}$/i.test(existing)) {
      cachedSaltHex = existing.toLowerCase();
      return cachedSaltHex;
    }
    log.warn('Telemetry salt file had invalid shape; rotating salt');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code !== 'ENOENT') {
      log.warn({ err: error }, 'Failed to read telemetry salt; generating a new salt');
    }
  }

  const generatedSaltHex = crypto.randomBytes(32).toString('hex');
  await atomicCredentialWrite(saltPath, generatedSaltHex, { mode: 0o600 });

  // Re-read after write so all local callers converge to the on-disk value.
  try {
    const persisted = (await fs.readFile(saltPath, 'utf8')).trim();
    if (/^[a-f0-9]{64}$/i.test(persisted)) {
      return persisted.toLowerCase();
    }
  } catch (error) {
    log.warn({ err: error }, 'Failed to re-read telemetry salt after write; using generated value');
  }

  return generatedSaltHex;
}

export async function getTelemetrySaltHex(): Promise<string> {
  if (testSaltHex) {
    return testSaltHex;
  }
  if (cachedSaltHex) {
    return cachedSaltHex;
  }
  if (!saltInitPromise) {
    saltInitPromise = initializeTelemetrySaltHex()
      .then((saltHex) => {
        cachedSaltHex = saltHex;
        return saltHex;
      })
      .finally(() => {
        saltInitPromise = null;
      });
  }
  return saltInitPromise;
}

function deriveHubSpotAccountHashWithSalt(email: string, saltHex: string): string {
  return crypto
    .createHmac('sha256', Buffer.from(saltHex, 'hex'))
    .update(email.toLowerCase())
    .digest('hex');
}

export function deriveHubSpotAccountHash(email: string, saltHex: string): string;
export function deriveHubSpotAccountHash(email: string): Promise<string>;
export function deriveHubSpotAccountHash(email: string, saltHex?: string): string | Promise<string> {
  if (saltHex) {
    return deriveHubSpotAccountHashWithSalt(email, saltHex);
  }
  return getTelemetrySaltHex().then((resolvedSaltHex) => deriveHubSpotAccountHashWithSalt(email, resolvedSaltHex));
}

function assertNoSensitivePayloadMaterial(payload: HubSpotTelemetryPayload, saltHex: string): void {
  const serialized = JSON.stringify(payload);
  if (serialized.includes(saltHex)) {
    throw new Error('HubSpot telemetry payload attempted to include telemetry salt');
  }
  if (/hubspot-access-token|hubspot-refresh-token|access_token|refresh_token/i.test(serialized)) {
    throw new Error('HubSpot telemetry payload attempted to include token material');
  }
  if (/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(serialized)) {
    throw new Error('HubSpot telemetry payload attempted to include raw email');
  }
}

/**
 * Emit a HubSpot migration/host telemetry event.
 *
 * Canonical emit-site map:
 * @emittedAt hubspot.refresh.start src/main/services/hubspotTelemetry.ts:recordHubSpotRefreshTelemetryFromOss
 * @emittedAt hubspot.refresh.success src/main/services/hubspotTelemetry.ts:recordHubSpotRefreshTelemetryFromOss
 * @emittedAt hubspot.refresh.invalid_grant src/main/services/hubspotTelemetry.ts:recordHubSpotRefreshTelemetryFromOss
 * @emittedAt hubspot.refresh.transient src/main/services/hubspotTelemetry.ts:recordHubSpotRefreshTelemetryFromOss
 * @emittedAt hubspot.refresh.rate_limited src/main/services/hubspotTelemetry.ts:recordHubSpotRefreshTelemetryFromOss
 * @emittedAt hubspot.refresh.persist_failed src/main/services/hubspotTelemetry.ts:recordHubSpotRefreshTelemetryFromOss
 * @emittedAt hubspot.refresh.lock_failed src/main/services/hubspotTelemetry.ts:recordHubSpotRefreshTelemetryFromOss
 * @emittedAt hubspot.auth_required.emitted src/main/services/mcpService.ts:invokeStdioAuthenticateTool
 * @emittedAt hubspot.auth_required.dispatched src/main/services/mcpService.ts:invokeStdioAuthenticateTool
 * @emittedAt hubspot.auth_required.browser_opened src/main/services/hubspotAuthOrchestrator.ts:runHubSpotAuthOrchestrator
 * @emittedAt hubspot.auth_required.callback_success src/main/services/hubspotAuthService.ts:startHubSpotAuth callback
 * @emittedAt hubspot.auth_required.callback_failed src/main/services/hubspotAuthService.ts:startHubSpotAuth callback
 * @emittedAt hubspot.migration.instance.start src/main/services/bundledMcpManager.ts:migrateBundledConnectorsToNpx
 * @emittedAt hubspot.migration.instance.success src/main/services/bundledMcpManager.ts:migrateBundledConnectorsToNpx
 * @emittedAt hubspot.migration.instance.failed src/main/services/bundledMcpManager.ts:migrateBundledConnectorsToNpx
 * @emittedAt hubspot.migration.instance.skipped src/main/services/bundledMcpManager.ts:migrateBundledConnectorsToNpx
 * @emittedAt hubspot.scope_tier.fallback src/main/services/bundledMcpManager.ts:resolveHubSpotScopeTierWithFallback
 * @emittedAt hubspot.quarantine.quarantined src/main/services/managedMcpInstallService.ts:recordReinstallAttempt
 * @emittedAt hubspot.quarantine.recovered src/main/services/managedMcpInstallService.ts:getMetadata
 * @emittedAt hubspot.catalog_override.activated src/main/services/connectorCatalogResolver.ts:resolveConnectorCatalogForMain
 * @emittedAt hubspot.catalog_override.rejected src/main/services/connectorCatalogResolver.ts:resolveConnectorCatalogForMain
 */
export async function emitHubSpotTelemetry(input: HubSpotTelemetryInput): Promise<HubSpotTelemetryPayload> {
  const saltHex = await getTelemetrySaltHex();
  const dimensions: HubSpotTelemetryDimensions = {
    connector: 'hubspot',
    surface: input.surface ?? resolveSurface(),
    package_version: HUBSPOT_PACKAGE_VERSION,
    ...(input.accountEmail ? { account_hash: deriveHubSpotAccountHashWithSalt(input.accountEmail, saltHex) } : {}),
    ...(input.refreshAuthority ? { refresh_authority: input.refreshAuthority } : {}),
    ...(input.errorCode ? { error_code: input.errorCode } : {}),
    ...(typeof input.rotationDetected === 'boolean' ? { rotation_detected: input.rotationDetected } : {}),
    ...(input.instanceId ? { instance_id: input.instanceId } : {}),
    ...(typeof input.quarantinedCount === 'number' ? { quarantined_count: input.quarantinedCount } : {}),
    ...(catalogOverrideStatus === 'activated' ? { catalog_override_active: true as const } : {}),
    ...(catalogOverrideStatus ? { catalog_override_status: catalogOverrideStatus } : {}),
  };

  const payload: HubSpotTelemetryPayload = { event: input.event, dimensions };
  assertNoSensitivePayloadMaterial(payload, saltHex);

  log.info({ event: input.event, dimensions }, 'HubSpot telemetry event');
  if (
    input.event === 'hubspot.refresh.invalid_grant' ||
    input.event === 'hubspot.refresh.persist_failed' ||
    input.event === 'hubspot.refresh.lock_failed'
  ) {
    getErrorReporter().addBreadcrumb({
      category: 'hubspot.refresh',
      level: 'warning',
      message: input.event,
      data: { ...dimensions },
    });
  }

  return payload;
}

export async function recordHubSpotRefreshTelemetryFromOss(
  event: Extract<HubSpotTelemetryEvent, `hubspot.refresh.${string}`>,
  input: Omit<HubSpotTelemetryInput, 'event'> = {},
): Promise<HubSpotTelemetryPayload> {
  return emitHubSpotTelemetry({ ...input, event });
}

export function setHubSpotCatalogOverrideStatus(status: 'activated' | 'rejected' | null): void {
  catalogOverrideStatus = status;
}

export const _testOnly = {
  configureSaltForTests: (saltHex: string | null) => {
    testSaltHex = saltHex;
    cachedSaltHex = null;
  },
  configureUserDataDirForTests: (userDataDir: string | null) => {
    testUserDataDir = userDataDir;
    cachedSaltHex = null;
  },
  resetCatalogOverrideStatusForTests: () => {
    catalogOverrideStatus = null;
  },
  getTelemetrySaltHex,
};
