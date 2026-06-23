/**
 * Stage 6c — intents.ts unit tests.
 *
 * Covers:
 *   - `sendIntent` builds the correct POST body (appId, clientId, intent,
 *     tabContext, pageContext, userText)
 *   - `sendIntent` surfaces 501 NOT_IMPLEMENTED as a distinct typed error
 *   - `sendIntent` surfaces 503 APP_NOT_CONNECTED as a distinct typed error
 *   - `sendIntent` surfaces network failures as NETWORK_ERROR
 *   - `sendIntent` surfaces port discovery failure as PORT_UNREACHABLE
 *   - `sendIntent` surfaces aborts as TIMEOUT
 *   - `captureTabContext` returns expected keys when chrome.tabs.query resolves
 *   - `captureTabContext` returns null when chrome.tabs.query rejects or is empty
 *
 * @see docs/plans/260418_rebel_app_bridge_and_browser_extension.md (Stage 6c)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  captureTabContext,
  connectStream,
  focusInRebel,
  getHistory,
  parseSSEChunk,
  sendIntent,
  sendMessage,
  type IntentKind,
  type StreamEvent,
} from '../../src/lib/intents';
import type { PortDiscovery } from '../../src/lib/port-discovery';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function makeDiscovery(port: number | null): PortDiscovery {
  const cached = port
    ? {
        port,
        origin: `http://127.0.0.1:${port}`,
        cachedAt: Date.now(),
      }
    : null;
  return {
    async getPort() {
      return cached;
    },
    async refresh() {
      return cached;
    },
    invalidate() {
      /* noop */
    },
    peekCache() {
      return cached;
    },
  };
}

function mockFetchResponse(init: {
  status: number;
  body?: unknown;
  bodyText?: string;
}): typeof fetch {
  return (async () => {
    const headers = new Headers({ 'content-type': 'application/json' });
    const body =
      init.bodyText !== undefined ? init.bodyText : JSON.stringify(init.body ?? {});
    return new Response(body, { status: init.status, headers });
  }) as unknown as typeof fetch;
}

function recordingFetch(
  responseInit: { status: number; body: unknown },
  record: Array<{ url: string; init?: RequestInit }>,
): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    const entry: { url: string; init?: RequestInit } = { url };
    if (init) entry.init = init;
    record.push(entry);
    const headers = new Headers({ 'content-type': 'application/json' });
    return new Response(JSON.stringify(responseInit.body), {
      status: responseInit.status,
      headers,
    });
  }) as unknown as typeof fetch;
}

// ---------------------------------------------------------------------------
// sendIntent
// ---------------------------------------------------------------------------

describe('sendIntent — request shape', () => {
  it('POSTs /intent/conversation/create with appId, clientId, intent, tabContext, pageContext', async () => {
    const record: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = recordingFetch(
      {
        status: 200,
        body: { success: true, conversationId: 's_123', state: 'new' },
      },
      record,
    );

    const result = await sendIntent({
      clientId: 'client-abc',
      token: 'pair-token-xyz',
      intent: 'summarise',
      tabContext: { tabId: 42, windowId: 1, url: 'https://example.com/a', title: 'A' },
      pageContext: {
        title: 'A',
        url: 'https://example.com/a',
        selection: 'hello',
        text: 'body text',
      },
      fetchImpl,
      portDiscovery: makeDiscovery(52320),
    });

    expect(result).toMatchObject({ ok: true, conversationId: 's_123', state: 'new' });
    expect(record).toHaveLength(1);
    const call = record[0];
    if (!call) throw new Error('expected a call');
    expect(call.url).toBe('http://127.0.0.1:52320/intent/conversation/create');
    expect(call.init?.method).toBe('POST');
    const body = JSON.parse(String(call.init?.body));
    expect(body).toEqual({
      appId: 'browser-extension',
      clientId: 'client-abc',
      intent: 'summarise',
      tabContext: { tabId: 42, windowId: 1, url: 'https://example.com/a', title: 'A' },
      pageContext: {
        title: 'A',
        url: 'https://example.com/a',
        selection: 'hello',
        text: 'body text',
      },
    });
  });

  it('attaches Authorization, X-Rebel-App-Id and X-Rebel-Client-Id headers (A4)', async () => {
    // Post-review A4: /intent/* now requires the paired app token +
    // X-Rebel-App-Id + X-Rebel-Client-Id. Missing any of these makes
    // the bridge return 401.
    const record: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = recordingFetch(
      { status: 200, body: { success: true, conversationId: 's_hdr' } },
      record,
    );
    await sendIntent({
      clientId: 'client-abc',
      token: 'pair-token-xyz',
      intent: 'summarise',
      tabContext: { tabId: 1 },
      fetchImpl,
      portDiscovery: makeDiscovery(52320),
    });
    const init = record[0]?.init;
    if (!init) throw new Error('no init captured');
    const headers = new Headers(init.headers);
    expect(headers.get('authorization')).toBe('Bearer pair-token-xyz');
    expect(headers.get('x-rebel-app-id')).toBe('browser-extension');
    expect(headers.get('x-rebel-client-id')).toBe('client-abc');
    expect(headers.get('x-rebel-client-fingerprint')).toBeNull();
  });

  it('forwards X-Rebel-Client-Fingerprint when supplied (B4)', async () => {
    const record: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = recordingFetch(
      { status: 200, body: { success: true, conversationId: 's_fp' } },
      record,
    );
    await sendIntent({
      clientId: 'client-abc',
      token: 'pair-token-xyz',
      fingerprint: 'fp-sha256-abc',
      intent: 'summarise',
      tabContext: { tabId: 1 },
      fetchImpl,
      portDiscovery: makeDiscovery(52320),
    });
    const init = record[0]?.init;
    if (!init) throw new Error('no init captured');
    const headers = new Headers(init.headers);
    expect(headers.get('x-rebel-client-fingerprint')).toBe('fp-sha256-abc');
  });

  it('passes userText through when the caller supplies it (ask intent)', async () => {
    const record: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = recordingFetch(
      { status: 200, body: { success: true, conversationId: 's_ask' } },
      record,
    );
    await sendIntent({
      clientId: 'client-abc',
      token: 'pair-token-xyz',
      intent: 'ask' as IntentKind,
      tabContext: { tabId: 7 },
      userText: 'What does this page argue?',
      fetchImpl,
      portDiscovery: makeDiscovery(52320),
    });
    const body = JSON.parse(String(record[0]?.init?.body));
    expect(body.intent).toBe('ask');
    expect(body.userText).toBe('What does this page argue?');
  });

  it('omits pageContext / userText when absent (lean wire shape)', async () => {
    const record: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = recordingFetch(
      { status: 200, body: { success: true, conversationId: 's_bare' } },
      record,
    );
    await sendIntent({
      clientId: 'client-abc',
      token: 'pair-token-xyz',
      intent: 'save_to_notes',
      tabContext: { tabId: 1 },
      fetchImpl,
      portDiscovery: makeDiscovery(52320),
    });
    const body = JSON.parse(String(record[0]?.init?.body));
    expect(body).toEqual({
      appId: 'browser-extension',
      clientId: 'client-abc',
      intent: 'save_to_notes',
      tabContext: { tabId: 1 },
    });
    expect('pageContext' in body).toBe(false);
    expect('userText' in body).toBe(false);
  });
});

describe('sendIntent — error mapping', () => {
  it('returns NOT_IMPLEMENTED when the server returns 501 (Stage 7 not landed)', async () => {
    const fetchImpl = mockFetchResponse({
      status: 501,
      body: {
        success: false,
        code: 'NOT_IMPLEMENTED',
        message: 'App Bridge create conversation not yet implemented.',
      },
    });
    const result = await sendIntent({
      clientId: 'client-abc',
      token: 'pair-token-xyz',
      intent: 'summarise',
      tabContext: { tabId: 1 },
      fetchImpl,
      portDiscovery: makeDiscovery(52320),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('NOT_IMPLEMENTED');
      expect(result.status).toBe(501);
    }
  });

  it('returns APP_NOT_CONNECTED on 503', async () => {
    const fetchImpl = mockFetchResponse({ status: 503, body: {} });
    const result = await sendIntent({
      clientId: 'client-abc',
      token: 'pair-token-xyz',
      intent: 'summarise',
      tabContext: { tabId: 1 },
      fetchImpl,
      portDiscovery: makeDiscovery(52320),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('APP_NOT_CONNECTED');
  });

  it('returns UNAUTHORIZED on 401', async () => {
    const fetchImpl = mockFetchResponse({ status: 401, body: {} });
    const result = await sendIntent({
      clientId: 'client-abc',
      token: 'pair-token-xyz',
      intent: 'summarise',
      tabContext: { tabId: 1 },
      fetchImpl,
      portDiscovery: makeDiscovery(52320),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('UNAUTHORIZED');
  });

  it('returns BAD_REQUEST with a human message on 400', async () => {
    const fetchImpl = mockFetchResponse({
      status: 400,
      body: { success: false, code: 'BAD_REQUEST', message: 'intent: required' },
    });
    const result = await sendIntent({
      clientId: 'client-abc',
      token: 'pair-token-xyz',
      intent: 'summarise',
      tabContext: { tabId: 1 },
      fetchImpl,
      portDiscovery: makeDiscovery(52320),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('BAD_REQUEST');
      expect(result.message).toMatch(/intent/i);
    }
  });

  it('returns NETWORK_ERROR when fetch rejects with a non-abort error', async () => {
    const fetchImpl = (() =>
      Promise.reject(new TypeError('failed to fetch'))) as unknown as typeof fetch;
    const result = await sendIntent({
      clientId: 'client-abc',
      token: 'pair-token-xyz',
      intent: 'summarise',
      tabContext: { tabId: 1 },
      fetchImpl,
      portDiscovery: makeDiscovery(52320),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('NETWORK_ERROR');
  });

  it('returns PORT_UNREACHABLE when port discovery yields no bridge', async () => {
    const fetchImpl = vi.fn();
    const result = await sendIntent({
      clientId: 'client-abc',
      token: 'pair-token-xyz',
      intent: 'summarise',
      tabContext: { tabId: 1 },
      fetchImpl: fetchImpl as unknown as typeof fetch,
      portDiscovery: makeDiscovery(null),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('PORT_UNREACHABLE');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('returns TIMEOUT when the request is aborted', async () => {
    const fetchImpl = ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('aborted', 'AbortError') as unknown as Error),
        );
      })) as unknown as typeof fetch;
    const result = await sendIntent({
      clientId: 'client-abc',
      token: 'pair-token-xyz',
      intent: 'summarise',
      tabContext: { tabId: 1 },
      fetchImpl,
      portDiscovery: makeDiscovery(52320),
      timeoutMs: 10,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('TIMEOUT');
  });

  it('returns UNKNOWN when the server responds 200 but omits conversationId', async () => {
    const fetchImpl = mockFetchResponse({ status: 200, body: { success: true } });
    const result = await sendIntent({
      clientId: 'client-abc',
      token: 'pair-token-xyz',
      intent: 'summarise',
      tabContext: { tabId: 1 },
      fetchImpl,
      portDiscovery: makeDiscovery(52320),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('UNKNOWN');
  });
});

// ---------------------------------------------------------------------------
// captureTabContext
// ---------------------------------------------------------------------------

describe('captureTabContext', () => {
  beforeEach(() => {
    // Ensure `chrome` global exists for fallback path (some tests don't pass
    // tabsQuery and will fall through to chrome.tabs.query).
    (globalThis as unknown as { chrome?: unknown }).chrome = {
      tabs: {
        query: vi.fn(() => Promise.resolve([])),
      },
    };
  });

  afterEach(() => {
    delete (globalThis as unknown as { chrome?: unknown }).chrome;
  });

  it('returns { tabId, windowId, url, title } when chrome.tabs.query resolves with a live tab', async () => {
    const tabsQuery = vi.fn(async () => [
      { id: 42, windowId: 1, url: 'https://example.com/a', title: 'A' } as chrome.tabs.Tab,
    ]);
    const ctx = await captureTabContext({ tabsQuery });
    expect(ctx).toEqual({
      tabId: 42,
      windowId: 1,
      url: 'https://example.com/a',
      title: 'A',
    });
  });

  it('omits optional keys when the underlying tab omits them', async () => {
    const tabsQuery = vi.fn(async () => [
      { id: 7 } as unknown as chrome.tabs.Tab,
    ]);
    const ctx = await captureTabContext({ tabsQuery });
    expect(ctx).toEqual({ tabId: 7 });
  });

  it('returns null when chrome.tabs.query rejects', async () => {
    const tabsQuery = vi.fn(async () => {
      throw new Error('nope');
    });
    const ctx = await captureTabContext({ tabsQuery });
    expect(ctx).toBeNull();
  });

  it('returns null when chrome.tabs.query resolves to an empty array', async () => {
    const tabsQuery = vi.fn(async () => []);
    const ctx = await captureTabContext({ tabsQuery });
    expect(ctx).toBeNull();
  });

  it('returns null when the first tab lacks an id', async () => {
    const tabsQuery = vi.fn(async () => [{} as chrome.tabs.Tab]);
    const ctx = await captureTabContext({ tabsQuery });
    expect(ctx).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// sendMessage
// ---------------------------------------------------------------------------

describe('sendMessage', () => {
  it('POSTs to /intent/conversation/:id/message with the expected envelope', async () => {
    const record: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = recordingFetch(
      {
        status: 200,
        body: {
          success: true,
          messageId: 'msg-1',
          state: 'submitted',
          queueSize: 0,
        },
      },
      record,
    );
    const result = await sendMessage({
      conversationId: 'conv-1',
      clientId: 'client-abc',
      token: 'tok',
      text: 'hi there',
      tabContext: { tabId: 7 },
      fetchImpl,
      portDiscovery: makeDiscovery(52320),
    });
    expect(result).toEqual({
      ok: true,
      messageId: 'msg-1',
      state: 'submitted',
      queueSize: 0,
    });
    const call = record[0];
    if (!call) throw new Error('expected a call');
    expect(call.url).toBe('http://127.0.0.1:52320/intent/conversation/conv-1/message');
    expect(call.init?.method).toBe('POST');
    const body = JSON.parse(String(call.init?.body));
    expect(body).toEqual({
      appId: 'browser-extension',
      clientId: 'client-abc',
      text: 'hi there',
      tabContext: { tabId: 7 },
    });
    const headers = new Headers(call.init?.headers);
    expect(headers.get('authorization')).toBe('Bearer tok');
    expect(headers.get('x-rebel-app-id')).toBe('browser-extension');
    expect(headers.get('x-rebel-client-id')).toBe('client-abc');
  });

  it('URL-encodes the conversationId path segment', async () => {
    const record: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = recordingFetch(
      {
        status: 200,
        body: { success: true, messageId: 'm', state: 'submitted', queueSize: 0 },
      },
      record,
    );
    await sendMessage({
      conversationId: 'conv with/slash',
      clientId: 'c',
      token: 't',
      text: 'hi',
      fetchImpl,
      portDiscovery: makeDiscovery(52320),
    });
    expect(record[0]?.url).toBe(
      'http://127.0.0.1:52320/intent/conversation/conv%20with%2Fslash/message',
    );
  });

  it('surfaces buffered state with queueSize', async () => {
    const fetchImpl = mockFetchResponse({
      status: 200,
      body: {
        success: true,
        messageId: 'msg-q',
        state: 'buffered',
        queueSize: 2,
      },
    });
    const result = await sendMessage({
      conversationId: 'c',
      clientId: 'x',
      token: 't',
      text: 'held',
      fetchImpl,
      portDiscovery: makeDiscovery(52320),
    });
    expect(result).toEqual({
      ok: true,
      messageId: 'msg-q',
      state: 'buffered',
      queueSize: 2,
    });
  });

  it('returns UNAUTHORIZED on 401', async () => {
    const fetchImpl = mockFetchResponse({ status: 401, body: {} });
    const result = await sendMessage({
      conversationId: 'c',
      clientId: 'x',
      token: 't',
      text: 'x',
      fetchImpl,
      portDiscovery: makeDiscovery(52320),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('UNAUTHORIZED');
  });

  it('returns NOT_IMPLEMENTED on 501', async () => {
    const fetchImpl = mockFetchResponse({ status: 501, body: {} });
    const result = await sendMessage({
      conversationId: 'c',
      clientId: 'x',
      token: 't',
      text: 'x',
      fetchImpl,
      portDiscovery: makeDiscovery(52320),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('NOT_IMPLEMENTED');
  });

  it('returns PORT_UNREACHABLE when discovery yields no port', async () => {
    const fetchImpl = vi.fn();
    const result = await sendMessage({
      conversationId: 'c',
      clientId: 'x',
      token: 't',
      text: 'x',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      portDiscovery: makeDiscovery(null),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('PORT_UNREACHABLE');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('returns TIMEOUT on abort', async () => {
    const fetchImpl = ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('aborted', 'AbortError') as unknown as Error),
        );
      })) as unknown as typeof fetch;
    const result = await sendMessage({
      conversationId: 'c',
      clientId: 'x',
      token: 't',
      text: 'x',
      fetchImpl,
      portDiscovery: makeDiscovery(52320),
      timeoutMs: 5,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('TIMEOUT');
  });

  it('returns UNKNOWN when the server replies 200 with a malformed body', async () => {
    const fetchImpl = mockFetchResponse({
      status: 200,
      body: { success: true }, // missing messageId/state/queueSize
    });
    const result = await sendMessage({
      conversationId: 'c',
      clientId: 'x',
      token: 't',
      text: 'x',
      fetchImpl,
      portDiscovery: makeDiscovery(52320),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('UNKNOWN');
  });

  it('forwards X-Rebel-Client-Fingerprint when supplied', async () => {
    const record: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = recordingFetch(
      {
        status: 200,
        body: { success: true, messageId: 'm', state: 'submitted', queueSize: 0 },
      },
      record,
    );
    await sendMessage({
      conversationId: 'c',
      clientId: 'x',
      token: 't',
      text: 'x',
      fingerprint: 'fp-123',
      fetchImpl,
      portDiscovery: makeDiscovery(52320),
    });
    const headers = new Headers(record[0]?.init?.headers);
    expect(headers.get('x-rebel-client-fingerprint')).toBe('fp-123');
  });
});

// ---------------------------------------------------------------------------
// getHistory
// ---------------------------------------------------------------------------

describe('getHistory', () => {
  it('GETs /intent/conversation/:id/messages and projects the response', async () => {
    const record: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = recordingFetch(
      {
        status: 200,
        body: {
          success: true,
          conversationId: 'c',
          messages: [
            { id: 'm1', role: 'user', text: 'hello', createdAt: 1 },
            { id: 'm2', role: 'assistant', text: 'hi back', createdAt: 2 },
          ],
          turnStatus: 'idle',
          conversationTitle: 'Greeting',
        },
      },
      record,
    );
    const result = await getHistory({
      conversationId: 'c',
      clientId: 'x',
      token: 't',
      fetchImpl,
      portDiscovery: makeDiscovery(52320),
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.messages).toHaveLength(2);
      expect(result.messages[0]).toEqual({
        id: 'm1',
        role: 'user',
        text: 'hello',
        createdAt: 1,
      });
      expect(result.turnStatus).toBe('idle');
      expect(result.conversationTitle).toBe('Greeting');
    }
    const call = record[0];
    if (!call) throw new Error('expected a call');
    expect(call.url).toBe('http://127.0.0.1:52320/intent/conversation/c/messages');
    expect(call.init?.method).toBe('GET');
    const headers = new Headers(call.init?.headers);
    expect(headers.get('authorization')).toBe('Bearer t');
    expect(headers.get('x-rebel-app-id')).toBe('browser-extension');
    expect(headers.get('x-rebel-client-id')).toBe('x');
  });

  it('drops malformed message entries silently (forward compatible)', async () => {
    const fetchImpl = mockFetchResponse({
      status: 200,
      body: {
        messages: [
          { id: 'ok', role: 'user', text: 'ok', createdAt: 1 },
          { id: 'bad-role', role: 'system', text: 'nope', createdAt: 2 },
          { role: 'user', text: 'no id', createdAt: 3 },
          'string-entry',
        ],
        turnStatus: 'running',
      },
    });
    const result = await getHistory({
      conversationId: 'c',
      clientId: 'x',
      token: 't',
      fetchImpl,
      portDiscovery: makeDiscovery(52320),
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.messages).toHaveLength(1);
      expect(result.messages[0]?.id).toBe('ok');
      expect(result.turnStatus).toBe('running');
      expect(result.conversationTitle).toBeUndefined();
    }
  });

  it('returns UNKNOWN when turnStatus is missing or unrecognised', async () => {
    const fetchImpl = mockFetchResponse({
      status: 200,
      body: { messages: [], turnStatus: 'nonsense' },
    });
    const result = await getHistory({
      conversationId: 'c',
      clientId: 'x',
      token: 't',
      fetchImpl,
      portDiscovery: makeDiscovery(52320),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('UNKNOWN');
  });

  it('returns UNAUTHORIZED on 401', async () => {
    const fetchImpl = mockFetchResponse({ status: 401, body: {} });
    const result = await getHistory({
      conversationId: 'c',
      clientId: 'x',
      token: 't',
      fetchImpl,
      portDiscovery: makeDiscovery(52320),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('UNAUTHORIZED');
  });

  it('returns PORT_UNREACHABLE when discovery fails', async () => {
    const fetchImpl = vi.fn();
    const result = await getHistory({
      conversationId: 'c',
      clientId: 'x',
      token: 't',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      portDiscovery: makeDiscovery(null),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('PORT_UNREACHABLE');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('returns NETWORK_ERROR when fetch rejects', async () => {
    const fetchImpl = (() =>
      Promise.reject(new TypeError('failed'))) as unknown as typeof fetch;
    const result = await getHistory({
      conversationId: 'c',
      clientId: 'x',
      token: 't',
      fetchImpl,
      portDiscovery: makeDiscovery(52320),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('NETWORK_ERROR');
  });
});

// ---------------------------------------------------------------------------
// focusInRebel
// ---------------------------------------------------------------------------

describe('focusInRebel', () => {
  it('POSTs /intent/conversation/:id/focus with auth headers', async () => {
    const record: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = recordingFetch(
      { status: 200, body: { success: true, conversationId: 'c', focused: true } },
      record,
    );
    const result = await focusInRebel({
      conversationId: 'c',
      clientId: 'x',
      token: 't',
      fetchImpl,
      portDiscovery: makeDiscovery(52320),
    });
    expect(result).toEqual({ ok: true });
    const call = record[0];
    if (!call) throw new Error('expected a call');
    expect(call.url).toBe('http://127.0.0.1:52320/intent/conversation/c/focus');
    expect(call.init?.method).toBe('POST');
    const headers = new Headers(call.init?.headers);
    expect(headers.get('authorization')).toBe('Bearer t');
    expect(headers.get('x-rebel-app-id')).toBe('browser-extension');
    expect(headers.get('x-rebel-client-id')).toBe('x');
  });

  it('returns UNAUTHORIZED on 401', async () => {
    const fetchImpl = mockFetchResponse({ status: 401, body: {} });
    const result = await focusInRebel({
      conversationId: 'c',
      clientId: 'x',
      token: 't',
      fetchImpl,
      portDiscovery: makeDiscovery(52320),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('UNAUTHORIZED');
  });

  it('returns PORT_UNREACHABLE when discovery fails', async () => {
    const fetchImpl = vi.fn();
    const result = await focusInRebel({
      conversationId: 'c',
      clientId: 'x',
      token: 't',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      portDiscovery: makeDiscovery(null),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('PORT_UNREACHABLE');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('returns BAD_REQUEST on 400 with server message', async () => {
    const fetchImpl = mockFetchResponse({
      status: 400,
      body: { success: false, message: 'conversation missing' },
    });
    const result = await focusInRebel({
      conversationId: 'c',
      clientId: 'x',
      token: 't',
      fetchImpl,
      portDiscovery: makeDiscovery(52320),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('BAD_REQUEST');
      expect(result.message).toMatch(/conversation missing/);
    }
  });
});

// ---------------------------------------------------------------------------
// parseSSEChunk (unit)
// ---------------------------------------------------------------------------

describe('parseSSEChunk', () => {
  it('parses a single event/data block and returns no remaining bytes', () => {
    const chunk = 'event: assistant_delta\ndata: {"turnId":"t1","text":"hi"}\n\n';
    const out = parseSSEChunk(chunk);
    expect(out.events).toHaveLength(1);
    expect(out.events[0]).toEqual({
      event: 'assistant_delta',
      data: '{"turnId":"t1","text":"hi"}',
    });
    expect(out.remaining).toBe('');
  });

  it('returns the tail of an incomplete block as remaining', () => {
    const chunk = 'event: assistant_delta\ndata: {"turnId":"t1",';
    const out = parseSSEChunk(chunk);
    expect(out.events).toHaveLength(0);
    expect(out.remaining).toBe(chunk);
  });

  it('ignores `:` keepalive-comment blocks', () => {
    const chunk = ': keepalive\n\nevent: assistant_done\ndata: {"turnId":"t1"}\n\n';
    const out = parseSSEChunk(chunk);
    expect(out.events).toHaveLength(1);
    expect(out.events[0]?.event).toBe('assistant_done');
  });

  it('concatenates multiple data: lines with \\n', () => {
    const chunk = 'event: assistant_delta\ndata: line1\ndata: line2\n\n';
    const out = parseSSEChunk(chunk);
    expect(out.events[0]?.data).toBe('line1\nline2');
  });

  it('strips the single leading space after the colon per SSE spec', () => {
    const chunk = 'event: x\ndata:hello\n\nevent: y\ndata: world\n\n';
    const out = parseSSEChunk(chunk);
    expect(out.events[0]?.data).toBe('hello');
    expect(out.events[1]?.data).toBe('world');
  });

  it('defaults event name to `message` when absent', () => {
    const chunk = 'data: {"x":1}\n\n';
    const out = parseSSEChunk(chunk);
    expect(out.events[0]?.event).toBe('message');
  });

  it('parses two consecutive events in one chunk', () => {
    const chunk =
      'event: a\ndata: 1\n\nevent: b\ndata: 2\n\n';
    const out = parseSSEChunk(chunk);
    expect(out.events).toHaveLength(2);
    expect(out.events[0]?.event).toBe('a');
    expect(out.events[1]?.event).toBe('b');
  });

  it('normalises CRLF to LF', () => {
    const chunk = 'event: x\r\ndata: 1\r\n\r\n';
    const out = parseSSEChunk(chunk);
    expect(out.events).toHaveLength(1);
    expect(out.events[0]?.event).toBe('x');
  });
});

// ---------------------------------------------------------------------------
// connectStream
// ---------------------------------------------------------------------------

/**
 * Build a `fetch`-compatible mock that yields a streaming Response whose body
 * emits the supplied SSE chunks in order. Useful for driving the parser from
 * arbitrary partial-chunk sequences.
 */
function makeStreamFetch(
  chunks: string[],
  init: { status?: number; signal?: AbortSignal } = {},
): typeof fetch {
  const encoder = new TextEncoder();
  const status = init.status ?? 200;
  return (async (_url: string, reqInit?: RequestInit) => {
    const reqSignal = reqInit?.signal;
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        for (const chunk of chunks) {
          // Honor the caller's AbortSignal mid-stream.
          if (reqSignal?.aborted) {
            controller.error(new DOMException('aborted', 'AbortError'));
            return;
          }
          controller.enqueue(encoder.encode(chunk));
          // Yield to the microtask queue so the reader can see the chunk.
          await Promise.resolve();
        }
        controller.close();
      },
    });
    return new Response(body, { status });
  }) as unknown as typeof fetch;
}

describe('connectStream', () => {
  it('parses SSE frames and delivers typed events', async () => {
    const events: StreamEvent[] = [];
    const chunks = [
      'event: connected\ndata: {"conversationId":"c","turnStatus":"idle"}\n\n',
      'event: turn_started\ndata: {"turnId":"t1"}\n\n',
      'event: assistant_delta\ndata: {"turnId":"t1","text":"he"}\n\nevent: assistant_delta\ndata: {"turnId":"t1","text":"llo"}\n\n',
      'event: assistant_done\ndata: {"turnId":"t1"}\n\n',
    ];

    await new Promise<void>((resolve) => {
      connectStream({
        conversationId: 'c',
        clientId: 'x',
        token: 't',
        fetchImpl: makeStreamFetch(chunks),
        portDiscovery: makeDiscovery(52320),
        onEvent: (e) => events.push(e),
        onClose: () => resolve(),
      });
    });

    expect(events.map((e) => e.type)).toEqual([
      'connected',
      'turn_started',
      'assistant_delta',
      'assistant_delta',
      'assistant_done',
    ]);
    const delta = events[2];
    if (delta?.type !== 'assistant_delta') throw new Error('expected delta');
    expect(delta.text).toBe('he');
  });

  it('handles a single frame split across multiple chunks', async () => {
    const events: StreamEvent[] = [];
    const chunks = [
      'event: assistant_delta\n',
      'data: {"turnId":"t1",',
      '"text":"hello"}\n\n',
    ];
    await new Promise<void>((resolve) => {
      connectStream({
        conversationId: 'c',
        clientId: 'x',
        token: 't',
        fetchImpl: makeStreamFetch(chunks),
        portDiscovery: makeDiscovery(52320),
        onEvent: (e) => events.push(e),
        onClose: () => resolve(),
      });
    });
    expect(events).toHaveLength(1);
    const delta = events[0];
    if (delta?.type !== 'assistant_delta') throw new Error('expected delta');
    expect(delta.text).toBe('hello');
  });

  it('invokes onError and onClose on non-2xx status', async () => {
    const errors: Error[] = [];
    const closed: boolean[] = [];
    await new Promise<void>((resolve) => {
      const fetchImpl = makeStreamFetch([], { status: 401 });
      connectStream({
        conversationId: 'c',
        clientId: 'x',
        token: 't',
        fetchImpl,
        portDiscovery: makeDiscovery(52320),
        onEvent: () => {
          /* no events expected */
        },
        onError: (e) => errors.push(e),
        onClose: () => {
          closed.push(true);
          resolve();
        },
      });
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toMatch(/UNAUTHORIZED/);
    expect(closed).toEqual([true]);
  });

  it('calls onError + onClose when port discovery fails', async () => {
    const errors: Error[] = [];
    await new Promise<void>((resolve) => {
      connectStream({
        conversationId: 'c',
        clientId: 'x',
        token: 't',
        fetchImpl: makeStreamFetch([]),
        portDiscovery: makeDiscovery(null),
        onEvent: () => {
          /* none */
        },
        onError: (e) => errors.push(e),
        onClose: () => resolve(),
      });
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toBe('PORT_UNREACHABLE');
  });

  it('honors AbortSignal — close() stops further events and fires onClose', async () => {
    const events: StreamEvent[] = [];
    const controller = new AbortController();
    const chunks = [
      'event: assistant_delta\ndata: {"turnId":"t1","text":"first"}\n\n',
      'event: assistant_delta\ndata: {"turnId":"t1","text":"second"}\n\n',
    ];
    await new Promise<void>((resolve) => {
      const conn = connectStream({
        conversationId: 'c',
        clientId: 'x',
        token: 't',
        fetchImpl: makeStreamFetch(chunks),
        portDiscovery: makeDiscovery(52320),
        signal: controller.signal,
        onEvent: (e) => {
          events.push(e);
          // Abort after first event.
          conn.close();
        },
        onClose: () => resolve(),
      });
    });
    // We received at least the first event; abort shouldn't crash.
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0]?.type).toBe('assistant_delta');
  });

  it('sends Authorization + X-Rebel-App-Id + X-Rebel-Client-Id headers', async () => {
    const captured: RequestInit | undefined = await new Promise<RequestInit | undefined>(
      (resolve) => {
        let capturedInit: RequestInit | undefined;
        const encoder = new TextEncoder();
        const fetchImpl = (async (_url: string, init?: RequestInit) => {
          capturedInit = init;
          const body = new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(encoder.encode(':ok\n\n'));
              controller.close();
            },
          });
          return new Response(body, { status: 200 });
        }) as unknown as typeof fetch;
        connectStream({
          conversationId: 'c',
          clientId: 'client-abc',
          token: 'tok',
          fingerprint: 'fp-9',
          fetchImpl,
          portDiscovery: makeDiscovery(52320),
          onEvent: () => {
            /* none */
          },
          onClose: () => resolve(capturedInit),
        });
      },
    );
    expect(captured).toBeDefined();
    const headers = new Headers(captured?.headers);
    expect(headers.get('authorization')).toBe('Bearer tok');
    expect(headers.get('x-rebel-app-id')).toBe('browser-extension');
    expect(headers.get('x-rebel-client-id')).toBe('client-abc');
    expect(headers.get('x-rebel-client-fingerprint')).toBe('fp-9');
    expect(headers.get('accept')).toBe('text/event-stream');
  });

  it('ignores unknown event types silently', async () => {
    const events: StreamEvent[] = [];
    const chunks = [
      'event: unknown_future_event\ndata: {"x":1}\n\n',
      'event: assistant_delta\ndata: {"turnId":"t1","text":"ok"}\n\n',
    ];
    await new Promise<void>((resolve) => {
      connectStream({
        conversationId: 'c',
        clientId: 'x',
        token: 't',
        fetchImpl: makeStreamFetch(chunks),
        portDiscovery: makeDiscovery(52320),
        onEvent: (e) => events.push(e),
        onClose: () => resolve(),
      });
    });
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('assistant_delta');
  });

  it('drops malformed JSON payloads silently', async () => {
    const events: StreamEvent[] = [];
    const chunks = [
      'event: assistant_delta\ndata: this is not json\n\n',
      'event: assistant_delta\ndata: {"turnId":"t1","text":"ok"}\n\n',
    ];
    await new Promise<void>((resolve) => {
      connectStream({
        conversationId: 'c',
        clientId: 'x',
        token: 't',
        fetchImpl: makeStreamFetch(chunks),
        portDiscovery: makeDiscovery(52320),
        onEvent: (e) => events.push(e),
        onClose: () => resolve(),
      });
    });
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('assistant_delta');
  });

  it('maps revoked SSE frames to { type: "revoked" }', async () => {
    const events: StreamEvent[] = [];
    const chunks = ['event: revoked\ndata: {"reason":"token_revoked"}\n\n'];
    await new Promise<void>((resolve) => {
      connectStream({
        conversationId: 'c',
        clientId: 'x',
        token: 't',
        fetchImpl: makeStreamFetch(chunks),
        portDiscovery: makeDiscovery(52320),
        onEvent: (e) => events.push(e),
        onClose: () => resolve(),
      });
    });
    expect(events).toEqual([{ type: 'revoked' }]);
  });
});
