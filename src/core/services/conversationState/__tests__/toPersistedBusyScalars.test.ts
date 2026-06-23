import { describe, expect, it } from 'vitest';
import { STALE_TURN_THRESHOLD_MS } from '@core/services/agentTurnReducer/runtime';
import type { AgentEvent } from '@shared/types';
import { deriveTurnLiveness } from '../turnLiveness';
import { toPersistedBusyScalars } from '../toPersistedBusyScalars';

const NOW = 1_700_000_000_000;

const turnStarted = (timestamp: number): AgentEvent => ({ type: 'turn_started', timestamp });
const result = (timestamp: number): AgentEvent => ({ type: 'result', text: 'done', timestamp });

describe('toPersistedBusyScalars', () => {
  it('maps all liveness states to persisted busy scalars', () => {
    const cases = [
      {
        name: 'idle',
        derived: deriveTurnLiveness({}, NOW),
        expected: { isBusy: false, activeTurnId: null },
      },
      {
        name: 'running',
        derived: deriveTurnLiveness({ 'turn-running': [turnStarted(NOW - 1000)] }, NOW),
        expected: { isBusy: true, activeTurnId: 'turn-running' },
      },
      {
        name: 'terminal',
        derived: deriveTurnLiveness({ 'turn-terminal': [result(NOW - 1000)] }, NOW),
        expected: { isBusy: false, activeTurnId: null },
      },
      {
        name: 'interrupted',
        derived: deriveTurnLiveness(
          { 'turn-interrupted': [turnStarted(NOW - STALE_TURN_THRESHOLD_MS - 1)] },
          NOW,
        ),
        expected: { isBusy: false, activeTurnId: null },
      },
    ] as const;

    for (const testCase of cases) {
      expect(toPersistedBusyScalars(testCase.derived), testCase.name).toEqual(testCase.expected);
    }
  });
});
