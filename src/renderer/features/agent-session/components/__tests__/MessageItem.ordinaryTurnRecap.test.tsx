// @vitest-environment happy-dom

/**
 * Stage 6 of 260618 show-more-activity (Phase-7 must-address F1): the per-turn
 * recap + AI summary must reach the ORDINARY-turn host `ContextualProgressCard`,
 * not just the primary-MCP-app inline disclosure. This is the bug's regression
 * test — without the Stage 6 wiring `MessageItem` never passes `activityRecap`
 * to `ContextualProgressCard`, so the feature is invisible for the common case
 * (a normal completed turn with no primary MCP app).
 *
 * We render with MCP apps DISABLED so MessageItem takes the ContextualProgressCard
 * branch (not the inline-disclosure branch), and capture the props the card
 * receives via a spy mock.
 */

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import type { AgentTurnMessage } from '@shared/types';
import type { MessageItemProps } from '../MessageItem';
import type { TurnStepContext } from '../../utils/turnStepContext';
import type { StepToolSummary } from '../../utils/toolChips';
import type { ContextualProgressCardProps } from '../ContextualProgressCard';

vi.mock('@rebel/shared', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  computeTaskDisplayProps: vi.fn(() => null),
}));

// MCP apps DISABLED → MessageItem renders ContextualProgressCard (ordinary host),
// not the primary-MCP-app inline disclosure.
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

// Spy mock — capture the props ContextualProgressCard receives so we can assert
// the recap inputs + AI summary are routed in.
const capturedCardProps: ContextualProgressCardProps[] = [];
vi.mock('../ContextualProgressCard', () => ({
  ContextualProgressCard: (props: ContextualProgressCardProps) => {
    capturedCardProps.push(props);
    return <div data-testid="contextual-progress-card" />;
  },
}));

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

import { MessageItem } from '../MessageItem';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function makeTool(overrides: Partial<StepToolSummary> = {}): StepToolSummary {
  return {
    label: 'Search Slack',
    detail: 'searched',
    icon: '🔎',
    tone: 'default',
    toolName: 'search_slack',
    toolUseId: 'tool-a',
    mcpAppUiMeta: undefined,
    ...overrides,
  };
}

// An ordinary completed turn: two real tool calls + one file touched, no primary
// MCP app. flattenedFileOperations drives the recap's filesTouched count.
function makeTurnStepContext(): TurnStepContext {
  return {
    assistantSteps: [],
    fileOperationsByStep: new Map(),
    flattenedFileOperations: [{ filePath: '/work/report.md', operation: 'read' }],
    toolSummariesByStep: new Map([
      [1, [makeTool(), makeTool({ toolUseId: 'tool-b', label: 'Read doc', toolName: 'read_file' })]],
    ]),
    technicalEvents: [],
    technicalEventsByStep: new Map(),
    pendingTodos: [],
    missionContext: null,
    taskProgress: [],
    turnTaskDelta: null,
    modelByStep: new Map(),
  } as unknown as TurnStepContext;
}

const message: AgentTurnMessage = {
  id: 'msg-1',
  turnId: 'turn-1',
  role: 'assistant',
  text: 'Here is the answer.',
  createdAt: Date.now() - 8_000,
};

function makeProps(overrides: Partial<MessageItemProps> = {}): MessageItemProps {
  return {
    message,
    boundaryAfterThis: undefined,
    messageCount: 1,
    sessionIdForFeedback: 'session-1',
    resolvedTurnId: 'turn-1',
    turnEvents: [
      { type: 'status', message: 'Working', timestamp: Date.now() - 8_000 },
      { type: 'result', timestamp: Date.now() },
    ] as MessageItemProps['turnEvents'],
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
    ...overrides,
  } as MessageItemProps;
}

function render(props: MessageItemProps) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  act(() => root.render(<MessageItem {...props} />));
  return {
    container,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

describe('MessageItem routes the recap to the ordinary-turn host (Stage 6 F1 regression)', () => {
  it('passes activityRecap (count inputs) to ContextualProgressCard for an ordinary completed turn', () => {
    capturedCardProps.length = 0;
    const r = render(makeProps());

    // The ordinary-turn host rendered (not the inline-disclosure branch).
    expect(r.container.querySelector('[data-testid="contextual-progress-card"]')).toBeTruthy();

    const recap = capturedCardProps.at(-1)?.activityRecap;
    // FAILS without the Stage 6 fix: activityRecap was never passed.
    expect(recap).toBeTruthy();
    expect(recap?.toolCount).toBe(2);
    expect(recap?.filesTouched).toBe(1);
    expect(recap?.errors).toBe(0);
    // No summary present → the card will show the deterministic count-line.
    expect(recap?.summary).toBeUndefined();

    r.unmount();
  });

  it('routes the AI summary into ContextualProgressCard when present for the turn', () => {
    capturedCardProps.length = 0;
    const r = render(
      makeProps({
        activitySummaryByTurn: { 'turn-1': 'Pulled your Q3 numbers from Slack and drafted the update.' },
      }),
    );

    const recap = capturedCardProps.at(-1)?.activityRecap;
    expect(recap?.summary).toBe('Pulled your Q3 numbers from Slack and drafted the update.');
    expect(recap?.toolCount).toBe(2);

    r.unmount();
  });

  it('does not leak a summary keyed to a different turn', () => {
    capturedCardProps.length = 0;
    const r = render(
      makeProps({
        activitySummaryByTurn: { 'turn-OTHER': 'Should not show here.' },
      }),
    );

    const recap = capturedCardProps.at(-1)?.activityRecap;
    expect(recap?.summary).toBeUndefined();

    r.unmount();
  });
});
