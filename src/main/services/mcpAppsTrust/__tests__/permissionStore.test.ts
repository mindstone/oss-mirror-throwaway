import { beforeEach, describe, expect, it } from 'vitest';
import type { KeyValueStore } from '@core/store';
import {
  _setPermissionStoreForTests,
  cleanupConversation,
  ensureKnownV1ToolGrant,
  grant,
  grantTool,
  isGranted,
  isKnownV1McpAppTool,
  isToolAllowed,
  revoke,
} from '../permissionStore';

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

describe('mcpAppsTrust permissionStore', () => {
  beforeEach(() => {
    _setPermissionStoreForTests(createMemoryStore());
  });

  it('grants and checks methods per source/conversation', () => {
    expect(isGranted(scope, 'ui/updateModelContext')).toBe(false);

    grant(scope, ['ui/updateModelContext']);

    expect(isGranted(scope, 'ui/updateModelContext')).toBe(true);
    expect(isGranted(scope, 'ui/sendMessage')).toBe(false);
    expect(isGranted({ ...scope, conversationId: 'conversation-2' }, 'ui/updateModelContext')).toBe(false);
  });

  it('preserves future permission entry fields when granting more methods', () => {
    const store = createMemoryStore();
    _setPermissionStoreForTests(store);
    store.set('mcpAppsTrust.permissions', {
      [scope.sourcePackageId]: {
        [scope.conversationId]: {
          granted: false,
          grantedAt: '2026-05-10T00:00:00.000Z',
          methods: ['ui/sendMessage'],
          futureAuditField: { retained: true },
        },
      },
    });

    grant(scope, ['ui/updateModelContext']);

    expect(store.get('mcpAppsTrust.permissions', {})[scope.sourcePackageId]?.[scope.conversationId])
      .toEqual({
        granted: true,
        grantedAt: '2026-05-10T00:00:00.000Z',
        methods: ['ui/sendMessage', 'ui/updateModelContext'],
        futureAuditField: { retained: true },
      });
  });

  it('grants and checks tool allowlist entries per source/conversation', () => {
    expect(isToolAllowed(scope, 'send_workspace_email')).toBe(false);

    grantTool(scope, 'send_workspace_email');

    expect(isToolAllowed(scope, 'send_workspace_email')).toBe(true);
    expect(isToolAllowed(scope, 'delete_all_emails')).toBe(false);
    expect(isToolAllowed({ ...scope, conversationId: 'conversation-2' }, 'send_workspace_email')).toBe(false);
    expect(isGranted(scope, 'ui/updateModelContext')).toBe(false);
  });

  it('treats migrated entries without toolAllowlist as no tool access', () => {
    const store = createMemoryStore();
    _setPermissionStoreForTests(store);
    store.set('mcpAppsTrust.permissions', {
      [scope.sourcePackageId]: {
        [scope.conversationId]: {
          granted: true,
          grantedAt: '2026-05-10T00:00:00.000Z',
          methods: ['ui/sendMessage'],
        },
      },
    });

    expect(isGranted(scope, 'ui/sendMessage')).toBe(true);
    expect(isToolAllowed(scope, 'send_workspace_email')).toBe(false);
  });

  it('auto-grants known v1 connector tool pairs and denies unknown pairs', () => {
    expect(isKnownV1McpAppTool('google-workspace', 'send_workspace_email')).toBe(true);
    expect(isKnownV1McpAppTool('google-workspace', 'delete_all_emails')).toBe(false);

    expect(ensureKnownV1ToolGrant(scope, 'google-workspace', 'send_workspace_email')).toBe(true);
    expect(isToolAllowed(scope, 'send_workspace_email')).toBe(true);

    expect(ensureKnownV1ToolGrant(scope, 'google-workspace', 'delete_all_emails')).toBe(false);
    expect(isToolAllowed(scope, 'delete_all_emails')).toBe(false);
  });

  it('revokes one method or a whole conversation grant', () => {
    grant(scope, ['ui/updateModelContext', 'ui/sendMessage']);
    revoke(scope, ['ui/updateModelContext']);

    expect(isGranted(scope, 'ui/updateModelContext')).toBe(false);
    expect(isGranted(scope, 'ui/sendMessage')).toBe(true);

    revoke(scope);

    expect(isGranted(scope, 'ui/sendMessage')).toBe(false);
  });

  it('cleans up a deleted conversation across sources', () => {
    grant(scope, ['ui/updateModelContext']);
    grant({ sourcePackageId: 'OtherConnector-user-1', conversationId: scope.conversationId }, ['ui/updateModelContext']);
    grant({ ...scope, conversationId: 'conversation-2' }, ['ui/updateModelContext']);

    cleanupConversation(scope.conversationId);

    expect(isGranted(scope, 'ui/updateModelContext')).toBe(false);
    expect(isGranted({ sourcePackageId: 'OtherConnector-user-1', conversationId: scope.conversationId }, 'ui/updateModelContext')).toBe(false);
    expect(isGranted({ ...scope, conversationId: 'conversation-2' }, 'ui/updateModelContext')).toBe(true);
  });
});
