import { describe, it, expect } from 'vitest';
import catalogData from '../../../../resources/connector-catalog.json';
import type { ConnectorCatalog } from '@shared/types';
import {
  findConnectorsForUrl,
  findCatalogEntry,
  getServerDescription,
  getServerDescriptionWithEmail,
  getServerDisplayName,
  isKnownServer,
} from '../connectorCatalogService';

const catalog = catalogData as ConnectorCatalog;

describe('connectorCatalogService', () => {
  describe('findCatalogEntry', () => {
    describe('Step 1: exact match on bundledConfig.serverName', () => {
      it('matches bundled Slack by serverName', () => {
        const entry = findCatalogEntry('Slack');
        expect(entry).toBeDefined();
        expect(entry?.id).toBe('bundled-slack');
        expect(entry?.bundledConfig?.serverName).toBe('Slack');
      });

      it('matches bundled GoogleWorkspace by serverName', () => {
        const entry = findCatalogEntry('GoogleWorkspace');
        expect(entry).toBeDefined();
        expect(entry?.id).toBe('bundled-google');
        expect(entry?.bundledConfig?.serverName).toBe('GoogleWorkspace');
      });

      it('matches bundled Microsoft365Mail by serverName', () => {
        const entry = findCatalogEntry('Microsoft365Mail');
        expect(entry).toBeDefined();
        expect(entry?.id).toBe('bundled-microsoft-mail');
      });

      it('matches bundled HubSpot by serverName', () => {
        const entry = findCatalogEntry('HubSpot');
        expect(entry).toBeDefined();
        expect(entry?.id).toBe('bundled-hubspot');
      });

      it('matches bundled Fathom by serverName', () => {
        const entry = findCatalogEntry('Fathom');
        expect(entry).toBeDefined();
        expect(entry?.id).toBe('bundled-fathom');
      });
    });

    describe('Step 2: normalized fallback', () => {
      it('matches sentry by normalized ID', () => {
        const entry = findCatalogEntry('sentry');
        expect(entry).toBeDefined();
        expect(entry?.id).toBe('sentry');
      });

      it('matches notion by normalized ID', () => {
        const entry = findCatalogEntry('notion');
        expect(entry).toBeDefined();
        expect(entry?.id).toBe('notion');
      });

      it('matches linear by normalized ID', () => {
        const entry = findCatalogEntry('linear');
        expect(entry).toBeDefined();
        expect(entry?.id).toBe('linear');
      });

      it('handles case insensitivity', () => {
        const entry1 = findCatalogEntry('NOTION');
        const entry2 = findCatalogEntry('Notion');
        const entry3 = findCatalogEntry('notion');
        expect(entry1?.id).toBe('notion');
        expect(entry2?.id).toBe('notion');
        expect(entry3?.id).toBe('notion');
      });

      it('handles hyphens in normalized matching', () => {
        // 'figma-desktop' is in the catalog, 'figmadesktop' should match via normalization
        const entry = findCatalogEntry('figmadesktop');
        expect(entry).toBeDefined();
        expect(entry?.id).toBe('figma-desktop');
      });

      it('handles underscores in normalized matching', () => {
        // 'figma_desktop' should normalize to match 'figma-desktop'
        const entry = findCatalogEntry('figma_desktop');
        expect(entry).toBeDefined();
        expect(entry?.id).toBe('figma-desktop');
      });
    });

    describe('Step 3: affix-stripped fuzzy match', () => {
      it('matches "perplexity-mcp" to catalog id "perplexity"', () => {
        const entry = findCatalogEntry('perplexity-mcp');
        expect(entry).toBeDefined();
        expect(entry?.id).toBe('perplexity');
      });

      it('matches "Perplexity-MCP" to catalog id "perplexity" (case-insensitive)', () => {
        const entry = findCatalogEntry('Perplexity-MCP');
        expect(entry).toBeDefined();
        expect(entry?.id).toBe('perplexity');
      });

      it('matches "tavily-mcp" to catalog id "tavily"', () => {
        const entry = findCatalogEntry('tavily-mcp');
        expect(entry).toBeDefined();
        expect(entry?.id).toBe('tavily');
      });

      it('matches "exa-mcp-server" to catalog id "exa"', () => {
        const entry = findCatalogEntry('exa-mcp-server');
        expect(entry).toBeDefined();
        expect(entry?.id).toBe('exa');
      });

      it('matches "shopify-mcp" to catalog id "shopify"', () => {
        const entry = findCatalogEntry('shopify-mcp');
        expect(entry).toBeDefined();
        expect(entry?.id).toBe('shopify');
      });

      it('matches "databricks-mcp-server" to catalog id "databricks"', () => {
        const entry = findCatalogEntry('databricks-mcp-server');
        expect(entry).toBeDefined();
        expect(entry?.id).toBe('databricks');
      });

      it('matches "sentry-server" to catalog id "sentry"', () => {
        const entry = findCatalogEntry('sentry-server');
        expect(entry).toBeDefined();
        expect(entry?.id).toBe('sentry');
      });

      it('matches "mcp-notion" (prefix) to catalog id "notion"', () => {
        const entry = findCatalogEntry('mcp-notion');
        expect(entry).toBeDefined();
        expect(entry?.id).toBe('notion');
      });

      it('matches "linear-mcp-server" to catalog id "linear"', () => {
        const entry = findCatalogEntry('linear-mcp-server');
        expect(entry).toBeDefined();
        expect(entry?.id).toBe('linear');
      });

      it('matches "brave-search-mcp-server" to catalog id "brave-search"', () => {
        const entry = findCatalogEntry('brave-search-mcp-server');
        expect(entry).toBeDefined();
        expect(entry?.id).toBe('brave-search');
      });

      it('matches "brave-search" to catalog id "brave-search"', () => {
        const entry = findCatalogEntry('brave-search');
        expect(entry).toBeDefined();
        expect(entry?.id).toBe('brave-search');
      });

      it('matches "Brave-Search-MCP" to catalog id "brave-search" (case-insensitive)', () => {
        const entry = findCatalogEntry('Brave-Search-MCP');
        expect(entry).toBeDefined();
        expect(entry?.id).toBe('brave-search');
      });

      it('does not match "brave-mcp" to catalog id "brave-search" with current stripping rules', () => {
        const entry = findCatalogEntry('brave-mcp');
        expect(entry).toBeUndefined();
      });

      it('matches against catalog entry display name', () => {
        // server named "slack-mcp" -- stripped to "slack", matches catalog name "Slack"
        // (but "Slack" also matches via bundledConfig.serverName in Step 2, so test
        //  a non-bundled example: server named "Notion-mcp" normalized+stripped = "notion")
        const entry = findCatalogEntry('Notion-mcp');
        expect(entry).toBeDefined();
        expect(entry?.id).toBe('notion');
      });

      it('does not match when stripping produces empty string', () => {
        // "mcp" alone should not match anything
        expect(findCatalogEntry('mcp')).toBeUndefined();
      });

      it('does not match when stripping produces a different valid name', () => {
        // "mcp-server" strips to empty-ish, should not match
        expect(findCatalogEntry('mcp-server')).toBeUndefined();
      });

      it('prefers exact normalized match over affix-stripped match', () => {
        // "browser-mcp" should match catalog id "browser-mcp" exactly (Step 3)
        // rather than stripping to "browser" (Step 4)
        const entry = findCatalogEntry('browser-mcp');
        expect(entry).toBeDefined();
        expect(entry?.id).toBe('browser-mcp');
      });
    });

    describe('returns undefined for unknown servers', () => {
      it('returns undefined for completely unknown servers', () => {
        expect(findCatalogEntry('MyCustomMcp')).toBeUndefined();
        expect(findCatalogEntry('unknown-server')).toBeUndefined();
        expect(findCatalogEntry('totally-made-up')).toBeUndefined();
      });

      it('returns undefined for empty/invalid input', () => {
        expect(findCatalogEntry('')).toBeUndefined();
      });
    });

    describe('catalogId option (instance-named servers)', () => {
      it('resolves instance-named Fathom via catalogId', () => {
        // Instance name won't match via normal lookup
        expect(findCatalogEntry('Fathom-greg-work-com')).toBeUndefined();

        // But with catalogId hint, it resolves correctly
        const entry = findCatalogEntry('Fathom-greg-work-com', { catalogId: 'bundled-fathom' });
        expect(entry).toBeDefined();
        expect(entry?.id).toBe('bundled-fathom');
        expect(entry?.description ?? '').toMatch(/meeting/i);
      });

      it('resolves instance-named GoogleWorkspace via catalogId', () => {
        // Instance name won't match via normal lookup
        expect(findCatalogEntry('GoogleWorkspace-greg-work-com')).toBeUndefined();

        // But with catalogId hint, it resolves correctly
        const entry = findCatalogEntry('GoogleWorkspace-greg-work-com', { catalogId: 'bundled-google' });
        expect(entry).toBeDefined();
        expect(entry?.id).toBe('bundled-google');
      });

      it('catalogId takes precedence over name-based matching', () => {
        // Even though 'Slack' would match via serverName, catalogId takes priority
        const entry = findCatalogEntry('Slack', { catalogId: 'bundled-fathom' });
        expect(entry?.id).toBe('bundled-fathom');
      });

      it('falls back to name matching when catalogId not found', () => {
        // Invalid catalogId should fall back to normal lookup
        const entry = findCatalogEntry('Slack', { catalogId: 'non-existent-id' });
        expect(entry?.id).toBe('bundled-slack');
      });

      it('handles null/undefined catalogId gracefully', () => {
        expect(findCatalogEntry('Slack', { catalogId: null })?.id).toBe('bundled-slack');
        expect(findCatalogEntry('Slack', { catalogId: undefined })?.id).toBe('bundled-slack');
        expect(findCatalogEntry('Slack', {})?.id).toBe('bundled-slack');
      });
    });
  });

  describe('findConnectorsForUrl', () => {
    it('matches Google Docs URLs and extracts document_id', () => {
      const matches = findConnectorsForUrl(
        'https://docs.google.com/document/d/abc123DEF_456/edit',
        catalog
      );
      expect(matches).toHaveLength(1);
      expect(matches[0]?.catalogEntry.id).toBe('bundled-google');
      expect(matches[0]?.pattern.tool).toBe('read_workspace_document');
      expect(matches[0]?.extractedArgs).toEqual({ document_id: 'abc123DEF_456' });
    });

    it('matches Google Sheets URLs and extracts spreadsheet_id', () => {
      const matches = findConnectorsForUrl(
        'https://docs.google.com/spreadsheets/d/sheet_789-abc/edit#gid=0',
        catalog
      );
      expect(matches).toHaveLength(1);
      expect(matches[0]?.catalogEntry.id).toBe('bundled-google');
      expect(matches[0]?.pattern.tool).toBe('read_workspace_spreadsheet');
      expect(matches[0]?.extractedArgs).toEqual({ spreadsheet_id: 'sheet_789-abc' });
    });

    it('matches Google Slides URLs and extracts presentation_id', () => {
      const matches = findConnectorsForUrl(
        'https://docs.google.com/presentation/d/slides_abc-123/edit',
        catalog
      );
      expect(matches).toHaveLength(1);
      expect(matches[0]?.catalogEntry.id).toBe('bundled-google');
      expect(matches[0]?.pattern.tool).toBe('read_workspace_presentation');
      expect(matches[0]?.extractedArgs).toEqual({ presentation_id: 'slides_abc-123' });
    });

    it('matches Google Drive URLs and extracts file_id', () => {
      const matches = findConnectorsForUrl(
        'https://drive.google.com/file/d/driveFileId_456/view',
        catalog
      );
      expect(matches).toHaveLength(1);
      expect(matches[0]?.catalogEntry.id).toBe('bundled-google');
      expect(matches[0]?.pattern.tool).toBe('download_drive_file');
      expect(matches[0]?.extractedArgs).toEqual({ file_id: 'driveFileId_456' });
    });

    it('does not match URLs where the domain is a substring', () => {
      const matches = findConnectorsForUrl(
        'https://malicious.com/?next=https://docs.google.com/document/d/abc',
        catalog
      );
      expect(matches).toHaveLength(0);
    });

    it('matches /u/0 multi-account Google URL variants', () => {
      const matches = findConnectorsForUrl(
        'https://docs.google.com/document/u/0/d/multiAccountDoc123/edit?usp=sharing',
        catalog
      );
      expect(matches).toHaveLength(1);
      expect(matches[0]?.pattern.tool).toBe('read_workspace_document');
      expect(matches[0]?.extractedArgs).toEqual({ document_id: 'multiAccountDoc123' });
    });

    it('returns empty array when no patterns match', () => {
      const matches = findConnectorsForUrl('https://example.com/not-a-known-connector-url', catalog);
      expect(matches).toEqual([]);
    });

    it('is graceful on invalid regex patterns', () => {
      const invalidCatalog: ConnectorCatalog = {
        version: 1,
        connectors: [
          {
            id: 'invalid-regex-test',
            name: 'Invalid Regex Test',
            description: 'Test connector with invalid regex',
            category: 'productivity',
            provider: 'community',
            icon: 'link',
            urlPatterns: [
              {
                pattern: '(?<broken',
                tool: 'read_something',
              },
            ],
          },
        ],
      };

      expect(() => findConnectorsForUrl('https://example.com/doc/123', invalidCatalog)).not.toThrow();
      expect(findConnectorsForUrl('https://example.com/doc/123', invalidCatalog)).toEqual([]);
    });

    it('returns multiple matches when multiple connectors match the same URL', () => {
      const multiMatchCatalog: ConnectorCatalog = {
        version: 1,
        connectors: [
          {
            id: 'connector-a',
            name: 'Connector A',
            description: 'First matcher',
            category: 'productivity',
            provider: 'community',
            icon: 'link',
            urlPatterns: [
              {
                pattern: 'example\\.com/doc/(?<id>[a-zA-Z0-9_-]+)',
                tool: 'read_doc_a',
                extractArgs: { param: 'documentId' },
              },
            ],
          },
          {
            id: 'connector-b',
            name: 'Connector B',
            description: 'Second matcher',
            category: 'productivity',
            provider: 'community',
            icon: 'link',
            urlPatterns: [
              {
                pattern: 'example\\.com/doc/(?<id>[a-zA-Z0-9_-]+)',
                tool: 'read_doc_b',
                extractArgs: { group: 'id', param: 'docId' },
              },
            ],
          },
        ],
      };

      const matches = findConnectorsForUrl('https://example.com/doc/abc123', multiMatchCatalog);
      expect(matches).toHaveLength(2);
      expect(matches.map((match) => match.catalogEntry.id)).toEqual(['connector-a', 'connector-b']);
      expect(matches[0]?.extractedArgs).toEqual({ documentId: 'abc123' });
      expect(matches[1]?.extractedArgs).toEqual({ docId: 'abc123' });
    });

    it('defaults extractArgs.group to "id" when group is omitted', () => {
      const defaultGroupCatalog: ConnectorCatalog = {
        version: 1,
        connectors: [
          {
            id: 'default-group-test',
            name: 'Default Group Test',
            description: 'Ensures default capture group works',
            category: 'productivity',
            provider: 'community',
            icon: 'link',
            urlPatterns: [
              {
                pattern: 'example\\.com/file/(?<id>[a-zA-Z0-9_-]+)',
                tool: 'read_file',
                extractArgs: { param: 'fileId' },
              },
            ],
          },
        ],
      };

      const matches = findConnectorsForUrl('https://example.com/file/xyz_789', defaultGroupCatalog);
      expect(matches).toHaveLength(1);
      expect(matches[0]?.extractedArgs).toEqual({ fileId: 'xyz_789' });
    });
  });

  describe('getServerDescription', () => {
    it('returns catalog description for known servers', () => {
      const desc = getServerDescription('Slack');
      expect(desc).toContain('messages');
    });

    it('returns default fallback for unknown servers', () => {
      expect(getServerDescription('MyCustomMcp')).toBe('(custom MCP server)');
    });

    it('returns custom fallback when provided', () => {
      expect(getServerDescription('MyCustomMcp', 'User-configured server')).toBe(
        'User-configured server'
      );
    });
  });

  describe('getServerDisplayName', () => {
    it('returns catalog name for known servers', () => {
      expect(getServerDisplayName('notion')).toBe('Notion');
    });

    it('returns catalog name for brave-search', () => {
      expect(getServerDisplayName('brave-search')).toBe('Brave Search');
    });

    it('returns original key for unknown servers', () => {
      expect(getServerDisplayName('MyCustomMcp')).toBe('MyCustomMcp');
    });
  });

  describe('isKnownServer', () => {
    it('returns true for known servers', () => {
      expect(isKnownServer('Slack')).toBe(true);
      expect(isKnownServer('notion')).toBe(true);
      expect(isKnownServer('linear')).toBe(true);
      expect(isKnownServer('brave-search')).toBe(true);
    });

    it('returns false for unknown servers', () => {
      expect(isKnownServer('MyCustomMcp')).toBe(false);
      expect(isKnownServer('unknown-server')).toBe(false);
    });
  });

  describe('getServerDescriptionWithEmail', () => {
    it('returns catalog description when no options provided', () => {
      const desc = getServerDescriptionWithEmail('Slack');
      expect(desc).toContain('messages');
    });

    it('prefixes email when provided', () => {
      const desc = getServerDescriptionWithEmail('Slack', { email: '[external-email]' });
      expect(desc).toMatch(/^greg@work\.com - /);
      expect(desc).toContain('messages');
    });

    it('uses serverDescription override when provided', () => {
      const desc = getServerDescriptionWithEmail('Slack', { serverDescription: 'Custom description' });
      expect(desc).toBe('Custom description');
    });

    it('uses catalogId to resolve instance-named servers', () => {
      // Without catalogId, instance name returns generic description
      const descWithoutCatalogId = getServerDescriptionWithEmail('Fathom-greg-work-com');
      expect(descWithoutCatalogId).toBe('(custom MCP server)');

      // With catalogId, it resolves to catalog entry
      const descWithCatalogId = getServerDescriptionWithEmail('Fathom-greg-work-com', {
        catalogId: 'bundled-fathom',
      });
      expect(descWithCatalogId).toMatch(/meeting/i);
    });

    it('combines email and catalogId for instance-named servers', () => {
      const desc = getServerDescriptionWithEmail('Fathom-greg-work-com', {
        catalogId: 'bundled-fathom',
        email: '[external-email]',
      });
      expect(desc).toMatch(/^greg@work\.com - /);
      expect(desc).toMatch(/meeting/i);
    });

    it('serverDescription takes precedence over catalogId lookup', () => {
      const desc = getServerDescriptionWithEmail('Fathom-greg-work-com', {
        catalogId: 'bundled-fathom',
        serverDescription: 'My custom Fathom',
      });
      expect(desc).toBe('My custom Fathom');
    });

    it('avoids duplicate email when description already starts with email', () => {
      const desc = getServerDescriptionWithEmail('Fathom', {
        email: '[external-email]',
        serverDescription: '[external-email] - Already prefixed',
      });
      // Should NOT double-prefix
      expect(desc).toBe('[external-email] - Already prefixed');
      expect(desc.indexOf('[external-email]')).toBe(0);
      expect(desc.lastIndexOf('[external-email]')).toBe(0); // Only one occurrence
    });

    it('handles null values in options', () => {
      const desc = getServerDescriptionWithEmail('Slack', {
        email: null,
        catalogId: null,
        serverDescription: null,
      });
      // Slack description changed - just check it's not the fallback
      expect(desc).not.toBe('(custom MCP server)');
    });
  });

  describe('rebel-oss credential persistence (REBEL-1G5 regression)', () => {
    // Regression guard for Sentry REBEL-1G5: after connectors migrated to
    // provider: "rebel-oss", several setupFields had no `envVar`, so
    // buildPayloadFromCatalog silently dropped user-entered credentials.
    // The upstream npm packages read credentials from process.env on startup,
    // so the envVar mapping is the load-bearing wire.
    //
    // Known exceptions (credentials persisted via a non-env path):
    // - Zendesk: settingsHandlers writes subdomain/email/apiKey to accounts.json
    // - Freshdesk: not yet wired; package uses file-based FRESHDESK_CONFIG_PATH
    // - iCloud/Yahoo/Custom Email: need email field handling (options.email
    //   is not in setupFields); tracked separately.
    const expectedEnvVarWiring: Record<string, Record<string, string>> = {
      'bundled-fathom': { apiKey: 'FATHOM_API_KEY' },
      'bundled-pandadoc': { apiKey: 'PANDADOC_API_KEY' },
      'bundled-mixmax': { apiKey: 'MIXMAX_API_TOKEN' },
      'bundled-humaans': { apiKey: 'HUMAANS_API_KEY' },
      'bundled-kling': { accessKey: 'KLING_ACCESS_KEY', secretKey: 'KLING_SECRET_KEY' },
      'bundled-runway': { apiKey: 'RUNWAYML_API_SECRET' },
      'bundled-quickbooks': {
        clientId: 'QUICKBOOKS_CLIENT_ID',
        clientSecret: 'QUICKBOOKS_CLIENT_SECRET',
        refreshToken: 'QUICKBOOKS_REFRESH_TOKEN',
        realmId: 'QUICKBOOKS_REALM_ID',
        environment: 'QUICKBOOKS_ENVIRONMENT',
      },
      'bundled-servicenow': {
        instance: 'SERVICENOW_INSTANCE',
        username: 'SERVICENOW_USERNAME',
        password: 'SERVICENOW_PASSWORD',
      },
      'bundled-talentlms': { domain: 'TALENTLMS_DOMAIN', apiKey: 'TALENTLMS_API_KEY' },
      'bundled-gamma': { apiKey: 'GAMMA_API_KEY' },
      'bundled-napkin': { apiKey: 'NAPKIN_API_KEY' },
      'bundled-elevenlabs': { apiKey: 'ELEVENLABS_API_KEY' },
      'bundled-nano-banana': { apiKey: 'GEMINI_API_KEY' },
      'bundled-workday': {
        host: 'WORKDAY_HOST',
        tenant: 'WORKDAY_TENANT',
        clientId: 'WORKDAY_CLIENT_ID',
        clientSecret: 'WORKDAY_CLIENT_SECRET',
        refreshToken: 'WORKDAY_REFRESH_TOKEN',
      },
      'bundled-icloud-mail': { password: 'EMAIL_IMAP_PASSWORD' },
      'bundled-yahoo-mail': { password: 'EMAIL_IMAP_PASSWORD' },
      'bundled-custom-email': {
        imapHost: 'EMAIL_IMAP_IMAP_HOST',
        imapPort: 'EMAIL_IMAP_IMAP_PORT',
        smtpHost: 'EMAIL_IMAP_SMTP_HOST',
        smtpPort: 'EMAIL_IMAP_SMTP_PORT',
        password: 'EMAIL_IMAP_PASSWORD',
      },
    };

    // Connectors where the account-identity email (from the shared Account
    // Email input, not a setupField) must flow into a specific env var.
    const expectedAccountIdentityEnvVar: Record<string, string> = {
      'bundled-icloud-mail': 'EMAIL_IMAP_EMAIL',
      'bundled-yahoo-mail': 'EMAIL_IMAP_EMAIL',
      'bundled-custom-email': 'EMAIL_IMAP_EMAIL',
    };

    for (const [connectorId, expectedFields] of Object.entries(expectedEnvVarWiring)) {
      it(`${connectorId} setupFields wire to the expected upstream env vars`, () => {
        const entry = catalog.connectors.find((c) => c.id === connectorId);
        expect(entry, `${connectorId} not found in catalog`).toBeDefined();
        expect(entry?.provider).toBe('rebel-oss');

        for (const [fieldId, expectedEnvVar] of Object.entries(expectedFields)) {
          const field = entry?.setupFields?.find((f) => f.id === fieldId);
          expect(field, `${connectorId}.${fieldId} setupField not found`).toBeDefined();
          expect(
            field?.envVar,
            `${connectorId}.${fieldId} must map to ${expectedEnvVar}`,
          ).toBe(expectedEnvVar);
        }
      });
    }

    for (const [connectorId, expectedEnvVar] of Object.entries(expectedAccountIdentityEnvVar)) {
      it(`${connectorId} wires the account-identity email to ${expectedEnvVar}`, () => {
        const entry = catalog.connectors.find((c) => c.id === connectorId);
        expect(entry, `${connectorId} not found in catalog`).toBeDefined();
        expect(entry?.bundledConfig?.accountIdentityEnvVar).toBe(expectedEnvVar);
      });
    }
  });
});
