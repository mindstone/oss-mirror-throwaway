import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DetectorEvent, DetectorSegment, MeetingTriggerDetector } from '@core/services/meetingTriggerDetector';
import { createMeetingQuestionTriggerService } from '../meetingQuestionTriggerService';

type TriggerEvent = Extract<DetectorEvent, { kind: 'trigger' }>;

function createFakeDetector(): MeetingTriggerDetector {
  const listeners = new Set<(event: TriggerEvent) => void>();
  return {
    ingestSegment(seg: DetectorSegment): void {
      if (seg.isFinal === false) return;
      if (!seg.text.startsWith('TRIGGER:')) return;
      const extracted = seg.text.slice('TRIGGER:'.length).trim();
      for (const listener of listeners) {
        listener({
          kind: 'trigger',
          extracted,
          speaker: 'unknown',
          timestamp: seg.timestamp,
        });
      }
    },
    on(kind, listener): void {
      if (kind === 'trigger') {
        listeners.add(listener as (event: TriggerEvent) => void);
      }
    },
    off(kind, listener): void {
      if (kind === 'trigger') {
        listeners.delete(listener as (event: TriggerEvent) => void);
      }
    },
    hasPendingAccumulation: () => false,
    getAccumulationSpeaker: () => null,
    beginAccumulation: () => {},
    appendToAccumulation: () => {},
    cancelAccumulation: () => {},
    dispose: () => listeners.clear(),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('trigger-action-stuck observability', () => {
  it('warns when trigger-heard is not followed by companion-turn-started within 30s', async () => {
    vi.useFakeTimers();
    const observabilitySink = vi.fn();
    const broadcasts: Array<{ channel: string; payload: unknown }> = [];
    const service = createMeetingQuestionTriggerService({
      submitCompanionTurn: () => new Promise(() => {}),
      getCompanionSessionId: () => 'companion-1',
      getRollingTranscript: () => undefined,
      getTriggerPhrase: () => 'Spark',
      getOwnerName: () => 'User',
      broadcast: (channel, payload) => broadcasts.push({ channel, payload }),
      createDetector: () => createFakeDetector(),
      observabilitySink,
    });

    try {
      service.onSegmentAppended({
        sessionId: 'meeting-1',
        text: 'TRIGGER: summarise so far',
        segmentTimestamp: 10_000,
        isFinal: true,
      });

      await vi.advanceTimersByTimeAsync(30_000);

      expect(broadcasts.some((entry) => entry.channel === 'meeting:trigger-heard')).toBe(true);
      expect(broadcasts.some((entry) => entry.channel === 'meeting:companion-turn-started')).toBe(false);
      expect(observabilitySink).toHaveBeenCalledWith(expect.objectContaining({
        level: 'warn',
        message: 'trigger-action-stuck',
        fields: expect.objectContaining({
          sessionIdHash: expect.any(String),
          triggerSource: 'voice-trigger',
          triggerSourceSpeaker: 'unknown',
          triggeredAt: 10_000,
          timeoutMs: 30_000,
        }),
      }));
    } finally {
      await service.dispose();
    }
  });
});
