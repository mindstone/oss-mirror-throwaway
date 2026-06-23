import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentSession } from '@shared/types';
import type { ConversationAnnotation } from '@shared/types/agent';
import { createSummaryFromSession } from '../effects/persistenceManager';
import { createSessionStore } from '../sessionStore';

const createAnnotation = (
  overrides: Partial<ConversationAnnotation> = {},
): ConversationAnnotation => ({
  id: 'ann-1',
  messageId: 'msg-1',
  text: 'selected text',
  comment: 'remember this',
  createdAt: 1703851200000,
  startOffset: 0,
  endOffset: 13,
  ...overrides,
});

const makeSession = (overrides: Partial<AgentSession> = {}): AgentSession => ({
  id: 'session-with-annotations',
  title: 'Annotated session',
  createdAt: 1_000,
  updatedAt: 1_000,
  messages: [{
    id: 'msg-1',
    turnId: 'turn-1',
    role: 'assistant',
    text: 'selected text is here',
    createdAt: 1_500,
  }],
  eventsByTurn: {},
  activeTurnId: null,
  isBusy: false,
  lastError: null,
  resolvedAt: null,
  ...overrides,
});

beforeEach(() => {
  vi.stubGlobal('window', {
    sessionsApi: {
      get: vi.fn().mockResolvedValue(null),
      upsert: vi.fn().mockResolvedValue({ success: true }),
      delete: vi.fn().mockResolvedValue(undefined),
      list: vi.fn().mockResolvedValue([]),
      applyTurnEventUnion: vi.fn().mockResolvedValue({ success: true }),
    },
    agentApi: {
      stopTurn: vi.fn().mockResolvedValue(undefined),
    },
  });
});

describe('sessionStore annotationsBySessionId', () => {
  it('writes, reads, and clears annotations by session id', () => {
    const store = createSessionStore();
    const sessionId = 'session-with-annotations';
    const annotation = createAnnotation();

    expect(store.getState().getAnnotationsForSession(sessionId)).toEqual([]);

    store.getState().setAnnotationsForSession(sessionId, [annotation]);

    expect(store.getState().getAnnotationsForSession(sessionId)).toEqual([
      annotation,
    ]);
    expect(store.getState().annotationsBySessionId[sessionId]).toEqual([annotation]);

    store.getState().setAnnotationsForSession(sessionId, []);

    expect(sessionId in store.getState().annotationsBySessionId).toBe(false);
    expect(store.getState().getAnnotationsForSession(sessionId)).toEqual([]);
  });

  it('persists annotations through snapshot and openHistorySession rehydration', () => {
    const store = createSessionStore();
    const sessionId = store.getState().currentSessionId;

    store.getState().addUserMessage('hello');
    const messageId = store.getState().messages[0].id;
    const annotation = createAnnotation({ messageId });
    store.getState().setAnnotationsForSession(sessionId, [annotation]);

    const snapshot = store.getState().snapshotCurrentSession();
    expect(snapshot?.annotations).toEqual([annotation]);

    const restartedStore = createSessionStore();
    restartedStore.getState().cacheSession(snapshot!);

    const reopened = restartedStore
      .getState()
      .openHistorySession(sessionId, snapshot!.eventsByTurn);

    expect(reopened?.id).toBe(sessionId);
    expect(restartedStore.getState().getAnnotationsForSession(sessionId)).toEqual([
      annotation,
    ]);
  });

  it('restores session-scoped annotations after switching away and back', () => {
    const store = createSessionStore();
    const sessionAId = store.getState().currentSessionId;

    store.getState().addUserMessage('hello from session A');
    const sessionAMessageId = store.getState().messages[0].id;
    const sessionAAnnotation = createAnnotation({
      id: 'ann-session-a',
      messageId: sessionAMessageId,
      comment: 'session A comment',
    });
    store
      .getState()
      .setAnnotationsForSession(sessionAId, [sessionAAnnotation]);

    const sessionB = makeSession({
      id: 'session-b',
      title: 'Session B',
      messages: [{
        id: 'msg-b',
        turnId: 'turn-b',
        role: 'assistant',
        text: 'session B reply',
        createdAt: 2_000,
      }],
      eventsByTurn: {},
    });
    store.getState().cacheSession(sessionB);

    const openedB = store
      .getState()
      .openHistorySession(sessionB.id, sessionB.eventsByTurn);
    expect(openedB?.id).toBe(sessionB.id);
    expect(store.getState().currentSessionId).toBe(sessionB.id);
    expect(store.getState().getAnnotationsForSession(sessionAId)).toEqual([
      sessionAAnnotation,
    ]);
    expect(store.getState().getAnnotationsForSession(sessionB.id)).toEqual([]);

    const cachedSessionA = store.getState().getLoadedSession(sessionAId);
    expect(cachedSessionA).toBeDefined();
    const reopenedA = store
      .getState()
      .openHistorySession(sessionAId, cachedSessionA!.eventsByTurn);

    expect(reopenedA?.id).toBe(sessionAId);
    expect(store.getState().currentSessionId).toBe(sessionAId);
    expect(store.getState().getAnnotationsForSession(sessionAId)).toEqual([
      sessionAAnnotation,
    ]);
  });

  it('rehydrates old sessions without annotations as empty', () => {
    const store = createSessionStore();
    const session = makeSession();
    store.getState().cacheSession(session);

    expect(() => {
      store.getState().openHistorySession(session.id, session.eventsByTurn);
    }).not.toThrow();
    expect(store.getState().getAnnotationsForSession(session.id)).toEqual([]);
  });

  it('does not resurrect cleared annotations from a stale disk merge', async () => {
    const store = createSessionStore();
    const annotation = createAnnotation();
    const staleDiskSession = makeSession({
      annotations: [annotation],
      eventsByTurn: { 'turn-1': [] },
    });
    store.getState().cacheSession(staleDiskSession);
    store.getState().setAnnotationsForSession(staleDiskSession.id, [annotation]);
    store.getState().setAnnotationsForSession(staleDiskSession.id, []);
    expect(
      Object.prototype.hasOwnProperty.call(
        store.getState().annotationsBySessionId,
        staleDiskSession.id,
      ),
    ).toBe(false);

    vi.mocked(window.sessionsApi.get).mockResolvedValue(staleDiskSession);

    store.getState().processHistoryEvent('session-with-annotations', 'turn-1', {
      type: 'result',
      text: 'done',
      timestamp: 2_000,
    });

    await vi.waitFor(() => {
      expect(window.sessionsApi.applyTurnEventUnion).toHaveBeenCalled();
    });
    expect(
      store.getState().loadedSessions.get(staleDiskSession.id)?.annotations,
    ).toBeUndefined();
    expect(store.getState().getAnnotationsForSession(staleDiskSession.id)).toEqual([]);
  });

  it('keeps annotation-only sessions snapshotable and under-cap cleanup preserves them', () => {
    const store = createSessionStore();
    const sessionId = store.getState().currentSessionId;
    const annotation = createAnnotation({
      id: 'ann-only',
      messageId: 'missing-message',
      comment: 'annotation-only session content',
      createdAt: 5_000,
    });

    store.getState().setAnnotationsForSession(sessionId, [annotation]);

    const snapshot = store.getState().snapshotCurrentSession();
    expect(snapshot).not.toBeNull();
    expect(snapshot?.messages).toEqual([]);
    expect(snapshot?.annotations).toEqual([annotation]);

    const summary = createSummaryFromSession(snapshot!);
    expect(summary.messageCount).toBe(0);
    expect(summary.hasAnnotations).toBe(true);

    store.getState().resetSession();

    const preservedSummary = store
      .getState()
      .sessionSummaries.find((candidate) => candidate.id === sessionId);
    expect(preservedSummary?.hasAnnotations).toBe(true);
    expect(store.getState().getAnnotationsForSession(sessionId)).toEqual([
      annotation,
    ]);
  });

  it('retains annotations on surviving messages (including target) and drops on truncated messages', () => {
    const store = createSessionStore();
    const session = makeSession({
      id: 'session-truncate-annotations',
      messages: [
        {
          id: 'm1',
          turnId: 'turn-1',
          role: 'user',
          text: 'First prompt',
          createdAt: 1_000,
        },
        {
          id: 'm2',
          turnId: 'turn-1',
          role: 'assistant',
          text: 'First reply',
          createdAt: 2_000,
        },
        {
          id: 'm3',
          turnId: 'turn-2',
          role: 'user',
          text: 'Second prompt',
          createdAt: 3_000,
        },
        {
          id: 'm4',
          turnId: 'turn-2',
          role: 'assistant',
          text: 'Second reply',
          createdAt: 4_000,
        },
        {
          id: 'm5',
          turnId: 'turn-3',
          role: 'assistant',
          text: 'Extra reply',
          createdAt: 5_000,
        },
      ],
      eventsByTurn: {
        'turn-1': [],
        'turn-2': [],
        'turn-3': [],
      },
    });
    store.getState().cacheSession(session);
    store.getState().openHistorySession(session.id, session.eventsByTurn);

    const annotations = [
      createAnnotation({ id: 'ann-m2', messageId: 'm2' }),
      createAnnotation({ id: 'ann-m3', messageId: 'm3' }),
      createAnnotation({ id: 'ann-m4', messageId: 'm4' }),
    ];
    store.getState().setAnnotationsForSession(session.id, annotations);

    // Annotations are AI-reply-only by design; `truncateToMessage` is only
    // invoked for user-message edit-and-resubmit, so the target message's
    // annotation set is empty in practice. This test codifies today's
    // surviving-message filter; if user-message annotations become valid,
    // revisit the filter because the edited target should likely drop too.
    store.getState().truncateToMessage('m3', 'Edited second prompt');

    expect(store.getState().messages.map((message) => message.id)).toEqual([
      'm1',
      'm2',
      'm3',
    ]);
    expect(store.getState().getAnnotationsForSession(session.id)).toEqual([
      annotations[0],
      annotations[1],
    ]);
  });
});
