import { afterEach, describe, expect, it, vi } from 'vitest';

 
vi.mock('@core/logger', () => ({
  createTurnSessionLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
  createScopedLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
  }),
}));

 
vi.mock('@core/tracking', () => ({
  getTracker: () => ({
    track: vi.fn(),
    identify: vi.fn(),
    getAnonymousId: vi.fn(() => 'anon-test-id'),
    isAvailable: vi.fn(() => true),
  }),
}));

 
vi.mock('../autoContinueCache', () => ({
  cleanupAutoContinueCache: vi.fn(),
}));

import type { AgentEvent } from '@shared/types';
import { dispatchAgentEvent } from '../agentEventDispatcher';
import { agentTurnRegistry } from '../agentTurnRegistry';

describe('agent event dispatcher subscriber survival', () => {
  const turnId = 'subscriber-survival-turn';

  afterEach(() => {
    agentTurnRegistry.cleanupTurn(turnId);
    vi.clearAllMocks();
  });

  it('keeps subscribers active when the single-slot listener is overwritten', () => {
    const subscriber = vi.fn();
    const firstSingleSlotListener = vi.fn();
    const secondSingleSlotListener = vi.fn();
    const event: Extract<AgentEvent, { type: 'assistant' }> = {
      type: 'assistant',
      text: 'Subscriber should still receive this',
      timestamp: Date.now(),
    };

    agentTurnRegistry.subscribeTurnEvents(turnId, subscriber);
    agentTurnRegistry.setEventListener(turnId, firstSingleSlotListener);
    agentTurnRegistry.setEventListener(turnId, secondSingleSlotListener);

    dispatchAgentEvent(null, turnId, event);

    expect(firstSingleSlotListener).not.toHaveBeenCalled();
    expect(secondSingleSlotListener).toHaveBeenCalledOnce();
    expect(subscriber).toHaveBeenCalledOnce();
    expect(subscriber.mock.calls[0]?.[0]).toMatchObject({
      type: 'assistant',
      text: 'Subscriber should still receive this',
    });
  });
});
