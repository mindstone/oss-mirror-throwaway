import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  registeredHandlers,
  getSlackWorkspacesMock,
  getSlackTokensForWorkspaceMock,
  fetchMock,
} = vi.hoisted(() => ({
  registeredHandlers: new Map<string, (event: unknown, request: { userId: string; packageId?: string; teamId?: string }) => Promise<unknown>>(),
  getSlackWorkspacesMock: vi.fn(),
  getSlackTokensForWorkspaceMock: vi.fn(),
  fetchMock: vi.fn(),
}));

vi.mock('../utils/registerHandler', () => ({
  registerHandler: (
    channel: string,
    handler: (event: unknown, request: { userId: string; packageId?: string; teamId?: string }) => Promise<unknown>,
  ) => {
    registeredHandlers.set(channel, handler);
  },
}));

vi.mock('../../services/slackAuthService', () => ({
  getSlackWorkspaces: getSlackWorkspacesMock,
  getSlackTokensForWorkspace: getSlackTokensForWorkspaceMock,
  getSlackConfigDir: vi.fn(() => '/tmp/slack'),
  startSlackAuth: vi.fn(),
  removeSlackWorkspace: vi.fn(),
  cancelSlackAuth: vi.fn(),
}));

vi.mock('../../services/oauthCredentials', () => ({
  resolveOAuthCredentials: vi.fn(() => null),
  slackCredentialSource: {},
}));

vi.mock('../../services/mcpConfigManager', () => ({
  upsertMcpServerEntry: vi.fn(),
  removeMcpServerEntry: vi.fn(),
}));

vi.mock('../../services/mcpServerRemovalService', () => ({
  removeMcpServerWithCleanup: vi.fn(),
}));

vi.mock('../../services/bundledMcpManager', () => ({
  buildSlackInstancePayload: vi.fn(() => ({})),
}));

vi.mock('../../services/mcpService', () => ({
  resolveMcpConfigPath: vi.fn(() => null),
  reconfigureSuperMcpWithCacheRefreshResolvingOnDeferral: vi.fn(async () => ({ queued: false })),
}));

vi.mock('../../settingsStore', () => ({
  getSettings: vi.fn(() => ({})),
}));

import { registerSlackHandlers } from '../slackHandlers';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function getResolveUserHandler() {
  const handler = registeredHandlers.get('slack:resolve-user');
  if (!handler) throw new Error('slack:resolve-user handler was not registered');
  return handler;
}

describe('registerSlackHandlers slack:resolve-user', () => {
  beforeEach(() => {
    registeredHandlers.clear();
    vi.stubGlobal('fetch', fetchMock);
    getSlackWorkspacesMock.mockReset();
    getSlackTokensForWorkspaceMock.mockReset();
    fetchMock.mockReset();
    registerSlackHandlers();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('resolves a Slack mention within the explicitly requested workspace', async () => {
    getSlackWorkspacesMock.mockResolvedValue([
      { teamId: 'T1', teamName: 'First Team' },
      { teamId: 'T2', teamName: 'Second Team' },
    ]);
    getSlackTokensForWorkspaceMock.mockResolvedValue({ botToken: 'xoxb-token' });
    fetchMock.mockResolvedValue(jsonResponse({
      ok: true,
      user: {
        id: 'U123',
        profile: { display_name: 'Bob Brown', email: 'bob@example.com' },
      },
    }));

    const result = await getResolveUserHandler()(null, {
      teamId: 'T2',
      userId: '<@U123|bob>',
    });

    expect(result).toEqual({
      success: true,
      user: {
        id: 'U123',
        displayName: 'Bob Brown',
        realName: undefined,
        email: 'bob@example.com',
      },
    });
    expect(getSlackTokensForWorkspaceMock).toHaveBeenCalledTimes(1);
    expect(getSlackTokensForWorkspaceMock).toHaveBeenCalledWith('T2');
    const requestUrl = new URL(fetchMock.mock.calls[0][0] as string);
    expect(requestUrl.searchParams.get('user')).toBe('U123');
  });

  it('fails closed when an explicit package does not match a connected workspace', async () => {
    getSlackWorkspacesMock.mockResolvedValue([
      { teamId: 'T1', teamName: 'First Team' },
    ]);

    const result = await getResolveUserHandler()(null, {
      packageId: 'Slack-unknown',
      userId: 'U123',
    });

    expect(result).toEqual({ success: false, error: 'Slack workspace not found' });
    expect(getSlackTokensForWorkspaceMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not search other workspaces when explicit workspace lookup fails', async () => {
    getSlackWorkspacesMock.mockResolvedValue([
      { teamId: 'T1', teamName: 'First Team' },
      { teamId: 'T2', teamName: 'Second Team' },
    ]);
    getSlackTokensForWorkspaceMock.mockImplementation(async (teamId: string) => (
      teamId === 'T1' ? { botToken: 'xoxb-first' } : { botToken: 'xoxb-second' }
    ));
    fetchMock.mockResolvedValue(jsonResponse({ ok: false, error: 'user_not_found' }));

    const result = await getResolveUserHandler()(null, {
      teamId: 'T1',
      userId: 'U123',
    });

    expect(result).toEqual({ success: false, error: 'Slack user not found' });
    expect(getSlackTokensForWorkspaceMock).toHaveBeenCalledTimes(1);
    expect(getSlackTokensForWorkspaceMock).toHaveBeenCalledWith('T1');
  });
});
