import type { Meta, StoryObj } from '@storybook/react';
import type { AgentEvent } from '@shared/types';
import { buildAgentEvent } from '@shared/contracts/agentEventManifest';
import { ContextualProgressCard, type ContextualProgressCardProps } from './ContextualProgressCard';
import type { TaskProgressItem } from '../utils/turnStepContext';
import type { SubAgentTimeline, SubAgentTimelineItem } from '../utils/subAgentTimeline';

const meta = {
  title: 'Agent Session/ContextualProgressCard',
  component: ContextualProgressCard,
  parameters: {
    layout: 'padded',
    controls: { disable: true },
    docs: {
      description: {
        component:
          'Thinking-panel card showing the plan, the live activity line, and (collapsed) technical details. These stories focus on the Stage 2 parallel-batch swimlane treatment in the Planning section: a quiet "At the same time" lane that groups contiguous parallel tasks, with a muted-but-visible variant when the whole batch has finished.',
      },
    },
  },
} satisfies Meta<typeof ContextualProgressCard>;

export default meta;
type Story = StoryObj<typeof meta>;

const makeTask = (
  id: string,
  title: string,
  status: TaskProgressItem['status'],
  parallelGroup?: string,
): TaskProgressItem => ({ id, title, status, parallelGroup });

const allSingletons: TaskProgressItem[] = [
  makeTask('s1', 'Read your latest emails', 'completed'),
  makeTask('s2', 'Skim your calendar for tomorrow', 'in_progress'),
  makeTask('s3', 'Draft a daily briefing', 'pending'),
];

const groupOfThreeMixed: TaskProgressItem[] = [
  makeTask('intro', 'Recap yesterday', 'completed'),
  makeTask('p1', 'Read your emails', 'completed', 'g1'),
  makeTask('p2', 'Check your calendar', 'in_progress', 'g1'),
  makeTask('p3', 'Pull the launch doc', 'pending', 'g1'),
  makeTask('after', 'Synthesize a briefing', 'pending'),
];

const groupFullyComplete: TaskProgressItem[] = [
  makeTask('p1', 'Search inbox', 'completed', 'g2'),
  makeTask('p2', 'Search calendar', 'completed', 'g2'),
  makeTask('summary', 'Write the digest', 'in_progress'),
];

const groupSpanningBlocked: TaskProgressItem[] = [
  makeTask('p1', 'Pull last week\u2019s notes', 'completed', 'g3'),
  { ...makeTask('p2', 'Wait for finance numbers', 'blocked', 'g3'), blockers: ['p1'] },
  makeTask('p3', 'Cross-reference the deck', 'pending', 'g3'),
  makeTask('after', 'Stitch the briefing together', 'pending'),
];

const mixedPlan: TaskProgressItem[] = [
  makeTask('intro', 'Frame the goal', 'completed'),
  makeTask('p1', 'Read emails', 'completed', 'g1'),
  makeTask('p2', 'Check calendar', 'in_progress', 'g1'),
  makeTask('p3', 'Skim Slack', 'pending', 'g1'),
  makeTask('mid', 'Notice the patterns', 'pending'),
  makeTask('q1', 'Draft section A', 'pending', 'g2'),
  makeTask('q2', 'Draft section B', 'pending', 'g2'),
];

const groupOfThreeTwoLive: TaskProgressItem[] = [
  makeTask('intro', 'Frame the goal', 'completed'),
  makeTask('p1', 'Read your emails', 'in_progress', 'g1'),
  makeTask('p2', 'Check your calendar', 'in_progress', 'g1'),
  makeTask('p3', 'Pull the launch doc', 'pending', 'g1'),
  makeTask('after', 'Synthesize a briefing', 'pending'),
];

const makeRunningSubAgent = (id: string, label: string, summary: string): SubAgentTimelineItem => ({
  id,
  label,
  summary,
  status: 'running',
  isBackground: false,
  startedAt: Date.now() - 12_000,
  toolSummaries: [],
  stepRange: null,
});

const twoRunnersTimeline: SubAgentTimeline = {
  items: [
    makeRunningSubAgent('sa-1', 'researcher', 'Scan inbox for the brief'),
    makeRunningSubAgent('sa-2', 'researcher', 'Skim calendar for blockers'),
  ],
  summaryLabel: '2 assistants running',
  tooltip: '2 assistants running',
  totalCount: 2,
  runningCount: 2,
  toolCount: 0,
};

const baseProps = (taskProgress: TaskProgressItem[]): ContextualProgressCardProps => ({
  missionContext: { goal: 'Catch you up on what happened overnight' },
  taskProgress,
  steps: [],
  fileOperationsByStep: new Map(),
  toolSummariesByStep: new Map(),
  selectedStepNumber: null,
  isThinking: true,
  onSelectStep: () => undefined,
});

function ThemePair(args: ContextualProgressCardProps) {
  return (
    <div style={{ display: 'grid', gap: 'var(--space-4)', width: 720, maxWidth: '100%' }}>
      <div className="light" style={{ padding: 'var(--space-4)', background: 'var(--color-bg-page)' }}>
        <ContextualProgressCard {...args} />
      </div>
      <div className="dark" style={{ padding: 'var(--space-4)', background: 'var(--color-bg-page)' }}>
        <ContextualProgressCard {...args} />
      </div>
    </div>
  );
}

export const AllSingletons: Story = {
  render: () => <ThemePair {...baseProps(allSingletons)} />,
};

export const OneParallelGroupOfThreeMixedStatuses: Story = {
  render: () => <ThemePair {...baseProps(groupOfThreeMixed)} />,
};

export const ParallelGroupFullyCompleteMuted: Story = {
  render: () => <ThemePair {...baseProps(groupFullyComplete)} />,
};

export const GroupSpanningBlockedRow: Story = {
  render: () => <ThemePair {...baseProps(groupSpanningBlocked)} />,
  parameters: {
    docs: {
      description: {
        story:
          'Stage 3: the blocked row inside the swimlane uses the plain circle indicator and shows the "Waiting on: <title>" inline subtext (resolved against the preceding completed task) when collapsed. Click the row to expand and confirm the inline subtext gives way to the existing accordion.',
      },
    },
  },
};

export const MixedPlanSingletonsAndGroups: Story = {
  render: () => <ThemePair {...baseProps(mixedPlan)} />,
};

export const ParallelGroupLiveTwoRunning: Story = {
  render: () => <ThemePair {...baseProps(groupOfThreeTwoLive)} />,
  parameters: {
    docs: {
      description: {
        story:
          'Stage 4: when 2+ tasks in a parallel group are simultaneously in_progress, the swimlane container plays a 3s synchronized "breath" — a quiet indigo wash on the background plus a brightness bump on the left bar. The animation is driven from the swimlane container so all rows inherit a single phase. Look for the slow indigo pulse on the swimlane chrome, not on the rows themselves.',
      },
    },
  },
};

export const DoingRightNowTwoRunners: Story = {
  render: () => (
    <ThemePair
      {...baseProps(groupOfThreeTwoLive)}
      subAgentTimeline={twoRunnersTimeline}
    />
  ),
  parameters: {
    docs: {
      description: {
        story:
          'Stage 4: the "Doing right now" assistant-chip container plays the same shared breath when ≥2 sub-agents are running. The animation lives on the chip container, NOT each chip — single synchronized phase across the live batch. The existing per-chip Bot icons and the loading GIF stay unchanged.',
      },
    },
  },
};

export const ReducedMotionFallback: Story = {
  render: () => <ThemePair {...baseProps(groupOfThreeTwoLive)} />,
  parameters: {
    docs: {
      description: {
        story:
          'Stage 4 reduced-motion fallback. Enable Chrome DevTools → Rendering → "Emulate CSS media feature prefers-reduced-motion: reduce" to see the static slightly-stronger indigo treatment instead of the breathing animation. The swimlane gets a subtle indigo background tint and a brighter left bar; no animation runs.',
      },
    },
  },
};

const interruptedTaskProgress: TaskProgressItem[] = [
  makeTask('s1', 'Read the source-capture file', 'completed'),
  makeTask('s2', 'Draft the briefing summary', 'in_progress'),
];

const interruptedTurnEvents: AgentEvent[] = [
  buildAgentEvent.error(
    {
      error: 'fetch failed',
      errorSource: 'main',
      errorKind: 'server_error',
      isTransient: true,
      timestamp: Date.now(),
    },
    { sessionId: 'storybook-session', turnId: 'storybook-turn-interrupted' },
  ),
];

const interruptedProps: ContextualProgressCardProps = {
  missionContext: { goal: 'Catch you up on what happened overnight' },
  taskProgress: interruptedTaskProgress,
  steps: [],
  fileOperationsByStep: new Map(),
  toolSummariesByStep: new Map(),
  selectedStepNumber: null,
  isThinking: false,
  isBusy: false,
  isPaused: false,
  endedWith: 'transient_error',
  turnEvents: interruptedTurnEvents,
  onSelectStep: () => undefined,
};

export const InterruptedConnectionDropped: Story = {
  render: () => <ThemePair {...interruptedProps} />,
  parameters: {
    docs: {
      description: {
        story:
          'Stage 2 of the transient-error UX cleanup. When `endedWith === "transient_error"` the card branches to the interrupted treatment: WifiOff icon, "Rebel was interrupted" header, "Connection dropped — X/Y steps completed" collapsed bar, and "Connection dropped" live text under a "Result" section label. Reuses the existing amber `.statusIconError` palette so the visual ties back to the message-header `Connection dropped` badge.',
      },
    },
  },
};

// ───────────────────────────────────────────────────────────────────────────
// Stage 2 (260528 terminal-state presentation health): one ThemePair story per
// `data-state` value, so design-system-reviewer can confirm zero visual drift in
// both themes. These render the SAME treatments the card produces today — the
// presentation derivation (progressPresentation.ts) is behaviour-preserving.
// ───────────────────────────────────────────────────────────────────────────

// A turn with completed activity (one tool step) so `hadActivity` becomes true
// and the card can reach the terminal `complete` / silent-stop states.
const finishedTools = new Map([[1, [
  { label: 'Read file', icon: '📄', tone: 'files', status: 'success', toolName: 'read_file', toolUseId: 'tool-1' },
]]]) as ContextualProgressCardProps['toolSummariesByStep'];

const finishedTaskProgress: TaskProgressItem[] = [
  makeTask('s1', 'Read the source-capture file', 'completed'),
  makeTask('s2', 'Draft the briefing summary', 'completed'),
];

const incompleteTaskProgress: TaskProgressItem[] = [
  makeTask('s1', 'Read the source-capture file', 'completed'),
  makeTask('s2', 'Draft the briefing summary', 'in_progress'),
];

const terminalBase = (taskProgress: TaskProgressItem[]): ContextualProgressCardProps => ({
  missionContext: { goal: 'Catch you up on what happened overnight' },
  taskProgress,
  steps: [],
  fileOperationsByStep: new Map(),
  toolSummariesByStep: finishedTools,
  selectedStepNumber: null,
  isThinking: false,
  isBusy: false,
  isPaused: false,
  onSelectStep: () => undefined,
});

const awaitingUserEvents: AgentEvent[] = [
  buildAgentEvent.result(
    { text: '', turnEndReason: 'awaiting_user', timestamp: Date.now() },
    { sessionId: 'storybook-session', turnId: 'storybook-turn-await' },
  ),
];

export const Live: Story = {
  render: () => <ThemePair {...baseProps(allSingletons)} />,
  parameters: {
    docs: { description: { story: '`data-state="live"` — the thinking state (loading GIF, "Rebel’s thinking" header).' } },
  },
};

export const Complete: Story = {
  render: () => <ThemePair {...terminalBase(finishedTaskProgress)} />,
  parameters: {
    docs: { description: { story: '`data-state="complete"` — green Check, "How Rebel did this" header, "Finished" live text, "Result" section label.' } },
  },
};

export const Paused: Story = {
  render: () => <ThemePair {...terminalBase(incompleteTaskProgress)} isPaused />,
  parameters: {
    docs: { description: { story: '`data-state="paused"` — Brain indicator, "Rebel paused" header. Live text falls through to the activity status line (no paused arm).' } },
  },
};

export const SilentStoppedUser: Story = {
  render: () => <ThemePair {...terminalBase(incompleteTaskProgress)} isStopping />,
  parameters: {
    docs: { description: { story: '`data-state="silent_stopped_user"` — StopCircle info icon + "Stopped by you" banner. Header/live text fall through to complete/thinking (short ladders).' } },
  },
};

export const SilentStoppedAwait: Story = {
  render: () => <ThemePair {...terminalBase(incompleteTaskProgress)} turnEvents={awaitingUserEvents} />,
  parameters: {
    docs: { description: { story: '`data-state="silent_stopped_await"` — MessageSquare info icon + "Waiting for you" banner (no Continue button).' } },
  },
};

export const SilentStoppedUnexpected: Story = {
  render: () => <ThemePair {...terminalBase(incompleteTaskProgress)} />,
  parameters: {
    docs: { description: { story: '`data-state="silent_stopped_unexpected"` — warning AlertTriangle + "Stopped" banner with `role=alert`. Reached when a turn stops with incomplete tasks and no clear reason.' } },
  },
};

export const Superseded: Story = {
  render: () => <ThemePair {...terminalBase(finishedTaskProgress)} endedWith="superseded" />,
  parameters: {
    docs: { description: { story: '`data-state="superseded"` — renders BYTE-IDENTICALLY to `complete` today (deferred #2). It carries its own `data-state` key so a future distinct treatment is a one-place edit; this single story documents the equivalence.' } },
  },
};

const errorTools = new Map([[1, [
  { label: 'Run command', icon: '⚙️', tone: 'default', status: 'error', toolName: 'run_command', toolUseId: 'tool-err' },
]]]) as ContextualProgressCardProps['toolSummariesByStep'];

export const ErrorTone: Story = {
  render: () => (
    <ThemePair
      {...terminalBase(incompleteTaskProgress)}
      toolSummariesByStep={errorTools}
      isThinking
    />
  ),
  parameters: {
    docs: { description: { story: '`data-state="error"` — the orphan tool-error tone: amber AlertTriangle icon only, with header/live text falling through (no dedicated copy). Lower precedence than interrupted/complete.' } },
  },
};
