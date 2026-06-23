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
const FOREGROUND_BUSY_TURN_ID = 'flow-panels-foreground-busy-turn';

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

beforeEach(() => {
  // Augment the happy-dom window with the IPC APIs sessionStore expects,
  // without replacing the window object (which would lose DOM globals like
  // `Element` that downstream UI deps such as @floating-ui/react rely on).
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

  // Reset shared singleton store between tests
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

describe('FlowPanelsShell — body[data-active-work] effect (R2-2)', () => {
  it('does NOT set body[data-active-work] when foreground session is idle', () => {
    renderShell();
    expect(document.body.hasAttribute('data-active-work')).toBe(false);
  });

  it('sets body[data-active-work=true] when foreground session is busy (top-level isBusy)', () => {
    renderShell();
    act(() => {
      setForegroundBusy();
    });
    expect(document.body.getAttribute('data-active-work')).toBe('true');
  });

  it('removes body[data-active-work] when foreground transitions back to idle', () => {
    renderShell();
    act(() => {
      setForegroundBusy();
    });
    expect(document.body.getAttribute('data-active-work')).toBe('true');

    act(() => {
      setForegroundIdle();
    });
    expect(document.body.hasAttribute('data-active-work')).toBe(false);
  });

  it('R2-2: idle foreground Conversation B does NOT get data-active-work while background Conversation A streams', () => {
    renderShell();
    const fgId = useSessionStore.getState().currentSessionId;

    act(() => {
      useSessionStore.setState({
        isBusy: false,
        sessionSummaries: [
          makeSummary({ id: 'conversation-A-bg', isBusy: true, activeTurnId: 'turn-bg-A' }),
          makeSummary({ id: fgId, isBusy: false }),
        ],
      });
    });

    // Foreground-only lens — body must NOT carry data-active-work even though
    // the system-wide selectHasAnyActiveTurn would be true.
    expect(document.body.hasAttribute('data-active-work')).toBe(false);
  });

  it('cleanup removes body attribute on unmount', () => {
    const m = renderShell();
    act(() => {
      setForegroundBusy();
    });
    expect(document.body.getAttribute('data-active-work')).toBe('true');

    m.unmount();
    mounted.length = 0;

    expect(document.body.hasAttribute('data-active-work')).toBe(false);
  });
});

describe('FlowPanelsShell — Stage 3 self-healing watchdog (Phase 8 close-out)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('force-clears body[data-active-work] after 30 min of continuous busy', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    renderShell();

    act(() => {
      setForegroundBusy();
    });
    expect(document.body.getAttribute('data-active-work')).toBe('true');

    act(() => {
      vi.advanceTimersByTime(30 * 60 * 1000);
    });
    expect(document.body.hasAttribute('data-active-work')).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('data-active-work attribute force-cleared'),
      expect.objectContaining({
        reason: 'leaked_active_work_signal',
        watchdogTimeoutMs: 30 * 60 * 1000,
        stage: 'stage_3_blur_budget',
      }),
    );
  });

  it('does NOT fire watchdog before the 30-min threshold', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    renderShell();

    act(() => {
      setForegroundBusy();
    });
    expect(document.body.getAttribute('data-active-work')).toBe('true');

    // Advance just under threshold.
    act(() => {
      vi.advanceTimersByTime(30 * 60 * 1000 - 1);
    });
    expect(document.body.getAttribute('data-active-work')).toBe('true');
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('refuses to re-set the attribute on the same continuous busy window after watchdog fires', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    renderShell();

    act(() => {
      setForegroundBusy();
    });
    act(() => {
      vi.advanceTimersByTime(30 * 60 * 1000);
    });
    expect(document.body.hasAttribute('data-active-work')).toBe(false);

    // Force a re-render via an unrelated state update — the busy signal stays
    // true and the watchdog has already fired, so the attribute must NOT be
    // re-set (zero-crossing semantic — symmetric with Stage 6 latch's
    // `armed-after-clear` state).
    act(() => {
      useSessionStore.setState({ sessionSummaries: [] });
    });
    expect(document.body.hasAttribute('data-active-work')).toBe(false);
  });

  it('re-arms after a busy → idle → busy zero-crossing', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    renderShell();

    act(() => {
      setForegroundBusy();
    });
    act(() => {
      vi.advanceTimersByTime(30 * 60 * 1000);
    });
    expect(document.body.hasAttribute('data-active-work')).toBe(false);

    // Real idle transition — re-arms.
    act(() => {
      setForegroundIdle();
    });
    expect(document.body.hasAttribute('data-active-work')).toBe(false);

    // New busy window — attribute set again.
    act(() => {
      setForegroundBusy();
    });
    expect(document.body.getAttribute('data-active-work')).toBe('true');
  });

  it('cancels the watchdog timer when isBusy returns to false before threshold', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    renderShell();

    act(() => {
      setForegroundBusy();
    });
    act(() => {
      vi.advanceTimersByTime(15 * 60 * 1000);
      setForegroundIdle();
    });
    expect(document.body.hasAttribute('data-active-work')).toBe(false);

    // Advance well past 30-min — watchdog must NOT fire because the timer
    // was cleared on the busy → idle cleanup.
    act(() => {
      vi.advanceTimersByTime(60 * 60 * 1000);
    });
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
