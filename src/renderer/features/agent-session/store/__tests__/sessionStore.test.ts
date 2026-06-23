import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createSessionStore, getCurrentSessionEvents } from '../sessionStore';

beforeEach(() => {
  vi.stubGlobal('window', {
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
});

describe('sessionStore setupContext', () => {
  it('persists bundled app-bridge setup context through snapshot + rehydrate and clears it on reset', () => {
    const store = createSessionStore();
    const sessionId = store.getState().currentSessionId;

    store.getState().addUserMessage('Configure Rebel Browser');
    store.getState().setSetupContext({ kind: 'bundled-app-bridge' });
    store.getState().setSetupContextPairSessionId('pair-session-1');

    const snapshot = store.getState().snapshotCurrentSession();
    expect(snapshot?.setupContext).toEqual({
      kind: 'bundled-app-bridge',
      pairSessionId: 'pair-session-1',
    });

    store.getState().addOrUpdateHistorySession(snapshot!);
    store.getState().resetSession();
    expect(store.getState().currentSessionSetupContext).toBeNull();

    const reloadedSession = {
      ...snapshot!,
      id: sessionId,
    };
    store.getState().cacheSession(reloadedSession);
    const reopened = store.getState().openHistorySession(sessionId, reloadedSession.eventsByTurn);

    expect(reopened?.setupContext).toEqual({
      kind: 'bundled-app-bridge',
      pairSessionId: 'pair-session-1',
    });
    expect(store.getState().currentSessionSetupContext).toEqual({
      kind: 'bundled-app-bridge',
      pairSessionId: 'pair-session-1',
    });

    store.getState().resetSession();
    expect(store.getState().currentSessionSetupContext).toBeNull();
  });

  it('setSetupContextForSession writes to a background session without modifying active session, and clears on null', () => {
    const store = createSessionStore();
    
    // Create a background session
    const backgroundSessionId = 'bg-session-1';
    store.getState().createBackgroundSession(backgroundSessionId);
    
    // Call the new reducer
    store.getState().setSetupContextForSession(backgroundSessionId, {
      kind: 'bundled-app-bridge',
      pairSessionId: 'pair-session-X',
    });
    
    // Background session should have it
    const bgSession = store.getState().loadedSessions.get(backgroundSessionId);
    expect(bgSession?.setupContext).toEqual({
      kind: 'bundled-app-bridge',
      pairSessionId: 'pair-session-X',
    });
    
    // Active session should be untouched
    expect(store.getState().currentSessionSetupContext).toBeNull();
    
    // Idempotent clear — reducer normalises `null` to `undefined` for the
    // background-session persistence path (AgentSession.setupContext is
    // optional-but-not-nullable).
    store.getState().setSetupContextForSession(backgroundSessionId, null);
    const bgSessionAfterClear = store.getState().loadedSessions.get(backgroundSessionId);
    expect(bgSessionAfterClear?.setupContext).toBeUndefined();
  });
});

describe('sessionStore approval receipts', () => {
  it('adds a receipt to the current session without marking it as user work', async () => {
    const store = createSessionStore();

    await store.getState().addReceiptMessageToSession(
      store.getState().currentSessionId,
      'Approved. Rebel saved research-plan.md to UX Research.',
    );

    expect(store.getState().messages).toEqual([
      expect.objectContaining({
        role: 'assistant',
        text: 'Approved. Rebel saved research-plan.md to UX Research.',
        isApprovalReceipt: true,
      }),
    ]);
    expect(store.getState().isBusy).toBe(false);
  });

  it('persists a receipt to a loaded background session without sending a turn', async () => {
    const upsert = vi.fn().mockResolvedValue({ success: true });
    vi.mocked(window.sessionsApi.upsert).mockImplementation(upsert);

    const store = createSessionStore();
    const backgroundSessionId = 'approval-session-1';
    store.getState().createBackgroundSession(backgroundSessionId);

    const ok = await store.getState().addReceiptMessageToSession(
      backgroundSessionId,
      'Approved. Rebel saved research-plan.md to UX Research.',
    );

    const session = store.getState().loadedSessions.get(backgroundSessionId);
    expect(ok).toBe(true);
    expect(session?.messages).toEqual([
      expect.objectContaining({
        role: 'assistant',
        text: 'Approved. Rebel saved research-plan.md to UX Research.',
        isApprovalReceipt: true,
      }),
    ]);
    expect(window.agentApi.stopTurn).not.toHaveBeenCalled();
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        id: backgroundSessionId,
        messages: [
          expect.objectContaining({
            isApprovalReceipt: true,
          }),
        ],
      }),
    );
  });
});

describe('sessionStore.clearAllSessionsForE2E', () => {
  it('clears sidebar summaries, loaded sessions, drafts, and current conversation state', () => {
    const store = createSessionStore();
    const initialSessionId = store.getState().currentSessionId;

    store.getState().addUserMessage('Keep this out of the next test');
    store.getState().processEvent('turn-1', {
      type: 'result',
      text: 'Done',
      timestamp: Date.now(),
    });
    store.getState().createBackgroundSession('background-session');
    store.getState().setDraftForSession(initialSessionId, 'stale draft');
    store.getState().setAnnotationsForSession(initialSessionId, [
      {
        id: 'annotation-1',
        messageId: 'message-1',
        text: 'Draft',
        comment: 'Clear me',
        createdAt: Date.now(),
        startOffset: 0,
        endOffset: 5,
      },
    ]);

    expect(store.getState().sessionSummaries.length).toBeGreaterThan(0);
    expect(store.getState().loadedSessions.size).toBeGreaterThan(0);
    expect(Object.keys(getCurrentSessionEvents())).toHaveLength(1);

    const nextSessionId = store.getState().clearAllSessionsForE2E();

    expect(nextSessionId).not.toBe(initialSessionId);
    expect(store.getState().currentSessionId).toBe(nextSessionId);
    expect(store.getState().messages).toEqual([]);
    expect(getCurrentSessionEvents()).toEqual({});
    expect(store.getState().sessionSummaries).toEqual([]);
    expect(store.getState().loadedSessions.size).toBe(0);
    expect(store.getState().draftsBySessionId).toEqual({});
    expect(store.getState().annotationsBySessionId).toEqual({});
    expect(store.getState().pendingNetworkRetryTurns).toEqual({});
  });
});
