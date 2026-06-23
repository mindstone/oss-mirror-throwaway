import { afterEach, describe, expect, it } from 'vitest';
import type { AgentSession } from '@shared/types';
import { agentTurnRegistry } from '../agentTurnRegistry';
import { buildCliSessionSnapshot } from '../cliSessionSnapshot';

describe('buildCliSessionSnapshot', () => {
  const trackedTurns = new Set<string>();

  afterEach(() => {
    for (const turnId of trackedTurns) {
      agentTurnRegistry.cleanupTurn(turnId);
    }
    trackedTurns.clear();
  });

  it('builds a CLI session snapshot from the accumulator and existing session', () => {
    const turnId = 'cli-snapshot-turn';
    const sessionId = 'cli-snapshot-session';
    trackedTurns.add(turnId);
    agentTurnRegistry.setTurnPrompt(turnId, 'unique prompt marker');
    const accumulator = agentTurnRegistry.getOrCreateAccumulator(turnId, sessionId);
    accumulator.appendEvent({ type: 'turn_started', timestamp: 1_000 }, sessionId);
    accumulator.appendEvent({ type: 'assistant', text: 'assistant marker', timestamp: 1_100 }, sessionId);
    accumulator.appendEvent({ type: 'result', text: 'assistant marker', timestamp: 1_200 }, sessionId);

    const existingSession: AgentSession = {
      id: sessionId,
      title: 'Existing title',
      createdAt: 900,
      updatedAt: 950,
      messages: [
        {
          id: 'existing-user',
          turnId: 'existing-turn',
          role: 'user',
          text: 'existing',
          createdAt: 900,
        },
      ],
      eventsByTurn: {},
      activeTurnId: null,
      isBusy: false,
      lastError: null,
      resolvedAt: null,
      origin: 'manual',
    };

    const snapshot = buildCliSessionSnapshot({
      turnId,
      sessionId,
      existingSession,
      registry: agentTurnRegistry,
      now: () => 1_500,
    });

    expect(snapshot.id).toBe(sessionId);
    expect(snapshot.title).toBe('Existing title');
    expect(snapshot.origin).toBe('manual');
    expect(snapshot.messages).toHaveLength(3);
    expect(snapshot.messages.map((message) => message.text)).toEqual([
      'existing',
      'unique prompt marker',
      'assistant marker',
    ]);
    expect(snapshot.eventsByTurn[turnId]).toHaveLength(3);
    expect(snapshot.updatedAt).toBeGreaterThan(existingSession.updatedAt);
    expect(snapshot.isBusy).toBe(false);
  });
});
