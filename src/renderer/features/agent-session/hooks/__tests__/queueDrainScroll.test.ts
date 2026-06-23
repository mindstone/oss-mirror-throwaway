// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@renderer/test-utils';
import type { AgentTurnMessage } from '@shared/types';
import { useConversationAutoScroll } from '../useConversationAutoScroll';
import type { ConversationPaneHandle } from '../../components/ConversationPane';

const makeMessage = (
  overrides: Partial<AgentTurnMessage> & { id: string; role: AgentTurnMessage['role'] }
): AgentTurnMessage => ({
  turnId: 'turn-1',
  text: 'test',
  createdAt: Date.now(),
  ...overrides,
});

const createMockContainerRef = () => {
  const scrollElement = document.createElement('div');
  // Simulate a scrollable container with content
  Object.defineProperties(scrollElement, {
    scrollHeight: { value: 2000, configurable: true },
    clientHeight: { value: 600, configurable: true },
    scrollTop: { value: 1400, writable: true, configurable: true },
  });

  const handle: ConversationPaneHandle = {
    scrollToIndex: vi.fn(),
    scrollToBottom: vi.fn(),
    // Added in Stage 1 of the scroll-to-bottom primitive refactor
    // (docs/plans/260420_scroll_to_bottom_primitive_refactor.md).
    // Non-optional on the handle; TS requires a stub.
    scrollToBottomUntilStable: vi
      .fn()
      .mockResolvedValue({ landedAtBottom: true, reason: 'stable' as const }),
    getScrollElement: () => scrollElement,
    getVisibleRange: () => null,
  };

  return { ref: { current: handle }, scrollElement, handle };
};

describe('queueDrainScroll – auto-scroll behavior with messageOrigin', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does NOT call scrollToBottom for queue-drained user messages', () => {
    const { ref, handle } = createMockContainerRef();
    const existingMessages: AgentTurnMessage[] = [
      makeMessage({ id: 'msg-1', role: 'user' }),
      makeMessage({ id: 'msg-2', role: 'result', turnId: 'turn-1' }),
    ];

    const { rerender } = renderHook(
      ({ messages }) =>
        useConversationAutoScroll({
          containerRef: ref,
          visibleMessages: messages,
          processingTurnId: null,
          isBusy: false,
          isInsightSurface: false,
          isDiagnosticsSurface: false,
          currentSessionId: 'session-1',
        }),
      { initialProps: { messages: existingMessages } },
    );

    // Clear any calls from the initial render (message-arrival effect for existing messages)
    (handle.scrollToBottom as ReturnType<typeof vi.fn>).mockClear();
    (handle.scrollToIndex as ReturnType<typeof vi.fn>).mockClear();

    // Add a queue-drained user message
    const messagesWithQueueDrain: AgentTurnMessage[] = [
      ...existingMessages,
      makeMessage({
        id: 'msg-3',
        role: 'user',
        turnId: 'turn-2',
        messageOrigin: 'queue-drain',
      }),
    ];

    rerender({ messages: messagesWithQueueDrain });

    // scrollToBottom should NOT be called for queue-drained messages
    expect(handle.scrollToBottom).not.toHaveBeenCalled();
  });

  it('DOES call scrollToBottom for user-typed messages', () => {
    const { ref, handle } = createMockContainerRef();
    const existingMessages: AgentTurnMessage[] = [
      makeMessage({ id: 'msg-1', role: 'user' }),
      makeMessage({ id: 'msg-2', role: 'result', turnId: 'turn-1' }),
    ];

    const { rerender } = renderHook(
      ({ messages }) =>
        useConversationAutoScroll({
          containerRef: ref,
          visibleMessages: messages,
          processingTurnId: null,
          isBusy: false,
          isInsightSurface: false,
          isDiagnosticsSurface: false,
          currentSessionId: 'session-1',
        }),
      { initialProps: { messages: existingMessages } },
    );

    // Clear any calls from the initial render (prevents false positive)
    (handle.scrollToBottom as ReturnType<typeof vi.fn>).mockClear();
    (handle.scrollToIndex as ReturnType<typeof vi.fn>).mockClear();

    // Add a user-typed message (no messageOrigin = defaults to user-typed behavior)
    const messagesWithUserTyped: AgentTurnMessage[] = [
      ...existingMessages,
      makeMessage({
        id: 'msg-3',
        role: 'user',
        turnId: 'turn-2',
      }),
    ];

    rerender({ messages: messagesWithUserTyped });

    // scrollToBottom SHOULD be called for normal user messages
    expect(handle.scrollToBottom).toHaveBeenCalled();
  });

  it('does NOT force scroll on turn-start when latest user message is queue-drained', () => {
    const { ref, handle } = createMockContainerRef();
    const messagesWithQueueDrain: AgentTurnMessage[] = [
      makeMessage({ id: 'msg-1', role: 'user' }),
      makeMessage({ id: 'msg-2', role: 'result', turnId: 'turn-1' }),
      makeMessage({
        id: 'msg-3',
        role: 'user',
        turnId: 'turn-2',
        messageOrigin: 'queue-drain',
      }),
    ];

    const { rerender } = renderHook(
      ({ messages, processingTurnId, isBusy }) =>
        useConversationAutoScroll({
          containerRef: ref,
          visibleMessages: messages,
          processingTurnId,
          isBusy,
          isInsightSurface: false,
          isDiagnosticsSurface: false,
          currentSessionId: 'session-1',
        }),
      {
        initialProps: {
          messages: messagesWithQueueDrain,
          processingTurnId: null as string | null,
          isBusy: true,
        },
      },
    );

    // Clear any calls from the initial render
    (handle.scrollToBottom as ReturnType<typeof vi.fn>).mockClear();
    (handle.scrollToIndex as ReturnType<typeof vi.fn>).mockClear();

    // Simulate turn assignment (null → value transition)
    rerender({
      messages: messagesWithQueueDrain,
      processingTurnId: 'turn-2',
      isBusy: true,
    });

    // Advance timers past the 50ms delay in the turn-start effect
    vi.advanceTimersByTime(100);

    // scrollToBottom should NOT be called because the latest user message is queue-drained
    expect(handle.scrollToBottom).not.toHaveBeenCalled();
  });

  it('fires scrollToBottom when a new turn starts (activeTurnId null → value)', () => {
    const { ref, handle } = createMockContainerRef();
    const messagesWithUserTypedLatest: AgentTurnMessage[] = [
      makeMessage({ id: 'msg-1', role: 'user', turnId: 'turn-1' }),
      makeMessage({ id: 'msg-2', role: 'result', turnId: 'turn-1' }),
      makeMessage({ id: 'msg-3', role: 'user', turnId: 'turn-2' }),
    ];

    const { rerender } = renderHook(
      ({ messages, processingTurnId, isBusy }) =>
        useConversationAutoScroll({
          containerRef: ref,
          visibleMessages: messages,
          processingTurnId,
          isBusy,
          isInsightSurface: false,
          isDiagnosticsSurface: false,
          currentSessionId: 'session-1',
        }),
      {
        initialProps: {
          messages: messagesWithUserTypedLatest,
          processingTurnId: null as string | null,
          isBusy: true,
        },
      },
    );

    (handle.scrollToBottom as ReturnType<typeof vi.fn>).mockClear();
    (handle.scrollToIndex as ReturnType<typeof vi.fn>).mockClear();

    rerender({
      messages: messagesWithUserTypedLatest,
      processingTurnId: 'turn-2',
      isBusy: true,
    });

    vi.advanceTimersByTime(100);
    expect(handle.scrollToBottom).toHaveBeenCalledTimes(1);
  });

  it('pins a new assistant answer to the top of the viewport instead of chasing the bottom', () => {
    const { ref, handle } = createMockContainerRef();
    const existingMessages: AgentTurnMessage[] = [
      makeMessage({ id: 'msg-1', role: 'user', turnId: 'turn-1' }),
    ];

    const { rerender } = renderHook(
      ({ messages }) =>
        useConversationAutoScroll({
          containerRef: ref,
          visibleMessages: messages,
          processingTurnId: 'turn-2',
          isBusy: true,
          isInsightSurface: false,
          isDiagnosticsSurface: false,
          currentSessionId: 'session-1',
        }),
      { initialProps: { messages: existingMessages } },
    );

    (handle.scrollToBottom as ReturnType<typeof vi.fn>).mockClear();
    (handle.scrollToIndex as ReturnType<typeof vi.fn>).mockClear();

    rerender({
      messages: [
        ...existingMessages,
        makeMessage({ id: 'msg-2', role: 'assistant', turnId: 'turn-2' }),
      ],
    });

    expect(handle.scrollToBottom).not.toHaveBeenCalled();
    expect(handle.scrollToIndex).toHaveBeenCalledTimes(1);
    expect(handle.scrollToIndex).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ align: 'start', behavior: 'auto' }),
    );
  });

  it.each([
    { role: 'assistant' as const },
    { role: 'result' as const },
  ])('does NOT pin queue-drain answer to top (role: $role)', ({ role }) => {
    const { ref, handle } = createMockContainerRef();
    const existingMessages: AgentTurnMessage[] = [
      makeMessage({ id: 'msg-1', role: 'user', turnId: 'turn-1' }),
      makeMessage({ id: 'msg-2', role: 'result', turnId: 'turn-1' }),
      makeMessage({ id: 'msg-3', role: 'user', turnId: 'turn-2', messageOrigin: 'queue-drain' }),
    ];

    const { rerender } = renderHook(
      ({ messages }) =>
        useConversationAutoScroll({
          containerRef: ref,
          visibleMessages: messages,
          processingTurnId: 'turn-2',
          isBusy: true,
          isInsightSurface: false,
          isDiagnosticsSurface: false,
          currentSessionId: 'session-1',
        }),
      { initialProps: { messages: existingMessages } },
    );

    (handle.scrollToBottom as ReturnType<typeof vi.fn>).mockClear();
    (handle.scrollToIndex as ReturnType<typeof vi.fn>).mockClear();

    rerender({
      messages: [
        ...existingMessages,
        makeMessage({ id: 'msg-4', role, turnId: 'turn-2' }),
      ],
    });

    expect(handle.scrollToIndex).not.toHaveBeenCalled();
    expect(handle.scrollToBottom).not.toHaveBeenCalled();
  });

  it('does NOT pin to the top of an assistant answer when reopening a non-busy conversation', () => {
    const { ref, handle } = createMockContainerRef();
    const existingMessages: AgentTurnMessage[] = [
      makeMessage({ id: 'msg-1', role: 'user', turnId: 'turn-1' }),
    ];

    const { rerender } = renderHook(
      ({ messages }) =>
        useConversationAutoScroll({
          containerRef: ref,
          visibleMessages: messages,
          processingTurnId: null,
          isBusy: false,
          isInsightSurface: false,
          isDiagnosticsSurface: false,
          currentSessionId: 'session-1',
        }),
      { initialProps: { messages: existingMessages } },
    );

    (handle.scrollToBottom as ReturnType<typeof vi.fn>).mockClear();
    (handle.scrollToIndex as ReturnType<typeof vi.fn>).mockClear();

    rerender({
      messages: [
        ...existingMessages,
        makeMessage({ id: 'msg-2', role: 'assistant', turnId: 'turn-2' }),
      ],
    });

    expect(handle.scrollToIndex).not.toHaveBeenCalled();
  });

  it('does not re-pin when the same answer turn swaps from assistant to result', () => {
    const { ref, handle } = createMockContainerRef();
    const { rerender } = renderHook(
      ({ messages }) =>
        useConversationAutoScroll({
          containerRef: ref,
          visibleMessages: messages,
          processingTurnId: 'turn-2',
          isBusy: true,
          isInsightSurface: false,
          isDiagnosticsSurface: false,
          currentSessionId: 'session-1',
        }),
      {
        initialProps: {
          messages: [makeMessage({ id: 'msg-1', role: 'user', turnId: 'turn-1' })],
        },
      },
    );

    (handle.scrollToBottom as ReturnType<typeof vi.fn>).mockClear();
    (handle.scrollToIndex as ReturnType<typeof vi.fn>).mockClear();

    rerender({
      messages: [
        makeMessage({ id: 'msg-1', role: 'user', turnId: 'turn-1' }),
        makeMessage({ id: 'msg-2', role: 'assistant', turnId: 'turn-2' }),
      ],
    });
    expect(handle.scrollToIndex).toHaveBeenCalledTimes(1);

    rerender({
      messages: [
        makeMessage({ id: 'msg-1', role: 'user', turnId: 'turn-1' }),
        makeMessage({ id: 'msg-3', role: 'result', turnId: 'turn-2' }),
      ],
    });

    expect(handle.scrollToIndex).toHaveBeenCalledTimes(1);
    expect(handle.scrollToBottom).not.toHaveBeenCalled();
  });
});
