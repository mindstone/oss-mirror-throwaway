import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings } from '@shared/types';

const mocks = vi.hoisted(() => ({
  configPath: '/tmp/mcp.json' as string | null,
  readFile: vi.fn(),
  skippedServers: [] as Array<{ id: string; reason: string }>,
  superMcpState: { isRunning: true, port: 3200 },
  // Must mirror the real exported constant in mcpService.ts — the health check
  // classifies a `status:'error'` summary carrying exactly this message as a
  // transient `warn` (REBEL-ZF).
  fsExhaustionMsg: 'too many open files — close other apps or restart your machine',
}));

vi.mock('node:fs/promises', () => ({
  default: {
    readFile: mocks.readFile,
  },
  readFile: mocks.readFile,
}));

vi.mock('../../../superMcpHttpManager', () => ({
  superMcpHttpManager: {
    getState: () => mocks.superMcpState,
    getSkippedServers: () => mocks.skippedServers,
  },
}));

vi.mock('../../../mcpService', () => ({
  resolveMcpConfigPath: () => mocks.configPath,
  describeMcpConfiguration: vi.fn(),
  MCP_CONFIG_FS_EXHAUSTION_MESSAGE: mocks.fsExhaustionMsg,
}));

import { checkBundledServers, checkMcpSkippedServers, checkMcpConfigValid } from '../mcp';
import { describeMcpConfiguration } from '../../../mcpService';

const SETTINGS = {} as AppSettings;

const SPLIT_SERVERS = [
  'RebelInbox',
  'RebelMeetings',
  'RebelSearchAndConversations',
  'RebelAutomations',
  'RebelSpaces',
  'RebelSettings',
  'RebelMcpConnectors',
] as const;

function mockMcpServers(serverNames: readonly string[]): void {
  mocks.readFile.mockResolvedValue(
    JSON.stringify({
      mcpServers: Object.fromEntries(serverNames.map((name) => [name, {}])),
    }),
  );
}

describe('checkBundledServers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.configPath = '/tmp/mcp.json';
    mocks.superMcpState = { isRunning: true, port: 3200 };
    mocks.skippedServers = [];
  });

  it('returns skip without details when no config path is configured', async () => {
    mocks.configPath = null;

    const result = await checkBundledServers(SETTINGS);

    expect(result).toMatchObject({
      id: 'bundledServers',
      status: 'skip',
    });
    expect(result).not.toHaveProperty('details');
  });

  it('preserves the all-present pass branch details shape with splitServers, not present', async () => {
    mockMcpServers([...SPLIT_SERVERS, 'RebelDiagnostics']);

    const result = await checkBundledServers(SETTINGS);

    expect(result.status).toBe('pass');
    expect(result.details).toEqual({
      splitServers: [...SPLIT_SERVERS],
      diagnostics: true,
    });
    expect(result.details).not.toHaveProperty('present');
    expect(result.details).not.toHaveProperty('missing');
  });

  it('preserves the partial-present pass branch details shape', async () => {
    mockMcpServers(['RebelInbox', 'RebelDiagnostics']);

    const result = await checkBundledServers(SETTINGS);

    expect(result.status).toBe('pass');
    expect(result.details).toEqual({
      present: ['RebelInbox'],
      missing: SPLIT_SERVERS.filter((name) => name !== 'RebelInbox'),
      diagnostics: true,
    });
  });

  it('preserves the warn branch details shape', async () => {
    mockMcpServers(['RebelMeetings']);

    const result = await checkBundledServers(SETTINGS);

    expect(result.status).toBe('warn');
    expect(result.details).toEqual({
      present: ['RebelMeetings'],
      missing: SPLIT_SERVERS.filter((name) => name !== 'RebelMeetings'),
      diagnostics: false,
    });
  });

  it('keeps catch-branch raw errors outside the safe allowlist', async () => {
    mocks.readFile.mockRejectedValue(new Error('alice@example.com'));

    const result = await checkBundledServers(SETTINGS);

    expect(result.status).toBe('warn');
    expect(result.details).toEqual({ error: 'alice@example.com' });
  });
});

describe('checkMcpSkippedServers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.superMcpState = { isRunning: true, port: 3200 };
    mocks.skippedServers = [];
  });

  it('returns skip without details when Super-MCP is not running', () => {
    mocks.superMcpState = { isRunning: false, port: 3200 };
    const result = checkMcpSkippedServers();

    expect(result).toMatchObject({
      id: 'mcpSkippedServers',
      status: 'skip',
    });
    expect(result).not.toHaveProperty('details');
  });

  it('returns pass without details when no servers are skipped', () => {
    const result = checkMcpSkippedServers();

    expect(result).toMatchObject({
      id: 'mcpSkippedServers',
      status: 'pass',
    });
    expect(result).not.toHaveProperty('details');
  });

  it('preserves skipped-server warn details while typing the allowlisted count', () => {
    mocks.skippedServers = [{ id: 'Custom-alice-example-com', reason: 'bad config' }];

    const result = checkMcpSkippedServers();

    expect(result.status).toBe('warn');
    expect(result.details).toEqual({
      skippedCount: 1,
      servers: [{ id: 'Custom-alice-example-com', reason: 'bad config' }],
    });
  });
});

describe('checkMcpConfigValid — transient fs-exhaustion classification (REBEL-ZF)', () => {
  const describeMock = vi.mocked(describeMcpConfiguration);

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.configPath = '/tmp/mcp.json';
    mocks.superMcpState = { isRunning: true, port: 3200 };
  });

  it('classifies a transient EMFILE config-read summary as warn, not fail', async () => {
    describeMock.mockResolvedValue({
      status: 'error',
      mode: 'none',
      configPath: '/tmp/mcp.json',
      servers: [],
      upstreamCount: 0,
      router: null,
      lastLoadedAt: 1,
      error: mocks.fsExhaustionMsg,
    } as never);

    const result = await checkMcpConfigValid(SETTINGS);

    expect(result.status).toBe('warn');
    expect(result.id).toBe('mcpConfigValid');
  });

  it('still hard-fails a genuine (non-transient) config error', async () => {
    describeMock.mockResolvedValue({
      status: 'error',
      mode: 'none',
      configPath: '/tmp/mcp.json',
      servers: [],
      upstreamCount: 0,
      router: null,
      lastLoadedAt: 1,
      error: 'Unexpected token } in JSON at position 42',
    } as never);

    const result = await checkMcpConfigValid(SETTINGS);

    expect(result.status).toBe('fail');
  });

  it('treats a thrown EMFILE as a transient warn (defensive catch branch)', async () => {
    describeMock.mockRejectedValue(
      Object.assign(new Error('EMFILE: too many open files, open /tmp/mcp.json'), { code: 'EMFILE' }),
    );

    const result = await checkMcpConfigValid(SETTINGS);

    expect(result.status).toBe('warn');
  });

  it('still hard-fails a thrown non-resource error', async () => {
    describeMock.mockRejectedValue(new Error('boom'));

    const result = await checkMcpConfigValid(SETTINGS);

    expect(result.status).toBe('fail');
  });
});
