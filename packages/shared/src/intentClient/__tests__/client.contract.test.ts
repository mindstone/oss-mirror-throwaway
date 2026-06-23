import { describe, expect, it, vi } from 'vitest';
import { createIntentClient, isResponseError } from '../client';
import type {
  ConnectStreamError,
  ConnectStreamEvent,
  ResponseError,
} from '../clientTypes';
import type { DiagnosticEvent, DiagnosticSink, FetchExceptionShape } from '../diagnostics';
import type { IntentTransportAdapter } from '../intentTransportAdapter';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ENCODER = new TextEncoder();

const ADAPTER_CASES = [
  {
    name: 'extension-like adapter',
    adapter: (): IntentTransportAdapter => ({
      resolveBaseUrl: () => 'http://127.0.0.1:52320',
      buildHeaders: async (init) => {
        const headers = new Headers();
        headers.set('authorization', 'Bearer test-tok-ext');
        headers.set('x-rebel-app-id', 'browser-extension');
        headers.set('x-rebel-client-id', 'cid-ext');
        headers.set('x-rebel-client-fingerprint', 'fp-ext');
        if (init.contentType) headers.set('content-type', init.contentType);
        if (init.accept) headers.set('accept', init.accept);
        return headers;
      },
      stampRequestBody: (body) => ({
        ...body,
        appId: 'browser-extension',
        clientId: 'cid-ext',
      }),
      describeForLog: () => ({
        surface: 'browser-extension',
        origin: 'http://127.0.0.1:52320',
        transportKind: 'port-discovery',
      }),
    }),
    expectedBaseUrl: 'http://127.0.0.1:52320',
    expectedHeaders: {
      authorization: 'Bearer test-tok-ext',
      'x-rebel-app-id': 'browser-extension',
      'x-rebel-client-id': 'cid-ext',
      'x-rebel-client-fingerprint': 'fp-ext',
      'content-type': 'application/json',
      accept: 'application/json',
    },
    expectsStampedBody: true,
  },
  {
    name: 'office-like adapter',
    adapter: (): IntentTransportAdapter => ({
      resolveBaseUrl: () => '',
      buildHeaders: async (init) => {
        const headers = new Headers();
        headers.set('authorization', 'Bearer test-tok-office');
        if (init.contentType) headers.set('content-type', init.contentType);
        if (init.accept) headers.set('accept', init.accept);
        return headers;
      },
      describeForLog: () => ({
        surface: 'office-addin',
        origin: '',
        transportKind: 'sidecar-proxy',
      }),
    }),
    expectedBaseUrl: '',
    expectedHeaders: {
      authorization: 'Bearer test-tok-office',
      'content-type': 'application/json',
      accept: 'application/json',
    },
    expectsStampedBody: false,
  },
] as const;

describe.each(ADAPTER_CASES)('$name', (adapterCase) => {
  function route(path: string): string {
    return `${adapterCase.expectedBaseUrl}${path}`;
  }

  function createDiagnosticsCollector(): {
    sink: DiagnosticSink;
    events: DiagnosticEvent[];
  } {
    const events: DiagnosticEvent[] = [];
    return {
      events,
      sink: {
        emit: (event) => {
          events.push(event);
        },
      },
    };
  }

  function createClient(fetchImpl: typeof fetch, sink?: DiagnosticSink) {
    const diagnostics = sink ?? createDiagnosticsCollector().sink;
    return createIntentClient({
      transport: adapterCase.adapter(),
      fetchImpl,
      diagnostics,
    });
  }

  it('1) uses the correct URL contract for all operations', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.endsWith('/intent/conversation/create')) {
        return jsonResponse({ conversationId: 'conv-1', state: 'new' });
      }
      if (url.endsWith('/intent/conversation/message')) {
        return jsonResponse({
          conversationId: 'conv-1',
          messageId: 'msg-1',
          state: 'submitted',
          queueSize: 0,
        });
      }
      if (url.endsWith('/intent/conversation/history')) {
        return jsonResponse({
          conversationId: 'conv-1',
          messages: [
            {
              id: 'msg-2',
              role: 'assistant',
              text: 'hello',
              createdAt: 123,
              turnId: 'turn-2',
            },
          ],
          turnStatus: 'idle',
        });
      }
      if (url.endsWith('/intent/conversation/focus')) {
        return jsonResponse({ conversationId: 'conv-1', focused: true });
      }
      if (url.endsWith('/intent/conversation/stream')) {
        return sseResponse([
          'event: connected\ndata: {"conversationId":"conv-1","turnStatus":"idle"}\n\n',
        ]);
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    const client = createClient(fetchMock);
    await client.createConversation({ intent: 'chat', userText: 'hello' });
    await client.sendMessage({ conversationId: 'conv-1', text: 'hello again' });
    const history = await client.getHistory({ conversationId: 'conv-1' });
    expect(history.messages).toEqual([
      {
        id: 'msg-2',
        role: 'assistant',
        text: 'hello',
        createdAt: 123,
        turnId: 'turn-2',
      },
    ]);
    await client.focusInRebel({ conversationId: 'conv-1' });

    const streamClosed = vi.fn();
    client.connectStream(
      { conversationId: 'conv-1' },
      {
        onEvent: () => undefined,
        onError: () => undefined,
        onClose: streamClosed,
      },
    );

    await vi.waitFor(() => expect(streamClosed).toHaveBeenCalledWith('eof'));

    expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual([
      route('/intent/conversation/create'),
      route('/intent/conversation/message'),
      route('/intent/conversation/history'),
      route('/intent/conversation/focus'),
      route('/intent/conversation/stream'),
    ]);
  });

  it('2) applies surface-specific headers + X-Rebel-Diag-Id correlation', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse({
        conversationId: 'conv-1',
        messageId: 'msg-1',
        state: 'submitted',
        queueSize: 0,
      }),
    );
    const { events, sink } = createDiagnosticsCollector();
    const client = createClient(fetchMock, sink);

    await client.sendMessage({ conversationId: 'conv-1', text: 'header test' });

    const init = fetchMock.mock.calls[0]?.[1];
    const headers = headersToObject(init?.headers);
    const diagHeader = headers['x-rebel-diag-id'];
    const withoutDiag = { ...headers };
    delete withoutDiag['x-rebel-diag-id'];

    expect(withoutDiag).toEqual(adapterCase.expectedHeaders);
    expect(diagHeader).toMatch(UUID_RE);

    const fetchStart = events.find((event) => event.kind === 'fetch.start');
    expect(fetchStart?.requestId).toBe(diagHeader);
  });

  it('2b) emits focusInRebel diagnostics with the same requestId as X-Rebel-Diag-Id', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse({
        conversationId: 'conv-1',
        focused: true,
      }),
    );
    const { events, sink } = createDiagnosticsCollector();
    const client = createClient(fetchMock, sink);

    await client.focusInRebel({ conversationId: 'conv-1' });

    const init = fetchMock.mock.calls[0]?.[1];
    const headers = headersToObject(init?.headers);
    const diagHeader = headers['x-rebel-diag-id'];
    expect(diagHeader).toMatch(UUID_RE);
    expect(events.map((event) => event.kind)).toEqual([
      'fetch.start',
      'fetch.response',
    ]);
    expect(events.every((event) => event.requestId === diagHeader)).toBe(true);
    expect(
      events.every(
        (event) => 'op' in event && event.op === 'focusInRebel',
      ),
    ).toBe(true);
  });

  it('3) stamps body only for extension-like transport', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse({
        conversationId: 'conv-1',
        messageId: 'msg-1',
        state: 'submitted',
        queueSize: 0,
      }),
    );
    const client = createClient(fetchMock);

    await client.sendMessage({ conversationId: 'conv-1', text: 'stamp me' });

    const init = fetchMock.mock.calls[0]?.[1];
    const parsedBody = parseJsonBody(init?.body);

    expect(parsedBody).toMatchObject({
      conversationId: 'conv-1',
      text: 'stamp me',
    });
    if (adapterCase.expectsStampedBody) {
      expect(parsedBody).toMatchObject({
        appId: 'browser-extension',
        clientId: 'cid-ext',
      });
    } else {
      expect(parsedBody).not.toHaveProperty('appId');
      expect(parsedBody).not.toHaveProperty('clientId');
    }
  });

  it('4) maps response + fetch failures through sendMessage (error matrix)', async () => {
    const statusMatrix: Array<[number, string, string]> = [
      [400, 'BAD_REQUEST', '{"error":"bad req"}'],
      [401, 'UNAUTHORIZED', '{"message":"bad auth"}'],
      [403, 'FORBIDDEN', '{"message":"forbidden"}'],
      [404, 'NOT_FOUND', '{"message":"missing"}'],
      [410, 'GONE', '{"message":"gone"}'],
      [501, 'UNSUPPORTED', '{"message":"unsupported"}'],
      [503, 'BRIDGE_UNAVAILABLE', '{"message":"bridge down"}'],
      [500, 'BRIDGE_ERROR', '{"message":"server crash"}'],
      [502, 'BRIDGE_ERROR', '{"message":"bad gateway"}'],
      [504, 'BRIDGE_ERROR', '{"message":"timeout"}'],
      [418, 'UNKNOWN', '{"message":"teapot"}'],
    ];

    for (const [status, expectedCode, body] of statusMatrix) {
      const client = createClient(
        vi.fn<typeof fetch>(async () => new Response(body, { status })),
      );
      await expect(
        client.sendMessage({ conversationId: 'conv-1', text: `status-${status}` }),
      ).rejects.toMatchObject({ code: expectedCode, status });
    }

    const networkClient = createClient(
      vi.fn<typeof fetch>(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );
    await expect(
      networkClient.sendMessage({ conversationId: 'conv-1', text: 'network' }),
    ).rejects.toMatchObject({ code: 'NETWORK_ERROR' });

    const timeoutClient = createClient(
      vi.fn<typeof fetch>(async () => {
        throw new DOMException('Timeout', 'TimeoutError');
      }),
    );
    await expect(
      timeoutClient.sendMessage({ conversationId: 'conv-1', text: 'timeout' }),
    ).rejects.toMatchObject({ code: 'TIMEOUT' });

    const abortClient = createClient(
      vi.fn<typeof fetch>(async () => {
        throw new DOMException('aborted', 'AbortError');
      }),
    );
    await expect(
      abortClient.sendMessage({ conversationId: 'conv-1', text: 'abort' }),
    ).rejects.toMatchObject({ code: 'ABORTED', name: 'AbortError' });
  });

  it('5) maps stream-open non-2xx to onError + stream.close(reason=error)', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      new Response('{"message":"nope"}', { status: 401 }),
    );
    const { events, sink } = createDiagnosticsCollector();
    const onError = vi.fn<(error: ConnectStreamError) => void>();
    const onClose = vi.fn<(reason: 'eof' | 'aborted' | 'error' | 'revoked') => void>();

    const client = createClient(fetchMock, sink);
    client.connectStream(
      { conversationId: 'conv-1' },
      {
        onEvent: () => undefined,
        onError,
        onClose,
      },
    );

    await vi.waitFor(() => expect(onClose).toHaveBeenCalledWith('error'));

    const firstError = onError.mock.calls[0]?.[0];
    expect(isResponseError(firstError)).toBe(true);
    expect((firstError as ResponseError).code).toBe('UNAUTHORIZED');
    expect(
      events.some(
        (event) =>
          event.kind === 'stream.close' && event.requestId && event.reason === 'error',
      ),
    ).toBe(true);
  });

  it('6) maps reader.read rejection to shape + stream.close(reason=error)', async () => {
    const streamError = new TypeError('reader exploded');
    const fetchMock = vi.fn<typeof fetch>(async () =>
      sseResponse(
        ['event: connected\ndata: {"conversationId":"conv-1","turnStatus":"idle"}\n\n'],
        streamError,
      ),
    );
    const { events, sink } = createDiagnosticsCollector();
    const onError = vi.fn<(error: ConnectStreamError) => void>();
    const onClose = vi.fn<(reason: 'eof' | 'aborted' | 'error' | 'revoked') => void>();

    const client = createClient(fetchMock, sink);
    client.connectStream(
      { conversationId: 'conv-1' },
      {
        onEvent: () => undefined,
        onError,
        onClose,
      },
    );

    await vi.waitFor(() => expect(onClose).toHaveBeenCalledWith('error'));

    const firstError = onError.mock.calls[0]?.[0] as FetchExceptionShape;
    expect(firstError).toMatchObject({
      errName: 'TypeError',
      isTypeError: true,
      isAbortError: false,
    });
    expect(
      events.some(
        (event) => event.kind === 'stream.close' && event.reason === 'error',
      ),
    ).toBe(true);
  });

  it('7) parses split SSE frames across reader chunks', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      sseResponse([
        'event: turn_started\ndata: {"turnId":"turn-1"}\n',
        '\nevent: assistant_done\ndata: {"turnId":"turn-1"}\n\n',
      ]),
    );
    const onEvent = vi.fn<(event: ConnectStreamEvent) => void>();
    const onClose = vi.fn<(reason: 'eof' | 'aborted' | 'error' | 'revoked') => void>();
    const client = createClient(fetchMock);

    client.connectStream(
      { conversationId: 'conv-1' },
      {
        onEvent,
        onError: () => undefined,
        onClose,
      },
    );

    await vi.waitFor(() => expect(onClose).toHaveBeenCalledWith('eof'));
    expect(onEvent.mock.calls.map(([event]) => event.type)).toEqual([
      'turn_started',
      'assistant_done',
    ]);
  });

  it("8) propagates revoked event as onEvent + onClose('revoked')", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      sseResponse(['event: revoked\ndata: {"reason":"token_revoked"}\n\n']),
    );
    const { events, sink } = createDiagnosticsCollector();
    const onEvent = vi.fn<(event: ConnectStreamEvent) => void>();
    const onClose = vi.fn<(reason: 'eof' | 'aborted' | 'error' | 'revoked') => void>();
    const client = createClient(fetchMock, sink);

    client.connectStream(
      { conversationId: 'conv-1' },
      {
        onEvent,
        onError: () => undefined,
        onClose,
      },
    );

    await vi.waitFor(() => expect(onClose).toHaveBeenCalledWith('revoked'));
    expect(onEvent).toHaveBeenCalledWith({ type: 'revoked' });
    expect(
      events.some(
        (event) => event.kind === 'stream.close' && event.reason === 'revoked',
      ),
    ).toBe(true);
  });

  it('9) preserves capture-before-collapse ordering (fetch.threw before rejection)', async () => {
    const { events, sink } = createDiagnosticsCollector();
    const fetchMock = vi.fn<typeof fetch>(async () => {
      throw new TypeError('network down');
    });
    const client = createClient(fetchMock, sink);

    let eventsAtRejection: DiagnosticEvent[] = [];
    await expect(
      client
        .sendMessage({ conversationId: 'conv-1', text: 'boom' })
        .catch((error) => {
          eventsAtRejection = [...events];
          throw error;
        }),
    ).rejects.toMatchObject({ code: 'NETWORK_ERROR' });

    expect(eventsAtRejection.map((event) => event.kind)).toEqual([
      'fetch.start',
      'fetch.threw',
    ]);
    const threw = eventsAtRejection[1];
    expect(threw?.kind).toBe('fetch.threw');
    if (threw?.kind === 'fetch.threw') {
      expect(threw.shape.isTypeError).toBe(true);
    }
  });

  it('10) composes AbortSignal and rejects with AbortError while preserving shape diagnostics', async () => {
    const { events, sink } = createDiagnosticsCollector();
    const fetchMock = vi.fn<typeof fetch>((_input, init) => {
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) {
          reject(new Error('missing signal'));
          return;
        }
        if (signal.aborted) {
          reject(new DOMException('aborted early', 'AbortError'));
          return;
        }
        signal.addEventListener(
          'abort',
          () => reject(new DOMException('aborted', 'AbortError')),
          { once: true },
        );
      });
    });
    const client = createClient(fetchMock, sink);
    const controller = new AbortController();

    let eventsAtRejection: DiagnosticEvent[] = [];
    const pending = client
      .sendMessage({ conversationId: 'conv-1', text: 'abort me' }, controller.signal)
      .catch((error) => {
        eventsAtRejection = [...events];
        throw error;
      });

    controller.abort();

    await expect(pending).rejects.toMatchObject({
      code: 'ABORTED',
      name: 'AbortError',
    });

    const threw = eventsAtRejection.find(
      (event) => event.kind === 'fetch.threw',
    ) as Extract<DiagnosticEvent, { kind: 'fetch.threw' }> | undefined;
    expect(threw).toBeDefined();
    expect(threw?.shape.isAbortError).toBe(true);
    expect(eventsAtRejection.map((event) => event.kind)).toEqual([
      'fetch.start',
      'fetch.threw',
    ]);
  });

  it('11) isolates chat path from synchronous throws and async sink rejections (F31)', async () => {
    const successFetch = vi.fn<typeof fetch>(async () =>
      jsonResponse({
        conversationId: 'conv-1',
        messageId: 'msg-1',
        state: 'submitted',
        queueSize: 0,
      }),
    );

    const syncThrowSink: DiagnosticSink = {
      emit: () => {
        throw new Error('sync sink failure');
      },
    };
    const syncClient = createClient(successFetch, syncThrowSink);
    await expect(
      syncClient.sendMessage({ conversationId: 'conv-1', text: 'sync sink' }),
    ).resolves.toMatchObject({ messageId: 'msg-1' });

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      const asyncRejectSink: DiagnosticSink = {
        emit: () => Promise.reject(new Error('async sink failure')),
      };
      const asyncClient = createClient(successFetch, asyncRejectSink);

      await expect(
        asyncClient.sendMessage({ conversationId: 'conv-1', text: 'async sink' }),
      ).resolves.toMatchObject({ messageId: 'msg-1' });

      await flushMicrotasks();
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('12) correlates X-Rebel-Diag-Id header with fetch.start requestId', async () => {
    const { events, sink } = createDiagnosticsCollector();
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse({ conversationId: 'conv-1', state: 'new' }),
    );
    const client = createClient(fetchMock, sink);

    await client.createConversation({ intent: 'chat', userText: 'corr' });

    const init = fetchMock.mock.calls[0]?.[1];
    const headers = headersToObject(init?.headers);
    const diagId = headers['x-rebel-diag-id'];
    expect(diagId).toMatch(UUID_RE);

    const fetchStart = events.find(
      (event) => event.kind === 'fetch.start' && event.op === 'createConversation',
    );
    expect(fetchStart?.requestId).toBe(diagId);
  });
});

function headersToObject(headersInit: HeadersInit | undefined): Record<string, string> {
  if (!headersInit) return {};
  const headers = new Headers(headersInit);
  const result: Record<string, string> = {};
  for (const [key, value] of headers.entries()) {
    result[key.toLowerCase()] = value;
  }
  return result;
}

function parseJsonBody(body: BodyInit | null | undefined): Record<string, unknown> {
  if (typeof body !== 'string') {
    throw new Error('Expected JSON string body.');
  }
  return JSON.parse(body) as Record<string, unknown>;
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function sseResponse(chunks: string[], errorAfterChunks?: unknown): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(ENCODER.encode(chunk));
      }
      if (errorAfterChunks !== undefined) {
        controller.error(errorAfterChunks);
        return;
      }
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}
