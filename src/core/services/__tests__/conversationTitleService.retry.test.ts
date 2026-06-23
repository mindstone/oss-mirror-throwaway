import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentTurnMessage, AppSettings } from '@shared/types';

const {
  mockCaptureKnownCondition,
  mockCallBehindTheScenes,
  mockHasValidAuth,
} = vi.hoisted(() => ({
  mockCaptureKnownCondition: vi.fn(),
  mockCallBehindTheScenes: vi.fn(),
  mockHasValidAuth: vi.fn(() => true),
}));

 
vi.mock('@core/sentry/captureKnownCondition', () => ({
  captureKnownCondition: (...args: unknown[]) => mockCaptureKnownCondition(...args),
}));

 
vi.mock('@core/services/behindTheScenesClient', () => ({
  callBehindTheScenesWithAuth: (...args: unknown[]) => mockCallBehindTheScenes(...args),
  getEffectiveModelName: vi.fn(() => 'test-model'),
}));

 
vi.mock('@core/utils/authEnvUtils', () => ({
  hasValidAuth: () => mockHasValidAuth(),
}));

import { processAutoTitle } from '../conversationTitleService';

const makeMessage = (
  overrides: Partial<AgentTurnMessage> & { role: AgentTurnMessage['role']; text: string },
): AgentTurnMessage => ({
  id: overrides.id ?? '1',
  turnId: overrides.turnId ?? 't1',
  role: overrides.role,
  text: overrides.text,
  createdAt: overrides.createdAt ?? 1,
});

const baseSession = () => ({
  id: 'session-1',
  title: 'New conversation',
  messages: [
    makeMessage({ role: 'user', text: 'Help me draft an email' }),
    makeMessage({ id: '2', turnId: 't1', role: 'assistant', text: 'Sure!' }),
  ],
  eventsByTurn: { t1: [{ type: 'result', text: 'done', timestamp: 1 } as any] },
});

const mockSettings = { claude: { apiKey: 'test-key' } } as unknown as AppSettings;
const getSettings = () => mockSettings;

describe('processAutoTitle — retry path', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockHasValidAuth.mockReturnValue(true);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function advancePastBackoff() {
    await vi.advanceTimersByTimeAsync(30_000);
  }

  it('returns the title on first attempt without retrying', async () => {
    mockCallBehindTheScenes.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'Email Draft' }],
    });

    const getCurrentSession = vi.fn();
    const promise = processAutoTitle(baseSession(), { getSettings, getCurrentSession });
    const result = await promise;

    expect(result).toEqual({ title: 'Email Draft', reason: 'initial', turnCount: 1 });
    expect(mockCallBehindTheScenes).toHaveBeenCalledTimes(1);
    expect(getCurrentSession).not.toHaveBeenCalled();
    expect(mockCaptureKnownCondition).not.toHaveBeenCalled();
  });

  it('retries once after 30s when first attempt returns null and emits on second null', async () => {
    mockCallBehindTheScenes
      .mockResolvedValueOnce({ content: [] })
      .mockResolvedValueOnce({ content: [] });

    const getCurrentSession = vi.fn().mockResolvedValue({
      title: 'New conversation',
      messages: baseSession().messages,
    });

    const promise = processAutoTitle(baseSession(), { getSettings, getCurrentSession });
    await advancePastBackoff();
    const result = await promise;

    expect(result).toBeNull();
    expect(mockCallBehindTheScenes).toHaveBeenCalledTimes(2);
    expect(getCurrentSession).toHaveBeenCalledTimes(1);
    expect(mockCaptureKnownCondition).toHaveBeenCalledTimes(1);
    expect(mockCaptureKnownCondition).toHaveBeenCalledWith(
      'conversation_title_unavailable',
      expect.objectContaining({
        extra: expect.objectContaining({
          sessionId: 'session-1',
          reason: 'second_attempt_null',
        }),
      }),
    );
  });

  it('returns the retry title when second attempt succeeds', async () => {
    mockCallBehindTheScenes
      .mockResolvedValueOnce({ content: [] })
      .mockResolvedValueOnce({ content: [{ type: 'text', text: 'Retry Title' }] });

    const getCurrentSession = vi.fn().mockResolvedValue({
      title: 'New conversation',
      messages: baseSession().messages,
    });

    const promise = processAutoTitle(baseSession(), { getSettings, getCurrentSession });
    await advancePastBackoff();
    const result = await promise;

    expect(result).toEqual({ title: 'Retry Title', reason: 'initial', turnCount: 1 });
    expect(mockCaptureKnownCondition).not.toHaveBeenCalled();
  });

  it('skips retry when first attempt aborts via external signal — no emit', async () => {
    // Simulate an external caller's AbortSignal causing the BTS rejection
    // BEFORE our internal 15s timer fires. This is the "intentional cancel"
    // path that must stay silent (no retry, no known-condition emit).
    mockCallBehindTheScenes.mockImplementationOnce(() => {
      const abortError = new Error('aborted');
      abortError.name = 'AbortError';
      return Promise.reject(abortError);
    });

    const getCurrentSession = vi.fn();

    const promise = processAutoTitle(baseSession(), { getSettings, getCurrentSession });
    // Drain only microtasks — do NOT advance to TITLE_TIMEOUT_MS (15s).
    // We want the rejection to land before the internal timer fires so
    // timedOut stays false and the outcome is classified as 'aborted'.
    await vi.advanceTimersByTimeAsync(0);
    await advancePastBackoff();
    const result = await promise;

    expect(result).toBeNull();
    expect(mockCallBehindTheScenes).toHaveBeenCalledTimes(1);
    expect(getCurrentSession).not.toHaveBeenCalled();
    expect(mockCaptureKnownCondition).not.toHaveBeenCalled();
  });

  it('retries when first attempt times out — and returns title on retry', async () => {
    // First call: hang until our internal 15s timer aborts it.
    mockCallBehindTheScenes.mockImplementationOnce((_settings: unknown, request: { signal?: AbortSignal }) => {
      return new Promise((_, reject) => {
        request.signal?.addEventListener('abort', () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
    });
    // Second call: succeed
    mockCallBehindTheScenes.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'Retry Title' }],
    });

    const getCurrentSession = vi.fn().mockResolvedValue({
      title: 'New conversation',
      messages: baseSession().messages,
    });

    const promise = processAutoTitle(baseSession(), { getSettings, getCurrentSession });
    await vi.advanceTimersByTimeAsync(15_000); // trip internal timer
    await advancePastBackoff();                 // trip retry backoff
    const result = await promise;

    expect(result).toEqual({ title: 'Retry Title', reason: 'initial', turnCount: 1 });
    expect(mockCallBehindTheScenes).toHaveBeenCalledTimes(2);
    expect(getCurrentSession).toHaveBeenCalledTimes(1);
    expect(mockCaptureKnownCondition).not.toHaveBeenCalled();
  });

  it('emits conversation_title_unavailable when both attempts time out', async () => {
    // Both calls hang until their internal 15s timers abort them.
    const hangUntilAborted = (_settings: unknown, request: { signal?: AbortSignal }) =>
      new Promise((_, reject) => {
        request.signal?.addEventListener('abort', () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
    mockCallBehindTheScenes
      .mockImplementationOnce(hangUntilAborted)
      .mockImplementationOnce(hangUntilAborted);

    const getCurrentSession = vi.fn().mockResolvedValue({
      title: 'New conversation',
      messages: baseSession().messages,
    });

    const promise = processAutoTitle(baseSession(), { getSettings, getCurrentSession });
    await vi.advanceTimersByTimeAsync(15_000); // first timer
    await advancePastBackoff();                 // retry backoff
    await vi.advanceTimersByTimeAsync(15_000); // second timer
    const result = await promise;

    expect(result).toBeNull();
    expect(mockCallBehindTheScenes).toHaveBeenCalledTimes(2);
    expect(mockCaptureKnownCondition).toHaveBeenCalledTimes(1);
    expect(mockCaptureKnownCondition).toHaveBeenCalledWith(
      'conversation_title_unavailable',
      expect.objectContaining({
        extra: expect.objectContaining({
          sessionId: 'session-1',
          reason: 'second_attempt_null',
        }),
      }),
    );
  });

  it('skips retry + emit when session was deleted at retry time', async () => {
    mockCallBehindTheScenes.mockResolvedValueOnce({ content: [] });

    const getCurrentSession = vi.fn().mockResolvedValue(null);

    const promise = processAutoTitle(baseSession(), { getSettings, getCurrentSession });
    await advancePastBackoff();
    const result = await promise;

    expect(result).toBeNull();
    expect(mockCallBehindTheScenes).toHaveBeenCalledTimes(1);
    expect(getCurrentSession).toHaveBeenCalledTimes(1);
    expect(mockCaptureKnownCondition).not.toHaveBeenCalled();
  });

  it('skips retry + emit when title was manually renamed at retry time', async () => {
    mockCallBehindTheScenes.mockResolvedValueOnce({ content: [] });

    const getCurrentSession = vi.fn().mockResolvedValue({
      title: 'My Important Renamed Title',
      messages: baseSession().messages,
    });

    const promise = processAutoTitle(baseSession(), { getSettings, getCurrentSession });
    await advancePastBackoff();
    const result = await promise;

    expect(result).toBeNull();
    expect(mockCallBehindTheScenes).toHaveBeenCalledTimes(1);
    expect(mockCaptureKnownCondition).not.toHaveBeenCalled();
  });

  it('skips retry + emit when auth has gone invalid by retry time', async () => {
    mockCallBehindTheScenes.mockResolvedValueOnce({ content: [] });
    mockHasValidAuth
      .mockReturnValueOnce(true) // first attempt
      .mockReturnValueOnce(false); // retry pre-check

    const getCurrentSession = vi.fn().mockResolvedValue({
      title: 'New conversation',
      messages: baseSession().messages,
    });

    const promise = processAutoTitle(baseSession(), { getSettings, getCurrentSession });
    await advancePastBackoff();
    const result = await promise;

    expect(result).toBeNull();
    expect(mockCallBehindTheScenes).toHaveBeenCalledTimes(1);
    expect(getCurrentSession).not.toHaveBeenCalled();
    expect(mockCaptureKnownCondition).not.toHaveBeenCalled();
  });

  it('does not retry when getCurrentSession is not wired', async () => {
    mockCallBehindTheScenes.mockResolvedValueOnce({ content: [] });

    const promise = processAutoTitle(baseSession(), { getSettings });
    await advancePastBackoff();
    const result = await promise;

    expect(result).toBeNull();
    expect(mockCallBehindTheScenes).toHaveBeenCalledTimes(1);
    expect(mockCaptureKnownCondition).not.toHaveBeenCalled();
  });

  it('waits the full 30s before retrying — boundary at 29_999ms / 30_000ms', async () => {
    mockCallBehindTheScenes
      .mockResolvedValueOnce({ content: [] })
      .mockResolvedValueOnce({ content: [{ type: 'text', text: 'Retry Title' }] });

    const getCurrentSession = vi.fn().mockResolvedValue({
      title: 'New conversation',
      messages: baseSession().messages,
    });

    const promise = processAutoTitle(baseSession(), { getSettings, getCurrentSession });

    await vi.advanceTimersByTimeAsync(29_999);
    expect(mockCallBehindTheScenes).toHaveBeenCalledTimes(1);
    expect(getCurrentSession).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    const result = await promise;

    expect(mockCallBehindTheScenes).toHaveBeenCalledTimes(2);
    expect(getCurrentSession).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ title: 'Retry Title', reason: 'initial', turnCount: 1 });
  });

  it('does not propagate a captureKnownCondition throw — defensive wrap', async () => {
    mockCallBehindTheScenes
      .mockResolvedValueOnce({ content: [] })
      .mockResolvedValueOnce({ content: [] });
    mockCaptureKnownCondition.mockImplementation(() => {
      throw new Error('reporter exploded');
    });

    const getCurrentSession = vi.fn().mockResolvedValue({
      title: 'New conversation',
      messages: baseSession().messages,
    });

    const promise = processAutoTitle(baseSession(), { getSettings, getCurrentSession });
    await advancePastBackoff();
    await expect(promise).resolves.toBeNull();
    expect(mockCaptureKnownCondition).toHaveBeenCalledTimes(1);
  });
});
