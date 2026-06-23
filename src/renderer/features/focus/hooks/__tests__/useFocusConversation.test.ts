// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@renderer/test-utils';
import { useFocusConversation } from '../useFocusConversation';

const mockSetCurrentSessionMeta = vi.fn();
const mockAddUserMessage = vi.fn(() => ({ id: 'placeholder-1' }));

vi.mock('@renderer/features/agent-session/store/sessionStore', () => ({
  getSessionStoreState: () => ({
    setCurrentSessionMeta: mockSetCurrentSessionMeta,
    addUserMessage: mockAddUserMessage,
  }),
}));

describe('useFocusConversation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls submitQueuedMessage with correct params', () => {
    const startFreshSession = vi.fn(() => 'session-123');
    const submitQueuedMessage = vi.fn();

    const { result, unmount } = renderHook(() =>
      useFocusConversation({ startFreshSession, submitQueuedMessage }),
    );

    act(() => {
      result.current.startConversation('Plan my week', 'week');
    });

    expect(startFreshSession).toHaveBeenCalledOnce();
    expect(submitQueuedMessage).toHaveBeenCalledWith('Plan my week', 'text', undefined, {
      targetSessionId: 'session-123',
      existingMessageId: 'placeholder-1',
    });
    unmount();
  });

  it('sets session meta for weekly variant', () => {
    const startFreshSession = vi.fn(() => 'session-w');
    const submitQueuedMessage = vi.fn();

    const { result, unmount } = renderHook(() =>
      useFocusConversation({ startFreshSession, submitQueuedMessage }),
    );

    act(() => {
      result.current.startConversation('Test', 'week');
    });

    expect(mockSetCurrentSessionMeta).toHaveBeenCalledWith({
      currentSessionTitle: 'Focus: Week Planning',
      currentSessionOrigin: 'focus',
    });
    unmount();
  });

  it('sets session meta for monthly variant', () => {
    const startFreshSession = vi.fn(() => 'session-m');
    const submitQueuedMessage = vi.fn();

    const { result, unmount } = renderHook(() =>
      useFocusConversation({ startFreshSession, submitQueuedMessage }),
    );

    act(() => {
      result.current.startConversation('Review month', 'month');
    });

    expect(mockSetCurrentSessionMeta).toHaveBeenCalledWith({
      currentSessionTitle: 'Focus: Month Review',
      currentSessionOrigin: 'focus',
    });
    unmount();
  });

  it('async submitQueuedMessage rejection is caught and logged', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const startFreshSession = vi.fn(() => 'session-err');
    const submitQueuedMessage = vi.fn().mockRejectedValue(new Error('Queue failure'));

    const { result, unmount } = renderHook(() =>
      useFocusConversation({ startFreshSession, submitQueuedMessage }),
    );

    act(() => {
      result.current.startConversation('Fail prompt', 'week');
    });

    // Allow the promise rejection to propagate through the microtask queue
    await vi.waitFor(() => {
      expect(consoleError).toHaveBeenCalledWith(
        '[fireAndForget:focusStartConversation]',
        expect.any(Error),
      );
    });

    // Session was still created (fire-and-forget pattern)
    expect(startFreshSession).toHaveBeenCalledOnce();
    expect(mockAddUserMessage).toHaveBeenCalledOnce();

    consoleError.mockRestore();
    unmount();
  });

  it('sync submitQueuedMessage (returning void) works without error', () => {
    const startFreshSession = vi.fn(() => 'session-sync');
    const submitQueuedMessage = vi.fn(() => undefined);

    const { result, unmount } = renderHook(() =>
      useFocusConversation({ startFreshSession, submitQueuedMessage }),
    );

    act(() => {
      result.current.startConversation('Sync prompt', 'week');
    });

    expect(submitQueuedMessage).toHaveBeenCalledOnce();
    unmount();
  });
});
