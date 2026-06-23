import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CompletedStep } from '../hooks/useAgentTurn';
import type { SubAgentItem } from '../utils/subAgentExtraction';
import {
  buildActiveActivityViewModel,
  buildCompletedActivityViewModel,
  deriveActivityHeader,
  deriveAssistantDisplayItems,
  formatActivityElapsed,
} from '../selectors/mobileActivityViewModel';

const NOW = 1_700_000_000_000;

const makeAssistant = (overrides: Partial<SubAgentItem> = {}): SubAgentItem => ({
  id: overrides.id ?? 'assistant-1',
  label: overrides.label ?? 'Research specialist',
  subagentType: overrides.subagentType ?? 'research-specialist',
  summary: overrides.summary ?? 'Reviewing the latest notes',
  status: overrides.status ?? 'running',
  isBackground: overrides.isBackground ?? false,
  startedAt: overrides.startedAt ?? NOW - 45_000,
  completedAt: overrides.completedAt,
  durationMs: overrides.durationMs,
  result: overrides.result,
  toolUseId: overrides.toolUseId,
});

const makeCompletedStep = (overrides: Partial<CompletedStep> = {}): CompletedStep => ({
  label: overrides.label ?? 'Read',
  timestamp: overrides.timestamp ?? NOW - 20_000,
  toolName: overrides.toolName ?? 'Read',
  detail: overrides.detail,
  isError: overrides.isError,
  toolUseId: overrides.toolUseId,
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('formatActivityElapsed', () => {
  it('formats seconds, minutes, and hours per compact rules', () => {
    expect(formatActivityElapsed(23_000)).toBe('23s');
    expect(formatActivityElapsed(4 * 60_000)).toBe('4m');
    expect(formatActivityElapsed(72 * 60_000)).toBe('1h 12m');
  });
});

describe('deriveAssistantDisplayItems', () => {
  it('returns empty output for zero assistants', () => {
    expect(deriveAssistantDisplayItems([])).toEqual([]);
  });

  it('keeps one assistant and computes elapsed label', () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const items = deriveAssistantDisplayItems([makeAssistant()]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      roleLabel: 'Research Specialist',
      status: 'running',
      activityLabel: 'Reviewing the latest notes',
      elapsedLabel: '45s',
    });
  });

  it('demotes model names to modelLabel metadata', () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const items = deriveAssistantDisplayItems([
      makeAssistant({
        label: 'gpt-4o',
        subagentType: 'gpt-4o',
        summary: 'Synthesizing findings',
      }),
    ]);

    expect(items[0].roleLabel).toBe('Assistant');
    expect(items[0].activityLabel).toBe('Synthesizing findings');
    expect(items[0].modelLabel).toBe('gpt-4o');
  });
});

describe('buildActiveActivityViewModel + deriveActivityHeader', () => {
  it('returns Getting started with no mission, tasks, assistants, or fallback headline', () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const vm = buildActiveActivityViewModel({
      headline: '',
      completedSteps: [],
      elapsedMs: 1_000,
      isStalled: false,
      isError: false,
    });

    expect(vm.mission).toBeNull();
    expect(vm.summary.taskCount).toBe(0);
    const header = deriveActivityHeader(vm);
    expect(header.headline).toBe('Getting started');
    expect(header.progressLabel).toBeUndefined();
  });

  it('uses assistant activity for one assistant and coordinating copy for 10 assistants', () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const oneAssistantVm = buildActiveActivityViewModel({
      headline: '',
      completedSteps: [],
      subAgentItems: [makeAssistant()],
      elapsedMs: 10_000,
      isStalled: false,
      isError: false,
    });
    expect(deriveActivityHeader(oneAssistantVm).headline).toBe('Reviewing the latest notes');

    const tenAssistants = Array.from({ length: 10 }, (_, index) =>
      makeAssistant({
        id: `assistant-${index}`,
        label: `Research specialist ${index}`,
        subagentType: `research-specialist-${index}`,
      }));
    const manyAssistantsVm = buildActiveActivityViewModel({
      headline: '',
      completedSteps: [],
      subAgentItems: tenAssistants,
      elapsedMs: 10_000,
      isStalled: false,
      isError: false,
    });
    expect(deriveActivityHeader(manyAssistantsVm).headline).toBe('Coordinating 10 assistants');
  });

  it('applies headline priority: error > stalled > running tool > assistant > current task > fallback', () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const baseArgs = {
      completedSteps: [makeCompletedStep()],
      subAgentItems: [makeAssistant()],
      taskProgress: [{ id: 'task-1', title: 'Draft summary', status: 'in_progress' as const }],
      elapsedMs: 90_000,
      hasMissionSet: false,
      touchedTaskIds: ['task-1'],
    };

    const errorVm = buildActiveActivityViewModel({
      ...baseArgs,
      headline: 'Using Bash...',
      isStalled: true,
      isError: true,
    });
    expect(deriveActivityHeader(errorVm)).toMatchObject({
      headline: 'Something tripped',
      subheadline: 'Some details may be incomplete.',
      state: 'error',
    });

    const stalledVm = buildActiveActivityViewModel({
      ...baseArgs,
      headline: 'Using Bash...',
      isStalled: true,
      isError: false,
    });
    expect(deriveActivityHeader(stalledVm)).toMatchObject({
      headline: 'Taking longer than expected',
      subheadline: 'Still working. This one has layers.',
      state: 'stalled',
    });

    const runningVm = buildActiveActivityViewModel({
      ...baseArgs,
      headline: 'Using Bash...',
      isStalled: false,
      isError: false,
    });
    expect(deriveActivityHeader(runningVm).headline).toBe('Running a command');

    const assistantVm = buildActiveActivityViewModel({
      ...baseArgs,
      headline: '',
      taskProgress: [],
      touchedTaskIds: [],
      isStalled: false,
      isError: false,
    });
    expect(deriveActivityHeader(assistantVm).headline).toBe('Reviewing the latest notes');

    const taskVm = buildActiveActivityViewModel({
      ...baseArgs,
      headline: '',
      subAgentItems: [],
      isStalled: false,
      isError: false,
    });
    expect(deriveActivityHeader(taskVm).headline).toBe('Draft summary');

    const fallbackVm = buildActiveActivityViewModel({
      ...baseArgs,
      headline: 'Final fallback',
      subAgentItems: [],
      taskProgress: [],
      touchedTaskIds: [],
      completedSteps: [],
      isStalled: false,
      isError: false,
    });
    expect(deriveActivityHeader(fallbackVm).headline).toBe('Final fallback');
  });
});

describe('buildCompletedActivityViewModel + deriveActivityHeader', () => {
  it('produces completed Done summary headline when there are steps/assistants', () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const vm = buildCompletedActivityViewModel({
      fallbackSteps: [
        makeCompletedStep({ toolUseId: 'step-1', toolName: 'Read' }),
        makeCompletedStep({ toolUseId: 'step-2', toolName: 'Write' }),
      ],
      subAgentItems: [
        makeAssistant({
          id: 'assistant-1',
          status: 'completed',
          durationMs: 30_000,
          completedAt: NOW - 1_000,
        }),
      ],
      durationMs: 95_000,
      errorCount: 0,
    });

    expect(vm.state).toBe('completed');
    const header = deriveActivityHeader(vm);
    expect(header.headline).toBe('Done — 2 steps, 1 assistant');
    expect(header.elapsedLabel).toBe('1m');
  });

  it('escalates completed view to error state when errorCount is non-zero', () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const vm = buildCompletedActivityViewModel({
      fallbackSteps: [makeCompletedStep()],
      durationMs: 20_000,
      errorCount: 1,
    });
    const header = deriveActivityHeader(vm);
    expect(vm.state).toBe('error');
    expect(header.headline).toBe('Something tripped');
  });
});
