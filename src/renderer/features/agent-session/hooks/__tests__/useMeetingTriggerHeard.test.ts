// @vitest-environment happy-dom
import { act } from 'react';
import { renderHook } from '@renderer/test-utils';
import { useMeetingTriggerHeard } from '../useMeetingTriggerHeard';
import { meetingEventEmitter } from '@rebel/cloud-client';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

vi.useFakeTimers();

describe('useMeetingTriggerHeard', () => {
  beforeEach(() => {
    vi.clearAllTimers();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('initializes with default state', () => {
    const { result } = renderHook(() => useMeetingTriggerHeard('session-1'));
    
    expect(result.current).toEqual({
      pulsing: false,
      lastTriggerAt: null,
      lastSpeaker: null,
      rateLimited: false,
      rateLimitResetsAt: null,
      awaitingTurn: false,
      lastDropReason: null,
    });
  });

  it('handles trigger-heard event', () => {
    const { result } = renderHook(() => useMeetingTriggerHeard('session-1'));
    
    act(() => {
      meetingEventEmitter.emit('trigger-heard', {
        sessionId: 'session-1',
        triggerSource: 'voice-trigger',
        triggerSourceSpeaker: 'Alice',
        triggeredAt: 1000,
        triggerExtracted: 'Summarise what we have so far.',
      });
    });

    expect(result.current.pulsing).toBe(true);
    expect(result.current.lastSpeaker).toBe('Alice');
    expect(result.current.lastTriggerAt).toBe(1000);

    act(() => {
      vi.advanceTimersByTime(3000);
    });

    expect(result.current.pulsing).toBe(false);

    act(() => {
      vi.advanceTimersByTime(27000); // reaches 30s total
    });

    expect(result.current.awaitingTurn).toBe(true);
  });

  it('handles trigger-rate-limit-exceeded', () => {
    const { result } = renderHook(() => useMeetingTriggerHeard('session-1'));
    
    act(() => {
      meetingEventEmitter.emit('trigger-rate-limit-exceeded', {
        sessionId: 'session-1',
        resetsAt: Date.now() + 60000,
      });
    });

    expect(result.current.rateLimited).toBe(true);
    expect(result.current.rateLimitResetsAt).toBeGreaterThan(Date.now());
  });

  it('handles trigger-dropped event', () => {
    const { result } = renderHook(() => useMeetingTriggerHeard('session-1'));
    
    act(() => {
      meetingEventEmitter.emit('trigger-dropped', {
        sessionId: 'session-1',
        triggerSource: 'voice-trigger',
        triggerSourceSpeaker: 'Charlie',
        triggeredAt: 1000,
        triggerExtracted: 'Summarise what we have so far.',
        reason: 'action-timeout',
      });
    });

    expect(result.current.lastDropReason).toBe('action-timeout');

    act(() => {
      vi.advanceTimersByTime(8000);
    });

    expect(result.current.lastDropReason).toBe(null);
  });
});
