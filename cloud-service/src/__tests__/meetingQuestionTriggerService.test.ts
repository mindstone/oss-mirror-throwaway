import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentTurnRequest } from '@shared/types';
import type { DetectorEvent, DetectorSegment, MeetingTriggerDetector } from '@core/services/meetingTriggerDetector';
import {
  createMeetingQuestionTriggerService,
  type MeetingQuestionTriggerService,
  type SubmitCompanionTurnResult,
} from '../services/meetingQuestionTriggerService';

type TriggerEvent = Extract<DetectorEvent, { kind: 'trigger' }>;

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function flushPromises(iterations = 20): Promise<void> {
  return (async () => {
    for (let i = 0; i < iterations; i += 1) {
      await Promise.resolve();
    }
  })();
}

async function waitForCallCount(
  fn: ReturnType<typeof vi.fn>,
  expectedCalls: number,
): Promise<void> {
  for (let i = 0; i < 2_000; i += 1) {
    if (fn.mock.calls.length >= expectedCalls) return;
    await flushPromises(5);
  }
}

function createFakeDetectorFactory(): (args: { ownerName: string; triggerPhrase: string | null }) => MeetingTriggerDetector {
  return () => {
    const listeners = {
      trigger: new Set<(event: TriggerEvent) => void>(),
      stop: new Set<() => void>(),
      discard: new Set<() => void>(),
      'high-signal': new Set<() => void>(),
    };
    let disposed = false;

    const detector: MeetingTriggerDetector = {
      ingestSegment(seg: DetectorSegment): void {
        if (disposed) return;
        if (seg.isFinal === false) return;
        const text = seg.text.trim();
        if (!text.startsWith('TRIGGER:')) return;
        const extracted = text.slice('TRIGGER:'.length).trim();
        const event: TriggerEvent = {
          kind: 'trigger',
          extracted,
          speaker: 'unknown',
          timestamp: seg.timestamp,
        };
        for (const listener of listeners.trigger) {
          listener(event);
        }
      },
      on(kind, listener): void {
        (listeners[kind] as Set<(event: DetectorEvent) => void>).add(listener as (event: DetectorEvent) => void);
      },
      off(kind, listener): void {
        (listeners[kind] as Set<(event: DetectorEvent) => void>).delete(listener as (event: DetectorEvent) => void);
      },
      hasPendingAccumulation(): boolean {
        return false;
      },
      getAccumulationSpeaker(): string | null {
        return null;
      },
      beginAccumulation(): void {},
      appendToAccumulation(): void {},
      cancelAccumulation(): void {},
      dispose(): void {
        disposed = true;
        listeners.trigger.clear();
        listeners.stop.clear();
        listeners.discard.clear();
        listeners['high-signal'].clear();
      },
    };

    return detector;
  };
}

interface HarnessOptions {
  companionSessionId?: string | null;
  rollingTranscript?: string;
  submitCompanionTurn?: (request: AgentTurnRequest) => Promise<SubmitCompanionTurnResult>;
}

function createHarness(options: HarnessOptions = {}): {
  service: MeetingQuestionTriggerService;
  submitCompanionTurn: ReturnType<typeof vi.fn>;
  broadcasts: Array<{ channel: string; payload: unknown }>;
} {
  let turnCounter = 0;
  const broadcasts: Array<{ channel: string; payload: unknown }> = [];
  const submitCompanionTurn = vi.fn(options.submitCompanionTurn ?? (async () => ({
    turnId: `turn-${++turnCounter}`,
    completion: Promise.resolve({ outcome: 'result', persisted: true }),
  })));
  const hasCompanionOverride = Object.prototype.hasOwnProperty.call(options, 'companionSessionId');

  const service = createMeetingQuestionTriggerService({
    submitCompanionTurn,
    getCompanionSessionId: () => (hasCompanionOverride ? (options.companionSessionId ?? null) : 'companion-1'),
    getRollingTranscript: () => options.rollingTranscript,
    getTriggerPhrase: () => 'Spark',
    getOwnerName: () => 'User',
    broadcast: (channel, payload) => {
      broadcasts.push({ channel, payload });
    },
    createDetector: createFakeDetectorFactory(),
  });

  return {
    service,
    submitCompanionTurn,
    broadcasts,
  };
}

const createdServices: MeetingQuestionTriggerService[] = [];

afterEach(async () => {
  for (const service of createdServices.splice(0)) {
    await service.dispose();
  }
  vi.useRealTimers();
});

describe('meetingQuestionTriggerService', () => {
  it('processes trigger actions in FIFO order', async () => {
    const submittedPrompts: string[] = [];
    const harness = createHarness({
      submitCompanionTurn: async (request) => {
        submittedPrompts.push(request.prompt);
        return {
          turnId: `turn-${submittedPrompts.length}`,
          completion: Promise.resolve({ outcome: 'result', persisted: true }),
        };
      },
    });
    createdServices.push(harness.service);

    harness.service.onSegmentAppended({
      sessionId: 'meeting-1',
      text: 'TRIGGER: first question',
      segmentTimestamp: 1_000,
      isFinal: true,
    });
    harness.service.onSegmentAppended({
      sessionId: 'meeting-1',
      text: 'TRIGGER: second question',
      segmentTimestamp: 6_000,
      isFinal: true,
    });

    await flushPromises();

    expect(submittedPrompts).toEqual([
      'first question',
      'second question',
    ]);

    const started = harness.broadcasts
      .filter((entry) => entry.channel === 'meeting:companion-turn-started')
      .map((entry) => (entry.payload as { triggerExtracted: string }).triggerExtracted);
    expect(started).toEqual(['first question', 'second question']);
  });

  it('isolates action timeout failures so the next queued action still runs', async () => {
    vi.useFakeTimers();
    const never = new Promise<unknown>(() => {});

    const harness = createHarness({
      submitCompanionTurn: vi.fn()
        .mockImplementationOnce(async () => ({
          turnId: 'turn-1',
          completion: never,
        }))
        .mockImplementationOnce(async () => ({
          turnId: 'turn-2',
          completion: Promise.resolve({ outcome: 'result', persisted: true }),
        })),
    });
    createdServices.push(harness.service);

    harness.service.onSegmentAppended({
      sessionId: 'meeting-1',
      text: 'TRIGGER: first question',
      segmentTimestamp: 1_000,
      isFinal: true,
    });
    harness.service.onSegmentAppended({
      sessionId: 'meeting-1',
      text: 'TRIGGER: second question',
      segmentTimestamp: 6_000,
      isFinal: true,
    });

    await flushPromises();
    expect(harness.submitCompanionTurn).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(30_000);
    await flushPromises();

    expect(harness.submitCompanionTurn).toHaveBeenCalledTimes(2);
    expect(
      harness.broadcasts.some((entry) =>
        entry.channel === 'meeting:trigger-dropped'
        && (entry.payload as { reason: string }).reason === 'action-timeout'),
    ).toBe(true);
  });

  it('isolates thrown action failures so the next queued action still runs', async () => {
    const harness = createHarness({
      submitCompanionTurn: vi.fn()
        .mockImplementationOnce(async () => {
          throw new Error('submit failed');
        })
        .mockImplementationOnce(async () => ({
          turnId: 'turn-2',
          completion: Promise.resolve({ outcome: 'result', persisted: true }),
        })),
    });
    createdServices.push(harness.service);

    harness.service.onSegmentAppended({
      sessionId: 'meeting-1',
      text: 'TRIGGER: first question',
      segmentTimestamp: 1_000,
      isFinal: true,
    });
    harness.service.onSegmentAppended({
      sessionId: 'meeting-1',
      text: 'TRIGGER: second question',
      segmentTimestamp: 6_000,
      isFinal: true,
    });

    await flushPromises();

    expect(harness.submitCompanionTurn).toHaveBeenCalledTimes(2);
    expect(
      harness.broadcasts.some((entry) =>
        entry.channel === 'meeting:trigger-dropped'
        && (entry.payload as { reason: string }).reason === 'action-failed'),
    ).toBe(true);
  });

  it('replays late-registered rolling transcript segments', async () => {
    const harness = createHarness({
      rollingTranscript: 'TRIGGER: replayed question from transcript',
    });
    createdServices.push(harness.service);

    harness.service.onSegmentAppended({
      sessionId: 'meeting-1',
      text: 'normal segment with no trigger',
      segmentTimestamp: 10_000,
      isFinal: true,
    });

    await flushPromises();

    expect(harness.submitCompanionTurn).toHaveBeenCalledTimes(1);
    const firstRequest = harness.submitCompanionTurn.mock.calls[0]?.[0] as AgentTurnRequest;
    expect(firstRequest.prompt).toContain('replayed question from transcript');
  });

  it('attaches canonical trigger metadata to submitted companion turns', async () => {
    const harness = createHarness();
    createdServices.push(harness.service);

    harness.service.onSegmentAppended({
      sessionId: 'meeting-1',
      text: 'TRIGGER: what changed?',
      segmentTimestamp: 42_000,
      isFinal: true,
    });

    await flushPromises();

    expect(harness.submitCompanionTurn).toHaveBeenCalledTimes(1);
    const request = harness.submitCompanionTurn.mock.calls[0]?.[0] as AgentTurnRequest;
    expect(request).toMatchObject({
      sessionId: 'companion-1',
      prompt: 'what changed?',
      meetingSessionId: 'meeting-1',
      recordingActive: true,
      origin: 'inbound-trigger',
      triggerMeta: {
        triggerSource: 'voice-trigger',
        triggerSourceSpeaker: 'unknown',
        triggeredAt: 42_000,
        triggerExtracted: 'what changed?',
      },
    });
  });

  it('rate-limits the 21st trigger in a rolling hour', async () => {
    const harness = createHarness();
    createdServices.push(harness.service);

    for (let i = 1; i <= 21; i += 1) {
      harness.service.onSegmentAppended({
        sessionId: 'meeting-1',
        text: `TRIGGER: question-${i}`,
        segmentTimestamp: i * 60_000,
        isFinal: true,
      });
    }

    await waitForCallCount(harness.submitCompanionTurn, 20);

    expect(harness.submitCompanionTurn).toHaveBeenCalledTimes(20);
    expect(
      harness.broadcasts.filter((entry) => entry.channel === 'meeting:trigger-rate-limit-exceeded'),
    ).toHaveLength(1);
  });

  it('coalesces triggers that arrive within 3 transcript-seconds', async () => {
    const harness = createHarness();
    createdServices.push(harness.service);

    harness.service.onSegmentAppended({
      sessionId: 'meeting-1',
      text: 'TRIGGER: first question',
      segmentTimestamp: 1_000,
      isFinal: true,
    });
    harness.service.onSegmentAppended({
      sessionId: 'meeting-1',
      text: 'TRIGGER: second question',
      segmentTimestamp: 2_500,
      isFinal: true,
    });

    await flushPromises();

    expect(harness.submitCompanionTurn).toHaveBeenCalledTimes(1);
    expect(
      harness.broadcasts.some((entry) =>
        entry.channel === 'meeting:trigger-dropped'
        && (entry.payload as { reason: string }).reason === 'coalesced'),
    ).toBe(true);
  });

  it('drops trigger actions when companion session lookup is missing', async () => {
    const harness = createHarness({
      companionSessionId: null,
    });
    createdServices.push(harness.service);

    harness.service.onSegmentAppended({
      sessionId: 'meeting-1',
      text: 'TRIGGER: where did my companion go?',
      segmentTimestamp: 1_000,
      isFinal: true,
    });

    await flushPromises();

    expect(harness.submitCompanionTurn).not.toHaveBeenCalled();
    expect(
      harness.broadcasts.some((entry) =>
        entry.channel === 'meeting:trigger-dropped'
        && (entry.payload as { reason: string }).reason === 'missing-companion-id'),
    ).toBe(true);
  });

  it('drops queued actions when a meeting session ends', async () => {
    const firstCompletion = createDeferred<unknown>();
    const harness = createHarness({
      submitCompanionTurn: vi.fn()
        .mockImplementationOnce(async () => ({
          turnId: 'turn-1',
          completion: firstCompletion.promise,
        }))
        .mockImplementationOnce(async () => ({
          turnId: 'turn-2',
          completion: Promise.resolve({ outcome: 'result', persisted: true }),
        })),
    });
    createdServices.push(harness.service);

    harness.service.onSegmentAppended({
      sessionId: 'meeting-1',
      text: 'TRIGGER: first question',
      segmentTimestamp: 1_000,
      isFinal: true,
    });
    harness.service.onSegmentAppended({
      sessionId: 'meeting-1',
      text: 'TRIGGER: second question',
      segmentTimestamp: 6_000,
      isFinal: true,
    });

    await flushPromises();
    expect(harness.submitCompanionTurn).toHaveBeenCalledTimes(1);

    await harness.service.onSessionEnded('meeting-1', 'session-ended');
    await flushPromises();

    firstCompletion.resolve({ outcome: 'result', persisted: true });
    await flushPromises();

    expect(harness.submitCompanionTurn).toHaveBeenCalledTimes(1);
    expect(
      harness.broadcasts.some((entry) =>
        entry.channel === 'meeting:trigger-dropped'
        && (entry.payload as { reason: string; triggerExtracted: string }).reason === 'session-ended'
        && (entry.payload as { reason: string; triggerExtracted: string }).triggerExtracted === 'second question'),
    ).toBe(true);
  });
});
