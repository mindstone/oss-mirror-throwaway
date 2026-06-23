import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '@shared/types';
import {
  assertNoStuckBusy,
  violatesNoStuckBusy,
} from '../assertNoStuckBusy';

const turnStartedEvent = (timestamp: number): AgentEvent => ({
  type: 'turn_started',
  timestamp,
});

const resultEvent = (text: string, timestamp: number): AgentEvent => ({
  type: 'result',
  text,
  timestamp,
});

const statusEvent = (message: string, timestamp: number): AgentEvent => ({
  type: 'status',
  message,
  timestamp,
});

describe('assertNoStuckBusy negative controls', () => {
  it('fails a busy persisted shape whose active turn already has a terminal result', () => {
    // Regression proof: this is the exact stuck-busy artifact shape the net must catch.
    const stuckBusyWithTerminalTurn = {
      isBusy: true,
      activeTurnId: 'turn-terminal',
      eventsByTurn: {
        'turn-terminal': [
          turnStartedEvent(1000),
          resultEvent('completed but still busy', 1010),
        ],
      },
    };

    expect(violatesNoStuckBusy(stuckBusyWithTerminalTurn)).toBe(true);
    expect(() => assertNoStuckBusy(stuckBusyWithTerminalTurn)).toThrow(
      'active turn "turn-terminal" already has terminal event',
    );
  });

  it('fails a busy persisted shape with no active turn', () => {
    // Regression proof: busy without an active turn is an unresumable persisted state.
    const stuckBusyWithoutActiveTurn = {
      isBusy: true,
      activeTurnId: null,
      eventsByTurn: {},
    };

    expect(violatesNoStuckBusy(stuckBusyWithoutActiveTurn)).toBe(true);
    expect(() => assertNoStuckBusy(stuckBusyWithoutActiveTurn)).toThrow(
      'isBusy=true requires a non-empty activeTurnId',
    );
  });

  it('fails a busy persisted shape with an undefined or empty activeTurnId', () => {
    // Persisted JSON can carry undefined (absent key) or an empty string;
    // both mean "no active turn" and must violate isBusy=true.
    const undefinedActiveTurn = {
      isBusy: true,
      activeTurnId: undefined as unknown as null,
      eventsByTurn: {},
    };
    const emptyActiveTurn = {
      isBusy: true,
      activeTurnId: '' as unknown as null,
      eventsByTurn: {},
    };

    expect(violatesNoStuckBusy(undefinedActiveTurn)).toBe(true);
    expect(() => assertNoStuckBusy(undefinedActiveTurn)).toThrow(
      'isBusy=true requires a non-empty activeTurnId',
    );
    expect(violatesNoStuckBusy(emptyActiveTurn)).toBe(true);
    expect(() => assertNoStuckBusy(emptyActiveTurn)).toThrow(
      'isBusy=true requires a non-empty activeTurnId',
    );
  });

  it('passes a busy shape whose terminal event is on a NON-active turn', () => {
    // Only the active turn's terminal matters; a prior completed turn is fine.
    const busyWithPriorTerminal = {
      isBusy: true,
      activeTurnId: 'turn-live',
      eventsByTurn: {
        'turn-old': [turnStartedEvent(900), resultEvent('old done', 950)],
        'turn-live': [turnStartedEvent(1000), statusEvent('working', 1005)],
      },
    };

    expect(violatesNoStuckBusy(busyWithPriorTerminal)).toBe(false);
    expect(() => assertNoStuckBusy(busyWithPriorTerminal)).not.toThrow();
  });

  it('passes an idle persisted shape even if old terminal turn data remains on disk', () => {
    // Idle snapshots may retain historical terminal events; only busy snapshots are invalid.
    const cleanIdleSnapshot = {
      isBusy: false,
      activeTurnId: 'turn-terminal',
      eventsByTurn: {
        'turn-terminal': [
          turnStartedEvent(1000),
          resultEvent('completed and idle', 1010),
        ],
      },
    };

    expect(violatesNoStuckBusy(cleanIdleSnapshot)).toBe(false);
    expect(() => assertNoStuckBusy(cleanIdleSnapshot)).not.toThrow();
  });

  it('passes a busy persisted shape whose active turn only has non-terminal evidence', () => {
    // In-flight turns are allowed to persist as busy while they have no result/error event.
    const cleanInFlightSnapshot = {
      isBusy: true,
      activeTurnId: 'turn-in-flight',
      eventsByTurn: {
        'turn-in-flight': [
          turnStartedEvent(1000),
          statusEvent('Still working', 1005),
        ],
      },
    };

    expect(violatesNoStuckBusy(cleanInFlightSnapshot)).toBe(false);
    expect(() => assertNoStuckBusy(cleanInFlightSnapshot)).not.toThrow();
  });
});
