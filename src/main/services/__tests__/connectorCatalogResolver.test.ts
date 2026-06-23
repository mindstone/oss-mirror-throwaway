import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { app } from 'electron';
import { setErrorReporter } from '@core/errorReporter';
import {
  getCatalogOverrideStartupBanner,
  resolveConnectorCatalogForMain,
  _testOnly,
} from '../connectorCatalogResolver';
import * as hubspotTelemetry from '../hubspotTelemetry';

const makeCatalog = (mcpConfig: Record<string, unknown>) => ({
  version: 1,
  connectors: [{
    id: 'bundled-hubspot',
    name: 'HubSpot',
    description: 'HubSpot CRM',
    category: 'productivity',
    icon: 'hubspot',
    provider: 'rebel-oss',
    bundledConfig: {
      authType: 'oauth',
      settingsKey: 'hubspot.enabled',
      serverName: 'HubSpot',
      setupToolName: 'authenticate_hubspot_account',
      authApi: 'hubspotApi',
    },
    mcpConfig,
  }],
});

describe('connectorCatalogResolver REBEL_CATALOG_OVERRIDE', () => {
  let tempDir: string;
  let appPath: string;
  let userData: string;
  let packaged = false;
  const capturedMessages: Array<{ message: string; context?: Record<string, unknown> }> = [];
  const breadcrumbs: Array<{ category: string; message: string; level?: string; data?: Record<string, unknown> }> = [];

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'catalog-override-'));
    appPath = path.join(tempDir, 'app');
    userData = path.join(tempDir, 'userData');
    packaged = false;
    await fs.mkdir(path.join(appPath, 'resources'), { recursive: true });
    await fs.mkdir(path.join(userData, 'managed-mcps'), { recursive: true });
    vi.spyOn(app, 'getPath').mockImplementation((name: string) => {
      if (name === 'userData') return userData;
      return path.join(tempDir, name);
    });
    Object.defineProperty(app, 'getAppPath', {
      configurable: true,
      value: vi.fn(() => appPath),
    });
    Object.defineProperty(app, 'isPackaged', {
      configurable: true,
      get: () => packaged,
    });
    capturedMessages.length = 0;
    breadcrumbs.length = 0;
    setErrorReporter({
      captureException: vi.fn(),
      captureMessage: (message, context) => capturedMessages.push({ message, context }),
      addBreadcrumb: (breadcrumb) => breadcrumbs.push(breadcrumb),
    });
    hubspotTelemetry._testOnly.configureSaltForTests('00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff');
    _testOnly.resetForTests();
    delete process.env.REBEL_CATALOG_OVERRIDE;
    delete process.env.REBEL_CATALOG_OVERRIDE_ALLOW_PROD;
    delete process.env.REBEL_CATALOG_OVERRIDE_SHA256;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    hubspotTelemetry._testOnly.configureSaltForTests(null);
    _testOnly.resetForTests();
    delete process.env.REBEL_CATALOG_OVERRIDE;
    delete process.env.REBEL_CATALOG_OVERRIDE_ALLOW_PROD;
    delete process.env.REBEL_CATALOG_OVERRIDE_SHA256;
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  async function writeOverride(name: string, body: unknown): Promise<string> {
    const filePath = path.join(tempDir, name);
    await fs.writeFile(filePath, JSON.stringify(body, null, 2), 'utf8');
    process.env.REBEL_CATALOG_OVERRIDE = filePath;
    return filePath;
  }

  it('uses bundled catalog when REBEL_CATALOG_OVERRIDE is unset', async () => {
    const result = await resolveConnectorCatalogForMain();

    expect(result.source).toBe('bundled');
    expect(result.rejectedReason).toBeUndefined();
    expect(getCatalogOverrideStartupBanner()).toBeNull();
  });

  it('rejects schema-invalid overrides with a startup banner', async () => {
    await writeOverride('invalid.json', { version: 1, connectors: [{ id: 'extra-only', extra: true }] });

    const result = await resolveConnectorCatalogForMain();

    expect(result.source).toBe('bundled');
    expect(result.startupBanner).toMatch(/Catalog override rejected:/);
    expect(capturedMessages.some((entry) => entry.message === 'Catalog override rejected')).toBe(true);
  });

  it('rejects node -e style execution with a startup banner', async () => {
    await writeOverride('node-e.json', makeCatalog({ transport: 'stdio', command: 'node', args: ['-e'] }));

    const result = await resolveConnectorCatalogForMain();

    expect(result.source).toBe('bundled');
    expect(result.rejectedReason).toMatch(/node script path must be absolute|node command flags/);
  });

  it('rejects arbitrary npx packages', async () => {
    await writeOverride('npx-rm.json', makeCatalog({ transport: 'stdio', command: 'npx', args: ['-y', 'rm-rf'] }));

    const result = await resolveConnectorCatalogForMain();

    expect(result.source).toBe('bundled');
    expect(result.rejectedReason).toMatch(/allowed @mindstone or @mindstone-engineering package/);
  });

  it('rejects npx packages from other scopes', async () => {
    await writeOverride('other-scope.json', makeCatalog({ transport: 'stdio', command: 'npx', args: ['-y', '@other-scope/x@1.0.0'] }));

    const result = await resolveConnectorCatalogForMain();

    expect(result.source).toBe('bundled');
    expect(result.rejectedReason).toMatch(/allowed @mindstone or @mindstone-engineering package/);
  });

  it('rejects allowed packages with latest tag instead of exact semver', async () => {
    await writeOverride('latest.json', makeCatalog({ transport: 'stdio', command: 'npx', args: ['-y', '@mindstone/mcp-server-hubspot@latest'] }));

    const result = await resolveConnectorCatalogForMain();

    expect(result.source).toBe('bundled');
    expect(result.rejectedReason).toMatch(/exact semver/);
  });

  it('rejects npx args with trailing extra flags', async () => {
    await writeOverride(
      'npx-extra-args.json',
      makeCatalog({
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@mindstone/mcp-server-hubspot@0.2.0', '--inject-flag'],
      }),
    );

    const result = await resolveConnectorCatalogForMain();

    expect(result.source).toBe('bundled');
    expect(result.rejectedReason).toMatch(/exact semver/);
    expect(result.startupBanner).toMatch(/Catalog override rejected:/);
  });

  it('keeps bundled fallback + banner + sentry tag when telemetry emit fails on rejection', async () => {
    const telemetrySpy = vi
      .spyOn(hubspotTelemetry, 'emitHubSpotTelemetry')
      .mockRejectedValueOnce(new Error('salt write failed'));
    await writeOverride('invalid-shape.json', { version: 1, connectors: [{ id: 'bad' }] });

    const result = await resolveConnectorCatalogForMain();

    expect(result.source).toBe('bundled');
    expect(result.startupBanner).toMatch(/Catalog override rejected:/);
    expect(
      capturedMessages.some((entry) => {
        const tags = (entry.context?.tags ?? null) as { catalog_override_status?: string } | null;
        return tags?.catalog_override_status === 'rejected';
      }),
    ).toBe(true);
    expect(telemetrySpy).toHaveBeenCalled();
  });

  it('rejects production overrides with checksum mismatch', async () => {
    packaged = true;
    await writeOverride('prod-mismatch.json', makeCatalog({ transport: 'stdio', command: 'npx', args: ['-y', '@mindstone/mcp-server-hubspot@0.2.0'] }));
    process.env.REBEL_CATALOG_OVERRIDE_ALLOW_PROD = '1';
    process.env.REBEL_CATALOG_OVERRIDE_SHA256 = '0'.repeat(64);

    const result = await resolveConnectorCatalogForMain();

    expect(result.source).toBe('bundled');
    expect(result.rejectedReason).toBe('override checksum mismatch');
  });

  it('accepts a valid production override with matching lowercase-normalized SHA256', async () => {
    packaged = true;
    const overridePath = await writeOverride('prod-valid.json', makeCatalog({ transport: 'stdio', command: 'npx', args: ['-y', '@mindstone/mcp-server-hubspot@0.2.0'] }));
    const sha = crypto.createHash('sha256').update(await fs.readFile(overridePath)).digest('hex').toUpperCase();
    process.env.REBEL_CATALOG_OVERRIDE_ALLOW_PROD = '1';
    process.env.REBEL_CATALOG_OVERRIDE_SHA256 = sha;

    const result = await resolveConnectorCatalogForMain();

    expect(result.source).toBe('override');
    expect(
      capturedMessages.some((entry) => {
        const tags = (entry.context?.tags ?? null) as { catalog_override_active?: string } | null;
        return tags?.catalog_override_active === 'true';
      }),
    ).toBe(true);
  });

  it('accepts a valid dev-mode override without production flags', async () => {
    await writeOverride('dev-valid.json', makeCatalog({ transport: 'stdio', command: 'npx', args: ['-y', '@mindstone/mcp-server-hubspot@0.2.0'] }));

    const result = await resolveConnectorCatalogForMain();

    expect(result.source).toBe('override');
    expect(breadcrumbs.some((entry) => entry.message === 'Catalog override activated')).toBe(true);
  });

  // Phase B4 — Microsoft 365 cohort npx allowlist coverage.
  // See docs/plans/260519_microsoft_365_oss_migration.md.
  describe('Microsoft 365 OSS package allowlist', () => {
    const MICROSOFT_PACKAGES = [
      'microsoft-mail',
      'microsoft-calendar',
      'microsoft-files',
      'microsoft-teams',
      'microsoft-sharepoint',
    ] as const;

    for (const pkg of MICROSOFT_PACKAGES) {
      it(`accepts @mindstone/mcp-server-${pkg} at an exact semver via the override mechanism`, async () => {
        await writeOverride(
          `${pkg}-override.json`,
          makeCatalog({
            transport: 'stdio',
            command: 'npx',
            args: ['-y', `@mindstone/mcp-server-${pkg}@0.1.0`],
          }),
        );

        const result = await resolveConnectorCatalogForMain();
        expect(result.source).toBe('override');
        expect(result.rejectedReason).toBeUndefined();
      });

      it(`accepts @mindstone-engineering/mcp-server-${pkg} (legacy scope, kept during FOX-3319 rename)`, async () => {
        await writeOverride(
          `${pkg}-legacy-scope.json`,
          makeCatalog({
            transport: 'stdio',
            command: 'npx',
            args: ['-y', `@mindstone-engineering/mcp-server-${pkg}@0.1.0`],
          }),
        );

        const result = await resolveConnectorCatalogForMain();
        expect(result.source).toBe('override');
        expect(result.rejectedReason).toBeUndefined();
      });

      it(`rejects @mindstone/mcp-server-${pkg}@latest (floating tag forbidden)`, async () => {
        await writeOverride(
          `${pkg}-latest.json`,
          makeCatalog({
            transport: 'stdio',
            command: 'npx',
            args: ['-y', `@mindstone/mcp-server-${pkg}@latest`],
          }),
        );

        const result = await resolveConnectorCatalogForMain();
        expect(result.source).toBe('bundled');
        expect(result.rejectedReason).toMatch(/exact semver/);
      });

      it(`rejects @mindstone/mcp-server-${pkg}@^0.1.0 (semver range forbidden)`, async () => {
        await writeOverride(
          `${pkg}-caret.json`,
          makeCatalog({
            transport: 'stdio',
            command: 'npx',
            args: ['-y', `@mindstone/mcp-server-${pkg}@^0.1.0`],
          }),
        );

        const result = await resolveConnectorCatalogForMain();
        expect(result.source).toBe('bundled');
        expect(result.rejectedReason).toMatch(/exact semver/);
      });

      it(`rejects @mindstone/mcp-server-${pkg} with trailing extra args (no injection vector)`, async () => {
        await writeOverride(
          `${pkg}-trailing.json`,
          makeCatalog({
            transport: 'stdio',
            command: 'npx',
            args: ['-y', `@mindstone/mcp-server-${pkg}@0.1.0`, '--inject-flag'],
          }),
        );

        const result = await resolveConnectorCatalogForMain();
        expect(result.source).toBe('bundled');
        expect(result.rejectedReason).toMatch(/exact semver/);
      });
    }

    it('does NOT accept a typo like microsoft-mailx (defence-in-depth against approximate matches)', async () => {
      await writeOverride(
        'microsoft-mailx-typo.json',
        makeCatalog({
          transport: 'stdio',
          command: 'npx',
          args: ['-y', '@mindstone/mcp-server-microsoft-mailx@0.1.0'],
        }),
      );

      const result = await resolveConnectorCatalogForMain();
      expect(result.source).toBe('bundled');
      expect(result.rejectedReason).toMatch(/allowed @mindstone or @mindstone-engineering package/);
    });

    it('does NOT accept @other-scope/mcp-server-microsoft-mail (scope guard)', async () => {
      await writeOverride(
        'microsoft-mail-other-scope.json',
        makeCatalog({
          transport: 'stdio',
          command: 'npx',
          args: ['-y', '@other-scope/mcp-server-microsoft-mail@0.1.0'],
        }),
      );

      const result = await resolveConnectorCatalogForMain();
      expect(result.source).toBe('bundled');
      expect(result.rejectedReason).toMatch(/allowed @mindstone or @mindstone-engineering package/);
    });
  });
});
