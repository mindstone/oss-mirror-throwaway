import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '@shared/types';
import type { ConversationStateShape } from '@shared/utils/conversationState';
import {
  applySingleActiveBuildInvariant,
  detectSoftwareEngineerTaskCompletion,
  extractTaskEventsFromConversationShape,
  extractTaskEventsFromPersistedEvents,
  type TaskEvent,
} from '../seTaskDetection';

function makeTaskEvent(overrides: Partial<TaskEvent> = {}): TaskEvent {
  return {
    toolUseId: overrides.toolUseId ?? 'task-1',
    subagentType: overrides.subagentType ?? 'software-engineer',
    prompt: overrides.prompt ?? 'Implement the connector',
    ...(overrides.description !== undefined ? { description: overrides.description } : {}),
    turnIndex: overrides.turnIndex ?? 2,
    ...(overrides.completedAtTurnIndex !== undefined
      ? { completedAtTurnIndex: overrides.completedAtTurnIndex }
      : {}),
    resultStatus: overrides.resultStatus ?? 'success',
  };
}

function makeToolStartEvent(args: {
  toolUseId: string;
  subagentType: string;
  prompt?: string;
  description?: string;
  timestamp: number;
}): AgentEvent {
  return {
    type: 'tool',
    toolName: 'Task',
    toolUseId: args.toolUseId,
    parentToolUseId: null,
    detail: JSON.stringify({
      subagent_type: args.subagentType,
      prompt: args.prompt ?? 'Do the work',
      description: args.description ?? 'Task description',
    }),
    stage: 'start',
    timestamp: args.timestamp,
  };
}

function makeToolEndEvent(args: {
  toolUseId: string;
  timestamp: number;
  isError?: boolean;
  detail?: string;
}): AgentEvent {
  return {
    type: 'tool',
    toolName: 'Task',
    toolUseId: args.toolUseId,
    parentToolUseId: null,
    detail: args.detail ?? 'completed',
    stage: 'end',
    ...(args.isError ? { isError: true } : {}),
    timestamp: args.timestamp,
  };
}

describe('detectSoftwareEngineerTaskCompletion', () => {
  it('returns found with latest successful completion turn and sorted unique subagent types', () => {
    const result = detectSoftwareEngineerTaskCompletion({
      taskEvents: [
        makeTaskEvent({
          toolUseId: 'a',
          subagentType: 'se-planner',
          turnIndex: 3,
          completedAtTurnIndex: 6,
          resultStatus: 'success',
        }),
        makeTaskEvent({
          toolUseId: 'b',
          subagentType: 'software-engineer',
          turnIndex: 4,
          completedAtTurnIndex: 8,
          resultStatus: 'success',
        }),
      ],
      contributionSessionId: 'session-1',
      contributionTurnIndexWindow: { sessionId: 'session-1', startTurn: 2, endTurn: 8 },
    });

    expect(result).toEqual({
      found: true,
      taskSubagentTypes: ['se-planner', 'software-engineer'],
      observedAt: { sessionId: 'session-1', turnIndex: 8 },
    });
  });

  it('uses completedAtTurnIndex (not dispatch turnIndex) for in-window matching', () => {
    const result = detectSoftwareEngineerTaskCompletion({
      taskEvents: [
        makeTaskEvent({
          toolUseId: 'x',
          subagentType: 'software-engineer',
          turnIndex: 1,
          completedAtTurnIndex: 5,
          resultStatus: 'success',
        }),
      ],
      contributionSessionId: 'session-1',
      contributionTurnIndexWindow: { sessionId: 'session-1', startTurn: 5, endTurn: 7 },
    });

    expect(result).toEqual({
      found: true,
      taskSubagentTypes: ['software-engineer'],
      observedAt: { sessionId: 'session-1', turnIndex: 5 },
    });
  });

  it('returns window_session_mismatch when window session differs from contribution session', () => {
    const result = detectSoftwareEngineerTaskCompletion({
      taskEvents: [makeTaskEvent()],
      contributionSessionId: 'session-a',
      contributionTurnIndexWindow: { sessionId: 'session-b', startTurn: 0, endTurn: null },
    });
    expect(result).toEqual({
      found: false,
      reason: 'window_session_mismatch',
    });
  });

  it('returns no_tasks_in_window for empty windows (endTurn < startTurn)', () => {
    const result = detectSoftwareEngineerTaskCompletion({
      taskEvents: [makeTaskEvent()],
      contributionSessionId: 'session-a',
      contributionTurnIndexWindow: { sessionId: 'session-a', startTurn: 6, endTurn: 5 },
    });
    expect(result).toEqual({
      found: false,
      reason: 'no_tasks_in_window',
    });
  });

  it('returns no_se_subagent_task_in_window when only non-SE tasks overlap', () => {
    const result = detectSoftwareEngineerTaskCompletion({
      taskEvents: [
        makeTaskEvent({
          subagentType: 'researcher-gpt5.5-high',
          completedAtTurnIndex: 4,
        }),
      ],
      contributionSessionId: 'session-a',
      contributionTurnIndexWindow: { sessionId: 'session-a', startTurn: 0, endTurn: 10 },
    });
    expect(result).toEqual({
      found: false,
      reason: 'no_se_subagent_task_in_window',
    });
  });

  it('returns se_task_in_window_but_not_completed when SE tasks overlap but are not successful', () => {
    const result = detectSoftwareEngineerTaskCompletion({
      taskEvents: [
        makeTaskEvent({
          subagentType: 'se-implementer',
          resultStatus: 'error',
          completedAtTurnIndex: undefined,
        }),
      ],
      contributionSessionId: 'session-a',
      contributionTurnIndexWindow: { sessionId: 'session-a', startTurn: 0, endTurn: 10 },
    });
    expect(result).toEqual({
      found: false,
      reason: 'se_task_in_window_but_not_completed',
    });
  });

  it('mixed success/failure ordering: latest successful completion wins even if later SE task failed', () => {
    const result = detectSoftwareEngineerTaskCompletion({
      taskEvents: [
        makeTaskEvent({
          toolUseId: 'success-1',
          subagentType: 'software-engineer',
          completedAtTurnIndex: 10,
          resultStatus: 'success',
        }),
        makeTaskEvent({
          toolUseId: 'failed-later',
          subagentType: 'se-reviewer',
          turnIndex: 11,
          resultStatus: 'cancelled',
        }),
        makeTaskEvent({
          toolUseId: 'success-2',
          subagentType: 'se-planner',
          completedAtTurnIndex: 12,
          resultStatus: 'success',
        }),
      ],
      contributionSessionId: 'session-a',
      contributionTurnIndexWindow: { sessionId: 'session-a', startTurn: 0, endTurn: 20 },
    });

    expect(result).toEqual({
      found: true,
      taskSubagentTypes: ['se-planner', 'software-engineer'],
      observedAt: { sessionId: 'session-a', turnIndex: 12 },
    });
  });
});

describe('applySingleActiveBuildInvariant', () => {
  it('opens target window and force-closes prior open windows in same session', () => {
    const next = applySingleActiveBuildInvariant(
      [
        { id: 'A', turnIndexWindow: { sessionId: 's1', startTurn: 2, endTurn: null } },
        { id: 'B', turnIndexWindow: { sessionId: 's1', startTurn: 5, endTurn: null } },
        { id: 'C', turnIndexWindow: { sessionId: 's2', startTurn: 1, endTurn: null } },
      ],
      { sessionId: 's1', newPathLockTurn: 8, newContributionId: 'B' },
    );

    expect(next.find((entry) => entry.id === 'A')?.turnIndexWindow).toEqual({
      sessionId: 's1',
      startTurn: 2,
      endTurn: 7,
    });
    expect(next.find((entry) => entry.id === 'B')?.turnIndexWindow).toEqual({
      sessionId: 's1',
      startTurn: 5,
      endTurn: null,
    });
    expect(next.find((entry) => entry.id === 'C')?.turnIndexWindow).toEqual({
      sessionId: 's2',
      startTurn: 1,
      endTurn: null,
    });
  });

  it('within-session re-open overwrites a previously closed window and closes the currently open one', () => {
    const next = applySingleActiveBuildInvariant(
      [
        { id: 'A', turnIndexWindow: { sessionId: 's1', startTurn: 1, endTurn: 3 } },
        { id: 'B', turnIndexWindow: { sessionId: 's1', startTurn: 4, endTurn: null } },
      ],
      { sessionId: 's1', newPathLockTurn: 9, newContributionId: 'A' },
    );

    expect(next.find((entry) => entry.id === 'A')?.turnIndexWindow).toEqual({
      sessionId: 's1',
      startTurn: 9,
      endTurn: null,
    });
    expect(next.find((entry) => entry.id === 'B')?.turnIndexWindow).toEqual({
      sessionId: 's1',
      startTurn: 4,
      endTurn: 8,
    });
  });

  it('same-turn double path-lock can produce empty closed windows (handled by detection as no_tasks_in_window)', () => {
    const next = applySingleActiveBuildInvariant(
      [
        { id: 'A', turnIndexWindow: { sessionId: 's1', startTurn: 10, endTurn: null } },
        { id: 'B', turnIndexWindow: { sessionId: 's1', startTurn: 10, endTurn: null } },
      ],
      { sessionId: 's1', newPathLockTurn: 10, newContributionId: 'B' },
    );

    expect(next.find((entry) => entry.id === 'A')?.turnIndexWindow).toEqual({
      sessionId: 's1',
      startTurn: 10,
      endTurn: 9,
    });
  });
});

describe('extractTaskEventsFrom* helpers', () => {
  it('extracts Task start/end pairs from conversation shape and marks successful completion turn', () => {
    const shape: ConversationStateShape = {
      messages: [],
      eventsByTurn: {
        'turn-1': [
          makeToolStartEvent({
            toolUseId: 'task-1',
            subagentType: 'se-implementer',
            prompt: 'Ship fix',
            timestamp: 1,
          }),
        ],
        'turn-2': [
          makeToolEndEvent({
            toolUseId: 'task-1',
            timestamp: 2,
          }),
        ],
      },
      activeTurnId: 'turn-2',
      focusedTurnId: null,
      isBusy: false,
      lastError: null,
      lastErrorSource: null,
      terminatedTurnIds: new Set<string>(),
    };

    const events = extractTaskEventsFromConversationShape(shape);
    expect(events).toEqual([
      {
        toolUseId: 'task-1',
        subagentType: 'se-implementer',
        prompt: 'Ship fix',
        description: 'Task description',
        turnIndex: 0,
        completedAtTurnIndex: 1,
        resultStatus: 'success',
      },
    ]);
  });

  it('skips parsing an over-budget Task detail (OOM guard) without crashing, leaving fields empty', () => {
    // A Task tool-start whose detail JSON exceeds the bounded parse budget
    // (256 KiB). The guard must refuse to JSON.parse it and yield the same
    // empty fields a parse failure would — never allocating a decoded copy.
    const hugePrompt = 'x'.repeat(300 * 1024);
    const oversizedDetail = JSON.stringify({
      subagent_type: 'software-engineer',
      prompt: hugePrompt,
      description: 'Task description',
    });
    expect(oversizedDetail.length).toBeGreaterThan(256 * 1024);

    const events = extractTaskEventsFromPersistedEvents({
      'turn-1': [
        {
          type: 'tool',
          toolName: 'Task',
          toolUseId: 'task-huge',
          parentToolUseId: null,
          detail: oversizedDetail,
          stage: 'start',
          timestamp: 1,
        },
      ],
    });

    expect(events).toEqual([
      {
        toolUseId: 'task-huge',
        subagentType: '',
        prompt: '',
        turnIndex: 0,
        resultStatus: 'pending',
      },
    ]);
  });

  it('still parses a normal-size Task detail (guard does not regress the happy path)', () => {
    const events = extractTaskEventsFromPersistedEvents({
      'turn-1': [
        makeToolStartEvent({
          toolUseId: 'task-normal',
          subagentType: 'software-engineer',
          prompt: 'A reasonably sized prompt',
          timestamp: 1,
        }),
      ],
    });

    expect(events).toEqual([
      {
        toolUseId: 'task-normal',
        subagentType: 'software-engineer',
        prompt: 'A reasonably sized prompt',
        description: 'Task description',
        turnIndex: 0,
        resultStatus: 'pending',
      },
    ]);
  });

  it('extracts Task events from persisted events fallback source', () => {
    const events = extractTaskEventsFromPersistedEvents({
      'turn-a': [
        makeToolStartEvent({
          toolUseId: 'task-a',
          subagentType: 'software-engineer',
          timestamp: 10,
        }),
      ],
      'turn-b': [
        makeToolEndEvent({
          toolUseId: 'task-a',
          timestamp: 11,
          isError: true,
          detail: 'cancelled by user',
        }),
      ],
    });

    expect(events).toEqual([
      {
        toolUseId: 'task-a',
        subagentType: 'software-engineer',
        prompt: 'Do the work',
        description: 'Task description',
        turnIndex: 0,
        resultStatus: 'cancelled',
      },
    ]);
  });
});
