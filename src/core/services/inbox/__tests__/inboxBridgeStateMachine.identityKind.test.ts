import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

const getSettingsMock = vi.hoisted(() => vi.fn());
const resolveMcpConfigPathMock = vi.hoisted(() => vi.fn());
const restartSuperMcpForConfigChangeAndAwaitExecutionMock = vi.hoisted(() => vi.fn());
const reloadSuperMcpNowForChatPackageMaterializationMock = vi.hoisted(() => vi.fn());
const findExistingCatalogServerMock = vi.hoisted(() => vi.fn());
const upsertMcpServerEntryMock = vi.hoisted(() => vi.fn());
const resolveConnectorCatalogPathMock = vi.hoisted(() => vi.fn());
const lookupCatalogEntryMock = vi.hoisted(() => vi.fn());
const buildPayloadFromCatalogMock = vi.hoisted(() => vi.fn());

vi.mock('@core/services/settingsStore', () => ({
  getSettings: getSettingsMock,
}));

vi.mock('@main/services/mcpService', () => ({
  resolveMcpConfigPath: resolveMcpConfigPathMock,
  restartSuperMcpForConfigChangeAndAwaitExecution: restartSuperMcpForConfigChangeAndAwaitExecutionMock,
  reloadSuperMcpNowForChatPackageMaterialization: reloadSuperMcpNowForChatPackageMaterializationMock,
  authenticateMcpServer: vi.fn(),
}));

vi.mock('@main/services/mcpConfigManager', () => ({
  upsertMcpServerEntry: upsertMcpServerEntryMock,
  removeMcpServerEntry: vi.fn(),
  getMcpServerNames: vi.fn(),
  setMcpToolEnabled: vi.fn(),
  ensureRouterConfigFile: vi.fn(),
  findExistingCatalogServer: findExistingCatalogServerMock,
  readMcpServerDetails: vi.fn(),
}));

vi.mock('@main/services/bundledMcpManager', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@main/services/bundledMcpManager')>();
  return {
    ...actual,
    resolveConnectorCatalogPath: resolveConnectorCatalogPathMock,
    lookupCatalogEntry: lookupCatalogEntryMock,
    buildPayloadFromCatalog: buildPayloadFromCatalogMock,
  };
});

import {
  buildMissingIdentityWarningNextStep,
  handleBundledInboxBridgeRequest,
  setBundledInboxBridgeToken,
} from '../inboxBridgeStateMachine';

const BRIDGE_TOKEN = 'test-bridge-token';
const SERVER_NAME = 'Acme Connector';

let server: http.Server;
let baseUrl = '';
let catalogPath = '';
let currentCatalogEntry: Record<string, unknown>;

async function startBridgeServer(): Promise<void> {
  server = http.createServer((req, res) => {
    void handleBundledInboxBridgeRequest(req, res);
  });

  await new Promise<void>((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => resolve());
    server.on('error', reject);
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Failed to resolve bridge server address');
  }
  baseUrl = `http://127.0.0.1:${address.port}`;
}

async function stopBridgeServer(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function postUpsertServer(payload: Record<string, unknown>): Promise<{
  status: number;
  body: Record<string, unknown>;
}> {
  const response = await fetch(`${baseUrl}/mcp/upsert-server`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${BRIDGE_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
  };
}

function expectNextStep(body: Record<string, unknown>): string {
  expect(typeof body.nextStep).toBe('string');
  return body.nextStep as string;
}

describe('inboxBridgeStateMachine /mcp/upsert-server identity kind warnings', () => {
  beforeAll(async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'inbox-bridge-identity-kind-'));
    catalogPath = path.join(tempDir, 'connector-catalog.json');
    await fs.writeFile(catalogPath, JSON.stringify({ connectors: [] }), 'utf8');
    await startBridgeServer();
  });

  beforeEach(() => {
    setBundledInboxBridgeToken(BRIDGE_TOKEN);
    currentCatalogEntry = {
      id: 'mock-connector',
      accountIdentity: 'email',
      bundledConfig: { authType: 'api-key' },
    };

    getSettingsMock.mockReturnValue({
      coreDirectory: '/tmp/workspace',
      providerKeys: {},
    });
    resolveMcpConfigPathMock.mockReturnValue('/tmp/mcp.json');
    resolveConnectorCatalogPathMock.mockReturnValue(catalogPath);
    lookupCatalogEntryMock.mockImplementation(() => currentCatalogEntry);
    findExistingCatalogServerMock.mockResolvedValue({ exists: false });
    buildPayloadFromCatalogMock.mockResolvedValue({ name: SERVER_NAME });
    upsertMcpServerEntryMock.mockResolvedValue({ backupPath: '/tmp/mcp.backup.json' });
    restartSuperMcpForConfigChangeAndAwaitExecutionMock.mockResolvedValue(undefined);
    reloadSuperMcpNowForChatPackageMaterializationMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    setBundledInboxBridgeToken(null);
    vi.clearAllMocks();
  });

  afterAll(async () => {
    setBundledInboxBridgeToken(null);
    await stopBridgeServer();
  });

  it.each([
    ['email', 'email'],
    ['legacy undefined', undefined],
  ])('shows missing-identity warning for %s kind when email is absent', async (_label, accountIdentity) => {
    currentCatalogEntry = {
      id: 'mock-connector',
      accountIdentity,
      bundledConfig: { authType: 'api-key' },
    };

    const response = await postUpsertServer({
      catalogId: 'mock-connector',
    });

    expect(response.status).toBe(200);
    const nextStep = expectNextStep(response.body);
    expect(nextStep).toContain('re-add with the email parameter');
    expect(nextStep).toContain('without an associated email');
    expect(response.body.missingIdentity).toBe('email');
  });

  it.each([
    ['email', 'email'],
    ['legacy undefined', undefined],
  ])('suppresses warning when %s kind has email present (trimmed)', async (_label, accountIdentity) => {
    currentCatalogEntry = {
      id: 'mock-connector',
      accountIdentity,
      bundledConfig: { authType: 'api-key' },
    };

    const response = await postUpsertServer({
      catalogId: 'mock-connector',
      email: '  user@example.com  ',
    });

    expect(response.status).toBe(200);
    const nextStep = expectNextStep(response.body);
    expect(nextStep).toBe(`Server "${SERVER_NAME}" added and ready to use.`);
    expect(nextStep).not.toContain('supports multiple accounts');
    expect(response.body.missingIdentity).toBeUndefined();
  });

  it.each(['workspace', 'subdomain', 'domain', 'tenant', 'none'] as const)(
    'does not show missing-identity warning when paramName is not email (%s)',
    async (accountIdentity) => {
      currentCatalogEntry = {
        id: 'mock-connector',
        accountIdentity,
        bundledConfig: { authType: 'api-key' },
      };

      const response = await postUpsertServer({
        catalogId: 'mock-connector',
      });

      expect(response.status).toBe(200);
      const nextStep = expectNextStep(response.body);
      expect(nextStep).toBe(`Server "${SERVER_NAME}" added and ready to use.`);
      expect(nextStep).not.toContain('supports multiple accounts');
      expect(response.body.missingIdentity).toBeUndefined();
    },
  );

  it.each([
    ['workspace', 'workspace name'],
    ['subdomain', 'account URL'],
    ['domain', 'account URL'],
    ['tenant', 'account URL'],
    ['email', 'email'],
  ] as const)('uses the "%s" registry param in warning copy (%s)', (accountIdentity, expectedParamName) => {
    const nextStep = buildMissingIdentityWarningNextStep(SERVER_NAME, accountIdentity);
    expect(nextStep).toContain(`re-add with the ${expectedParamName} parameter`);
  });

  it('keeps email-kind warning phrasing byte-identical', async () => {
    currentCatalogEntry = {
      id: 'mock-connector',
      accountIdentity: 'email',
      bundledConfig: { authType: 'api-key' },
    };

    const response = await postUpsertServer({
      catalogId: 'mock-connector',
    });

    expect(response.status).toBe(200);
    expect(expectNextStep(response.body)).toBe(
      `Warning: "${SERVER_NAME}" was added without an associated email. This connector supports multiple accounts — re-add with the email parameter to create a properly named instance. Without it, adding a second account later may conflict.`,
    );
  });

  it('uses the immediate chat materialization reload after the response delay for added catalog servers', async () => {
    const originalSetTimeout = globalThis.setTimeout;
    let delayedReload: (() => void) | null = null;
    const setTimeoutSpy = vi
      .spyOn(globalThis, 'setTimeout')
      .mockImplementation(((callback: Parameters<typeof setTimeout>[0], timeout?: number, ...args: unknown[]) => {
        if (timeout === 1500) {
          delayedReload = () => {
            if (typeof callback === 'function') {
              callback();
            }
          };
          return originalSetTimeout(() => undefined, 0);
        }
        return originalSetTimeout(callback, timeout, ...args);
      }) as typeof setTimeout);

    try {
      const response = await postUpsertServer({
        catalogId: 'mock-connector',
        email: 'user@example.com',
      });

      expect(response.status).toBe(200);
      expect(response.body.outcome).toBe('added');
      expect(reloadSuperMcpNowForChatPackageMaterializationMock).not.toHaveBeenCalled();
      expect(restartSuperMcpForConfigChangeAndAwaitExecutionMock).not.toHaveBeenCalled();
      expect(delayedReload).toBeTypeOf('function');

      const runDelayedReload: unknown = delayedReload;
      if (typeof runDelayedReload !== 'function') {
        throw new Error('Expected delayed reload callback to be captured');
      }
      runDelayedReload();
      await Promise.resolve();

      expect(reloadSuperMcpNowForChatPackageMaterializationMock).toHaveBeenCalledWith(
        '/tmp/mcp.json',
        'bundled-inbox-bridge:catalog upsert',
        'chat-package-materialization',
      );
      expect(restartSuperMcpForConfigChangeAndAwaitExecutionMock).not.toHaveBeenCalled();
    } finally {
      setTimeoutSpy.mockRestore();
    }
  });
});
