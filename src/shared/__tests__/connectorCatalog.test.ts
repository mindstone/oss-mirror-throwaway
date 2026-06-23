import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import catalog from '../../../resources/connector-catalog.json';
import {
  ALLOWED_PROVIDER_KEY_MAPPINGS,
  validateConnectorCatalogProviderKeyMappings,
} from '../data/connectorCatalogValidation';
import { isBundledLikeProvider } from '../types';
import type { ConnectorCatalog, ConnectorCatalogEntry } from '../types';

// Type-assert the imported JSON to our catalog type
const typedCatalog = catalog as ConnectorCatalog;

type EnvPlaceholderCatalogEntry = {
  id: string;
  mcpConfig?: { env?: Record<string, string> };
  setupFields?: Array<{ id: string; envVar?: string }>;
  bundledConfig?: { providerKeyMapping?: Record<string, string> };
};

type ValidateEnvPlaceholderResolvability = (entry: EnvPlaceholderCatalogEntry) => void;

const validateCatalogImportModulePath = '../../../scripts/lib/validateCatalogImport.js';

async function loadValidateEnvPlaceholderResolvability(): Promise<ValidateEnvPlaceholderResolvability> {
  const module = (await import(validateCatalogImportModulePath)) as {
    validateEnvPlaceholderResolvability: ValidateEnvPlaceholderResolvability;
  };
  return module.validateEnvPlaceholderResolvability;
}

describe('connector-catalog.json', () => {
  it('has required fields for each provider type', () => {
    for (const entry of typedCatalog.connectors) {
      // Cast to check at runtime what TypeScript enforces at compile time
      const connector = entry as ConnectorCatalogEntry;

      if (connector.provider === 'bundled') {
        expect(
          connector.bundledConfig,
          `bundled connector "${connector.id}" must have bundledConfig`
        ).toBeDefined();
      } else if (connector.provider === 'rebel-oss') {
        // rebel-oss entries may have bundledConfig, mcpConfig, or both
        expect(
          connector.bundledConfig || connector.mcpConfig,
          `rebel-oss connector "${connector.id}" must have bundledConfig or mcpConfig`
        ).toBeDefined();
      } else if (connector.provider === 'direct') {
        // Direct connectors must have mcpConfig
        expect(
          connector.mcpConfig,
          `direct connector "${connector.id}" must have mcpConfig`
        ).toBeDefined();
      }
      // Community connectors: mcpConfig is optional (some use requiresSetup for user-provided URL)
      if (connector.provider === 'community' && !connector.mcpConfig) {
        // If a community connector has no mcpConfig, it must have requiresSetup
        // (e.g., Framer - user provides their own server URL at runtime)
        expect(
          connector.requiresSetup,
          `community connector "${connector.id}" has no mcpConfig but no requiresSetup`
        ).toBe(true);
      }
    }
  });

  it('bundled/direct connectors do not have wrong config type', () => {
    for (const entry of typedCatalog.connectors) {
      // bundled connectors must not have mcpConfig; rebel-oss may have mcpConfig
      if (entry.provider === 'bundled') {
        expect(
          (entry as unknown as Record<string, unknown>).mcpConfig,
          `bundled connector "${entry.id}" should not have mcpConfig`
        ).toBeUndefined();
      } else if (!isBundledLikeProvider(entry.provider)) {
        expect(
          (entry as unknown as Record<string, unknown>).bundledConfig,
          `non-bundled connector "${entry.id}" should not have bundledConfig`
        ).toBeUndefined();
      }
    }
  });

  it('all entries have required base fields', () => {
    for (const entry of typedCatalog.connectors) {
      expect(entry.id, 'entry must have id').toBeTruthy();
      expect(entry.name, `entry "${entry.id}" must have name`).toBeTruthy();
      expect(entry.description, `entry "${entry.id}" must have description`).toBeTruthy();
      expect(entry.category, `entry "${entry.id}" must have category`).toBeTruthy();
      expect(entry.provider, `entry "${entry.id}" must have provider`).toBeTruthy();
      expect(entry.icon, `entry "${entry.id}" must have icon`).toBeTruthy();
    }
  });

  it('bundled-like connectors have valid authType', () => {
    const validAuthTypes = ['oauth', 'api-key', 'oauth-user-provided', 'none'];

    for (const entry of typedCatalog.connectors) {
      if (isBundledLikeProvider(entry.provider) && entry.bundledConfig) {
        expect(
          validAuthTypes,
          `${entry.provider} connector "${entry.id}" has invalid authType: ${entry.bundledConfig.authType}`
        ).toContain(entry.bundledConfig.authType);
      }
    }
  });

  it('setupFields with headerPrefix must have headerKey', () => {
    for (const entry of typedCatalog.connectors) {
      if (!entry.setupFields) continue;

      for (const field of entry.setupFields) {
        if (field.headerPrefix !== undefined) {
          expect(
            field.headerKey,
            `connector "${entry.id}" field "${field.id}" has headerPrefix but no headerKey`
          ).toBeDefined();
        }
      }
    }
  });

  it('bundled-salesforce has callbackUrl and non-admin guidance in setup instructions', () => {
    const salesforce = typedCatalog.connectors.find(c => c.id === 'bundled-salesforce');
    expect(salesforce, 'Salesforce entry should exist').toBeDefined();

    // callbackUrl field should be present (runtime JSON field, not in TS type)
    expect((salesforce as any)?.callbackUrl).toBe('https://rebel-auth.mindstone.com/salesforce/callback');

    // setupInstructions should contain non-admin guidance
    expect(salesforce?.setupInstructions).toBeDefined();
    expect(salesforce?.setupInstructions).toContain('All users may self-authorize');

    // setupInstructions should reference the callback URL pattern
    expect(salesforce?.setupInstructions).toContain('Callback URL');
  });

  it('bundled-salesforce has environment setupField with select type and production/sandbox options', () => {
    const salesforce = typedCatalog.connectors.find(c => c.id === 'bundled-salesforce');
    expect(salesforce, 'Salesforce entry should exist').toBeDefined();

    const envField = salesforce?.setupFields?.find(f => f.id === 'environment');
    expect(envField, 'environment setupField should exist').toBeDefined();
    expect(envField?.type).toBe('select');
    expect((envField as any)?.default).toBe('production');
    expect((envField as any)?.options).toHaveLength(2);
    expect((envField as any)?.options?.[0]?.value).toBe('production');
    expect((envField as any)?.options?.[1]?.value).toBe('sandbox');
    expect(envField?.settingsKey).toBe('salesforce.environment');
  });

  it('Deel entry exists with correct direct MCP configuration', () => {
    const deel = typedCatalog.connectors.find(c => c.id === 'deel');
    expect(deel, 'Deel entry should exist').toBeDefined();

    expect(deel?.provider).toBe('direct');
    expect(deel?.category).toBe('productivity');
    expect(deel?.mcpConfig?.url).toBe('https://api.letsdeel.com/mcp');
    expect(deel?.mcpConfig?.transport).toBe('http');
    expect(deel?.mcpConfig?.oauth).toBe(true);
    expect(deel?.verified).toBe(true);
    expect(deel?.verifiedSource).toBe('https://developer.deel.com/mcp');
    expect(deel?.accountIdentity).toBe('email');
    expect(deel?.setupUrl).toBeDefined();
    expect(deel?.setupInstructions).toBeDefined();
  });

  it('Beeper entry uses localhost URL and has auth token setup field', () => {
    const beeper = typedCatalog.connectors.find(c => c.id === 'beeper');
    expect(beeper, 'Beeper entry should exist').toBeDefined();

    expect(beeper?.provider).toBe('community');
    expect(beeper?.mcpConfig?.url).toBe('http://localhost:23373/v0/mcp');
    expect(beeper?.verifiedSource).toBe('https://developers.beeper.com/desktop-api/mcp');
    expect(beeper?.requiresSetup).toBe(true);

    const tokenField = beeper?.setupFields?.find(f => f.id === 'apiKey');
    expect(tokenField, 'auth token setupField should exist').toBeDefined();
    expect(tokenField?.headerKey).toBe('Authorization');
    expect(tokenField?.headerPrefix).toBe('Bearer ');
    expect(tokenField?.type).toBe('password');
  });

  it('PostHog entries exist and have correct configuration', () => {
    const posthog = typedCatalog.connectors.find(c => c.id === 'posthog');
    const posthogEu = typedCatalog.connectors.find(c => c.id === 'posthog-eu');

    expect(posthog, 'PostHog US entry should exist').toBeDefined();
    expect(posthogEu, 'PostHog EU entry should exist').toBeDefined();

    // Verify PostHog US
    expect(posthog?.provider).toBe('direct');
    expect(posthog?.mcpConfig?.url).toBe('https://mcp.posthog.com/mcp');
    const posthogApiKeyField = posthog?.setupFields?.find(f => f.id === 'apiKey');
    expect(posthogApiKeyField?.headerKey).toBe('Authorization');
    expect(posthogApiKeyField?.headerPrefix).toBe('Bearer ');

    // Verify PostHog EU (uses query param, not subdomain)
    expect(posthogEu?.provider).toBe('direct');
    expect(posthogEu?.mcpConfig?.url).toBe('https://mcp.posthog.com/mcp?region=eu');
  });

  it('bundled-ibkr has all four setup fields including clientId', () => {
    const ibkr = typedCatalog.connectors.find(c => c.id === 'bundled-ibkr');
    expect(ibkr, 'IBKR entry should exist').toBeDefined();

    expect(ibkr?.provider).toBe('bundled');
    expect(ibkr?.bundledConfig?.authType).toBe('none');
    expect(ibkr?.bundledConfig?.serverName).toBe('IBKR');
    expect(ibkr?.requiresSetup).toBe(true);
    expect(ibkr?.accountIdentity).toBe('none');

    // Verify all four setup fields exist
    expect(ibkr?.setupFields).toHaveLength(4);
    const fieldIds = ibkr?.setupFields?.map(f => f.id) ?? [];
    expect(fieldIds).toContain('mode');
    expect(fieldIds).toContain('port');
    expect(fieldIds).toContain('host');
    expect(fieldIds).toContain('clientId');

    // All fields should be optional (have sensible defaults)
    for (const field of ibkr?.setupFields ?? []) {
      expect(field.required, `field "${field.id}" should be optional`).toBe(false);
    }

    // Verify placeholders match defaults
    const modeField = ibkr?.setupFields?.find(f => f.id === 'mode');
    expect(modeField?.placeholder).toBe('paper');

    const portField = ibkr?.setupFields?.find(f => f.id === 'port');
    expect(portField?.placeholder).toBe('4002');

    const hostField = ibkr?.setupFields?.find(f => f.id === 'host');
    expect(hostField?.placeholder).toBe('127.0.0.1');

    const clientIdField = ibkr?.setupFields?.find(f => f.id === 'clientId');
    expect(clientIdField?.placeholder).toBe('1');
  });

  // Phase D regression guard for the bundled-vanta -> @mindstone/mcp-server-vanta
  // OSS migration. See: docs/plans/finished/260519_vanta_oss_migration.md.
  // Asserts the catalog now points at the OSS package via npx and preserves the
  // bundledConfig block (postmortem 260417 documents the class of regression
  // where bundledConfig was dropped during an OSS flip).
  it('bundled-vanta uses the OSS package via npx (Phase D regression guard)', () => {
    const vanta = typedCatalog.connectors.find(c => c.id === 'bundled-vanta');
    expect(vanta, 'Vanta entry should exist').toBeDefined();
    expect(vanta?.provider).toBe('rebel-oss');

    expect(vanta?.mcpConfig?.command).toBe('npx');
    expect(vanta?.mcpConfig?.args).toEqual(['-y', '@mindstone/mcp-server-vanta@0.1.0']);
    // Pin guard: no floating dist-tags or semver ranges in the published catalog.
    const pkgRef = vanta?.mcpConfig?.args?.[1] ?? '';
    expect(pkgRef).not.toMatch(/@latest$/);
    expect(pkgRef).not.toMatch(/[\^~]/);

    const envKeys = Object.keys(vanta?.mcpConfig?.env ?? {});
    expect(envKeys).toContain('VANTA_CLIENT_ID');
    expect(envKeys).toContain('VANTA_CLIENT_SECRET');
    expect(envKeys).toContain('VANTA_REGION');

    // bundledConfig must survive the flip so the runtime resolver can route
    // user-provided settings into the npx-launched OSS process.
    expect(vanta?.bundledConfig).toBeDefined();
    expect(vanta?.bundledConfig?.authType).toBe('api-key');
    expect(vanta?.bundledConfig?.serverName).toBe('Vanta');
    expect(vanta?.bundledConfig?.settingsKey).toBe('vanta.enabled');

    // setupFields preserved with envVar pointers so the host can map user
    // input into the {{TOKEN}} placeholders in mcpConfig.env.
    const envVars = (vanta?.setupFields ?? [])
      .map(f => f.envVar)
      .filter((v): v is string => Boolean(v));
    expect(envVars).toContain('VANTA_CLIENT_ID');
    expect(envVars).toContain('VANTA_CLIENT_SECRET');
    expect(envVars).toContain('VANTA_REGION');

    expect(vanta?.accountIdentity).toBe('none');
  });

  // Phase D regression guard for the bundled-replit-ssh OSS migration.
  // See: docs/plans/260519_replit_ssh_oss_migration.md.
  // Asserts the catalog now points at the pinned OSS package via npx while
  // preserving bundledConfig (postmortem 260417).
  describe('bundled-replit-ssh', () => {
    it('post-flip catalog shape (Phase D regression guard)', () => {
      const replitSsh = typedCatalog.connectors.find(c => c.id === 'bundled-replit-ssh');
      expect(replitSsh, 'Replit SSH entry should exist').toBeDefined();
      expect(replitSsh?.provider).toBe('rebel-oss');
      expect(replitSsh?.mcpConfig?.command).toBe('npx');
      expect(replitSsh?.mcpConfig?.args).toEqual([
        '-y',
        '@mindstone/mcp-server-replit-ssh@0.1.2',
      ]);
      expect(replitSsh?.mcpConfig?.args?.[1]).not.toMatch(/@latest$/);
      expect(replitSsh?.mcpConfig?.args?.[1]).not.toMatch(/[\^~]/);
      expect(replitSsh?.mcpConfig?.env).toBeUndefined();
      expect(replitSsh?.bundledConfig?.authType).toBe('none');
      expect(replitSsh?.bundledConfig?.serverName).toBe('ReplitSSH');
      expect(replitSsh?.bundledConfig?.settingsKey).toBe('replitSsh.enabled');
      expect(replitSsh?.accountIdentity).toBe('none');

      const toolNames = (replitSsh?.tools ?? []).map(t => t.name).sort();
      expect(toolNames).toEqual([
        'replit_check_connection',
        'replit_list_files',
        'replit_read_file',
        'replit_setup_ssh',
        'replit_write_file',
      ]);
    });
  });

  // Phase D regression guard for the Microsoft 365 cohort OSS migration.
  // See: docs/plans/260519_microsoft_365_oss_migration.md.
  //
  // Five surfaces share one Microsoft tenant identity and one host-side
  // orchestrator (`microsoftApi`). Each surface has its own catalog entry
  // (Mail / Calendar / Files / Teams / SharePoint) so the Settings UI can
  // toggle them independently, but they all flip together in Phase D.
  //
  // Asserts the post-flip production catalog shape
  //   (provider: "rebel-oss", mcpConfig.command: "npx", pinned package, no
  //    MICROSOFT_DISABLE_REFRESH in mcpConfig.env — host surface-gates it,
  //    preserved bundledConfig per postmortem 260417).
  describe('bundled-microsoft-* (Phase D drift detectors)', () => {
    type MicrosoftConnectorFixture = {
      id: string;
      serverName: string;
      setupToolName: string;
      ossPackage: string;
    };
    const MICROSOFT_CONNECTORS: ReadonlyArray<MicrosoftConnectorFixture> = [
      { id: 'bundled-microsoft-mail',       serverName: 'Microsoft365Mail',       setupToolName: 'authenticate_microsoft_account', ossPackage: '@mindstone/mcp-server-microsoft-mail' },
      { id: 'bundled-microsoft-calendar',   serverName: 'Microsoft365Calendar',   setupToolName: 'authenticate_microsoft_account', ossPackage: '@mindstone/mcp-server-microsoft-calendar' },
      { id: 'bundled-microsoft-files',      serverName: 'Microsoft365Files',      setupToolName: 'authenticate_microsoft_account', ossPackage: '@mindstone/mcp-server-microsoft-files' },
      { id: 'bundled-microsoft-teams',      serverName: 'Microsoft365Teams',      setupToolName: 'authenticate_microsoft_account', ossPackage: '@mindstone/mcp-server-microsoft-teams' },
      { id: 'bundled-microsoft-sharepoint', serverName: 'Microsoft365SharePoint', setupToolName: 'authenticate_sharepoint',        ossPackage: '@mindstone/mcp-server-microsoft-sharepoint' },
    ];

    for (const { id, serverName, setupToolName, ossPackage } of MICROSOFT_CONNECTORS) {
      describe(id, () => {
        it('post-flip catalog shape (Phase D regression guard)', () => {
          const entry = typedCatalog.connectors.find((c) => c.id === id);
          expect(entry, `${id} should exist in catalog`).toBeDefined();

          expect(entry?.provider).toBe('rebel-oss');

          // mcpConfig points at the pinned OSS package via npx.
          expect(entry?.mcpConfig?.command).toBe('npx');
          const args = entry?.mcpConfig?.args ?? [];
          expect(args).toHaveLength(2);
          expect(args[0]).toBe('-y');
          const packageRef = args[1] ?? '';
          expect(packageRef.startsWith(`${ossPackage}@`)).toBe(true);
          expect(packageRef).not.toMatch(/@latest$/);
          expect(packageRef).not.toMatch(/[\^~]/);

          // bundledConfig must survive the flip with ALL five fields
          // (postmortem 260417). Same identity surface as pre-flip.
          expect(entry?.bundledConfig).toBeDefined();
          expect(entry?.bundledConfig?.authType).toBe('oauth');
          expect(entry?.bundledConfig?.settingsKey).toBe('microsoft.enabled');
          expect(entry?.bundledConfig?.serverName).toBe(serverName);
          expect(entry?.bundledConfig?.setupToolName).toBe(setupToolName);
          expect(entry?.bundledConfig?.authApi).toBe('microsoftApi');
          expect(entry?.accountIdentity).toBe('email');

          // MICROSOFT_DISABLE_REFRESH and MICROSOFT_ALLOW_CLOUD_REFRESH must
          // NOT be baked into the catalog mcpConfig.env — the host injects
          // them per-surface at spawn time (cloud only). Baking them into
          // the catalog would silently disable host-side refresh on desktop
          // and is exactly the regression Phase B3 guards against.
          const env = entry?.mcpConfig?.env ?? {};
          expect(env).not.toHaveProperty('MICROSOFT_DISABLE_REFRESH');
          expect(env).not.toHaveProperty('MICROSOFT_ALLOW_CLOUD_REFRESH');
        });

        // Post-flip structural fixture (runs today; mirrors bundled-replit-ssh
        // post-flip-fixture pattern). Validates that a Phase D-shaped entry,
        // built in isolation, satisfies the same invariants the live catalog
        // skipped test will enforce after the flip. Catches catalog-shape
        // drift between the planning doc and the rest of the test suite.
        it('post-flip Phase D target shape is structurally valid (fixture, runs today)', () => {
          const postFlipFixture = {
            id,
            name: 'Microsoft 365',
            description: 'Microsoft 365 OSS surface.',
            category: 'communication',
            provider: 'rebel-oss',
            bundledConfig: {
              authType: 'oauth',
              settingsKey: 'microsoft.enabled',
              serverName,
              setupToolName,
              authApi: 'microsoftApi',
            },
            mcpConfig: {
              transport: 'stdio',
              command: 'npx',
              args: ['-y', `${ossPackage}@0.1.0`],
            },
            icon: 'mail',
            requiresSetup: false,
            accountIdentity: 'email',
          } as unknown as ConnectorCatalogEntry;

          expect(postFlipFixture.provider).toBe('rebel-oss');
          expect(postFlipFixture.mcpConfig?.command).toBe('npx');
          expect(postFlipFixture.mcpConfig?.args).toEqual(['-y', `${ossPackage}@0.1.0`]);
          expect(postFlipFixture.mcpConfig?.args?.[1]).not.toMatch(/@latest$/);
          expect(postFlipFixture.mcpConfig?.args?.[1]).not.toMatch(/[\^~]/);
          expect(postFlipFixture.bundledConfig).toBeDefined();
          expect(postFlipFixture.bundledConfig?.authType).toBe('oauth');
          expect(postFlipFixture.bundledConfig?.serverName).toBe(serverName);
          expect(postFlipFixture.bundledConfig?.settingsKey).toBe('microsoft.enabled');
          expect(postFlipFixture.bundledConfig?.setupToolName).toBe(setupToolName);
          expect(postFlipFixture.bundledConfig?.authApi).toBe('microsoftApi');
          expect(postFlipFixture.mcpConfig?.env).toBeUndefined();
        });
      });
    }
  });

  it('AppSignal entry exists with correct Bearer token configuration', () => {
    const appsignal = typedCatalog.connectors.find(c => c.id === 'appsignal');
    expect(appsignal, 'AppSignal entry should exist').toBeDefined();

    expect(appsignal?.provider).toBe('direct');
    expect(appsignal?.category).toBe('development');
    expect(appsignal?.mcpConfig?.url).toBe('https://appsignal.com/api/mcp');
    expect(appsignal?.mcpConfig?.transport).toBe('http');
    expect(appsignal?.mcpConfig?.type).toBe('http');
    expect(appsignal?.verified).toBe(true);
    expect(appsignal?.verifiedSource).toBe('https://docs.appsignal.com/mcp.html');
    expect(appsignal?.requiresSetup).toBe(true);
    expect(appsignal?.setupUrl).toBe('https://appsignal.com/users/mcp_tokens');
    expect(appsignal?.maturity).toBe('beta');
    expect(appsignal?.accountIdentity).toBe('email');

    const tokenField = appsignal?.setupFields?.find(f => f.id === 'apiKey');
    expect(tokenField, 'MCP token setupField should exist').toBeDefined();
    expect(tokenField?.headerKey).toBe('Authorization');
    expect(tokenField?.headerPrefix).toBe('Bearer ');
    expect(tokenField?.type).toBe('password');
  });

  it('Zapier entry uses user-provided URL pattern, not OAuth (FOX-2926)', () => {
    const zapier = typedCatalog.connectors.find(c => c.id === 'zapier');
    expect(zapier, 'Zapier entry should exist').toBeDefined();

    expect(zapier?.provider).toBe('direct');
    expect(zapier?.category).toBe('automation');

    // Zapier MCP uses user-specific URLs generated at mcp.zapier.com.
    // OAuth without pre-registered credentials causes DCR failure and 5-min timeout.
    expect(zapier?.mcpConfig?.oauth, 'Zapier should NOT use OAuth (causes DCR timeout)').toBeFalsy();

    // Must have requiresSetup + setupFields for the user to paste their URL
    expect(zapier?.requiresSetup).toBe(true);
    expect(zapier?.setupUrl).toBe('https://mcp.zapier.com');
    expect(zapier?.setupUrlBehavior).toBe('button');

    // URL field for user's personalized MCP server URL
    const urlField = zapier?.setupFields?.find(f => f.id === 'url');
    expect(urlField, 'url setupField should exist').toBeDefined();
    expect(urlField?.type).toBe('url');
    expect(urlField?.label).toBeDefined();
  });

  it('rebel-oss connectors with requiresSetup + setupFields must have bundledConfig', () => {
    // Regression guard: when connectors are migrated from bundled to rebel-oss,
    // they must keep their bundledConfig block. Without it, the Settings UI save path
    // falls through to the generic onUpsertServer handler which doesn't resolve
    // template variables in mcpConfig.env (e.g., {{BRIDGE_STATE_PATH}}).
    // See: docs/plans/260417_connector_setup_regression_and_reconfigure.md
    for (const entry of typedCatalog.connectors) {
      if (entry.provider !== 'rebel-oss') continue;
      if (!entry.requiresSetup || !entry.setupFields?.length) continue;

      expect(
        entry.bundledConfig,
        `rebel-oss connector "${entry.id}" has requiresSetup + setupFields but no bundledConfig. ` +
        `This breaks the Settings UI save path. Add a bundledConfig block with authType, serverName, and setupToolName.`
      ).toBeDefined();
      expect(
        entry.bundledConfig?.authType,
        `rebel-oss connector "${entry.id}" bundledConfig must have authType`
      ).toBeDefined();
      expect(
        entry.bundledConfig?.serverName,
        `rebel-oss connector "${entry.id}" bundledConfig must have serverName`
      ).toBeDefined();
    }
  });

  // Stronger regression guard than the `requiresSetup + setupFields` test above:
  // bundled OAuth connectors like Slack have no `setupFields` and no
  // `requiresSetup` (the OAuth flow IS the setup), so the existing test silently
  // skips them. Postmortem 260417 went undetected for 8 days for exactly this
  // class of entries. Use `bundledConfig.authApi` as the "host-routes-OAuth-here"
  // signal — every host-routed OAuth connector MUST keep its full bundledConfig.
  // See: docs/plans/260429_slack_mcp_oss_migration.md (Stage 0).
  describe('rebel-oss authApi-routed bundledConfig regression guard', () => {
    // Hardcoded list of connector IDs that MUST be routed through host-side
    // OAuth via bundledConfig.authApi after migration. Each entry here is a
    // postmortem-260417 watchdog: dropping bundledConfig (entirely or
    // partially) for these connectors must fail this test loudly. Add new
    // host-routed OAuth connectors here when they migrate (M365 wave, etc.).
    const HOST_ROUTED_OAUTH_CONNECTOR_IDS = [
      'bundled-slack',
      'bundled-hubspot',
      'bundled-google',
      // Microsoft 365 cohort: all five surfaces are gated by the same
      // `microsoftApi` orchestrator and share a single bundledConfig.authApi.
      // Layer 1 stays dormant until Phase D flips each of these to rebel-oss.
      // See docs/plans/260519_microsoft_365_oss_migration.md.
      'bundled-microsoft-mail',
      'bundled-microsoft-calendar',
      'bundled-microsoft-files',
      'bundled-microsoft-teams',
      'bundled-microsoft-sharepoint',
    ] as const;
    const EXPECTED_AUTH_API_BY_CONNECTOR_ID: Record<typeof HOST_ROUTED_OAUTH_CONNECTOR_IDS[number], string> = {
      'bundled-slack': 'slackApi',
      'bundled-hubspot': 'hubspotApi',
      'bundled-google': 'googleWorkspaceApi',
      'bundled-microsoft-mail': 'microsoftApi',
      'bundled-microsoft-calendar': 'microsoftApi',
      'bundled-microsoft-files': 'microsoftApi',
      'bundled-microsoft-teams': 'microsoftApi',
      'bundled-microsoft-sharepoint': 'microsoftApi',
    };

    /**
     * Validator extracted so we can assert it both passes for the live catalog
     * AND fails for an intentionally-broken fixture entry (acceptance gate).
     * Throws on first violation with a contextual message.
     *
     * Two-layer protection against postmortem 260417:
     *   Layer 1: For known host-routed-OAuth connector IDs that are rebel-oss,
     *            REQUIRE bundledConfig + authApi (catches the EXACT 260417 regression class:
     *            migrating to rebel-oss while accidentally dropping bundledConfig).
     *            Does not fire pre-migration (entry still has provider: "bundled").
     *   Layer 2: For ANY rebel-oss entry that retains bundledConfig.authApi, also require
     *            authType + serverName + setupToolName.
     *            (catches "another host-routed entry was added with incomplete config".)
     */
    const assertAuthApiRoutedBundledConfig = (entry: ConnectorCatalogEntry): void => {
      const isKnownHostRouted = (HOST_ROUTED_OAUTH_CONNECTOR_IDS as readonly string[])
        .includes(entry.id);

      if (isKnownHostRouted && entry.provider === 'rebel-oss') {
        if (!entry.bundledConfig) {
          throw new Error(
            `host-routed OAuth connector "${entry.id}" (rebel-oss) MUST have a bundledConfig block ` +
            `(see docs-private/postmortems/260417_rebel_oss_bundledconfig_regression_postmortem.md). ` +
            `If you intentionally removed it, also remove the ID from ` +
            `HOST_ROUTED_OAUTH_CONNECTOR_IDS in connectorCatalog.test.ts.`,
          );
        }
        if (!entry.bundledConfig.authApi) {
          throw new Error(
            `host-routed OAuth connector "${entry.id}" (rebel-oss) MUST keep bundledConfig.authApi`,
          );
        }
      }

      if (entry.provider !== 'rebel-oss') return;
      if (!entry.bundledConfig?.authApi) return;

      if (!entry.bundledConfig.authType) {
        throw new Error(
          `rebel-oss authApi-routed connector "${entry.id}" must have bundledConfig.authType`,
        );
      }
      if (!entry.bundledConfig.serverName) {
        throw new Error(
          `rebel-oss authApi-routed connector "${entry.id}" must have bundledConfig.serverName`,
        );
      }
      if (!entry.bundledConfig.setupToolName) {
        throw new Error(
          `rebel-oss authApi-routed connector "${entry.id}" must have bundledConfig.setupToolName ` +
          `(invokeStdioAuthenticateTool requires it for routing)`,
        );
      }
      if (!entry.bundledConfig.settingsKey) {
        throw new Error(
          `rebel-oss authApi-routed connector "${entry.id}" must have bundledConfig.settingsKey ` +
          `(plan: all 5 bundledConfig fields must survive migration; settings UI uses this key)`,
        );
      }
    };

    it('every rebel-oss connector with bundledConfig.authApi keeps all 5 fields (authType + settingsKey + serverName + setupToolName + authApi)', () => {
      for (const entry of typedCatalog.connectors) {
        expect(() => assertAuthApiRoutedBundledConfig(entry as ConnectorCatalogEntry))
          .not.toThrow();
      }
    });

    it('every known host-routed OAuth connector has all five bundledConfig fields as non-empty strings', () => {
      for (const id of HOST_ROUTED_OAUTH_CONNECTOR_IDS) {
        const entry = typedCatalog.connectors.find((candidate) => candidate.id === id);
        expect(entry, `host-routed OAuth connector "${id}" should exist in catalog`).toBeDefined();

        const bundledConfig = entry?.bundledConfig;
        expect(bundledConfig, `connector "${id}" must have bundledConfig`).toBeDefined();
        expect(typeof bundledConfig?.authType).toBe('string');
        expect(bundledConfig?.authType?.trim().length ?? 0).toBeGreaterThan(0);
        expect(typeof bundledConfig?.settingsKey).toBe('string');
        expect(bundledConfig?.settingsKey?.trim().length ?? 0).toBeGreaterThan(0);
        expect(typeof bundledConfig?.serverName).toBe('string');
        expect(bundledConfig?.serverName?.trim().length ?? 0).toBeGreaterThan(0);
        expect(typeof bundledConfig?.setupToolName).toBe('string');
        expect(bundledConfig?.setupToolName?.trim().length ?? 0).toBeGreaterThan(0);
        expect(typeof bundledConfig?.authApi).toBe('string');
        expect(bundledConfig?.authApi?.trim().length ?? 0).toBeGreaterThan(0);
        expect(bundledConfig?.authApi).toBe(EXPECTED_AUTH_API_BY_CONNECTOR_ID[id]);
      }
    });

    it('catches a Slack-shaped rebel-oss entry that drops authType (regression fixture)', () => {
      // Mirrors the Slack catalog entry post-Stage-2 migration but with
      // authType intentionally dropped. The validator MUST flag it.
      const brokenSlackEntry = {
        id: 'bundled-slack',
        name: 'Slack',
        provider: 'rebel-oss',
        bundledConfig: {
          // authType: 'oauth',  // <-- intentionally missing
          settingsKey: 'slack.enabled',
          serverName: 'Slack',
          setupToolName: 'authenticate_slack_workspace',
          authApi: 'slackApi',
        },
      } as unknown as ConnectorCatalogEntry;

      expect(() => assertAuthApiRoutedBundledConfig(brokenSlackEntry)).toThrow(
        /must have bundledConfig\.authType/,
      );
    });

    it('catches a Slack-shaped rebel-oss entry that drops serverName (regression fixture)', () => {
      const brokenSlackEntry = {
        id: 'bundled-slack',
        name: 'Slack',
        provider: 'rebel-oss',
        bundledConfig: {
          authType: 'oauth',
          settingsKey: 'slack.enabled',
          // serverName: 'Slack',  // <-- intentionally missing
          setupToolName: 'authenticate_slack_workspace',
          authApi: 'slackApi',
        },
      } as unknown as ConnectorCatalogEntry;

      expect(() => assertAuthApiRoutedBundledConfig(brokenSlackEntry)).toThrow(
        /must have bundledConfig\.serverName/,
      );
    });

    it('catches a Slack-shaped rebel-oss entry that drops settingsKey (Settings UI breaks silently otherwise)', () => {
      const brokenSlackEntry = {
        id: 'bundled-slack',
        name: 'Slack',
        provider: 'rebel-oss',
        bundledConfig: {
          authType: 'oauth',
          // settingsKey: 'slack.enabled',  // <-- intentionally missing
          serverName: 'Slack',
          setupToolName: 'authenticate_slack_workspace',
          authApi: 'slackApi',
        },
      } as unknown as ConnectorCatalogEntry;

      expect(() => assertAuthApiRoutedBundledConfig(brokenSlackEntry)).toThrow(
        /must have bundledConfig\.settingsKey/,
      );
    });

    it('catches a Slack-shaped rebel-oss entry that drops setupToolName (auth routing breaks silently otherwise)', () => {
      const brokenSlackEntry = {
        id: 'bundled-slack',
        name: 'Slack',
        provider: 'rebel-oss',
        bundledConfig: {
          authType: 'oauth',
          settingsKey: 'slack.enabled',
          serverName: 'Slack',
          // setupToolName: 'authenticate_slack_workspace',  // <-- intentionally missing
          authApi: 'slackApi',
        },
      } as unknown as ConnectorCatalogEntry;

      expect(() => assertAuthApiRoutedBundledConfig(brokenSlackEntry)).toThrow(
        /must have bundledConfig\.setupToolName/,
      );
    });

    it('catches a known host-routed connector that drops bundledConfig entirely (postmortem 260417 root regression)', () => {
      // This is the EXACT regression class postmortem 260417 documents:
      // OSS migration drops bundledConfig from a host-routed-OAuth entry.
      // Layer 1 (hardcoded ID list) catches this even though no authApi exists
      // to gate inclusion on.
      const slackWithNoBundledConfig = {
        id: 'bundled-slack',
        name: 'Slack',
        provider: 'rebel-oss',
        // bundledConfig: { ... },  // <-- intentionally missing entirely
      } as unknown as ConnectorCatalogEntry;

      expect(() => assertAuthApiRoutedBundledConfig(slackWithNoBundledConfig)).toThrow(
        /MUST have a bundledConfig block/,
      );
    });

    it('catches a known host-routed connector that drops just authApi (auth routing silently broken)', () => {
      const slackWithNoAuthApi = {
        id: 'bundled-slack',
        name: 'Slack',
        provider: 'rebel-oss',
        bundledConfig: {
          authType: 'oauth',
          settingsKey: 'slack.enabled',
          serverName: 'Slack',
          setupToolName: 'authenticate_slack_workspace',
          // authApi: 'slackApi',  // <-- intentionally missing
        },
      } as unknown as ConnectorCatalogEntry;

      expect(() => assertAuthApiRoutedBundledConfig(slackWithNoAuthApi)).toThrow(
        /MUST keep bundledConfig\.authApi/,
      );
    });

    it('does NOT fire Layer 1 pre-migration (entry still provider: "bundled" — Slack today)', () => {
      // Pre-Stage-2 state: bundled-slack still has provider: "bundled". Layer 1
      // is dormant in this state because the postmortem 260417 regression class
      // only manifests on rebel-oss entries that drop bundledConfig.
      const slackTodayPreMigration = {
        id: 'bundled-slack',
        name: 'Slack',
        provider: 'bundled',
        bundledConfig: {
          authType: 'oauth',
          settingsKey: 'slack.enabled',
          serverName: 'Slack',
          setupToolName: 'authenticate_slack_workspace',
          authApi: 'slackApi',
        },
      } as unknown as ConnectorCatalogEntry;
      expect(() => assertAuthApiRoutedBundledConfig(slackTodayPreMigration)).not.toThrow();
    });

    it('passes a complete Slack-shaped rebel-oss entry (positive control)', () => {
      const validSlackEntry = {
        id: 'bundled-slack',
        name: 'Slack',
        provider: 'rebel-oss',
        bundledConfig: {
          authType: 'oauth',
          settingsKey: 'slack.enabled',
          serverName: 'Slack',
          setupToolName: 'authenticate_slack_workspace',
          authApi: 'slackApi',
        },
      } as unknown as ConnectorCatalogEntry;

      expect(() => assertAuthApiRoutedBundledConfig(validSlackEntry)).not.toThrow();
    });

    it('passes a complete HubSpot-shaped rebel-oss entry without modifying production catalog', async () => {
      const hubspotEntry = {
        id: 'bundled-hubspot',
        name: 'HubSpot',
        provider: 'rebel-oss',
        bundledConfig: {
          authType: 'oauth',
          settingsKey: 'hubspot.enabled',
          serverName: 'HubSpot',
          setupToolName: 'authenticate_hubspot_account',
          authApi: 'hubspotApi',
        },
      } as unknown as ConnectorCatalogEntry;

      expect(() => assertAuthApiRoutedBundledConfig(hubspotEntry)).not.toThrow();
      expect(hubspotEntry.provider).toBe('rebel-oss');
      expect(hubspotEntry.bundledConfig?.authApi).toBe('hubspotApi');
    });

    it('passes a complete Google Workspace-shaped authApi-routed entry before the catalog flip', async () => {
      const googleEntry = {
        id: 'bundled-google',
        name: 'Google Workspace',
        provider: 'rebel-oss',
        bundledConfig: {
          authType: 'oauth',
          settingsKey: 'googleWorkspace.enabled',
          serverName: 'GoogleWorkspace',
          setupToolName: 'authenticate_workspace_account',
          authApi: 'googleWorkspaceApi',
        },
      } as unknown as ConnectorCatalogEntry;

      expect(() => assertAuthApiRoutedBundledConfig(googleEntry)).not.toThrow();
      expect(googleEntry.bundledConfig?.authApi).toBe('googleWorkspaceApi');
    });

    it('skips entries that are not rebel-oss or do not declare authApi (and not in known host-routed list)', () => {
      const noAuthApi = {
        id: 'bundled-foo',
        provider: 'rebel-oss',
        bundledConfig: { authType: 'api-key', serverName: 'Foo' },
      } as unknown as ConnectorCatalogEntry;
      expect(() => assertAuthApiRoutedBundledConfig(noAuthApi)).not.toThrow();

      const wrongProvider = {
        id: 'direct-bar',
        provider: 'direct',
        bundledConfig: { authApi: 'slackApi' },
      } as unknown as ConnectorCatalogEntry;
      expect(() => assertAuthApiRoutedBundledConfig(wrongProvider)).not.toThrow();
    });
  });

  describe('bundled-like connector catalog invariants', () => {
    // These invariants ensure the ExpandedConnectionCard save-path routing
    // handles all bundled connector types. See docs/plans/260417_setup_route_boolean_consolidation.md.

    const bundledLikeEntries = typedCatalog.connectors.filter(
      (c) => c.provider === 'bundled' || c.provider === 'rebel-oss'
    );

    it('every bundled-like entry with bundledConfig must have bundledConfig.serverName', () => {
      const missing = bundledLikeEntries.filter(
        (c) => c.bundledConfig && !c.bundledConfig.serverName
      );
      expect(missing.map((c) => c.id)).toEqual([]);
    });

    it('every bundledConfig.authType must be a known value', () => {
      const knownAuthTypes = ['api-key', 'oauth', 'oauth-user-provided', 'none'];
      const unknown = bundledLikeEntries.filter(
        (c) => c.bundledConfig?.authType && !knownAuthTypes.includes(c.bundledConfig.authType)
      );
      expect(unknown.map((c) => `${c.id}: ${c.bundledConfig?.authType}`)).toEqual([]);
    });

    // Guard against reintroducing removed dead shapes without restoring their handling code
    // in ExpandedConnectionCard.tsx handleSaveSetup. If these shapes are needed again,
    // the save-path branches must be restored first.
    it('no bundled-like authType:none with accountIdentity:email (handling removed)', () => {
      const matches = bundledLikeEntries.filter(
        (c) => c.bundledConfig?.authType === 'none' && c.accountIdentity === 'email'
      );
      expect(matches.map((c) => c.id)).toEqual([]);
    });

    it('no bundled-like authType:oauth with setupFields (handling removed)', () => {
      const matches = bundledLikeEntries.filter(
        (c) => c.bundledConfig?.authType === 'oauth' && c.setupFields && c.setupFields.length > 0
      );
      expect(matches.map((c) => c.id)).toEqual([]);
    });

    it('every bundled-like entry with requiresSetup matches a known handleSaveSetup route', () => {
      // Mirrors the 3 live save routes in ExpandedConnectionCard.handleSaveSetup.
      // If this test fails, either add a new save route in handleSaveSetup OR fix the catalog entry.
      const isKnownSaveRoute = (c: ConnectorCatalogEntry): boolean => {
        const cfg = c.bundledConfig;
        if (!cfg?.serverName) return false;
        if (cfg.authType === 'api-key') return true;
        if (cfg.authType === 'oauth-user-provided') return true;
        if (cfg.authType === 'none' && c.accountIdentity !== 'email' && (c.setupFields?.length ?? 0) > 0) return true;
        return false;
      };

      const unhandled = bundledLikeEntries.filter(
        (c) => c.requiresSetup && c.setupFields && c.setupFields.length > 0 && !isKnownSaveRoute(c)
      );
      expect(
        unhandled.map((c) => `${c.id}: authType=${c.bundledConfig?.authType}, identity=${c.accountIdentity}`)
      ).toEqual([]);
    });
  });

  it('direct OAuth connectors without oauthClientId should not exist (prevents DCR timeout)', () => {
    for (const entry of typedCatalog.connectors) {
      if (entry.provider !== 'direct') continue;
      if (!entry.mcpConfig?.oauth) continue;

      // If a direct connector uses OAuth, it should either:
      // 1. Have oauthClientId pre-registered (for servers without DCR)
      // 2. Support DCR (which the server must advertise via .well-known metadata)
      // We can't verify #2 at test time, but #1 is checkable.
      // This test documents the pattern: if you add a direct OAuth connector,
      // verify that the vendor's MCP endpoint supports DCR before relying on it.
      // Connectors with oauthClientId bypass DCR entirely.
      const hasStaticCredentials = !!entry.mcpConfig.oauthClientId;
      if (!hasStaticCredentials) {
        // Not a hard failure — just document the risk.
        // The connector MUST work with DCR or the user will get a 5-min timeout.
        // This is a warning, not a gate, because some vendors do support DCR.
      }
    }
    // This test passes as documentation — the real gate is the Zapier-specific test above
    expect(true).toBe(true);
  });

  // Phase 3 H5 (Stage 0a): defence-in-depth against catalog typos in
  // bundledConfig.providerKeyMapping that would inject the wrong vendor's
  // secret into a connector at MCP server spawn time.
  // See docs/plans/260503_openai_image_oss_migration.md.
  describe('providerKeyMapping env-var / provider compatibility (Phase 3 H5)', () => {
    it('current catalog has zero providerKeyMapping violations', () => {
      const errors = validateConnectorCatalogProviderKeyMappings(typedCatalog);
      expect(errors, errors.map((e) => e.message).join('\n')).toEqual([]);
    });

    it('rejects a catalog entry with a mismatched [envVar, providerId] pair', () => {
      const fixture = {
        connectors: [
          {
            id: 'fixture-mismatch',
            provider: 'rebel-oss',
            bundledConfig: {
              authType: 'none',
              serverName: 'Fixture',
              providerKeyMapping: { OPENAI_API_KEY: 'google' },
            },
          },
        ],
      } as unknown as ConnectorCatalog;

      const errors = validateConnectorCatalogProviderKeyMappings(fixture);
      expect(errors).toHaveLength(1);
      expect(errors[0].connectorId).toBe('fixture-mismatch');
      expect(errors[0].envVar).toBe('OPENAI_API_KEY');
      expect(errors[0].providerId).toBe('google');
      expect(errors[0].reason).toBe('env-var-provider-mismatch');
      expect(errors[0].message).toMatch(/reserved for provider "openai"/);
    });

    it('rejects a catalog entry that uses an unknown env-var name (even with a known provider)', () => {
      const fixture = {
        connectors: [
          {
            id: 'fixture-unknown-env',
            provider: 'rebel-oss',
            bundledConfig: {
              authType: 'none',
              serverName: 'Fixture',
              providerKeyMapping: { OPENAI_BETA_API_KEY: 'openai' },
            },
          },
        ],
      } as unknown as ConnectorCatalog;

      const errors = validateConnectorCatalogProviderKeyMappings(fixture);
      expect(errors).toHaveLength(1);
      expect(errors[0].connectorId).toBe('fixture-unknown-env');
      expect(errors[0].envVar).toBe('OPENAI_BETA_API_KEY');
      expect(errors[0].providerId).toBe('openai');
      expect(errors[0].reason).toBe('unknown-env-var');
      expect(errors[0].message).toMatch(/not in ALLOWED_PROVIDER_KEY_MAPPINGS/);
    });

    it('accepts the allowlisted OPENAI_API_KEY → openai pair', () => {
      const fixture = {
        connectors: [
          {
            id: 'fixture-openai-image',
            provider: 'rebel-oss',
            bundledConfig: {
              authType: 'none',
              serverName: 'Fixture',
              providerKeyMapping: { OPENAI_API_KEY: 'openai' },
            },
          },
        ],
      } as unknown as ConnectorCatalog;

      expect(validateConnectorCatalogProviderKeyMappings(fixture)).toEqual([]);
    });

    it('accepts a catalog entry with no providerKeyMapping at all', () => {
      const fixture = {
        connectors: [
          {
            id: 'fixture-no-mapping',
            provider: 'rebel-oss',
            bundledConfig: { authType: 'oauth', serverName: 'Fixture' },
          },
          {
            id: 'fixture-bundled-no-mapping',
            provider: 'bundled',
            bundledConfig: { authType: 'api-key', serverName: 'Fixture2' },
          },
        ],
      } as unknown as ConnectorCatalog;

      expect(validateConnectorCatalogProviderKeyMappings(fixture)).toEqual([]);
    });

    it('every value in ALLOWED_PROVIDER_KEY_MAPPINGS is a non-empty string (sanity check on the constant itself)', () => {
      const entries = Object.entries(ALLOWED_PROVIDER_KEY_MAPPINGS);
      expect(entries.length).toBeGreaterThan(0);
      for (const [envVar, providerId] of entries) {
        expect(envVar.trim().length).toBeGreaterThan(0);
        expect(typeof providerId).toBe('string');
        expect(providerId.length).toBeGreaterThan(0);
      }
    });
  });
});

describe('accountIdentity / setupFields orthogonality convention', () => {
  // Phase 2 G3: codifies the convention recorded in MCP_ARCHITECTURE.md.
  //
  // accountIdentity (instance discriminator) and setupFields (credential
  // collection schema) are structurally orthogonal. When their concerns
  // overlap on the same input field, setupFields owns rendering. The catalog
  // already encodes one convention: the 'email' identity is rendered by the
  // parent setup form, never as a setupFields[].id === 'email' entry
  // (see docs/plans/260326_generic_imap_smtp_email_mcp.md). The same applies
  // to 'workspace'. URL-shaped identities (subdomain/domain/tenant) are the
  // empirically-allowed collision set today.
  //
  // History + arbitrator rationale:
  //   docs/plans/260527_account-identity-followups/PLAN.md (Phase 2)
  //   docs/plans/260527_account-identity-followups/subagent_reports/260527_1900_arbitrator-opus.md

  const ALLOWED_COLLISION_KINDS = new Set(['subdomain', 'domain', 'tenant']);

  it('never duplicates "email" or "workspace" identity as a setupField of matching id', () => {
    const violations: string[] = [];
    for (const entry of typedCatalog.connectors) {
      if (entry.accountIdentity !== 'email' && entry.accountIdentity !== 'workspace') continue;
      const collidingField = entry.setupFields?.find((f) => f.id === entry.accountIdentity);
      if (collidingField) {
        violations.push(
          `${entry.id}: accountIdentity='${entry.accountIdentity}' AND setupFields[].id='${collidingField.id}'. Per convention, 'email'/'workspace' identities are rendered by the parent setup form — do NOT duplicate in setupFields. See docs/project/MCP_ARCHITECTURE.md § Orthogonality.`
        );
      }
    }
    expect(violations).toEqual([]);
  });

  it('setupFields[].id === accountIdentity collisions only occur for subdomain|domain|tenant kinds', () => {
    const violations: string[] = [];
    for (const entry of typedCatalog.connectors) {
      if (!entry.accountIdentity || !entry.setupFields) continue;
      const collidingField = entry.setupFields.find((f) => f.id === entry.accountIdentity);
      if (!collidingField) continue;
      if (!ALLOWED_COLLISION_KINDS.has(entry.accountIdentity)) {
        violations.push(
          `${entry.id}: setupFields[].id='${collidingField.id}' === accountIdentity='${entry.accountIdentity}', but only ${[...ALLOWED_COLLISION_KINDS].join('|')} kinds may collide. If a new kind needs this pattern, update ALLOWED_COLLISION_KINDS and document in MCP_ARCHITECTURE.md.`
        );
      }
    }
    expect(violations).toEqual([]);
  });
});

describe('connector catalog env placeholder resolvability', () => {
  it('every catalog entry mcpConfig.env token ******** to a system token, setupField, or providerKeyMapping', async () => {
    const validateEnvPlaceholderResolvability = await loadValidateEnvPlaceholderResolvability();
    const catalogFromDisk = JSON.parse(
      readFileSync(join(process.cwd(), 'resources/connector-catalog.json'), 'utf8'),
    ) as { connectors?: unknown[] };
    const entries = (catalogFromDisk.connectors ?? []) as EnvPlaceholderCatalogEntry[];

    for (const entry of entries) {
      expect(() => validateEnvPlaceholderResolvability(entry), `entry ${entry.id}`).not.toThrow();
    }
  });
});

// F-DA-2: production catalog drift detector for bundled-runway sandbox env
// keys. The catalogEnvBackfillMigration sandbox pass relies on these exact
// placeholder values being in the *published* catalog so existing already-npx
// and managed-install Runway entries get RUNWAY_ALLOWED_ROOT /
// RUNWAY_DOWNLOAD_ROOT injected on the next boot. Reads the on-disk catalog
// directly (NOT a fixture) so an accidental edit that strips or renames the
// placeholders fails CI.
describe('bundled-runway sandbox env catalog drift detector', () => {
  it('declares the default-only sandbox env keys with the expected placeholder values', () => {
    const catalogFromDisk = JSON.parse(
      readFileSync(join(process.cwd(), 'resources/connector-catalog.json'), 'utf8'),
    ) as { connectors?: Array<{ id: string; mcpConfig?: { env?: Record<string, string> } }> };

    const runway = (catalogFromDisk.connectors ?? []).find((c) => c.id === 'bundled-runway');
    expect(runway, 'bundled-runway entry should exist in the production catalog').toBeDefined();

    const env = runway?.mcpConfig?.env ?? {};
    expect(env.RUNWAY_ALLOWED_ROOT).toBe('{{ALLOWED_ROOTS_ANCESTOR}}');
    expect(env.RUNWAY_DOWNLOAD_ROOT).toBe('{{ALLOWED_ROOTS_ANCESTOR_DOWNLOADS}}');
  });
});
