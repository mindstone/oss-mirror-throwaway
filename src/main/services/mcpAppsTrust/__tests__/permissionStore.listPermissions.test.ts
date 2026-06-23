import { beforeEach, describe, expect, it } from 'vitest';
import type { KeyValueStore } from '@core/store';
import {
  _setPermissionStoreForTests,
  ensureKnownV1ToolGrant,
  grant,
  listPermissions,
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

describe('mcpAppsTrust permissionStore listPermissions', () => {
  beforeEach(() => {
    _setPermissionStoreForTests(createMemoryStore());
  });

  it('returns an empty list for an empty store', () => {
    expect(listPermissions()).toEqual([]);
  });

  it('lists the stored permission shape without future metadata fields', () => {
    const store = createMemoryStore();
    _setPermissionStoreForTests(store);
    store.set('mcpAppsTrust.permissions', {
      'GoogleWorkspace-joshua-example-com': {
        'conversation-1': {
          granted: true,
          grantedAt: '2026-05-10T00:00:00.000Z',
          methods: ['ui/sendMessage'],
          toolAllowlist: ['send_workspace_email'],
          futureAuditField: { retained: true },
        },
      },
    });

    expect(listPermissions()).toEqual([
      {
        sourcePackageId: 'GoogleWorkspace-joshua-example-com',
        conversationId: 'conversation-1',
        granted: true,
        grantedAt: '2026-05-10T00:00:00.000Z',
        methods: ['ui/sendMessage'],
        toolAllowlist: ['send_workspace_email'],
      },
    ]);
  });

  it('lists multiple packages and conversations in deterministic order', () => {
    grant({
      sourcePackageId: 'Zoom-user-2',
      conversationId: 'conversation-2',
    }, ['ui/updateModelContext']);
    grant({
      sourcePackageId: 'GoogleWorkspace-user-1',
      conversationId: 'conversation-2',
    }, ['ui/sendMessage']);
    grant({
      sourcePackageId: 'GoogleWorkspace-user-1',
      conversationId: 'conversation-1',
    }, ['ui/updateModelContext']);

    expect(listPermissions().map((permission) => [
      permission.sourcePackageId,
      permission.conversationId,
      permission.methods,
    ])).toEqual([
      ['GoogleWorkspace-user-1', 'conversation-1', ['ui/updateModelContext']],
      ['GoogleWorkspace-user-1', 'conversation-2', ['ui/sendMessage']],
      ['Zoom-user-2', 'conversation-2', ['ui/updateModelContext']],
    ]);
  });

  it('includes auto-granted tool entries', () => {
    ensureKnownV1ToolGrant({
      sourcePackageId: 'GoogleWorkspace-joshua-example-com',
      conversationId: 'conversation-1',
    }, 'google-workspace', 'send_workspace_email');

    expect(listPermissions()).toEqual([
      expect.objectContaining({
        sourcePackageId: 'GoogleWorkspace-joshua-example-com',
        conversationId: 'conversation-1',
        granted: true,
        methods: [],
        toolAllowlist: ['send_workspace_email'],
      }),
    ]);
  });
});
