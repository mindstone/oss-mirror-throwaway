import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  turnCompleted: vi.fn(),
  trackFirstRealTaskIfNeeded: vi.fn(),
}));

 
vi.mock('@renderer/src/tracking', () => ({
  tracking: {
    chat: {
      turnCompleted: mocks.turnCompleted,
    },
  },
  trackFirstRealTaskIfNeeded: mocks.trackFirstRealTaskIfNeeded,
}));

import { trackTurnCompleted } from '../analyticsTracker';
import type { AgentEvent } from '@shared/types';

describe('trackTurnCompleted', () => {
  it('passes content-free output shape metrics to turn analytics', () => {
    mocks.turnCompleted.mockClear();
    mocks.trackFirstRealTaskIfNeeded.mockClear();

    const event: Extract<AgentEvent, { type: 'result' }> = {
      type: 'result',
      text: 'Do not send this raw text to analytics.',
      timestamp: 1_700_000_000_000,
      outputShapeMetrics: {
        wordCount: 8,
        headingCount: 0,
        bulletCount: 0,
        numberedListCount: 0,
        codeBlockCount: 0,
        tableLineCount: 0,
        linkCount: 0,
        hasSourceSection: false,
        shapeBucket: 'short_answer',
      },
    };

    trackTurnCompleted('turn-1', 'session-1', event, 1234);

    expect(mocks.turnCompleted).toHaveBeenCalledWith(
      expect.objectContaining({
        turnId: 'turn-1',
        sessionId: 'session-1',
        durationMs: 1234,
        outputShapeMetrics: event.outputShapeMetrics,
      }),
    );
    expect(mocks.turnCompleted).not.toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.any(String),
      }),
    );
  });
});
