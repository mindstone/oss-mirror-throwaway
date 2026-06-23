import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { KeyValueStore } from '@core/store';
import {
  handleCallTool,
  handleIssueNonce,
} from '../mcpAppsHandlers';
import {
  _resetNonceManagerForTests,
  _resetRateLimiterForTests,
  _setPermissionStoreForTests,
  grantTool,
  isToolAllowed,
} from '../../services/mcpAppsTrust';

const mockConnect = vi.hoisted(() => vi.fn());
const mockCallTool = vi.hoisted(() => vi.fn());
const mockClose = vi.hoisted(() => vi.fn());
const mockTerminateSession = vi.hoisted(() => vi.fn());

 
vi.mock('electron', () => ({
  app: { getPath: () => '/tmp' },
  ipcMain: { handle: vi.fn() },
  shell: { openPath: vi.fn() },
}));

 
vi.mock('@core/logger', () => ({
  createScopedLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

 
vi.mock('../../services/superMcpHttpManager', () => ({
  superMcpHttpManager: {
    getState: () => ({ isRunning: true, url: 'http://127.0.0.1:3100/mcp' }),
  },
}));

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: class {
    connect = mockConnect;
    callTool = mockCallTool;
    close = mockClose;
    constructor() {
      // no-op
    }
  },
}));

vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: class {
    terminateSession = mockTerminateSession;
    constructor(_url: URL) {
      // no-op
    }
  },
}));

type StoreState = {
  'mcpAppsTrust.permissions': Record<string, Record<string, {
    granted: boolean;
    grantedAt: string;
    methods: string[];
    toolAllowlist?: string[];
  }>>;
};

function createMemoryStore(): KeyValueStore<StoreState> {
  const state: StoreState = { 'mcpAppsTrust.permissions': {} };
  return {
    get: ((key: keyof StoreState, defaultValue?: StoreState[keyof StoreState]) =>
      state[key] ?? defaultValue) as KeyValueStore<StoreState>['get'],
    set: ((keyOrValues: keyof StoreState | Partial<StoreState>, value?: StoreState[keyof StoreState]) => {
      if (typeof keyOrValues === 'string') {
        state[keyOrValues] = value as StoreState[keyof StoreState];
        return;
      }
      Object.assign(state, keyOrValues);
    }) as KeyValueStore<StoreState>['set'],
    has: (key: string) => key in state,
    delete: (key: string) => {
      delete (state as Record<string, unknown>)[key];
    },
    clear: () => {
      state['mcpAppsTrust.permissions'] = {};
    },
    get store() {
      return state;
    },
    set store(value: StoreState) {
      state['mcpAppsTrust.permissions'] = value['mcpAppsTrust.permissions'];
    },
    path: ':memory:',
  };
}

const baseRequest = {
  appFamily: 'google-workspace',
  sourcePackageId: 'GoogleWorkspace-joshua-example-com',
  toolUseId: 'tool-1',
  sessionId: 'conversation-1',
  conversationId: 'conversation-1',
  iframeInstanceId: 'iframe-1',
  nonce: 'placeholder',
  toolName: 'send_workspace_email',
  args: { to: 'user@example.com' },
};

function issueValidNonce(): string {
  const response = handleIssueNonce({
    sourcePackageId: baseRequest.sourcePackageId,
    toolUseId: baseRequest.toolUseId,
    sessionId: baseRequest.sessionId,
    conversationId: baseRequest.conversationId,
    iframeInstanceId: baseRequest.iframeInstanceId,
  });
  expect(response.success).toBe(true);
  return response.success ? response.nonce : '';
}

describe('mcpAppsHandlers callTool', () => {
  beforeEach(() => {
    _resetNonceManagerForTests();
    _resetRateLimiterForTests();
    _setPermissionStoreForTests(createMemoryStore());
    mockConnect.mockReset();
    mockCallTool.mockReset();
    mockClose.mockReset();
    mockTerminateSession.mockReset();

    mockConnect.mockResolvedValue(undefined);
    mockClose.mockResolvedValue(undefined);
    mockTerminateSession.mockResolvedValue(undefined);
    mockCallTool.mockResolvedValue({
      isError: false,
      content: [{ type: 'text', text: 'sent' }],
    });
  });

  it('rejects existing iframe calls that omit nonce and host trust fields', async () => {
    const response = await handleCallTool({
      appFamily: baseRequest.appFamily,
      sourcePackageId: baseRequest.sourcePackageId,
      toolName: baseRequest.toolName,
      args: baseRequest.args,
    });

    expect(response).toMatchObject({
      success: false,
      rejection: {
        jsonRpcCode: -32602,
        reason: 'invalid_params',
      },
    });
    expect(mockCallTool).not.toHaveBeenCalled();
  });

  it('rejects stale nonces before tool allowlist checks', async () => {
    const response = await handleCallTool(baseRequest);

    expect(response).toMatchObject({
      success: false,
      rejection: {
        jsonRpcCode: -32603,
        reason: 'stale_nonce',
      },
    });
    expect(mockCallTool).not.toHaveBeenCalled();
  });

  it('rejects non-allowlisted tool calls after nonce and rate-limit enforcement', async () => {
    const response = await handleCallTool({
      ...baseRequest,
      nonce: issueValidNonce(),
      toolName: 'delete_all_emails',
    });

    expect(response).toMatchObject({
      success: false,
      rejection: {
        jsonRpcCode: -32603,
        reason: 'tool_not_allowed',
      },
    });
    expect(mockCallTool).not.toHaveBeenCalled();
  });

  it('auto-grants known v1 connector tool calls and executes via Super-MCP use_tool', async () => {
    const response = await handleCallTool({
      ...baseRequest,
      nonce: issueValidNonce(),
    });

    expect(response).toEqual({
      success: true,
      result: {
        isError: false,
        content: [{ type: 'text', text: 'sent' }],
      },
    });
    expect(isToolAllowed({
      sourcePackageId: baseRequest.sourcePackageId,
      conversationId: baseRequest.conversationId,
    }, 'send_workspace_email')).toBe(true);
    expect(mockCallTool).toHaveBeenCalledWith(
      {
        name: 'use_tool',
        arguments: {
          package_id: baseRequest.sourcePackageId,
          tool_id: 'send_workspace_email',
          args: baseRequest.args,
        },
      },
      undefined,
      expect.any(Object),
    );
  });

  it('does not filter iframe tool calls by app-only visibility when explicit grant permits the tool', async () => {
    grantTool({
      sourcePackageId: baseRequest.sourcePackageId,
      conversationId: baseRequest.conversationId,
    }, 'app_only_send');

    const response = await handleCallTool({
      ...baseRequest,
      nonce: issueValidNonce(),
      toolName: 'app_only_send',
    });

    expect(response.success).toBe(true);
    expect(mockCallTool).toHaveBeenCalledWith(
      expect.objectContaining({
        arguments: expect.objectContaining({ tool_id: 'app_only_send' }),
      }),
      undefined,
      expect.any(Object),
    );
  });

  it('consumes tools/call nonces so replaying the same nonce fails', async () => {
    const nonce = issueValidNonce();

    expect(await handleCallTool({ ...baseRequest, nonce })).toMatchObject({ success: true });
    expect(await handleCallTool({ ...baseRequest, nonce })).toMatchObject({
      success: false,
      rejection: { reason: 'stale_nonce' },
    });
  });
});
