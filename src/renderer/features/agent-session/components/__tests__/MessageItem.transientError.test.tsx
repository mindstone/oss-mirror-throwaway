// @vitest-environment happy-dom

/**
 * Folded #7 — both-surfaces integration test (PLAN Stage 2 / Verification Notes).
 *
 * A single `endedWith="transient_error"` render of `MessageItem` exercises BOTH
 * transient-error surfaces at once:
 *   (a) the message-header `Connection dropped` badge (`transientErrorMarker`,
 *       MessageItem.tsx:1287), and
 *   (b) the embedded `ContextualProgressCard`'s interrupted treatment
 *       (`data-state="interrupted"`, emitted internally by the card from the
 *       `endedWith` prop MessageItem passes through at :1597).
 *
 * This pins the cross-surface contract where the Stage-2 refactor could break it
 * (the card derives `data-state` internally; MessageItem must keep passing
 * `endedWith` straight through). The card is NOT mocked here — that is the point.
 */

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentTurnMessage } from '@shared/types';
import type { MessageItemProps } from '../MessageItem';
import type { TurnStepContext } from '../../utils/turnStepContext';
import type { StepToolSummary } from '../../utils/toolChips';
import type { TaskProgressItem } from '../../utils/turnStepContext';

// Real task display so the card receives taskProgress (it derives the
// "X/Y steps completed" suffix from it) and the card mounts.
const displayTasks: TaskProgressItem[] = [
  { id: 't1', title: 'First step', status: 'completed' },
  { id: 't2', title: 'Second step', status: 'in_progress' },
];

vi.mock('@rebel/shared', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  computeTaskDisplayProps: vi.fn(() => ({
    mode: 'full',
    displayTasks,
    displayMission: { goal: 'Catch you up on overnight' },
    snapshotCounts: undefined,
  })),
}));

vi.mock('@renderer/features/settings', () => ({
  useSettingsSafe: () => ({
    settings: {
      theme: 'dark',
      experimental: { mcpAppsEnabled: false },
      trustedPreviewDomains: [],
      localModel: { profiles: [] },
    },
  }),
}));

vi.mock('@renderer/components/MessageMarkdown', () => ({
  MessageMarkdown: ({ content }: { content: string }) => <div data-testid="message-markdown">{content}</div>,
}));

// NOTE: ContextualProgressCard is deliberately NOT mocked — the whole point of
// this test is to render both surfaces from one tree.
vi.mock('../InsightsPill', () => ({ InsightsPill: () => null }));
vi.mock('../MemoryUpdateIndicator', () => ({ MemoryUpdateIndicator: () => null }));
vi.mock('../TeamKnowledgeIndicator', () => ({ TeamKnowledgeIndicator: () => null }));
vi.mock('../TimeSavedSummary', () => ({ TimeSavedSummary: () => null }));
vi.mock('../ConversationFeedbackPrompt', () => ({ ConversationFeedbackPrompt: () => null }));
vi.mock('@renderer/components/ToolResultImage', () => ({
  ToolResultImage: () => null,
  ToolResultImages: () => null,
}));
vi.mock('../ImageGrid', () => ({ ImageGrid: () => null }));
vi.mock('@renderer/contexts/NavigationContext', () => ({
  useNavigationSafe: () => ({ navigate: vi.fn(), currentSurface: 'sessions', teamSelectedOperatorId: null }),
}));
vi.mock('@renderer/src/analytics', () => ({ analytics: { track: vi.fn() } }));

import { MessageItem } from '../MessageItem';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function makeTool(overrides: Partial<StepToolSummary> = {}): StepToolSummary {
  return {
    label: 'Read file',
    icon: '📄',
    tone: 'files',
    status: 'success',
    toolName: 'read_file',
    toolUseId: 'tool-1',
    ...overrides,
  };
}

function makeTurnStepContext(): TurnStepContext {
  return {
    assistantSteps: [],
    fileOperationsByStep: new Map(),
    flattenedFileOperations: [],
    toolSummariesByStep: new Map([[1, [makeTool()]]]),
    technicalEvents: [],
    technicalEventsByStep: new Map(),
    pendingTodos: [],
    missionContext: { goal: 'Catch you up on overnight' },
    taskProgress: displayTasks,
    turnTaskDelta: null,
    modelByStep: new Map(),
  } as unknown as TurnStepContext;
}

const message: AgentTurnMessage = {
  id: 'msg-1',
  turnId: 'turn-1',
  role: 'result',
  text: 'Wrapping up the briefing.',
  createdAt: Date.now(),
  endedWith: 'transient_error',
};

function makeProps(overrides: Partial<MessageItemProps> = {}): MessageItemProps {
  return {
    message,
    boundaryAfterThis: undefined,
    messageCount: 1,
    sessionIdForFeedback: 'session-1',
    resolvedTurnId: 'turn-1',
    turnEvents: [
      // An error event → detectSilentStop classifies error_exit (hasSilentStop
      // false), so the silent-stop banner does not double up with interrupted.
      { type: 'error', error: 'fetch failed', timestamp: Date.now() } as never,
    ],
    turnStepContext: makeTurnStepContext(),
    subAgentTimeline: undefined,
    activeStepByTurn: {},
    memoryStatusByTurn: {},
    timeSavedStatusByTurn: {},
    activitySummaryByTurn: {},
    visibleTurnId: 'turn-1',
    focusedTurnId: null,
    processingTurnId: null,
    editingMessageId: null,
    isBusy: false,
    isStopping: false,
    onFocusTurn: vi.fn(),
    onBeginEditMessage: vi.fn(),
    onSelectInlineStep: vi.fn(),
    onOpenFile: vi.fn(),
    onCopyToClipboard: vi.fn(),
    retrySourceMessageId: undefined,
    ...overrides,
  };
}

function renderMessageItem(props: MessageItemProps): { container: HTMLElement; unmount: () => void } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  act(() => {
    root.render(<MessageItem {...props} />);
  });
  return {
    container,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

describe('MessageItem transient_error — both surfaces from one render', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    document.body.className = 'dark';
  });

  it('renders the header "Connection dropped" badge AND the card data-state="interrupted"', () => {
    const rendered = renderMessageItem(makeProps());

    // Surface (a): the message-header transient-error badge.
    expect(rendered.container.textContent).toContain('Connection dropped');
    const badge = rendered.container.querySelector('[aria-label="Connection dropped before this turn finished"]');
    expect(badge).toBeTruthy();

    // Surface (b): the embedded ContextualProgressCard's interrupted treatment.
    const card = rendered.container.querySelector('[data-state]');
    expect(card).toBeTruthy();
    expect(card?.getAttribute('data-state')).toBe('interrupted');
    expect(card?.getAttribute('data-state')).not.toBe('complete');

    rendered.unmount();
  });
});

describe('MessageItem interrupted liveness recovery affordance', () => {
  const STALE_TURN_THRESHOLD_MS = 5 * 60 * 1000;

  beforeEach(() => {
    vi.clearAllMocks();
    document.body.className = 'dark';
  });

  function staleTurnEvents() {
    const staleAt = Date.now() - STALE_TURN_THRESHOLD_MS - 1_000;
    return [
      { type: 'turn_started', timestamp: staleAt } as never,
      { type: 'assistant', text: 'Partial answer', timestamp: staleAt + 50 } as never,
    ];
  }

  it('renders interrupted recovery notice for the visible interrupted turn', () => {
    const rendered = renderMessageItem(
      makeProps({
        message: { ...message, id: 'msg-interrupted', endedWith: undefined },
        turnEvents: staleTurnEvents(),
        retrySourceMessageId: 'msg-user-1',
        onRetryMessage: vi.fn(),
      }),
    );

    const status = rendered.container.querySelector('[data-testid="interrupted-turn-status"]');
    const tryAgain = rendered.container.querySelector('[data-testid="interrupted-turn-try-again-button"]');

    expect(status?.textContent).toBe('Interrupted — answer may be incomplete.');
    expect(tryAgain).toBeTruthy();

    rendered.unmount();
  });

  it('does not render interrupted recovery notice when this row is not the visible turn', () => {
    const rendered = renderMessageItem(
      makeProps({
        message: { ...message, id: 'msg-hidden', endedWith: undefined },
        turnEvents: staleTurnEvents(),
        visibleTurnId: 'another-turn',
        retrySourceMessageId: 'msg-user-1',
        onRetryMessage: vi.fn(),
      }),
    );

    expect(rendered.container.querySelector('[data-testid="interrupted-turn-status"]')).toBeNull();
    expect(rendered.container.querySelector('[data-testid="interrupted-turn-try-again-button"]')).toBeNull();

    rendered.unmount();
  });

  it('uses the existing retry callback path when Try again is clicked', () => {
    const onRetryMessage = vi.fn();
    const rendered = renderMessageItem(
      makeProps({
        message: { ...message, id: 'msg-retry', endedWith: undefined },
        turnEvents: staleTurnEvents(),
        retrySourceMessageId: 'msg-user-1',
        onRetryMessage,
      }),
    );

    const tryAgain = rendered.container.querySelector<HTMLButtonElement>('[data-testid="interrupted-turn-try-again-button"]');
    expect(tryAgain).toBeTruthy();

    act(() => {
      tryAgain?.click();
    });

    expect(onRetryMessage).toHaveBeenCalledTimes(1);
    expect(onRetryMessage).toHaveBeenCalledWith('msg-user-1');

    rendered.unmount();
  });

  it('dismisses only the notice and keeps transcript content visible', () => {
    const rendered = renderMessageItem(
      makeProps({
        message: { ...message, id: 'msg-dismiss', endedWith: undefined },
        turnEvents: staleTurnEvents(),
        retrySourceMessageId: 'msg-user-1',
        onRetryMessage: vi.fn(),
      }),
    );

    const dismissButton = Array.from(
      rendered.container.querySelectorAll('button'),
    ).find((button) => button.textContent?.trim() === 'Dismiss notice');
    expect(dismissButton).toBeTruthy();

    act(() => {
      dismissButton?.click();
    });

    expect(rendered.container.querySelector('[data-testid="interrupted-turn-status"]')).toBeNull();
    expect(rendered.container.querySelector('[data-testid="interrupted-turn-try-again-button"]')).toBeNull();
    expect(rendered.container.textContent).toContain('Wrapping up the briefing.');

    rendered.unmount();
  });
});
