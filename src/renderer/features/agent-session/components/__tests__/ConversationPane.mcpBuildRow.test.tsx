// @vitest-environment happy-dom
/// <reference types="vitest/globals" />

/**
 * 260424 PR-template revamp follow-up (addendum #2): the inline
 * `MCPBuildCard` phantom row for `phase === 'github-check'` was
 * dropped along with the "One more thing" form. The footer question
 * batch is now the sole attribution surface, so rendering an inline
 * github-check row is unnecessary (the component returns null for it
 * anyway).
 *
 * These tests mount the real `ConversationPane` with TanStack Virtual
 * + child components mocked at module boundaries, and assert that the
 * phantom MCPBuildCard row mounts only for the `submitted` phase.
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import React from 'react';

// ── Module mocks ────────────────────────────────────────────────────
vi.mock('../ConversationPane.module.css', () => ({
  default: new Proxy({}, { get: (_t, prop) => String(prop) }),
}));

// Stub TanStack Virtual — renders ALL items (including phantom rows)
// so that the phantom MCPBuildCard row is present in the DOM. The stub
// emits `virtualItem` objects for each `count`, reading `count` off the
// options passed to `useVirtualizer`.
const virtualizerState = vi.hoisted(() => ({
  count: 0,
  getItemKey: null as ((index: number) => string | number) | null,
}));

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: (options: { count: number; getItemKey?: (index: number) => string | number }) => {
    virtualizerState.count = options.count;
    virtualizerState.getItemKey = options.getItemKey ?? null;
    const items = Array.from({ length: options.count }, (_, index) => ({
      index,
      size: 100,
      start: index * 100,
      key: (options.getItemKey?.(index) ?? `k-${index}`) as string | number,
    }));
    return {
      getVirtualItems: () => items,
      getTotalSize: () => options.count * 100,
      scrollToIndex: () => {},
      measureElement: () => {},
    };
  },
  elementScroll: () => {},
}));

// Pane-dependency stubs — all no-op render.
vi.mock('../../hooks/useCommunityShare', () => ({ useCommunityShare: () => null }));
vi.mock('../../hooks/useMemoryUpdateStatus', () => ({
  useMemoryUpdateStatus: () => ({ statusByTurn: {}, getStatusForTurn: () => undefined }),
}));
vi.mock('../../hooks/useTimeSavedStatus', () => ({
  useTimeSavedStatus: () => ({ statusByTurn: {}, getStatusForTurn: () => undefined }),
}));
vi.mock('../../hooks/useScrollToAnswer', () => ({
  useScrollToAnswer: () => {},
  computeScrollToAnswerIndex: () => null,
}));
vi.mock('../../hooks/useUserQuestions', () => ({
  extractQuestionBatches: () => [],
  extractAnsweredBatches: () => [],
  buildQuestionBatchStates: () => [],
}));
vi.mock('../../utils/lruMeasureCache', () => ({
  setMeasureCacheEntryLru: () => {},
  getConversationMeasureCache: () => new Map<string, number>(),
  clearConversationMeasureCache: () => {},
}));
vi.mock('@rebel/shared', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, computeTaskDisplayProps: () => null };
});
vi.mock('@renderer/lib/utils', () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
}));

// Child components — render a testable marker so we can distinguish
// which phantom row rendered. The MCPBuildCard mock emits a div with
// a data-testid carrying the phase it received so both assertions —
// "rendered at all" and "received the right state" — are verifiable.
vi.mock('../ContextualProgressCard', () => ({ ContextualProgressCard: () => null }));
vi.mock('../EmptyConversationState', () => ({ EmptyConversationState: () => null }));
vi.mock('../FirstBigWinCard', () => ({ FirstBigWinCard: () => null }));
vi.mock('../CommunityWinCard', () => ({ CommunityWinCard: () => null }));
vi.mock('../MCPBuildCard', () => ({
  MCPBuildCard: ({ state }: { state: { phase: string; connectorName: string } }) =>
    React.createElement('div', {
      'data-testid': `mcp-build-card-phantom-${state.phase}`,
      'data-connector-name': state.connectorName,
    }, state.phase),
}));
vi.mock('../MessageItem', () => ({ MessageItem: () => null }));
vi.mock('../UserQuestionCard', () => ({ UserQuestionCard: () => null }));
vi.mock('../OnboardingCoachIntro', () => ({ OnboardingCoachIntro: () => null }));
vi.mock('../../../focus/components/FocusContextCard', () => ({ FocusContextCard: () => null }));

// ── Imports AFTER mocks ─────────────────────────────────────────────
import type { AgentTurnMessage } from '@shared/types';
import {
  ConversationPane,
  type ConversationPaneHandle,
  type ConversationPaneProps,
} from '../ConversationPane';

// React act() environment for mount.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ReactDOMClient = require('react-dom/client') as typeof import('react-dom/client');
const { act: reactAct } = require('react') as typeof import('react');

// ── Helpers ─────────────────────────────────────────────────────────
const makeMessage = (
  overrides: Partial<AgentTurnMessage> & { id: string; role: AgentTurnMessage['role'] },
): AgentTurnMessage => ({
  turnId: 'turn-1',
  text: 'test',
  createdAt: Date.now(),
  ...overrides,
});

function buildMinimalProps(
  overrides: Partial<ConversationPaneProps> = {},
): ConversationPaneProps {
  return {
    visibleMessages: [makeMessage({ id: 'msg-1', role: 'assistant' })],
    eventsByTurn: {},
    visibleTurnId: 'turn-1',
    focusedTurnId: null,
    processingTurnId: null,
    editingMessageId: null,
    isBusy: false,
    isStopping: false,
    currentSessionId: 'session-A',
    isTextMode: false,
    turnStepContextByTurn: {},
    subAgentTimelineByTurn: new Map(),
    activeStepByTurn: {},
    resolveTurnIdForMessage: () => 'turn-1',
    onBeginEditMessage: () => {},
    onSelectInlineStep: () => {},
    onFocusTurn: () => {},
    onOpenFile: () => {},
    onCopyToClipboard: () => {},
    ...overrides,
  };
}

function mountPane(props: ConversationPaneProps) {
  const ref = React.createRef<ConversationPaneHandle>();
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = ReactDOMClient.createRoot(container);

  reactAct(() => {
    root.render(
      React.createElement(ConversationPane, {
        ...props,
        ref,
      } as ConversationPaneProps & { ref: React.RefObject<ConversationPaneHandle> }),
    );
  });

  return {
    ref,
    container,
    unmount: () => {
      reactAct(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

beforeAll(() => {
  (window as unknown as { api: unknown }).api = {
    shouldShowFirstBigWin: async () => false,
    getTodayMinutes: async () => 0,
    onTimeSavedStatus: () => () => {},
    markFirstBigWinShown: async () => {},
  };
});

beforeEach(() => {
  virtualizerState.count = 0;
  virtualizerState.getItemKey = null;
});

// ── Tests ───────────────────────────────────────────────────────────
describe('ConversationPane — inline MCPBuildCard phantom row', () => {
  it('renders the inline MCPBuildCard when phase === "submitted" (regression guard)', () => {
    const { container, unmount } = mountPane(
      buildMinimalProps({
        mcpBuildCardState: {
          phase: 'submitted',
          connectorName: 'TestConn',
        },
      }),
    );

    // Phantom row count = visibleMessages (1) + submitted phantom (1) = 2.
    expect(virtualizerState.count).toBe(2);

    // The mocked MCPBuildCard emits `data-testid="mcp-build-card-phantom-submitted"`.
    const card = container.querySelector('[data-testid="mcp-build-card-phantom-submitted"]');
    expect(card).toBeTruthy();
    expect(card?.getAttribute('data-connector-name')).toBe('TestConn');

    unmount();
  });

  it('does NOT render an inline MCPBuildCard for github-check (footer batch owns attribution)', () => {
    // Addendum #2: the inline `github-check` phantom row was removed
    // along with the "One more thing" form. The footer picker submits
    // directly — no inline card needs to scroll into view.
    const { container, unmount } = mountPane(
      buildMinimalProps({
        mcpBuildCardState: {
          phase: 'github-check',
          connectorName: 'RedirectConn',
        },
      }),
    );

    // Phantom row count = visibleMessages (1) only.
    expect(virtualizerState.count).toBe(1);

    const card = container.querySelector('[data-testid^="mcp-build-card-phantom-"]');
    expect(card).toBeNull();

    unmount();
  });

  it('does NOT render an inline MCPBuildCard for pre-submit phases (submit-prompt)', () => {
    // Only `submitted` renders as a phantom row inline — other phases
    // surface in the footer card or thinking card.
    const { container, unmount } = mountPane(
      buildMinimalProps({
        mcpBuildCardState: {
          phase: 'submit-prompt',
          connectorName: 'PromptConn',
          tools: [],
        },
      }),
    );

    // Phantom row count = visibleMessages (1) only.
    expect(virtualizerState.count).toBe(1);

    const card = container.querySelector('[data-testid^="mcp-build-card-phantom-"]');
    expect(card).toBeNull();

    unmount();
  });

  it('does NOT render an inline MCPBuildCard when mcpBuildCardState is null', () => {
    const { container, unmount } = mountPane(
      buildMinimalProps({ mcpBuildCardState: null }),
    );

    expect(virtualizerState.count).toBe(1);

    const card = container.querySelector('[data-testid^="mcp-build-card-phantom-"]');
    expect(card).toBeNull();

    unmount();
  });

  // Stage 4 (260426 foolproof contribution flow): renderer treats
  // `mcpBuildCardState` as a single-active-record prop. The Stage 2 IPC
  // migration internally uses `getActiveContributionBySession` to pick the
  // most-recently-updated record when a session has multiple builds, so the
  // renderer never sees the "second" build. This test pins that contract
  // from the renderer's perspective: passing the active record's state
  // renders the active phantom row exactly as it does today, regardless of
  // how many other builds exist server-side. Footer/phantom-row gating
  // MUST NOT change between Stage 3 and Stage 4.
  it('renders the active record phantom row in a 2-build session (Stage 4 routing pin)', () => {
    // Simulate the IPC having returned the SECOND build's state (the active
    // one — most-recently-updated). The renderer sees only this prop; the
    // existence of a second build server-side is invisible to it.
    const { container, unmount } = mountPane(
      buildMinimalProps({
        mcpBuildCardState: {
          phase: 'submitted',
          connectorName: 'SecondConnector',
        },
      }),
    );

    // Phantom row count = visibleMessages (1) + submitted phantom (1) = 2,
    // identical to the single-build case. Multi-card UI is deferred.
    expect(virtualizerState.count).toBe(2);

    const card = container.querySelector('[data-testid="mcp-build-card-phantom-submitted"]');
    expect(card).toBeTruthy();
    expect(card?.getAttribute('data-connector-name')).toBe('SecondConnector');

    // Phantom MCPBuildCard for OTHER phases (submit-prompt, github-check)
    // must STILL not render — Stage 4 telemetry doesn't change phantom-row
    // gating. Pinning it explicitly so a future refactor of the gating
    // logic can't accidentally widen the set.
    const otherPhantoms = container.querySelectorAll(
      '[data-testid="mcp-build-card-phantom-submit-prompt"],[data-testid="mcp-build-card-phantom-github-check"]',
    );
    expect(otherPhantoms.length).toBe(0);

    unmount();
  });
});
