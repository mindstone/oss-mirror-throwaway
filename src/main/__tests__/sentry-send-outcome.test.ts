import type { Event, TransportMakeRequestResponse } from '@sentry/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

 
vi.mock('@sentry/electron/main', () => ({
  IPCMode: { Classic: 'classic' },
  addBreadcrumb: vi.fn(),
  captureException: vi.fn(),
  captureMessage: vi.fn(),
  flush: vi.fn(),
  getClient: vi.fn(() => ({ on: vi.fn() })),
  init: vi.fn(),
  setContext: vi.fn(),
  setTag: vi.fn(),
  setUser: vi.fn(),
  withScope: vi.fn(),
}));

const makeEvent = (eventId: string): Event => ({
  event_id: eventId,
});

const makeResponse = (statusCode: number): TransportMakeRequestResponse => ({
  statusCode,
});

const loadSentryModule = async () => {
  vi.resetModules();
  return import('../sentry');
};

describe('Sentry send outcome LRU', () => {
  let sentry: Awaited<ReturnType<typeof loadSentryModule>>;

  beforeEach(async () => {
    sentry = await loadSentryModule();
    sentry.clearSendOutcomesForTest();
  });

  it('evicts the oldest outcome after inserting 51 outcomes', () => {
    for (let i = 0; i < 51; i++) {
      sentry.recordSendOutcome(makeEvent(`event-${i}`), makeResponse(200));
    }

    expect(sentry.getSendOutcome('event-0')).toBeUndefined();
    expect(sentry.getSendOutcome('event-1')).toMatchObject({ eventId: 'event-1', statusCode: 200 });
  });

  it('refreshes recency when re-inserting an existing event ID', () => {
    sentry.recordSendOutcome(makeEvent('event-a'), makeResponse(200));

    // Fill the remaining slots. With a 50-entry cap, inserting 50 others here
    // would already evict event-a before the refresh under test.
    for (let i = 0; i < 49; i++) {
      sentry.recordSendOutcome(makeEvent(`event-${i}`), makeResponse(200));
    }

    sentry.recordSendOutcome(makeEvent('event-a'), makeResponse(202));
    sentry.recordSendOutcome(makeEvent('event-new'), makeResponse(200));

    expect(sentry.getSendOutcome('event-a')).toMatchObject({
      eventId: 'event-a',
      statusCode: 202,
    });
  });

  it('does not store an empty event ID', () => {
    sentry.recordSendOutcome(makeEvent(''), makeResponse(200));

    expect(sentry.getSendOutcomeCountForTest()).toBe(0);
    expect(sentry.getSendOutcome('')).toBeUndefined();
  });

  it('returns the recorded outcome with its status code', () => {
    sentry.recordSendOutcome(makeEvent('event-status'), makeResponse(429));

    expect(sentry.getSendOutcome('event-status')).toMatchObject({
      eventId: 'event-status',
      statusCode: 429,
    });
  });
});
