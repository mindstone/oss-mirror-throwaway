import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { KeyValueStore } from '@core/store';
import {
  handleIssueNonce,
  handleUpdateModelContext,
} from '../mcpAppsHandlers';
import {
  _resetNonceManagerForTests,
  _resetRateLimiterForTests,
  _setPermissionStoreForTests,
  grant,
} from '../../services/mcpAppsTrust';
import {
  _resetMcpAppModelContextStoreForTests,
  getContextsForConversation,
} from '../../services/mcpAppModelContextStore';

 
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
    getState: () => ({ isRunning: false, url: null }),
  },
}));

type StoreState = {
  'mcpAppsTrust.permissions': Record<string, Record<string, { granted: boolean; grantedAt: string; methods: string[] }>>;
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
  sourcePackageId: 'GoogleWorkspace-joshua-example-com',
  toolUseId: 'tool-1',
  sessionId: 'conversation-1',
  conversationId: 'conversation-1',
  iframeInstanceId: 'iframe-1',
  nonce: 'placeholder',
  content: 'Draft recipient is alice@example.com',
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

describe('mcpAppsHandlers updateModelContext', () => {
  beforeEach(() => {
    _resetNonceManagerForTests();
    _resetRateLimiterForTests();
    _resetMcpAppModelContextStoreForTests();
    _setPermissionStoreForTests(createMemoryStore());
  });

  it('rejects stale nonces', () => {
    const response = handleUpdateModelContext(baseRequest);

    expect(response).toMatchObject({
      success: false,
      rejection: {
        jsonRpcCode: -32603,
        reason: 'stale_nonce',
      },
    });
  });

  it('rejects permission-denied requests after nonce validation', () => {
    const nonce = issueValidNonce();

    const response = handleUpdateModelContext({ ...baseRequest, nonce });

    expect(response).toMatchObject({
      success: false,
      rejection: {
        jsonRpcCode: -32603,
        reason: 'permission_denied',
      },
    });
  });

  it('counts permission-denied attempts against updateModelContext rate limits', () => {
    for (let index = 0; index < 5; index += 1) {
      expect(handleUpdateModelContext({
        ...baseRequest,
        nonce: issueValidNonce(),
        content: `denied ${index}`,
      })).toMatchObject({
        success: false,
        rejection: { reason: 'permission_denied' },
      });
    }

    grant({
      sourcePackageId: baseRequest.sourcePackageId,
      conversationId: baseRequest.conversationId,
    }, ['ui/updateModelContext']);

    expect(handleUpdateModelContext({ ...baseRequest, nonce: issueValidNonce(), content: 'now granted' })).toMatchObject({
      success: false,
      rejection: {
        jsonRpcCode: -32029,
        reason: 'rate_limited',
      },
    });
  });

  it('rejects invalid params after permission passes', () => {
    const nonce = issueValidNonce();
    grant({
      sourcePackageId: baseRequest.sourcePackageId,
      conversationId: baseRequest.conversationId,
    }, ['ui/updateModelContext']);

    const response = handleUpdateModelContext({
      ...baseRequest,
      nonce,
      content: 'x'.repeat(16_385),
    });

    expect(response).toMatchObject({
      success: false,
      rejection: {
        jsonRpcCode: -32602,
        reason: 'invalid_params',
      },
    });
  });

  it('stores context when nonce, rate limit, permission, and payload validation pass', () => {
    const nonce = issueValidNonce();
    grant({
      sourcePackageId: baseRequest.sourcePackageId,
      conversationId: baseRequest.conversationId,
    }, ['ui/updateModelContext']);

    const response = handleUpdateModelContext({
      ...baseRequest,
      nonce,
      structuredContent: { recipient: 'alice@example.com' },
    });

    expect(response).toEqual({ success: true });
    expect(getContextsForConversation(baseRequest.conversationId)).toEqual([
      expect.objectContaining({
        sourcePackageId: baseRequest.sourcePackageId,
        content: baseRequest.content,
        structuredContent: { recipient: 'alice@example.com' },
        toolUseId: baseRequest.toolUseId,
      }),
    ]);
  });

  it('consumes updateModelContext nonces so replaying the same nonce fails', () => {
    const nonce = issueValidNonce();
    grant({
      sourcePackageId: baseRequest.sourcePackageId,
      conversationId: baseRequest.conversationId,
    }, ['ui/updateModelContext']);

    expect(handleUpdateModelContext({ ...baseRequest, nonce, content: 'first context' }))
      .toEqual({ success: true });
    expect(handleUpdateModelContext({ ...baseRequest, nonce, content: 'replayed context' }))
      .toMatchObject({
        success: false,
        rejection: {
          reason: 'stale_nonce',
        },
      });
    expect(getContextsForConversation(baseRequest.conversationId)).toEqual([
      expect.objectContaining({ content: 'first context' }),
    ]);
  });

  it('rejects rate-limited requests before storing another context', () => {
    grant({
      sourcePackageId: baseRequest.sourcePackageId,
      conversationId: baseRequest.conversationId,
    }, ['ui/updateModelContext']);

    for (let index = 0; index < 5; index += 1) {
      expect(handleUpdateModelContext({
        ...baseRequest,
        nonce: issueValidNonce(),
        content: `context ${index}`,
      })).toEqual({ success: true });
    }

    const response = handleUpdateModelContext({ ...baseRequest, nonce: issueValidNonce(), content: 'one too many' });

    expect(response).toMatchObject({
      success: false,
      rejection: {
        jsonRpcCode: -32029,
        reason: 'rate_limited',
      },
    });
    expect(getContextsForConversation(baseRequest.conversationId)).toEqual([
      expect.objectContaining({ content: 'context 4' }),
    ]);
  });

  it('rate-limits excessive ui/initialize nonce issuance and records rejected attempts', () => {
    for (let index = 0; index < 30; index += 1) {
      expect(handleIssueNonce({
        sourcePackageId: baseRequest.sourcePackageId,
        toolUseId: baseRequest.toolUseId,
        sessionId: baseRequest.sessionId,
        conversationId: baseRequest.conversationId,
        iframeInstanceId: baseRequest.iframeInstanceId,
      }).success).toBe(true);
    }

    const overLimit = handleIssueNonce({
      sourcePackageId: baseRequest.sourcePackageId,
      toolUseId: baseRequest.toolUseId,
      sessionId: baseRequest.sessionId,
      conversationId: baseRequest.conversationId,
      iframeInstanceId: baseRequest.iframeInstanceId,
    });
    expect(overLimit).toMatchObject({
      success: false,
      rejection: {
        jsonRpcCode: -32029,
        reason: 'rate_limited',
      },
    });
  });
});
