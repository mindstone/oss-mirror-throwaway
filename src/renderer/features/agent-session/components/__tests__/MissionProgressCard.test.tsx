// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { MissionProgressCard, _testOnly } from '../MissionProgressCard';
import type { TaskModelRoutingInfo, TaskProgressItem } from '../../utils/turnStepContext';

const { groupTasksByParallelRun } = _testOnly;

 
vi.mock('../MissionProgressCard.module.css', () => ({
  default: new Proxy({}, { get: (_target, prop) => String(prop) }),
}));

 
vi.mock('@renderer/components/ui', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

 
vi.mock('@renderer/lib/utils', () => ({
  cn: (...args: Array<string | false | null | undefined>) => args.filter(Boolean).join(' '),
}));

 
vi.mock('lucide-react', () => ({
  Bot: (props: React.SVGProps<SVGSVGElement>) => <svg data-icon="bot" {...props} />,
  Check: (props: React.SVGProps<SVGSVGElement>) => <svg data-icon="check" {...props} />,
  ChevronRight: (props: React.SVGProps<SVGSVGElement>) => <svg data-icon="chevron-right" {...props} />,
  Pause: (props: React.SVGProps<SVGSVGElement>) => <svg data-icon="pause" {...props} />,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const tasks: TaskProgressItem[] = [
  { id: 'task-1', title: 'Gather source material', status: 'completed' },
  { id: 'task-2', title: 'Draft the synthesis', status: 'in_progress' },
  { id: 'task-3', title: 'Ask focused researcher to verify claims', status: 'pending' },
];

const modelByTaskId = new Map<string, TaskModelRoutingInfo>([
  ['task-1', { model: 'openai/gpt-5.5', effort: 'low' }],
  ['task-2', { model: 'openai/gpt-5.5', effort: 'low' }],
  ['task-3', {
    model: 'claude-sonnet-4-6',
    effort: 'medium',
    isSubAgent: true,
    subAgentContext: 'scoped',
  }],
]);

function renderCard(options: { light?: boolean } = {}): { container: HTMLElement; root: Root } {
  document.body.className = options.light ? 'light' : '';
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  act(() => {
    root.render(
      <MissionProgressCard
        taskProgress={tasks}
        modelByTaskId={modelByTaskId}
        embedded
      />,
    );
  });

  return { container, root };
}

describe('MissionProgressCard model badges', () => {
  afterEach(() => {
    document.body.className = '';
    document.body.innerHTML = '';
  });

  it('renders a full model badge once and continuation marker for consecutive same-model tasks', () => {
    const { container, root } = renderCard();

    expect(container.textContent).toContain('GPT-5.5');
    expect(container.querySelectorAll('.modelContinuation')).toHaveLength(1);
    expect(container.querySelectorAll('.modelBadge')).toHaveLength(3);

    act(() => root.unmount());
  });

  it('renders sub-agent task badges with Bot indicator and focused context label in light theme', () => {
    const { container, root } = renderCard({ light: true });

    expect(container.querySelector('[data-icon="bot"]')).toBeTruthy();
    expect(container.textContent).toContain('Claude sonnet-4-6 · focused');
    expect(container.querySelectorAll('.taskSubAgent')).toHaveLength(1);

    act(() => root.unmount());
  });
});

describe('groupTasksByParallelRun', () => {
  const makeTask = (
    id: string,
    overrides: Partial<TaskProgressItem> = {},
  ): TaskProgressItem => ({
    id,
    title: `Task ${id}`,
    status: 'pending',
    ...overrides,
  });

  it('returns an empty array for empty input', () => {
    expect(groupTasksByParallelRun([])).toEqual([]);
  });

  it('returns all singletons when no task has a parallelGroup', () => {
    const tasks = [makeTask('a'), makeTask('b'), makeTask('c')];
    const entries = groupTasksByParallelRun(tasks);

    expect(entries).toHaveLength(3);
    entries.forEach((entry, idx) => {
      expect(entry.kind).toBe('single');
      if (entry.kind === 'single') {
        expect(entry.task.id).toBe(tasks[idx].id);
      }
    });
  });

  it('clusters two contiguous tasks sharing a parallelGroup into a single group entry', () => {
    const tasks = [
      makeTask('a', { parallelGroup: 'g1' }),
      makeTask('b', { parallelGroup: 'g1' }),
    ];
    const entries = groupTasksByParallelRun(tasks);

    expect(entries).toHaveLength(1);
    const [entry] = entries;
    expect(entry.kind).toBe('group');
    if (entry.kind === 'group') {
      expect(entry.groupId).toBe('g1');
      expect(entry.tasks.map(t => t.id)).toEqual(['a', 'b']);
    }
  });

  it('preserves order across mixed singletons and a group of three', () => {
    const tasks = [
      makeTask('a'),
      makeTask('b', { parallelGroup: 'g1' }),
      makeTask('c', { parallelGroup: 'g1' }),
      makeTask('d', { parallelGroup: 'g1' }),
      makeTask('e'),
    ];
    const entries = groupTasksByParallelRun(tasks);

    expect(entries).toHaveLength(3);
    expect(entries[0].kind).toBe('single');
    expect(entries[1].kind).toBe('group');
    expect(entries[2].kind).toBe('single');

    if (entries[0].kind === 'single') expect(entries[0].task.id).toBe('a');
    if (entries[1].kind === 'group') {
      expect(entries[1].groupId).toBe('g1');
      expect(entries[1].tasks.map(t => t.id)).toEqual(['b', 'c', 'd']);
    }
    if (entries[2].kind === 'single') expect(entries[2].task.id).toBe('e');
  });

  it('renders a singleton with parallelGroup set as a single entry (group-of-one)', () => {
    const tasks = [
      makeTask('a', { parallelGroup: 'g1' }),
      makeTask('b'),
    ];
    const entries = groupTasksByParallelRun(tasks);

    expect(entries).toHaveLength(2);
    expect(entries[0].kind).toBe('single');
    if (entries[0].kind === 'single') {
      expect(entries[0].task.id).toBe('a');
      expect(entries[0].task.parallelGroup).toBe('g1');
    }
    expect(entries[1].kind).toBe('single');
  });

  it('does not cluster non-adjacent same-group tasks (split by a non-member)', () => {
    const tasks = [
      makeTask('a1', { parallelGroup: 'g1' }),
      makeTask('a2', { parallelGroup: 'g1' }),
      makeTask('b'),
      makeTask('a3', { parallelGroup: 'g1' }),
    ];
    const entries = groupTasksByParallelRun(tasks);

    expect(entries).toHaveLength(3);
    expect(entries[0].kind).toBe('group');
    if (entries[0].kind === 'group') {
      expect(entries[0].groupId).toBe('g1');
      expect(entries[0].tasks.map(t => t.id)).toEqual(['a1', 'a2']);
    }
    expect(entries[1].kind).toBe('single');
    if (entries[1].kind === 'single') expect(entries[1].task.id).toBe('b');
    expect(entries[2].kind).toBe('single');
    if (entries[2].kind === 'single') expect(entries[2].task.id).toBe('a3');
  });
});

describe('MissionProgressCard swimlane rendering', () => {
  afterEach(() => {
    document.body.className = '';
    document.body.innerHTML = '';
  });

  const swimlaneTasks: TaskProgressItem[] = [
    { id: 'p-1', title: 'Read your emails', status: 'in_progress', parallelGroup: 'g1' },
    { id: 'p-2', title: 'Check your calendar', status: 'pending', parallelGroup: 'g1' },
    { id: 'p-3', title: 'Pull the latest doc', status: 'pending', parallelGroup: 'g1' },
    { id: 's-1', title: 'Draft the synthesis', status: 'pending' },
  ];

  it('wraps a contiguous parallel group into a single swimlane and leaves singletons untouched', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    act(() => {
      root.render(
        <MissionProgressCard
          taskProgress={swimlaneTasks}
          embedded
        />,
      );
    });

    const swimlanes = container.querySelectorAll('[data-testid="swimlane"]');
    expect(swimlanes).toHaveLength(1);

    const swimlaneRows = swimlanes[0].querySelectorAll('.swimlaneList > li');
    expect(swimlaneRows).toHaveLength(3);

    expect(container.textContent).toContain('At the same time');

    act(() => root.unmount());
  });

  it('marks a fully completed swimlane with the swimlaneComplete modifier', () => {
    const completedGroup: TaskProgressItem[] = [
      { id: 'q-1', title: 'Search inbox', status: 'completed', parallelGroup: 'g2' },
      { id: 'q-2', title: 'Search calendar', status: 'completed', parallelGroup: 'g2' },
      { id: 'q-3', title: 'Search drive', status: 'completed', parallelGroup: 'g2' },
    ];

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    act(() => {
      root.render(
        <MissionProgressCard
          taskProgress={completedGroup}
          embedded
        />,
      );
    });

    const swimlane = container.querySelector('[data-testid="swimlane"]');
    expect(swimlane).toBeTruthy();
    expect(swimlane?.className).toContain('swimlaneComplete');

    act(() => root.unmount());
  });

  it('renders an all-singleton plan flat, with zero swimlanes', () => {
    const singletonsOnly: TaskProgressItem[] = [
      { id: 'one', title: 'Read your emails', status: 'completed' },
      { id: 'two', title: 'Check your calendar', status: 'in_progress' },
      { id: 'three', title: 'Draft the synthesis', status: 'pending' },
    ];

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    act(() => {
      root.render(
        <MissionProgressCard
          taskProgress={singletonsOnly}
          embedded
        />,
      );
    });

    expect(container.querySelectorAll('[data-testid="swimlane"]')).toHaveLength(0);
    expect(container.textContent).not.toContain('At the same time');
    expect(container.querySelectorAll('.taskList > .task')).toHaveLength(3);

    act(() => root.unmount());
  });
});

describe('MissionProgressCard swimlane live state', () => {
  afterEach(() => {
    document.body.className = '';
    document.body.innerHTML = '';
  });

  function renderTasks(taskProgress: TaskProgressItem[]): { container: HTMLElement; root: Root } {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => {
      root.render(<MissionProgressCard taskProgress={taskProgress} embedded />);
    });
    return { container, root };
  }

  it('adds the swimlaneLive class when 2+ tasks in the group are in_progress', () => {
    const { container, root } = renderTasks([
      { id: 'p-1', title: 'Read your emails', status: 'in_progress', parallelGroup: 'g1' },
      { id: 'p-2', title: 'Check your calendar', status: 'in_progress', parallelGroup: 'g1' },
    ]);

    const swimlane = container.querySelector('[data-testid="swimlane"]');
    expect(swimlane).toBeTruthy();
    expect(swimlane?.className).toContain('swimlaneLive');

    act(() => root.unmount());
  });

  it('does NOT add swimlaneLive when only one task in the group is in_progress', () => {
    const { container, root } = renderTasks([
      { id: 'p-1', title: 'Read your emails', status: 'in_progress', parallelGroup: 'g1' },
      { id: 'p-2', title: 'Check your calendar', status: 'pending', parallelGroup: 'g1' },
    ]);

    const swimlane = container.querySelector('[data-testid="swimlane"]');
    expect(swimlane).toBeTruthy();
    expect(swimlane?.className).not.toContain('swimlaneLive');

    act(() => root.unmount());
  });

  it('does NOT add swimlaneLive when all tasks in the group are completed', () => {
    const { container, root } = renderTasks([
      { id: 'p-1', title: 'Search inbox', status: 'completed', parallelGroup: 'g2' },
      { id: 'p-2', title: 'Search calendar', status: 'completed', parallelGroup: 'g2' },
    ]);

    const swimlane = container.querySelector('[data-testid="swimlane"]');
    expect(swimlane).toBeTruthy();
    expect(swimlane?.className).toContain('swimlaneComplete');
    expect(swimlane?.className).not.toContain('swimlaneLive');

    act(() => root.unmount());
  });
});

describe('MissionProgressCard parallel in_progress regression coverage', () => {
  afterEach(() => {
    document.body.className = '';
    document.body.innerHTML = '';
  });

  function renderTasks(
    taskProgress: TaskProgressItem[],
    options: { isThinking?: boolean } = {},
  ): { container: HTMLElement; root: Root } {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => {
      root.render(
        <MissionProgressCard
          taskProgress={taskProgress}
          isThinking={options.isThinking ?? false}
          embedded
        />,
      );
    });
    return { container, root };
  }

  it('renders all four parallel siblings as in_progress when all four are in_progress', () => {
    const { container, root } = renderTasks([
      { id: 'p-1', title: 'Parallel 1', status: 'in_progress', parallelGroup: 'g1' },
      { id: 'p-2', title: 'Parallel 2', status: 'in_progress', parallelGroup: 'g1' },
      { id: 'p-3', title: 'Parallel 3', status: 'in_progress', parallelGroup: 'g1' },
      { id: 'p-4', title: 'Parallel 4', status: 'in_progress', parallelGroup: 'g1' },
    ]);

    const swimlane = container.querySelector('[data-testid="swimlane"]');
    expect(swimlane).toBeTruthy();
    expect(swimlane?.className).toContain('swimlaneLive');
    expect(swimlane?.querySelectorAll('.indicatorCircle_in_progress')).toHaveLength(4);

    act(() => root.unmount());
  });

  it('window math holds with multiple in_progress siblings', () => {
    const { container, root } = renderTasks([
      { id: 't-1', title: 'Step 1', status: 'completed' },
      { id: 't-2', title: 'Step 2', status: 'completed' },
      { id: 't-3', title: 'Step 3', status: 'in_progress', parallelGroup: 'g1' },
      { id: 't-4', title: 'Step 4', status: 'in_progress', parallelGroup: 'g1' },
      { id: 't-5', title: 'Step 5', status: 'in_progress', parallelGroup: 'g1' },
      { id: 't-6', title: 'Step 6', status: 'pending' },
      { id: 't-7', title: 'Step 7', status: 'pending' },
      { id: 't-8', title: 'Step 8', status: 'pending' },
      { id: 't-9', title: 'Step 9', status: 'pending' },
      { id: 't-10', title: 'Step 10', status: 'pending' },
    ]);

    expect(container.textContent).toContain('Showing steps 1-8 of 10');
    expect(container.textContent).toContain('Step 1');
    expect(container.textContent).toContain('Step 8');
    expect(container.textContent).not.toContain('Step 9');
    expect(container.textContent).not.toContain('Step 10');

    act(() => root.unmount());
  });

  it('inferredCurrentId self-suppresses when explicit in_progress siblings exist', () => {
    const { container, root } = renderTasks([
      { id: 'c-1', title: 'Completed step', status: 'completed' },
      { id: 'p-1', title: 'Parallel 1', status: 'in_progress', parallelGroup: 'g1' },
      { id: 'p-2', title: 'Parallel 2', status: 'in_progress', parallelGroup: 'g1' },
      { id: 'n-1', title: 'Pending step', status: 'pending' },
    ], { isThinking: true });

    expect(container.querySelectorAll('.indicatorCircle_in_progress')).toHaveLength(2);
    const pendingRow = Array.from(container.querySelectorAll('.task'))
      .find((row) => row.textContent?.includes('Pending step'));
    expect(pendingRow).toBeTruthy();
    expect(pendingRow?.className).toContain('task_pending');
    expect(pendingRow?.className).not.toContain('task_in_progress');

    act(() => root.unmount());
  });
});

describe('MissionProgressCard blocked rows', () => {
  afterEach(() => {
    document.body.className = '';
    document.body.innerHTML = '';
  });

  function renderTasks(taskProgress: TaskProgressItem[]): { container: HTMLElement; root: Root } {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => {
      root.render(<MissionProgressCard taskProgress={taskProgress} embedded />);
    });
    return { container, root };
  }

  it('renders a plain circle indicator for a blocked row', () => {
    const { container, root } = renderTasks([
      { id: 'a', title: 'Pull last week notes', status: 'completed' },
      { id: 'b', title: 'Wait on finance numbers', status: 'blocked', blockers: ['a'] },
    ]);

    expect(container.querySelector('.indicatorCircle_blocked')).toBeTruthy();
    expect(container.querySelector('[data-icon="pause"]')).toBeNull();

    act(() => root.unmount());
  });

  it('shows "Waiting on: <title>" inline for a blocked row with one resolvable blocker', () => {
    const { container, root } = renderTasks([
      { id: 'src', title: 'Pull source notes', status: 'completed' },
      { id: 'b', title: 'Wait on dependency', status: 'blocked', blockers: ['src'] },
    ]);

    const inline = container.querySelector('[data-testid="task-blocker-inline-b"]');
    expect(inline?.textContent).toBe('Waiting on: Pull source notes');

    act(() => root.unmount());
  });

  it('shows "Waiting on: <first> +N more" for a blocked row with multiple resolvable blockers', () => {
    const { container, root } = renderTasks([
      { id: 'a', title: 'Pull source notes', status: 'completed' },
      { id: 'c', title: 'Cross reference deck', status: 'completed' },
      { id: 'd', title: 'Confirm with finance', status: 'completed' },
      { id: 'b', title: 'Wait on dependencies', status: 'blocked', blockers: ['a', 'c', 'd'] },
    ]);

    const inline = container.querySelector('[data-testid="task-blocker-inline-b"]');
    expect(inline?.textContent).toBe('Waiting on: Pull source notes +2 more');

    act(() => root.unmount());
  });

  it('falls back to "Waiting on earlier steps" when blockers cannot be resolved', () => {
    const { container, root } = renderTasks([
      { id: 'b', title: 'Wait on missing tasks', status: 'blocked', blockers: ['missing-1', 'missing-2'] },
    ]);

    const inline = container.querySelector('[data-testid="task-blocker-inline-b"]');
    expect(inline?.textContent).toBe('Waiting on earlier steps');

    act(() => root.unmount());
  });

  it('hides the inline subtext when the blocked row is expanded (the expandedBlockers accordion owns the detail)', () => {
    const { container, root } = renderTasks([
      { id: 'src', title: 'Pull source notes', status: 'completed' },
      { id: 'b', title: 'Wait on dependency', status: 'blocked', blockers: ['src'] },
    ]);

    const expandTrigger = container.querySelector('[data-testid="task-expand-b"]') as HTMLElement | null;
    expect(expandTrigger).toBeTruthy();

    act(() => {
      expandTrigger?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(container.querySelector('[data-testid="task-blocker-inline-b"]')).toBeNull();
    expect(container.querySelector('[data-testid="task-expanded-b"]')).toBeTruthy();

    act(() => root.unmount());
  });
});
