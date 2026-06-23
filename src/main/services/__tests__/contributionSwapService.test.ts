/**
 * Tests for contributionSwapService.ts
 *
 * Validates:
 * - Happy path: published contribution + catalog match + local config → swap succeeds
 * - Already swapped: config already points to npx → skip
 * - No catalog match: skip gracefully
 * - No config entry: skip (connector was removed)
 * - Env var preservation: user env vars survive the swap
 * - Multiple contributions: sweep processes all
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// ─── In-memory store mock ───────────────────────────────────────────

let storeData: Record<string, unknown> = {};

vi.mock('@core/storeFactory', () => ({
  createStore: vi.fn(() => ({
    get(key: string) { return storeData[key]; },
    set(keyOrObj: string | Record<string, unknown>, value?: unknown) {
      if (typeof keyOrObj === 'string') {
        storeData[keyOrObj] = value;
      } else {
        Object.assign(storeData, keyOrObj);
      }
    },
    has(key: string) { return key in storeData; },
    delete(key: string) { delete storeData[key]; },
    clear() { storeData = {}; },
    get store() { return storeData; },
    set store(val: Record<string, unknown>) { storeData = val; },
    path: '/mock/path',
  })),
}));

// ─── Mock mcpConfigManager ──────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  mockReadMcpServerDetails: vi.fn(),
  mockUpsertMcpServerEntry: vi.fn(),
  mockFindCatalogEntry: vi.fn(),
  mockResolveEnvPlaceholders: vi.fn(),
}));

vi.mock('@core/services/mcpConfigManager', () => ({
  readMcpServerDetails: mocks.mockReadMcpServerDetails,
  upsertMcpServerEntry: mocks.mockUpsertMcpServerEntry,
}));

vi.mock('@core/services/connectorCatalogService', () => ({
  findCatalogEntry: mocks.mockFindCatalogEntry,
}));

vi.mock('../bundledMcpManager', () => ({
  resolveEnvPlaceholders: mocks.mockResolveEnvPlaceholders,
}));

// ─── Imports (after mocks) ──────────────────────────────────────────

import {
  trySwapSingleContribution,
  sweepPublishedContributions,
} from '../contributionSwapService';
import {
  createContribution,
  listContributions,
  _resetStore,
} from '@core/services/contributionStore';
import type { ConnectorContribution } from '@core/services/contributionTypes';
import type { McpServerConfigDetails, ConnectorCatalogEntry } from '@shared/types';

// ─── Helpers ────────────────────────────────────────────────────────

const TEST_CONFIG_PATH = '/mock/mcp-config/config.json';

function makePublishedContribution(overrides?: Partial<{
  connectorName: string;
  localServerPath: string;
}>): ConnectorContribution {
  return createContribution({
    sessionId: `session-${Math.random().toString(36).slice(2, 8)}`,
    connectorName: overrides?.connectorName ?? 'Zendesk',
    status: 'published',
    attributionMode: 'anonymous',
    localServerPath: overrides?.localServerPath ?? '/Users/test/mcp-servers/zendesk',
  });
}

function makeExistingConfig(overrides?: Partial<McpServerConfigDetails>): McpServerConfigDetails {
  return {
    name: 'Zendesk',
    type: null,
    transport: 'stdio',
    command: 'node',
    args: ['/Users/test/mcp-servers/zendesk/build/index.js'],
    url: null,
    cwd: null,
    env: { ZENDESK_API_KEY: 'user-key-123', ZENDESK_SUBDOMAIN: 'mycompany' },
    headers: null,
    description: 'Zendesk support tickets',
    catalogId: null,
    email: 'user@example.com',
    workspace: null,
    lastConnectedAt: 1713100000000,
    ...overrides,
  };
}

function makeCatalogEntry(overrides?: Partial<ConnectorCatalogEntry>): ConnectorCatalogEntry {
  return {
    id: 'zendesk',
    name: 'Zendesk',
    description: 'Zendesk support platform',
    category: 'communication',
    provider: 'rebel-oss',
    icon: 'headphones',
    mcpConfig: {
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@mindstone-engineering/mcp-server-zendesk'],
      env: {
        LOG_MODE: 'strict',
        MCP_HOST_BRIDGE_STATE: '{{MCP_BASE_DIR}}/rebel-inbox-bridge.json',
      },
    },
    ...overrides,
  } as ConnectorCatalogEntry;
}

// ─── Tests ──────────────────────────────────────────────────────────

describe('contributionSwapService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    storeData = {};
    _resetStore();
    mocks.mockUpsertMcpServerEntry.mockResolvedValue({ backupPath: null });
    mocks.mockResolveEnvPlaceholders.mockImplementation(
      (env: Record<string, string>) => ({ ...env }),
    );
  });

  // ── trySwapSingleContribution ─────────────────────────────────

  describe('trySwapSingleContribution', () => {
    it('swaps a published contribution from local to catalog config', async () => {
      const contribution = makePublishedContribution();
      mocks.mockReadMcpServerDetails.mockResolvedValue(makeExistingConfig());
      mocks.mockFindCatalogEntry.mockReturnValue(makeCatalogEntry());

      const result = await trySwapSingleContribution(contribution, TEST_CONFIG_PATH);

      expect(result.swapped).toBe(true);
      expect(result.contributionId).toBe(contribution.id);
      expect(result.connectorName).toBe('Zendesk');

      // Verify upsert was called with catalog command/args but preserved identity
      expect(mocks.mockUpsertMcpServerEntry).toHaveBeenCalledOnce();
      const [configPath, payload] = mocks.mockUpsertMcpServerEntry.mock.calls[0];
      expect(configPath).toBe(TEST_CONFIG_PATH);
      expect(payload.name).toBe('Zendesk'); // preserved server name
      expect(payload.command).toBe('npx');
      expect(payload.args).toEqual(['-y', '@mindstone-engineering/mcp-server-zendesk']);
      expect(payload.catalogId).toBe('zendesk');
      expect(payload.email).toBe('user@example.com');
      expect(payload.lastConnectedAt).toBe(1713100000000);
      expect(payload.description).toBe('Zendesk support tickets');
    });

    it('skips when config already points to npx (already swapped)', async () => {
      const contribution = makePublishedContribution();
      mocks.mockReadMcpServerDetails.mockResolvedValue(
        makeExistingConfig({ command: 'npx', catalogId: null }),
      );

      const result = await trySwapSingleContribution(contribution, TEST_CONFIG_PATH);

      expect(result.swapped).toBe(false);
      expect(result.reason).toBe('already_swapped');
      expect(mocks.mockUpsertMcpServerEntry).not.toHaveBeenCalled();
    });

    it('skips when config already has a catalogId (already swapped)', async () => {
      const contribution = makePublishedContribution();
      mocks.mockReadMcpServerDetails.mockResolvedValue(
        makeExistingConfig({ catalogId: 'zendesk' }),
      );

      const result = await trySwapSingleContribution(contribution, TEST_CONFIG_PATH);

      expect(result.swapped).toBe(false);
      expect(result.reason).toBe('already_swapped');
      expect(mocks.mockUpsertMcpServerEntry).not.toHaveBeenCalled();
    });

    it('skips when no catalog match exists', async () => {
      const contribution = makePublishedContribution();
      mocks.mockReadMcpServerDetails.mockResolvedValue(makeExistingConfig());
      mocks.mockFindCatalogEntry.mockReturnValue(undefined);

      const result = await trySwapSingleContribution(contribution, TEST_CONFIG_PATH);

      expect(result.swapped).toBe(false);
      expect(result.reason).toBe('no_catalog_match');
      expect(mocks.mockUpsertMcpServerEntry).not.toHaveBeenCalled();
    });

    it('skips when no config entry exists (user removed connector)', async () => {
      const contribution = makePublishedContribution();
      mocks.mockReadMcpServerDetails.mockRejectedValue(
        new Error('Server "Zendesk" not found in configuration.'),
      );

      const result = await trySwapSingleContribution(contribution, TEST_CONFIG_PATH);

      expect(result.swapped).toBe(false);
      expect(result.reason).toBe('no_config_entry');
      expect(mocks.mockUpsertMcpServerEntry).not.toHaveBeenCalled();
    });

    it('skips when contribution has no connectorName', async () => {
      const contribution = makePublishedContribution({ connectorName: '' });
      // Force empty connectorName after creation
      (contribution as unknown as { connectorName: string }).connectorName = '';

      const result = await trySwapSingleContribution(contribution, TEST_CONFIG_PATH);

      expect(result.swapped).toBe(false);
      expect(result.reason).toBe('missing_connector_info');
    });

    it('skips when contribution has no localServerPath', async () => {
      const contribution = makePublishedContribution();
      delete (contribution as { localServerPath?: string }).localServerPath;

      const result = await trySwapSingleContribution(contribution, TEST_CONFIG_PATH);

      expect(result.swapped).toBe(false);
      expect(result.reason).toBe('missing_connector_info');
    });

    it('skips when catalog entry is not rebel-oss provider', async () => {
      const contribution = makePublishedContribution();
      mocks.mockReadMcpServerDetails.mockResolvedValue(makeExistingConfig());
      mocks.mockFindCatalogEntry.mockReturnValue(
        makeCatalogEntry({ provider: 'community' as 'rebel-oss' }),
      );

      const result = await trySwapSingleContribution(contribution, TEST_CONFIG_PATH);

      expect(result.swapped).toBe(false);
      expect(result.reason).toBe('no_catalog_match');
    });

    it('skips when catalog entry has no mcpConfig', async () => {
      const contribution = makePublishedContribution();
      mocks.mockReadMcpServerDetails.mockResolvedValue(makeExistingConfig());
      const noMcpEntry = makeCatalogEntry();
      delete (noMcpEntry as { mcpConfig?: ConnectorCatalogEntry['mcpConfig'] }).mcpConfig;
      mocks.mockFindCatalogEntry.mockReturnValue(noMcpEntry);

      const result = await trySwapSingleContribution(contribution, TEST_CONFIG_PATH);

      expect(result.swapped).toBe(false);
      expect(result.reason).toBe('no_catalog_match');
    });

    // ── Env var preservation ────────────────────────────────────

    describe('env var preservation', () => {
      it('preserves user env vars during swap (user values win)', async () => {
        const contribution = makePublishedContribution();
        const existingConfig = makeExistingConfig({
          env: {
            ZENDESK_API_KEY: 'user-key-123',
            ZENDESK_SUBDOMAIN: 'mycompany',
            LOG_MODE: 'verbose', // user override of catalog default
          },
        });
        mocks.mockReadMcpServerDetails.mockResolvedValue(existingConfig);
        mocks.mockFindCatalogEntry.mockReturnValue(makeCatalogEntry());
        mocks.mockResolveEnvPlaceholders.mockReturnValue({
          LOG_MODE: 'strict',
          MCP_HOST_BRIDGE_STATE: '/resolved/path/rebel-inbox-bridge.json',
        });

        const result = await trySwapSingleContribution(contribution, TEST_CONFIG_PATH);

        expect(result.swapped).toBe(true);
        const [, payload] = mocks.mockUpsertMcpServerEntry.mock.calls[0];
        // User values win for overlapping keys
        expect(payload.env.LOG_MODE).toBe('verbose');
        // User-only keys preserved
        expect(payload.env.ZENDESK_API_KEY).toBe('user-key-123');
        expect(payload.env.ZENDESK_SUBDOMAIN).toBe('mycompany');
        // Catalog-only keys added
        expect(payload.env.MCP_HOST_BRIDGE_STATE).toBe('/resolved/path/rebel-inbox-bridge.json');
      });

      it('uses catalog env vars when no existing env vars', async () => {
        const contribution = makePublishedContribution();
        mocks.mockReadMcpServerDetails.mockResolvedValue(
          makeExistingConfig({ env: null }),
        );
        mocks.mockFindCatalogEntry.mockReturnValue(makeCatalogEntry());
        mocks.mockResolveEnvPlaceholders.mockReturnValue({
          LOG_MODE: 'strict',
          MCP_HOST_BRIDGE_STATE: '/resolved/path/rebel-inbox-bridge.json',
        });

        const result = await trySwapSingleContribution(contribution, TEST_CONFIG_PATH);

        expect(result.swapped).toBe(true);
        const [, payload] = mocks.mockUpsertMcpServerEntry.mock.calls[0];
        expect(payload.env.LOG_MODE).toBe('strict');
        expect(payload.env.MCP_HOST_BRIDGE_STATE).toBe('/resolved/path/rebel-inbox-bridge.json');
      });
    });

    it('preserves headers from existing config', async () => {
      const contribution = makePublishedContribution();
      mocks.mockReadMcpServerDetails.mockResolvedValue(
        makeExistingConfig({
          headers: { Authorization: 'Bearer token-123' },
        }),
      );
      mocks.mockFindCatalogEntry.mockReturnValue(makeCatalogEntry());

      const result = await trySwapSingleContribution(contribution, TEST_CONFIG_PATH);

      expect(result.swapped).toBe(true);
      const [, payload] = mocks.mockUpsertMcpServerEntry.mock.calls[0];
      expect(payload.headers).toEqual({ Authorization: 'Bearer token-123' });
    });
  });

  // ── sweepPublishedContributions ───────────────────────────────

  describe('sweepPublishedContributions', () => {
    it('processes all published contributions', async () => {
      makePublishedContribution({ connectorName: 'Zendesk' });
      makePublishedContribution({ connectorName: 'Fireflies' });

      mocks.mockReadMcpServerDetails.mockResolvedValue(makeExistingConfig());
      mocks.mockFindCatalogEntry.mockReturnValue(makeCatalogEntry());

      const results = await sweepPublishedContributions(TEST_CONFIG_PATH);

      expect(results).toHaveLength(2);
      expect(results.filter((r) => r.swapped)).toHaveLength(2);
    });

    it('returns empty array when no published contributions exist', async () => {
      // Create a non-published contribution
      createContribution({
        sessionId: 'session-draft',
        connectorName: 'SomeConnector',
        status: 'draft',
        attributionMode: 'anonymous',
      });

      const results = await sweepPublishedContributions(TEST_CONFIG_PATH);

      expect(results).toHaveLength(0);
      expect(mocks.mockReadMcpServerDetails).not.toHaveBeenCalled();
    });

    it('handles mixed results: some swapped, some skipped', async () => {
      makePublishedContribution({ connectorName: 'Zendesk' });
      makePublishedContribution({ connectorName: 'NoMatch' });

      // First call succeeds, second has no catalog match
      mocks.mockReadMcpServerDetails.mockResolvedValue(makeExistingConfig());
      mocks.mockFindCatalogEntry
        .mockReturnValueOnce(makeCatalogEntry())
        .mockReturnValueOnce(undefined);

      const results = await sweepPublishedContributions(TEST_CONFIG_PATH);

      expect(results).toHaveLength(2);
      expect(results.filter((r) => r.swapped)).toHaveLength(1);
      expect(results.filter((r) => !r.swapped)).toHaveLength(1);
    });

    it('continues processing after an error in one contribution', async () => {
      makePublishedContribution({ connectorName: 'ErrorConnector' });
      makePublishedContribution({ connectorName: 'Zendesk' });

      // First call throws, second succeeds
      mocks.mockReadMcpServerDetails
        .mockRejectedValueOnce(new Error('Disk read error'))
        .mockResolvedValueOnce(makeExistingConfig());
      mocks.mockFindCatalogEntry.mockReturnValue(makeCatalogEntry());

      const results = await sweepPublishedContributions(TEST_CONFIG_PATH);

      expect(results).toHaveLength(2);
      // First errored out (readMcpServerDetails throws, caught as 'no_config_entry')
      // Actually, the error from readMcpServerDetails is caught at the trySwapSingleContribution
      // level (the try/catch for readMcpServerDetails returns 'no_config_entry'),
      // so the sweep-level catch won't fire for this case.
      // The second should succeed.
      const swapped = results.filter((r) => r.swapped);
      expect(swapped.length).toBeGreaterThanOrEqual(1);
    });

    it('handles sweep-level errors gracefully', async () => {
      makePublishedContribution({ connectorName: 'Zendesk' });

      // Force an error that escapes trySwapSingleContribution's internal catches
      mocks.mockReadMcpServerDetails.mockResolvedValue(makeExistingConfig());
      mocks.mockFindCatalogEntry.mockReturnValue(makeCatalogEntry());
      mocks.mockUpsertMcpServerEntry.mockRejectedValue(new Error('Write failed'));

      const results = await sweepPublishedContributions(TEST_CONFIG_PATH);

      expect(results).toHaveLength(1);
      expect(results[0].swapped).toBe(false);
      expect(results[0].reason).toBe('error');
    });
  });
});
