import { beforeEach, describe, expect, it } from 'vitest';
import type { KeyValueStore } from '@core/store';
import {
  _setPermissionStoreForTests,
  grant,
  grantTool,
  isGranted,
  isToolAllowed,
  revoke,
  revokePackage,
  revokeTool,
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

function getEntry(store: KeyValueStore<StoreState>, sourcePackageId = scope.sourcePackageId, conversationId = scope.conversationId): TestPermissionEntry | undefined {
  return store.get('mcpAppsTrust.permissions', {})[sourcePackageId]?.[conversationId];
}

describe('mcpAppsTrust permissionStore revoke semantics', () => {
  beforeEach(() => {
    _setPermissionStoreForTests(createMemoryStore());
  });

  it('deletes the entry when revoking the last method and toolAllowlist is empty', () => {
    grant(scope, ['ui/sendMessage']);

    revoke(scope, ['ui/sendMessage']);

    expect(isGranted(scope, 'ui/sendMessage')).toBe(false);
    expect(isToolAllowed(scope, 'send_workspace_email')).toBe(false);
  });

  it('preserves the entry when revoking the last method and toolAllowlist still has tools', () => {
    const store = createMemoryStore();
    _setPermissionStoreForTests(store);
    store.set('mcpAppsTrust.permissions', {
      [scope.sourcePackageId]: {
        [scope.conversationId]: {
          granted: true,
          grantedAt: '2026-05-10T00:00:00.000Z',
          methods: ['ui/sendMessage'],
          toolAllowlist: ['send_workspace_email'],
          futureAuditField: { retained: true },
        },
      },
    });

    revoke(scope, ['ui/sendMessage']);

    expect(getEntry(store)).toEqual({
      granted: true,
      grantedAt: '2026-05-10T00:00:00.000Z',
      methods: [],
      toolAllowlist: ['send_workspace_email'],
      futureAuditField: { retained: true },
    });
  });

  it('revokeTool removes one tool when other methods and tools remain', () => {
    const store = createMemoryStore();
    _setPermissionStoreForTests(store);
    store.set('mcpAppsTrust.permissions', {
      [scope.sourcePackageId]: {
        [scope.conversationId]: {
          granted: true,
          grantedAt: '2026-05-10T00:00:00.000Z',
          methods: ['ui/sendMessage'],
          toolAllowlist: ['draft_email', 'send_workspace_email'],
          futureAuditField: { retained: true },
        },
      },
    });

    revokeTool(scope, 'draft_email');

    expect(getEntry(store)).toEqual({
      granted: true,
      grantedAt: '2026-05-10T00:00:00.000Z',
      methods: ['ui/sendMessage'],
      toolAllowlist: ['send_workspace_email'],
      futureAuditField: { retained: true },
    });
  });

  it('deletes the entry when revokeTool removes the last tool and methods are empty', () => {
    grantTool(scope, 'send_workspace_email');

    revokeTool(scope, 'send_workspace_email');

    expect(isToolAllowed(scope, 'send_workspace_email')).toBe(false);
    expect(isGranted(scope, 'ui/sendMessage')).toBe(false);
  });

  it('revokePackage removes all conversations for a package only', () => {
    grant(scope, ['ui/sendMessage']);
    grant({ ...scope, conversationId: 'conversation-2' }, ['ui/updateModelContext']);
    grant({
      sourcePackageId: 'Zoom-user-2',
      conversationId: 'conversation-1',
    }, ['ui/sendMessage']);

    revokePackage(scope.sourcePackageId);

    expect(isGranted(scope, 'ui/sendMessage')).toBe(false);
    expect(isGranted({ ...scope, conversationId: 'conversation-2' }, 'ui/updateModelContext')).toBe(false);
    expect(isGranted({
      sourcePackageId: 'Zoom-user-2',
      conversationId: 'conversation-1',
    }, 'ui/sendMessage')).toBe(true);
  });

  it('revokeTool is a no-op when the toolName is not in the allowlist', () => {
    const store = createMemoryStore();
    _setPermissionStoreForTests(store);
    store.set('mcpAppsTrust.permissions', {
      [scope.sourcePackageId]: {
        [scope.conversationId]: {
          granted: true,
          grantedAt: '2026-05-10T00:00:00.000Z',
          methods: [],
          toolAllowlist: ['send_workspace_email'],
          futureAuditField: { retained: true },
        },
      },
    });

    revokeTool(scope, 'draft_email');

    expect(getEntry(store)).toEqual({
      granted: true,
      grantedAt: '2026-05-10T00:00:00.000Z',
      methods: [],
      toolAllowlist: ['send_workspace_email'],
      futureAuditField: { retained: true },
    });
  });

  it('preserves unknown future fields when revoking one method while another remains', () => {
    const store = createMemoryStore();
    _setPermissionStoreForTests(store);
    store.set('mcpAppsTrust.permissions', {
      [scope.sourcePackageId]: {
        [scope.conversationId]: {
          granted: true,
          grantedAt: '2026-05-10T00:00:00.000Z',
          methods: ['ui/sendMessage', 'ui/updateModelContext'],
          futureAuditField: { retained: true },
        },
      },
    });

    revoke(scope, ['ui/sendMessage']);

    expect(getEntry(store)).toEqual({
      granted: true,
      grantedAt: '2026-05-10T00:00:00.000Z',
      methods: ['ui/updateModelContext'],
      futureAuditField: { retained: true },
    });
  });
});
