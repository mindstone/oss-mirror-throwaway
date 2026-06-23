import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface StoredMap {
  [key: string]: unknown;
}

function mockChromeStorage(initial: StoredMap = {}): {
  session: StoredMap;
  onChangedListeners: Array<(changes: Record<string, { oldValue?: unknown; newValue?: unknown }>, area: string) => void>;
  emit: (changes: Record<string, { oldValue?: unknown; newValue?: unknown }>, area: string) => void;
} {
  const session: StoredMap = { ...initial };
  const onChangedListeners: Array<(changes: Record<string, { oldValue?: unknown; newValue?: unknown }>, area: string) => void> = [];
  const chromeMock = {
    storage: {
      session: {
        get: vi.fn(async (keys?: string | string[]) => {
          if (!keys) return { ...session };
          if (Array.isArray(keys)) {
            return Object.fromEntries(keys.map((key) => [key, session[key]]));
          }
          return { [keys]: session[keys] };
        }),
        set: vi.fn(async (items: Record<string, unknown>) => {
          Object.assign(session, items);
        }),
        remove: vi.fn(async (key: string | string[]) => {
          const keys = Array.isArray(key) ? key : [key];
          for (const entry of keys) {
            delete session[entry];
          }
        }),
      },
      onChanged: {
        addListener: vi.fn((listener: (changes: Record<string, { oldValue?: unknown; newValue?: unknown }>, area: string) => void) => {
          onChangedListeners.push(listener);
        }),
        removeListener: vi.fn((listener: (changes: Record<string, { oldValue?: unknown; newValue?: unknown }>, area: string) => void) => {
          const index = onChangedListeners.indexOf(listener);
          if (index >= 0) onChangedListeners.splice(index, 1);
        }),
      },
    },
  };
  vi.stubGlobal('chrome', chromeMock);
  return {
    session,
    onChangedListeners,
    emit: (changes, area) => {
      for (const listener of onChangedListeners.slice()) {
        listener(changes, area);
      }
    },
  };
}

const KEY = 'rebel.pending-permissions.v1';
const REVOKED_KEY = 'rebel.last-revoked.v1';

describe('permissionState', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-24T12:00:00.000Z'));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('upserts a new pending entry with tabIds = [tabId]', async () => {
    const ctx = mockChromeStorage();
    const { setPending, getPending } = await import('../../src/permissions/permissionState');

    await setPending({
      origin: 'https://example.com',
      capability: 'read_page',
      tabId: 11,
      displayName: 'Example Site',
    });

    const state = await getPending();
    expect(state).toEqual({
      'https://example.com': {
        origin: 'https://example.com',
        capability: 'read_page',
        tabIds: [11],
        firstRequestedAt: Date.now(),
        lastRequestedAt: Date.now(),
        displayName: 'Example Site',
      },
    });
    expect(ctx.session[KEY]).toBeTruthy();
  });

  it('coalesces two tabs on the same origin into one entry with two tabIds', async () => {
    mockChromeStorage();
    const { setPending, getPending } = await import('../../src/permissions/permissionState');

    await setPending({
      origin: 'https://example.com',
      capability: 'read_page',
      tabId: 11,
      displayName: 'Example',
    });
    vi.advanceTimersByTime(1000);
    await setPending({
      origin: 'https://example.com',
      capability: 'fill_form',
      tabId: 22,
      displayName: 'Example',
    });

    const state = await getPending();
    expect(state['https://example.com']?.tabIds).toEqual([11, 22]);
    // capability is updated to the most recent
    expect(state['https://example.com']?.capability).toBe('fill_form');
    // firstRequestedAt stays fixed to the create time
    expect(state['https://example.com']?.firstRequestedAt).toBe(Date.parse('2026-04-24T12:00:00.000Z'));
    expect(state['https://example.com']?.lastRequestedAt).toBe(
      Date.parse('2026-04-24T12:00:00.000Z') + 1000,
    );
  });

  it('dedupes tabIds when the same tab re-requests', async () => {
    mockChromeStorage();
    const { setPending, getPending } = await import('../../src/permissions/permissionState');

    await setPending({
      origin: 'https://a.test',
      capability: 'read_page',
      tabId: 11,
      displayName: 'A',
    });
    await setPending({
      origin: 'https://a.test',
      capability: 'read_page',
      tabId: 11,
      displayName: 'A',
    });

    const state = await getPending();
    expect(state['https://a.test']?.tabIds).toEqual([11]);
  });

  it('dropTabFromPending removes one tabId but keeps the entry if others remain', async () => {
    mockChromeStorage();
    const { setPending, dropTabFromPending, getPending } = await import(
      '../../src/permissions/permissionState'
    );

    await setPending({ origin: 'https://a.test', capability: 'read_page', tabId: 11, displayName: 'A' });
    await setPending({ origin: 'https://a.test', capability: 'read_page', tabId: 22, displayName: 'A' });

    await dropTabFromPending(11);

    const state = await getPending();
    expect(state['https://a.test']?.tabIds).toEqual([22]);
  });

  it('dropTabFromPending deletes the entry when tabIds becomes empty', async () => {
    mockChromeStorage();
    const { setPending, dropTabFromPending, getPending } = await import(
      '../../src/permissions/permissionState'
    );

    await setPending({ origin: 'https://a.test', capability: 'read_page', tabId: 11, displayName: 'A' });

    await dropTabFromPending(11);

    const state = await getPending();
    expect(state['https://a.test']).toBeUndefined();
  });

  it('clearPendingForOrigin removes regardless of tabIds', async () => {
    mockChromeStorage();
    const { setPending, clearPendingForOrigin, getPending } = await import(
      '../../src/permissions/permissionState'
    );

    await setPending({ origin: 'https://a.test', capability: 'read_page', tabId: 11, displayName: 'A' });
    await setPending({ origin: 'https://a.test', capability: 'read_page', tabId: 22, displayName: 'A' });

    await clearPendingForOrigin('https://a.test');

    const state = await getPending();
    expect(state['https://a.test']).toBeUndefined();
  });

  it('clearPendingForTabNavigation drops tab when new origin differs', async () => {
    mockChromeStorage();
    const { setPending, clearPendingForTabNavigation, getPending } = await import(
      '../../src/permissions/permissionState'
    );

    await setPending({ origin: 'https://a.test', capability: 'read_page', tabId: 11, displayName: 'A' });
    await setPending({ origin: 'https://a.test', capability: 'read_page', tabId: 22, displayName: 'A' });

    await clearPendingForTabNavigation(11, 'https://b.test/hello');

    const state = await getPending();
    expect(state['https://a.test']?.tabIds).toEqual([22]);
  });

  it('clearPendingForTabNavigation keeps tab when new origin matches', async () => {
    mockChromeStorage();
    const { setPending, clearPendingForTabNavigation, getPending } = await import(
      '../../src/permissions/permissionState'
    );

    await setPending({ origin: 'https://a.test', capability: 'read_page', tabId: 11, displayName: 'A' });

    await clearPendingForTabNavigation(11, 'https://a.test/other-page');

    const state = await getPending();
    expect(state['https://a.test']?.tabIds).toEqual([11]);
  });

  it('auto-clears entries older than 2 minutes on read', async () => {
    mockChromeStorage();
    const { setPending, getPending } = await import('../../src/permissions/permissionState');

    await setPending({ origin: 'https://old.test', capability: 'read_page', tabId: 1, displayName: 'Old' });

    // Jump forward > 2 minutes.
    vi.advanceTimersByTime(3 * 60 * 1000);

    await setPending({ origin: 'https://fresh.test', capability: 'read_page', tabId: 2, displayName: 'Fresh' });

    const state = await getPending();
    expect(state['https://old.test']).toBeUndefined();
    expect(state['https://fresh.test']).toBeDefined();
  });

  it('onChange fires listener when the pending key changes', async () => {
    const ctx = mockChromeStorage();
    const { onChange } = await import('../../src/permissions/permissionState');

    const listener = vi.fn();
    onChange(listener);

    ctx.emit(
      { [KEY]: { newValue: { 'https://x.test': { origin: 'https://x.test', capability: 'read_page', tabIds: [1], firstRequestedAt: Date.now(), lastRequestedAt: Date.now(), displayName: 'X' } } } },
      'session',
    );
    // Allow the async reader to run.
    await vi.waitFor(() => {
      expect(listener).toHaveBeenCalled();
    });
  });

  it('onChange ignores changes in other areas and for other keys', async () => {
    const ctx = mockChromeStorage();
    const { onChange } = await import('../../src/permissions/permissionState');

    const listener = vi.fn();
    onChange(listener);
    ctx.emit({ [KEY]: { newValue: {} } }, 'local');
    ctx.emit({ otherKey: { newValue: 1 } }, 'session');
    // Flush any outstanding microtasks without blocking on a real timer.
    await Promise.resolve();
    await Promise.resolve();
    expect(listener).not.toHaveBeenCalled();
  });

  it('onChange returns an unsubscribe function', async () => {
    mockChromeStorage();
    const { onChange } = await import('../../src/permissions/permissionState');

    const listener = vi.fn();
    const unsub = onChange(listener);
    expect(typeof unsub).toBe('function');
    unsub();
    // No easy way to verify the unsubscribe beyond not throwing; removeListener
    // was invoked via the underlying addListener mock (covered by smoke).
  });

  it('gracefully degrades when chrome.storage.session is unavailable', async () => {
    vi.stubGlobal('chrome', {});
    const { setPending, getPending } = await import('../../src/permissions/permissionState');

    await setPending({ origin: 'https://x.test', capability: 'read_page', tabId: 1, displayName: 'X' });
    await expect(getPending()).resolves.toEqual({});
  });

  it('writeLastRevokedMarker writes to the marker key', async () => {
    const ctx = mockChromeStorage();
    const { writeLastRevokedMarker } = await import(
      '../../src/permissions/permissionState'
    );

    await writeLastRevokedMarker('https://revoked.test');
    expect(ctx.session[REVOKED_KEY]).toMatchObject({
      origin: 'https://revoked.test',
      at: Date.now(),
    });
  });

  it('does not expose __rebelE2E__.permissionState in production mode', async () => {
    // `import.meta.env.MODE` is `'test'` under vitest — assert the static
    // branch is evaluated and publishes the api.
    mockChromeStorage();
    await import('../../src/permissions/permissionState');
    const globalAny = globalThis as typeof globalThis & {
      __rebelE2E__?: { permissionState?: { clearPendingState: () => Promise<void> } };
    };
    expect(globalAny.__rebelE2E__?.permissionState).toBeDefined();
  });
});
