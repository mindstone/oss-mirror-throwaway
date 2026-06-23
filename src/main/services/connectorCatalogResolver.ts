import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { app } from 'electron';
import catalogData from '../../../resources/connector-catalog.json';
import { ALLOWED_NPX_PACKAGE_RE, CatalogSchema } from '@shared/connectorCatalogSchema';
import type { ConnectorCatalog } from '@shared/types';
import { createScopedLogger } from '@core/logger';
import { getErrorReporter } from '@core/errorReporter';
import { getPlatformConfig } from '@core/platform';
import { setConnectorCatalogForMain } from '@core/services/connectorCatalogService';
import {
  emitHubSpotTelemetry,
  setHubSpotCatalogOverrideStatus,
  type HubSpotTelemetryInput,
} from './hubspotTelemetry';

const log = createScopedLogger({ service: 'connector-catalog-resolver' });

// `ALLOWED_NPX_PACKAGE_RE` lives in @shared/connectorCatalogSchema so that
// scripts/dev-mcp-managed-install.ts can use the same whitelist when
// auto-generating overrides — see docstring on the constant. Update there.
//
// Historical note: this allowlist accepts BOTH scopes during the FOX-3319
// rename (@mindstone-engineering = legacy, @mindstone = canonical) and keeps
// `microsoft-365` alongside the five surface-specific Microsoft packages for
// the duration of the Phase B → Phase D Microsoft cohort flip (see
// docs/plans/260519_microsoft_365_oss_migration.md). Phase E removes
// `microsoft-365`.
const FORBIDDEN_NODE_ARGS = new Set(['-e', '--eval', '-r', '--require', '-p', '--print', '--input-type']);

export interface ConnectorCatalogResolution {
  catalog: ConnectorCatalog;
  source: 'bundled' | 'override';
  overridePath?: string;
  rejectedReason?: string;
  startupBanner?: string;
}

let lastStartupBanner: string | null = null;

function getAppResourcesRoot(): string {
  const appPath = typeof app.getAppPath === 'function'
    ? app.getAppPath()
    : getPlatformConfig().appPath;
  return path.join(appPath, 'resources');
}

function getManagedMcpsRoot(): string {
  return path.join(app.getPath('userData'), 'managed-mcps');
}

function isPathInside(childPath: string, parentPath: string): boolean {
  const relative = path.relative(parentPath, childPath);
  return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function validateCommandArgs(catalog: ConnectorCatalog): void {
  for (const connector of catalog.connectors) {
    const command = connector.mcpConfig?.command;
    const args = connector.mcpConfig?.args ?? [];
    if (!command) continue;

    if (command === 'node') {
      if (args.length !== 1) {
        throw new Error(`connector ${connector.id}: node command requires exactly one absolute script path`);
      }
      const [scriptPath] = args;
      if (!path.isAbsolute(scriptPath)) {
        throw new Error(`connector ${connector.id}: node script path must be absolute`);
      }
      if (FORBIDDEN_NODE_ARGS.has(scriptPath) || scriptPath.startsWith('-')) {
        throw new Error(`connector ${connector.id}: node command flags are not allowed`);
      }
      const normalizedScriptPath = path.normalize(scriptPath);
      const allowedRoots = [getAppResourcesRoot(), getManagedMcpsRoot()].map((root) => path.normalize(root));
      if (!allowedRoots.some((root) => isPathInside(normalizedScriptPath, root))) {
        throw new Error(`connector ${connector.id}: node script path must be under app resources or managed MCPs`);
      }
      continue;
    }

    if (command === 'npx') {
      if (args.length !== 2 || args[0] !== '-y' || !ALLOWED_NPX_PACKAGE_RE.test(args[1])) {
        throw new Error(`connector ${connector.id}: npx args must pin an allowed @mindstone or @mindstone-engineering package with exact semver`);
      }
      continue;
    }

    throw new Error(`connector ${connector.id}: command "${command}" is not allowed`);
  }
}

function getBundledCatalog(): ConnectorCatalog {
  return catalogData as ConnectorCatalog;
}

async function safeEmitHubSpotTelemetry(input: HubSpotTelemetryInput): Promise<void> {
  await emitHubSpotTelemetry(input).catch((err) => {
    log.error({ err, event: input.event }, 'hubspot.telemetry_emit_failed');
  });
}

async function rejectOverride(reason: string, overridePath?: string): Promise<ConnectorCatalogResolution> {
  lastStartupBanner = `Catalog override rejected: ${reason}`;
  setHubSpotCatalogOverrideStatus('rejected');
  log.error({ reason, overridePath }, 'Catalog override rejected');
  getErrorReporter().captureMessage('Catalog override rejected', {
    level: 'error',
    tags: { catalog_override_status: 'rejected' },
    extra: { reason, overridePath },
  });
  const resolution: ConnectorCatalogResolution = {
    catalog: getBundledCatalog(),
    source: 'bundled',
    overridePath,
    rejectedReason: reason,
    startupBanner: lastStartupBanner,
  };
  setConnectorCatalogForMain(null);

  await safeEmitHubSpotTelemetry({
    event: 'hubspot.catalog_override.rejected',
    errorCode: reason,
  });
  return resolution;
}

async function sha256File(filePath: string): Promise<string> {
  const data = await fs.readFile(filePath);
  return crypto.createHash('sha256').update(data).digest('hex').toLowerCase();
}

/**
 * Resolve the connector catalog for main-process reads.
 *
 * Security note: Stage 5 keeps checksum + strict command/args validation as the
 * v0.1.0 control surface and intentionally defers signed-manifest verification
 * to Stage 6 follow-up tracking from the HubSpot OSS migration plan
 * (docs/plans/260503_hubspot_mcp_oss_migration.md, R3-SEC-1 deferral).
 */
export async function resolveConnectorCatalogForMain(): Promise<ConnectorCatalogResolution> {
  const overridePath = process.env.REBEL_CATALOG_OVERRIDE?.trim();
  if (!overridePath) {
    lastStartupBanner = null;
    setHubSpotCatalogOverrideStatus(null);
    setConnectorCatalogForMain(null);
    return { catalog: getBundledCatalog(), source: 'bundled' };
  }

  let raw: string;
  try {
    raw = await fs.readFile(overridePath, 'utf8');
  } catch (error) {
    return rejectOverride(`unable to read override file (${(error as NodeJS.ErrnoException).code ?? 'unknown'})`, overridePath);
  }

  if (app.isPackaged) {
    const allowProd = process.env.REBEL_CATALOG_OVERRIDE_ALLOW_PROD === '1';
    const expectedSha = process.env.REBEL_CATALOG_OVERRIDE_SHA256?.toLowerCase();
    if (!allowProd || !expectedSha) {
      return rejectOverride('production override requires REBEL_CATALOG_OVERRIDE_ALLOW_PROD=1 and REBEL_CATALOG_OVERRIDE_SHA256', overridePath);
    }
    const actualSha = await sha256File(overridePath);
    if (actualSha !== expectedSha) {
      return rejectOverride('override checksum mismatch', overridePath);
    }
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return rejectOverride('override JSON is invalid', overridePath);
  }

  const schemaResult = CatalogSchema.safeParse(parsed);
  if (!schemaResult.success) {
    return rejectOverride(`override schema invalid: ${schemaResult.error.issues[0]?.message ?? 'unknown schema error'}`, overridePath);
  }

  const catalog = schemaResult.data as ConnectorCatalog;
  try {
    validateCommandArgs(catalog);
  } catch (error) {
    return rejectOverride(error instanceof Error ? error.message : String(error), overridePath);
  }

  lastStartupBanner = null;
  setHubSpotCatalogOverrideStatus('activated');
  log.warn({ overridePath }, 'Catalog override activated');
  getErrorReporter().addBreadcrumb({
    category: 'connector-catalog',
    level: 'warning',
    message: 'Catalog override activated',
    data: { overridePath },
  });
  getErrorReporter().captureMessage('Catalog override activated', {
    level: 'warning',
    tags: { catalog_override_active: 'true' },
    extra: { overridePath },
  });
  setConnectorCatalogForMain(catalog);
  await safeEmitHubSpotTelemetry({ event: 'hubspot.catalog_override.activated' });
  return { catalog, source: 'override', overridePath };
}

export function getCatalogOverrideStartupBanner(): string | null {
  return lastStartupBanner;
}

export const _testOnly = {
  validateCommandArgs,
  getBundledCatalog,
  resetForTests: () => {
    lastStartupBanner = null;
    setHubSpotCatalogOverrideStatus(null);
  },
};
