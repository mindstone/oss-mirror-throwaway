import { describe, expect, it } from 'vitest';
import type { AgentEvent, AgentSession } from '@shared/types';
import { redactSessionFixture } from '../redactSessionFixture';

const makeStatusEvent = (seq: number, timestamp: number): AgentEvent => ({
  type: 'status',
  message: `sensitive-status-${seq}`,
  timestamp,
  seq,
});

describe('redactSessionFixture', () => {
  it('preserves turn partitioning, event ordering, seq, and timestamps while redacting payload strings', () => {
    const turnId = 'turn-redact-1';
    const first = makeStatusEvent(1, 1_000);
    const second = makeStatusEvent(2, 1_100);
    const session: AgentSession = {
      id: 'session-redact-1',
      title: 'Highly sensitive title',
      createdAt: 10,
      updatedAt: 20,
      messages: [
        {
          id: 'm-1',
          turnId,
          role: 'user',
          text: 'Sensitive user prompt',
          createdAt: 10,
        },
      ],
      eventsByTurn: {
        [turnId]: [first, second, first],
      },
      activeTurnId: turnId,
      isBusy: true,
      lastError: null,
      resolvedAt: null,
      draft: {
        text: 'Sensitive draft text',
        updatedAt: 30,
      },
    };

    const redacted = redactSessionFixture(session);

    expect(redacted.title).toBe('[REDACTED]');
    expect(redacted.messages[0].text).toBe('[REDACTED]');
    expect(redacted.draft?.text).toBe('[REDACTED]');

    const redactedEvents = redacted.eventsByTurn[turnId];
    expect(redactedEvents).toHaveLength(3);
    expect(redactedEvents.map((event) => event.seq)).toEqual([1, 2, 1]);
    expect(redactedEvents.map((event) => event.timestamp)).toEqual([1_000, 1_100, 1_000]);
    expect((redactedEvents[0] as { message?: string }).message).toBe('[REDACTED]');
  });
});
