// @vitest-environment happy-dom

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SidePanel } from '../../src/sidepanel/SidePanel';
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

function buildPendingEntry(
  overrides: Partial<PendingPermissionEntry> = {},
): PendingPermissionEntry {
  const now = Date.now();
  return {
    origin: 'https://example.com',
    capability: 'read_page',
    tabIds: [11],
    firstRequestedAt: now,
    lastRequestedAt: now,
    displayName: 'Example',
    ...overrides,
  };
}

function setupChromeMock(options: {
  pending?: Record<string, PendingPermissionEntry>;
  activeTabUrl?: string | null;
  lastRevokedMarker?: { origin: string; at: number } | null;
} = {}): {
  emitStorageChange: (
    changes: Record<string, StorageChange>,
    areaName: string,
  ) => void;
  storageOnChangedListeners: StorageChangedListener[];
} {
  const session: Record<string, unknown> = {};
  if (options.pending) {
    session['rebel.pending-permissions.v1'] = options.pending;
  }
  if (options.lastRevokedMarker) {
    session['rebel.last-revoked.v1'] = options.lastRevokedMarker;
  }
  const storageOnChangedListeners: StorageChangedListener[] = [];

  const tabsQuery = vi.fn(async () =>
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

  vi.stubGlobal('chrome', {
    action: { setBadgeText: vi.fn(async () => undefined) },
    windows: { getCurrent: vi.fn(async () => ({ id: 1 })) },
    runtime: {
      id: 'fake-id',
      sendMessage: vi.fn(async () => undefined),
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
        get: vi.fn(async () => ({})),
      },
      session: {
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
      },
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
    storageOnChangedListeners,
    emitStorageChange: (changes, areaName) => {
      for (const listener of storageOnChangedListeners.slice()) {
        listener(changes, areaName);
      }
    },
  };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    await Promise.resolve();
  }
}

describe('SidePanel permission stack', () => {
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

  it('renders the pending stack with the softened v2.1 banner title', async () => {
    setupChromeMock({
      pending: {
        'https://example.com': buildPendingEntry({
          origin: 'https://example.com',
        }),
      },
    });
    mounted = mount(<SidePanel />);
    await act(async () => {
      await flush();
    });

    const stack = mounted.container.querySelector(
      '[data-testid="permission-stack"]',
    );
    expect(stack).not.toBeNull();
    expect(stack?.textContent).toContain(CARD_COPY.sidepanelBannerTitle);
    // Verbatim spot-check against the v2.1 warmth-pass copy.
    expect(stack?.textContent).toContain('One thing before I can help here');
    expect(
      mounted.container.querySelectorAll(
        '[data-testid="permission-grant-card"]',
      ).length,
    ).toBe(1);
  });

  it('orders cards with the active tab origin first', async () => {
    const now = Date.now();
    setupChromeMock({
      activeTabUrl: 'https://b.test/page',
      pending: {
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
    });
    mounted = mount(<SidePanel />);
    await act(async () => {
      await flush();
    });

    const cards = Array.from(
      mounted.container.querySelectorAll(
        '[data-testid="permission-grant-card"]',
      ),
    );
    expect(cards.length).toBe(2);
    expect(cards[0]?.textContent ?? '').toContain('b.test');
    expect(cards[1]?.textContent ?? '').toContain('a.test');
  });

  it('surfaces the revoked-externally toast when the storage marker appears', async () => {
    const ctx = setupChromeMock();
    mounted = mount(<SidePanel />);
    await act(async () => {
      await flush();
    });

    expect(
      mounted.container.querySelector(
        '[data-testid="permission-revoked-toast"]',
      ),
    ).toBeNull();

    await act(async () => {
      ctx.emitStorageChange(
        {
          'rebel.last-revoked.v1': {
            newValue: { origin: 'https://example.com', at: Date.now() },
          },
        },
        'session',
      );
      await flush();
    });

    const toast = mounted.container.querySelector(
      '[data-testid="permission-revoked-toast"]',
    );
    expect(toast).not.toBeNull();
    expect(toast?.textContent).toBe(
      CARD_COPY.revokedToast('example.com'),
    );
  });

  it('unsubscribes from storage listeners on unmount', async () => {
    const ctx = setupChromeMock();
    mounted = mount(<SidePanel />);
    await act(async () => {
      await flush();
    });
    const before = ctx.storageOnChangedListeners.length;
    expect(before).toBeGreaterThan(0);

    mounted.unmount();
    mounted = null;
    expect(ctx.storageOnChangedListeners.length).toBeLessThan(before);
  });
});
