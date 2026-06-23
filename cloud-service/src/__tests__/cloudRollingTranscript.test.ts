import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockLogger } = vi.hoisted(() => ({
  mockLogger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
  },
}));

vi.mock('@core/logger', () => ({
  createScopedLogger: () => mockLogger,
}));

import { CloudRollingTranscript } from '../services/cloudRollingTranscript';

describe('cloudRollingTranscript', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-24T10:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('appends transcript segments and de-duplicates by segmentId', () => {
    const store = new CloudRollingTranscript();
    store.appendSegments('bot-1', [
      {
        segmentId: 'seg-1',
        text: 'Hello team',
        speaker: 'Alex',
        timestamp: Date.now() - 3_000,
        isFinal: true,
        source: 'recall-bot',
      },
    ], 'Standup');

    store.appendSegments('bot-1', [
      {
        segmentId: 'seg-1',
        text: 'Hello team',
        speaker: 'Alex',
        timestamp: Date.now() - 3_000,
        isFinal: true,
        source: 'recall-bot',
      },
      {
        segmentId: 'seg-2',
        text: 'Let us start',
        speaker: 'Jordan',
        timestamp: Date.now() - 1_000,
        isFinal: true,
        source: 'recall-bot',
      },
    ]);

    const meetings = store.getActiveMeetings();
    expect(meetings).toHaveLength(1);
    expect(meetings[0].segments.map((segment) => segment.segmentId)).toEqual(['seg-1', 'seg-2']);
    expect(store.getStaleness('bot-1')).not.toBeNull();
  });

  it('evicts meetings once they exceed the 4-hour activity window', () => {
    const store = new CloudRollingTranscript();
    store.appendSegments('bot-ttl', [
      {
        segmentId: 'seg-ttl',
        text: 'Still here',
        speaker: 'Morgan',
        timestamp: Date.now(),
        isFinal: true,
        source: 'recall-bot',
      },
    ]);

    expect(store.getActiveMeetings()).toHaveLength(1);
    vi.advanceTimersByTime((4 * 60 * 60 * 1000) + 1);
    expect(store.getActiveMeetings()).toHaveLength(0);
    expect(store.getStaleness('bot-ttl')).toBeNull();
  });

  it('evicts least recently appended meetings once capacity is exceeded', () => {
    const store = new CloudRollingTranscript({ maxActiveMeetings: 2 });

    store.appendSegments('bot-a', [{
      segmentId: 'seg-a',
      text: 'A',
      speaker: 'A',
      timestamp: Date.now(),
      isFinal: true,
      source: 'recall-bot',
    }]);
    store.appendSegments('bot-b', [{
      segmentId: 'seg-b',
      text: 'B',
      speaker: 'B',
      timestamp: Date.now(),
      isFinal: true,
      source: 'recall-bot',
    }]);
    store.appendSegments('bot-a', [{
      segmentId: 'seg-a2',
      text: 'A2',
      speaker: 'A',
      timestamp: Date.now(),
      isFinal: true,
      source: 'recall-bot',
    }]);
    store.appendSegments('bot-c', [{
      segmentId: 'seg-c',
      text: 'C',
      speaker: 'C',
      timestamp: Date.now(),
      isFinal: true,
      source: 'recall-bot',
    }]);

    const activeBotIds = store.getActiveMeetings().map((meeting) => meeting.recallBotId).sort();
    expect(activeBotIds).toEqual(['bot-a', 'bot-c']);
  });

  it('evicts the oldest meeting when appending 101 meetings at default capacity (100) and logs the evicted recallBotId', () => {
    const store = new CloudRollingTranscript();

    for (let index = 0; index <= 100; index += 1) {
      store.appendSegments(`bot-${index}`, [{
        segmentId: `seg-${index}`,
        text: `text-${index}`,
        speaker: `Speaker ${index}`,
        timestamp: Date.now(),
        isFinal: true,
        source: 'recall-bot',
      }]);
    }

    const activeBotIds = store.getActiveMeetings().map((meeting) => meeting.recallBotId);
    expect(activeBotIds).toHaveLength(100);
    expect(activeBotIds).not.toContain('bot-0');
    expect(activeBotIds).toContain('bot-100');
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ recallBotId: 'bot-0' }),
      'evicted least recently appended meeting transcript due to capacity limit',
    );
  });

  it('returns exact staleness in milliseconds', () => {
    const store = new CloudRollingTranscript();
    store.appendSegments('bot-staleness', [{
      segmentId: 'seg-staleness',
      text: 'staleness',
      speaker: 'Observer',
      timestamp: Date.now() - 12_345,
      isFinal: true,
      source: 'recall-bot',
    }]);

    expect(store.getStaleness('bot-staleness')).toBe(12_345);
  });
});
