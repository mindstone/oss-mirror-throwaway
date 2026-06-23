import { act, renderHook } from '@testing-library/react-native';
import { meetingEventEmitter } from '@rebel/cloud-client';

import { useMeetingTriggerHeard } from '../useMeetingTriggerHeard';

const triggerEvent = {
  sessionId: 'meeting-1',
  triggerSource: 'voice-trigger' as const,
  triggerSourceSpeaker: 'unknown',
  triggeredAt: 10_000,
  triggerExtracted: 'summarise so far',
};

describe('useMeetingTriggerHeard', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(1_000);
    meetingEventEmitter.removeAllListeners();
  });

  afterEach(() => {
    meetingEventEmitter.removeAllListeners();
    jest.useRealTimers();
  });

  it('pulses for 3s after trigger-heard and ignores other meetings', () => {
    const { result } = renderHook(() => useMeetingTriggerHeard('meeting-1'));

    act(() => {
      meetingEventEmitter.emit('trigger-heard', { ...triggerEvent, sessionId: 'other' });
    });
    expect(result.current.pulsing).toBe(false);

    act(() => {
      meetingEventEmitter.emit('trigger-heard', triggerEvent);
    });
    expect(result.current.pulsing).toBe(true);
    expect(result.current.lastTriggerAt).toBe(10_000);
    expect(result.current.lastSpeaker).toBe('unknown');

    act(() => {
      jest.advanceTimersByTime(3_000);
    });
    expect(result.current.pulsing).toBe(false);
  });

  it('surfaces awaiting-turn after 30s and clears on companion-turn-started', () => {
    const { result } = renderHook(() => useMeetingTriggerHeard('meeting-1'));

    act(() => {
      meetingEventEmitter.emit('trigger-heard', triggerEvent);
      jest.advanceTimersByTime(30_000);
    });
    expect(result.current.awaitingTurn).toBe(true);

    act(() => {
      meetingEventEmitter.emit('companion-turn-started', {
        ...triggerEvent,
        turnId: 'turn-1',
        companionSessionId: 'companion-1',
      });
    });
    expect(result.current.awaitingTurn).toBe(false);
  });

  it('surfaces and expires rate-limit state', () => {
    const { result } = renderHook(() => useMeetingTriggerHeard('meeting-1'));

    act(() => {
      meetingEventEmitter.emit('trigger-rate-limit-exceeded', {
        sessionId: 'meeting-1',
        resetsAt: 6_000,
      });
    });
    expect(result.current.rateLimited).toBe(true);
    expect(result.current.rateLimitResetsAt).toBe(6_000);

    act(() => {
      jest.advanceTimersByTime(5_000);
    });
    expect(result.current.rateLimited).toBe(false);
    expect(result.current.rateLimitResetsAt).toBeNull();
  });

  it('records dropped reasons, clears awaiting-turn, and hides coalesced drops', () => {
    const { result } = renderHook(() => useMeetingTriggerHeard('meeting-1'));

    act(() => {
      meetingEventEmitter.emit('trigger-heard', triggerEvent);
      jest.advanceTimersByTime(30_000);
    });
    expect(result.current.awaitingTurn).toBe(true);

    act(() => {
      meetingEventEmitter.emit('trigger-dropped', {
        ...triggerEvent,
        reason: 'action-timeout',
      });
    });
    expect(result.current.awaitingTurn).toBe(false);
    expect(result.current.lastDropReason).toBe('action-timeout');

    act(() => {
      jest.advanceTimersByTime(8_000);
    });
    expect(result.current.lastDropReason).toBeNull();

    act(() => {
      meetingEventEmitter.emit('trigger-dropped', {
        ...triggerEvent,
        reason: 'coalesced',
      });
    });
    expect(result.current.lastDropReason).toBeNull();
  });
});
