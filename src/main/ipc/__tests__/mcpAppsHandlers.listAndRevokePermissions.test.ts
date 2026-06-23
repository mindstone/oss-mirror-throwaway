import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';
import type { KeyValueStore } from '@core/store';
import {
  handleGrantPermission,
  handleListPermissions,
  handleRevokePermission,
} from '../mcpAppsHandlers';
import {
  _setPermissionStoreForTests,
  grant,
  grantTool,
  isGranted,
  isToolAllowed,
} from '../../services/mcpAppsTrust';
import { hashSourcePackageId } from '../../services/mcpAppsTrust/safeLogging';
import {
  MCP_APPS_BROADCAST_CHANNELS,
  mcpAppsChannels,
} from '@shared/ipc/channels/mcpApps';

const mockSendToAllWindows = vi.hoisted(() => vi.fn());
const mockLogger = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

 
vi.mock('electron', () => ({
  app: { getPath: () => '/tmp' },
  ipcMain: { handle: vi.fn() },
  shell: { openPath: vi.fn() },
}));

 
vi.mock('@core/broadcastService', async () => {
  const { createBroadcastServiceMock } = await import('@shared/__tests__/testModuleMocks');
  return createBroadcastServiceMock({ sendToAllWindows: mockSendToAllWindows });
});

 
vi.mock('@core/logger', () => ({
  createScopedLogger: () => mockLogger,
}));

 
vi.mock('../../services/superMcpHttpManager', () => ({
  superMcpHttpManager: {
    getState: () => ({ isRunning: false, url: null }),
  },
}));

type TestPermissionEntry = {
  granted: boolean;
  grantedAt: string;
  methods: string[];
  toolAllowlist?: string[];
  [key: string]: unknown;
};

type StoreState = {
  'mcpAppsTrust.permissions': Record<string, Record<string, TestPermissionEntry>>;
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

const scope = {
  sourcePackageId: 'GoogleWorkspace-joshua-example-com',
  conversationId: 'conversation-1',
};

describe('mcpAppsHandlers list and revoke permissions', () => {
  beforeEach(() => {
    _setPermissionStoreForTests(createMemoryStore());
    mockSendToAllWindows.mockReset();
    mockLogger.info.mockReset();
    mockLogger.warn.mockReset();
    mockLogger.error.mockReset();
  });

  it('handleListPermissions returns the expected shape', async () => {
    grant(scope, ['ui/sendMessage']);
    grantTool(scope, 'send_workspace_email');

    await expect(handleListPermissions({})).resolves.toEqual({
      permissions: [
        expect.objectContaining({
          sourcePackageId: scope.sourcePackageId,
          conversationId: scope.conversationId,
          granted: true,
          methods: ['ui/sendMessage'],
          toolAllowlist: ['send_workspace_email'],
        }),
      ],
    });
  });

  it('handleRevokePermission revokes a method grant', async () => {
    grant(scope, ['ui/sendMessage']);

    await expect(handleRevokePermission({
      scope: 'method',
      ...scope,
      method: 'ui/sendMessage',
    })).resolves.toEqual({ success: true });

    expect(isGranted(scope, 'ui/sendMessage')).toBe(false);
  });

  it('handleRevokePermission revokes a tool grant', async () => {
    grantTool(scope, 'send_workspace_email');

    await expect(handleRevokePermission({
      scope: 'tool',
      ...scope,
      toolName: 'send_workspace_email',
    })).resolves.toEqual({ success: true });

    expect(isToolAllowed(scope, 'send_workspace_email')).toBe(false);
  });

  it('handleRevokePermission revokes one conversation grant for the selected package', async () => {
    grant(scope, ['ui/sendMessage']);
    grantTool(scope, 'send_workspace_email');
    grant({
      sourcePackageId: 'Zoom-user-2',
      conversationId: scope.conversationId,
    }, ['ui/sendMessage']);

    await expect(handleRevokePermission({
      scope: 'conversation',
      ...scope,
    })).resolves.toEqual({ success: true });

    expect(isGranted(scope, 'ui/sendMessage')).toBe(false);
    expect(isToolAllowed(scope, 'send_workspace_email')).toBe(false);
    expect(isGranted({
      sourcePackageId: 'Zoom-user-2',
      conversationId: scope.conversationId,
    }, 'ui/sendMessage')).toBe(true);
  });

  it('handleRevokePermission revokes every conversation for a package', async () => {
    grant(scope, ['ui/sendMessage']);
    grant({ ...scope, conversationId: 'conversation-2' }, ['ui/updateModelContext']);
    grant({
      sourcePackageId: 'Zoom-user-2',
      conversationId: 'conversation-1',
    }, ['ui/sendMessage']);

    await expect(handleRevokePermission({
      scope: 'package',
      sourcePackageId: scope.sourcePackageId,
    })).resolves.toEqual({ success: true });

    expect(isGranted(scope, 'ui/sendMessage')).toBe(false);
    expect(isGranted({ ...scope, conversationId: 'conversation-2' }, 'ui/updateModelContext')).toBe(false);
    expect(isGranted({
      sourcePackageId: 'Zoom-user-2',
      conversationId: 'conversation-1',
    }, 'ui/sendMessage')).toBe(true);
  });

  it('logs permission_revoked with safe source attribution only', async () => {
    grant(scope, ['ui/sendMessage']);

    await handleRevokePermission({
      scope: 'method',
      ...scope,
      method: 'ui/sendMessage',
    });

    const revokedLog = mockLogger.info.mock.calls
      .map(([payload]) => payload)
      .find((payload) => payload && typeof payload === 'object' && (payload as { kind?: string }).kind === 'permission_revoked');

    expect(revokedLog).toMatchObject({
      kind: 'permission_revoked',
      scope: 'method',
      sourcePackageFamily: 'Google Workspace',
      sourcePackageIdHash: hashSourcePackageId(scope.sourcePackageId),
      conversationId: scope.conversationId,
      method: 'ui/sendMessage',
    });
    expect(JSON.stringify(revokedLog)).not.toContain(scope.sourcePackageId);
  });

  it('emits mcp:permission-changed broadcasts for grant and revoke', async () => {
    await handleGrantPermission({
      ...scope,
      method: 'ui/sendMessage',
    });

    expect(mockSendToAllWindows).toHaveBeenLastCalledWith(
      MCP_APPS_BROADCAST_CHANNELS.PERMISSION_CHANGED,
      {
        kind: 'granted',
        scope: 'method',
        sourcePackageId: scope.sourcePackageId,
        conversationId: scope.conversationId,
        method: 'ui/sendMessage',
      },
    );
    expect(mockLogger.info).toHaveBeenCalledWith(
      {
        kind: 'granted',
        scope: 'method',
        sourcePackageId: scope.sourcePackageId,
        conversationId: scope.conversationId,
        method: 'ui/sendMessage',
      },
      'mcp-app:permission-changed broadcast emitted',
    );

    await handleRevokePermission({
      scope: 'method',
      ...scope,
      method: 'ui/sendMessage',
    });

    expect(mockSendToAllWindows).toHaveBeenLastCalledWith(
      MCP_APPS_BROADCAST_CHANNELS.PERMISSION_CHANGED,
      {
        kind: 'revoked',
        scope: 'method',
        sourcePackageId: scope.sourcePackageId,
        conversationId: scope.conversationId,
        method: 'ui/sendMessage',
      },
    );

    await handleGrantPermission({
      ...scope,
      method: 'tools/call',
      toolName: 'send_workspace_email',
    });

    expect(mockSendToAllWindows).toHaveBeenLastCalledWith(
      MCP_APPS_BROADCAST_CHANNELS.PERMISSION_CHANGED,
      {
        kind: 'granted',
        scope: 'tool',
        sourcePackageId: scope.sourcePackageId,
        conversationId: scope.conversationId,
        method: 'tools/call',
        toolName: 'send_workspace_email',
      },
    );
    expect(mockLogger.info).toHaveBeenCalledWith(
      {
        kind: 'granted',
        scope: 'tool',
        sourcePackageId: scope.sourcePackageId,
        conversationId: scope.conversationId,
        method: 'tools/call',
      },
      'mcp-app:permission-changed broadcast emitted',
    );
  });

  it('rejects invalid revoke-permission schema variants', async () => {
    const schema = mcpAppsChannels['mcp:revoke-permission'].request;

    expect(() => schema.parse({
      scope: 'workspace',
      sourcePackageId: scope.sourcePackageId,
    })).toThrow(ZodError);
    expect(() => schema.parse({
      scope: 'method',
      sourcePackageId: scope.sourcePackageId,
      method: 'ui/sendMessage',
    })).toThrow(ZodError);
    expect(() => schema.parse({
      scope: 'method',
      ...scope,
      method: 'ui/unknown',
    })).toThrow(ZodError);
    await expect(handleRevokePermission({
      scope: 'method',
      ...scope,
      method: 'ui/unknown',
    } as never)).rejects.toThrow(ZodError);
  });
});
