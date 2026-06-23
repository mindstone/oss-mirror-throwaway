// @vitest-environment happy-dom
import React, { act } from 'react';
import * as ReactDOMClient from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FlowPanelsProvider } from '../FlowPanelsProvider';
import { FlowPanelsShell } from '../FlowPanelsShell';
import {
  appendRendererOptimisticTurnStartedEvent,
  clearCurrentSessionEvents,
  removeRendererOptimisticTurnStartedEvent,
  useSessionStore,
} from '@renderer/features/agent-session/store/sessionStore';
import type { AgentSessionSummary } from '@shared/types';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Mounted = {
  unmount: () => void;
};

const mounted: Mounted[] = [];
const FOREGROUND_BUSY_TURN_ID = 'flow-panels-contract-busy-turn';

const setForegroundBusy = (): void => {
  appendRendererOptimisticTurnStartedEvent(FOREGROUND_BUSY_TURN_ID);
  useSessionStore.setState({ activeTurnId: FOREGROUND_BUSY_TURN_ID });
};

const setForegroundIdle = (): void => {
  removeRendererOptimisticTurnStartedEvent(FOREGROUND_BUSY_TURN_ID);
  useSessionStore.setState({ activeTurnId: null });
};

const makeSummary = (overrides: Partial<AgentSessionSummary>): AgentSessionSummary => ({
  id: overrides.id ?? 'session-x',
  title: overrides.title ?? 'Test session',
  createdAt: overrides.createdAt ?? Date.now(),
  updatedAt: overrides.updatedAt ?? Date.now(),
  resolvedAt: overrides.resolvedAt ?? null,
  doneAt: overrides.doneAt ?? null,
  starredAt: overrides.starredAt ?? null,
  deletedAt: overrides.deletedAt ?? null,
  origin: overrides.origin ?? 'manual',
  isCorrupted: overrides.isCorrupted ?? false,
  preview: overrides.preview ?? '',
  messageCount: overrides.messageCount ?? 0,
  hasDraft: overrides.hasDraft ?? false,
  draftPreview: overrides.draftPreview ?? null,
  draftUpdatedAt: overrides.draftUpdatedAt ?? null,
  usage: overrides.usage ?? {
    costUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    turnCount: 0,
  },
  activeTurnId: overrides.activeTurnId ?? null,
  isBusy: overrides.isBusy ?? false,
  lastError: overrides.lastError ?? null,
});

function renderShell(): Mounted {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = ReactDOMClient.createRoot(container);

  act(() => {
    root.render(
      <FlowPanelsProvider>
        <FlowPanelsShell
          brand={null}
          sidebar={null}
          surfaceTabs={[]}
          surfaces={{}}
          showConversation={false}
        />
      </FlowPanelsProvider>,
    );
  });

  const m: Mounted = {
    unmount: () => {
      act(() => { root.unmount(); });
      container.remove();
    },
  };
  mounted.push(m);
  return m;
}

function appShell(): Element {
  const shell = document.querySelector('.app-shell');
  expect(shell).not.toBeNull();
  return shell as Element;
}

beforeEach(() => {
  Object.assign(window as unknown as Record<string, unknown>, {
    sessionsApi: {
      get: vi.fn().mockResolvedValue(null),
      upsert: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
      list: vi.fn().mockResolvedValue([]),
    },
    agentApi: {
      stopTurn: vi.fn().mockResolvedValue(undefined),
    },
  });

  act(() => {
    clearCurrentSessionEvents();
    useSessionStore.setState({
      isBusy: false,
      activeTurnId: null,
      sessionSummaries: [],
    });
  });

  document.body.removeAttribute('data-active-work');
});

afterEach(() => {
  while (mounted.length > 0) {
    mounted.pop()?.unmount();
  }
  document.body.removeAttribute('data-active-work');
  clearCurrentSessionEvents();
  vi.restoreAllMocks();
});

describe('FlowPanelsShell active-work foreground contract', () => {
  it('ignores background-only work, then tracks current-session busy and idle transitions by removing attributes', () => {
    renderShell();
    const foregroundSessionId = useSessionStore.getState().currentSessionId;

    act(() => {
      useSessionStore.setState({
        isBusy: false,
        sessionSummaries: [
          makeSummary({ id: 'conversation-A-bg', isBusy: true, activeTurnId: 'turn-bg-A' }),
          makeSummary({ id: foregroundSessionId, isBusy: false }),
        ],
      });
    });

    expect(document.body.hasAttribute('data-active-work')).toBe(false);
    expect(appShell().hasAttribute('data-active-work')).toBe(false);

    act(() => {
      useSessionStore.setState({
        sessionSummaries: [
          makeSummary({ id: 'conversation-A-bg', isBusy: true, activeTurnId: 'turn-bg-A' }),
          makeSummary({ id: foregroundSessionId, isBusy: true, activeTurnId: 'turn-fg' }),
        ],
      });
      setForegroundBusy();
    });

    expect(document.body.getAttribute('data-active-work')).toBe('true');
    expect(appShell().getAttribute('data-active-work')).toBe('true');

    act(() => {
      useSessionStore.setState({
        sessionSummaries: [
          makeSummary({ id: 'conversation-A-bg', isBusy: true, activeTurnId: 'turn-bg-A' }),
          makeSummary({ id: foregroundSessionId, isBusy: false }),
        ],
      });
      setForegroundIdle();
    });

    expect(document.body.hasAttribute('data-active-work')).toBe(false);
    expect(appShell().hasAttribute('data-active-work')).toBe(false);
  });
});
