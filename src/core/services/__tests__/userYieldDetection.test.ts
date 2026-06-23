/**
 * Unit tests for `isYieldingToUser` and `hasLegitimateYieldSignal`.
 *
 * FOX-3097: shared predicate consulted by both the rebelCoreQuery task-board
 * continuation block and the autoContinueHook fast paths.
 */
import { describe, it, expect } from 'vitest';
import {
  hasLegitimateYieldSignal,
  isYieldingToUser,
  matchesCompletionIndicator,
  type YieldDetectionTask,
} from '../userYieldDetection';
import type { AgentEvent } from '@shared/types';

const NOW = 1_700_000_000_000;
const TURN_START = NOW - 1_000;

function seededPendingTask(overrides: Partial<YieldDetectionTask> = {}): YieldDetectionTask {
  return {
    owner: 'main',
    status: 'pending',
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function seededInProgressTask(overrides: Partial<YieldDetectionTask> = {}): YieldDetectionTask {
  return {
    owner: 'main',
    status: 'in_progress',
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

describe('matchesCompletionIndicator', () => {
  it('matches strict indicators in unleashed mode', () => {
    expect(matchesCompletionIndicator('Done!', true)).toBe(true);
    expect(matchesCompletionIndicator('let me know if you need anything else', true)).toBe(true);
  });

  it('rejects loose indicators in unleashed mode', () => {
    expect(matchesCompletionIndicator("here's the report", true)).toBe(false);
    expect(matchesCompletionIndicator('Perfect.', true)).toBe(false);
  });

  it('accepts loose indicators in default mode', () => {
    expect(matchesCompletionIndicator("here's your summary", false)).toBe(true);
    expect(matchesCompletionIndicator('feel free to ask anything', false)).toBe(true);
  });

  it('rejects empty input', () => {
    expect(matchesCompletionIndicator('', false)).toBe(false);
  });
});

describe('hasLegitimateYieldSignal', () => {
  it('recognizes the seeded connector-build Phase 0.0 question', () => {
    const text =
      "What would you like to connect to Rebel? Just type the name of the service (e.g., 'Zendesk', 'our internal CRM') and a link to their site or API docs if you have one — that helps me get started faster.";
    expect(hasLegitimateYieldSignal(text, [])).toBe(true);
  });

  it('recognizes "which one" style choice questions', () => {
    expect(
      hasLegitimateYieldSignal('Which one would you like to use?', []),
    ).toBe(true);
  });

  it('recognizes explicit waits for user input', () => {
    expect(hasLegitimateYieldSignal('Waiting for your answer.', [])).toBe(true);
    expect(
      hasLegitimateYieldSignal('Let me know what you think of the draft.', []),
    ).toBe(true);
  });

  it('recognizes pending side-effect confirmations', () => {
    expect(
      hasLegitimateYieldSignal("Here's the draft. Want me to send it?", []),
    ).toBe(true);
  });

  // FOX-3097 Phase 7 — pattern coverage for real skill phrasings.
  // Sampled from `slack-mcp-work-with`, `space-memory-populate`,
  // `coaching-conversation`. Each phrasing should be recognized as a
  // legitimate user-yield so the runtime doesn't force-continue on them.
  it('recognizes brief approval asks — "Ok to proceed?"', () => {
    expect(hasLegitimateYieldSignal('Ok to proceed?', [])).toBe(true);
    expect(hasLegitimateYieldSignal('Okay to proceed with the update?', [])).toBe(true);
    expect(hasLegitimateYieldSignal('Shall I proceed?', [])).toBe(true);
    expect(hasLegitimateYieldSignal('Shall I go ahead and merge?', [])).toBe(true);
  });

  it('recognizes coaching-style "How X do/should you" clarifications', () => {
    expect(
      hasLegitimateYieldSignal('How direct do you want me to be?', []),
    ).toBe(true);
    expect(
      hasLegitimateYieldSignal('How far back should I look?', []),
    ).toBe(true);
    expect(
      hasLegitimateYieldSignal('How much detail would you like?', []),
    ).toBe(true);
  });

  it('recognizes "Which X should/would you/I Y" choice questions', () => {
    expect(
      hasLegitimateYieldSignal('Which space should I populate?', []),
    ).toBe(true);
    expect(
      hasLegitimateYieldSignal('Which sources should I use?', []),
    ).toBe(true);
    expect(
      hasLegitimateYieldSignal('Which channel would you like me to post in?', []),
    ).toBe(true);
  });

  it('recognizes "please confirm" asks', () => {
    expect(
      hasLegitimateYieldSignal('Please confirm before I proceed.', []),
    ).toBe(true);
  });

  it('rejects messages that announce next work ("next I\'ll ...")', () => {
    // Even though it contains "just type" shape, the lazy-continuation gate
    // blocks the yield so the completion-verification retry still fires.
    expect(
      hasLegitimateYieldSignal("Next, I'll fetch the data. Just type 'ok'?", []),
    ).toBe(false);
  });

  it('rejects messages with no yield signal', () => {
    expect(hasLegitimateYieldSignal('Working on it.', [])).toBe(false);
    expect(hasLegitimateYieldSignal('', [])).toBe(false);
  });

  it('rejects side-effect patterns when the tool already fired', () => {
    const toolEvent: AgentEvent = {
      type: 'tool',
      toolName: 'send_email',
      detail: '',
      stage: 'end',
      timestamp: Date.now(),
    } as AgentEvent;
    expect(
      hasLegitimateYieldSignal('Want me to send it?', [toolEvent]),
    ).toBe(false);
  });
});

describe('isYieldingToUser', () => {
  // ==========================================================================
  // Fix Design checkpoint cases (from FOX-3097 brief)
  // ==========================================================================

  it('[case 1] seeded planner tasks + plain-text question → yields', () => {
    const tasks: YieldDetectionTask[] = [
      seededInProgressTask({ createdAt: TURN_START, updatedAt: TURN_START }),
      seededPendingTask({ createdAt: TURN_START, updatedAt: TURN_START }),
      seededPendingTask({ createdAt: TURN_START, updatedAt: TURN_START }),
    ];
    const result = isYieldingToUser({
      lastAssistantText:
        "What would you like to connect to Rebel? Just type the name of the service (e.g., 'Zendesk').",
      tasks,
      turnStartTime: TURN_START,
      turnEvents: [],
    });
    expect(result).toBe(true);
  });

  it('[case 2] seeded incomplete tasks + NO user-yield handoff → does not yield', () => {
    const tasks: YieldDetectionTask[] = [
      seededInProgressTask({ createdAt: TURN_START, updatedAt: TURN_START }),
    ];
    const result = isYieldingToUser({
      lastAssistantText: "Next, I'll start fetching the API docs.",
      tasks,
      turnStartTime: TURN_START,
      turnEvents: [],
    });
    expect(result).toBe(false);
  });

  it('[case 4] task actively in-progress this turn + genuine user-input handoff → does not yield', () => {
    // When an in_progress task has been actively updated this turn (TaskUpdate
    // fired while status stayed `in_progress`), the model is mid-work and the
    // completion-verification safety net should still catch mid-work questions.
    // isYieldingToUser returns false → the task-board check proceeds to force
    // continuation as before.
    const tasks: YieldDetectionTask[] = [
      seededInProgressTask({
        createdAt: TURN_START - 500,
        updatedAt: TURN_START + 100,
      }),
    ];
    const result = isYieldingToUser({
      lastAssistantText: 'Which environment would you like to deploy to?',
      tasks,
      turnStartTime: TURN_START,
      turnEvents: [],
    });
    expect(result).toBe(false);
  });

  // ==========================================================================
  // FOX-3097 Phase 7b — production-observed TaskUpdate(status='completed')
  // regression. Reproduces the mechanism in transcript
  // 57a52249-078d-4696-ab8d-05f9436e4247: model marks the "Ask the user" task
  // `completed` via TaskUpdate, then emits the Phase 0.0 question. The earlier
  // predicate treated this as "work in progress" and blocked the yield.
  // ==========================================================================

  it('[regression] task marked completed via TaskUpdate this turn + Phase 0.0 question → yields', () => {
    const tasks: YieldDetectionTask[] = [
      {
        owner: 'main',
        status: 'completed',
        createdAt: TURN_START - 500,
        updatedAt: TURN_START + 100,
      },
    ];
    const result = isYieldingToUser({
      lastAssistantText:
        "What would you like to connect to Rebel? Just type the name of the service (e.g., 'Zendesk').",
      tasks,
      turnStartTime: TURN_START,
      turnEvents: [],
    });
    expect(result).toBe(true);
  });

  it('[regression] mix of a just-completed task + untouched pending seeds + yield phrasing → yields', () => {
    // Real shape from the transcript: task 1 completed this turn, tasks 2 and
    // 8 are pending/in_progress but never touched (updatedAt === createdAt).
    const tasks: YieldDetectionTask[] = [
      {
        owner: 'main',
        status: 'completed',
        createdAt: TURN_START - 500,
        updatedAt: TURN_START + 100,
      },
      {
        owner: 'main',
        status: 'pending',
        createdAt: TURN_START,
        updatedAt: TURN_START,
      },
      {
        owner: 'main',
        status: 'in_progress',
        createdAt: TURN_START,
        updatedAt: TURN_START,
      },
    ];
    const result = isYieldingToUser({
      lastAssistantText:
        'What would you like to connect to Rebel? Just type the name of the service.',
      tasks,
      turnStartTime: TURN_START,
      turnEvents: [],
    });
    expect(result).toBe(true);
  });

  it('[regression] pending task with updatedAt > createdAt → does not count as in-progress work', () => {
    // A pending task that got re-prioritized or had its notes edited is
    // bookkeeping, not active work. Should not block a yield.
    const tasks: YieldDetectionTask[] = [
      {
        owner: 'main',
        status: 'pending',
        createdAt: TURN_START - 500,
        updatedAt: TURN_START + 100,
      },
    ];
    const result = isYieldingToUser({
      lastAssistantText: 'What would you like to focus on first?',
      tasks,
      turnStartTime: TURN_START,
      turnEvents: [],
    });
    expect(result).toBe(true);
  });

  it('legitimate yield with only subagent (non-main) tasks still counts as yield', () => {
    // Subagent tasks are NOT part of the main-agent completion check, so they
    // should never block a yield.
    const tasks: YieldDetectionTask[] = [
      { owner: 'subagent', status: 'in_progress', createdAt: TURN_START - 500, updatedAt: TURN_START + 100 },
    ];
    const result = isYieldingToUser({
      lastAssistantText: 'What would you like to do next?',
      tasks,
      turnStartTime: TURN_START,
      turnEvents: [],
    });
    expect(result).toBe(true);
  });

  it('tasks where updatedAt > createdAt but updated before turn start → still yields', () => {
    // Pre-existing tasks touched in earlier turns shouldn't block this turn's
    // yield decision.
    const tasks: YieldDetectionTask[] = [
      {
        owner: 'main',
        status: 'pending',
        createdAt: TURN_START - 10_000,
        updatedAt: TURN_START - 5_000,
      },
    ];
    const result = isYieldingToUser({
      lastAssistantText: 'What would you like to focus on?',
      tasks,
      turnStartTime: TURN_START,
      turnEvents: [],
    });
    expect(result).toBe(true);
  });

  it('empty assistant text → does not yield (preserves completion-verification)', () => {
    expect(
      isYieldingToUser({
        lastAssistantText: '',
        tasks: [seededPendingTask()],
        turnStartTime: TURN_START,
        turnEvents: [],
      }),
    ).toBe(false);
  });

  it('no tasks + yield signal → yields (no tasks means nothing to complete)', () => {
    expect(
      isYieldingToUser({
        lastAssistantText: 'Let me know what you think of the output.',
        tasks: [],
        turnStartTime: TURN_START,
        turnEvents: [],
      }),
    ).toBe(true);
  });

  it('pending side-effect confirmation + no task work → yields', () => {
    const tasks: YieldDetectionTask[] = [seededPendingTask()];
    expect(
      isYieldingToUser({
        lastAssistantText: "Draft is ready. Want me to send it?",
        tasks,
        turnStartTime: TURN_START,
        turnEvents: [],
      }),
    ).toBe(true);
  });
});
