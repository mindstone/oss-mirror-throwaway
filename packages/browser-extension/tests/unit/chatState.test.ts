/**
 * Stage 5 — chatState CRUD + storage-change subscription.
 *
 * Covers:
 *   - `getChatState` returns a default empty shape when nothing is stored,
 *     when storage rejects, or when the stored value is malformed
 *   - `setChatState` persists only the known fields (drops undefined)
 *   - `clearChatState` removes the storage key
 *   - `onStorageChanged` fires the callback with the new state and returns
 *     an unsubscribe handle that detaches the listener
 *
 * @see docs/plans/260421_embedded_chat_in_extension.md (Stage 5)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearChatState,
  createExtensionScopedChatStatePersistence,
  getChatState,
  LEGACY_BROWSER_CHAT_STATE_KEY,
  onStorageChanged,
  setChatState,
  TEST_SCOPES,
  type ChatState,
} from '../../src/lib/chatState';
import { SESSION_AUTH_STORAGE_KEY } from '../../src/lib/browserAuth';
import { buildBrowserTabScope } from '../../src/lib/chatScope';

const storageKeyForScope = (scope: { key: string }) =>
  `rebel.chat.scope.v1.${encodeURIComponent(scope.key)}`;

type StorageListener = (
  changes: { [key: string]: chrome.storage.StorageChange },
  area: chrome.storage.AreaName,
) => void;

interface FakeStorage {
  readonly store: Map<string, unknown>;
  readonly sessionStore: Map<string, unknown>;
  readonly listeners: Set<StorageListener>;
  get: ReturnType<typeof vi.fn>;
  sessionGet: ReturnType<typeof vi.fn>;
  sessionSet: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
}

function installFakeChrome(): FakeStorage {
  const store = new Map<string, unknown>();
  const sessionStore = new Map<string, unknown>();
  const listeners = new Set<StorageListener>();

  const get = vi.fn(async (key: string | null) => {
    if (key === null) {
      return Object.fromEntries(store.entries());
    }
    const val = store.get(key);
    return val === undefined ? {} : { [key]: val };
  });
  const set = vi.fn(async (obj: Record<string, unknown>) => {
    const changes: Record<string, chrome.storage.StorageChange> = {};
    for (const [k, v] of Object.entries(obj)) {
      const prev = store.get(k);
      store.set(k, v);
      changes[k] = { oldValue: prev, newValue: v };
    }
    for (const l of listeners) {
      l(changes, 'local');
    }
  });
  const remove = vi.fn(async (keyOrKeys: string | string[]) => {
    const keys = Array.isArray(keyOrKeys) ? keyOrKeys : [keyOrKeys];
    const changes: Record<string, chrome.storage.StorageChange> = {};
    for (const key of keys) {
      if (!store.has(key)) continue;
      const prev = store.get(key);
      store.delete(key);
      changes[key] = { oldValue: prev, newValue: undefined };
    }
    if (Object.keys(changes).length === 0) return;
    for (const l of listeners) {
      l(changes, 'local');
    }
  });
  const sessionGet = vi.fn(async (key: string) => {
    const val = sessionStore.get(key);
    return val === undefined ? {} : { [key]: val };
  });
  const sessionSet = vi.fn(async (obj: Record<string, unknown>) => {
    for (const [k, v] of Object.entries(obj)) {
      sessionStore.set(k, v);
    }
  });

  (globalThis as unknown as { chrome: unknown }).chrome = {
    storage: {
      local: { get, set, remove },
      session: { get: sessionGet, set: sessionSet, remove: vi.fn() },
      onChanged: {
        addListener: (l: StorageListener) => listeners.add(l),
        removeListener: (l: StorageListener) => listeners.delete(l),
      },
    },
  };

  return { store, sessionStore, listeners, get, sessionGet, sessionSet, set, remove };
}

describe('chatState', () => {
  let fake: FakeStorage;
  const scopeA = TEST_SCOPES.tab(101, 1);
  const scopeB = TEST_SCOPES.tab(202, 1);
  const ephemeralScope = TEST_SCOPES.ephemeral('panel-missing-tab');

  beforeEach(() => {
    fake = installFakeChrome();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete (globalThis as unknown as { chrome?: unknown }).chrome;
  });

  it('returns empty state when nothing is stored', async () => {
    const state = await getChatState(scopeA);
    expect(state).toEqual({ conversationId: null });
  });

  it('returns empty state when chrome.storage.local rejects', async () => {
    fake.get.mockRejectedValueOnce(new Error('denied'));
    const state = await getChatState(scopeA);
    expect(state).toEqual({ conversationId: null });
  });

  it('returns empty state when stored value is malformed', async () => {
    fake.store.set(storageKeyForScope(scopeA), 'not-an-object');
    const state = await getChatState(scopeA);
    expect(state).toEqual({ conversationId: null });
  });

  it('parses a well-formed stored state (with optional fields)', async () => {
    fake.store.set(storageKeyForScope(scopeA), {
      scope: { key: scopeA.key, mode: scopeA.mode, tabId: scopeA.tabId, windowId: scopeA.windowId },
      state: {
        conversationId: 'abc',
        conversationTitle: 'Greetings',
        createdAt: 12345,
        installSessionId: 'inst-1',
      },
    });
    const state = await getChatState(scopeA);
    expect(state).toEqual({
      conversationId: 'abc',
      conversationTitle: 'Greetings',
      createdAt: 12345,
      installSessionId: 'inst-1',
    });
  });

  it('drops unknown / malformed fields on read', async () => {
    fake.store.set(storageKeyForScope(scopeA), {
      scope: { key: scopeA.key, mode: scopeA.mode, tabId: scopeA.tabId },
      state: {
        conversationId: 'abc',
        conversationTitle: '',
        createdAt: 'yesterday',
        extra: { oops: true },
      },
    });
    const state = await getChatState(scopeA);
    expect(state).toEqual({ conversationId: 'abc' });
    expect('conversationTitle' in state).toBe(false);
    expect('createdAt' in state).toBe(false);
  });

  it('persists a bare conversationId without optional fields', async () => {
    await setChatState(scopeA, { conversationId: 'c1' });
    expect(fake.set).toHaveBeenCalledWith({
      [storageKeyForScope(scopeA)]: {
        scope: {
          key: scopeA.key,
          mode: scopeA.mode,
          tabId: scopeA.tabId,
          windowId: scopeA.windowId,
        },
        state: { conversationId: 'c1' },
      },
    });
    const state = await getChatState(scopeA);
    expect(state).toEqual({ conversationId: 'c1' });
  });

  it('persists all optional fields when supplied', async () => {
    const input: ChatState = {
      conversationId: 'c1',
      conversationTitle: 'Title',
      createdAt: 999,
    };
    await setChatState(scopeA, input);
    expect(fake.set).toHaveBeenCalledWith({
      [storageKeyForScope(scopeA)]: {
        scope: {
          key: scopeA.key,
          mode: scopeA.mode,
          tabId: scopeA.tabId,
          windowId: scopeA.windowId,
        },
        state: input,
      },
    });
  });

  it('drops empty-string title and non-finite createdAt when persisting', async () => {
    await setChatState(scopeA, {
      conversationId: 'c1',
      conversationTitle: '',
      createdAt: Number.NaN,
    });
    expect(fake.set).toHaveBeenCalledWith({
      [storageKeyForScope(scopeA)]: {
        scope: {
          key: scopeA.key,
          mode: scopeA.mode,
          tabId: scopeA.tabId,
          windowId: scopeA.windowId,
        },
        state: { conversationId: 'c1' },
      },
    });
  });

  it('clearChatState removes the storage key', async () => {
    await setChatState(scopeA, { conversationId: 'c1' });
    await clearChatState(scopeA);
    expect(fake.remove).toHaveBeenCalledWith(storageKeyForScope(scopeA));
    const state = await getChatState(scopeA);
    expect(state).toEqual({ conversationId: null });
  });

  it('onStorageChanged fires with the new state when the key changes', async () => {
    const observed: ChatState[] = [];
    const unsubscribe = onStorageChanged(scopeA, (s) => observed.push(s));

    await setChatState(scopeA, { conversationId: 'first' });
    await setChatState(scopeA, {
      conversationId: 'second',
      conversationTitle: 'Hello',
      createdAt: 7,
    });

    expect(observed).toHaveLength(2);
    expect(observed[0]).toEqual({ conversationId: 'first' });
    expect(observed[1]).toEqual({
      conversationId: 'second',
      conversationTitle: 'Hello',
      createdAt: 7,
    });

    unsubscribe();
    await setChatState(scopeA, { conversationId: 'third' });
    expect(observed).toHaveLength(2); // no further fires after unsubscribe
  });

  it('onStorageChanged reports empty state when the key is removed', async () => {
    await setChatState(scopeA, { conversationId: 'first' });
    const observed: ChatState[] = [];
    const unsubscribe = onStorageChanged(scopeA, (s) => observed.push(s));
    await clearChatState(scopeA);
    expect(observed).toEqual([{ conversationId: null }]);
    unsubscribe();
  });

  it('onStorageChanged ignores writes to unrelated keys', async () => {
    const observed: ChatState[] = [];
    const unsubscribe = onStorageChanged(scopeA, (s) => observed.push(s));

    // Simulate a write to an unrelated key
    (globalThis as unknown as { chrome: { storage: { local: { set: typeof chrome.storage.local.set } } } }).chrome.storage.local.set({
      'other.key': { whatever: true },
    });
    // micro-wait for set to complete
    await Promise.resolve();

    expect(observed).toHaveLength(0);
    unsubscribe();
  });


  it('scoped persistence returns null until a conversation exists', async () => {
    const persistence = createExtensionScopedChatStatePersistence(scopeA);
    expect(await persistence.get()).toBeNull();

    await persistence.set({
      conversationId: 'conv-1',
      conversationTitle: 'Rebel chat',
      createdAt: Date.now(),
      pageTitle: 'Example',
      pageUrl: 'https://example.com/page',
    });

    expect(await persistence.get()).toEqual({
      conversationId: 'conv-1',
      conversationTitle: 'Rebel chat',
      createdAt: expect.any(Number),
      pageTitle: 'Example',
      pageUrl: 'https://example.com/page',
    });
  });

  it('safely migrates the legacy global state when the current tab URL proves the scope', async () => {
    const createdAt = Date.now();
    const scope = buildBrowserTabScope({
      tabId: 303,
      windowId: 1,
      url: 'https://example.com/article',
      title: 'Example article',
    }, 'panel-303');
    fake.sessionStore.set(SESSION_AUTH_STORAGE_KEY, { installSessionId: 'inst-current' });
    fake.store.set(LEGACY_BROWSER_CHAT_STATE_KEY, {
      conversationId: 'conv-legacy',
      conversationTitle: 'Legacy chat',
      createdAt,
      pageTitle: 'Example article',
      pageUrl: 'https://example.com/article',
    });

    const persistence = createExtensionScopedChatStatePersistence(scope);

    expect(await persistence.get()).toEqual({
      conversationId: 'conv-legacy',
      conversationTitle: 'Legacy chat',
      createdAt,
      pageTitle: 'Example article',
      pageUrl: 'https://example.com/article',
    });
    expect(fake.store.has(LEGACY_BROWSER_CHAT_STATE_KEY)).toBe(false);
    expect(fake.store.get(storageKeyForScope(scope))).toMatchObject({
      scope: {
        key: scope.key,
        mode: 'tab',
        tabId: 303,
        windowId: 1,
      },
      state: {
        conversationId: 'conv-legacy',
        pageUrl: 'https://example.com/article',
        installSessionId: 'inst-current',
      },
    });
  });

  it('ignores legacy global state when the current tab scope cannot be proven', async () => {
    const scope = buildBrowserTabScope({
      tabId: 404,
      windowId: 1,
      url: 'https://example.com/current',
      title: 'Current',
    }, 'panel-404');
    fake.store.set(LEGACY_BROWSER_CHAT_STATE_KEY, {
      conversationId: 'conv-legacy',
      pageTitle: 'Different article',
      pageUrl: 'https://example.com/different',
    });

    const persistence = createExtensionScopedChatStatePersistence(scope);

    expect(await persistence.get()).toBeNull();
    expect(fake.store.has(LEGACY_BROWSER_CHAT_STATE_KEY)).toBe(true);
    expect(fake.store.has(storageKeyForScope(scope))).toBe(false);
  });

  it('clears stale legacy global state from a previous install session without migrating it', async () => {
    const scope = buildBrowserTabScope({
      tabId: 505,
      windowId: 1,
      url: 'https://example.com/article',
      title: 'Example article',
    }, 'panel-505');
    fake.sessionStore.set(SESSION_AUTH_STORAGE_KEY, { installSessionId: 'inst-current' });
    fake.store.set(LEGACY_BROWSER_CHAT_STATE_KEY, {
      conversationId: 'conv-legacy',
      pageTitle: 'Example article',
      pageUrl: 'https://example.com/article',
      installSessionId: 'inst-old',
    });

    const persistence = createExtensionScopedChatStatePersistence(scope);

    expect(await persistence.get()).toBeNull();
    expect(fake.remove).toHaveBeenCalledWith(LEGACY_BROWSER_CHAT_STATE_KEY);
    expect(fake.store.has(storageKeyForScope(scope))).toBe(false);
  });

  it('scoped persistence clears stale conversations from a previous install session', async () => {
    const persistence = createExtensionScopedChatStatePersistence(scopeA);
    fake.sessionStore.set(SESSION_AUTH_STORAGE_KEY, { installSessionId: 'inst-current' });
    fake.store.set(storageKeyForScope(scopeA), {
      scope: { key: scopeA.key, mode: scopeA.mode, tabId: scopeA.tabId },
      state: {
        conversationId: 'conv-old',
        createdAt: Date.now(),
        installSessionId: 'inst-old',
      },
    });

    expect(await persistence.get()).toBeNull();
    expect(fake.remove).toHaveBeenCalledWith(storageKeyForScope(scopeA));
  });

  it('scoped persistence clears conversations older than the resume window', async () => {
    const persistence = createExtensionScopedChatStatePersistence(scopeA);
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-25T12:00:00.000Z'));
    try {
      fake.store.set(storageKeyForScope(scopeA), {
        scope: { key: scopeA.key, mode: scopeA.mode, tabId: scopeA.tabId },
        state: {
          conversationId: 'conv-old',
          createdAt: Date.now() - 13 * 60 * 60 * 1000,
        },
      });

      expect(await persistence.get()).toBeNull();
      expect(fake.remove).toHaveBeenCalledWith(storageKeyForScope(scopeA));
    } finally {
      vi.useRealTimers();
    }
  });

  it('emits a scoped persistence diagnostic when browser storage writes fail', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    fake.set.mockRejectedValueOnce(new Error('quota'));
    const persistence = createExtensionScopedChatStatePersistence(scopeA);

    await persistence.set({ conversationId: 'conv-fail' });

    expect(warnSpy).toHaveBeenCalledWith(
      '[rebel][chat-state] WARN',
      expect.objectContaining({
        diagnosticCode: 'scope_persist_failed',
        operation: 'set',
        errorName: 'Error',
      }),
    );
  });

  it('scoped persistence.subscribe forwards storage notifications', async () => {
    const persistence = createExtensionScopedChatStatePersistence(scopeA);
    const listener = vi.fn();
    const unsubscribe = persistence.subscribe?.(listener) ?? (() => undefined);

    await setChatState(scopeA, { conversationId: 'conv-1' });
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    await setChatState(scopeA, { conversationId: 'conv-2' });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('scoped persistence.clear removes persisted conversations', async () => {
    const persistence = createExtensionScopedChatStatePersistence(scopeA);
    await persistence.set({ conversationId: 'conv-1' });
    await persistence.clear();

    expect(await persistence.get()).toBeNull();
  });

  it('same URL in two different tabs does not collide', async () => {
    const persistenceA = createExtensionScopedChatStatePersistence(scopeA);
    const sameUrlScopeB = TEST_SCOPES.tab(202, 1);
    const persistenceB = createExtensionScopedChatStatePersistence(sameUrlScopeB);

    await persistenceA.set({
      conversationId: 'conv-a',
      pageTitle: 'Pricing',
      pageUrl: 'https://stripe.com/pricing',
    });
    await persistenceB.set({
      conversationId: 'conv-b',
      pageTitle: 'Pricing',
      pageUrl: 'https://stripe.com/pricing',
    });

    expect(await persistenceA.get()).toMatchObject({ conversationId: 'conv-a' });
    expect(await persistenceB.get()).toMatchObject({ conversationId: 'conv-b' });
  });

  it('missing tab id uses an isolated ephemeral scope instead of hydrating another tab', async () => {
    const persistenceA = createExtensionScopedChatStatePersistence(scopeA);
    const ephemeralPersistence = createExtensionScopedChatStatePersistence(ephemeralScope);

    await persistenceA.set({ conversationId: 'conv-tab-a' });

    expect(await ephemeralPersistence.get()).toBeNull();
  });

  it('caps stored scoped records at the bounded index size', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-25T12:00:00.000Z'));
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    try {
      for (let i = 0; i < 52; i += 1) {
        const scope = TEST_SCOPES.tab(1_000 + i, 1);
        const persistence = createExtensionScopedChatStatePersistence(scope);
        await persistence.set({ conversationId: `conv-${i}` });
        vi.advanceTimersByTime(1);
      }

      const scopedKeys = Array.from(fake.store.keys()).filter((key) =>
        key.startsWith('rebel.chat.scope.v1.'),
      );
      expect(scopedKeys).toHaveLength(50);
      expect(fake.store.has(storageKeyForScope(TEST_SCOPES.tab(1_000, 1)))).toBe(false);
      expect(fake.store.has(storageKeyForScope(TEST_SCOPES.tab(1_051, 1)))).toBe(true);

      const rawIndex = fake.store.get('rebel.chat.scopes.v1');
      expect(rawIndex).toBeTruthy();
      const index = rawIndex as Record<string, unknown>;
      expect(Object.keys(index)).toHaveLength(50);
      expect(index).not.toHaveProperty(storageKeyForScope(TEST_SCOPES.tab(1_000, 1)));
      expect(infoSpy).toHaveBeenCalledWith(
        '[rebel][chat-state] INFO',
        expect.objectContaining({ diagnosticCode: 'scope_pruned' }),
      );
    } finally {
      infoSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('rebuilds a missing scoped-record index before pruning', async () => {
    for (let i = 0; i < 52; i += 1) {
      const scope = TEST_SCOPES.tab(2_000 + i, 1);
      fake.store.set(storageKeyForScope(scope), {
        scope: {
          key: scope.key,
          mode: scope.mode,
          tabId: scope.tabId,
          windowId: scope.windowId,
        },
        state: {
          conversationId: `conv-${i}`,
          createdAt: i,
        },
      });
    }

    expect(fake.store.has('rebel.chat.scopes.v1')).toBe(false);

    await setChatState(TEST_SCOPES.tab(2_052, 1), {
      conversationId: 'conv-52',
      createdAt: 52,
    });

    const scopedKeys = Array.from(fake.store.keys()).filter((key) =>
      key.startsWith('rebel.chat.scope.v1.'),
    );
    expect(scopedKeys).toHaveLength(50);
    expect(fake.store.has(storageKeyForScope(TEST_SCOPES.tab(2_000, 1)))).toBe(false);
    expect(fake.store.has(storageKeyForScope(TEST_SCOPES.tab(2_052, 1)))).toBe(true);
  });

  it('late clear from one scope does not clear another scope', async () => {
    const persistenceA = createExtensionScopedChatStatePersistence(scopeA);
    const persistenceB = createExtensionScopedChatStatePersistence(scopeB);

    await persistenceA.set({ conversationId: 'conv-a' });
    await persistenceB.set({ conversationId: 'conv-b' });
    await persistenceA.clear();

    expect(await persistenceB.get()).toMatchObject({ conversationId: 'conv-b' });
  });

  it('late set from one scope does not overwrite another scope', async () => {
    const persistenceA = createExtensionScopedChatStatePersistence(scopeA);
    const persistenceB = createExtensionScopedChatStatePersistence(scopeB);

    await persistenceA.set({ conversationId: 'conv-a' });
    await persistenceB.set({ conversationId: 'conv-b' });
    await persistenceA.set({ conversationId: 'conv-a-late' });

    expect(await persistenceA.get()).toMatchObject({ conversationId: 'conv-a-late' });
    expect(await persistenceB.get()).toMatchObject({ conversationId: 'conv-b' });
  });
});
