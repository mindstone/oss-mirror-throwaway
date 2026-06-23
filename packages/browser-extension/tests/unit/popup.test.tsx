// @vitest-environment happy-dom

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Popup } from '../../src/popup/popup';
import { CARD_COPY } from '../../src/permissions/PermissionGrantCard';
import type { PendingPermissionEntry } from '../../src/permissions/permissionState';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface Mounted {
  container: HTMLDivElement;
  root: Root;
  unmount: () => void;
}

function mount(ui: React.ReactElement): Mounted {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(ui);
  });
  return {
    container,
    root,
    unmount: () => {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

interface StorageChange {
  oldValue?: unknown;
  newValue?: unknown;
}
type StorageChangedListener = (
  changes: Record<string, StorageChange>,
  areaName: string,
) => void;

interface ChromeSessionArea {
  get: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
}

interface ChromeMockContext {
  session: Record<string, unknown>;
  sessionArea: ChromeSessionArea;
  storageOnChangedListeners: StorageChangedListener[];
  emitStorageChange: (
    changes: Record<string, StorageChange>,
    areaName: string,
  ) => void;
  tabsQuery: ReturnType<typeof vi.fn>;
  runtimeSendMessage: ReturnType<typeof vi.fn>;
}

function setupChromeMock(options: {
  session?: Record<string, unknown>;
  activeTabUrl?: string | null;
  installStatus?: { kind: string };
} = {}): ChromeMockContext {
  const session: Record<string, unknown> = { ...(options.session ?? {}) };
  const storageOnChangedListeners: StorageChangedListener[] = [];

  const sessionArea: ChromeSessionArea = {
    get: vi.fn(async (key?: string | string[] | null) => {
      if (!key) return { ...session };
      if (Array.isArray(key)) {
        return Object.fromEntries(key.map((k) => [k, session[k]]));
      }
      return { [key]: session[key] };
    }),
    set: vi.fn(async (items: Record<string, unknown>) => {
      Object.assign(session, items);
    }),
    remove: vi.fn(async (key: string | string[]) => {
      const keys = Array.isArray(key) ? key : [key];
      for (const k of keys) delete session[k];
    }),
  };

  const tabsQuery = vi.fn(
    async (): Promise<chrome.tabs.Tab[]> =>
      options.activeTabUrl
        ? [
            {
              id: 42,
              url: options.activeTabUrl,
              windowId: 1,
            } as unknown as chrome.tabs.Tab,
          ]
        : [],
  );
  const runtimeSendMessage = vi.fn(async (message: { type?: string } | undefined) => {
    if (message?.type === 'get-install-state') {
      return { status: options.installStatus ?? { kind: 'boot-token-missing' } };
    }
    return undefined;
  });

  vi.stubGlobal('chrome', {
    action: {
      setBadgeText: vi.fn(async () => undefined),
    },
    windows: {
      getCurrent: vi.fn(async () => ({ id: 1 })),
    },
    runtime: {
      sendMessage: runtimeSendMessage,
      onMessage: {
        addListener: vi.fn(),
        removeListener: vi.fn(),
      },
      getURL: vi.fn((path: string) => `chrome-extension://fake-id/${path}`),
    },
    permissions: {
      request: vi.fn(async () => true),
    },
    tabs: {
      query: tabsQuery,
    },
    storage: {
      local: {
        get: vi.fn(async () => ({
          'rebel.pairing.v1': { clientId: 'browser-0123456789abcdef' },
        })),
      },
      session: sessionArea,
      onChanged: {
        addListener: vi.fn((listener: StorageChangedListener) => {
          storageOnChangedListeners.push(listener);
        }),
        removeListener: vi.fn((listener: StorageChangedListener) => {
          const i = storageOnChangedListeners.indexOf(listener);
          if (i >= 0) storageOnChangedListeners.splice(i, 1);
        }),
      },
    },
  });

  return {
    session,
    sessionArea,
    storageOnChangedListeners,
    emitStorageChange: (changes, areaName) => {
      for (const listener of storageOnChangedListeners.slice()) {
        listener(changes, areaName);
      }
    },
    tabsQuery,
    runtimeSendMessage,
  };
}

function buildPendingEntry(
  overrides: Partial<PendingPermissionEntry> = {},
): PendingPermissionEntry {
  return {
    origin: 'https://example.com',
    capability: 'read_page',
    tabIds: [11],
    firstRequestedAt: Date.now(),
    lastRequestedAt: Date.now(),
    displayName: 'Example',
    ...overrides,
  };
}

describe('Popup', () => {
  let mounted: Mounted | null = null;

  beforeEach(() => {
    setupChromeMock();
  });

  afterEach(() => {
    mounted?.unmount();
    mounted = null;
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('renders install-from-Rebel guidance with no code input', async () => {
    mounted = mount(<Popup />);

    await act(async () => {
      await Promise.resolve();
    });

    expect(mounted.container.textContent).toContain('Open Rebel, start the browser install there');
    expect(mounted.container.querySelector('input')).toBeNull();
    expect(mounted.container.textContent).not.toContain('6-digit');
    expect(mounted.container.textContent).not.toContain('security code');
  });

  it('renders a stack of permission-grant cards when pending state has multiple origins', async () => {
    const now = Date.now();
    setupChromeMock({
      session: {
        'rebel.pending-permissions.v1': {
          'https://a.test': buildPendingEntry({
            origin: 'https://a.test',
            displayName: 'A',
            lastRequestedAt: now,
            firstRequestedAt: now - 1_000,
          }),
          'https://b.test': buildPendingEntry({
            origin: 'https://b.test',
            displayName: 'B',
            lastRequestedAt: now - 500,
            firstRequestedAt: now - 500,
          }),
        },
      },
    });

    mounted = mount(<Popup />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const cards = mounted.container.querySelectorAll(
      '[data-testid="permission-grant-card"]',
    );
    expect(cards.length).toBe(2);
    expect(mounted.container.textContent).toContain('a.test');
    expect(mounted.container.textContent).toContain('b.test');
  });

  it('orders cards with the active tab origin first', async () => {
    // a.test came LAST (newest lastRequestedAt), but b.test is active — so
    // b.test should be first in the rendered order.
    const now = Date.now();
    setupChromeMock({
      activeTabUrl: 'https://b.test/page',
      session: {
        'rebel.pending-permissions.v1': {
          'https://a.test': buildPendingEntry({
            origin: 'https://a.test',
            lastRequestedAt: now,
            firstRequestedAt: now,
          }),
          'https://b.test': buildPendingEntry({
            origin: 'https://b.test',
            lastRequestedAt: now - 1_000,
            firstRequestedAt: now - 1_000,
          }),
        },
      },
    });

    mounted = mount(<Popup />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const cards = Array.from(
      mounted.container.querySelectorAll(
        '[data-testid="permission-grant-card"]',
      ),
    );
    expect(cards.length).toBe(2);
    // First card should be the active origin (b.test) even though its
    // lastRequestedAt is older than a.test.
    const firstCardText = cards[0]?.textContent ?? '';
    expect(firstCardText).toContain('b.test');
    const secondCardText = cards[1]?.textContent ?? '';
    expect(secondCardText).toContain('a.test');
  });

  it('shows a revoked-externally toast when rebel.last-revoked.v1 is written', async () => {
    const ctx = setupChromeMock();
    mounted = mount(<Popup />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(
      mounted.container.querySelector('[data-testid="permission-revoked-toast"]'),
    ).toBeNull();

    // Emit a storage change representing the SW writing the marker.
    await act(async () => {
      ctx.emitStorageChange(
        {
          'rebel.last-revoked.v1': {
            newValue: { origin: 'https://revoked.test', at: Date.now() },
          },
        },
        'session',
      );
      await Promise.resolve();
    });

    const toast = mounted.container.querySelector(
      '[data-testid="permission-revoked-toast"]',
    );
    expect(toast).not.toBeNull();
    expect(toast?.textContent).toBe(
      CARD_COPY.revokedToast('revoked.test'),
    );
  });

  it('opens chat with both the active tab id and window id', async () => {
    const ctx = setupChromeMock({
      activeTabUrl: 'https://example.com/page',
      installStatus: { kind: 'connected' },
    });
    mounted = mount(<Popup />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const button = mounted.container.querySelector<HTMLButtonElement>('[data-testid="open-chat-button"]');
    expect(button).not.toBeNull();
    await act(async () => {
      button?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(ctx.runtimeSendMessage).toHaveBeenCalledWith({
      target: 'service-worker',
      type: 'open-side-panel',
      tabId: 42,
      windowId: 1,
    });
  });

  it('unsubscribes from permission + storage listeners on unmount', async () => {
    const ctx = setupChromeMock();
    mounted = mount(<Popup />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    const listenerCount = ctx.storageOnChangedListeners.length;
    expect(listenerCount).toBeGreaterThan(0);

    mounted.unmount();
    mounted = null;

    expect(ctx.storageOnChangedListeners.length).toBeLessThan(listenerCount);
  });
});
