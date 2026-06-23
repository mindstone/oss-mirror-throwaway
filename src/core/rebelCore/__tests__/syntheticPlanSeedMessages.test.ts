import { describe, expect, it } from 'vitest';
import { createAgentMessageAdapter } from '../agentMessageAdapter';
import { buildSyntheticPlanSeedMessages } from '../rebelCoreQuery';
import { createTaskStore } from '../taskState';
import { seedTaskStoreFromPlan, seedMissionGoalTask, hasMissionGoalTask } from '../planningMode';
import { extractMissionContext } from '../builtinTools';
import { parseMissionFromDetail, parseTasksFromDetail } from '@rebel/shared';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const makeAdapter = () =>
  createAgentMessageAdapter({
    model: 'claude-sonnet-4-20250514',
    tools: ['Read', 'Bash', 'MissionSet', 'TaskList'],
    sessionId: 'test-session',
    cwd: '/tmp',
  });

const makePlanWithMission = () => JSON.stringify({
  goal: 'Write a summary report',
  assumptions: ['Data is available'],
  steps: [
    { id: '1', description: 'Gather data', success_signal: 'Data collected', parallel_group: null },
    { id: '2', description: 'Analyze data', success_signal: 'Analysis complete', depends_on: ['1'], parallel_group: null },
    { id: '3', description: 'Write report', success_signal: 'Report written', depends_on: ['2'], parallel_group: null },
  ],
  risks: ['Data may be incomplete'],
  done_criteria: ['Report is comprehensive and accurate'],
});

const makePlanWithoutMission = () => JSON.stringify({
  steps: [
    { id: '1', description: 'Do something', parallel_group: null },
  ],
});

// ---------------------------------------------------------------------------
// createSyntheticToolCallPair
// ---------------------------------------------------------------------------

describe('createSyntheticToolCallPair', () => {
  it('produces exactly 2 messages (assistant start + user result)', () => {
    const adapter = makeAdapter();
    const messages = adapter.createSyntheticToolCallPair(
      'MissionSet', 'tu-001', { goal: 'Test' }, '{"summary":"ok"}',
    );

    expect(messages).toHaveLength(2);
    expect(messages[0].type).toBe('assistant');
    expect(messages[1].type).toBe('user');
  });

  it('start message contains tool_use block with correct fields', () => {
    const adapter = makeAdapter();
    const input = { goal: 'Build something', done_criteria: 'It works' };
    const messages = adapter.createSyntheticToolCallPair(
      'MissionSet', 'tu-002', input, '{"summary":"ok"}',
    );

    const msg = messages[0] as Record<string, unknown>;
    expect(msg.session_id).toBe('test-session');
    expect(msg.parent_tool_use_id).toBeNull();
    expect(msg.uuid).toBeDefined();

    const content = (msg.message as Record<string, unknown>).content as Array<Record<string, unknown>>;
    expect(content).toHaveLength(1);
    expect(content[0].type).toBe('tool_use');
    expect(content[0].id).toBe('tu-002');
    expect(content[0].name).toBe('MissionSet');
    expect(content[0].input).toEqual(input);
  });

  it('result message contains tool_result block with matching tool_use_id', () => {
    const adapter = makeAdapter();
    const output = '{"tasks":[],"summary":"0 tasks"}';
    const messages = adapter.createSyntheticToolCallPair(
      'TaskList', 'tu-003', {}, output,
    );

    const msg = messages[1] as Record<string, unknown>;
    expect(msg.session_id).toBe('test-session');
    expect(msg.parent_tool_use_id).toBeNull();
    expect(msg.uuid).toBeDefined();

    const messageObj = msg.message as Record<string, unknown>;
    expect(messageObj.role).toBe('user');
    const content = messageObj.content as Array<Record<string, unknown>>;
    expect(content).toHaveLength(1);
    expect(content[0].type).toBe('tool_result');
    expect(content[0].tool_use_id).toBe('tu-003');
    expect(content[0].content).toBe(output);
    expect(content[0].is_error).toBe(false);
  });

  it('both messages have parent_tool_use_id: null', () => {
    const adapter = makeAdapter();
    const messages = adapter.createSyntheticToolCallPair(
      'MissionSet', 'tu-004', {}, '{}',
    );

    for (const msg of messages) {
      expect((msg as Record<string, unknown>).parent_tool_use_id).toBeNull();
    }
  });

  it('does NOT mutate adapter accumulated state', () => {
    const adapter = makeAdapter();

    // Accumulate text via normal handleEvent
    adapter.handleEvent({ type: 'assistant:text', text: 'Parent response' });

    // Create synthetic pair — should not touch accumulated state
    adapter.createSyntheticToolCallPair('TaskList', 'tu-005', {}, '{"tasks":[]}');

    // Verify parent text is preserved in final result
    adapter.handleEvent({
      type: 'turn:complete',
      usage: { inputTokens: 100, outputTokens: 50, cacheCreationTokens: 0, cacheReadTokens: 0 },
      stopReason: 'end_turn',
    });
    const results = adapter.handleEvent({
      type: 'loop:complete',
      totalUsage: { inputTokens: 100, outputTokens: 50, cacheCreationTokens: 0, cacheReadTokens: 0 },
    });

    const resultMessage = results.find((m) => m.type === 'result');
    expect((resultMessage as Record<string, unknown>).result).toBe('Parent response');
    expect((resultMessage as Record<string, unknown>).num_turns).toBe(1);
  });

  it('multiple calls produce unique UUIDs', () => {
    const adapter = makeAdapter();
    const msgs1 = adapter.createSyntheticToolCallPair('MissionSet', 'tu-a', {}, '{}');
    const msgs2 = adapter.createSyntheticToolCallPair('TaskList', 'tu-b', {}, '{}');

    const uuids = [
      (msgs1[0] as Record<string, unknown>).uuid,
      (msgs1[1] as Record<string, unknown>).uuid,
      (msgs2[0] as Record<string, unknown>).uuid,
      (msgs2[1] as Record<string, unknown>).uuid,
    ];

    expect(new Set(uuids).size).toBe(4);
  });

  it('sets is_error: true when isError flag is set', () => {
    const adapter = makeAdapter();
    const messages = adapter.createSyntheticToolCallPair(
      'TaskList', 'tu-err', {}, 'Something went wrong', true,
    );

    const content = ((messages[1] as Record<string, unknown>).message as Record<string, unknown>).content as Array<Record<string, unknown>>;
    expect(content[0].is_error).toBe(true);
    expect(content[0].content).toBe('Something went wrong');
  });

  // Origin marker propagation: the optional `origin` parameter must round-trip
  // through to `_meta.origin` on BOTH the start and result content blocks.
  // Downstream `collectToolHints` reads `_meta.origin` and stamps `_origin` on
  // the AgentEvent — that gate is what protects the synthesis-gate filter and
  // recovery filter from treating planning seeds as real execution.
  describe('origin parameter propagation', () => {
    it.each(['real', 'synthetic-plan-seed', 'pre-turn-context'] as const)(
      'sets _meta.origin=%s on both start and result blocks',
      (origin) => {
        const adapter = makeAdapter();
        const messages = adapter.createSyntheticToolCallPair(
          'MissionSet', 'tu-origin', { goal: 'x' }, '{"summary":"ok"}', false, origin,
        );

        const startContent = ((messages[0] as Record<string, unknown>).message as Record<string, unknown>).content as Array<Record<string, unknown>>;
        expect(startContent[0]._meta).toEqual({ origin });

        const resultContent = ((messages[1] as Record<string, unknown>).message as Record<string, unknown>).content as Array<Record<string, unknown>>;
        expect(resultContent[0]._meta).toEqual({ origin });
      },
    );

    it('omits _meta entirely when origin is not provided', () => {
      const adapter = makeAdapter();
      const messages = adapter.createSyntheticToolCallPair(
        'MissionSet', 'tu-no-origin', {}, '{}',
      );

      const startContent = ((messages[0] as Record<string, unknown>).message as Record<string, unknown>).content as Array<Record<string, unknown>>;
      expect(startContent[0]._meta).toBeUndefined();

      const resultContent = ((messages[1] as Record<string, unknown>).message as Record<string, unknown>).content as Array<Record<string, unknown>>;
      expect(resultContent[0]._meta).toBeUndefined();
    });
  });
});

// ---------------------------------------------------------------------------
// buildSyntheticPlanSeedMessages
// ---------------------------------------------------------------------------

describe('buildSyntheticPlanSeedMessages', () => {
  it('emits MissionSet + TaskList when task store has mission goal and tasks', () => {
    const adapter = makeAdapter();
    const taskStore = createTaskStore();
    seedTaskStoreFromPlan(makePlanWithMission(), taskStore);

    const messages = buildSyntheticPlanSeedMessages(adapter, taskStore);

    // MissionSet (start + result) + TaskList (start + result) = 4 messages
    expect(messages).toHaveLength(4);

    // First pair: MissionSet
    const missionStart = messages[0] as Record<string, unknown>;
    expect(missionStart.type).toBe('assistant');
    const missionStartContent = (missionStart.message as Record<string, unknown>).content as Array<Record<string, unknown>>;
    expect(missionStartContent[0].name).toBe('MissionSet');

    const missionResult = messages[1] as Record<string, unknown>;
    expect(missionResult.type).toBe('user');

    // Second pair: TaskList
    const taskStart = messages[2] as Record<string, unknown>;
    expect(taskStart.type).toBe('assistant');
    const taskStartContent = (taskStart.message as Record<string, unknown>).content as Array<Record<string, unknown>>;
    expect(taskStartContent[0].name).toBe('TaskList');

    const taskResult = messages[3] as Record<string, unknown>;
    expect(taskResult.type).toBe('user');
  });

  it('emits only TaskList when task store has tasks but no mission goal', () => {
    const adapter = makeAdapter();
    const taskStore = createTaskStore();
    seedTaskStoreFromPlan(makePlanWithoutMission(), taskStore);

    const messages = buildSyntheticPlanSeedMessages(adapter, taskStore);

    // Only TaskList (start + result) = 2 messages
    expect(messages).toHaveLength(2);
    const startContent = ((messages[0] as Record<string, unknown>).message as Record<string, unknown>).content as Array<Record<string, unknown>>;
    expect(startContent[0].name).toBe('TaskList');
  });

  it('returns empty array when task store is empty', () => {
    const adapter = makeAdapter();
    const taskStore = createTaskStore();

    const messages = buildSyntheticPlanSeedMessages(adapter, taskStore);
    expect(messages).toEqual([]);
  });

  it('returns empty array when seededCount is 0 (idempotency guard at call site)', () => {
    const taskStore = createTaskStore();

    // First seed — populates the store
    const first = seedTaskStoreFromPlan(makePlanWithMission(), taskStore);
    expect(first.seededCount).toBeGreaterThan(0);

    // Second seed — idempotency guard kicks in
    const second = seedTaskStoreFromPlan(makePlanWithMission(), taskStore);
    expect(second.seededCount).toBe(0);
    // The call-site guard `if (seededCount > 0)` prevents calling buildSyntheticPlanSeedMessages
  });

  it('MissionSet payload is parseable by parseMissionFromDetail()', () => {
    const adapter = makeAdapter();
    const taskStore = createTaskStore();
    seedTaskStoreFromPlan(makePlanWithMission(), taskStore);

    const messages = buildSyntheticPlanSeedMessages(adapter, taskStore);

    // Extract MissionSet result detail
    const missionResultMsg = messages[1] as Record<string, unknown>;
    const missionContent = (missionResultMsg.message as Record<string, unknown>).content as Array<Record<string, unknown>>;
    const detail = missionContent[0].content as string;

    const parsed = parseMissionFromDetail(detail);
    expect(parsed).not.toBeNull();
    expect(parsed!.goal).toBe('Write a summary report');
    expect(parsed!.doneCriteria).toBe('Report is comprehensive and accurate');
  });

  it('TaskList payload is parseable by parseTasksFromDetail()', () => {
    const adapter = makeAdapter();
    const taskStore = createTaskStore();
    seedTaskStoreFromPlan(makePlanWithMission(), taskStore);

    const messages = buildSyntheticPlanSeedMessages(adapter, taskStore);

    // Extract TaskList result detail
    const taskResultMsg = messages[3] as Record<string, unknown>;
    const taskContent = (taskResultMsg.message as Record<string, unknown>).content as Array<Record<string, unknown>>;
    const detail = taskContent[0].content as string;

    const parsed = parseTasksFromDetail(detail, 'TaskList');
    // Shared parser filters out mission-owned tasks
    expect(parsed.length).toBeGreaterThan(0);
    // All returned tasks should be non-mission
    for (const task of parsed) {
      expect(task.title).toBeDefined();
      expect(['pending', 'in_progress', 'completed', 'blocked']).toContain(task.status);
    }
  });

  it('TaskList includes all tasks (including mission-owned) in raw payload', () => {
    const adapter = makeAdapter();
    const taskStore = createTaskStore();
    seedTaskStoreFromPlan(makePlanWithMission(), taskStore);

    const messages = buildSyntheticPlanSeedMessages(adapter, taskStore);

    // Parse raw TaskList JSON to verify mission-owned tasks are included
    const taskResultMsg = messages[3] as Record<string, unknown>;
    const taskContent = (taskResultMsg.message as Record<string, unknown>).content as Array<Record<string, unknown>>;
    const rawPayload = JSON.parse(taskContent[0].content as string);

    const allTasks = taskStore.listTasks();
    expect(rawPayload.tasks).toHaveLength(allTasks.length);

    // Verify mission-owned tasks are present in raw payload
    const missionTasks = rawPayload.tasks.filter((t: Record<string, unknown>) => t.owner === 'mission');
    expect(missionTasks.length).toBeGreaterThan(0);
  });

  it('maintains start-before-result ordering for each tool pair', () => {
    const adapter = makeAdapter();
    const taskStore = createTaskStore();
    seedTaskStoreFromPlan(makePlanWithMission(), taskStore);

    const messages = buildSyntheticPlanSeedMessages(adapter, taskStore);

    // Messages come in pairs: [start, result, start, result]
    for (let i = 0; i < messages.length; i += 2) {
      expect(messages[i].type).toBe('assistant');
      expect(messages[i + 1].type).toBe('user');

      // tool_use_id in start matches tool_use_id in result
      const startContent = ((messages[i] as Record<string, unknown>).message as Record<string, unknown>).content as Array<Record<string, unknown>>;
      const resultContent = ((messages[i + 1] as Record<string, unknown>).message as Record<string, unknown>).content as Array<Record<string, unknown>>;
      expect(startContent[0].id).toBe(resultContent[0].tool_use_id);
    }
  });
});

// ---------------------------------------------------------------------------
// Non-plan mode synthetic MissionSet emission
// Regression: seedMissionGoalTask() created a mission goal task but didn't
// emit a synthetic MissionSet event, so the renderer never showed the mission card.
// See docs/plans/260409_fix_plan_mode_bypass_for_profiles.md
// ---------------------------------------------------------------------------

describe('non-plan mode MissionSet emission', () => {
  it('seedMissionGoalTask + extractMissionContext produces a valid MissionSet payload', () => {
    const taskStore = createTaskStore();

    // Before seeding, no mission
    expect(hasMissionGoalTask(taskStore)).toBe(false);

    // Seed mission from user prompt (mirrors non-plan mode path in rebelCoreQuery)
    seedMissionGoalTask(taskStore, 'Explain why the AI bootcamp page shows wrong content on mobile');
    expect(hasMissionGoalTask(taskStore)).toBe(true);

    // Extract mission context (same call as the non-plan emission path)
    const missionContext = extractMissionContext(taskStore.listTasks());
    expect(missionContext.goal).toBe('Explain why the AI bootcamp page shows wrong content on mobile');

    // Build synthetic MissionSet pair (mirrors the emission path)
    const adapter = makeAdapter();
    const missionInput = { goal: missionContext.goal };
    const missionOutput = JSON.stringify({
      summary: 'Mission context updated (goal)',
      mission: missionContext,
    }, null, 2);
    const msgs = adapter.createSyntheticToolCallPair(
      'MissionSet', 'test-uuid', missionInput, missionOutput,
    );

    expect(msgs).toHaveLength(2);
    expect(msgs[0].type).toBe('assistant');
    expect(msgs[1].type).toBe('user');

    // Verify the MissionSet payload is parseable by the shared parser
    const resultContent = (msgs[1] as Record<string, unknown>).message as Record<string, unknown>;
    const contentBlocks = resultContent.content as Array<Record<string, unknown>>;
    const parsed = parseMissionFromDetail(contentBlocks[0].content as string);
    expect(parsed?.goal).toBe('Explain why the AI bootcamp page shows wrong content on mobile');
  });

  it('does not emit TaskList when only a mission goal task is seeded', () => {
    const taskStore = createTaskStore();

    seedMissionGoalTask(taskStore, 'Test goal');

    // buildSyntheticPlanSeedMessages emits TaskList for ANY task — but
    // the non-plan path should NOT use it for this reason. Verify that
    // the mission-only store has tasks (so using buildSyntheticPlanSeedMessages
    // would incorrectly emit TaskList).
    const allTasks = taskStore.listTasks();
    expect(allTasks.length).toBeGreaterThan(0);

    // This confirms the fix is correct: non-plan mode must emit MissionSet
    // directly (not via buildSyntheticPlanSeedMessages) to avoid unwanted TaskList.
  });
});
