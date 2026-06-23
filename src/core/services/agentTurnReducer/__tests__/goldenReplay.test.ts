import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AgentEvent, AgentTurnMessage } from '@shared/types';
import { updateConversationWithEvent, type ConversationStateShape } from '../conversation';
import { applyEventToRuntime, createRuntimeState, type SessionRuntimeState } from '../runtime';
import { createInitialLiveTurnState, reduceLiveTurnState } from '../live';

type FixtureEvent = AgentEvent & { turnId?: string };
const fixturesRoot = path.resolve(process.cwd(), 'tests/golden-replays/agent-turn/fixtures');
const fixtureDirs = fs.readdirSync(fixturesRoot).filter((entry) => fs.statSync(path.join(fixturesRoot, entry)).isDirectory()).sort();

const readEvents = (fixture: string): FixtureEvent[] =>
  fs.readFileSync(path.join(fixturesRoot, fixture, 'events.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as FixtureEvent);

const projectCloud = (state: ReturnType<typeof createInitialLiveTurnState>) => ({
  isSending: state.isSending,
  streamingText: state.streamingText,
  statusText: state.statusText,
  activeTurnId: state.activeTurnId,
  completedSteps: state.completedSteps,
  missionContext: state.missionContext,
  taskProgress: state.taskProgress,
  subAgentItems: state.subAgentItems,
  error: state.error,
  hasMissionSet: state.hasMissionSet,
  touchedTaskIds: state.touchedTaskIds,
  userQuestionEventsByTurn: state.userQuestionEventsByTurn,
});

const projectDesktop = (conv: ConversationStateShape, runtime: SessionRuntimeState) => ({
  messages: conv.messages.map((message: AgentTurnMessage) => ({
    turnId: message.isWarning ? '<warning>' : message.turnId,
    role: message.role,
    text: message.text,
    isWarning: message.isWarning ?? false,
    isHidden: message.isHidden ?? false,
  })),
  activeTurnId: conv.activeTurnId,
  isBusy: conv.isBusy,
  lastError: conv.lastError,
  runtime: { activeTurnId: runtime.activeTurnId, terminated: runtime.terminated },
});

const replayCloud = (events: FixtureEvent[]) => {
  let state = createInitialLiveTurnState();
  return events.map((event, index) => {
    state = reduceLiveTurnState(
      state,
      event,
      { sessionId: 'session-1', turnId: state.activeTurnId ?? event.turnId ?? null, now: event.timestamp * 1000 },
      { humanizeError: ({ rawMessage }) => rawMessage },
    ).state;
    return { index, eventType: event.type, state: projectCloud(state) };
  });
};

const replayDesktop = (events: FixtureEvent[]) => {
  let conversation: ConversationStateShape = {
    messages: [],
    eventsByTurn: {},
    activeTurnId: null,
    focusedTurnId: null,
    isBusy: false,
    lastError: null,
    lastErrorSource: null,
    terminatedTurnIds: new Set(),
  };
  let runtime = createRuntimeState();
  let lastKnownTurnId = 'turn-1';
  return events.map((event, index) => {
    const turnId = event.turnId ?? conversation.activeTurnId ?? lastKnownTurnId;
    if (event.type === 'turn_started') lastKnownTurnId = turnId;
    conversation = updateConversationWithEvent(conversation, turnId, event);
    runtime = applyEventToRuntime(runtime, turnId, event);
    return { index, eventType: event.type, state: projectDesktop(conversation, runtime) };
  });
};

describe('agent turn golden replay fixtures', () => {
  it('has all required fixture streams', () => {
    expect(fixtureDirs).toEqual([
      '01-simple-turn',
      '02-tool-roundtrip',
      '03-mission-task',
      '04-todowrite-then-tasklist',
      '05-subagent',
      '06-error-classified',
      '07-error-supersede',
      '08-late-result',
      '09-cancellation',
      '10-context-overflow',
      '11-warning',
      '12-user-question',
      '13-multi-turn-same-session',
      '14-foreground-background-concurrent',
      '15-ws-replay-seq-gap',
      '16-ws-duplicate-events',
      '17-async-background-via-AgentOutputTool',
      '18-orphaned-sub-agent-end',
      '19-stopped-turn-partial-assistant',
      '20-warning-dedupe',
    ]);
  });

  it.each(fixtureDirs)('matches cloud baseline for %s', (fixture) => {
    const expected = JSON.parse(fs.readFileSync(path.join(fixturesRoot, fixture, 'expected-cloud.json'), 'utf8')) as { steps: unknown[] };
    expect(replayCloud(readEvents(fixture))).toEqual(expected.steps);
  });

  it.each(fixtureDirs)('matches desktop baseline for %s', (fixture) => {
    const expected = JSON.parse(fs.readFileSync(path.join(fixturesRoot, fixture, 'expected-desktop.json'), 'utf8')) as { steps: unknown[] };
    expect(replayDesktop(readEvents(fixture))).toEqual(expected.steps);
  });

  it.each(fixtureDirs)('keeps normalized terminal parity for %s', (fixture) => {
    const cloud = replayCloud(readEvents(fixture)).at(-1)?.state;
    const desktop = replayDesktop(readEvents(fixture)).at(-1)?.state;
    expect(cloud?.activeTurnId ?? null).toBe(desktop?.runtime.activeTurnId ?? null);
  });
});
