// @vitest-environment happy-dom

/**
 * Stage 1b (260617_bricked-state-0448-electron42) — soft "still waiting" (State
 * B) affordance on `MessageItem`.
 *
 * The watchdog dispatches a one-shot `status` event carrying a `stall` marker
 * when an interactive `awaiting_api` turn has been silent past ~30s with no
 * first token. `MessageItem` surfaces a calm, non-destructive inline
 * "Try again / Stop" row WITHOUT ending the turn. This test pins:
 *   - the row renders on the actively-processing turn with a stall-bearing status,
 *   - "Try again" is stop-then-resend (`onStopActiveTurn` THEN `onRetryMessage`),
 *   - "Stop" calls `onStopActiveTurn`,
 *   - the surface clears when output streams / the turn ends / while stopping /
 *     when this row is not the active turn.
 *
 * Mirrors the harness in MessageItem.transientError.test.tsx.
 */

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent, AgentTurnMessage } from '@shared/types';
import type { MessageItemProps } from '../MessageItem';
import type { TurnStepContext } from '../../utils/turnStepContext';
import { AWAITING_API_SOFT_STALL_MESSAGE } from '@shared/constants/awaitingApiSoftStall';

vi.mock('@rebel/shared', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  computeTaskDisplayProps: vi.fn(() => ({ mode: 'full', displayTasks: [], displayMission: null, snapshotCounts: undefined })),
}));
vi.mock('@renderer/features/settings', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useSettingsSafe: () => ({
    settings: { theme: 'dark', experimental: { mcpAppsEnabled: false }, trustedPreviewDomains: [], localModel: { profiles: [] } },
  }),
  useSettings: () => ({
    settings: { theme: 'dark', experimental: { mcpAppsEnabled: false }, trustedPreviewDomains: [], localModel: { profiles: [] } },
    saveSettingsWith: vi.fn(),
  }),
}));
// The live thinking card renders TutorialNudge; stub it (its settings/tutorial
// hooks are out of scope for the State B affordance under test).
vi.mock('@renderer/features/tutorials', () => ({ TutorialNudge: () => null }));
vi.mock('@renderer/components/MessageMarkdown', () => ({
  MessageMarkdown: ({ content }: { content: string }) => <div data-testid="message-markdown">{content}</div>,
}));
vi.mock('../InsightsPill', () => ({ InsightsPill: () => null }));
vi.mock('../MemoryUpdateIndicator', () => ({ MemoryUpdateIndicator: () => null }));
vi.mock('../TeamKnowledgeIndicator', () => ({ TeamKnowledgeIndicator: () => null }));
vi.mock('../TimeSavedSummary', () => ({ TimeSavedSummary: () => null }));
vi.mock('../ConversationFeedbackPrompt', () => ({ ConversationFeedbackPrompt: () => null }));
vi.mock('@renderer/components/ToolResultImage', () => ({ ToolResultImage: () => null, ToolResultImages: () => null }));
vi.mock('../ImageGrid', () => ({ ImageGrid: () => null }));
vi.mock('@renderer/contexts/NavigationContext', () => ({
  useNavigationSafe: () => ({ navigate: vi.fn(), currentSurface: 'sessions', teamSelectedOperatorId: null }),
}));
vi.mock('@renderer/src/analytics', () => ({ analytics: { track: vi.fn() } }));

import { MessageItem } from '../MessageItem';
import { useSessionStore } from '../../store/sessionStore';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function makeTurnStepContext(): TurnStepContext {
  return {
    assistantSteps: [],
    fileOperationsByStep: new Map(),
    flattenedFileOperations: [],
    toolSummariesByStep: new Map(),
    technicalEvents: [],
    technicalEventsByStep: new Map(),
    pendingTodos: [],
    missionContext: null,
    taskProgress: [],
    turnTaskDelta: null,
    modelByStep: new Map(),
  } as unknown as TurnStepContext;
}

const baseMessage: AgentTurnMessage = {
  id: 'msg-assistant',
  turnId: 'turn-1',
  role: 'assistant',
  text: '',
  createdAt: Date.now(),
};

const stallEvent: AgentEvent = {
  type: 'status',
  message: 'Still on this one — it is taking longer than usual.',
  timestamp: Date.now(),
  stall: { phase: 'awaiting_api', sinceMs: 30_000 },
};

function makeProps(overrides: Partial<MessageItemProps> = {}): MessageItemProps {
  return {
    message: baseMessage,
    boundaryAfterThis: undefined,
    messageCount: 1,
    sessionIdForFeedback: 'session-1',
    resolvedTurnId: 'turn-1',
    turnEvents: [stallEvent],
    turnStepContext: makeTurnStepContext(),
    subAgentTimeline: undefined,
    activeStepByTurn: {},
    memoryStatusByTurn: {},
    timeSavedStatusByTurn: {},
    activitySummaryByTurn: {},
    visibleTurnId: 'turn-1',
    focusedTurnId: null,
    // Actively-processing turn (turn still alive).
    processingTurnId: 'turn-1',
    editingMessageId: null,
    isBusy: true,
    isStopping: false,
    onFocusTurn: vi.fn(),
    onBeginEditMessage: vi.fn(),
    onSelectInlineStep: vi.fn(),
    onOpenFile: vi.fn(),
    onCopyToClipboard: vi.fn(),
    retrySourceMessageId: 'msg-user-1',
    onRetryMessage: vi.fn(),
    onStopActiveTurn: vi.fn(),
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

const q = (c: HTMLElement, id: string) => c.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`);

describe('MessageItem soft "still waiting" (State B) affordance', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    document.body.className = 'dark';
    // Reset the answer-phase flag so each test starts pre-first-token.
    act(() => { useSessionStore.getState().clearAnswerStreaming('turn-1'); });
  });

  it('renders the soft-stall row on the actively-processing turn with the SHARED copy constant', () => {
    const r = renderMessageItem(makeProps());
    const status = q(r.container, 'soft-stall-status');
    // Guard the DISPLAYED text against the shared single-source-of-truth
    // constant (the same literal the eval pins) — not a hardcoded substring.
    expect(status?.textContent).toContain(AWAITING_API_SOFT_STALL_MESSAGE);
    expect(q(r.container, 'soft-stall-try-again-button')).toBeTruthy();
    expect(q(r.container, 'soft-stall-stop-button')).toBeTruthy();
    r.unmount();
  });

  it('Try again does stop-then-resend (stop FIRST, then retry the user message)', () => {
    const calls: string[] = [];
    const onStopActiveTurn = vi.fn(() => { calls.push('stop'); });
    const onRetryMessage = vi.fn(() => { calls.push('retry'); });
    const r = renderMessageItem(makeProps({ onStopActiveTurn, onRetryMessage }));

    act(() => { q(r.container, 'soft-stall-try-again-button')?.click(); });

    expect(onStopActiveTurn).toHaveBeenCalledTimes(1);
    expect(onRetryMessage).toHaveBeenCalledTimes(1);
    expect(onRetryMessage).toHaveBeenCalledWith('msg-user-1');
    expect(calls).toEqual(['stop', 'retry']); // stop precedes resend — no parallel turn
    r.unmount();
  });

  it('Stop calls stopActiveTurn (and does NOT resend)', () => {
    const onStopActiveTurn = vi.fn();
    const onRetryMessage = vi.fn();
    const r = renderMessageItem(makeProps({ onStopActiveTurn, onRetryMessage }));

    act(() => { q(r.container, 'soft-stall-stop-button')?.click(); });

    expect(onStopActiveTurn).toHaveBeenCalledTimes(1);
    expect(onRetryMessage).not.toHaveBeenCalled();
    r.unmount();
  });

  // BLOCKER regression (Stage 1b review): the renderer NEVER receives
  // `assistant_delta` (Stage-2 collapse), so clearing State B can't depend on
  // it. The real first-token signal is `answer_phase_started`, recorded in the
  // store as `answerStreamingTurnIds`. State B must clear the instant that flips
  // — BEFORE the rolled-up `assistant` event lands — or "still waiting" stays
  // visible while the answer streams (the load-bearing UI invariant violation).
  it('clears the surface the instant the answer phase starts (answer_phase_started → store flag), before any assistant event', () => {
    // The stall is still showing (no first token yet).
    const r = renderMessageItem(makeProps());
    expect(q(r.container, 'soft-stall-status')).toBeTruthy();

    // First token arrives: the engine marks the turn answer-streaming. NO new
    // event is appended to turnEvents (the assistant rollup may be seconds away).
    act(() => { useSessionStore.getState().markAnswerStreaming('turn-1'); });

    // State B must clear immediately off the store flag.
    expect(q(r.container, 'soft-stall-status')).toBeNull();
    r.unmount();
  });

  it('clears the surface once the rolled-up assistant event lands (detector belt)', () => {
    const r = renderMessageItem(makeProps({
      turnEvents: [stallEvent, { type: 'assistant', text: 'Here is the answer', timestamp: Date.now() + 1 } as AgentEvent],
    }));
    expect(q(r.container, 'soft-stall-status')).toBeNull();
    r.unmount();
  });

  it('clears the surface when the turn has ended (result)', () => {
    const r = renderMessageItem(makeProps({
      turnEvents: [stallEvent, { type: 'result', text: 'done', timestamp: Date.now() + 1 } as AgentEvent],
      processingTurnId: null,
      isBusy: false,
    }));
    expect(q(r.container, 'soft-stall-status')).toBeNull();
    r.unmount();
  });

  it('does NOT render while stopping (isStopping)', () => {
    const r = renderMessageItem(makeProps({ isStopping: true }));
    expect(q(r.container, 'soft-stall-status')).toBeNull();
    r.unmount();
  });

  it('does NOT render when this row is not the actively-processing turn', () => {
    const r = renderMessageItem(makeProps({ processingTurnId: 'another-turn' }));
    expect(q(r.container, 'soft-stall-status')).toBeNull();
    r.unmount();
  });

  it('does NOT render when there is no stall marker (plain status only)', () => {
    const r = renderMessageItem(makeProps({
      turnEvents: [{ type: 'status', message: 'Working…', timestamp: Date.now() }],
    }));
    expect(q(r.container, 'soft-stall-status')).toBeNull();
    r.unmount();
  });
});
