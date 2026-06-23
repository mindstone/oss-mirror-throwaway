// @vitest-environment happy-dom

/**
 * Stage 3 of 260618 show-more-activity: the collapsed work-disclosure label
 * prefers the per-turn AI activity summary (`activitySummaryByTurn[turnId]`)
 * over the deterministic count-line, and the memoised row repaints when a late
 * summary arrives for its turn (memo comparator includes the turn-scoped value).
 */

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import type { AgentTurnMessage, McpAppUiMeta } from '@shared/types';
import type { MessageItemProps } from '../MessageItem';
import type { TurnStepContext } from '../../utils/turnStepContext';
import type { StepToolSummary } from '../../utils/toolChips';

vi.mock('@rebel/shared', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  computeTaskDisplayProps: vi.fn(() => null),
}));

vi.mock('@renderer/features/settings', () => ({
  useSettingsSafe: () => ({
    settings: {
      theme: 'dark',
      experimental: { mcpAppsEnabled: true },
      trustedPreviewDomains: [],
      localModel: { profiles: [] },
    },
  }),
}));

vi.mock('@renderer/components/MessageMarkdown', () => ({
  MessageMarkdown: ({ content }: { content: string }) => <div data-testid="message-markdown">{content}</div>,
}));

vi.mock('../ContextualProgressCard', () => ({ ContextualProgressCard: () => null }));
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

// The collapsed `MessageWorkDisclosure` (whose label is the recap / AI summary)
// is rendered by `renderInlineWorkDisclosure()`, which only appears in the
// primary-MCP-app layout (the answer IS the primary view, so the steps get
// their own collapsed disclosure). So the turn carries a lead primary tool plus
// two inline tools → deterministic recap label of "2 tools".
const primaryUiMeta: McpAppUiMeta = {
  resourceUri: 'ui://demo/primary',
  sourcePackageId: 'Demo-pkg',
  presentation: 'primary',
  viewSummary: 'Primary view.',
  viewRoleLabel: 'Primary',
};

function makePrimaryTool(): StepToolSummary {
  return {
    label: 'Primary tool',
    detail: '',
    icon: '',
    tone: 'default',
    toolName: 'primary_tool',
    toolUseId: 'tool-primary',
    mcpAppUiMeta: primaryUiMeta,
  };
}

function makeInlineTool(overrides: Partial<StepToolSummary> = {}): StepToolSummary {
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

function makeTurnStepContext(): TurnStepContext {
  return {
    assistantSteps: [],
    fileOperationsByStep: new Map(),
    flattenedFileOperations: [],
    toolSummariesByStep: new Map([
      [1, [makePrimaryTool(), makeInlineTool(), makeInlineTool({ toolUseId: 'tool-b', label: 'Read doc' })]],
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
  createdAt: Date.now(),
};

function makeProps(overrides: Partial<MessageItemProps> = {}): MessageItemProps {
  return {
    message,
    boundaryAfterThis: undefined,
    messageCount: 1,
    sessionIdForFeedback: 'session-1',
    resolvedTurnId: 'turn-1',
    turnEvents: [],
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

function getDisclosureButton(container: HTMLElement): HTMLButtonElement | null {
  const disclosure = container.querySelector('[data-testid="message-work-disclosure"]');
  return (disclosure?.querySelector('button') as HTMLButtonElement | null) ?? null;
}

function render(props: MessageItemProps) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  act(() => root.render(<MessageItem {...props} />));
  return {
    container,
    rerender: (next: MessageItemProps) => act(() => root.render(<MessageItem {...next} />)),
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

describe('MessageItem activity-summary label preference (Stage 3)', () => {
  it('shows the deterministic count-line when no summary is present', () => {
    const r = render(makeProps());
    const button = getDisclosureButton(r.container);
    expect(button?.textContent).toContain('2 tools');
    expect(button?.textContent).not.toContain('Pulled your Q3 numbers');
    r.unmount();
  });

  it('prefers the AI summary sentence over the count-line when present', () => {
    const r = render(
      makeProps({
        activitySummaryByTurn: { 'turn-1': 'Pulled your Q3 numbers from Slack and drafted the update.' },
      }),
    );
    const button = getDisclosureButton(r.container);
    expect(button?.textContent).toContain('Pulled your Q3 numbers from Slack and drafted the update.');
    // The count-line is replaced, not appended.
    expect(button?.textContent).not.toContain('2 tools');
    r.unmount();
  });

  it('reflects the shown label in the aria-label and keeps it silent (no aria-live)', () => {
    const r = render(
      makeProps({
        activitySummaryByTurn: { 'turn-1': 'Summarised the thread and replied.' },
      }),
    );
    const button = getDisclosureButton(r.container);
    expect(button?.getAttribute('aria-label')).toContain('Summarised the thread and replied.');
    // The recap label must not announce itself to screen readers when it swaps.
    const disclosure = r.container.querySelector('[data-testid="message-work-disclosure"]');
    expect(disclosure?.querySelector('[aria-live]')).toBeNull();
    r.unmount();
  });

  it('repaints the memoised row when a late summary arrives for its turn (memo comparator)', () => {
    const r = render(makeProps());
    expect(getDisclosureButton(r.container)?.textContent).toContain('2 tools');

    // A late swap-in: same row identity, only activitySummaryByTurn changes.
    r.rerender(
      makeProps({
        activitySummaryByTurn: { 'turn-1': 'Looked through your files and pulled the figures.' },
      }),
    );
    const button = getDisclosureButton(r.container);
    expect(button?.textContent).toContain('Looked through your files and pulled the figures.');
    expect(button?.textContent).not.toContain('2 tools');
    r.unmount();
  });

  it('ignores a summary keyed to a different turn', () => {
    const r = render(
      makeProps({
        activitySummaryByTurn: { 'turn-OTHER': 'Should not show here.' },
      }),
    );
    const button = getDisclosureButton(r.container);
    expect(button?.textContent).toContain('2 tools');
    expect(button?.textContent).not.toContain('Should not show here.');
    r.unmount();
  });
});
