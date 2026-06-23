import { unsafeAssertRoutingModelId } from '@shared/utils/modelChoiceCodec';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import {
  buildExecutionSystemPrompt,
  resolveRuntimeModels,
  seedTaskStoreFromPlan,
  extractJsonFromModelOutput,
  parseDirectAnswer,
  runPlanningPhase,
  extractRoutingFromPlan,
  buildEligibleRoutingModelIds,
  buildPlanningRoutingPool,
  buildRoutingPromptAddendum,
  normalizePlanningSubAgents,
  derivePlanParallelGroups,
  PLAN_OUTPUT_FORMAT,
  PLAN_RESPONSE_SCHEMA_OPENAI_STRICT,
} from '../planningMode';
import { PARALLEL_AGENT_CAP } from '../constants/limits';
import type { ModelClient } from '../modelClient';
import { ModelError } from '../modelErrors';
import { getModelRuntimeRoleMetadata } from '../configuredRoleFallback';
import type { ProviderCapabilities } from '../contextPolicy';
import { createTaskStore } from '../taskState';
import { configurePromptFileService, _resetForTesting } from '@core/services/promptFileService';
import { setErrorReporter, type ErrorReporter } from '@core/errorReporter';
import type { AppSettings, ModelProfile } from '@shared/types';
import { modelSupportsReasoning } from '@shared/data/modelProviderPresets';

const silentReporter: ErrorReporter = {
  captureException: () => {},
  captureMessage: () => {},
  addBreadcrumb: () => {},
};

beforeEach(() => {
  _resetForTesting();
  configurePromptFileService(path.resolve(__dirname, '../../../..', 'rebel-system', 'prompts'));
  setErrorReporter(silentReporter);
});

afterEach(() => {
  _resetForTesting();
  setErrorReporter(silentReporter);
});

const TEST_CAPABILITIES: ProviderCapabilities = {
  hasNativeContextEditing: false,
  hasNativeCompaction: false,
  cacheStrategy: 'none',
  cacheHeuristicTtlMs: 0,
  supportsImageContent: () => false,
};

const TEST_SETTINGS: AppSettings = {
  coreDirectory: null,
  mcpConfigFile: null,
  onboardingCompleted: true,
  userEmail: null,
  onboardingFirstCompletedAt: null,
  voice: { enabled: false },
  models: {
    apiKey: 'fake-ant-test',
    oauthToken: null,
    authMethod: 'api-key',
    model: unsafeAssertRoutingModelId('claude-sonnet-4-6'),
    thinkingModel: 'claude-opus-4-7',
    thinkingProfileId: null,
    workingProfileId: null,
    permissionMode: 'plan',
    executablePath: null,
    planMode: true,
    extendedContext: false,
  },
  localModel: { activeProfileId: null, profiles: [] },
  diagnostics: { enabled: false },
} as unknown as AppSettings;

describe('planningMode', () => {
  describe('resolveRuntimeModels', () => {
    it('uses a direct model unchanged when not in plan mode', () => {
      expect(
        resolveRuntimeModels({
          model: unsafeAssertRoutingModelId('claude-sonnet-4-6[1m]'),
          settings: TEST_SETTINGS,
        } as any),
      ).toEqual({
        isPlanMode: false,
        displayModel: 'claude-sonnet-4-6',
        executionModel: 'claude-sonnet-4-6',
        planningModel: null,
      });
    });

    it('splits planner alias into planning and execution models', () => {
      expect(
        resolveRuntimeModels({
          model: unsafeAssertRoutingModelId('planner'),
          env: {
            PLANNING_MODEL: 'claude-opus-4-7[1m]',
            EXECUTION_MODEL: 'claude-sonnet-4-6[1m]',
          },
          settings: TEST_SETTINGS,
        } as any),
      ).toEqual({
        isPlanMode: true,
        displayModel: 'claude-sonnet-4-6',
        executionModel: 'claude-sonnet-4-6',
        planningModel: unsafeAssertRoutingModelId('claude-opus-4-7'),
      });
    });
  });

  describe('buildExecutionSystemPrompt', () => {
    it('appends the hidden execution plan to a string system prompt', () => {
      const result = buildExecutionSystemPrompt(
        'Base system prompt',
        '{"goal":"test"}',
        'claude-opus-4-7',
        '{"tasks":[{"id":"1","title":"Do the work","status":"in_progress"}]}',
      );

      expect(result).toContain('Base system prompt');
      expect(result).toContain('<rebel_core_execution_plan>');
      expect(result).toContain('<rebel_core_seeded_tasks>');
      expect(result).toContain('{"goal":"test"}');
      expect(result).toContain('claude-opus-4-7');
      expect(result).toContain('TaskCreate, TaskUpdate, and TaskList');
    });

    it('includes self-check instruction in execution prompt', () => {
      const result = buildExecutionSystemPrompt('Base system prompt', '{"goal":"test"}', 'claude-opus-4-7');

      expect(result).toContain('Before ending your turn, verify');
      expect(result).toContain('execution tasks you created are marked completed');
      expect(result).toContain('done_criteria');
    });

    it('includes adaptive routing context when provided', () => {
      const result = buildExecutionSystemPrompt('Base system prompt', '{"goal":"test"}', 'claude-opus-4-7', undefined, {
        model: unsafeAssertRoutingModelId('claude-haiku-4-20250414'),
        profileName: 'Haiku',
        escalation: {
          atStep: 'step-2',
          toModel: 'claude-sonnet-4-20250514',
          reason: 'needs synthesis',
        },
      });

      expect(result).toContain('MODEL ROUTING');
      expect(result).toContain('Current model: claude-haiku-4-20250414 (Haiku).');
      expect(result).toContain('At step step-2, the planner recommends escalating');
      expect(result).toContain('because: needs synthesis');
    });

    it('omits parallel execution guidance when no groups are provided', () => {
      const withoutGroups = buildExecutionSystemPrompt(
        'Base system prompt',
        '{"goal":"test"}',
        'claude-opus-4-7',
      );
      const withEmptyGroups = buildExecutionSystemPrompt(
        'Base system prompt',
        '{"goal":"test"}',
        'claude-opus-4-7',
        undefined,
        undefined,
        [],
      );

      expect(withoutGroups).not.toContain('PARALLEL EXECUTION:');
      expect(withEmptyGroups).not.toContain('PARALLEL EXECUTION:');
    });

    it('renders parallel execution guidance for a single group', () => {
      const result = buildExecutionSystemPrompt(
        'Base system prompt',
        '{"goal":"test"}',
        'claude-opus-4-7',
        undefined,
        undefined,
        [{
          groupId: 'g1',
          memberStepIds: ['r1', 'r2'],
          suggestedTools: ['Read', 'WebSearch'],
        }],
      );

      expect(result).toContain('PARALLEL EXECUTION:');
      expect(result).toContain('Groups:');
      expect(result).toContain('- g1: steps r1, r2 (suggested tools: Read, WebSearch)');
      expect(typeof result).toBe('string');
      if (typeof result !== 'string') {
        throw new Error('Expected string execution prompt');
      }
      expect(result.indexOf('PARALLEL EXECUTION:')).toBeLessThan(result.indexOf('<rebel_core_execution_plan>'));
    });

    it('renders multiple groups with suggested tools', () => {
      const result = buildExecutionSystemPrompt(
        'Base system prompt',
        '{"goal":"test"}',
        'claude-opus-4-7',
        undefined,
        undefined,
        [
          {
            groupId: 'g1',
            memberStepIds: ['r1', 'r2'],
            suggestedTools: ['Read', 'WebSearch'],
          },
          {
            groupId: 'g2',
            memberStepIds: ['s1', 's2'],
            suggestedTools: ['TaskList'],
          },
        ],
      );

      expect(result).toContain('- g1: steps r1, r2 (suggested tools: Read, WebSearch)');
      expect(result).toContain('- g2: steps s1, s2 (suggested tools: TaskList)');
    });

    it('omits parenthetical details when a group has no suggested tools', () => {
      const result = buildExecutionSystemPrompt(
        'Base system prompt',
        '{"goal":"test"}',
        'claude-opus-4-7',
        undefined,
        undefined,
        [{
          groupId: 'g1',
          memberStepIds: ['r1', 'r2', 'r3'],
          suggestedTools: [],
        }],
      );

      expect(result).toContain('- g1: steps r1, r2, r3');
      expect(result).not.toContain('- g1: steps r1, r2, r3 (');
    });

    it('supports parallel execution guidance when base prompt is ContentBlock[]', () => {
      const result = buildExecutionSystemPrompt(
        [{ type: 'text', text: 'Base block' }] as any,
        '{"goal":"test"}',
        'claude-opus-4-7',
        undefined,
        undefined,
        [{
          groupId: 'g1',
          memberStepIds: ['r1', 'r2'],
          suggestedTools: ['Read'],
        }],
      );

      expect(Array.isArray(result)).toBe(true);
      expect(result as any[]).toHaveLength(2);
      expect((result as any[])[1].text).toContain('PARALLEL EXECUTION:');
      expect((result as any[])[1].text).toContain('- g1: steps r1, r2 (suggested tools: Read)');
    });

    it('uses PARALLEL_AGENT_CAP in prompt guidance and updated pivot wording', () => {
      const result = buildExecutionSystemPrompt(
        'Base system prompt',
        '{"goal":"test"}',
        'claude-opus-4-7',
        undefined,
        undefined,
        [{
          groupId: 'g1',
          memberStepIds: ['r1', 'r2'],
          suggestedTools: ['Read'],
        }],
      );

      expect(result).toContain(`The runtime caps concurrent sub-agent dispatches at ${PARALLEL_AGENT_CAP} per turn`);
      expect(result).toContain(`declares more than ${PARALLEL_AGENT_CAP} Agent calls`);
      expect(result).toContain('If results from a parallel group invalidate plans for follow-up steps, you');
      expect(result).toContain('may pivot in subsequent turns — describe the pivot and adjust task');
      expect(result).not.toContain('If an early result inside a parallel group invalidates a later member');
    });

    it('renders derivePlanParallelGroups output consistently for fixture plans', () => {
      const fixtureSteps = [
        {
          id: 'r1',
          description: 'Research source A',
          parallel_group: 'g1',
          suggested_tools: ['Read', 'WebSearch'],
          sub_agents: [{ task: 'research A', model: unsafeAssertRoutingModelId('gpt-5.5') }],
        },
        {
          id: 'r2',
          description: 'Research source B',
          parallel_group: 'g1',
          suggested_tools: ['Read'],
          sub_agents: [{ task: 'review B', model: unsafeAssertRoutingModelId('gpt-5.5') }],
        },
        {
          id: 's1',
          description: 'Synthesize output',
          parallel_group: 'g2',
          suggested_tools: ['TaskList'],
          sub_agents: [],
        },
        {
          id: 's2',
          description: 'Cross-check synthesis',
          parallel_group: 'g2',
          suggested_tools: ['TaskUpdate'],
          sub_agents: [],
        },
      ] as Array<{
        id: string;
        description: string;
        parallel_group: string;
        suggested_tools: string[];
        sub_agents: Array<{ task: string; model: string }>;
      }>;

      const derivedParallelGroups = Array.from(derivePlanParallelGroups(fixtureSteps as any).entries()).map(
        ([groupId, memberStepIds]) => {
          const memberStepIdSet = new Set(memberStepIds);
          const memberSteps = fixtureSteps.filter((step) => memberStepIdSet.has(step.id));
          const suggestedTools = Array.from(new Set(memberSteps.flatMap((step) => step.suggested_tools ?? [])));
          return { groupId, memberStepIds, suggestedTools };
        },
      );

      const result = buildExecutionSystemPrompt(
        'Base system prompt',
        '{"goal":"test"}',
        'claude-opus-4-7',
        undefined,
        undefined,
        derivedParallelGroups,
      );

      expect(result).toContain('- g1: steps r1, r2 (suggested tools: Read, WebSearch)');
      expect(result).toContain('- g2: steps s1, s2 (suggested tools: TaskList, TaskUpdate)');
      expect(result).not.toContain('sub-agents:');
    });

    it('does not render sub-agent metadata from schema-correct sub_agents arrays', () => {
      const fixtureSteps = [
        {
          id: 'r1',
          description: 'Research source A',
          parallel_group: 'g1',
          suggested_tools: ['Read'],
          sub_agents: [{ task: 'Use researcher-gpt5.5-high to gather facts', model: unsafeAssertRoutingModelId('gpt-5.5') }],
        },
        {
          id: 'r2',
          description: 'Research source B',
          parallel_group: 'g1',
          suggested_tools: ['WebSearch'],
          sub_agents: [{ task: 'Use reviewer-gpt5.5-high to verify findings', model: unsafeAssertRoutingModelId('gpt-5.5') }],
        },
      ];

      const derivedParallelGroups = Array.from(derivePlanParallelGroups(fixtureSteps as any).entries()).map(
        ([groupId, memberStepIds]) => {
          const memberStepIdSet = new Set(memberStepIds);
          const memberSteps = fixtureSteps.filter((step) => memberStepIdSet.has(step.id));
          const suggestedTools = Array.from(new Set(memberSteps.flatMap((step) => step.suggested_tools ?? [])));
          return { groupId, memberStepIds, suggestedTools };
        },
      );

      const result = buildExecutionSystemPrompt(
        'Base system prompt',
        '{"goal":"test"}',
        'claude-opus-4-7',
        undefined,
        undefined,
        derivedParallelGroups,
      );

      expect(result).toContain('- g1: steps r1, r2 (suggested tools: Read, WebSearch)');
      expect(result).not.toContain('sub-agents:');
    });

    it('preserves structured system prompts', () => {
      const result = buildExecutionSystemPrompt(
        [{ type: 'text', text: 'Base block' }] as any,
        '{"goal":"test"}',
        'claude-opus-4-7',
      );

      expect(Array.isArray(result)).toBe(true);
      expect(result as any[]).toHaveLength(2);
      expect((result as any[])[1].text).toContain('<rebel_core_execution_plan>');
    });
  });

  describe('seedTaskStoreFromPlan', () => {
    it('hydrates strict-schema plans with parallel_group: null', () => {
      const taskStore = createTaskStore();
      const planText = JSON.stringify({
        type: 'plan',
        confidence: null,
        answer: null,
        reasoning: null,
        goal: 'Discriminated plan',
        assumptions: [],
        steps: [
          {
            id: 'step-1',
            description: 'Do the work',
            success_signal: null,
            suggested_tools: [],
            depends_on: [],
            parallel_group: null,
            model: null,
            effort: null,
            sub_agents: null,
          },
        ],
        risks: [],
        done_criteria: [],
        routing: null,
      });

      const seeded = seedTaskStoreFromPlan(planText, taskStore);

      expect(seeded.seededCount).toBe(1);
      const missionTask = taskStore.listTasks().find((t) => t.owner === 'mission');
      expect(missionTask?.title).toBe('Discriminated plan');
    });

    it('hydrates strict-schema plans with parallel_group: "g1"', () => {
      const taskStore = createTaskStore();
      const planText = JSON.stringify({
        type: 'plan',
        confidence: null,
        answer: null,
        reasoning: null,
        goal: 'Grouped plan',
        assumptions: [],
        steps: [
          {
            id: 'step-1',
            description: 'Gather facts A',
            success_signal: null,
            suggested_tools: [],
            depends_on: [],
            parallel_group: 'g1',
            model: null,
            effort: null,
            sub_agents: null,
          },
          {
            id: 'step-2',
            description: 'Gather facts B',
            success_signal: null,
            suggested_tools: [],
            depends_on: [],
            parallel_group: 'g1',
            model: null,
            effort: null,
            sub_agents: null,
          },
        ],
        risks: [],
        done_criteria: [],
        routing: null,
      });

      const seeded = seedTaskStoreFromPlan(planText, taskStore);

      expect(seeded.seededCount).toBe(2);
    });

    it('persists planner parallel_group values onto seeded tasks as parallelGroup', () => {
      const taskStore = createTaskStore();
      const planText = JSON.stringify({
        goal: 'Grouped plan',
        steps: [
          { id: 'step-1', description: 'Gather facts A', parallel_group: 'g1' },
          { id: 'step-2', description: 'Gather facts B', parallel_group: 'g1' },
        ],
      });

      const seeded = seedTaskStoreFromPlan(planText, taskStore);
      expect(seeded.seededCount).toBe(2);

      const nonMissionTasks = taskStore.listTasks().filter((task) => task.owner !== 'mission');
      expect(nonMissionTasks).toHaveLength(2);
      expect(nonMissionTasks[0]?.parallelGroup).toBe('g1');
      expect(nonMissionTasks[1]?.parallelGroup).toBe('g1');
    });

    it('does not persist parallelGroup for singleton groups filtered by derivePlanParallelGroups', () => {
      const taskStore = createTaskStore();
      const planText = JSON.stringify({
        goal: 'Singleton group plan',
        steps: [
          { id: 'step-1', description: 'Only member', parallel_group: 'g1' },
          { id: 'step-2', description: 'Follow-up step' },
        ],
      });

      const seeded = seedTaskStoreFromPlan(planText, taskStore);
      expect(seeded.seededCount).toBe(2);

      const nonMissionTasks = taskStore.listTasks().filter((task) => task.owner !== 'mission');
      expect(nonMissionTasks).toHaveLength(2);
      expect(Object.prototype.hasOwnProperty.call(nonMissionTasks[0], 'parallelGroup')).toBe(false);
    });

    it('does not persist parallelGroup for malformed sibling-dependent groups', () => {
      const taskStore = createTaskStore();
      const planText = JSON.stringify({
        goal: 'Malformed group plan',
        steps: [
          { id: 'step-1', description: 'Group member A', parallel_group: 'g1' },
          { id: 'step-2', description: 'Group member B', parallel_group: 'g1', depends_on: ['step-1'] },
        ],
      });

      const seeded = seedTaskStoreFromPlan(planText, taskStore);
      expect(seeded.seededCount).toBe(2);

      const nonMissionTasks = taskStore.listTasks().filter((task) => task.owner !== 'mission');
      expect(nonMissionTasks).toHaveLength(2);
      expect(Object.prototype.hasOwnProperty.call(nonMissionTasks[0], 'parallelGroup')).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(nonMissionTasks[1], 'parallelGroup')).toBe(false);
    });

    it('omits parallelGroup when planner step omits parallel_group or sets null', () => {
      const taskStore = createTaskStore();
      const planText = JSON.stringify({
        goal: 'Ungrouped plan',
        steps: [
          { id: 'step-1', description: 'Sequential 1' },
          { id: 'step-2', description: 'Sequential 2', parallel_group: null },
        ],
      });

      const seeded = seedTaskStoreFromPlan(planText, taskStore);
      expect(seeded.seededCount).toBe(2);

      const nonMissionTasks = taskStore.listTasks().filter((task) => task.owner !== 'mission');
      expect(nonMissionTasks).toHaveLength(2);
      expect(Object.prototype.hasOwnProperty.call(nonMissionTasks[0], 'parallelGroup')).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(nonMissionTasks[1], 'parallelGroup')).toBe(false);
    });

    it('treats empty-string parallel_group values as absent when seeding tasks', () => {
      const taskStore = createTaskStore();
      const planText = JSON.stringify({
        goal: 'Empty group field',
        steps: [
          { id: 'step-1', description: 'Step A', parallel_group: '' },
          { id: 'step-2', description: 'Step B', parallel_group: '   ' },
        ],
      });

      const seeded = seedTaskStoreFromPlan(planText, taskStore);
      expect(seeded.seededCount).toBe(2);

      const nonMissionTasks = taskStore.listTasks().filter((task) => task.owner !== 'mission');
      expect(nonMissionTasks).toHaveLength(2);
      expect(Object.prototype.hasOwnProperty.call(nonMissionTasks[0], 'parallelGroup')).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(nonMissionTasks[1], 'parallelGroup')).toBe(false);
    });

    it('hydrates planner steps into execution tasks with dependencies', () => {
      const taskStore = createTaskStore();
      const planText = JSON.stringify({
        goal: 'Ship the change',
        steps: [
          {
            id: 'step-1',
            description: 'Inspect the current runtime',
            success_signal: 'Known gaps captured',
            parallel_group: null,
          },
          {
            id: 'step-2',
            description: 'Implement task seeding',
            depends_on: ['step-1'],
            parallel_group: null,
          },
        ],
      });

      const seeded = seedTaskStoreFromPlan(planText, taskStore);

      expect(seeded.seededCount).toBe(2);
      expect(seeded.seededTasksText).toContain('"title": "Inspect the current runtime"');

      const tasks = taskStore.listTasks();
      expect(tasks).toHaveLength(3);
      expect(tasks[0].status).toBe('in_progress');
      expect(tasks[1].status).toBe('blocked');
      expect(tasks[1].blockers).toEqual([tasks[0].id]);
      expect(seeded.stepIdToTaskIdMap.get('step-1')).toBe(tasks[0].id);
      expect(seeded.stepIdToTaskIdMap.get('step-2')).toBe(tasks[1].id);

      const missionTask = tasks.find((t) => t.owner === 'mission');
      expect(missionTask).toBeDefined();
      expect(missionTask!.title).toBe('Ship the change');
    });

    it('expands parallel_group dependency blockers to all group member task IDs', () => {
      const taskStore = createTaskStore();
      const planText = JSON.stringify({
        goal: 'Ship the change',
        steps: [
          { id: 's1', description: 'Gather source A', parallel_group: 'g1' },
          { id: 's2', description: 'Gather source B', parallel_group: 'g1' },
          { id: 's3', description: 'Synthesize findings', depends_on: ['g1'], parallel_group: null },
        ],
      });

      const seeded = seedTaskStoreFromPlan(planText, taskStore);
      expect(seeded.seededCount).toBe(3);

      const tasks = taskStore.listTasks().filter((task) => task.owner !== 'mission');
      expect(tasks).toHaveLength(3);
      expect(tasks[2].blockers).toEqual(expect.arrayContaining([tasks[0].id, tasks[1].id]));
      expect(tasks[2].blockers).toHaveLength(2);
    });

    it('expands cross-group depends_on blockers to all members of the referenced group', () => {
      const taskStore = createTaskStore();
      const planText = JSON.stringify({
        goal: 'Cross-group dependency',
        steps: [
          { id: 's1', description: 'Group 1 / A', parallel_group: 'g1' },
          { id: 's2', description: 'Group 1 / B', parallel_group: 'g1' },
          { id: 's3', description: 'Group 2 / A', parallel_group: 'g2', depends_on: ['g1'] },
          { id: 's4', description: 'Group 2 / B', parallel_group: 'g2', depends_on: ['g1'] },
        ],
      });

      const seeded = seedTaskStoreFromPlan(planText, taskStore);
      expect(seeded.seededCount).toBe(4);

      const s1TaskId = seeded.stepIdToTaskIdMap.get('s1');
      const s2TaskId = seeded.stepIdToTaskIdMap.get('s2');
      const s3TaskId = seeded.stepIdToTaskIdMap.get('s3');
      const s4TaskId = seeded.stepIdToTaskIdMap.get('s4');

      expect(s1TaskId).toBeDefined();
      expect(s2TaskId).toBeDefined();
      expect(s3TaskId).toBeDefined();
      expect(s4TaskId).toBeDefined();

      const tasksById = new Map(taskStore.listTasks().map((task) => [task.id, task]));
      expect(tasksById.get(s3TaskId!)?.blockers).toEqual(expect.arrayContaining([s1TaskId!, s2TaskId!]));
      expect(tasksById.get(s3TaskId!)?.blockers).toHaveLength(2);
      expect(tasksById.get(s4TaskId!)?.blockers).toEqual(expect.arrayContaining([s1TaskId!, s2TaskId!]));
      expect(tasksById.get(s4TaskId!)?.blockers).toHaveLength(2);
    });

    it('expands forward-referenced group dependencies using two-pass seeding', () => {
      const taskStore = createTaskStore();
      const planText = JSON.stringify({
        goal: 'Forward-reference group dependency',
        steps: [
          { id: 'synthesis', description: 'Synthesize results', depends_on: ['g1'] },
          { id: 'r1', description: 'Research 1', parallel_group: 'g1' },
          { id: 'r2', description: 'Research 2', parallel_group: 'g1' },
        ],
      });

      const seeded = seedTaskStoreFromPlan(planText, taskStore);
      expect(seeded.seededCount).toBe(3);

      const synthesisTaskId = seeded.stepIdToTaskIdMap.get('synthesis');
      const r1TaskId = seeded.stepIdToTaskIdMap.get('r1');
      const r2TaskId = seeded.stepIdToTaskIdMap.get('r2');
      expect(synthesisTaskId).toBeDefined();
      expect(r1TaskId).toBeDefined();
      expect(r2TaskId).toBeDefined();

      const tasksById = new Map(taskStore.listTasks().map((task) => [task.id, task]));
      expect(tasksById.get(synthesisTaskId!)?.blockers).toEqual(expect.arrayContaining([r1TaskId!, r2TaskId!]));
      expect(tasksById.get(synthesisTaskId!)?.blockers).toHaveLength(2);
    });

    it('expands singleton-group depends_on blockers even when the parallel helper filters singleton groups', () => {
      const taskStore = createTaskStore();
      const planText = JSON.stringify({
        goal: 'Singleton group expansion',
        steps: [
          { id: 's1', description: 'Only member', parallel_group: 'g1' },
          { id: 's2', description: 'Depends on singleton group', depends_on: ['g1'] },
        ],
      });

      const seeded = seedTaskStoreFromPlan(planText, taskStore);
      expect(seeded.seededCount).toBe(2);

      const s1TaskId = seeded.stepIdToTaskIdMap.get('s1');
      const s2TaskId = seeded.stepIdToTaskIdMap.get('s2');
      expect(s1TaskId).toBeDefined();
      expect(s2TaskId).toBeDefined();

      const tasksById = new Map(taskStore.listTasks().map((task) => [task.id, task]));
      expect(tasksById.get(s2TaskId!)?.blockers).toEqual([s1TaskId!]);
    });

    it('expands malformed-group depends_on blockers for seeding even when parallel helper filters malformed groups', () => {
      const taskStore = createTaskStore();
      const planText = JSON.stringify({
        goal: 'Malformed group expansion',
        steps: [
          { id: 's1', description: 'Group member 1', parallel_group: 'g1' },
          { id: 's2', description: 'Group member 2 (malformed)', parallel_group: 'g1', depends_on: ['s1'] },
          { id: 's3', description: 'Depends on malformed group', depends_on: ['g1'] },
        ],
      });

      const seeded = seedTaskStoreFromPlan(planText, taskStore);
      expect(seeded.seededCount).toBe(3);

      const s1TaskId = seeded.stepIdToTaskIdMap.get('s1');
      const s2TaskId = seeded.stepIdToTaskIdMap.get('s2');
      const s3TaskId = seeded.stepIdToTaskIdMap.get('s3');
      expect(s1TaskId).toBeDefined();
      expect(s2TaskId).toBeDefined();
      expect(s3TaskId).toBeDefined();

      const tasksById = new Map(taskStore.listTasks().map((task) => [task.id, task]));
      expect(tasksById.get(s3TaskId!)?.blockers).toEqual(expect.arrayContaining([s1TaskId!, s2TaskId!]));
      expect(tasksById.get(s3TaskId!)?.blockers).toHaveLength(2);
    });

    it('strips self-reference when malformed self-group dependencies expand blockers', async () => {
      const warnSpy = vi.fn();
      vi.resetModules();
       
      vi.doMock('@core/logger', async () => {
        const actual = await vi.importActual<typeof import('@core/logger')>('@core/logger');
        return {
          ...actual,
          createScopedLogger: () => ({
            trace: vi.fn(),
            debug: vi.fn(),
            info: vi.fn(),
            warn: warnSpy,
            error: vi.fn(),
            fatal: vi.fn(),
          }),
        };
      });

      try {
        const planningModeModule = await import('../planningMode');
        const steps = [
          { id: 's1', description: 'Malformed member', parallel_group: 'g1', depends_on: ['g1'] },
          { id: 's2', description: 'Sibling member', parallel_group: 'g1' },
        ];

        const groups = planningModeModule.derivePlanParallelGroups(steps);
        expect(groups.size).toBe(0);
        expect(warnSpy).toHaveBeenCalledWith(
          expect.objectContaining({
            groupId: 'g1',
            members: ['s1', 's2'],
            offendingStepId: 's1',
          }),
          'Parallel group has a member listing a sibling or own group as a dependency — ignoring group',
        );

        const taskStore = createTaskStore();
        const seeded = planningModeModule.seedTaskStoreFromPlan(
          JSON.stringify({
            goal: 'Self-group dependency regression',
            steps,
          }),
          taskStore,
        );

        const s1TaskId = seeded.stepIdToTaskIdMap.get('s1');
        const s2TaskId = seeded.stepIdToTaskIdMap.get('s2');
        expect(s1TaskId).toBeDefined();
        expect(s2TaskId).toBeDefined();

        const tasksById = new Map(
          taskStore
            .listTasks()
            .filter((task) => task.owner !== 'mission')
            .map((task) => [task.id, task]),
        );

        expect(tasksById.get(s1TaskId!)?.blockers).toEqual([s2TaskId!]);
        expect(tasksById.get(s1TaskId!)?.blockers).not.toContain(s1TaskId!);

        const seededTasks = JSON.parse(seeded.seededTasksText ?? '{"tasks":[]}') as {
          tasks: Array<{ id: string; status: string; blockers?: string[] }>;
        };
        const seededTasksById = new Map(seededTasks.tasks.map((task) => [task.id, task]));
        expect(seededTasksById.get(s1TaskId!)?.status).toBe('blocked');
        expect(seededTasksById.get(s2TaskId!)?.status).toBe('pending');
      } finally {
        vi.doUnmock('@core/logger');
        vi.resetModules();
      }
    });

    it('keeps valid groups while filtering one malformed group and avoids self-blocking in mixed fixtures', async () => {
      const warnSpy = vi.fn();
      vi.resetModules();
       
      vi.doMock('@core/logger', async () => {
        const actual = await vi.importActual<typeof import('@core/logger')>('@core/logger');
        return {
          ...actual,
          createScopedLogger: () => ({
            trace: vi.fn(),
            debug: vi.fn(),
            info: vi.fn(),
            warn: warnSpy,
            error: vi.fn(),
            fatal: vi.fn(),
          }),
        };
      });

      try {
        const planningModeModule = await import('../planningMode');
        const steps = [
          { id: 'v1', description: 'Valid group A / 1', parallel_group: 'g_valid_a' },
          { id: 'v2', description: 'Valid group A / 2', parallel_group: 'g_valid_a' },
          { id: 'v3', description: 'Valid group B / 1', parallel_group: 'g_valid_b' },
          { id: 'v4', description: 'Valid group B / 2', parallel_group: 'g_valid_b' },
          { id: 'm1', description: 'Malformed group member', parallel_group: 'g_malformed', depends_on: ['g_malformed'] },
          { id: 'm2', description: 'Malformed group sibling', parallel_group: 'g_malformed' },
          { id: 'consumer', description: 'Consumes valid + malformed groups', depends_on: ['g_valid_a', 'g_malformed'] },
        ];

        const groups = planningModeModule.derivePlanParallelGroups(steps);
        expect(Array.from(groups.entries())).toEqual([
          ['g_valid_a', ['v1', 'v2']],
          ['g_valid_b', ['v3', 'v4']],
        ]);
        expect(warnSpy).toHaveBeenCalledTimes(1);
        expect(warnSpy).toHaveBeenCalledWith(
          expect.objectContaining({
            groupId: 'g_malformed',
            members: ['m1', 'm2'],
            offendingStepId: 'm1',
          }),
          'Parallel group has a member listing a sibling or own group as a dependency — ignoring group',
        );

        const taskStore = createTaskStore();
        const seeded = planningModeModule.seedTaskStoreFromPlan(
          JSON.stringify({
            goal: 'Mixed groups fixture',
            steps,
          }),
          taskStore,
        );

        const v1TaskId = seeded.stepIdToTaskIdMap.get('v1');
        const v2TaskId = seeded.stepIdToTaskIdMap.get('v2');
        const m1TaskId = seeded.stepIdToTaskIdMap.get('m1');
        const m2TaskId = seeded.stepIdToTaskIdMap.get('m2');
        const consumerTaskId = seeded.stepIdToTaskIdMap.get('consumer');
        expect(v1TaskId).toBeDefined();
        expect(v2TaskId).toBeDefined();
        expect(m1TaskId).toBeDefined();
        expect(m2TaskId).toBeDefined();
        expect(consumerTaskId).toBeDefined();

        const tasksById = new Map(
          taskStore
            .listTasks()
            .filter((task) => task.owner !== 'mission')
            .map((task) => [task.id, task]),
        );

        expect(tasksById.get(consumerTaskId!)?.blockers).toEqual(
          expect.arrayContaining([v1TaskId!, v2TaskId!, m1TaskId!, m2TaskId!]),
        );
        expect(tasksById.get(consumerTaskId!)?.blockers).toHaveLength(4);
        expect(tasksById.get(m1TaskId!)?.blockers).toEqual([m2TaskId!]);
        expect(tasksById.get(m1TaskId!)?.blockers).not.toContain(m1TaskId!);
      } finally {
        vi.doUnmock('@core/logger');
        vi.resetModules();
      }
    });

    it('continues resolving single-step dependencies unchanged', () => {
      const taskStore = createTaskStore();
      const planText = JSON.stringify({
        goal: 'Ship the change',
        steps: [
          { id: 's1', description: 'Gather source A', parallel_group: null },
          { id: 's2', description: 'Synthesize findings', depends_on: ['s1'], parallel_group: null },
        ],
      });

      const seeded = seedTaskStoreFromPlan(planText, taskStore);
      expect(seeded.seededCount).toBe(2);

      const tasks = taskStore.listTasks().filter((task) => task.owner !== 'mission');
      expect(tasks).toHaveLength(2);
      expect(tasks[1].blockers).toEqual([tasks[0].id]);
    });

    it('preserves unknown blocker IDs as pass-through blockers', () => {
      const taskStore = createTaskStore();
      const planText = JSON.stringify({
        goal: 'Ship the change',
        steps: [
          { id: 's1', description: 'Gather source A', parallel_group: null },
          { id: 's2', description: 'Synthesize findings', depends_on: ['unknown-step'], parallel_group: null },
        ],
      });

      const seeded = seedTaskStoreFromPlan(planText, taskStore);
      expect(seeded.seededCount).toBe(2);

      const tasks = taskStore.listTasks().filter((task) => task.owner !== 'mission');
      expect(tasks).toHaveLength(2);
      expect(tasks[1].blockers).toEqual(['unknown-step']);
    });

    it('returns stepIdToTaskIdMap with planner step to task mappings', () => {
      const taskStore = createTaskStore();
      const planText = JSON.stringify({
        goal: 'Ship the change',
        steps: [
          { id: 's1', description: 'Gather inputs', parallel_group: null },
          { id: 's2', description: 'Synthesize answer', depends_on: ['s1'], parallel_group: null },
        ],
      });

      const seeded = seedTaskStoreFromPlan(planText, taskStore);
      const tasks = taskStore.listTasks().filter((task) => task.owner !== 'mission');

      expect(seeded.stepIdToTaskIdMap.size).toBe(2);
      expect(seeded.stepIdToTaskIdMap.get('s1')).toBe(tasks[0].id);
      expect(seeded.stepIdToTaskIdMap.get('s2')).toBe(tasks[1].id);
    });

    it('seeds done_criteria from plan JSON', () => {
      const taskStore = createTaskStore();
      const planText = JSON.stringify({
        goal: 'Ship the change',
        steps: [{ id: 'step-1', description: 'Do the work', parallel_group: null }],
        done_criteria: ['All tests pass', 'Deliverable produced'],
      });

      seedTaskStoreFromPlan(planText, taskStore);

      const tasks = taskStore.listTasks();
      const doneCriteriaTask = tasks.find((t) => t.owner === 'mission' && t.notes === 'done_criteria');
      expect(doneCriteriaTask).toBeDefined();
      expect(doneCriteriaTask!.title).toBe('All tests pass; Deliverable produced');
    });

    it('does not seed done_criteria when plan has none', () => {
      const taskStore = createTaskStore();
      const planText = JSON.stringify({
        goal: 'Ship the change',
        steps: [{ id: 'step-1', description: 'Do the work', parallel_group: null }],
      });

      seedTaskStoreFromPlan(planText, taskStore);

      const tasks = taskStore.listTasks();
      const doneCriteriaTask = tasks.find((t) => t.owner === 'mission' && t.notes === 'done_criteria');
      expect(doneCriteriaTask).toBeUndefined();
    });

    it('extracts JSON from markdown-fenced model output', () => {
      const taskStore = createTaskStore();
      const planText =
        '```json\n' +
        JSON.stringify({
          goal: 'Fenced plan',
          steps: [{ id: 'step-1', description: 'Do the work', parallel_group: null }],
        }) +
        '\n```';

      const seeded = seedTaskStoreFromPlan(planText, taskStore);
      expect(seeded.seededCount).toBe(1);

      const missionTask = taskStore.listTasks().find((t) => t.owner === 'mission');
      expect(missionTask?.title).toBe('Fenced plan');
    });

    it('extracts JSON when model adds commentary before/after', () => {
      const taskStore = createTaskStore();
      const json = JSON.stringify({
        goal: 'Commented plan',
        steps: [{ id: 'step-1', description: 'Do the work', parallel_group: null }],
      });
      const planText = 'Here is my plan:\n\n' + json + '\n\nLet me know if you need changes.';

      const seeded = seedTaskStoreFromPlan(planText, taskStore);
      expect(seeded.seededCount).toBe(1);
    });

    it('returns 0 for completely non-JSON output', () => {
      const taskStore = createTaskStore();
      const seeded = seedTaskStoreFromPlan('I will now execute the task directly.', taskStore);
      expect(seeded.seededCount).toBe(0);
    });

    // Discriminator-honouring normaliser tests — see
    // `docs/plans/260508_planner_schema_openai_strict_flatten_discriminator.md`
    // (Stage 3). Routes through the public seam (`seedTaskStoreFromPlan`)
    // rather than the private `normalizePlanningDocument` helper.
    it('discards plan-shape fields when discriminator is direct_answer', () => {
      const taskStore = createTaskStore();
      // Wire shape produced by the new flat schema for a direct-answer
      // (note: the plan-shape fields are populated as null/empty per the
      // unified prompt, so this case is the well-formed shape — but we
      // still want to confirm `seedTaskStoreFromPlan` does not seed any
      // tasks).
      const planText = JSON.stringify({
        type: 'direct_answer',
        confidence: 0.97,
        answer: 'The answer is 42.',
        reasoning: 'Available in context.',
        goal: null,
        assumptions: [],
        steps: [],
        risks: [],
        done_criteria: [],
        routing: null,
      });

      const seeded = seedTaskStoreFromPlan(planText, taskStore);

      expect(seeded.seededCount).toBe(0);
      expect(taskStore.listTasks().filter((t) => t.owner !== 'mission')).toHaveLength(0);
    });

    it('discards spurious plan-shape fields on a malformed direct-answer document', () => {
      const taskStore = createTaskStore();
      // Pathological wire shape: model emits direct_answer discriminator
      // but ALSO populates non-empty plan fields. Per Stage 3 of the
      // flatten-discriminator plan, the normaliser MUST honour the
      // discriminator and discard the spurious plan fields rather than
      // seeding tasks the user never asked for.
      const planText = JSON.stringify({
        type: 'direct_answer',
        confidence: 0.97,
        answer: 'The answer is 42.',
        reasoning: null,
        // Spurious — should NOT seed:
        goal: 'I should not be a goal',
        assumptions: ['ignored'],
        steps: [
          { id: 'spurious-step', description: 'I should not be seeded' },
        ],
        risks: ['ignored'],
        done_criteria: ['ignored'],
        routing: null,
      });

      const seeded = seedTaskStoreFromPlan(planText, taskStore);

      expect(seeded.seededCount).toBe(0);
      expect(taskStore.listTasks().filter((t) => t.owner !== 'mission')).toHaveLength(0);
    });
  });

  describe('extractJsonFromModelOutput', () => {
    it('returns raw JSON unchanged', () => {
      const json = '{"goal":"test"}';
      expect(extractJsonFromModelOutput(json)).toBe(json);
    });

    it('strips markdown json fences', () => {
      expect(extractJsonFromModelOutput('```json\n{"goal":"test"}\n```')).toBe('{"goal":"test"}');
    });

    it('strips bare markdown fences', () => {
      expect(extractJsonFromModelOutput('```\n{"goal":"test"}\n```')).toBe('{"goal":"test"}');
    });

    it('extracts JSON from surrounding commentary', () => {
      const result = extractJsonFromModelOutput('Here is the plan:\n{"goal":"test"}\nDone.');
      expect(result).toBe('{"goal":"test"}');
    });

    it('returns null for no JSON at all', () => {
      expect(extractJsonFromModelOutput('No JSON here')).toBeNull();
    });

    it('handles whitespace around fenced blocks', () => {
      expect(extractJsonFromModelOutput('  ```json\n  {"goal":"test"}  \n```  ')).toBe('{"goal":"test"}');
    });
  });

  describe('parseDirectAnswer', () => {
    it('extracts a valid direct answer with confidence 0.97', () => {
      const raw = JSON.stringify({
        type: 'direct_answer',
        confidence: 0.97,
        answer: 'The answer is 42.',
      });
      const result = parseDirectAnswer(raw);
      expect(result).toEqual({
        answer: 'The answer is 42.',
        confidence: 0.97,
      });
    });

    it('accepts confidence exactly 0.95 (boundary)', () => {
      const raw = JSON.stringify({
        type: 'direct_answer',
        confidence: 0.95,
        answer: 'Boundary answer.',
      });
      const result = parseDirectAnswer(raw);
      expect(result).not.toBeNull();
      expect(result!.confidence).toBe(0.95);
    });

    it('rejects confidence 0.94 (below threshold)', () => {
      const raw = JSON.stringify({
        type: 'direct_answer',
        confidence: 0.94,
        answer: 'Almost confident.',
      });
      expect(parseDirectAnswer(raw)).toBeNull();
    });

    it('accepts confidence exactly 1.0 (upper boundary)', () => {
      const raw = JSON.stringify({
        type: 'direct_answer',
        confidence: 1.0,
        answer: 'Fully confident answer.',
      });
      const result = parseDirectAnswer(raw);
      expect(result).not.toBeNull();
      expect(result!.confidence).toBe(1.0);
    });

    it('rejects confidence > 1.0', () => {
      const raw = JSON.stringify({
        type: 'direct_answer',
        confidence: 1.01,
        answer: 'Over-confident answer.',
      });
      expect(parseDirectAnswer(raw)).toBeNull();
    });

    it('rejects string confidence "0.99"', () => {
      const raw = JSON.stringify({
        type: 'direct_answer',
        confidence: '0.99',
        answer: 'String confidence.',
      });
      expect(parseDirectAnswer(raw)).toBeNull();
    });

    it('rejects NaN confidence', () => {
      // NaN cannot be represented in JSON, so construct manually
      const raw = '{"type":"direct_answer","confidence":NaN,"answer":"NaN confidence."}';
      expect(parseDirectAnswer(raw)).toBeNull();
    });

    it('rejects missing answer field', () => {
      const raw = JSON.stringify({
        type: 'direct_answer',
        confidence: 0.97,
      });
      expect(parseDirectAnswer(raw)).toBeNull();
    });

    it('rejects empty answer string', () => {
      const raw = JSON.stringify({
        type: 'direct_answer',
        confidence: 0.97,
        answer: '',
      });
      expect(parseDirectAnswer(raw)).toBeNull();
    });

    it('rejects whitespace-only answer', () => {
      const raw = JSON.stringify({
        type: 'direct_answer',
        confidence: 0.97,
        answer: '   \n  ',
      });
      expect(parseDirectAnswer(raw)).toBeNull();
    });

    it('rejects missing type field', () => {
      const raw = JSON.stringify({
        confidence: 0.97,
        answer: 'No type field.',
      });
      expect(parseDirectAnswer(raw)).toBeNull();
    });

    it('rejects wrong type field "plan"', () => {
      const raw = JSON.stringify({
        type: 'plan',
        confidence: 0.97,
        answer: 'Wrong type.',
      });
      expect(parseDirectAnswer(raw)).toBeNull();
    });

    it('extracts from markdown fences', () => {
      const json = JSON.stringify({
        type: 'direct_answer',
        confidence: 0.98,
        answer: 'Fenced answer.',
      });
      const raw = '```json\n' + json + '\n```';
      const result = parseDirectAnswer(raw);
      expect(result).toEqual({
        answer: 'Fenced answer.',
        confidence: 0.98,
      });
    });

    it('extracts optional reasoning field', () => {
      const raw = JSON.stringify({
        type: 'direct_answer',
        confidence: 0.96,
        answer: 'The answer with reasoning.',
        reasoning: 'All information is in context.',
      });
      const result = parseDirectAnswer(raw);
      expect(result).toEqual({
        answer: 'The answer with reasoning.',
        confidence: 0.96,
        reasoning: 'All information is in context.',
      });
    });

    it('returns undefined reasoning when field is absent', () => {
      const raw = JSON.stringify({
        type: 'direct_answer',
        confidence: 0.97,
        answer: 'No reasoning provided.',
      });
      const result = parseDirectAnswer(raw);
      expect(result).not.toBeNull();
      expect(result!.reasoning).toBeUndefined();
    });
  });

  describe('runPlanningPhase direct answer', () => {
    const createMockClient = (responseText: string): ModelClient => ({
      create: vi.fn(),
      stream: vi.fn().mockResolvedValue({
        content: [{ type: 'text', text: responseText }],
        stopReason: 'end_turn',
        usage: {
          inputTokens: 100,
          outputTokens: 50,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
        },
        model: unsafeAssertRoutingModelId('claude-opus-4-7'),
      }),
      capabilities: TEST_CAPABILITIES,
    });

    const basePlanningOptions = {
      planningModel: unsafeAssertRoutingModelId('claude-opus-4-7'),
      systemPrompt: 'You are a helpful assistant.',
      messages: [{ role: 'user' as const, content: 'What is 2+2?' }],
    };

    it('populates directAnswer when model returns valid direct-answer JSON', async () => {
      const directAnswerJson = JSON.stringify({
        type: 'direct_answer',
        confidence: 0.98,
        answer: 'The answer is 4.',
        reasoning: 'Simple arithmetic from context.',
      });
      const client = createMockClient(directAnswerJson);

      const result = await runPlanningPhase({ ...basePlanningOptions, client });

      expect(result.directAnswer).toEqual({
        answer: 'The answer is 4.',
        confidence: 0.98,
        reasoning: 'Simple arithmetic from context.',
      });
      expect(result.planText).toBe(directAnswerJson);
    });

    it('leaves directAnswer undefined for normal plan JSON', async () => {
      const planJson = JSON.stringify({
        goal: 'Do the work',
        steps: [{ id: 'step-1', description: 'First step', parallel_group: null }],
      });
      const client = createMockClient(planJson);

      const result = await runPlanningPhase({ ...basePlanningOptions, client });

      expect(result.directAnswer).toBeUndefined();
      expect(result.planText).toBe(planJson);
    });

    it('normalizePlanningDocument preserves string parallel_group values', async () => {
      const planJson = JSON.stringify({
        goal: 'Do the work',
        steps: [{ id: 'step-1', description: 'First step', parallel_group: 'g1' }],
      });
      const client = createMockClient(planJson);

      const result = await runPlanningPhase({ ...basePlanningOptions, client });
      expect(result.document?.steps?.[0]?.parallel_group).toBe('g1');
    });

    it('normalizePlanningDocument drops null and empty parallel_group values', async () => {
      const planJson = JSON.stringify({
        goal: 'Do the work',
        steps: [
          { id: 'step-1', description: 'First step', parallel_group: null },
          { id: 'step-2', description: 'Second step', parallel_group: '' },
        ],
      });
      const client = createMockClient(planJson);

      const result = await runPlanningPhase({ ...basePlanningOptions, client });
      expect(result.document?.steps?.[0]?.parallel_group).toBeUndefined();
      expect(result.document?.steps?.[1]?.parallel_group).toBeUndefined();
    });

    it('replaces planText with fallback for low-confidence direct answer', async () => {
      const lowConfidenceJson = JSON.stringify({
        type: 'direct_answer',
        confidence: 0.9,
        answer: 'Not confident enough.',
      });
      const client = createMockClient(lowConfidenceJson);

      const result = await runPlanningPhase({ ...basePlanningOptions, client });

      expect(result.directAnswer).toBeUndefined();
      expect(result.planText).toContain('confidence was below threshold');
    });

    it('sends the structural invariant for direct_answer to the planning model', async () => {
      const planJson = JSON.stringify({
        goal: 'Do the work',
        steps: [{ id: 'step-1', description: 'First step', parallel_group: null }],
      });
      const client = createMockClient(planJson);

      await runPlanningPhase({ ...basePlanningOptions, client });

      const streamMock = vi.mocked(client.stream);
      const [request] = streamMock.mock.calls[0];
      const instructionsText = String(request.messages.at(-1)?.content ?? '');

      expect(instructionsText).toContain('Direct_answer is text-only');
      expect(instructionsText).toContain('there is no execution phase');
      expect(instructionsText).toContain('Never claim an action was performed');
      expect(instructionsText).toContain('short follow-up confirmations');
      expect(instructionsText).toContain('verification questions');
    });

    it('injects model notes into the adaptive routing prompt', async () => {
      const planJson = JSON.stringify({
        goal: 'Do the work',
        steps: [{ id: 'step-1', description: 'First step', parallel_group: null }],
      });
      const client = createMockClient(planJson);

      await runPlanningPhase({
        ...basePlanningOptions,
        client,
        routingContext: {
          eligibleProfiles: [
            {
              id: 'cheap',
              name: 'GPT-5.4 mini',
              model: unsafeAssertRoutingModelId('gpt-5.4-mini'),
              costTier: 'economy',
              reasoningEffort: 'low',
              modelNotes: 'Fast for routine tool calls.',
            },
            {
              id: 'frontier',
              name: 'GPT-5.5',
              model: unsafeAssertRoutingModelId('gpt-5.5'),
              costTier: 'premium',
              reasoningEffort: 'high',
              modelNotes: 'Best for complex synthesis.',
            },
          ],
          workingModel: 'gpt-5.4-mini',
          availableAgents: ['researcher-gpt5.5-high'],
        },
      });

      const streamMock = vi.mocked(client.stream);
      const [request] = streamMock.mock.calls[0];
      const routingPrompt = request.messages.at(-1)?.content;
      expect(routingPrompt).toEqual(expect.stringContaining('Notes: Fast for routine tool calls.'));
      expect(routingPrompt).toEqual(expect.stringContaining('Notes: Best for complex synthesis.'));
      expect(routingPrompt).toEqual(expect.stringContaining("Read each model's notes carefully"));
      expect(routingPrompt).not.toEqual(expect.stringContaining('Good at:'));
      expect(routingPrompt).not.toEqual(expect.stringContaining('Avoid for:'));
    });

    it('annotates planning failures with thinking role metadata for recovery routing', async () => {
      const planningError = new ModelError('server_error', 'planner overloaded', 503, 'Anthropic');
      const client: ModelClient = {
        create: vi.fn(),
        stream: vi.fn().mockRejectedValue(planningError),
        capabilities: TEST_CAPABILITIES,
      };

      await expect(runPlanningPhase({ ...basePlanningOptions, client })).rejects.toBeInstanceOf(ModelError);
      try {
        await runPlanningPhase({ ...basePlanningOptions, client });
      } catch (error) {
        expect(getModelRuntimeRoleMetadata(error)).toEqual({
          role: 'thinking',
          model: unsafeAssertRoutingModelId('claude-opus-4-7'),
          phase: 'planning',
        });
      }
    });
  });

  describe('extractRoutingFromPlan', () => {
    const eligible = new Set(['gpt-5.4-mini', 'gpt-5.5', 'claude-haiku-4-5']);

    it('returns undefined when plan has no routing field', () => {
      const plan = { goal: 'test', steps: [], assumptions: [] };
      expect(extractRoutingFromPlan(plan as any, eligible)).toBeUndefined();
    });

    it('extracts valid routing with known default model', () => {
      const plan = {
        goal: 'test',
        steps: [],
        assumptions: [],
        routing: {
          default_model: 'gpt-5.4-mini',
          default_effort: 'low',
          rationale: 'cheap enough',
        },
      };
      const result = extractRoutingFromPlan(plan as any, eligible);
      expect(result).toEqual({
        default_model: 'gpt-5.4-mini',
        default_effort: 'low',
        rationale: 'cheap enough',
      });
    });

    it('rejects routing with unknown default model', () => {
      const plan = {
        goal: 'test',
        steps: [],
        assumptions: [],
        routing: { default_model: 'unknown-model', default_effort: 'medium' },
      };
      expect(extractRoutingFromPlan(plan as any, eligible)).toBeUndefined();
    });

    it('strips invalid escalation but preserves base routing', () => {
      const plan = {
        goal: 'test',
        steps: [],
        assumptions: [],
        routing: {
          default_model: 'gpt-5.5',
          default_effort: 'high',
          escalation: { at_step: 'step-2' },
        },
      };
      const result = extractRoutingFromPlan(plan as any, eligible);
      expect(result).toEqual({
        default_model: 'gpt-5.5',
        default_effort: 'high',
        rationale: undefined,
      });
    });

    it('strips escalation with unknown to_model', () => {
      const plan = {
        goal: 'test',
        steps: [],
        assumptions: [],
        routing: {
          default_model: 'gpt-5.4-mini',
          escalation: {
            at_step: 'step-3',
            to_model: 'unknown-model',
            reason: 'needs depth',
          },
        },
      };
      const result = extractRoutingFromPlan(plan as any, eligible);
      expect(result).toBeDefined();
      expect(result!.escalation).toBeUndefined();
    });

    it('strips escalation targeting a real-but-uneligible premium model — the ONLY eligibility gate on the escalation path (GPT stage-12 review F4)', () => {
      // compileStepRoutes decodes escalation.to_model directly (decode-to-
      // itself, no resolveRoutingProfileRef / requireRoutingEligible pass —
      // see the escalation block in rebelCoreQuery.ts). This strip is what
      // keeps an un-chipped premium always-on model (e.g. claude-fable-5)
      // out of the escalation route. Do not weaken it as "redundant".
      const plan = {
        goal: 'test',
        steps: [],
        assumptions: [],
        routing: {
          default_model: 'gpt-5.4-mini',
          default_effort: 'low',
          escalation: {
            at_step: 'step-2',
            to_model: 'claude-fable-5', // real catalog model, NOT in `eligible`
            to_effort: 'xhigh',
            reason: 'hard synthesis',
          },
        },
      };
      const result = extractRoutingFromPlan(plan as any, eligible);
      expect(result).toBeDefined();
      expect(result!.default_model).toBe('gpt-5.4-mini');
      expect(result!.escalation).toBeUndefined();
    });

    it('preserves valid escalation with known to_model', () => {
      const plan = {
        goal: 'test',
        steps: [],
        assumptions: [],
        routing: {
          default_model: 'gpt-5.4-mini',
          default_effort: 'low',
          escalation: {
            at_step: 'step-2',
            to_model: 'gpt-5.5',
            to_effort: 'high',
            reason: 'synthesis',
          },
        },
      };
      const result = extractRoutingFromPlan(plan as any, eligible);
      expect(result?.escalation).toEqual({
        at_step: 'step-2',
        to_model: 'gpt-5.5',
        to_effort: 'high',
        reason: 'synthesis',
      });
    });

    it('includes working model in eligible set', () => {
      const withWorking = new Set(['gpt-5.4-mini', 'gpt-5.5']);
      const plan = {
        goal: 'test',
        steps: [],
        assumptions: [],
        routing: { default_model: 'gpt-5.5', default_effort: 'medium' },
      };
      expect(extractRoutingFromPlan(plan as any, withWorking)).toBeDefined();
    });

    it('routeRef: accepts a profile:<id> default_model and escalation to_model present in the eligible set', () => {
      // The eligible set carries both bare model ids AND provider-bound profile:<id> refs
      // (see buildEligibleRoutingModelIds), so the planner can disambiguate shared model ids.
      const eligibleWithRefs = new Set(['gpt-5.5', 'profile:oai-b', 'profile:oai-a']);
      const plan = {
        goal: 'test',
        steps: [],
        assumptions: [],
        routing: {
          default_model: 'profile:oai-b',
          default_effort: 'medium',
          escalation: { at_step: 'step-2', to_model: 'profile:oai-a', to_effort: 'high', reason: 'depth' },
        },
      };
      const result = extractRoutingFromPlan(plan as any, eligibleWithRefs);
      expect(result?.default_model).toBe('profile:oai-b');
      expect(result?.escalation?.to_model).toBe('profile:oai-a');
    });

    it('routeRef: rejects a profile:<id> ref that is not in the eligible set', () => {
      const eligibleWithRefs = new Set(['gpt-5.5', 'profile:oai-b']);
      const plan = {
        goal: 'test',
        steps: [],
        assumptions: [],
        routing: { default_model: 'profile:does-not-exist', default_effort: 'low' },
      };
      expect(extractRoutingFromPlan(plan as any, eligibleWithRefs)).toBeUndefined();
    });
  });

  describe('buildRoutingPromptAddendum (routeRef prompt)', () => {
    it('surfaces a profile:<id> handle + disambiguation guideline ONLY when a model id is shared', () => {
      const prompt = buildRoutingPromptAddendum({
        eligibleProfiles: [
          { id: 'oai-a', name: 'OpenAI gpt-5.5', model: 'gpt-5.5', costTier: 'medium', reasoning: true },
          { id: 'or-b', name: 'OpenRouter gpt-5.5', model: 'gpt-5.5', costTier: 'low', reasoning: false },
        ],
        workingModel: 'claude-sonnet-4-6',
      });
      // The shared model id gets a stable ref for each colliding entry.
      expect(prompt).toContain('Ref: "profile:oai-a"');
      expect(prompt).toContain('Ref: "profile:or-b"');
      // And the disambiguation guideline is present.
      expect(prompt).toContain('use its "Ref" value');
    });

    it('omits profile:<id> handles and the guideline when every model id is unique', () => {
      const prompt = buildRoutingPromptAddendum({
        eligibleProfiles: [
          { id: 'oai', name: 'OpenAI', model: 'gpt-5.5', costTier: 'medium', reasoning: true },
          { id: 'ant', name: 'Anthropic', model: 'claude-sonnet-4-6', costTier: 'medium', reasoning: true },
        ],
        workingModel: 'claude-sonnet-4-6',
      });
      expect(prompt).not.toContain('Ref: "profile:');
      expect(prompt).not.toContain('use its "Ref" value');
    });

    it('never surfaces a ref for the synthetic __working__ entry even when it shares the working model id', () => {
      const prompt = buildRoutingPromptAddendum({
        eligibleProfiles: [
          { id: '__working__', name: 'Working', model: 'gpt-5.5', costTier: 'medium', reasoning: true },
          { id: 'or-b', name: 'OpenRouter gpt-5.5', model: 'gpt-5.5', costTier: 'low', reasoning: false },
        ],
        workingModel: 'gpt-5.5',
      });
      // The real duplicate gets a ref; the synthetic working sentinel does not.
      expect(prompt).toContain('Ref: "profile:or-b"');
      expect(prompt).not.toContain('profile:__working__');
    });
  });

  describe('buildEligibleRoutingModelIds (routeRef)', () => {
    it('includes bare model ids, the working model, AND a profile:<id> ref per eligible profile', () => {
      const set = buildEligibleRoutingModelIds({
        eligibleProfiles: [
          { id: 'oai-a', model: 'gpt-5.5' },
          { id: 'oai-b', model: 'gpt-5.5' },
        ],
        workingModel: 'claude-sonnet-4-6',
      });
      // Bare model ids + working model (legacy, backward-compatible).
      expect(set.has('gpt-5.5')).toBe(true);
      expect(set.has('claude-sonnet-4-6')).toBe(true);
      // Provider-bound refs for disambiguation (new).
      expect(set.has('profile:oai-a')).toBe(true);
      expect(set.has('profile:oai-b')).toBe(true);
    });

    it('omits profile:<id> refs for profiles without an id (backward-compatible)', () => {
      const set = buildEligibleRoutingModelIds({
        eligibleProfiles: [{ model: 'gpt-5.5' }],
        workingModel: 'gpt-5.5',
      });
      expect(set.has('gpt-5.5')).toBe(true);
      expect([...set].some((id) => id.startsWith('profile:'))).toBe(false);
    });

    it('excludes the synthetic __working__ entry from the profile:<id> ref form (bare model still valid)', () => {
      const set = buildEligibleRoutingModelIds({
        eligibleProfiles: [
          { id: '__working__', model: 'gpt-5.5' },
          { id: 'oai-a', model: 'gpt-5.5' },
        ],
        workingModel: 'gpt-5.5',
      });
      // Bare model id always referenceable.
      expect(set.has('gpt-5.5')).toBe(true);
      // Real profile gets a ref; the synthetic working entry never does.
      expect(set.has('profile:oai-a')).toBe(true);
      expect(set.has('profile:__working__')).toBe(false);
    });

    it('returns an empty set for an undefined routingContext', () => {
      expect(buildEligibleRoutingModelIds(undefined).size).toBe(0);
    });

    it('includes only the working model for an empty eligibleProfiles list', () => {
      const set = buildEligibleRoutingModelIds({
        eligibleProfiles: [],
        workingModel: 'gpt-5.5',
      });
      expect([...set]).toEqual(['gpt-5.5']);
    });
  });

  describe('buildPlanningRoutingPool', () => {
    const profile = (overrides: Partial<ModelProfile>): ModelProfile =>
      ({
        id: 'p1',
        name: 'Profile 1',
        model: 'gpt-5.5',
        routingEligible: true,
        ...overrides,
      } as ModelProfile);

    it('appends the working model as the synthetic __working__ entry when no profile carries it', () => {
      const { profileEntries, routingContext } = buildPlanningRoutingPool({
        routingEligibleProfiles: [profile({ id: 'a', model: 'gpt-5.5' })],
        workingModel: 'claude-sonnet-4-6',
        workingReasoningSuppressed: false,
        availableAgents: [],
      });
      expect(profileEntries.map((e) => e.model)).toEqual(['gpt-5.5', 'claude-sonnet-4-6']);
      const working = profileEntries.find((e) => e.id === '__working__');
      expect(working?.model).toBe('claude-sonnet-4-6');
      // 2 distinct models -> routing injected.
      expect(routingContext).toBeDefined();
      expect(routingContext?.workingModel).toBe('claude-sonnet-4-6');
    });

    it('does NOT duplicate the working model when an eligible profile already carries it', () => {
      const { profileEntries } = buildPlanningRoutingPool({
        routingEligibleProfiles: [profile({ id: 'a', model: 'gpt-5.5' })],
        workingModel: 'gpt-5.5',
        workingReasoningSuppressed: false,
        availableAgents: [],
      });
      expect(profileEntries).toHaveLength(1);
      expect(profileEntries.some((e) => e.id === '__working__')).toBe(false);
    });

    it('skips routing (undefined context) when fewer than 2 models are in the pool', () => {
      // Empty eligible set + working model -> exactly 1 entry -> single-model pool.
      const { profileEntries, routingContext } = buildPlanningRoutingPool({
        routingEligibleProfiles: [],
        workingModel: 'gpt-5.5',
        workingReasoningSuppressed: false,
        availableAgents: [],
      });
      expect(profileEntries.map((e) => e.model)).toEqual(['gpt-5.5']);
      expect(routingContext).toBeUndefined();
    });

    it('injects routing at exactly 2 distinct models (the >=2 gate boundary)', () => {
      const { routingContext } = buildPlanningRoutingPool({
        routingEligibleProfiles: [
          profile({ id: 'a', model: 'gpt-5.5' }),
          profile({ id: 'b', model: 'deepseek-v4' }),
        ],
        workingModel: 'gpt-5.5', // already in the pool -> no synthetic entry; 2 distinct profiles
        workingReasoningSuppressed: false,
        availableAgents: ['researcher'],
      });
      expect(routingContext).toBeDefined();
      expect(routingContext?.eligibleProfiles).toHaveLength(2);
      expect(routingContext?.availableAgents).toEqual(['researcher']);
    });

    it('skips profiles without a model (mirrors the previous inline behaviour)', () => {
      const { profileEntries } = buildPlanningRoutingPool({
        routingEligibleProfiles: [
          profile({ id: 'a', model: '' }),
          profile({ id: 'b', model: 'gpt-5.5' }),
        ],
        workingModel: 'gpt-5.5',
        workingReasoningSuppressed: false,
        availableAgents: [],
      });
      // Only the model-bearing profile survives; working already present -> no synthetic entry.
      expect(profileEntries.map((e) => e.id)).toEqual(['b']);
    });

    it('forces working-entry reasoning=false when the active profile is thinking-incompatible', () => {
      const { profileEntries } = buildPlanningRoutingPool({
        routingEligibleProfiles: [profile({ id: 'a', model: 'gpt-5.5' })],
        workingModel: 'claude-sonnet-4-6',
        workingReasoningSuppressed: true,
        availableAgents: [],
      });
      const working = profileEntries.find((e) => e.id === '__working__');
      expect(working?.reasoning).toBe(false);
    });

    it('derives working-entry reasoning from the model capability when not thinking-incompatible', () => {
      const workingModel = 'claude-sonnet-4-6';
      const { profileEntries } = buildPlanningRoutingPool({
        routingEligibleProfiles: [profile({ id: 'a', model: 'gpt-5.5' })],
        workingModel,
        workingReasoningSuppressed: false,
        availableAgents: [],
      });
      const working = profileEntries.find((e) => e.id === '__working__');
      // Wired to the real capability helper rather than hardcoded.
      expect(working?.reasoning).toBe(modelSupportsReasoning(workingModel));
    });

    it('marks a thinking-incompatible routing-eligible profile as no-reasoning', () => {
      const { profileEntries } = buildPlanningRoutingPool({
        routingEligibleProfiles: [
          profile({
            id: 'incompat',
            model: 'deepseek-v4',
            reasoningEffort: 'high',
            thinkingCompatibility: 'incompatible',
          }),
        ],
        workingModel: 'gpt-5.5',
        workingReasoningSuppressed: false,
        availableAgents: [],
      });
      const incompat = profileEntries.find((e) => e.id === 'incompat');
      // A suppressed profile must not be advertised to the routing LLM as
      // reasoning-capable, and its effort must be omitted — matching the wire.
      expect(incompat?.reasoning).toBe(false);
      expect(incompat?.reasoningEffort).toBeUndefined();
    });

    it('maps profile fields and prefers profile.modelNotes over legacy strengths/weaknesses', () => {
      const { profileEntries } = buildPlanningRoutingPool({
        routingEligibleProfiles: [
          profile({
            id: 'a',
            model: 'gpt-5.5',
            costTier: 'premium',
            reasoningEffort: 'high',
            contextWindow: 200_000,
            modelNotes: 'explicit notes',
            strengths: 'fast',
            weaknesses: 'pricey',
          }),
        ],
        workingModel: 'gpt-5.5',
        workingReasoningSuppressed: false,
        availableAgents: [],
      });
      const entry = profileEntries.find((e) => e.id === 'a');
      expect(entry?.costTier).toBe('premium');
      expect(entry?.reasoningEffort).toBe('high');
      expect(entry?.contextWindow).toBe(200_000);
      expect(entry?.modelNotes).toBe('explicit notes');
    });

    it('falls back to merged strengths/weaknesses as modelNotes when no explicit notes or catalog default', () => {
      const { profileEntries } = buildPlanningRoutingPool({
        routingEligibleProfiles: [
          profile({
            id: 'a',
            model: 'some-unknown-model-xyz', // no catalog default
            strengths: 'fast',
            weaknesses: 'pricey',
          }),
        ],
        workingModel: 'gpt-5.5',
        workingReasoningSuppressed: false,
        availableAgents: [],
      });
      const entry = profileEntries.find((e) => e.id === 'a');
      expect(entry?.modelNotes).toBe('fast. pricey');
    });
  });

  describe('derivePlanParallelGroups', () => {
    it('builds group maps in plan order', () => {
      const groups = derivePlanParallelGroups([
        { id: 's1', parallel_group: 'g1' },
        { id: 's2', parallel_group: 'g1' },
        { id: 's3', parallel_group: 'g1' },
      ]);

      expect(Array.from(groups.entries())).toEqual([['g1', ['s1', 's2', 's3']]]);
    });

    it('returns empty maps for undefined/empty plans and ignores ungrouped steps in mixed plans', () => {
      expect(derivePlanParallelGroups(undefined).size).toBe(0);
      expect(derivePlanParallelGroups([]).size).toBe(0);

      const groups = derivePlanParallelGroups([
        { id: 's1' },
        { id: 's2', parallel_group: 'g1' },
        { id: 's3', parallel_group: 'g1' },
      ]);

      expect(Array.from(groups.entries())).toEqual([['g1', ['s2', 's3']]]);
    });

    it('filters singleton groups', () => {
      const groups = derivePlanParallelGroups([
        { id: 's1', parallel_group: 'g1' },
      ]);

      expect(groups.size).toBe(0);
    });

    it('dedupes duplicate member step IDs while preserving first-seen order', () => {
      const groups = derivePlanParallelGroups([
        { id: 's1', parallel_group: 'g1' },
        { id: 's1', parallel_group: 'g1' },
        { id: 's2', parallel_group: 'g1' },
      ]);

      expect(Array.from(groups.entries())).toEqual([['g1', ['s1', 's2']]]);
    });

    it('ignores malformed sibling-dependency groups and logs a warning', async () => {
      const warnSpy = vi.fn();
      vi.resetModules();
       
      vi.doMock('@core/logger', async () => {
        const actual = await vi.importActual<typeof import('@core/logger')>('@core/logger');
        return {
          ...actual,
          createScopedLogger: () => ({
            trace: vi.fn(),
            debug: vi.fn(),
            info: vi.fn(),
            warn: warnSpy,
            error: vi.fn(),
            fatal: vi.fn(),
          }),
        };
      });

      try {
        const planningModeModule = await import('../planningMode');
        const groups = planningModeModule.derivePlanParallelGroups([
          { id: 's1', parallel_group: 'g1' },
          { id: 's2', parallel_group: 'g1', depends_on: ['s1'] },
        ]);

        expect(groups.size).toBe(0);
        expect(warnSpy).toHaveBeenCalledWith(
          expect.objectContaining({
            groupId: 'g1',
            members: ['s1', 's2'],
            offendingStepId: 's2',
          }),
          'Parallel group has a member listing a sibling or own group as a dependency — ignoring group',
        );
      } finally {
        vi.doUnmock('@core/logger');
        vi.resetModules();
      }
    });

    it('ignores malformed self-group dependencies and logs a warning', async () => {
      const warnSpy = vi.fn();
      vi.resetModules();
       
      vi.doMock('@core/logger', async () => {
        const actual = await vi.importActual<typeof import('@core/logger')>('@core/logger');
        return {
          ...actual,
          createScopedLogger: () => ({
            trace: vi.fn(),
            debug: vi.fn(),
            info: vi.fn(),
            warn: warnSpy,
            error: vi.fn(),
            fatal: vi.fn(),
          }),
        };
      });

      try {
        const planningModeModule = await import('../planningMode');
        const groups = planningModeModule.derivePlanParallelGroups([
          { id: 's1', parallel_group: 'g1', depends_on: ['g1'] },
          { id: 's2', parallel_group: 'g1' },
        ]);

        expect(groups.size).toBe(0);
        expect(warnSpy).toHaveBeenCalledWith(
          expect.objectContaining({
            groupId: 'g1',
            members: ['s1', 's2'],
            offendingStepId: 's1',
          }),
          'Parallel group has a member listing a sibling or own group as a dependency — ignoring group',
        );
      } finally {
        vi.doUnmock('@core/logger');
        vi.resetModules();
      }
    });

    it('returns empty for plans without groups', () => {
      const groups = derivePlanParallelGroups([
        { id: 's1' },
        { id: 's2' },
      ]);

      expect(groups.size).toBe(0);
    });
  });

  describe('normalizePlanningSubAgents', () => {
    it('preserves valid context field', () => {
      expect(
        normalizePlanningSubAgents([
          {
            task: 'Use researcher to gather facts',
            model: unsafeAssertRoutingModelId('gpt-5.5'),
            effort: 'high',
            context: 'scoped',
          },
          {
            task: 'Use reviewer to check synthesis',
            model: unsafeAssertRoutingModelId('claude-sonnet-4-20250514'),
            context: 'contextual',
          },
        ]),
      ).toEqual([
        {
          task: 'Use researcher to gather facts',
          model: unsafeAssertRoutingModelId('gpt-5.5'),
          effort: 'high',
          context: 'scoped',
        },
        {
          task: 'Use reviewer to check synthesis',
          model: unsafeAssertRoutingModelId('claude-sonnet-4-20250514'),
          effort: undefined,
          context: 'contextual',
        },
      ]);
    });

    it('drops invalid context values', () => {
      expect(
        normalizePlanningSubAgents([
          {
            task: 'Use researcher to gather facts',
            model: unsafeAssertRoutingModelId('gpt-5.5'),
            context: 'minimal',
          },
        ]),
      ).toEqual([
        {
          task: 'Use researcher to gather facts',
          model: unsafeAssertRoutingModelId('gpt-5.5'),
          effort: undefined,
          context: undefined,
        },
      ]);
    });
  });

  describe('PLAN_OUTPUT_FORMAT', () => {
    const createMockClient = (responseText: string): ModelClient => ({
      create: vi.fn(),
      stream: vi.fn().mockResolvedValue({
        content: [{ type: 'text', text: responseText }],
        stopReason: 'end_turn',
        usage: {
          inputTokens: 10,
          outputTokens: 5,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
        },
        model: unsafeAssertRoutingModelId('claude-opus-4-7'),
      }),
      capabilities: TEST_CAPABILITIES,
    });
    const isSchemaNode = (value: unknown): value is Record<string, unknown> =>
      value != null && typeof value === 'object';
    const isObjectSchemaNode = (node: Record<string, unknown>): boolean =>
      node.type === 'object' || (Array.isArray(node.type) && node.type.includes('object'));

    const walkSchema = (
      value: unknown,
      visit: (node: Record<string, unknown>, path: string) => void,
      path = '$',
    ): void => {
      if (!isSchemaNode(value)) {
        return;
      }

      visit(value, path);

      for (const [key, child] of Object.entries(value)) {
        if (Array.isArray(child)) {
          child.forEach((item, index) => {
            walkSchema(item, visit, `${path}.${key}[${index}]`);
          });
          continue;
        }

        walkSchema(child, visit, `${path}.${key}`);
      }
    };

    it('declares a stable schema name and json_schema type', () => {
      expect(PLAN_OUTPUT_FORMAT.type).toBe('json_schema');
      expect(PLAN_OUTPUT_FORMAT.name).toBe('rebel_plan');
      expect(typeof PLAN_OUTPUT_FORMAT.schema).toBe('object');
    });

    // PLAN_OUTPUT_FORMAT.schema is the universal-subset PLAN_RESPONSE_SCHEMA,
    // sent to Anthropic + Cohere/Together/etc. compat providers. After the
    // §9b post-Phase-7 flatten it shares the same flat-discriminator shape
    // as the strict dialect — both have a single root `type:'object'` with
    // a nested `type` enum, and differ only in nullability encoding (this
    // schema uses nested `anyOf` for Anthropic compatibility; strict uses
    // `type:['T','null']` arrays). See postmortems for
    // f1b4d44b-45c1-4c4f-bbd7-622e4efcdec0 (OpenAI strict)
    // and 2feaa34a-f477-4ee8-97c6-abae42498775 (Anthropic constrained), and
    // `docs/plans/260508_planner_schema_openai_strict_flatten_discriminator.md`.

    // Per `docs/plans/260508_planner_schema_openai_strict_flatten_discriminator.md`,
    // the universal-subset schema was flattened to match the OpenAI-strict
    // dialect — both now share a single root `type:'object'` with a nested
    // `type` discriminator enum. The two schemas differ only in nullability
    // encoding (universal-subset uses nested `anyOf` for Anthropic
    // compatibility; strict uses `type:['T','null']` arrays which OpenAI
    // accepts but Anthropic rejects when combined with `enum`).
    it('uses a flat root object with nested type discriminator (universal-subset shape)', () => {
      const schema = PLAN_OUTPUT_FORMAT.schema as {
        anyOf?: unknown[];
        oneOf?: unknown[];
        type?: unknown;
        properties?: Record<string, unknown>;
      };
      expect(schema.type).toBe('object');
      // Top-level union/intersection combinators MUST NOT be present —
      // schema is the same shape strict OpenAI accepts (provider-portable).
      expect(schema.anyOf).toBeUndefined();
      expect(schema.oneOf).toBeUndefined();
      expect(schema.properties?.type).toMatchObject({
        type: 'string',
        enum: ['direct_answer', 'plan'],
      });
    });

    it('requires nullable parallel_group on each plan step in the universal-subset schema', () => {
      const stepSchema = (PLAN_OUTPUT_FORMAT.schema as {
        properties?: { steps?: { items?: { properties?: Record<string, unknown>; required?: string[] } } };
      }).properties?.steps?.items;
      const parallelGroup = stepSchema?.properties?.parallel_group as { anyOf?: Array<{ type?: string }> } | undefined;

      expect(parallelGroup?.anyOf).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: 'string' }),
          expect.objectContaining({ type: 'null' }),
        ]),
      );
      expect(stepSchema?.required).toContain('parallel_group');
    });

    it('accepts sample plan steps with parallel_group:null and parallel_group:"g1" in both schema dialects', () => {
      const sampleStepWithNull = { parallel_group: null };
      const sampleStepWithGroup = { parallel_group: 'g1' };

      const getStepSchema = (
        schema: unknown,
      ):
        | {
            properties?: Record<string, unknown>;
            required?: string[];
          }
        | undefined =>
        (schema as {
          properties?: { steps?: { items?: { properties?: Record<string, unknown>; required?: string[] } } };
        })?.properties?.steps?.items;

      const supportsParallelGroupValue = (schemaNode: unknown, value: unknown): boolean => {
        if (!isSchemaNode(schemaNode)) {
          return false;
        }
        if (Array.isArray(schemaNode.anyOf)) {
          return schemaNode.anyOf.some((branch) => supportsParallelGroupValue(branch, value));
        }
        const valueType = value === null ? 'null' : typeof value;
        if (Array.isArray(schemaNode.type)) {
          return schemaNode.type.includes(valueType);
        }
        return schemaNode.type === valueType;
      };

      for (const schema of [PLAN_OUTPUT_FORMAT.schema, PLAN_RESPONSE_SCHEMA_OPENAI_STRICT]) {
        const stepSchema = getStepSchema(schema);
        const parallelGroupSchema = stepSchema?.properties?.parallel_group;
        expect(stepSchema?.required).toContain('parallel_group');
        expect(supportsParallelGroupValue(parallelGroupSchema, sampleStepWithNull.parallel_group)).toBe(true);
        expect(supportsParallelGroupValue(parallelGroupSchema, sampleStepWithGroup.parallel_group)).toBe(true);
      }
    });

    // OpenAI strict mode requires every object to set additionalProperties:false
    // and to list every declared property in `required`. A single missed setting
    // anywhere in the tree (including nested step / sub_agent / routing /
    // escalation objects) re-introduces the same class of 400 error that
    // top-level anyOf produced. Walk the entire schema and assert the invariant
    // at every object node — purely structural, so adding/removing fields
    // doesn't require touching this test.
    it('every object node has additionalProperties:false and `required` covers all `properties` keys', () => {
      const violations: string[] = [];
      const walk = (node: unknown, path: string): void => {
        if (Array.isArray(node)) {
          node.forEach((child, i) => walk(child, `${path}[${i}]`));
          return;
        }
        if (!node || typeof node !== 'object') return;
        const obj = node as Record<string, unknown>;
        if (obj.type === 'object' || (Array.isArray(obj.type) && obj.type.includes('object'))) {
          if (obj.additionalProperties !== false) {
            violations.push(`${path || '<root>'}: additionalProperties is not false`);
          }
          const properties = obj.properties as Record<string, unknown> | undefined;
          const required = obj.required as string[] | undefined;
          if (properties && Object.keys(properties).length > 0) {
            const requiredSet = new Set(required ?? []);
            for (const key of Object.keys(properties)) {
              if (!requiredSet.has(key)) {
                violations.push(`${path || '<root>'}.${key}: declared in properties but missing from required`);
              }
            }
          }
        }
        for (const value of Object.values(obj)) {
          walk(value, path);
        }
      };
      walk(PLAN_OUTPUT_FORMAT.schema, '');
      expect(violations).toEqual([]);
    });

    // Anthropic's constrained-decoding validator rejects the
    // `type: ['string', 'null']` + `enum: [...]` combo with a misleading
    // "Enum value 'low' does not match declared type '['string', 'null']'"
    // error, even though the JSON Schema spec permits it. Nullable enums must
    // therefore use nested `anyOf: [{type:'string',enum:[...]},{type:'null'}]`
    // instead. See the postmortem for
    // 2feaa34a-f477-4ee8-97c6-abae42498775.
    it('does not combine array-form `type` with `enum` (Anthropic compatibility)', () => {
      const violations: string[] = [];
      const walk = (node: unknown, path: string): void => {
        if (Array.isArray(node)) {
          node.forEach((child, i) => walk(child, `${path}[${i}]`));
          return;
        }
        if (!node || typeof node !== 'object') return;
        const obj = node as Record<string, unknown>;
        if (Array.isArray(obj.type) && Array.isArray(obj.enum)) {
          violations.push(
            `${path || '<root>'}: combines array-form type ${JSON.stringify(obj.type)} with enum (use nested anyOf instead)`,
          );
        }
        for (const [key, value] of Object.entries(obj)) {
          walk(value, `${path}.${key}`);
        }
      };
      walk(PLAN_OUTPUT_FORMAT.schema, '');
      expect(violations).toEqual([]);
    });

    it('never mixes type and anyOf on the same schema node', () => {
      const violations: string[] = [];

      walkSchema(PLAN_OUTPUT_FORMAT.schema, (node, path) => {
        const hasAnyOf = Array.isArray(node.anyOf);
        const hasType = typeof node.type === 'string' || Array.isArray(node.type);
        if (hasAnyOf && hasType) {
          violations.push(path);
        }
      });

      expect(violations).toEqual([]);
    });

    it('never uses array-form type declarations', () => {
      const violations: string[] = [];

      walkSchema(PLAN_OUTPUT_FORMAT.schema, (node, path) => {
        if (Array.isArray(node.type)) {
          violations.push(path);
        }
      });

      expect(violations).toEqual([]);
    });

    it('sets additionalProperties false on every object schema node', () => {
      const violations: string[] = [];

      walkSchema(PLAN_OUTPUT_FORMAT.schema, (node, path) => {
        if (node.type === 'object' && node.additionalProperties !== false) {
          violations.push(path);
        }
      });

      expect(violations).toEqual([]);
    });

    it('marks every declared object property as required', () => {
      const violations: string[] = [];

      walkSchema(PLAN_OUTPUT_FORMAT.schema, (node, path) => {
        if (node.type !== 'object' || !isSchemaNode(node.properties)) {
          return;
        }

        if (!Array.isArray(node.required)) {
          violations.push(`${path}:missing-required-array`);
          return;
        }

        const required = new Set(node.required.filter((value): value is string => typeof value === 'string'));
        for (const propertyKey of Object.keys(node.properties)) {
          if (!required.has(propertyKey)) {
            violations.push(`${path}.${propertyKey}`);
          }
        }
      });

      expect(violations).toEqual([]);
    });

    it('keeps nullable anyOf unions at or below Anthropic cap (16)', () => {
      let nullableAnyOfCount = 0;

      walkSchema(PLAN_OUTPUT_FORMAT.schema, (node) => {
        if (!Array.isArray(node.anyOf)) {
          return;
        }
        if (node.anyOf.some((branch) => isSchemaNode(branch) && branch.type === 'null')) {
          nullableAnyOfCount += 1;
        }
      });

      expect(nullableAnyOfCount).toBeLessThanOrEqual(16);
    });

    it('routing.rationale is non-nullable in both schema dialects (Anthropic union-cap defense)', () => {
      const universalRationale = (PLAN_OUTPUT_FORMAT.schema as {
        properties?: { routing?: { anyOf?: Array<{ properties?: { rationale?: unknown } }> } };
      }).properties?.routing?.anyOf?.[0]?.properties?.rationale;
      expect(universalRationale).toEqual({ type: 'string' });

      const strictRationale = (PLAN_RESPONSE_SCHEMA_OPENAI_STRICT as {
        properties?: { routing?: { properties?: { rationale?: unknown } } };
      }).properties?.routing?.properties?.rationale;
      expect(strictRationale).toEqual({ type: 'string' });
    });

    describe('PLAN_RESPONSE_SCHEMA_OPENAI_STRICT', () => {
      // Per `docs/plans/260508_planner_schema_openai_strict_flatten_discriminator.md`,
      // OpenAI strict mode forbids root `anyOf`/`oneOf`/`allOf`/`not`/`enum`
      // unconditionally. The schema is now a flat root `type:'object'` with
      // a nested `type` discriminator enum in `properties`.
      it('uses a flat root object with nested type discriminator (no top-level anyOf)', () => {
        expect(PLAN_RESPONSE_SCHEMA_OPENAI_STRICT).toMatchObject({
          type: 'object',
          additionalProperties: false,
        });
        // Top-level union/intersection combinators MUST NOT be present.
        expect((PLAN_RESPONSE_SCHEMA_OPENAI_STRICT as { anyOf?: unknown[] }).anyOf).toBeUndefined();
        expect((PLAN_RESPONSE_SCHEMA_OPENAI_STRICT as { oneOf?: unknown[] }).oneOf).toBeUndefined();
        expect((PLAN_RESPONSE_SCHEMA_OPENAI_STRICT as { allOf?: unknown[] }).allOf).toBeUndefined();
        // Discriminator is a property, not a root union.
        const properties = (PLAN_RESPONSE_SCHEMA_OPENAI_STRICT as { properties?: Record<string, unknown> })
          .properties;
        expect(properties).toBeDefined();
        expect(properties?.type).toMatchObject({
          type: 'string',
          enum: ['direct_answer', 'plan'],
        });
      });

      it('sets additionalProperties false on every object schema node', () => {
        const violations: string[] = [];

        walkSchema(PLAN_RESPONSE_SCHEMA_OPENAI_STRICT, (node, path) => {
          if (isObjectSchemaNode(node) && isSchemaNode(node.properties) && node.additionalProperties !== false) {
            violations.push(path);
          }
        });

        expect(violations).toEqual([]);
      });

      it('marks every declared object property as required', () => {
        const violations: string[] = [];

        walkSchema(PLAN_RESPONSE_SCHEMA_OPENAI_STRICT, (node, path) => {
          if (!isObjectSchemaNode(node) || !isSchemaNode(node.properties)) {
            return;
          }

          if (!Array.isArray(node.required)) {
            violations.push(`${path}:missing-required-array`);
            return;
          }

          const required = new Set(node.required.filter((value): value is string => typeof value === 'string'));
          for (const propertyKey of Object.keys(node.properties)) {
            if (!required.has(propertyKey)) {
              violations.push(`${path}.${propertyKey}`);
            }
          }
        });

        expect(violations).toEqual([]);
      });

      it('uses OpenAI nullable type arrays for optional planner fields', () => {
        const nullableTypeArrays: string[] = [];

        walkSchema(PLAN_RESPONSE_SCHEMA_OPENAI_STRICT, (node, path) => {
          if (Array.isArray(node.type) && node.type.includes('null')) {
            nullableTypeArrays.push(path);
          }
        });

        // Paths updated for the flat-discriminator shape (was
        // `$.anyOf[0]...`/`$.anyOf[1]...` under the previous root-anyOf
        // shape). Per
        // `docs/plans/260508_planner_schema_openai_strict_flatten_discriminator.md`.
        expect(nullableTypeArrays).toEqual(
          expect.arrayContaining([
            '$.properties.reasoning',
            '$.properties.steps.items.properties.parallel_group',
            '$.properties.steps.items.properties.effort',
            '$.properties.routing',
          ]),
        );
      });

      it('requires parallel_group on each plan step in the OpenAI-strict schema', () => {
        const stepSchema = (PLAN_RESPONSE_SCHEMA_OPENAI_STRICT as {
          properties?: { steps?: { items?: { properties?: Record<string, unknown>; required?: string[] } } };
        }).properties?.steps?.items;
        expect(stepSchema?.properties?.parallel_group).toEqual({ type: ['string', 'null'] });
        expect(stepSchema?.required).toContain('parallel_group');
      });

      it('includes null in OpenAI strict effort enums', () => {
        const effortEnums: unknown[][] = [];

        walkSchema(PLAN_RESPONSE_SCHEMA_OPENAI_STRICT, (node) => {
          if (
            Array.isArray(node.enum) &&
            node.enum.includes('low') &&
            node.enum.includes('medium') &&
            node.enum.includes('high') &&
            node.enum.includes('xhigh')
          ) {
            effortEnums.push(node.enum);
          }
        });

        expect(effortEnums.length).toBeGreaterThan(0);
        expect(effortEnums.every((values) => values.includes(null))).toBe(true);
      });
    });

    it('passes outputConfig to the underlying client.stream call', async () => {
      const client = createMockClient(JSON.stringify({ goal: 'x', steps: [] }));
      await runPlanningPhase({
        planningModel: unsafeAssertRoutingModelId('claude-opus-4-7'),
        systemPrompt: 'sys',
        messages: [{ role: 'user', content: 'hi' }],
        client,
      });

      const streamMock = vi.mocked(client.stream);
      const [request] = streamMock.mock.calls[0];
      expect(request.outputConfig).toEqual({ format: PLAN_OUTPUT_FORMAT });
    });
  });

  describe('runPlanningPhase — schema rejection runtime fallback', () => {
    const TEST_CAPABILITIES: ProviderCapabilities = {
      hasNativeContextEditing: false,
      hasNativeCompaction: false,
      cacheStrategy: 'none',
      cacheHeuristicTtlMs: 0,
      supportsImageContent: () => false,
    };

    const mkSchemaRejection = (message: string, provider = 'openai'): ModelError =>
      new ModelError(
        'invalid_request',
        `400 ${message}`,
        400,
        provider,
        { rawMessage: message },
      );

    const mkUnrelatedInvalidRequest = (): ModelError =>
      new ModelError(
        'invalid_request',
        '400 some other invalid_request error unrelated to schemas',
        400,
        'openai',
        { rawMessage: 'some other invalid_request error unrelated to schemas' },
      );

    const successResult = {
      content: [{ type: 'text' as const, text: JSON.stringify({ goal: 'x', steps: [] }) }],
      stopReason: 'end_turn',
      usage: { inputTokens: 1, outputTokens: 1, cacheCreationTokens: 0, cacheReadTokens: 0 },
      model: unsafeAssertRoutingModelId('claude-opus-4-7'),
    };

    it('retries once without outputConfig when provider rejects response_format schema', async () => {
      const stream = vi.fn()
        .mockRejectedValueOnce(
          mkSchemaRejection(
            "Invalid schema for response_format 'rebel_plan': In context=(), 'oneOf' is not permitted.",
          ),
        )
        .mockResolvedValueOnce(successResult);

      const client: ModelClient = { create: vi.fn(), stream, capabilities: TEST_CAPABILITIES };

      const result = await runPlanningPhase({
        planningModel: unsafeAssertRoutingModelId('claude-opus-4-7'),
        systemPrompt: 'sys',
        messages: [{ role: 'user', content: 'hi' }],
        client,
      });

      expect(result.planText).toContain('"goal":"x"');
      expect(stream).toHaveBeenCalledTimes(2);
      const firstCall = stream.mock.calls[0][0];
      const secondCall = stream.mock.calls[1][0];
      expect(firstCall.outputConfig).toEqual({ format: PLAN_OUTPUT_FORMAT });
      expect(secondCall.outputConfig).toBeUndefined();
    });

    it('propagates the second failure when both attempts fail', async () => {
      const stream = vi.fn()
        .mockRejectedValueOnce(
          mkSchemaRejection(
            'output_config.format.schema: Enum value "low" does not match declared type [\'string\', \'null\']',
            'anthropic',
          ),
        )
        .mockRejectedValueOnce(new Error('second-failure-after-fallback'));

      const client: ModelClient = { create: vi.fn(), stream, capabilities: TEST_CAPABILITIES };

      await expect(
        runPlanningPhase({
          planningModel: unsafeAssertRoutingModelId('claude-opus-4-7'),
          systemPrompt: 'sys',
          messages: [{ role: 'user', content: 'hi' }],
          client,
        }),
      ).rejects.toThrow('second-failure-after-fallback');

      expect(stream).toHaveBeenCalledTimes(2);
    });

    it('propagates non-schema invalid_request errors immediately without retry', async () => {
      const stream = vi.fn().mockRejectedValueOnce(mkUnrelatedInvalidRequest());

      const client: ModelClient = { create: vi.fn(), stream, capabilities: TEST_CAPABILITIES };

      await expect(
        runPlanningPhase({
          planningModel: unsafeAssertRoutingModelId('claude-opus-4-7'),
          systemPrompt: 'sys',
          messages: [{ role: 'user', content: 'hi' }],
          client,
        }),
      ).rejects.toThrow(/some other invalid_request/);

      expect(stream).toHaveBeenCalledTimes(1);
    });

    it('retries when Anthropic rejects with constrained-decoding union-cap overflow', async () => {
      const stream = vi.fn()
        .mockRejectedValueOnce(
          mkSchemaRejection(
            'Schemas contains too many parameters with union types (17 parameters with type arrays or anyOf). This causes exponential compilation cost. Reduce the number of nullable or union-typed parameters (limit: 16 parameters with unions).',
            'anthropic',
          ),
        )
        .mockResolvedValueOnce(successResult);

      const client: ModelClient = { create: vi.fn(), stream, capabilities: TEST_CAPABILITIES };

      const result = await runPlanningPhase({
        planningModel: unsafeAssertRoutingModelId('claude-opus-4-7'),
        systemPrompt: 'sys',
        messages: [{ role: 'user', content: 'hi' }],
        client,
      });

      expect(result.planText).toContain('"goal":"x"');
      expect(stream).toHaveBeenCalledTimes(2);
      const secondCall = stream.mock.calls[1][0];
      expect(secondCall.outputConfig).toBeUndefined();
    });

    it('captures the rejection via the error reporter before retrying', async () => {
      const captureException = vi.fn();
      setErrorReporter({
        captureException,
        captureMessage: vi.fn(),
        addBreadcrumb: vi.fn(),
      });

      const rejection = mkSchemaRejection(
        "Invalid schema for response_format 'rebel_plan': In context=(), 'oneOf' is not permitted.",
      );
      const stream = vi.fn()
        .mockRejectedValueOnce(rejection)
        .mockResolvedValueOnce(successResult);

      const client: ModelClient = { create: vi.fn(), stream, capabilities: TEST_CAPABILITIES };

      await runPlanningPhase({
        planningModel: unsafeAssertRoutingModelId('claude-opus-4-7'),
        systemPrompt: 'sys',
        messages: [{ role: 'user', content: 'hi' }],
        client,
      });

      expect(captureException).toHaveBeenCalledTimes(1);
      const [capturedError, captureContext] = captureException.mock.calls[0];
      expect(capturedError).toBe(rejection);
      expect(captureContext).toMatchObject({
        tags: {
          sdk_error_category: 'structured_output_schema_rejected',
          schema_name: PLAN_OUTPUT_FORMAT.name,
          provider: 'openai',
          recovered: 'pending',
        },
      });
    });

    it('does NOT capture a second time after the retry succeeds', async () => {
      const captureException = vi.fn();
      setErrorReporter({
        captureException,
        captureMessage: vi.fn(),
        addBreadcrumb: vi.fn(),
      });

      const stream = vi.fn()
        .mockRejectedValueOnce(
          mkSchemaRejection('output_config.format.schema rejected', 'anthropic'),
        )
        .mockResolvedValueOnce(successResult);

      const client: ModelClient = { create: vi.fn(), stream, capabilities: TEST_CAPABILITIES };

      await runPlanningPhase({
        planningModel: unsafeAssertRoutingModelId('claude-opus-4-7'),
        systemPrompt: 'sys',
        messages: [{ role: 'user', content: 'hi' }],
        client,
      });

      expect(captureException).toHaveBeenCalledTimes(1);
    });
  });
});
