import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createSessionStore } from '../sessionStore';

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

function seedHistorySession() {
  const store = createSessionStore();
  const sessionId = store.getState().currentSessionId;

  store.getState().renameSession(sessionId, 'History session');
  store.getState().addUserMessage('Open this session from history');

  const messageId = store.getState().messages[0].id;
  const turnId = 'history-turn-1';
  store.getState().assignTurnToMessage(messageId, turnId, Date.now());
  store.getState().processEvent(turnId, {
    type: 'status',
    message: 'Thinking',
    timestamp: Date.now(),
  });
  store.getState().processEvent(turnId, {
    type: 'result',
    text: 'Done',
    timestamp: Date.now(),
  });

  const snapshot = store.getState().snapshotCurrentSession();
  if (!snapshot) {
    throw new Error('Expected seeded session snapshot to exist');
  }

  store.getState().addOrUpdateHistorySession(snapshot);
  store.getState().resetSession();

  return { store, snapshot, turnId };
}

describe('openHistorySession', () => {
  it('returns the requested history session and updates current store state', () => {
    const { store, snapshot, turnId } = seedHistorySession();

    const reopened = store.getState().openHistorySession(snapshot.id, snapshot.eventsByTurn);

    expect(reopened).not.toBeNull();
    expect(reopened).toMatchObject({
      id: snapshot.id,
      title: 'History session',
      origin: 'manual',
    });
    expect(reopened!.messages).toEqual(snapshot.messages);
    expect(reopened!.eventsByTurn[turnId]?.length ?? 0).toBeGreaterThan(0);
    expect(store.getState().currentSessionId).toBe(snapshot.id);
    expect(store.getState().messages).toEqual(reopened!.messages);
  });

  it('returns null for a session id that is not loaded in history', () => {
    const store = createSessionStore();

    expect(store.getState().openHistorySession('missing-session-id')).toBeNull();
  });

  it('keeps a draft-only outgoing session visible in history after opening another session', () => {
    const { store, snapshot } = seedHistorySession();
    const outgoingSessionId = store.getState().currentSessionId;
    const draftText = 'Draft typed before switching sessions';

    store.getState().setDraftForSession(outgoingSessionId, draftText);

    const outgoingSnapshot = store.getState().snapshotCurrentSession();
    expect(outgoingSnapshot).not.toBeNull();
    expect(outgoingSnapshot?.draft?.text).toBe(draftText);

    const opened = store.getState().openHistorySession(snapshot.id, snapshot.eventsByTurn);
    expect(opened).not.toBeNull();

    const outgoingSummary = store
      .getState()
      .sessionSummaries.find((summary) => summary.id === outgoingSessionId);
    expect(outgoingSummary).toBeDefined();
    expect(outgoingSummary?.hasDraft).toBe(true);
    expect(outgoingSummary?.draftPreview).toContain('Draft typed before switching sessions');
    expect(store.getState().draftsBySessionId[outgoingSessionId]?.text).toBe(draftText);
  });

  it('selectSession sanitises persisted-draft text containing &nbsp; into draftsBySessionId', () => {
    const { store, snapshot } = seedHistorySession();
    const sessionId = snapshot.id;

    // Inject a corrupted persisted draft into the cached session so the
    // openHistorySession rehydrate path encounters NBSP-family entities. The
    // existing in-memory `draftsBySessionId[sessionId]` is empty (no live
    // composer state for the dormant session), so the rehydrate branch fires.
    const cached = store.getState().loadedSessions.get(sessionId);
    if (!cached) {
      throw new Error('Expected seeded session to be cached');
    }
    const corruptedText = 'hello&nbsp;world\n\n&nbsp;\n\nfoo&nbsp;bar';
    store.getState().cacheSession({
      ...cached,
      draft: { text: corruptedText, updatedAt: Date.now() },
    });
    expect(store.getState().draftsBySessionId[sessionId]).toBeUndefined();

    store.getState().openHistorySession(sessionId, snapshot.eventsByTurn);

    const rehydrated = store.getState().draftsBySessionId[sessionId];
    expect(rehydrated).toBeDefined();
    expect(rehydrated!.text).not.toContain('&nbsp;');
    expect(rehydrated!.text).not.toContain('\u00a0');
  });
});
