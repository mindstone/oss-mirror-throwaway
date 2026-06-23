// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { useAgentSessionEngine } from '../useAgentSessionEngine';
import { useSessionStore } from '../../store/sessionStore';
import type { AgentEvent } from '@shared/types';

vi.mock('@renderer/contexts', () => ({
  useEmitLog: vi.fn(() => vi.fn()),
  useRecordBreadcrumb: vi.fn(() => vi.fn()),
}));

vi.mock('@renderer/src/sentry', () => ({
  captureRendererException: vi.fn(),
  captureRendererMessage: vi.fn(),
}));

let onEventCallback: ((payload: { turnId: string; event: AgentEvent; sessionId?: string }) => void) | null = null;

beforeEach(() => {
  vi.clearAllMocks();
  onEventCallback = null;
  // @ts-expect-error - testing env
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  
  vi.stubGlobal('sessionsApi', {
    get: vi.fn().mockResolvedValue(null),
    upsert: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
    list: vi.fn().mockResolvedValue([]),
  });

  vi.stubGlobal('api', {
    onAgentEvent: vi.fn((cb) => {
      onEventCallback = cb;
      return () => { onEventCallback = null; };
    }),
    onSessionTitleGenerated: vi.fn(() => () => {}),
    onSessionActivitySummaryGenerated: vi.fn(() => () => {}),
    onSafetyEvaluating: vi.fn(() => () => {}),
    onSafetyEvaluated: vi.fn(() => () => {}),
    onSafetyEvaluatingComplete: vi.fn(() => () => {}),
  });
  
  vi.stubGlobal('agentApi', {
    onSessionTitleGenerated: vi.fn(() => () => {}),
    stopTurn: vi.fn().mockResolvedValue(undefined),
    turn: vi.fn().mockResolvedValue({ turnId: 'test-turn-1' }),
    evaluateDoneSafety: vi.fn().mockResolvedValue({ safeToMarkDone: false, reason: 'test' }),
  });
});

function TestHarness() {
  useAgentSessionEngine({
    emitLog: vi.fn(),
    recordBreadcrumb: vi.fn(),
    showToast: vi.fn(),
  });
  return null;
}

describe('useAgentSessionEngine extract_extension cross-session stamping', () => {
  it('stamps pairSessionId on the originating background session when tool ends', async () => {
    const store = useSessionStore;
    
    // Start with a clean slate
    act(() => {
      store.getState().resetSession();
    });
    
    const backgroundSessionId = 'bg-session-1';

    // Create background session
    act(() => {
      store.getState().createBackgroundSession(backgroundSessionId);
    });

    const container = document.createElement('div');
    const root = createRoot(container);

    await act(async () => {
      root.render(createElement(TestHarness));
    });

    // Make sure the callback was registered
    expect(onEventCallback).not.toBeNull();

    // Set an activeTurnId on the background session so the hook routes the event to it.
    act(() => {
      const bgSession = store.getState().loadedSessions.get(backgroundSessionId);
      if (bgSession) {
        bgSession.activeTurnId = 'turn-1';
        store.getState().cacheSession(bgSession);
        
        const summary = store.getState().sessionSummaries.find(s => s.id === backgroundSessionId);
        if (summary) {
          store.getState().updateSessionSummary({ ...summary, activeTurnId: 'turn-1' });
        }
      }
    });

    // Simulate tool end event on background session
    const toolEvent: AgentEvent = {
      type: 'tool',
      stage: 'end',
      toolName: 'rebel_bridge_prepare_install',
      toolUseId: 'use-1',
      detail: JSON.stringify({
        ok: true,
        reason: 'ok',
        retryable: false,
        data: {
          setupStatus: 'awaiting_user_handoff',
          installSessionAlias: 'install_alias_bg',
        },
      }),
      isError: false,
      timestamp: Date.now(),
    };

    await act(async () => {
      onEventCallback!({ turnId: 'turn-1', event: toolEvent, sessionId: backgroundSessionId });
    });

    // Background session should have pairSessionId stamped
    const bgSessionAfter = store.getState().loadedSessions.get(backgroundSessionId);
    expect(bgSessionAfter?.setupContext).toEqual({
      kind: 'bundled-app-bridge',
      pairSessionId: 'install_alias_bg',
    });

    // Active session should be untouched
    expect(store.getState().currentSessionSetupContext).toBeNull();
    
    await act(async () => {
      root.unmount();
    });
  });
});
