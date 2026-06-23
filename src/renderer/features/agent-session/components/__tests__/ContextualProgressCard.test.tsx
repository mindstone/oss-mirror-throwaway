// @vitest-environment happy-dom

import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '@shared/types';
import type { StepToolSummary } from '../../utils/toolChips';
import type { TaskProgressItem } from '../../utils/turnStepContext';
import { ContextualProgressCard, type ContextualProgressCardProps } from '../ContextualProgressCard';

const { navigationMock } = vi.hoisted(() => ({
  navigationMock: {
    navigate: vi.fn(),
  },
}));

vi.mock('@renderer/contexts/NavigationContext', () => ({
  useNavigationSafe: () => ({
    navigate: navigationMock.navigate,
    currentSurface: 'sessions',
    teamSelectedOperatorId: null,
  }),
}));

vi.mock('@renderer/src/analytics', () => ({
  analytics: { track: vi.fn() },
}));

describe('ContextualProgressCard Operator setup affordance', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    navigationMock.navigate.mockResolvedValue(true);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.clearAllMocks();
  });

  it('renders Operator setup as a clickable affordance and navigates to the deep-link', async () => {
    const toolSummary: StepToolSummary = {
      label: 'Rebel Operator Consult',
      icon: '🧠',
      tone: 'planning',
      status: 'success',
      toolName: 'rebel_operator__consult',
      resultPayload: {
        isError: false,
        calibrated: false,
        errorCode: null,
        operatorId: '/workspace/Chief-of-Staff::brand-critic',
        operatorName: 'Brand Critic',
      },
    };

    await act(async () => {
      root.render(
        <ContextualProgressCard
          steps={[]}
          fileOperationsByStep={new Map()}
          toolSummariesByStep={new Map([[1, [toolSummary]]])}
          selectedStepNumber={null}
          isThinking
          onSelectStep={() => undefined}
        />,
      );
    });

    const button = container.querySelector<HTMLButtonElement>(
      '[aria-label="Set up Brand Critic in Operators"]',
    );
    expect(button).toBeTruthy();

    await act(async () => {
      button?.click();
    });

    expect(navigationMock.navigate).toHaveBeenCalledWith(
      `rebel://team/${encodeURIComponent('/workspace/Chief-of-Staff::brand-critic')}`,
    );
  });
});

describe('ContextualProgressCard transient_error termination', () => {
  let container: HTMLDivElement;
  let root: Root;

  const taskProgress: TaskProgressItem[] = [
    { id: 't1', title: 'First step', status: 'completed' },
    { id: 't2', title: 'Second step', status: 'in_progress' },
  ];

  const toolSummary: StepToolSummary = {
    label: 'Read file',
    icon: '📄',
    tone: 'files',
    status: 'success',
    toolName: 'read_file',
  };

  // Realistic transient_error scenario: an error event lands on the turn,
  // which makes detectSilentStop classify as 'error_exit' (hasSilentStop:
  // false) so the silent-stop banner does not double up with the new
  // interrupted UI.
  const errorTurnEvents: AgentEvent[] = [
    {
      type: 'error',
      error: 'fetch failed',
      timestamp: Date.now(),
    } as AgentEvent,
  ];

  const baseTerminalProps = (): ContextualProgressCardProps => ({
    steps: [],
    fileOperationsByStep: new Map(),
    toolSummariesByStep: new Map([[1, [toolSummary]]]),
    selectedStepNumber: null,
    isThinking: false,
    isBusy: false,
    isPaused: false,
    taskProgress,
    turnEvents: errorTurnEvents,
    onSelectStep: () => undefined,
  });

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.clearAllMocks();
  });

  async function renderAndExpand(props: ContextualProgressCardProps) {
    await act(async () => {
      root.render(<ContextualProgressCard {...props} />);
    });
    const collapsedBar = container.querySelector<HTMLDivElement>('[role="button"]');
    if (collapsedBar) {
      await act(async () => {
        collapsedBar.click();
      });
    }
  }

  it('renders "Connection dropped" in the collapsed bar when endedWith=transient_error', async () => {
    await act(async () => {
      root.render(<ContextualProgressCard {...baseTerminalProps()} endedWith="transient_error" />);
    });

    const html = container.innerHTML;
    expect(html).toContain('Connection dropped');
    expect(html).not.toContain('Done — ');
    expect(html).not.toContain('Finished');

    const ariaLabelButton = container.querySelector('[role="button"]');
    expect(ariaLabelButton?.getAttribute('aria-label')).toContain('Connection dropped');
  });

  it('renders the WifiOff icon (via lucide svg) when endedWith=transient_error', async () => {
    await act(async () => {
      root.render(<ContextualProgressCard {...baseTerminalProps()} endedWith="transient_error" />);
    });

    const svg = container.querySelector('svg');
    expect(svg).toBeTruthy();
    const className = svg?.getAttribute('class') ?? '';
    expect(className.toLowerCase()).toContain('wifi');
    expect(className).not.toContain('lucide-check');
  });

  it('renders "Rebel was interrupted" header text in expanded card', async () => {
    await renderAndExpand({ ...baseTerminalProps(), endedWith: 'transient_error' });

    const html = container.innerHTML;
    expect(html).toContain('Rebel was interrupted');
    expect(html).not.toContain('How Rebel did this');
  });

  it('renders "Connection dropped" live text and "Result" section label in expanded card', async () => {
    await renderAndExpand({ ...baseTerminalProps(), endedWith: 'transient_error' });

    const html = container.innerHTML;
    expect(html).toContain('Connection dropped');
    expect(html).toContain('Result');
    expect(html).not.toContain('Finished');
    expect(html).not.toContain('Doing right now');
  });

  it('emits data-state="interrupted" (not complete) when endedWith=transient_error (MA-2 regression)', async () => {
    await renderAndExpand({ ...baseTerminalProps(), endedWith: 'transient_error' });

    // New public contract: assert the data-state attribute on the card root.
    const card = container.querySelector('[data-state]');
    expect(card?.getAttribute('data-state')).toBe('interrupted');
    expect(card?.getAttribute('data-state')).not.toBe('complete');

    // Belt-and-braces: keep the old hashed-class negatives alongside the new
    // contract during migration (don't drop the old guard until the new is green).
    // CSS-Modules hashed names include the source class identifier as a substring.
    const html = container.innerHTML;
    expect(html).not.toContain('statusTextComplete');
    expect(html).not.toContain('liveTextDone');
    expect(html).not.toContain('sectionLabelComplete');
  });

  it('emits data-state="superseded" with complete-equivalent UI when endedWith=superseded', async () => {
    await renderAndExpand({ ...baseTerminalProps(), endedWith: 'superseded' });

    // superseded has its OWN data-state key (so a future distinct treatment is a
    // one-place edit) but renders byte-identically to complete today (invariant #8).
    const card = container.querySelector('[data-state]');
    expect(card?.getAttribute('data-state')).toBe('superseded');

    const html = container.innerHTML;
    expect(html).toContain('How Rebel did this');
    expect(html).toContain('Finished');
    expect(html).not.toContain('Rebel was interrupted');
    expect(html).not.toContain('Connection dropped');
  });

  it('emits data-state="complete" and preserves existing behaviour when endedWith is undefined (regression)', async () => {
    await renderAndExpand(baseTerminalProps());

    const card = container.querySelector('[data-state]');
    expect(card?.getAttribute('data-state')).toBe('complete');

    const html = container.innerHTML;
    expect(html).toContain('How Rebel did this');
    expect(html).toContain('Finished');
    expect(html).not.toContain('Rebel was interrupted');
    expect(html).not.toContain('Connection dropped');
  });

  it('renders "Connection dropped" without step count when no taskProgress', async () => {
    const props: ContextualProgressCardProps = {
      ...baseTerminalProps(),
      taskProgress: undefined,
    };

    await act(async () => {
      root.render(<ContextualProgressCard {...props} endedWith="transient_error" />);
    });

    const statusText = container.querySelector('[aria-live="polite"]');
    expect(statusText?.textContent).toBe('Connection dropped');
  });
});

describe('ContextualProgressCard FOX-2771 interrupted + timeout affordances', () => {
  let container: HTMLDivElement;
  let root: Root;

  const taskProgress: TaskProgressItem[] = [
    { id: 't1', title: 'First step', status: 'completed' },
    { id: 't2', title: 'Second step', status: 'in_progress' },
  ];

  const toolSummary: StepToolSummary = {
    label: 'Read file',
    icon: '📄',
    tone: 'files',
    status: 'success',
    toolName: 'read_file',
  };

  // App-closed interruption: the synthetic status appended by
  // markSessionTurnsAsCompleted is the turn's LAST event.
  const interruptedTurnEvents: AgentEvent[] = [
    {
      type: 'status',
      message: 'Agent turn interrupted when Mindstone Rebel closed.',
      timestamp: Date.now(),
    } as AgentEvent,
  ];

  // Continue-eligible watchdog timeout: terminal error event.
  const watchdogTurnEvents: AgentEvent[] = [
    {
      type: 'error',
      error: 'This turn was unresponsive for 12 minutes and was stopped automatically. You can try sending your message again.',
      timestamp: Date.now(),
    } as AgentEvent,
  ];

  const baseProps = (): ContextualProgressCardProps => ({
    steps: [],
    fileOperationsByStep: new Map(),
    toolSummariesByStep: new Map([[1, [toolSummary]]]),
    selectedStepNumber: null,
    isThinking: false,
    isBusy: false,
    isPaused: false,
    taskProgress,
    onSelectStep: () => undefined,
  });

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.clearAllMocks();
  });

  async function renderAndExpand(props: ContextualProgressCardProps) {
    await act(async () => {
      root.render(<ContextualProgressCard {...props} />);
    });
    const collapsedBar = container.querySelector<HTMLDivElement>('[role="button"]');
    if (collapsedBar) {
      await act(async () => {
        collapsedBar.click();
      });
    }
  }

  // App-close interruption WITH the quit-vs-crash discriminator (FOX-2771 follow-up).
  const shutdownTurnEvents: AgentEvent[] = [
    {
      type: 'status',
      message: 'Agent turn interrupted when Mindstone Rebel closed.',
      timestamp: Date.now(),
      source: 'shutdown',
    } as AgentEvent,
  ];
  const startupCorrectionTurnEvents: AgentEvent[] = [
    {
      type: 'status',
      message: 'Agent turn interrupted when Mindstone Rebel closed.',
      timestamp: Date.now(),
      source: 'startup-correction',
    } as AgentEvent,
  ];

  it('app-closed interrupted (unknown source): collapsed aria-label mirrors the visible "Interrupted" copy, not "Done" (review F1)', async () => {
    await act(async () => {
      root.render(<ContextualProgressCard {...baseProps()} turnEvents={interruptedTurnEvents} />);
    });

    const statusText = container.querySelector('[aria-live="polite"]');
    expect(statusText?.textContent).toBe('Interrupted — 1 step remaining');

    const collapsedBar = container.querySelector('[role="button"]');
    const ariaLabel = collapsedBar?.getAttribute('aria-label') ?? '';
    expect(ariaLabel).toContain('Interrupted — 1 step remaining');
    expect(ariaLabel).not.toContain('Done');
  });

  it('app-closed interrupted: NO WifiOff icon and NO "Connection dropped"/"Done" (FOX-2771 follow-up regression)', async () => {
    await renderAndExpand({ ...baseProps(), turnEvents: interruptedTurnEvents });

    const html = container.innerHTML;
    expect(html.toLowerCase()).not.toContain('wifi'); // never the connectivity metaphor
    expect(html).not.toContain('Connection dropped');
    expect(html).not.toContain('Finished');
    expect(html).not.toContain('Done — ');

    const card = container.querySelector('[data-state]');
    expect(card?.getAttribute('data-state')).toBe('interrupted');
  });

  it('app-closed interrupted source=shutdown: "Closed"/"Rebel was closed" + Power icon, never WifiOff', async () => {
    const onContinue = vi.fn();
    await renderAndExpand({ ...baseProps(), turnEvents: shutdownTurnEvents, onContinue });

    const html = container.innerHTML;
    expect(html).toContain('Rebel was closed'); // header
    expect(html).toContain('Closed before finishing'); // live text
    expect(html).toContain('Rebel was closed before this finished — 1 step remaining'); // banner
    expect(html.toLowerCase()).toContain('lucide-power');
    expect(html.toLowerCase()).not.toContain('wifi');

    const continueButton = Array.from(container.querySelectorAll('button'))
      .find((b) => b.textContent === 'Continue');
    expect(continueButton).toBeTruthy();
  });

  it('app-closed interrupted source=startup-correction: "Restarted"/"Rebel restarted" + RotateCcw icon, never WifiOff', async () => {
    await renderAndExpand({ ...baseProps(), turnEvents: startupCorrectionTurnEvents });

    const html = container.innerHTML;
    expect(html).toContain('Rebel restarted'); // header
    expect(html).toContain('Restarted before finishing'); // live text
    expect(html).toContain('Rebel restarted before this finished — 1 step remaining'); // banner
    expect(html.toLowerCase()).toContain('lucide-rotate-ccw');
    expect(html.toLowerCase()).not.toContain('wifi');
  });

  it('app-closed interrupted source=shutdown: collapsed visible text + aria-label both read "Closed — 1 step remaining" (review F1)', async () => {
    await act(async () => {
      root.render(<ContextualProgressCard {...baseProps()} turnEvents={shutdownTurnEvents} />);
    });

    const statusText = container.querySelector('[aria-live="polite"]');
    expect(statusText?.textContent).toBe('Closed — 1 step remaining');

    const collapsedBar = container.querySelector('[role="button"]');
    const ariaLabel = collapsedBar?.getAttribute('aria-label') ?? '';
    expect(ariaLabel).toContain('Closed — 1 step remaining');
    // Visible text and aria stay mirrored (no "Done"/network drift).
    expect(ariaLabel).not.toContain('Done');
    expect(ariaLabel).not.toContain('Interrupted');
  });

  it('app-closed interrupted source=startup-correction: collapsed visible text + aria-label both read "Restarted — 1 step remaining" (review F1)', async () => {
    await act(async () => {
      root.render(<ContextualProgressCard {...baseProps()} turnEvents={startupCorrectionTurnEvents} />);
    });

    const statusText = container.querySelector('[aria-live="polite"]');
    expect(statusText?.textContent).toBe('Restarted — 1 step remaining');

    const collapsedBar = container.querySelector('[role="button"]');
    const ariaLabel = collapsedBar?.getAttribute('aria-label') ?? '';
    expect(ariaLabel).toContain('Restarted — 1 step remaining');
    expect(ariaLabel).not.toContain('Done');
    expect(ariaLabel).not.toContain('Interrupted');
  });

  it('app-closed interrupted (unknown source): generic "Rebel was interrupted" header + banner; still non-network Power icon', async () => {
    const onContinue = vi.fn();
    await renderAndExpand({ ...baseProps(), turnEvents: interruptedTurnEvents, onContinue });

    const html = container.innerHTML;
    expect(html).toContain('Rebel was interrupted'); // generic header preserved
    expect(html).toContain('Rebel was interrupted before this finished — 1 step remaining'); // banner
    expect(html.toLowerCase()).toContain('lucide-power');
    expect(html.toLowerCase()).not.toContain('wifi');

    const continueButton = Array.from(container.querySelectorAll('button'))
      .find((b) => b.textContent === 'Continue');
    expect(continueButton).toBeTruthy();
  });

  it('watchdog timeout: banner uses DISTINCT "Timed out" copy + Clock icon, not "Interrupted"/WifiOff (Composer F4)', async () => {
    const onContinue = vi.fn();
    await renderAndExpand({ ...baseProps(), turnEvents: watchdogTurnEvents, onContinue });

    const html = container.innerHTML;
    expect(html).toContain('Timed out — 1 step remaining');
    expect(html).not.toContain('Interrupted — 1 step remaining');
    // Banner icon: Clock, not WifiOff (the WifiOff treatment is app-close/connection).
    expect(html.toLowerCase()).toContain('lucide-clock');

    const continueButton = Array.from(container.querySelectorAll('button'))
      .find((b) => b.textContent === 'Continue');
    expect(continueButton).toBeTruthy();
  });

  it('non-eligible error: no banner, no Continue (error banner owns the failure display)', async () => {
    const onContinue = vi.fn();
    const genericErrorEvents: AgentEvent[] = [
      { type: 'error', error: 'Your credit balance is too low.', timestamp: Date.now() } as AgentEvent,
    ];
    await renderAndExpand({ ...baseProps(), turnEvents: genericErrorEvents, onContinue });

    const html = container.innerHTML;
    expect(html).not.toContain('Timed out —');
    const continueButton = Array.from(container.querySelectorAll('button'))
      .find((b) => b.textContent === 'Continue');
    expect(continueButton).toBeFalsy();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Stage 4 — "one thing at a time": persona quip is a quiet, gated fallback;
// exactly one aria-live region during a turn; elapsed stays visible; sub-agent
// chips no longer stack as a competing row in the calm default.
// ───────────────────────────────────────────────────────────────────────────
describe('ContextualProgressCard Stage 4 — waiting line re-weighting', () => {
  let container: HTMLDivElement;
  let root: Root;

  const runningTool: StepToolSummary = {
    label: 'Read file',
    icon: '📄',
    tone: 'files',
    status: 'running',
    toolName: 'read_file',
  } as StepToolSummary;

  const baseThinkingProps = (): ContextualProgressCardProps => ({
    steps: [],
    fileOperationsByStep: new Map(),
    toolSummariesByStep: new Map(),
    selectedStepNumber: null,
    isThinking: true,
    isBusy: true,
    isPaused: false,
    onSelectStep: () => undefined,
  });

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it('shows exactly ONE aria-live region during a live turn', async () => {
    await act(async () => {
      root.render(
        <ContextualProgressCard
          {...baseThinkingProps()}
          toolSummariesByStep={new Map([[1, [runningTool]]])}
          thinkingHeadline="Skimming your brief like a seasoned editor."
        />,
      );
    });
    const liveRegions = container.querySelectorAll('[aria-live="polite"]');
    expect(liveRegions.length).toBe(1);
  });

  it('does NOT render the persona quip when there is concrete tool activity', async () => {
    await act(async () => {
      root.render(
        <ContextualProgressCard
          {...baseThinkingProps()}
          toolSummariesByStep={new Map([[1, [runningTool]]])}
          thinkingHeadline="Skimming your brief like a seasoned editor."
        />,
      );
    });
    // The primary line shows the concrete activity, never the quip.
    expect(container.textContent).toContain('Reading through your content');
    expect(container.textContent).not.toContain('Skimming your brief');
  });

  it('does NOT leak the tip Info icon onto a concrete tool line', async () => {
    await act(async () => {
      root.render(
        <ContextualProgressCard
          {...baseThinkingProps()}
          toolSummariesByStep={new Map([[1, [runningTool]]])}
          // A tip-shaped headline while a tool runs — the icon must not appear
          // on the concrete primary line.
          thinkingHeadline="**Tip:** You can drag files straight into the chat."
        />,
      );
    });
    const html = container.innerHTML.toLowerCase();
    expect(html).toContain('reading through your content');
    expect(html).not.toContain('lucide-info');
  });

  it('renders the persona quip as a quiet, aria-hidden fallback in a genuine idle gap', async () => {
    await act(async () => {
      root.render(
        <ContextualProgressCard
          {...baseThinkingProps()}
          toolSummariesByStep={new Map()}
          thinkingHeadline="Surveying the territory before committing to a route."
        />,
      );
    });
    // Primary line is the calm "Getting started" anchor; quip is the secondary line.
    expect(container.textContent).toContain('Getting started');
    expect(container.textContent).toContain('Surveying the territory');

    // The quip lives in an aria-hidden container so screen readers are not spammed.
    const quipText = Array.from(container.querySelectorAll('span'))
      .find((el) => el.textContent === 'Surveying the territory before committing to a route.');
    expect(quipText).toBeTruthy();
    const hiddenAncestor = quipText?.closest('[aria-hidden="true"]');
    expect(hiddenAncestor).toBeTruthy();
    // And it is NOT inside the single aria-live region.
    expect(quipText?.closest('[aria-live="polite"]')).toBeFalsy();
  });

  it('keeps the quiet elapsed timer visible during a turn (DA SHOULD-4)', async () => {
    await act(async () => {
      root.render(
        <ContextualProgressCard
          {...baseThinkingProps()}
          toolSummariesByStep={new Map([[1, [runningTool]]])}
          thinkingHeadline="Skimming your brief like a seasoned editor."
          thinkingElapsedLabel="1m 20s"
        />,
      );
    });
    expect(container.textContent).toContain('1m 20s');
    // Elapsed must not be an aria-live region (would announce every tick).
    const elapsed = Array.from(container.querySelectorAll('span'))
      .find((el) => el.textContent === '1m 20s');
    expect(elapsed?.closest('[aria-live="polite"]')).toBeFalsy();
  });

  it('suppresses the quip while a concrete line is fresh, then re-engages once static past the threshold (DA SHOULD-4)', async () => {
    vi.useFakeTimers();
    try {
      await act(async () => {
        root.render(
          <ContextualProgressCard
            {...baseThinkingProps()}
            // A running tool = concrete primary line ("Reading through your
            // content"). The quip stays suppressed until that line has been
            // static past the ~25s long-wait threshold.
            toolSummariesByStep={new Map([[1, [runningTool]]])}
            thinkingHeadline="Surveying the territory before committing to a route."
          />,
        );
      });

      // Before the threshold: only the concrete primary line, no secondary quip.
      expect(container.textContent).toContain('Reading through your content');
      expect(container.textContent).not.toContain('Surveying the territory');

      // Advance past the long-wait threshold (~25s) — the static clock ticks.
      await act(async () => {
        vi.advanceTimersByTime(26_000);
      });

      // Now the quip surfaces as a quiet secondary line for reassurance, while
      // the concrete primary line stays put.
      expect(container.textContent).toContain('Reading through your content');
      expect(container.textContent).toContain('Surveying the territory');
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not stack a competing sub-agent chips row in the calm default', async () => {
    // Sub-agent running, no higher-priority tool: the primary line names the
    // assistant activity; the chips row must NOT also render in the calm default.
    const subAgentTimeline = {
      items: [
        {
          id: 'sa-1',
          label: 'researcher',
          summary: 'Scanning your inbox',
          status: 'running' as const,
          isBackground: false,
          startedAt: Date.now() - 8000,
          toolSummaries: [],
          stepRange: null,
        },
      ],
      summaryLabel: '1 assistant running',
      tooltip: '1 assistant running',
      totalCount: 1,
      runningCount: 1,
      toolCount: 0,
    };
    await act(async () => {
      root.render(
        <ContextualProgressCard
          {...baseThinkingProps()}
          subAgentTimeline={subAgentTimeline}
        />,
      );
    });
    // The per-assistant chip label should not appear as a stacked competing row.
    const chipLists = container.querySelectorAll('[aria-label="Running assistants"]');
    expect(chipLists.length).toBe(0);
  });

  it('collapsed bar (manually collapsed mid-turn) shows the concrete line, never the rotating quip', async () => {
    // Render expanded first (thinking auto-expands), then manually collapse so
    // the collapsed bar's aria-live region is what is shown DURING the turn.
    await act(async () => {
      root.render(
        <ContextualProgressCard
          {...baseThinkingProps()}
          toolSummariesByStep={new Map([[1, [runningTool]]])}
          thinkingHeadline="Skimming your brief like a seasoned editor."
        />,
      );
    });
    // Collapse via Escape on the expanded header (sets userExpandedOverride=false).
    const expandedHeader = container.querySelector<HTMLButtonElement>('button[aria-expanded="true"]');
    expect(expandedHeader).toBeTruthy();
    await act(async () => {
      expandedHeader?.click();
    });

    const liveRegion = container.querySelector('[aria-live="polite"]');
    expect(liveRegion).toBeTruthy();
    // The single live region carries the concrete activity, not the quip.
    expect(liveRegion?.textContent).toContain('Reading through your content');
    expect(container.textContent).not.toContain('Skimming your brief');
    // Still exactly one live region when collapsed.
    expect(container.querySelectorAll('[aria-live="polite"]').length).toBe(1);
  });
});

// Stage 6 (260618 show-more-activity, Phase-7 must-address F1): the per-turn
// recap / AI summary must surface on the ORDINARY-turn host (this card), not
// just in the primary-MCP-app inline disclosure. On a cleanly-completed turn
// (classification 'none', isComplete, real activity) the collapsed bar swaps
// the "Done — …" template for the recap (AI sentence, else count-line).
describe('ContextualProgressCard Stage 6 finished-turn recap', () => {
  let container: HTMLDivElement;
  let root: Root;

  const toolSummary: StepToolSummary = {
    label: 'Read file',
    icon: '📄',
    tone: 'files',
    status: 'success',
    toolName: 'read_file',
  };

  // A cleanly-finished turn: a terminal result event, no taskProgress, so
  // detectSilentStop returns classification 'none'.
  const completedTurnEvents: AgentEvent[] = [
    { type: 'status', message: 'Working', timestamp: Date.now() - 12_000 } as AgentEvent,
    { type: 'result', timestamp: Date.now() } as AgentEvent,
  ];

  // isComplete = !isThinking && !isBusy && !isPaused && hadActivity. hadActivity
  // flips true once steps/tools exist. classification 'none' because no
  // taskProgress and not interrupted.
  const completedProps = (
    overrides: Partial<ContextualProgressCardProps> = {},
  ): ContextualProgressCardProps => ({
    steps: [],
    fileOperationsByStep: new Map(),
    toolSummariesByStep: new Map([[1, [toolSummary]]]),
    selectedStepNumber: null,
    isThinking: false,
    isBusy: false,
    isPaused: false,
    taskProgress: undefined,
    turnEvents: completedTurnEvents,
    onSelectStep: () => undefined,
    ...overrides,
  });

  const collapsedStatusText = (): string =>
    container.querySelector('[aria-live="polite"]')?.textContent ?? '';

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.clearAllMocks();
  });

  it('(a) shows the AI summary when activityRecap.summary is set', async () => {
    await act(async () => {
      root.render(
        <ContextualProgressCard
          {...completedProps({
            activityRecap: {
              summary: 'Pulled your Q3 numbers from Slack and drafted the update.',
              toolCount: 3,
              filesTouched: 1,
              durationMs: 12_000,
              errors: 0,
            },
          })}
        />,
      );
    });

    expect(collapsedStatusText()).toBe('Pulled your Q3 numbers from Slack and drafted the update.');
    // The "Done — …" template must NOT show — the recap replaced it.
    expect(container.textContent).not.toContain('Done');
    expect(container.textContent).not.toContain('3 tools');
    // aria-label tracks the shown recap (the orienting "Show how Rebel worked").
    const bar = container.querySelector('[role="button"]');
    expect(bar?.getAttribute('aria-label')).toContain('Pulled your Q3 numbers from Slack and drafted the update.');
  });

  it('(b) shows the deterministic count-line when summary absent but tools present', async () => {
    await act(async () => {
      root.render(
        <ContextualProgressCard
          {...completedProps({
            activityRecap: {
              summary: undefined,
              toolCount: 3,
              filesTouched: 1,
              durationMs: 12_000,
              errors: 0,
            },
          })}
        />,
      );
    });

    // Deterministic recap: files lead, then tools, then duration.
    const text = collapsedStatusText();
    expect(text).toContain('1 file');
    expect(text).toContain('3 tools');
    expect(text).not.toContain('Done');
  });

  it('(c) falls back to "Done" when there is no recap (no tools, no files, no summary)', async () => {
    await act(async () => {
      root.render(
        <ContextualProgressCard
          {...completedProps({
            activityRecap: {
              summary: undefined,
              toolCount: 0,
              filesTouched: 0,
              durationMs: undefined,
              errors: 0,
            },
          })}
        />,
      );
    });

    // No renderable recap → the existing "Done — …" template wins.
    expect(collapsedStatusText()).toContain('Done');
  });

  it('falls back to "Done" when activityRecap is entirely absent (older callers byte-identical)', async () => {
    await act(async () => {
      root.render(<ContextualProgressCard {...completedProps()} />);
    });
    expect(collapsedStatusText()).toContain('Done');
  });

  it('does NOT surface the recap on a non-clean finish (interrupted keeps its own copy)', async () => {
    await act(async () => {
      root.render(
        <ContextualProgressCard
          {...completedProps({
            // App-close interruption (classification !== 'none').
            turnEvents: [
              {
                type: 'status',
                message: 'Agent turn interrupted when Mindstone Rebel closed.',
                timestamp: Date.now(),
              } as AgentEvent,
            ],
            activityRecap: {
              summary: 'Pulled your Q3 numbers from Slack and drafted the update.',
              toolCount: 3,
              filesTouched: 1,
              durationMs: 12_000,
              errors: 0,
            },
          })}
        />,
      );
    });

    // The interrupted arm owns the collapsed copy; the recap never shows.
    expect(container.textContent).not.toContain('Pulled your Q3 numbers');
    expect(collapsedStatusText()).toContain('before finishing');
  });

  it('keeps exactly one aria-live region when the recap shows', async () => {
    await act(async () => {
      root.render(
        <ContextualProgressCard
          {...completedProps({
            activityRecap: {
              summary: 'Looked through your files and pulled the figures.',
              toolCount: 2,
              filesTouched: 0,
              durationMs: 8_000,
              errors: 0,
            },
          })}
        />,
      );
    });
    expect(container.querySelectorAll('[aria-live="polite"]').length).toBe(1);
  });

  it('swaps the count-line for the AI sentence when the summary arrives (no second live region)', async () => {
    await act(async () => {
      root.render(
        <ContextualProgressCard
          {...completedProps({
            activityRecap: { summary: undefined, toolCount: 2, filesTouched: 0, durationMs: 8_000, errors: 0 },
          })}
        />,
      );
    });
    expect(collapsedStatusText()).toContain('2 tools');

    // Late async summary swap-in — same card, only the summary changes.
    await act(async () => {
      root.render(
        <ContextualProgressCard
          {...completedProps({
            activityRecap: {
              summary: 'Looked through your files and pulled the figures.',
              toolCount: 2,
              filesTouched: 0,
              durationMs: 8_000,
              errors: 0,
            },
          })}
        />,
      );
    });
    expect(collapsedStatusText()).toBe('Looked through your files and pulled the figures.');
    expect(container.textContent).not.toContain('2 tools');
    // The swap stays within the single existing live region — no new one added.
    expect(container.querySelectorAll('[aria-live="polite"]').length).toBe(1);
  });
});
