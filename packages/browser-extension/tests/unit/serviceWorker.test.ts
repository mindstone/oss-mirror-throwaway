import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface ChromeStorageShape {
  state: Record<string, unknown>;
  get: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
}

function buildChromeStorage(initial: Record<string, unknown> = {}): ChromeStorageShape {
  const state: Record<string, unknown> = { ...initial };
  return {
    state,
    get: vi.fn(async (keys?: string | string[]) => {
      if (!keys) return { ...state };
      if (Array.isArray(keys)) {
        return Object.fromEntries(keys.map((key) => [key, state[key]]));
      }
      return { [keys]: state[keys] };
    }),
    set: vi.fn(async (items: Record<string, unknown>) => {
      Object.assign(state, items);
    }),
    remove: vi.fn(async (key: string | string[]) => {
      const keys = Array.isArray(key) ? key : [key];
      for (const entry of keys) delete state[entry];
    }),
  };
}

interface ChromeMockOptions {
  permissionsContains?: boolean;
  executeScriptResolves?: boolean;
  executeScriptError?: Error;
  sendMessageResponse?: unknown;
  sendMessageError?: Error;
}

function buildChromeMock(options: ChromeMockOptions = {}) {
  const sessionStorage = buildChromeStorage();
  const localStorage = buildChromeStorage();
  const executeScript = vi.fn();
  if (options.executeScriptError) {
    executeScript.mockRejectedValue(options.executeScriptError);
  } else if (options.executeScriptResolves !== false) {
    executeScript.mockResolvedValue(undefined);
  }
  const sendMessage = vi.fn();
  if (options.sendMessageError) {
    sendMessage.mockRejectedValue(options.sendMessageError);
  } else if (options.sendMessageResponse !== undefined) {
    sendMessage.mockResolvedValue(options.sendMessageResponse);
  } else {
    sendMessage.mockResolvedValue({ ok: true, data: { pageText: 'ok' } });
  }
  return {
    runtime: {
      onInstalled: { addListener: vi.fn() },
      onStartup: { addListener: vi.fn() },
      onMessage: { addListener: vi.fn() },
      getContexts: vi.fn().mockResolvedValue([]),
      getURL: vi.fn((entry: string) => `chrome-extension://abcdefghijklmnopabcdefghijklmnop/${entry}`),
      sendMessage: vi.fn().mockResolvedValue(undefined),
      id: 'abcdefghijklmnopabcdefghijklmnop',
    },
    sidePanel: {
      setOptions: vi.fn().mockResolvedValue(undefined),
      open: vi.fn().mockResolvedValue(undefined),
      setPanelBehavior: vi.fn().mockResolvedValue(undefined),
    },
    action: {
      setBadgeText: vi.fn().mockResolvedValue(undefined),
      setBadgeBackgroundColor: vi.fn().mockResolvedValue(undefined),
      onClicked: { addListener: vi.fn() },
    },
    alarms: {
      create: vi.fn(),
      onAlarm: { addListener: vi.fn() },
    },
    offscreen: {
      createDocument: vi.fn().mockResolvedValue(undefined),
    },
    tabs: {
      get: vi.fn(),
      query: vi.fn(),
      sendMessage,
      onActivated: { addListener: vi.fn() },
      onUpdated: { addListener: vi.fn() },
      onRemoved: { addListener: vi.fn() },
    },
    windows: {
      WINDOW_ID_NONE: -1,
      onFocusChanged: { addListener: vi.fn() },
    },
    scripting: {
      executeScript,
    },
    permissions: {
      contains: vi.fn().mockResolvedValue(options.permissionsContains ?? true),
      request: vi.fn().mockResolvedValue(true),
      remove: vi.fn().mockResolvedValue(true),
      onRemoved: { addListener: vi.fn() },
    },
    webNavigation: {
      onCommitted: { addListener: vi.fn() },
    },
    storage: {
      session: sessionStorage,
      local: localStorage,
      onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
    },
  };
}

async function invokeServiceWorkerMessage(
  chromeMock: ReturnType<typeof buildChromeMock>,
  message: unknown,
): Promise<unknown> {
  const listener = chromeMock.runtime.onMessage.addListener.mock.calls[0]?.[0] as
    | ((msg: unknown, sender: unknown, sendResponse: (response: unknown) => void) => boolean)
    | undefined;
  if (!listener) throw new Error('service worker message listener was not registered');
  return new Promise((resolve) => {
    listener(message, {}, resolve);
  });
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('serviceWorker dispatchCapability', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([
    'chrome://settings',
    'edge://extensions',
    'about:blank',
    'chrome-extension://abc123/popup.html',
    'moz-extension://abc123/popup.html',
    'https://example.com/file.pdf',
  ])('rejects unsupported surface %s before injecting content scripts', async (url) => {
    const chromeMock = buildChromeMock();
    chromeMock.tabs.get.mockResolvedValue({ id: 7, url });
    vi.stubGlobal('chrome', chromeMock);

    const { dispatchCapability } = await import('../../src/background/serviceWorker');
    const response = await dispatchCapability({
      target: 'service-worker',
      type: 'dispatch-capability',
      action: 'read_page',
      params: {},
      tabContext: { tabId: 7, url },
    });

    expect(response).toMatchObject({
      ok: false,
      code: 'UNSUPPORTED_SURFACE',
    });
    expect(chromeMock.scripting.executeScript).not.toHaveBeenCalled();
    expect(chromeMock.tabs.sendMessage).not.toHaveBeenCalled();
  });

  it('returns TAB_CONTEXT_DIVERGED when the tab changed origin+pathname before execution', async () => {
    const chromeMock = buildChromeMock();
    chromeMock.tabs.get.mockResolvedValue({
      id: 9,
      url: 'https://example.com/new-path?fresh=1',
    });
    vi.stubGlobal('chrome', chromeMock);

    const { dispatchCapability } = await import('../../src/background/serviceWorker');
    const response = await dispatchCapability({
      target: 'service-worker',
      type: 'dispatch-capability',
      action: 'read_page',
      params: {},
      tabContext: { tabId: 9, url: 'https://example.com/original-path?old=1' },
    });

    expect(response).toMatchObject({
      ok: false,
      code: 'TAB_CONTEXT_DIVERGED',
    });
    expect(chromeMock.scripting.executeScript).not.toHaveBeenCalled();
  });

  it('returns TAB_CONTEXT_DIVERGED when the tab changed query or hash before execution', async () => {
    const chromeMock = buildChromeMock();
    chromeMock.tabs.get.mockResolvedValue({
      id: 10,
      url: 'https://example.com/dashboard?view=team#usage',
    });
    vi.stubGlobal('chrome', chromeMock);

    const { dispatchCapability } = await import('../../src/background/serviceWorker');
    const response = await dispatchCapability({
      target: 'service-worker',
      type: 'dispatch-capability',
      action: 'read_page',
      params: {},
      tabContext: { tabId: 10, url: 'https://example.com/dashboard?view=personal#overview' },
    });

    expect(response).toMatchObject({
      ok: false,
      code: 'TAB_CONTEXT_DIVERGED',
    });
    expect(chromeMock.scripting.executeScript).not.toHaveBeenCalled();
  });

  it('injects the bundled content script URL in ISOLATED world', async () => {
    const chromeMock = buildChromeMock();
    chromeMock.tabs.get.mockResolvedValue({
      id: 11,
      url: 'https://example.com',
    });
    chromeMock.scripting.executeScript.mockResolvedValue(undefined);
    chromeMock.tabs.sendMessage.mockResolvedValue({
      ok: true,
      data: { pageText: 'ok' },
    });
    vi.stubGlobal('chrome', chromeMock);

    vi.doMock('../../src/content/contentScript.ts?script', () => ({
      default: '/assets/contentScript-abc.js',
    }));

    const { dispatchCapability } = await import('../../src/background/serviceWorker');
    const response = await dispatchCapability({
      target: 'service-worker',
      type: 'dispatch-capability',
      action: 'read_page',
      params: {},
      tabContext: { tabId: 11, url: 'https://example.com' },
    });

    expect(response).toMatchObject({ ok: true });
    expect(chromeMock.scripting.executeScript).toHaveBeenCalledWith({
      target: { tabId: 11 },
      files: ['/assets/contentScript-abc.js'],
      world: 'ISOLATED',
    });
  });

  it('does not fall back to the active tab when a DOM capability omits tabContext', async () => {
    const chromeMock = buildChromeMock();
    chromeMock.tabs.query.mockResolvedValue([
      { id: 55, url: 'https://example.com/active' },
    ]);
    vi.stubGlobal('chrome', chromeMock);

    const { dispatchCapability } = await import('../../src/background/serviceWorker');
    const response = await dispatchCapability({
      target: 'service-worker',
      type: 'dispatch-capability',
      action: 'read_page',
      params: {},
    });

    expect(response).toMatchObject({
      ok: false,
      code: 'TAB_CONTEXT_GONE',
      reason: 'missing_tab_context',
    });
    expect(chromeMock.tabs.query).not.toHaveBeenCalled();
    expect(chromeMock.scripting.executeScript).not.toHaveBeenCalled();
  });

  it('short-circuits the status capability with zero grants and no injection', async () => {
    const chromeMock = buildChromeMock({ permissionsContains: false });
    chromeMock.tabs.query.mockResolvedValue([
      { id: 42, windowId: 99, url: 'https://example.com/page', title: 'Example' },
    ]);
    vi.stubGlobal('chrome', chromeMock);

    const { dispatchCapability } = await import('../../src/background/serviceWorker');
    const response = await dispatchCapability({
      target: 'service-worker',
      type: 'dispatch-capability',
      action: 'status',
      params: {},
    });

    expect(response).toMatchObject({ ok: true });
    const okData = (response as { ok: true; data: Record<string, unknown> }).data;
    expect(okData).toMatchObject({
      tabId: 42,
      windowId: 99,
      url: 'https://example.com/page',
      title: 'Example',
    });
    expect(chromeMock.permissions.contains).not.toHaveBeenCalled();
    expect(chromeMock.scripting.executeScript).not.toHaveBeenCalled();
    expect(chromeMock.tabs.sendMessage).not.toHaveBeenCalled();
    expect(okData.capabilities).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'read_page' })]),
    );
  });

  it('uses the scoped tabContext for status when one is provided', async () => {
    const chromeMock = buildChromeMock({ permissionsContains: false });
    chromeMock.tabs.get.mockResolvedValue({
      id: 77,
      windowId: 5,
      url: 'https://example.com/scoped',
      title: 'Scoped',
    });
    chromeMock.tabs.query.mockResolvedValue([
      { id: 88, windowId: 6, url: 'https://example.com/active', title: 'Active' },
    ]);
    vi.stubGlobal('chrome', chromeMock);

    const { dispatchCapability } = await import('../../src/background/serviceWorker');
    const response = await dispatchCapability({
      target: 'service-worker',
      type: 'dispatch-capability',
      action: 'status',
      params: {},
      tabContext: {
        tabId: 77,
        windowId: 5,
        url: 'https://example.com/scoped',
        title: 'Scoped',
      },
    });

    expect(response).toMatchObject({ ok: true });
    const okData = (response as { ok: true; data: Record<string, unknown> }).data;
    expect(okData).toMatchObject({
      tabId: 77,
      windowId: 5,
      url: 'https://example.com/scoped',
      title: 'Scoped',
    });
    expect(chromeMock.tabs.get).toHaveBeenCalledWith(77);
    expect(chromeMock.tabs.query).not.toHaveBeenCalled();
    expect(chromeMock.scripting.executeScript).not.toHaveBeenCalled();
  });

  it('proceeds normally when chrome.permissions.contains returns false but inject succeeds (activeTab fallback)', async () => {
    const chromeMock = buildChromeMock({ permissionsContains: false });
    chromeMock.tabs.get.mockResolvedValue({ id: 11, url: 'https://example.com', title: 'Ex' });
    chromeMock.scripting.executeScript.mockResolvedValue(undefined);
    chromeMock.tabs.sendMessage.mockResolvedValue({ ok: true, data: { pageText: 'ok' } });
    vi.stubGlobal('chrome', chromeMock);

    const { dispatchCapability } = await import('../../src/background/serviceWorker');
    const response = await dispatchCapability({
      target: 'service-worker',
      type: 'dispatch-capability',
      action: 'read_page',
      params: {},
      tabContext: { tabId: 11, url: 'https://example.com' },
    });

    expect(response).toMatchObject({ ok: true });
    expect(chromeMock.permissions.contains).toHaveBeenCalledWith({
      origins: ['https://example.com/*'],
    });
  });

  it('returns INJECTION_REFUSED reason=no-host-permission when inject fails with a pinned message', async () => {
    const chromeMock = buildChromeMock({
      permissionsContains: false,
      executeScriptError: new Error('Cannot access contents of url "https://example.com/". Extension manifest must request permission to access this host.'),
    });
    chromeMock.tabs.get.mockResolvedValue({ id: 11, url: 'https://example.com', title: 'Ex' });
    vi.stubGlobal('chrome', chromeMock);

    const { dispatchCapability } = await import('../../src/background/serviceWorker');
    const response = await dispatchCapability({
      target: 'service-worker',
      type: 'dispatch-capability',
      action: 'read_page',
      params: {},
      tabContext: { tabId: 11, url: 'https://example.com' },
    });

    expect(response).toMatchObject({
      ok: false,
      code: 'INJECTION_REFUSED',
      reason: 'no-host-permission',
      details: expect.objectContaining({
        origin: 'https://example.com',
        displayOrigin: 'example.com',
        reason: 'no-host-permission',
        retryable: true,
      }),
    });
    // Pending state should record the request.
    expect(chromeMock.storage.session.set).toHaveBeenCalled();
  });

  it('classifies executeScript exceptions outside the pinned set as request-failed (never silently denied)', async () => {
    const chromeMock = buildChromeMock({
      permissionsContains: false,
      executeScriptError: new Error('Something weird from a managed device policy.'),
    });
    chromeMock.tabs.get.mockResolvedValue({ id: 11, url: 'https://example.com', title: 'Ex' });
    vi.stubGlobal('chrome', chromeMock);

    const { dispatchCapability } = await import('../../src/background/serviceWorker');
    const response = await dispatchCapability({
      target: 'service-worker',
      type: 'dispatch-capability',
      action: 'read_page',
      params: {},
      tabContext: { tabId: 11, url: 'https://example.com' },
    });

    expect(response).toMatchObject({
      ok: false,
      code: 'INJECTION_REFUSED',
      reason: 'request-failed',
    });
    const refusal = response as {
      ok: false;
      reason: string;
      details?: Record<string, unknown>;
    };
    expect(refusal.reason).not.toBe('denied-by-user');
    expect(refusal.details?.retryable).toBe(true);
  });

  it('classifies executeScript exceptions as transient when the caller already held permission', async () => {
    const chromeMock = buildChromeMock({
      permissionsContains: true,
      executeScriptError: new Error('Frame navigated while injection was pending.'),
    });
    chromeMock.tabs.get.mockResolvedValue({ id: 11, url: 'https://example.com', title: 'Ex' });
    vi.stubGlobal('chrome', chromeMock);

    const { dispatchCapability } = await import('../../src/background/serviceWorker');
    const response = await dispatchCapability({
      target: 'service-worker',
      type: 'dispatch-capability',
      action: 'read_page',
      params: {},
      tabContext: { tabId: 11, url: 'https://example.com' },
    });

    expect(response).toMatchObject({
      ok: false,
      code: 'INJECTION_REFUSED',
      reason: 'transient',
    });
  });

  it('refuses unsupported-scheme URLs before attempting injection', async () => {
    const chromeMock = buildChromeMock();
    chromeMock.tabs.get.mockResolvedValue({ id: 11, url: 'chrome://settings' });
    vi.stubGlobal('chrome', chromeMock);

    const { dispatchCapability } = await import('../../src/background/serviceWorker');
    const response = await dispatchCapability({
      target: 'service-worker',
      type: 'dispatch-capability',
      action: 'read_page',
      params: {},
      tabContext: { tabId: 11, url: 'chrome://settings' },
    });

    // First responder is the isUnsupportedSurfaceUrl check which returns
    // UNSUPPORTED_SURFACE, not INJECTION_REFUSED — it exists for agent-
    // facing tool copy. We assert it's not an INJECTION_REFUSED misclassification.
    expect(response).toMatchObject({ ok: false, code: 'UNSUPPORTED_SURFACE' });
    expect(chromeMock.scripting.executeScript).not.toHaveBeenCalled();
  });
});

describe('serviceWorker side-panel scope lifecycle', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('opens the side panel by tab id when tab-scoped side panels are available', async () => {
    const chromeMock = buildChromeMock();
    vi.stubGlobal('chrome', chromeMock);

    await import('../../src/background/serviceWorker');
    const response = await invokeServiceWorkerMessage(chromeMock, {
      target: 'service-worker',
      type: 'open-side-panel',
      tabId: 42,
      windowId: 1,
    });

    expect(response).toEqual({ ok: true });
    expect(chromeMock.sidePanel.setOptions).toHaveBeenCalledWith({
      tabId: 42,
      enabled: true,
    });
    expect(chromeMock.sidePanel.open).toHaveBeenCalledWith({ tabId: 42 });
    expect(chromeMock.sidePanel.open).not.toHaveBeenCalledWith({ windowId: 1 });
  });

  it('opens the side panel when the toolbar action is clicked', async () => {
    const chromeMock = buildChromeMock();
    vi.stubGlobal('chrome', chromeMock);

    await import('../../src/background/serviceWorker');
    const listener = chromeMock.action.onClicked.addListener.mock.calls[0]?.[0] as
      | ((tab: { id?: number; windowId?: number }) => void)
      | undefined;
    expect(listener).toBeDefined();

    listener?.({ id: 42, windowId: 1 });
    await flushMicrotasks();

    expect(chromeMock.sidePanel.open).toHaveBeenCalledWith({ tabId: 42 });
  });

  it('enables side-panel-on-action-click behavior during install wakeup', async () => {
    const chromeMock = buildChromeMock();
    vi.stubGlobal('chrome', chromeMock);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 404 })) as unknown as typeof fetch,
    );

    await import('../../src/background/serviceWorker');
    const listener = chromeMock.runtime.onInstalled.addListener.mock.calls[0]?.[0] as
      | ((details: { reason: string }) => void)
      | undefined;
    expect(listener).toBeDefined();

    listener?.({ reason: 'install' });
    await flushMicrotasks();

    expect(chromeMock.sidePanel.setPanelBehavior).toHaveBeenCalledWith({
      openPanelOnActionClick: true,
    });
  });

  it('falls back to window-scoped side-panel open without dropping the tab id request', async () => {
    const chromeMock = buildChromeMock();
    chromeMock.sidePanel.open
      .mockRejectedValueOnce(new Error('tab-scoped open unsupported'))
      .mockResolvedValueOnce(undefined);
    vi.stubGlobal('chrome', chromeMock);

    await import('../../src/background/serviceWorker');
    const response = await invokeServiceWorkerMessage(chromeMock, {
      target: 'service-worker',
      type: 'open-side-panel',
      tabId: 42,
      windowId: 1,
    });

    expect(response).toEqual({ ok: true, fallback: 'window' });
    expect(chromeMock.sidePanel.open).toHaveBeenNthCalledWith(1, { tabId: 42 });
    expect(chromeMock.sidePanel.open).toHaveBeenNthCalledWith(2, { windowId: 1 });
  });

  it('returns the service-worker-owned active scope to the side panel', async () => {
    const chromeMock = buildChromeMock();
    chromeMock.tabs.query.mockResolvedValue([
      { id: 7, windowId: 3, url: 'https://example.com/page', title: 'Example' },
    ]);
    vi.stubGlobal('chrome', chromeMock);

    await import('../../src/background/serviceWorker');
    const response = await invokeServiceWorkerMessage(chromeMock, {
      target: 'service-worker',
      type: 'get-active-scope',
      windowId: 3,
    });

    expect(chromeMock.tabs.query).toHaveBeenCalledWith({ active: true, windowId: 3 });
    expect(response).toEqual({
      ok: true,
      tabContext: {
        tabId: 7,
        windowId: 3,
        url: 'https://example.com/page',
        title: 'Example',
      },
    });
  });

  it('notifies side panels when the active tab changes', async () => {
    const chromeMock = buildChromeMock();
    chromeMock.tabs.query.mockResolvedValue([
      { id: 9, windowId: 4, url: 'https://example.com/active', title: 'Active' },
    ]);
    vi.stubGlobal('chrome', chromeMock);

    await import('../../src/background/serviceWorker');
    const activatedListener = chromeMock.tabs.onActivated.addListener.mock.calls[0]?.[0] as
      | ((activeInfo: { tabId: number; windowId: number }) => void)
      | undefined;
    expect(activatedListener).toBeTruthy();
    activatedListener?.({ tabId: 9, windowId: 4 });
    await flushMicrotasks();

    expect(chromeMock.runtime.sendMessage).toHaveBeenCalledWith({
      target: 'sidepanel',
      type: 'scope-changed',
      reason: 'tab-activated',
      windowId: 4,
      tabContext: {
        tabId: 9,
        windowId: 4,
        url: 'https://example.com/active',
        title: 'Active',
      },
    });
  });
});

describe('NO_HOST_PERMISSION_MESSAGES regex set', () => {
  it('matches the pinned Chromium wording for no host permission', async () => {
    const { NO_HOST_PERMISSION_MESSAGES } = await import(
      '../../src/background/serviceWorker'
    );
    expect(
      NO_HOST_PERMISSION_MESSAGES.some((r) =>
        r.test('Cannot access contents of url "https://example.com/".'),
      ),
    ).toBe(true);
    expect(
      NO_HOST_PERMISSION_MESSAGES.some((r) =>
        r.test('Cannot access the page. Missing host permission.'),
      ),
    ).toBe(true);
    expect(
      NO_HOST_PERMISSION_MESSAGES.some((r) =>
        r.test('No tab with id 99.'),
      ),
    ).toBe(true);
  });

  it('does NOT match unrelated errors (guards against silent denied-by-user)', async () => {
    const { NO_HOST_PERMISSION_MESSAGES } = await import(
      '../../src/background/serviceWorker'
    );
    const unrelated = [
      'Frame navigated while injection was pending.',
      'The extensions gallery cannot be scripted.',
      'Something else happened on a managed device.',
    ];
    for (const msg of unrelated) {
      expect(NO_HOST_PERMISSION_MESSAGES.some((r) => r.test(msg))).toBe(false);
    }
  });
});

describe('serviceWorker listener registration', () => {
  // Locks down the IIFE at module load: if a refactor silently drops one of
  // these registrations, the pending-state bookkeeping stops working but all
  // other unit tests would still pass. This guards against that.
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('wires scope and permission lifecycle listeners at module load', async () => {
    const chromeMock = buildChromeMock();
    vi.stubGlobal('chrome', chromeMock);

    await import('../../src/background/serviceWorker');

    expect(chromeMock.tabs.onActivated.addListener).toHaveBeenCalledTimes(1);
    expect(chromeMock.tabs.onUpdated.addListener).toHaveBeenCalledTimes(1);
    expect(chromeMock.windows.onFocusChanged.addListener).toHaveBeenCalledTimes(1);
    expect(chromeMock.webNavigation.onCommitted.addListener).toHaveBeenCalledTimes(1);
    expect(chromeMock.tabs.onRemoved.addListener).toHaveBeenCalledTimes(2);
    expect(chromeMock.permissions.onRemoved.addListener).toHaveBeenCalledTimes(1);
  });
});
