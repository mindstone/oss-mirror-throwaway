// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, flushAsync } from '@renderer/test-utils';
import {
  attachRequeueMessageId,
  createTargetBusyRejectionError,
} from '@shared/utils/agentTurnAdmission';
import {
  useMessageQueue,
  isSummaryBusyForQueueGate,
  supersedePolicyForQueueMode,
  DEFERRED_TARGET_RETRY_FALLBACK_MS,
} from '../useMessageQueue';
import { STALE_TURN_THRESHOLD_MS } from '../../utils/runtimeState';

vi.mock('@renderer/utils/stringUtils', () => {
  let counter = 0;
  return {
    createId: () => `test-id-${++counter}`,
  };
});

type HookOptions = Parameters<typeof useMessageQueue>[0];

function createMockOptions(overrides: Partial<HookOptions> = {}): HookOptions {
  return {
    isBusy: false,
    isStopping: false,
    currentSessionId: 'session-1',
    stopActiveTurn: vi.fn().mockResolvedValue(undefined),
    processMessage: vi.fn().mockResolvedValue(undefined),
    rerunEditedMessage: vi.fn().mockResolvedValue(undefined),
    isSessionBusy: vi.fn().mockReturnValue(false),
    emitLog: vi.fn(),
    showToast: vi.fn(),
    ...overrides,
  };
}

describe('useMessageQueue', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('idle dispatch', () => {
    it('processes message immediately when not busy', async () => {
      const opts = createMockOptions();
      const { result, unmount } = renderHook(() => useMessageQueue(opts));

      await act(async () => {
        await result.current.handleUserMessage('hello', 'text');
      });

      expect(opts.processMessage).toHaveBeenCalledWith(
        'hello',
        'text',
        undefined,
        undefined,
        'session-1',
        expect.objectContaining({ messageOrigin: 'user-typed' }),
      );
      expect(result.current.messageQueue).toHaveLength(0);
      unmount();
    });

    it('passes attachments through on immediate dispatch', async () => {
      const opts = createMockOptions();
      const { result, unmount } = renderHook(() => useMessageQueue(opts));

      const attachments = [{ type: 'file', name: 'test.txt', path: '/tmp/test.txt' }];
      await act(async () => {
        await result.current.handleUserMessage('with file', 'text', attachments as never[]);
      });

      expect(opts.processMessage).toHaveBeenCalledWith(
        'with file',
        'text',
        attachments,
        undefined,
        'session-1',
        expect.objectContaining({ messageOrigin: 'user-typed' }),
      );
      unmount();
    });

    it('calls rerunEditedMessage for edit messages when idle', async () => {
      const opts = createMockOptions();
      const { result, unmount } = renderHook(() => useMessageQueue(opts));

      await act(async () => {
        await result.current.handleUserMessage('edited text', 'text', undefined, {
          editTargetMessageId: 'msg-42',
        });
      });

      expect(opts.rerunEditedMessage).toHaveBeenCalledWith(
        'msg-42',
        'edited text',
        'text',
        undefined,
      );
      expect(opts.processMessage).not.toHaveBeenCalled();
      unmount();
    });
  });

  describe('empty text guard', () => {
    it('ignores empty text', async () => {
      const opts = createMockOptions();
      const { result, unmount } = renderHook(() => useMessageQueue(opts));

      await act(async () => {
        await result.current.handleUserMessage('', 'text');
      });

      expect(opts.processMessage).not.toHaveBeenCalled();
      unmount();
    });

    it('ignores whitespace-only text', async () => {
      const opts = createMockOptions();
      const { result, unmount } = renderHook(() => useMessageQueue(opts));

      await act(async () => {
        await result.current.handleUserMessage('   \n  ', 'text');
      });

      expect(opts.processMessage).not.toHaveBeenCalled();
      unmount();
    });
  });

  describe('queueing when busy', () => {
    it('queues message when agent is busy', async () => {
      const opts = createMockOptions({ isBusy: true });
      const { result, unmount } = renderHook(() => useMessageQueue(opts));

      await act(async () => {
        await result.current.handleUserMessage('queued msg', 'text');
      });

      expect(opts.processMessage).not.toHaveBeenCalled();
      expect(result.current.messageQueue).toHaveLength(1);
      expect(result.current.messageQueue[0].text).toBe('queued msg');
      unmount();
    });

    it('appends to back in default queue mode (FIFO)', async () => {
      const opts = createMockOptions({ isBusy: true });
      const { result, unmount } = renderHook(() => useMessageQueue(opts));

      await act(async () => {
        await result.current.handleUserMessage('first', 'text');
      });
      await act(async () => {
        await result.current.handleUserMessage('second', 'text');
      });

      expect(result.current.messageQueue).toHaveLength(2);
      expect(result.current.messageQueue[0].text).toBe('first');
      expect(result.current.messageQueue[1].text).toBe('second');
      unmount();
    });
  });

  describe('sendNow mode', () => {
    it('inserts at front and calls stopActiveTurn', async () => {
      const opts = createMockOptions({ isBusy: true });
      const { result, unmount } = renderHook(() => useMessageQueue(opts));

      await act(async () => {
        await result.current.handleUserMessage('queued', 'text');
      });
      await act(async () => {
        await result.current.handleUserMessage('urgent', 'text', undefined, {
          queueMode: 'sendNow',
        });
      });

      expect(result.current.messageQueue[0].text).toBe('urgent');
      expect(result.current.messageQueue[1].text).toBe('queued');
      expect(opts.stopActiveTurn).toHaveBeenCalledTimes(1);
      unmount();
    });

    it('edit messages always use sendNow regardless of queueMode option', async () => {
      const opts = createMockOptions({ isBusy: true });
      const { result, unmount } = renderHook(() => useMessageQueue(opts));

      await act(async () => {
        await result.current.handleUserMessage('queued first', 'text');
      });
      await act(async () => {
        await result.current.handleUserMessage('edited', 'text', undefined, {
          editTargetMessageId: 'msg-1',
          queueMode: 'queue',
        });
      });

      expect(result.current.messageQueue[0].text).toBe('edited');
      expect(opts.stopActiveTurn).toHaveBeenCalledTimes(1);
      unmount();
    });

    it('does not call stopActiveTurn when already stopping', async () => {
      const opts = createMockOptions({ isBusy: true, isStopping: true });
      const { result, unmount } = renderHook(() => useMessageQueue(opts));

      await act(async () => {
        await result.current.handleUserMessage('urgent', 'text', undefined, {
          queueMode: 'sendNow',
        });
      });

      expect(result.current.messageQueue).toHaveLength(1);
      expect(opts.stopActiveTurn).not.toHaveBeenCalled();
      unmount();
    });
  });

  describe('cross-session behavior', () => {
    it('queues FIFO without interrupt for different-session messages', async () => {
      // Stage 1 semantic note: the cross-session target must be BUSY for the
      // message to stay queued — an idle target now drains immediately
      // (skip-ahead across targets) instead of waiting on the viewed session.
      const opts = createMockOptions({
        isBusy: true,
        isSessionBusy: (id: string) => id === 'session-2',
      });
      const { result, unmount } = renderHook(() => useMessageQueue(opts));

      await act(async () => {
        await result.current.handleUserMessage('cross-session', 'text', undefined, {
          targetSessionId: 'session-2',
          queueMode: 'sendNow',
        });
      });

      expect(result.current.messageQueue).toHaveLength(1);
      expect(opts.stopActiveTurn).not.toHaveBeenCalled();
      unmount();
    });

    it('captures currentSessionId at enqueue time as default target', async () => {
      const opts = createMockOptions({ isBusy: true, currentSessionId: 'session-A' });
      const { result, unmount } = renderHook(() => useMessageQueue(opts));

      await act(async () => {
        await result.current.handleUserMessage('msg for session A', 'text');
      });

      expect(result.current.messageQueue[0].targetSessionId).toBe('session-A');
      unmount();
    });
  });

  describe('per-target busy gate (Stage 1, docs/plans/260610_queue-drain-cancels-turn)', () => {
    it('does NOT drain a message whose target session is still busy when the user switches to an idle session (incident f6b3e9b0 repro)', async () => {
      const opts = createMockOptions({ isBusy: true, currentSessionId: 'session-A' });
      const { result, rerender, unmount } = renderHook(
        (props: HookOptions) => useMessageQueue(props),
        { initialProps: opts },
      );

      await act(async () => {
        await result.current.handleUserMessage('for busy session A', 'text');
      });

      expect(result.current.messageQueue).toHaveLength(1);
      expect(result.current.messageQueue[0].targetSessionId).toBe('session-A');

      // User switches to an idle session B while session A's turn is still
      // running. The queue must hold the message — draining here is what
      // cancelled session A's in-flight turn in the incident.
      rerender({
        ...opts,
        isBusy: false,
        currentSessionId: 'session-B',
        isSessionBusy: (id: string) => id === 'session-A',
      });
      await flushAsync();

      expect(opts.processMessage).not.toHaveBeenCalled();
      expect(result.current.messageQueue).toHaveLength(1);
      unmount();
    });

    it('enqueues instead of dispatching when the viewed session is idle but the cross-session target is busy', async () => {
      const opts = createMockOptions({
        isBusy: false,
        currentSessionId: 'session-1',
        isSessionBusy: (id: string) => id === 'session-2',
      });
      const { result, unmount } = renderHook(() => useMessageQueue(opts));

      await act(async () => {
        await result.current.handleUserMessage('for busy session 2', 'text', undefined, {
          targetSessionId: 'session-2',
        });
      });

      expect(opts.processMessage).not.toHaveBeenCalled();
      expect(result.current.messageQueue).toHaveLength(1);
      expect(result.current.messageQueue[0].targetSessionId).toBe('session-2');
      unmount();
    });

    it('skips ahead past a busy-target head to dispatch a later idle-target message', async () => {
      const opts = createMockOptions({
        isBusy: true,
        currentSessionId: 'session-1',
        isSessionBusy: (id: string) => id === 'session-2',
      });
      const { result, unmount } = renderHook(() => useMessageQueue(opts));

      await act(async () => {
        await result.current.handleUserMessage('for busy session 2', 'text', undefined, {
          targetSessionId: 'session-2',
        });
      });
      await act(async () => {
        await result.current.handleUserMessage('for idle session 3', 'text', undefined, {
          targetSessionId: 'session-3',
        });
      });
      await flushAsync();

      expect(opts.processMessage).toHaveBeenCalledTimes(1);
      expect(opts.processMessage).toHaveBeenCalledWith(
        'for idle session 3',
        'text',
        undefined,
        undefined,
        'session-3',
        expect.objectContaining({ messageOrigin: 'queue-drain' }),
      );
      expect(result.current.messageQueue).toHaveLength(1);
      expect(result.current.messageQueue[0].text).toBe('for busy session 2');
      unmount();
    });

    it('preserves FIFO per target: same-target messages hold together and dispatch in order on idle', async () => {
      const opts = createMockOptions({
        isBusy: true,
        currentSessionId: 'session-1',
        isSessionBusy: (id: string) => id === 'session-2',
      });
      const { result, rerender, unmount } = renderHook(
        (props: HookOptions) => useMessageQueue(props),
        { initialProps: opts },
      );

      await act(async () => {
        await result.current.handleUserMessage('first for 2', 'text', undefined, {
          targetSessionId: 'session-2',
        });
      });
      await act(async () => {
        await result.current.handleUserMessage('second for 2', 'text', undefined, {
          targetSessionId: 'session-2',
        });
      });
      await flushAsync();

      expect(opts.processMessage).not.toHaveBeenCalled();
      expect(result.current.messageQueue).toHaveLength(2);

      // Target goes idle → head dispatches (one dispatch per busy-information
      // wake-up; in production the dispatched turn's own summary churn
      // produces the next isSessionBusy identity change)
      rerender({ ...opts, isSessionBusy: () => false });
      await flushAsync();

      expect(opts.processMessage).toHaveBeenCalledTimes(1);
      expect(result.current.messageQueue).toHaveLength(1);

      // Next busy-information wake-up (fresh isSessionBusy identity) → second dispatches
      rerender({ ...opts, isSessionBusy: () => false });
      await flushAsync();

      expect(opts.processMessage).toHaveBeenCalledTimes(2);
      expect(vi.mocked(opts.processMessage).mock.calls[0][0]).toBe('first for 2');
      expect(vi.mocked(opts.processMessage).mock.calls[1][0]).toBe('second for 2');
      expect(result.current.messageQueue).toHaveLength(0);
      unmount();
    });
  });

  describe('isSummaryBusyForQueueGate (read-side staleness)', () => {
    it('treats a fresh busy summary as busy', () => {
      const now = Date.now();
      expect(
        isSummaryBusyForQueueGate(
          { isBusy: true, activeTurnId: 'turn-1', lastActivityAt: now - 1_000 },
          now,
        ),
      ).toBe(true);
    });

    it('treats a stuck-busy summary with stale lastActivityAt as NOT busy (message drains)', () => {
      const now = Date.now();
      expect(
        isSummaryBusyForQueueGate(
          { isBusy: true, activeTurnId: 'turn-1', lastActivityAt: now - STALE_TURN_THRESHOLD_MS - 1 },
          now,
        ),
      ).toBe(false);
    });

    it('treats an activeTurnId-only summary as busy', () => {
      const now = Date.now();
      expect(
        isSummaryBusyForQueueGate(
          { isBusy: false, activeTurnId: 'turn-1', lastActivityAt: now - 1_000 },
          now,
        ),
      ).toBe(true);
    });

    it('treats an unknown session (no summary) as not busy', () => {
      expect(isSummaryBusyForQueueGate(undefined)).toBe(false);
    });

    it('treats a busy summary with no lastActivityAt as busy (cannot prove staleness)', () => {
      expect(
        isSummaryBusyForQueueGate({ isBusy: true, activeTurnId: 'turn-1', lastActivityAt: null }),
      ).toBe(true);
    });
  });

  describe('queue drain', () => {
    it('processes queued message when isBusy transitions to false', async () => {
      const opts = createMockOptions({ isBusy: true });
      const { result, rerender, unmount } = renderHook(
        (props: HookOptions) => useMessageQueue(props),
        { initialProps: opts },
      );

      await act(async () => {
        await result.current.handleUserMessage('drain me', 'text');
      });

      expect(result.current.messageQueue).toHaveLength(1);
      expect(opts.processMessage).not.toHaveBeenCalled();

      const idleOpts = { ...opts, isBusy: false };
      rerender(idleOpts);
      await flushAsync();

      expect(opts.processMessage).toHaveBeenCalledTimes(1);
      expect(opts.processMessage).toHaveBeenCalledWith(
        'drain me',
        'text',
        undefined,
        undefined,
        undefined,
        expect.objectContaining({ messageOrigin: 'queue-drain' }),
      );
      expect(result.current.messageQueue).toHaveLength(0);
      unmount();
    });

    // DELIBERATE AMENDMENT (Stage 1, plan 260610_queue-drain-cancels-turn):
    // this test previously codified the incident's buggy behavior — draining
    // on the VIEWED session's idle state regardless of the target session's
    // busy state. It is now split into the two distinct cases: target idle →
    // cross-session delivery preserved; target busy → held until the target
    // goes idle, then delivered.
    it('delivers queued message to original session when user switches before drain (target idle)', async () => {
      const opts = createMockOptions({ isBusy: true, currentSessionId: 'session-A' });
      const { result, rerender, unmount } = renderHook(
        (props: HookOptions) => useMessageQueue(props),
        { initialProps: opts },
      );

      await act(async () => {
        await result.current.handleUserMessage('for session A', 'text');
      });

      expect(result.current.messageQueue[0].targetSessionId).toBe('session-A');

      // Session A's turn has finished (isSessionBusy default mock → false)
      const switchedOpts = { ...opts, isBusy: false, currentSessionId: 'session-B' };
      rerender(switchedOpts);
      await flushAsync();

      expect(opts.processMessage).toHaveBeenCalledWith(
        'for session A',
        'text',
        undefined,
        undefined,
        'session-A',
        expect.objectContaining({ messageOrigin: 'queue-drain' }),
      );
      unmount();
    });

    it('holds queued message while its target session is busy, then delivers when the target goes idle', async () => {
      const opts = createMockOptions({ isBusy: true, currentSessionId: 'session-A' });
      const { result, rerender, unmount } = renderHook(
        (props: HookOptions) => useMessageQueue(props),
        { initialProps: opts },
      );

      await act(async () => {
        await result.current.handleUserMessage('for session A', 'text');
      });

      // Switch to idle session B while session A's turn is still running
      rerender({
        ...opts,
        isBusy: false,
        currentSessionId: 'session-B',
        isSessionBusy: (id: string) => id === 'session-A',
      });
      await flushAsync();

      expect(opts.processMessage).not.toHaveBeenCalled();
      expect(result.current.messageQueue).toHaveLength(1);

      // Session A's turn completes → new isSessionBusy identity reporting idle
      rerender({
        ...opts,
        isBusy: false,
        currentSessionId: 'session-B',
        isSessionBusy: () => false,
      });
      await flushAsync();

      expect(opts.processMessage).toHaveBeenCalledWith(
        'for session A',
        'text',
        undefined,
        undefined,
        'session-A',
        expect.objectContaining({ messageOrigin: 'queue-drain' }),
      );
      expect(result.current.messageQueue).toHaveLength(0);
      unmount();
    });

    it('shows toast and releases lock on processMessage failure during drain', async () => {
      const processMessage = vi.fn().mockRejectedValueOnce(new Error('drain fail'));
      const opts = createMockOptions({ isBusy: true, processMessage });
      const { result, rerender, unmount } = renderHook(
        (props: HookOptions) => useMessageQueue(props),
        { initialProps: opts },
      );

      await act(async () => {
        await result.current.handleUserMessage('will fail', 'text');
      });

      rerender({ ...opts, isBusy: false });
      await flushAsync();

      expect(opts.showToast).toHaveBeenCalledWith(
        expect.objectContaining({ title: expect.stringContaining('Failed to process queued message') }),
      );
      expect(result.current.messageQueue).toHaveLength(0);
      unmount();
    });

    it('does not call processMessage twice while a drain is in flight', async () => {
      let resolveProcess!: () => void;
      const processMessage = vi.fn().mockImplementation(
        () => new Promise<void>((resolve) => { resolveProcess = resolve; }),
      );
      const opts = createMockOptions({ isBusy: true, processMessage });
      const { result, rerender, unmount } = renderHook(
        (props: HookOptions) => useMessageQueue(props),
        { initialProps: opts },
      );

      await act(async () => {
        await result.current.handleUserMessage('first', 'text');
      });

      rerender({ ...opts, isBusy: false });
      await flushAsync();

      rerender({ ...opts, isBusy: false });
      await flushAsync();

      expect(processMessage).toHaveBeenCalledTimes(1);

      await act(async () => { resolveProcess(); });
      await flushAsync();
      unmount();
    });
  });

  describe('clearQueue', () => {
    it('removes all messages from queue', async () => {
      const opts = createMockOptions({ isBusy: true });
      const { result, unmount } = renderHook(() => useMessageQueue(opts));

      await act(async () => {
        await result.current.handleUserMessage('a', 'text');
      });
      await act(async () => {
        await result.current.handleUserMessage('b', 'text');
      });

      expect(result.current.messageQueue).toHaveLength(2);

      act(() => {
        result.current.clearQueue();
      });

      expect(result.current.messageQueue).toHaveLength(0);
      unmount();
    });
  });

  describe('clearQueueForSession', () => {
    it('removes only messages for the specified session', async () => {
      // session-2 marked busy so its message stays queued (an idle cross-session
      // target would now drain immediately via the per-target gate)
      const opts = createMockOptions({
        isBusy: true,
        currentSessionId: 'session-1',
        isSessionBusy: (id: string) => id === 'session-2',
      });
      const { result, unmount } = renderHook(() => useMessageQueue(opts));

      await act(async () => {
        await result.current.handleUserMessage('for session-1', 'text');
      });
      await act(async () => {
        await result.current.handleUserMessage('for session-2', 'text', undefined, {
          targetSessionId: 'session-2',
        });
      });

      expect(result.current.messageQueue).toHaveLength(2);

      act(() => {
        result.current.clearQueueForSession('session-1');
      });

      expect(result.current.messageQueue).toHaveLength(1);
      expect(result.current.messageQueue[0].text).toBe('for session-2');
      unmount();
    });
  });

  describe('removeFromQueue', () => {
    it('removes a specific message by id', async () => {
      const opts = createMockOptions({ isBusy: true });
      const { result, unmount } = renderHook(() => useMessageQueue(opts));

      await act(async () => {
        await result.current.handleUserMessage('first', 'text');
      });
      await act(async () => {
        await result.current.handleUserMessage('second', 'text');
      });

      const firstId = result.current.messageQueue[0].id;

      act(() => {
        result.current.removeFromQueue(firstId);
      });

      expect(result.current.messageQueue).toHaveLength(1);
      expect(result.current.messageQueue[0].text).toBe('second');
      unmount();
    });

    it('logs warning when removing non-existent message', async () => {
      const opts = createMockOptions({ isBusy: true });
      const { result, unmount } = renderHook(() => useMessageQueue(opts));

      act(() => {
        result.current.removeFromQueue('non-existent');
      });

      expect(opts.emitLog).toHaveBeenCalledWith(
        expect.objectContaining({
          level: 'warn',
          message: 'Attempted to remove non-existent message from queue',
        }),
      );
      unmount();
    });
  });

  describe('sendQueuedMessageNow', () => {
    it('promotes a queued message to front and triggers interrupt', async () => {
      const opts = createMockOptions({ isBusy: true });
      const { result, unmount } = renderHook(() => useMessageQueue(opts));

      await act(async () => {
        await result.current.handleUserMessage('first', 'text');
      });
      await act(async () => {
        await result.current.handleUserMessage('second', 'text');
      });

      const secondId = result.current.messageQueue[1].id;

      await act(async () => {
        await result.current.sendQueuedMessageNow(secondId);
      });

      expect(result.current.messageQueue[0].text).toBe('second');
      expect(result.current.messageQueue[1].text).toBe('first');
      expect(opts.stopActiveTurn).toHaveBeenCalledTimes(1);
      unmount();
    });

    it('shows toast and does not interrupt for cross-session message', async () => {
      // session-other marked busy so the message stays queued (an idle
      // cross-session target would now drain immediately via the per-target gate)
      const opts = createMockOptions({
        isBusy: true,
        isSessionBusy: (id: string) => id === 'session-other',
      });
      const { result, unmount } = renderHook(() => useMessageQueue(opts));

      await act(async () => {
        await result.current.handleUserMessage('cross', 'text', undefined, {
          targetSessionId: 'session-other',
        });
      });

      const msgId = result.current.messageQueue[0].id;

      await act(async () => {
        await result.current.sendQueuedMessageNow(msgId);
      });

      expect(opts.stopActiveTurn).not.toHaveBeenCalled();
      expect(opts.showToast).toHaveBeenCalledWith(
        expect.objectContaining({
          title: expect.stringContaining('different conversation'),
        }),
      );
      unmount();
    });

    it('logs warning for non-existent message id', async () => {
      const opts = createMockOptions();
      const { result, unmount } = renderHook(() => useMessageQueue(opts));

      await act(async () => {
        await result.current.sendQueuedMessageNow('does-not-exist');
      });

      expect(opts.emitLog).toHaveBeenCalledWith(
        expect.objectContaining({
          level: 'warn',
          message: 'Attempted to send-now non-existent queued message',
        }),
      );
      unmount();
    });
  });

  describe('options forwarding', () => {
    it('forwards modelOverride to processMessage', async () => {
      const opts = createMockOptions();
      const { result, unmount } = renderHook(() => useMessageQueue(opts));

      await act(async () => {
        await result.current.handleUserMessage('test', 'text', undefined, {
          modelOverride: 'haiku',
        });
      });

      expect(opts.processMessage).toHaveBeenCalledWith(
        'test',
        'text',
        undefined,
        undefined,
        'session-1',
        expect.objectContaining({ modelOverride: 'haiku' }),
      );
      unmount();
    });

    it('forwards doneAfterComplete flag', async () => {
      const opts = createMockOptions();
      const { result, unmount } = renderHook(() => useMessageQueue(opts));

      await act(async () => {
        await result.current.handleUserMessage('done after', 'text', undefined, {
          doneAfterComplete: true,
        });
      });

      expect(opts.processMessage).toHaveBeenCalledWith(
        'done after',
        'text',
        undefined,
        undefined,
        'session-1',
        expect.objectContaining({ doneAfterComplete: true }),
      );
      unmount();
    });
  });

  describe('existingMessageId bypass', () => {
    it('processes immediately without queueing when existingMessageId is set', async () => {
      const opts = createMockOptions({ isBusy: true });
      const { result, unmount } = renderHook(() => useMessageQueue(opts));

      await act(async () => {
        await result.current.handleUserMessage('optimistic', 'text', undefined, {
          existingMessageId: 'placeholder-1',
        });
      });

      expect(opts.stopActiveTurn).not.toHaveBeenCalled();
      expect(result.current.messageQueue).toHaveLength(0);
      expect(opts.processMessage).toHaveBeenCalledWith(
        'optimistic',
        'text',
        undefined,
        'placeholder-1',
        'session-1',
        expect.objectContaining({ messageOrigin: 'user-typed' }),
      );
      unmount();
    });
  });

  describe('messageOrigin', () => {
    it('regular queue drain stamps queue-drain', async () => {
      const opts = createMockOptions({ isBusy: true });
      const { result, rerender, unmount } = renderHook(
        (props: HookOptions) => useMessageQueue(props),
        { initialProps: opts },
      );

      await act(async () => {
        await result.current.handleUserMessage('queued msg', 'text');
      });

      expect(result.current.messageQueue).toHaveLength(1);

      // Transition to idle → queue drain
      rerender({ ...opts, isBusy: false });
      await flushAsync();

      expect(opts.processMessage).toHaveBeenCalledTimes(1);
      // The 6th argument (options) should contain messageOrigin: 'queue-drain'
      const callOptions = vi.mocked(opts.processMessage).mock.calls[0][5];
      expect(callOptions).toEqual(expect.objectContaining({ messageOrigin: 'queue-drain' }));
      unmount();
    });

    it('sendNow-via-tray drain stamps user-typed, not queue-drain', async () => {
      const opts = createMockOptions({ isBusy: true });
      const { result, rerender, unmount } = renderHook(
        (props: HookOptions) => useMessageQueue(props),
        { initialProps: opts },
      );

      await act(async () => {
        await result.current.handleUserMessage('first queued', 'text');
      });
      await act(async () => {
        await result.current.handleUserMessage('second queued', 'text');
      });

      const secondId = result.current.messageQueue[1].id;

      await act(async () => {
        await result.current.sendQueuedMessageNow(secondId);
      });

      // Transition to idle → queue drain
      rerender({ ...opts, isBusy: false });
      await flushAsync();

      expect(opts.processMessage).toHaveBeenCalledTimes(1);
      expect(opts.processMessage).toHaveBeenCalledWith(
        'second queued',
        'text',
        undefined,
        undefined,
        undefined,
        expect.objectContaining({ messageOrigin: 'user-typed' }),
      );
      const callOptions = vi.mocked(opts.processMessage).mock.calls[0][5];
      expect(callOptions).not.toEqual(expect.objectContaining({ messageOrigin: 'queue-drain' }));
      unmount();
    });

    it('preserves user-typed messageOrigin on direct (non-queued) dispatch', async () => {
      const opts = createMockOptions();
      const { result, unmount } = renderHook(() => useMessageQueue(opts));

      await act(async () => {
        await result.current.handleUserMessage('direct msg', 'text', undefined, {
          messageOrigin: 'user-typed',
        });
      });

      expect(opts.processMessage).toHaveBeenCalledTimes(1);
      const callOptions = vi.mocked(opts.processMessage).mock.calls[0][5];
      expect(callOptions).toEqual(expect.objectContaining({ messageOrigin: 'user-typed' }));
      unmount();
    });

    it('preserves system-continuation messageOrigin through queue drain', async () => {
      const opts = createMockOptions({ isBusy: true });
      const { result, rerender, unmount } = renderHook(
        (props: HookOptions) => useMessageQueue(props),
        { initialProps: opts },
      );

      await act(async () => {
        await result.current.handleUserMessage('continuation msg', 'text', undefined, {
          messageOrigin: 'system-continuation',
          isHidden: true,
          isSystemContinuation: true,
        });
      });

      expect(result.current.messageQueue).toHaveLength(1);
      expect(result.current.messageQueue[0]).toHaveProperty('messageOrigin', 'system-continuation');

      rerender({ ...opts, isBusy: false });
      await flushAsync();

      expect(opts.processMessage).toHaveBeenCalledTimes(1);
      const callOptions = vi.mocked(opts.processMessage).mock.calls[0][5];
      expect(callOptions).toEqual(expect.objectContaining({ messageOrigin: 'system-continuation' }));
      unmount();
    });

    it('defaults messageOrigin to user-typed in queued message data', async () => {
      const opts = createMockOptions({ isBusy: true });
      const { result, unmount } = renderHook(
        (props: HookOptions) => useMessageQueue(props),
        { initialProps: opts },
      );

      await act(async () => {
        await result.current.handleUserMessage('queued msg', 'text');
      });

      expect(result.current.messageQueue).toHaveLength(1);
      expect(result.current.messageQueue[0]).toHaveProperty('messageOrigin', 'user-typed');
      unmount();
    });
  });

  describe('error handling', () => {
    it('propagates processMessage error on immediate dispatch (caller handles)', async () => {
      const processMessage = vi.fn().mockRejectedValue(new Error('boom'));
      const opts = createMockOptions({ processMessage });
      const { result, unmount } = renderHook(() => useMessageQueue(opts));

      await expect(
        act(async () => {
          await result.current.handleUserMessage('will fail', 'text');
        }),
      ).rejects.toThrow('boom');

      expect(opts.showToast).not.toHaveBeenCalled();
      unmount();
    });

    it('shows toast on stopActiveTurn failure in sendNow mode', async () => {
      const stopActiveTurn = vi.fn().mockRejectedValue(new Error('stop failed'));
      const opts = createMockOptions({ isBusy: true, stopActiveTurn });
      const { result, unmount } = renderHook(() => useMessageQueue(opts));

      await act(async () => {
        await result.current.handleUserMessage('urgent', 'text', undefined, {
          queueMode: 'sendNow',
        });
      });

      expect(opts.showToast).toHaveBeenCalledWith(
        expect.objectContaining({
          title: expect.stringContaining('Failed to stop run'),
        }),
      );
      unmount();
    });
  });

  describe('onCommit (per-message dispatch callback)', () => {
    it('fires onCommit exactly once after immediate-send processMessage resolves', async () => {
      const onCommit = vi.fn();
      const opts = createMockOptions();
      const { result, unmount } = renderHook(() => useMessageQueue(opts));

      await act(async () => {
        await result.current.handleUserMessage('hello', 'text', undefined, { onCommit });
      });

      expect(opts.processMessage).toHaveBeenCalledTimes(1);
      expect(onCommit).toHaveBeenCalledTimes(1);
      unmount();
    });

    it('fires onCommit exactly once after queued-flush processMessage resolves', async () => {
      const onCommit = vi.fn();
      const opts = createMockOptions({ isBusy: true });
      const { result, rerender, unmount } = renderHook(
        (props: HookOptions) => useMessageQueue(props),
        { initialProps: opts },
      );

      // Enqueue while busy — should not dispatch yet
      await act(async () => {
        await result.current.handleUserMessage('queued', 'text', undefined, { onCommit });
      });

      expect(result.current.messageQueue).toHaveLength(1);
      expect(onCommit).not.toHaveBeenCalled();

      // Flip to idle to trigger drain
      rerender({ ...opts, isBusy: false });
      await flushAsync();

      expect(opts.processMessage).toHaveBeenCalledTimes(1);
      expect(onCommit).toHaveBeenCalledTimes(1);
      expect(result.current.messageQueue).toHaveLength(0);
      unmount();
    });

    it('does not fire onCommit when immediate-send processMessage rejects', async () => {
      const onCommit = vi.fn();
      const processMessage = vi.fn().mockRejectedValue(new Error('boom'));
      const opts = createMockOptions({ processMessage });
      const { result, unmount } = renderHook(() => useMessageQueue(opts));

      await expect(
        act(async () => {
          await result.current.handleUserMessage('will fail', 'text', undefined, { onCommit });
        }),
      ).rejects.toThrow('boom');

      expect(onCommit).not.toHaveBeenCalled();
      unmount();
    });

    it('does not fire onCommit when queued-flush processMessage rejects', async () => {
      const onCommit = vi.fn();
      const processMessage = vi.fn().mockRejectedValueOnce(new Error('drain fail'));
      const opts = createMockOptions({ isBusy: true, processMessage });
      const { result, rerender, unmount } = renderHook(
        (props: HookOptions) => useMessageQueue(props),
        { initialProps: opts },
      );

      await act(async () => {
        await result.current.handleUserMessage('will fail', 'text', undefined, { onCommit });
      });

      rerender({ ...opts, isBusy: false });
      await flushAsync();

      expect(processMessage).toHaveBeenCalledTimes(1);
      expect(onCommit).not.toHaveBeenCalled();
      unmount();
    });

    it('does not fire onCommit when message is removed from the queue before dispatch', async () => {
      const onCommit = vi.fn();
      const opts = createMockOptions({ isBusy: true });
      const { result, rerender, unmount } = renderHook(
        (props: HookOptions) => useMessageQueue(props),
        { initialProps: opts },
      );

      await act(async () => {
        await result.current.handleUserMessage('will be removed', 'text', undefined, { onCommit });
      });

      expect(result.current.messageQueue).toHaveLength(1);

      const id = result.current.messageQueue[0].id;
      act(() => {
        result.current.removeFromQueue(id);
      });

      expect(result.current.messageQueue).toHaveLength(0);

      // Transition to idle — queue is empty so no drain happens
      rerender({ ...opts, isBusy: false });
      await flushAsync();

      expect(opts.processMessage).not.toHaveBeenCalled();
      expect(onCommit).not.toHaveBeenCalled();
      unmount();
    });

    it('does not fire onCommit for any message cleared via clearQueueForSession', async () => {
      const onCommitA = vi.fn();
      const onCommitB = vi.fn();
      const opts = createMockOptions({ isBusy: true, currentSessionId: 'session-1' });
      const { result, rerender, unmount } = renderHook(
        (props: HookOptions) => useMessageQueue(props),
        { initialProps: opts },
      );

      await act(async () => {
        await result.current.handleUserMessage('for session-1', 'text', undefined, {
          onCommit: onCommitA,
        });
      });
      await act(async () => {
        await result.current.handleUserMessage('also for session-1', 'text', undefined, {
          onCommit: onCommitB,
        });
      });

      expect(result.current.messageQueue).toHaveLength(2);

      act(() => {
        result.current.clearQueueForSession('session-1');
      });

      expect(result.current.messageQueue).toHaveLength(0);

      // Transition to idle — queue is empty so no drain happens
      rerender({ ...opts, isBusy: false });
      await flushAsync();

      expect(opts.processMessage).not.toHaveBeenCalled();
      expect(onCommitA).not.toHaveBeenCalled();
      expect(onCommitB).not.toHaveBeenCalled();
      unmount();
    });

    it('does not fire any callback for rerunEditedMessage when no onCommit is attached', async () => {
      const opts = createMockOptions();
      const { result, unmount } = renderHook(() => useMessageQueue(opts));

      // No onCommit attached; rerun-edit path should not invent one to call.
      await act(async () => {
        await result.current.handleUserMessage('edited', 'text', undefined, {
          editTargetMessageId: 'msg-42',
        });
      });

      expect(opts.rerunEditedMessage).toHaveBeenCalledTimes(1);
      expect(opts.processMessage).not.toHaveBeenCalled();
      // No log entries relating to onCommit callbacks
      const logCalls = vi.mocked(opts.emitLog).mock.calls;
      const onCommitLogs = logCalls.filter(
        ([entry]) =>
          typeof entry === 'object' &&
          entry !== null &&
          'context' in entry &&
          (entry as { context?: Record<string, unknown> }).context?.callbackType === 'onCommit',
      );
      expect(onCommitLogs).toHaveLength(0);
      unmount();
    });

    it('logs error and does not re-throw when onCommit throws on immediate-send', async () => {
      const onCommit = vi.fn(() => {
        throw new Error('callback boom');
      });
      const opts = createMockOptions();
      const { result, unmount } = renderHook(() => useMessageQueue(opts));

      // Should NOT throw — the caller must be insulated from callback errors.
      await act(async () => {
        await result.current.handleUserMessage('fine', 'text', undefined, { onCommit });
      });

      expect(opts.processMessage).toHaveBeenCalledTimes(1);
      expect(onCommit).toHaveBeenCalledTimes(1);
      expect(opts.emitLog).toHaveBeenCalledWith(
        expect.objectContaining({
          level: 'error',
          message: 'Message queue onCommit callback threw',
          context: expect.objectContaining({
            callbackType: 'onCommit',
            error: 'callback boom',
          }),
        }),
      );
      unmount();
    });

    it('logs error and continues processing when onCommit throws on queued-flush', async () => {
      const onCommit = vi.fn(() => {
        throw new Error('callback boom');
      });
      const opts = createMockOptions({ isBusy: true });
      const { result, rerender, unmount } = renderHook(
        (props: HookOptions) => useMessageQueue(props),
        { initialProps: opts },
      );

      await act(async () => {
        await result.current.handleUserMessage('queued', 'text', undefined, { onCommit });
      });

      rerender({ ...opts, isBusy: false });
      await flushAsync();

      expect(opts.processMessage).toHaveBeenCalledTimes(1);
      expect(onCommit).toHaveBeenCalledTimes(1);
      expect(opts.emitLog).toHaveBeenCalledWith(
        expect.objectContaining({
          level: 'error',
          message: 'Message queue onCommit callback threw',
          context: expect.objectContaining({
            callbackType: 'onCommit',
            error: 'callback boom',
          }),
        }),
      );
      // Queue should still drain cleanly — no lingering "processing" lock
      expect(result.current.messageQueue).toHaveLength(0);
      unmount();
    });

    it('logs error and does not propagate when async onCommit rejects on immediate-send', async () => {
      const onCommit = vi.fn(async () => {
        await Promise.resolve();
        throw new Error('async boom');
      });
      const opts = createMockOptions();
      const { result, unmount } = renderHook(() => useMessageQueue(opts));

      // Must not throw — caller is insulated from async rejections too.
      await act(async () => {
        await result.current.handleUserMessage('fine', 'text', undefined, { onCommit });
      });

      // Let the rejected promise microtask settle so `.catch` runs.
      await act(async () => {
        await flushAsync();
      });

      expect(opts.processMessage).toHaveBeenCalledTimes(1);
      expect(onCommit).toHaveBeenCalledTimes(1);
      expect(opts.emitLog).toHaveBeenCalledWith(
        expect.objectContaining({
          level: 'error',
          message: 'Message queue onCommit callback rejected',
          context: expect.objectContaining({
            callbackType: 'onCommit',
            error: 'async boom',
          }),
        }),
      );
      unmount();
    });

    it('logs error and continues queue drain when async onCommit rejects on queued-flush', async () => {
      const onCommit = vi.fn(async () => {
        await Promise.resolve();
        throw new Error('async boom');
      });
      const opts = createMockOptions({ isBusy: true });
      const { result, rerender, unmount } = renderHook(
        (props: HookOptions) => useMessageQueue(props),
        { initialProps: opts },
      );

      await act(async () => {
        await result.current.handleUserMessage('queued', 'text', undefined, { onCommit });
      });

      rerender({ ...opts, isBusy: false });
      await flushAsync();
      // Let the rejected promise microtask settle so `.catch` runs.
      await act(async () => {
        await flushAsync();
      });

      expect(opts.processMessage).toHaveBeenCalledTimes(1);
      expect(onCommit).toHaveBeenCalledTimes(1);
      expect(opts.emitLog).toHaveBeenCalledWith(
        expect.objectContaining({
          level: 'error',
          message: 'Message queue onCommit callback rejected',
          context: expect.objectContaining({
            callbackType: 'onCommit',
            error: 'async boom',
          }),
        }),
      );
      expect(result.current.messageQueue).toHaveLength(0);
      unmount();
    });
  });

  describe('supersedePolicy stamping (Stage 3, docs/plans/260610_queue-drain-cancels-turn)', () => {
    it("queue-mode DRAIN dispatch carries supersedePolicy: 'reject'", async () => {
      const opts = createMockOptions({ isBusy: true });
      const { result, rerender, unmount } = renderHook(
        (props: HookOptions) => useMessageQueue(props),
        { initialProps: opts },
      );

      await act(async () => {
        await result.current.handleUserMessage('queued msg', 'text');
      });
      rerender({ ...opts, isBusy: false });
      await flushAsync();

      expect(opts.processMessage).toHaveBeenCalledTimes(1);
      expect(vi.mocked(opts.processMessage).mock.calls[0][5]).toEqual(
        expect.objectContaining({ supersedePolicy: 'reject', messageOrigin: 'queue-drain' }),
      );
      unmount();
    });

    it("queue-mode IMMEDIATE dispatch carries supersedePolicy: 'reject' (race insurance)", async () => {
      const opts = createMockOptions();
      const { result, unmount } = renderHook(() => useMessageQueue(opts));

      await act(async () => {
        await result.current.handleUserMessage('direct msg', 'text');
      });

      expect(opts.processMessage).toHaveBeenCalledTimes(1);
      expect(vi.mocked(opts.processMessage).mock.calls[0][5]).toEqual(
        expect.objectContaining({ supersedePolicy: 'reject' }),
      );
      unmount();
    });

    it('sendNow IMMEDIATE dispatch carries NO supersedePolicy (legacy supersede backstop)', async () => {
      const opts = createMockOptions();
      const { result, unmount } = renderHook(() => useMessageQueue(opts));

      await act(async () => {
        await result.current.handleUserMessage('urgent', 'text', undefined, {
          queueMode: 'sendNow',
        });
      });

      expect(opts.processMessage).toHaveBeenCalledTimes(1);
      expect(vi.mocked(opts.processMessage).mock.calls[0][5]).not.toEqual(
        expect.objectContaining({ supersedePolicy: expect.anything() }),
      );
      unmount();
    });

    it('sendNow-via-tray DRAIN dispatch carries NO supersedePolicy', async () => {
      const opts = createMockOptions({ isBusy: true });
      const { result, rerender, unmount } = renderHook(
        (props: HookOptions) => useMessageQueue(props),
        { initialProps: opts },
      );

      await act(async () => {
        await result.current.handleUserMessage('first queued', 'text');
      });
      await act(async () => {
        await result.current.handleUserMessage('second queued', 'text');
      });
      const secondId = result.current.messageQueue[1].id;
      await act(async () => {
        await result.current.sendQueuedMessageNow(secondId);
      });

      rerender({ ...opts, isBusy: false });
      await flushAsync();

      expect(opts.processMessage).toHaveBeenCalledTimes(1);
      expect(vi.mocked(opts.processMessage).mock.calls[0][0]).toBe('second queued');
      expect(vi.mocked(opts.processMessage).mock.calls[0][5]).not.toEqual(
        expect.objectContaining({ supersedePolicy: expect.anything() }),
      );
      unmount();
    });

    it("system-continuation queue dispatch carries 'reject' (no carve-out, Chief decision)", async () => {
      const opts = createMockOptions({ isBusy: true });
      const { result, rerender, unmount } = renderHook(
        (props: HookOptions) => useMessageQueue(props),
        { initialProps: opts },
      );

      await act(async () => {
        await result.current.handleUserMessage('continuation msg', 'text', undefined, {
          messageOrigin: 'system-continuation',
          isSystemContinuation: true,
        });
      });
      rerender({ ...opts, isBusy: false });
      await flushAsync();

      expect(opts.processMessage).toHaveBeenCalledTimes(1);
      expect(vi.mocked(opts.processMessage).mock.calls[0][5]).toEqual(
        expect.objectContaining({
          supersedePolicy: 'reject',
          messageOrigin: 'system-continuation',
          isSystemContinuation: true,
        }),
      );
      unmount();
    });
  });

  describe('typed refusal requeue (Stage 3, docs/plans/260610_queue-drain-cancels-turn)', () => {
    const makeRefusal = (existingMessageId?: string) => {
      const error = createTargetBusyRejectionError('session-1', 'turn-busy');
      return existingMessageId ? attachRequeueMessageId(error, existingMessageId) : error;
    };

    it('drain refusal: message requeued at FRONT with existingMessageId, no toast, no onCommit, deferred until new busy information', async () => {
      const onCommit = vi.fn();
      const processMessage = vi.fn()
        .mockRejectedValueOnce(makeRefusal('persisted-1'))
        .mockResolvedValue(undefined);
      const opts = createMockOptions({ isBusy: true, processMessage });
      const { result, rerender, unmount } = renderHook(
        (props: HookOptions) => useMessageQueue(props),
        { initialProps: opts },
      );

      await act(async () => {
        await result.current.handleUserMessage('refuse me', 'text', undefined, { onCommit });
      });
      await act(async () => {
        await result.current.handleUserMessage('behind in line', 'text');
      });
      expect(result.current.messageQueue).toHaveLength(2);

      // Drain → first dispatch refused at admission.
      rerender({ ...opts, isBusy: false });
      await flushAsync();

      expect(processMessage).toHaveBeenCalledTimes(1);
      // Requeued at the FRONT (per-target FIFO preserved) with the persisted id.
      expect(result.current.messageQueue).toHaveLength(2);
      expect(result.current.messageQueue[0].text).toBe('refuse me');
      expect(result.current.messageQueue[0].existingMessageId).toBe('persisted-1');
      expect(result.current.messageQueue[1].text).toBe('behind in line');
      // No failure UX, no commit.
      expect(opts.showToast).not.toHaveBeenCalled();
      expect(onCommit).not.toHaveBeenCalled();
      expect(opts.emitLog).toHaveBeenCalledWith(
        expect.objectContaining({
          level: 'info',
          message: expect.stringContaining('refused at admission'),
        }),
      );

      // Anti-hot-loop: the requeue mutated the queue (effect re-fires) but the
      // target is deferred — no immediate second dispatch.
      await flushAsync();
      expect(processMessage).toHaveBeenCalledTimes(1);

      // New busy information (fresh isSessionBusy identity) lifts the deferral
      // → retry dispatches the requeued head with the persisted id.
      rerender({ ...opts, isBusy: false, isSessionBusy: () => false });
      await flushAsync();

      expect(processMessage).toHaveBeenCalledTimes(2);
      expect(processMessage.mock.calls[1][0]).toBe('refuse me');
      expect(processMessage.mock.calls[1][3]).toBe('persisted-1');
      // onCommit fires on the successful dispatch only.
      expect(onCommit).toHaveBeenCalledTimes(1);
      unmount();
    });

    it('immediate-send refusal: message enqueued at BACK, handleUserMessage resolves, no toast, no onCommit', async () => {
      const onCommit = vi.fn();
      const processMessage = vi.fn().mockRejectedValueOnce(makeRefusal('persisted-9'));
      const opts = createMockOptions({
        processMessage,
        isSessionBusy: (id: string) => id === 'session-other',
      });
      const { result, unmount } = renderHook(() => useMessageQueue(opts));

      // Pre-existing queued message for a busy cross-session target — the
      // refused immediate send must append BEHIND it (normal FIFO).
      await act(async () => {
        await result.current.handleUserMessage('cross queued', 'text', undefined, {
          targetSessionId: 'session-other',
        });
      });
      expect(result.current.messageQueue).toHaveLength(1);

      // Immediate dispatch (viewed session looks idle) refused at admission.
      // Must NOT throw — the message is safely queued.
      await act(async () => {
        await result.current.handleUserMessage('raced send', 'text', undefined, { onCommit });
      });

      expect(processMessage).toHaveBeenCalledTimes(1);
      expect(result.current.messageQueue).toHaveLength(2);
      expect(result.current.messageQueue[0].text).toBe('cross queued');
      expect(result.current.messageQueue[1].text).toBe('raced send');
      expect(result.current.messageQueue[1].existingMessageId).toBe('persisted-9');
      expect(opts.showToast).not.toHaveBeenCalled();
      expect(onCommit).not.toHaveBeenCalled();
      expect(opts.emitLog).toHaveBeenCalledWith(
        expect.objectContaining({
          level: 'info',
          message: expect.stringContaining('refused at admission'),
        }),
      );
      unmount();
    });

    it('non-typed drain errors keep the existing toast/drop behavior', async () => {
      const processMessage = vi.fn().mockRejectedValueOnce(new Error('genuine failure'));
      const opts = createMockOptions({ isBusy: true, processMessage });
      const { result, rerender, unmount } = renderHook(
        (props: HookOptions) => useMessageQueue(props),
        { initialProps: opts },
      );

      await act(async () => {
        await result.current.handleUserMessage('will fail', 'text');
      });
      rerender({ ...opts, isBusy: false });
      await flushAsync();

      expect(opts.showToast).toHaveBeenCalledWith(
        expect.objectContaining({ title: expect.stringContaining('Failed to process queued message') }),
      );
      expect(result.current.messageQueue).toHaveLength(0);
      unmount();
    });
  });

  describe('supersedePolicyForQueueMode (single shared derivation, RS F11)', () => {
    it("maps 'queue' and undefined (legacy entries) to 'reject'", () => {
      expect(supersedePolicyForQueueMode('queue')).toBe('reject');
      expect(supersedePolicyForQueueMode(undefined)).toBe('reject');
    });

    it('maps explicit interrupts to no policy (legacy supersede backstop)', () => {
      expect(supersedePolicyForQueueMode('sendNow')).toBeUndefined();
      expect(supersedePolicyForQueueMode('sendNow-via-tray')).toBeUndefined();
    });
  });

  describe('explicit interrupt escapes refusal deferral (GPT F1/F2, RS F5)', () => {
    const makeRefusal = () => createTargetBusyRejectionError('session-1', 'turn-zombie');

    it('sendQueuedMessageNow dispatches a refusal-deferred message with NO supersedePolicy, without any new busy information', async () => {
      const processMessage = vi.fn()
        .mockRejectedValueOnce(makeRefusal())
        .mockResolvedValue(undefined);
      const opts = createMockOptions({ isBusy: true, processMessage });
      const { result, rerender, unmount } = renderHook(
        (props: HookOptions) => useMessageQueue(props),
        { initialProps: opts },
      );

      await act(async () => {
        await result.current.handleUserMessage('stuck behind zombie', 'text');
      });

      // Drain (renderer projects idle; main registry still busy) → refusal →
      // requeue + defer. Same isSessionBusy identity throughout: no churn.
      rerender({ ...opts, isBusy: false });
      await flushAsync();
      expect(processMessage).toHaveBeenCalledTimes(1);
      expect(result.current.messageQueue).toHaveLength(1);

      // Anti-hot-loop holds for the queue-mode entry.
      await flushAsync();
      expect(processMessage).toHaveBeenCalledTimes(1);

      // User explicitly promotes via the tray. NO isSessionBusy identity
      // change has occurred — the deferral alone must not block the interrupt.
      const queuedId = result.current.messageQueue[0].id;
      await act(async () => {
        await result.current.sendQueuedMessageNow(queuedId);
      });
      await flushAsync();

      expect(processMessage).toHaveBeenCalledTimes(2);
      expect(vi.mocked(processMessage).mock.calls[1][0]).toBe('stuck behind zombie');
      // Promoted interrupt carries NO policy → legacy supersede clears the zombie.
      expect(vi.mocked(processMessage).mock.calls[1][5]).not.toEqual(
        expect.objectContaining({ supersedePolicy: expect.anything() }),
      );
      expect(result.current.messageQueue).toHaveLength(0);
      unmount();
    });

    it('composer sendNow dispatches immediately with NO supersedePolicy when the target is refusal-deferred (GPT F2)', async () => {
      const processMessage = vi.fn()
        .mockRejectedValueOnce(makeRefusal())
        .mockResolvedValue(undefined);
      const opts = createMockOptions({ processMessage });
      const { result, unmount } = renderHook(() => useMessageQueue(opts));

      // Immediate queue-mode send refused at admission (TOCTOU) → enqueued at
      // back + target deferred. Renderer stays projected-idle (zombie shape).
      await act(async () => {
        await result.current.handleUserMessage('raced and refused', 'text');
      });
      expect(processMessage).toHaveBeenCalledTimes(1);
      expect(result.current.messageQueue).toHaveLength(1);

      // Explicit composer interrupt: must dispatch immediately (not enqueue),
      // with no policy — stale deferral state never blocks an interrupt.
      await act(async () => {
        await result.current.handleUserMessage('interrupt now', 'text', undefined, {
          queueMode: 'sendNow',
        });
      });

      expect(vi.mocked(processMessage).mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(vi.mocked(processMessage).mock.calls[1][0]).toBe('interrupt now');
      expect(vi.mocked(processMessage).mock.calls[1][5]).not.toEqual(
        expect.objectContaining({ supersedePolicy: expect.anything() }),
      );
      unmount();
    });
  });

  describe('deferred-target single-shot fallback retry (RS F4)', () => {
    const makeRefusal = () => createTargetBusyRejectionError('session-1', 'turn-busy');

    it('retries once after the fallback delay when no busy-information churn arrives; a re-refusal re-defers and re-arms', async () => {
      vi.useFakeTimers();
      try {
        const processMessage = vi.fn()
          .mockRejectedValueOnce(makeRefusal())
          .mockRejectedValueOnce(makeRefusal())
          .mockResolvedValue(undefined);
        const opts = createMockOptions({ isBusy: true, processMessage });
        const { result, rerender, unmount } = renderHook(
          (props: HookOptions) => useMessageQueue(props),
          { initialProps: opts },
        );

        await act(async () => {
          await result.current.handleUserMessage('stranded without churn', 'text');
        });

        // Drain → refusal #1 → defer + arm the single-shot fallback timer.
        rerender({ ...opts, isBusy: false });
        await flushAsync();
        expect(processMessage).toHaveBeenCalledTimes(1);
        expect(result.current.messageQueue).toHaveLength(1);

        // No isSessionBusy identity change EVER arrives. Deferral holds until
        // the fallback timer clears it and nudges the drain effect.
        await flushAsync();
        expect(processMessage).toHaveBeenCalledTimes(1);

        await act(async () => {
          vi.advanceTimersByTime(DEFERRED_TARGET_RETRY_FALLBACK_MS);
        });
        await flushAsync();

        // Retry #1 dispatched — refused again → re-deferred + timer re-armed.
        expect(processMessage).toHaveBeenCalledTimes(2);
        expect(result.current.messageQueue).toHaveLength(1);

        await act(async () => {
          vi.advanceTimersByTime(DEFERRED_TARGET_RETRY_FALLBACK_MS);
        });
        await flushAsync();

        // Retry #2 succeeds (target finally idle at admission) → queue drains.
        expect(processMessage).toHaveBeenCalledTimes(3);
        expect(result.current.messageQueue).toHaveLength(0);
        unmount();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('refusal after clearQueueForSession drops instead of resurrecting (RS F6)', () => {
    const makeRefusal = () => createTargetBusyRejectionError('session-1', 'turn-busy');

    it('drain refusal: message whose target was cleared mid-flight is dropped, not requeued', async () => {
      let rejectDispatch!: (err: unknown) => void;
      const processMessage = vi.fn(
        () => new Promise<void>((_resolve, reject) => { rejectDispatch = reject; }),
      );
      const opts = createMockOptions({ isBusy: true, processMessage });
      const { result, rerender, unmount } = renderHook(
        (props: HookOptions) => useMessageQueue(props),
        { initialProps: opts },
      );

      await act(async () => {
        await result.current.handleUserMessage('doomed', 'text');
      });
      expect(result.current.messageQueue).toHaveLength(1);

      // Drain starts; the dispatch hangs in flight (pre-refusal IPC window).
      rerender({ ...opts, isBusy: false });
      await flushAsync();
      expect(processMessage).toHaveBeenCalledTimes(1);
      expect(result.current.messageQueue).toHaveLength(0);

      // Session delete purges the target's queue while the dispatch is in flight.
      act(() => {
        result.current.clearQueueForSession('session-1');
      });

      // The in-flight dispatch is then refused at admission → must DROP.
      await act(async () => {
        rejectDispatch(makeRefusal());
        await flushAsync();
      });

      expect(result.current.messageQueue).toHaveLength(0);
      expect(opts.showToast).not.toHaveBeenCalled();
      expect(opts.emitLog).toHaveBeenCalledWith(
        expect.objectContaining({
          level: 'info',
          message: expect.stringContaining('dropping (no requeue)'),
        }),
      );
      unmount();
    });

    it('drain refusal: message in flight during a GLOBAL clearQueue() is dropped, not requeued', async () => {
      let rejectDispatch!: (err: unknown) => void;
      const processMessage = vi.fn(
        () => new Promise<void>((_resolve, reject) => { rejectDispatch = reject; }),
      );
      const opts = createMockOptions({ isBusy: true, processMessage });
      const { result, rerender, unmount } = renderHook(
        (props: HookOptions) => useMessageQueue(props),
        { initialProps: opts },
      );

      await act(async () => {
        await result.current.handleUserMessage('doomed', 'text');
      });
      expect(result.current.messageQueue).toHaveLength(1);

      // Drain starts; the dispatch hangs in flight (pre-refusal IPC window).
      rerender({ ...opts, isBusy: false });
      await flushAsync();
      expect(processMessage).toHaveBeenCalledTimes(1);
      expect(result.current.messageQueue).toHaveLength(0);

      // User clears the WHOLE queue (clear-all) while the dispatch is in flight.
      act(() => {
        result.current.clearQueue();
      });

      // The in-flight dispatch is then refused at admission → must DROP.
      await act(async () => {
        rejectDispatch(makeRefusal());
        await flushAsync();
      });

      expect(result.current.messageQueue).toHaveLength(0);
      expect(opts.showToast).not.toHaveBeenCalled();
      expect(opts.emitLog).toHaveBeenCalledWith(
        expect.objectContaining({
          level: 'info',
          message: expect.stringContaining('dropping (no requeue)'),
        }),
      );
      unmount();
    });

    it('immediate-send refusal: message whose target was cleared mid-flight is dropped, not enqueued', async () => {
      let rejectDispatch!: (err: unknown) => void;
      const processMessage = vi.fn(
        () => new Promise<void>((_resolve, reject) => { rejectDispatch = reject; }),
      );
      const opts = createMockOptions({ processMessage });
      const { result, unmount } = renderHook(() => useMessageQueue(opts));

      // Immediate dispatch in flight (viewed session idle).
      let sendPromise!: Promise<void>;
      await act(async () => {
        sendPromise = result.current.handleUserMessage('doomed', 'text');
        await flushAsync();
      });
      expect(processMessage).toHaveBeenCalledTimes(1);

      act(() => {
        result.current.clearQueueForSession('session-1');
      });

      await act(async () => {
        rejectDispatch(makeRefusal());
        // Refusal is swallowed (message handled) — the caller's await resolves.
        await sendPromise;
      });

      expect(result.current.messageQueue).toHaveLength(0);
      expect(opts.showToast).not.toHaveBeenCalled();
      expect(opts.emitLog).toHaveBeenCalledWith(
        expect.objectContaining({
          level: 'info',
          message: expect.stringContaining('dropping (no requeue)'),
        }),
      );
      unmount();
    });

    it('a purge BEFORE dispatch start does not poison later refusal requeues for that session', async () => {
      const processMessage = vi.fn()
        .mockRejectedValueOnce(makeRefusal())
        .mockResolvedValue(undefined);
      const opts = createMockOptions({ isBusy: true, processMessage });
      const { result, rerender, unmount } = renderHook(
        (props: HookOptions) => useMessageQueue(props),
        { initialProps: opts },
      );

      // Stale tombstone from an earlier clear (e.g. user emptied the tray).
      act(() => {
        result.current.clearQueueForSession('session-1');
      });

      // Wait past the tombstone timestamp so the later dispatch starts after it.
      await new Promise((resolve) => setTimeout(resolve, 5));

      await act(async () => {
        await result.current.handleUserMessage('queued later', 'text');
      });
      rerender({ ...opts, isBusy: false });
      await flushAsync();

      // Refusal must REQUEUE (tombstone predates this dispatch), not drop.
      expect(processMessage).toHaveBeenCalledTimes(1);
      expect(result.current.messageQueue).toHaveLength(1);
      expect(result.current.messageQueue[0].text).toBe('queued later');
      unmount();
    });
  });
});
