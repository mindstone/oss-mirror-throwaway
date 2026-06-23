import { describe, expect, it, vi } from 'vitest';
import { createChatController } from '../controller';
import type {
  ConnectStreamError,
  ConnectStreamEvent,
  ConnectStreamHandlers,
  IntentClient,
} from '../../intentClient';
import { createInMemoryChatStatePersistence } from '../../intentClient/persistence';

interface ClientHarness {
  client: IntentClient;
  connectHandlers: ConnectStreamHandlers[];
  createConversation: ReturnType<typeof vi.fn>;
  sendMessage: ReturnType<typeof vi.fn>;
  getHistory: ReturnType<typeof vi.fn>;
  focusInRebel: ReturnType<typeof vi.fn>;
}

function createClientHarness(): ClientHarness {
  const connectHandlers: ConnectStreamHandlers[] = [];
  const createConversation = vi.fn(async () => ({
    conversationId: 'conv-1',
    state: 'new' as const,
  }));
  const sendMessage = vi.fn(async () => ({
    conversationId: 'conv-1',
    messageId: 'msg-1',
    state: 'submitted' as const,
    queueSize: 0,
  }));
  const getHistory = vi.fn(async () => ({
    conversationId: 'conv-1',
    messages: [],
    turnStatus: 'idle' as const,
  }));
  const focusInRebel = vi.fn(async () => ({
    conversationId: 'conv-1',
    focused: true,
  }));

  return {
    connectHandlers,
    createConversation,
    sendMessage,
    getHistory,
    focusInRebel,
    client: {
      createConversation,
      sendMessage,
      getHistory,
      focusInRebel,
      connectStream: (_input, handlers) => {
        connectHandlers.push(handlers);
        return {
          close: vi.fn(),
        };
      },
    },
  };
}

function emitEvent(harness: ClientHarness, event: ConnectStreamEvent, index = 0): void {
  harness.connectHandlers[index]?.onEvent(event);
}

function emitError(harness: ClientHarness, error: ConnectStreamError, index = 0): void {
  harness.connectHandlers[index]?.onError(error);
}

function emitClose(
  harness: ClientHarness,
  reason: 'eof' | 'aborted' | 'error' | 'revoked',
  index = 0,
): void {
  harness.connectHandlers[index]?.onClose(reason);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('createChatController', () => {
  it('hydrates persisted conversations and opens the shared stream', async () => {
    const persistence = createInMemoryChatStatePersistence({
      conversationId: 'conv-1',
      pageTitle: 'Example',
      pageUrl: 'https://example.com',
    });
    const harness = createClientHarness();
    harness.getHistory.mockResolvedValueOnce({
      conversationId: 'conv-1',
      messages: [{ id: 'm1', role: 'user', text: 'hello', createdAt: 1 }],
      turnStatus: 'running',
    });

    const controller = createChatController({
      client: harness.client,
      persistence,
    });

    await vi.waitFor(() => {
      expect(controller.getSnapshot().conversationId).toBe('conv-1');
      expect(controller.getSnapshot().messages).toHaveLength(1);
      expect(harness.connectHandlers).toHaveLength(1);
    });

    expect(controller.getSnapshot().conversationContext).toEqual({
      pageTitle: 'Example',
      pageUrl: 'https://example.com',
    });
  });

  it('creates a conversation on first send and streams assistant deltas through the shared controller', async () => {
    const persistence = createInMemoryChatStatePersistence();
    const harness = createClientHarness();
    const controller = createChatController({
      client: harness.client,
      persistence,
      context: {
        captureContext: async () => ({
          tabContext: {
            url: 'https://example.com',
            title: 'Example',
          },
          pageContext: {
            url: 'https://example.com',
            title: 'Example',
          },
        }),
      },
    });

    await vi.waitFor(() => {
      expect(controller.getSnapshot().phase).toBe('idle');
    });

    await controller.send('hello');

    expect(harness.createConversation).toHaveBeenCalledWith(
      expect.objectContaining({
        intent: 'chat',
        userText: 'hello',
        switchToConversation: false,
      }),
      expect.any(AbortSignal),
    );
    expect(controller.getSnapshot().conversationId).toBe('conv-1');
    expect(controller.getSnapshot().messages[0]).toMatchObject({
      role: 'user',
      text: 'hello',
    });

    emitEvent(harness, {
      type: 'connected',
      conversationId: 'conv-1',
      turnStatus: 'running',
    });
    emitEvent(harness, { type: 'turn_started', turnId: 'turn-1' });
    emitEvent(harness, { type: 'assistant_delta', turnId: 'turn-1', text: 'hi' });

    expect(controller.getStreamingText()).toBe('hi');
    expect(controller.getSnapshot().phase).toBe('streaming');

    emitEvent(harness, { type: 'assistant_done', turnId: 'turn-1' });
    emitEvent(harness, {
      type: 'message_added',
      message: { id: 'assistant-1', role: 'assistant', text: 'hi', createdAt: 2 },
    });

    expect(controller.getStreamingText()).toBe('');
    expect(controller.getSnapshot().turnStatus).toBe('idle');
    expect(controller.getSnapshot().messages.at(-1)).toEqual({
      id: 'assistant-1',
      role: 'assistant',
      text: 'hi',
      createdAt: 2,
    });

    expect(await persistence.get()).toEqual({
      conversationId: 'conv-1',
      createdAt: expect.any(Number),
      pageTitle: 'Example',
      pageUrl: 'https://example.com',
    });
  });

  it('allows document-only context to create an Office conversation', async () => {
    const persistence = createInMemoryChatStatePersistence();
    const harness = createClientHarness();
    const controller = createChatController({
      client: harness.client,
      persistence,
      context: {
        captureContext: async () => ({
          documentContext: {
            host: 'word',
            title: 'Quarterly Plan.docx',
          },
        }),
      },
      missingContextMessage: 'Open a document, then try again.',
    });

    await vi.waitFor(() => {
      expect(controller.getSnapshot().phase).toBe('idle');
    });

    await controller.send('summarise this');

    expect(harness.createConversation).toHaveBeenCalledWith(
      expect.objectContaining({
        intent: 'chat',
        userText: 'summarise this',
        documentContext: {
          host: 'word',
          title: 'Quarterly Plan.docx',
        },
      }),
      expect.any(AbortSignal),
    );
    expect(controller.getSnapshot().conversationId).toBe('conv-1');
  });

  it('retries history for a newly-created conversation before treating NOT_FOUND as cleared', async () => {
    vi.useFakeTimers();
    try {
      const persistence = createInMemoryChatStatePersistence();
      const harness = createClientHarness();
      harness.getHistory
        .mockRejectedValueOnce(Object.assign(new Error('missing'), { code: 'NOT_FOUND' }))
        .mockResolvedValueOnce({
          conversationId: 'conv-1',
          messages: [{ id: 'm1', role: 'user', text: 'hello', createdAt: 1 }],
          turnStatus: 'idle' as const,
        });
      const controller = createChatController({
        client: harness.client,
        persistence,
        context: {
          captureContext: () => ({
            tabContext: { url: 'https://example.com', title: 'Example' },
            pageContext: { url: 'https://example.com', title: 'Example' },
          }),
        },
      });

      await vi.waitFor(() => {
        expect(controller.getSnapshot().phase).toBe('idle');
      });

      const sendPromise = controller.send('hello');
      await vi.waitFor(() => {
        expect(harness.getHistory).toHaveBeenCalledTimes(1);
      });
      await vi.advanceTimersByTimeAsync(50);
      await sendPromise;

      expect(harness.getHistory).toHaveBeenCalledTimes(2);
      expect(controller.getSnapshot()).toMatchObject({
        phase: 'idle',
        conversationId: 'conv-1',
        error: null,
      });
      expect(controller.getSnapshot().messages).toContainEqual({
        id: 'm1',
        role: 'user',
        text: 'hello',
        createdAt: 1,
      });
      expect(await persistence.get()).toMatchObject({ conversationId: 'conv-1' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('enforces single-flight sends with BUSY while the shared controller is still streaming', async () => {
    const harness = createClientHarness();
    const controller = createChatController({
      client: harness.client,
      context: {
        captureContext: () => ({
          tabContext: { url: 'https://example.com', title: 'Example' },
          pageContext: { url: 'https://example.com', title: 'Example' },
        }),
      },
    });

    await vi.waitFor(() => {
      expect(controller.getSnapshot().phase).toBe('idle');
    });

    await controller.send('first');
    emitEvent(harness, {
      type: 'connected',
      conversationId: 'conv-1',
      turnStatus: 'running',
    });
    emitEvent(harness, { type: 'turn_started', turnId: 'turn-1' });

    await expect(controller.send('second')).rejects.toMatchObject({ code: 'BUSY' });
  });

  it('moves retryable failures offline when reachability probes fail', async () => {
    const harness = createClientHarness();
    const controller = createChatController({
      client: harness.client,
      transport: {
        probeReachability: vi.fn(async () => false),
      },
      context: {
        captureContext: () => ({
          tabContext: { url: 'https://example.com', title: 'Example' },
          pageContext: { url: 'https://example.com', title: 'Example' },
        }),
      },
    });

    await vi.waitFor(() => {
      expect(controller.getSnapshot().phase).toBe('idle');
    });

    await controller.send('first');
    emitEvent(harness, {
      type: 'connected',
      conversationId: 'conv-1',
      turnStatus: 'idle',
    });
    emitEvent(harness, { type: 'assistant_done', turnId: 'turn-1' });

    harness.sendMessage.mockRejectedValueOnce(
      Object.assign(new Error('offline'), { code: 'NETWORK_ERROR' }),
    );

    await controller.send('retry me');

    expect(controller.getSnapshot().phase).toBe('offline');
    expect(controller.getSnapshot().retryableSend).toBe('retry me');
  });

  it('surfaces revoked state when the shared stream emits revoked', async () => {
    const harness = createClientHarness();
    const controller = createChatController({
      client: harness.client,
      context: {
        captureContext: () => ({
          tabContext: { url: 'https://example.com', title: 'Example' },
          pageContext: { url: 'https://example.com', title: 'Example' },
        }),
      },
    });

    await vi.waitFor(() => {
      expect(controller.getSnapshot().phase).toBe('idle');
    });

    await controller.send('hello');
    emitEvent(harness, {
      type: 'connected',
      conversationId: 'conv-1',
      turnStatus: 'running',
    });
    emitEvent(harness, { type: 'revoked' });

    expect(controller.getSnapshot().phase).toBe('revoked');
    expect(controller.getSnapshot().error?.code).toBe('UNAUTHORIZED');
  });

  it('startFresh clears persisted state after the migrated controller creates a conversation', async () => {
    const harness = createClientHarness();
    const persistence = createInMemoryChatStatePersistence();
    const controller = createChatController({
      client: harness.client,
      persistence,
      context: {
        captureContext: () => ({
          tabContext: { url: 'https://example.com', title: 'Example' },
          pageContext: { url: 'https://example.com', title: 'Example' },
        }),
      },
    });

    await vi.waitFor(() => {
      expect(controller.getSnapshot().phase).toBe('idle');
    });

    await controller.send('hello');
    await controller.startFresh();

    expect(controller.getSnapshot()).toMatchObject({
      phase: 'idle',
      conversationId: null,
      messages: [],
    });
    expect(await persistence.get()).toBeNull();
  });

  it('ignores stale reconnect recoveries that finish after startFresh', async () => {
    vi.useFakeTimers();
    try {
      const reconnectHistory = deferred<{
        conversationId: string;
        messages: Array<{ id: string; role: 'assistant'; text: string; createdAt: number; turnId: string }>;
        turnStatus: 'idle';
      }>();
      const harness = createClientHarness();
      harness.getHistory
        .mockResolvedValueOnce({
          conversationId: 'conv-1',
          messages: [],
          turnStatus: 'idle' as const,
        })
        .mockImplementationOnce(async () => await reconnectHistory.promise);

      const controller = createChatController({
        client: harness.client,
        persistence: createInMemoryChatStatePersistence({
          conversationId: 'conv-1',
        }),
      });

      await vi.waitFor(() => {
        expect(harness.connectHandlers).toHaveLength(1);
      });

      emitError(harness, {
        errName: 'TypeError',
        errMsg: 'reader exploded',
        errConstructor: 'TypeError',
        isTypeError: true,
        isDOMException: false,
        isAbortError: false,
      });

      await vi.waitFor(() => {
        expect(controller.getSnapshot().phase).toBe('reconnecting');
      });

      await vi.advanceTimersByTimeAsync(1_000);

      await vi.waitFor(() => {
        expect(harness.getHistory).toHaveBeenCalledTimes(2);
      });

      await controller.startFresh();

      expect(controller.getSnapshot()).toMatchObject({
        phase: 'idle',
        conversationId: null,
        messages: [],
      });

      reconnectHistory.resolve({
        conversationId: 'conv-1',
        messages: [
          {
            id: 'assistant-stale',
            role: 'assistant',
            text: 'This should stay gone',
            createdAt: 3,
            turnId: 'turn-stale',
          },
        ],
        turnStatus: 'idle',
      });

      await Promise.resolve();
      await Promise.resolve();

      expect(controller.getSnapshot()).toMatchObject({
        phase: 'idle',
        conversationId: null,
        messages: [],
      });
      expect(harness.connectHandlers).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('only reconciles a final assistant reply with the matching turn placeholder', async () => {
    const harness = createClientHarness();
    const controller = createChatController({
      client: harness.client,
      persistence: createInMemoryChatStatePersistence({
        conversationId: 'conv-1',
      }),
      context: {
        captureContext: () => ({
          tabContext: { url: 'https://example.com', title: 'Example' },
          pageContext: { url: 'https://example.com', title: 'Example' },
        }),
      },
    });

    await vi.waitFor(() => {
      expect(harness.connectHandlers).toHaveLength(1);
      expect(controller.getSnapshot().phase).toBe('idle');
    });

    emitEvent(harness, {
      type: 'connected',
      conversationId: 'conv-1',
      turnStatus: 'running',
    });
    emitEvent(harness, { type: 'turn_started', turnId: 'turn-a' });
    emitEvent(harness, { type: 'assistant_delta', turnId: 'turn-a', text: 'Partial A' });
    emitEvent(harness, {
      type: 'turn_error',
      turnId: 'turn-a',
      error: 'stream broke',
    });

    await controller.send('second turn');

    emitEvent(harness, { type: 'turn_started', turnId: 'turn-b' });
    emitEvent(harness, { type: 'assistant_delta', turnId: 'turn-b', text: 'Draft B' });
    emitEvent(harness, { type: 'assistant_done', turnId: 'turn-b' });
    emitEvent(harness, {
      type: 'message_added',
      message: {
        id: 'assistant-b',
        role: 'assistant',
        text: 'Final B',
        createdAt: 5,
        turnId: 'turn-b',
      },
    });

    expect(controller.getSnapshot().messages.filter((message) => message.role === 'assistant')).toEqual([
      {
        id: 'stream-turn-a',
        role: 'assistant',
        text: 'Partial A',
        createdAt: expect.any(Number),
        partial: true,
        turnId: 'turn-a',
      },
      {
        id: 'assistant-b',
        role: 'assistant',
        text: 'Final B',
        createdAt: 5,
        turnId: 'turn-b',
      },
    ]);
  });

  it('dedupes retryable stream failures into a single reconnect decision', async () => {
    vi.useFakeTimers();
    try {
      const harness = createClientHarness();
      const probeReachability = vi.fn(async () => true);
      const controller = createChatController({
        client: harness.client,
        transport: {
          probeReachability,
        },
        persistence: createInMemoryChatStatePersistence({
          conversationId: 'conv-1',
        }),
      });

      await vi.waitFor(() => {
        expect(harness.connectHandlers).toHaveLength(1);
      });

      emitEvent(harness, {
        type: 'connected',
        conversationId: 'conv-1',
        turnStatus: 'running',
      });
      emitEvent(harness, { type: 'turn_started', turnId: 'turn-1' });
      emitEvent(harness, { type: 'assistant_delta', turnId: 'turn-1', text: 'hel' });
      emitError(harness, {
        errName: 'TypeError',
        errMsg: 'reader exploded',
        errConstructor: 'TypeError',
        isTypeError: true,
        isDOMException: false,
        isAbortError: false,
      });
      emitClose(harness, 'error');

      await vi.waitFor(() => {
        expect(controller.getSnapshot().phase).toBe('reconnecting');
        expect(controller.getSnapshot().reconnectAttempt).toBe(1);
      });

      expect(probeReachability).toHaveBeenCalledTimes(1);
      expect(controller.getSnapshot().messages.at(-1)).toBeUndefined();
      expect(controller.getStreamingText()).toBe('hel');

      await vi.advanceTimersByTimeAsync(1_000);

      await vi.waitFor(() => {
        expect(harness.getHistory).toHaveBeenCalledTimes(2);
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not schedule reconnect twice for non-retryable stream-open failures', async () => {
    vi.useFakeTimers();
    try {
      const harness = createClientHarness();
      const probeReachability = vi.fn(async () => true);
      const controller = createChatController({
        client: harness.client,
        transport: {
          probeReachability,
        },
        persistence: createInMemoryChatStatePersistence({
          conversationId: 'conv-1',
        }),
      });

      await vi.waitFor(() => {
        expect(harness.connectHandlers).toHaveLength(1);
      });

      emitError(
        harness,
        {
          code: 'UNAUTHORIZED',
          message: 'pair again',
          status: 401,
        },
        0,
      );
      emitClose(harness, 'error');

      await vi.waitFor(() => {
        expect(controller.getSnapshot().phase).toBe('revoked');
        expect(controller.getSnapshot().error?.message).toBe('pair again');
      });

      await vi.runAllTimersAsync();

      expect(probeReachability).not.toHaveBeenCalled();
      expect(harness.getHistory).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('snapshots partial assistant text before going offline after a stream failure', async () => {
    const harness = createClientHarness();
    const controller = createChatController({
      client: harness.client,
      transport: {
        probeReachability: vi.fn(async () => false),
      },
      context: {
        captureContext: () => ({
          tabContext: { url: 'https://example.com', title: 'Example' },
          pageContext: { url: 'https://example.com', title: 'Example' },
        }),
      },
    });

    await vi.waitFor(() => {
      expect(controller.getSnapshot().phase).toBe('idle');
    });

    await controller.send('hello');
    emitEvent(harness, {
      type: 'connected',
      conversationId: 'conv-1',
      turnStatus: 'running',
    });
    emitEvent(harness, { type: 'turn_started', turnId: 'turn-1' });
    emitEvent(harness, { type: 'assistant_delta', turnId: 'turn-1', text: 'Half a thought' });
    emitError(harness, {
      errName: 'TypeError',
      errMsg: 'reader exploded',
      errConstructor: 'TypeError',
      isTypeError: true,
      isDOMException: false,
      isAbortError: false,
    });
    emitClose(harness, 'error');

    await vi.waitFor(() => {
      expect(controller.getSnapshot().phase).toBe('offline');
      expect(controller.getStreamingText()).toBe('');
    });

    expect(controller.getSnapshot().messages.at(-1)).toEqual({
      id: 'stream-turn-1',
      role: 'assistant',
      text: 'Half a thought',
      createdAt: expect.any(Number),
      partial: true,
      turnId: 'turn-1',
    });
  });

  it('does not let openInRebel abort an in-flight send', async () => {
    const sendDeferred = deferred<{
      conversationId: string;
      messageId: string;
      state: 'submitted';
      queueSize: number;
    }>();
    let observedSignal: AbortSignal | undefined;
    const harness = createClientHarness();
    harness.sendMessage.mockImplementationOnce(async (_input, signal) => {
      observedSignal = signal;
      return await sendDeferred.promise;
    });
    const controller = createChatController({
      client: harness.client,
      persistence: createInMemoryChatStatePersistence({
        conversationId: 'conv-1',
      }),
      context: {
        captureContext: () => ({
          tabContext: { url: 'https://example.com', title: 'Example' },
          pageContext: { url: 'https://example.com', title: 'Example' },
        }),
      },
    });

    await vi.waitFor(() => {
      expect(controller.getSnapshot().phase).toBe('idle');
      expect(harness.connectHandlers).toHaveLength(1);
    });

    const pendingSend = controller.send('keep going');
    await vi.waitFor(() => {
      expect(harness.sendMessage).toHaveBeenCalledTimes(1);
      expect(controller.getSnapshot().phase).toBe('sending');
    });

    await controller.openInRebel();

    expect(harness.focusInRebel).toHaveBeenCalledWith(
      { conversationId: 'conv-1' },
      expect.any(AbortSignal),
    );
    expect(observedSignal?.aborted).toBe(false);

    sendDeferred.resolve({
      conversationId: 'conv-1',
      messageId: 'msg-1',
      state: 'submitted',
      queueSize: 0,
    });
    await pendingSend;
    emitEvent(harness, {
      type: 'connected',
      conversationId: 'conv-1',
      turnStatus: 'idle',
    }, 0);

    await vi.waitFor(() => {
      expect(controller.getSnapshot().phase).toBe('idle');
    });
  });
});
