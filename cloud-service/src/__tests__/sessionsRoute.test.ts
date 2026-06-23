import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type http from 'node:http';
import { EventEmitter } from 'node:events';
import type { CloudServiceDeps } from '../bootstrap';
import type { AgentSession } from '@shared/types';
import {
  handleSessions,
  _resetSessionsRouteTombstoneStateForTests,
} from '../routes/sessions';
import { mergeDesktopPushIntoCloud } from '@core/services/cloudSessionMergeService';
import { resetSessionTombstoneStoreForTests } from '@core/services/continuity/sessionTombstoneStore';
import { setErrorReporter } from '@core/errorReporter';
import { cloudEventBroadcaster } from '../cloudEventBroadcaster';
import * as continuityRoute from '@core/services/cloudContinuityStateService';
import { getOutboxStallMonitor } from '@core/services/continuity/outboxStallMonitor';
import {
  resetDiagnosticEventsLedgerForTests,
  setDiagnosticEventsLedgerWriter,
  setDiagnosticEventsSurface,
} from '@core/services/diagnosticEventsLedger';
import type { DiagnosticEventEntry } from '@core/services/diagnostics/manifest';

function createMockReq(url: string): http.IncomingMessage {
  return {
    method: 'GET',
    url,
    headers: { host: 'localhost' },
  } as http.IncomingMessage;
}

function createMockMethodReq(
  method: string,
  url: string,
  headers?: Record<string, string>,
): http.IncomingMessage {
  return {
    method,
    url,
    headers: { host: 'localhost', ...headers },
  } as http.IncomingMessage;
}

function createMockRes(): {
  res: http.ServerResponse;
  statusCode: () => number;
  body: <T = unknown>() => T;
} {
  let capturedStatus = 200;
  let capturedBody = '';

  const res = {
    writeHead: vi.fn((status: number) => {
      capturedStatus = status;
    }),
    end: vi.fn((body?: string) => {
      capturedBody = body || '';
    }),
  } as unknown as http.ServerResponse;

  return {
    res,
    statusCode: () => capturedStatus,
    body: <T = unknown>() => JSON.parse(capturedBody) as T,
  };
}

function makeSession() {
  const longDetail = 'x'.repeat(650);

  return {
    id: 'session-1',
    title: 'Test Session',
    createdAt: 1000,
    updatedAt: 2000,
    messages: [],
    activeTurnId: null,
    isBusy: false,
    lastError: null,
    resolvedAt: null,
    eventsByTurn: {
      'turn-1': [
        { type: 'status', status: 'Thinking', timestamp: 1 },
        {
          type: 'tool',
          toolName: 'bash',
          detail: longDetail,
          stage: 'start',
          isError: true,
          toolUseId: 'tool-1',
          timestamp: 2,
        },
        {
          type: 'tool',
          toolName: 'compose_workspace_email',
          detail: '{"path":"/tmp/file.txt"}',
          stage: 'end',
          timestamp: 3,
          parentToolUseId: 'tool-1',
          imageContent: [{ type: 'image', data: 'abc', mimeType: 'image/png' }],
          mcpAppUiMeta: {
            resourceUri: 'ui://google-workspace/compose-email',
            presentation: 'primary',
            viewSummary: 'Email draft to person@example.com — subject "Hello".',
            viewRoleLabel: 'Editable email draft',
            structuredFallback: {
              kind: 'email-draft',
              payload: {
                to: ['person@example.com'],
                cc: [],
                bcc: [],
                subject: 'Hello',
                body: 'Draft body.',
              },
            },
          },
          toolResult: {
            content: [{ type: 'text', text: 'Draft ready' }],
            structuredContent: {
              to: ['person@example.com'],
              cc: [],
              bcc: [],
              subject: 'Hello',
              body: 'Draft body.',
              email: 'sender@example.com',
            },
          },
        },
      ],
      'turn-2': [{ type: 'result', result: 'done', timestamp: 4 }],
    },
  } as unknown as import('@shared/types').AgentSession;
}

function makeDeps(session: import('@shared/types').AgentSession): CloudServiceDeps {
  return {
    getSession: vi.fn(async () => session),
  } as unknown as CloudServiceDeps;
}

const capturedBreadcrumbs: Array<{ category: string; message: string; data?: Record<string, unknown> }> = [];
const capturedMessages: Array<{ message: string; context?: Record<string, unknown> }> = [];
const capturedDiagnosticEvents: DiagnosticEventEntry[] = [];
const broadcastSpy = vi.spyOn(cloudEventBroadcaster, 'broadcast');

beforeEach(() => {
  capturedBreadcrumbs.length = 0;
  capturedMessages.length = 0;
  capturedDiagnosticEvents.length = 0;
  broadcastSpy.mockClear();
  resetDiagnosticEventsLedgerForTests();
  setDiagnosticEventsSurface('cloud');
  setDiagnosticEventsLedgerWriter({
    append: (entry) => {
      capturedDiagnosticEvents.push(entry);
    },
  });
  setErrorReporter({
    captureException: () => {},
    captureMessage: (message, context) => {
      capturedMessages.push({ message, context });
    },
    addBreadcrumb: (breadcrumb) => {
      capturedBreadcrumbs.push({
        category: breadcrumb.category,
        message: breadcrumb.message,
        data: breadcrumb.data,
      });
    },
  });
});

afterEach(() => {
  resetSessionTombstoneStoreForTests();
  _resetSessionsRouteTombstoneStateForTests();
  resetDiagnosticEventsLedgerForTests();
  setErrorReporter({
    captureException: () => {},
    captureMessage: () => {},
    addBreadcrumb: () => {},
  });
});

function expectContinuityBreadcrumbAndDiagnostic(args: {
  message: string;
  reason?: string;
  family?: string;
}): void {
  expect(capturedBreadcrumbs.some((breadcrumb) => breadcrumb.message === args.message)).toBe(true);
  expect(capturedDiagnosticEvents).toContainEqual(expect.objectContaining({
    kind: 'continuity_transition',
    surface: 'cloud',
    data: expect.objectContaining({
      family: args.family ?? 'merge',
      message: args.message,
      ...(args.reason ? { reason: args.reason } : {}),
    }),
  }));
}

describe('sessions route lean toolEvents filtering', () => {
  it('returns only minimal tool events when lean=true&toolEvents=true', async () => {
    const session = makeSession();
    const deps = makeDeps(session);
    const { res, statusCode, body } = createMockRes();

    await handleSessions(createMockReq('/api/sessions/session-1?lean=true&toolEvents=true'), res, ['api', 'sessions', 'session-1'], deps);

    expect(statusCode()).toBe(200);
    const data = body() as Record<string, unknown>;
    const eventsByTurn = data.eventsByTurn as Record<string, Array<Record<string, unknown>>>;

    expect(Object.keys(eventsByTurn)).toEqual(['turn-1']);
    expect(eventsByTurn['turn-1']).toHaveLength(2);

    expect(eventsByTurn['turn-1'][0]).toEqual({
      type: 'tool',
      toolName: 'bash',
      detail: 'x'.repeat(500),
      stage: 'start',
      isError: true,
      toolUseId: 'tool-1',
      timestamp: 2,
    });

    expect(eventsByTurn['turn-1'][1]).toEqual({
      type: 'tool',
      toolName: 'compose_workspace_email',
      detail: '{"path":"/tmp/file.txt"}',
      stage: 'end',
      timestamp: 3,
      parentToolUseId: 'tool-1',
      imageContent: [{ type: 'image', data: 'abc', mimeType: 'image/png' }],
      mcpAppUiMeta: {
        resourceUri: 'ui://google-workspace/compose-email',
        presentation: 'primary',
        viewSummary: 'Email draft to person@example.com — subject "Hello".',
        viewRoleLabel: 'Editable email draft',
        structuredFallback: {
          kind: 'email-draft',
          payload: {
            to: ['person@example.com'],
            cc: [],
            bcc: [],
            subject: 'Hello',
            body: 'Draft body.',
          },
        },
      },
      toolResult: {
        content: [{ type: 'text', text: 'Draft ready' }],
        structuredContent: {
          to: ['person@example.com'],
          cc: [],
          bcc: [],
          subject: 'Hello',
          body: 'Draft body.',
          email: 'sender@example.com',
        },
      },
    });

    const allowedKeys = ['type', 'toolName', 'detail', 'stage', 'isError', 'toolUseId', 'parentToolUseId', 'timestamp', 'imageContent', 'imageRef', 'mcpAppUiMeta', 'toolResult'];
    for (const event of eventsByTurn['turn-1']) {
      expect(Object.keys(event).every((key) => allowedKeys.includes(key))).toBe(true);
    }
  });

  it('preserves imageRef in lean toolEvents responses', async () => {
    const session = makeSession();
    const imageRef = { assetId: 'turn-images-1-0', mimeType: 'image/png', byteSize: 123 };
    session.eventsByTurn = {
      'turn-images': [
        {
          type: 'tool',
          toolName: 'screenshot',
          detail: 'Captured screenshot',
          stage: 'end',
          timestamp: 10,
          imageRef: [imageRef],
        },
      ],
    } as unknown as import('@shared/types').AgentSession['eventsByTurn'];

    const deps = makeDeps(session);
    const { res, statusCode, body } = createMockRes();

    await handleSessions(createMockReq('/api/sessions/session-1?lean=true&toolEvents=true'), res, ['api', 'sessions', 'session-1'], deps);

    expect(statusCode()).toBe(200);
    const data = body() as Record<string, unknown>;
    const eventsByTurn = data.eventsByTurn as Record<string, Array<Record<string, unknown>>>;

    expect(eventsByTurn['turn-images'][0].imageRef).toEqual([imageRef]);
  });

  it('preserves imageContent in lean toolEvents responses', async () => {
    const session = makeSession();
    session.eventsByTurn = {
      'turn-images': [
        {
          type: 'tool',
          toolName: 'screenshot',
          detail: 'Captured screenshot',
          stage: 'end',
          timestamp: 10,
          imageContent: [
            { type: 'image', data: 'abc', mimeType: 'image/png' },
            { type: 'image', data: 'def', mimeType: 'image/jpeg' },
          ],
        },
      ],
    } as unknown as import('@shared/types').AgentSession['eventsByTurn'];

    const deps = makeDeps(session);
    const { res, statusCode, body } = createMockRes();

    await handleSessions(createMockReq('/api/sessions/session-1?lean=true&toolEvents=true'), res, ['api', 'sessions', 'session-1'], deps);

    expect(statusCode()).toBe(200);
    const data = body() as Record<string, unknown>;
    const eventsByTurn = data.eventsByTurn as Record<string, Array<Record<string, unknown>>>;

    expect(eventsByTurn['turn-images'][0].imageContent).toEqual([
      { type: 'image', data: 'abc', mimeType: 'image/png' },
      { type: 'image', data: 'def', mimeType: 'image/jpeg' },
    ]);
  });

  it('drops all imageContent for a turn when cumulative image size exceeds 10MB', async () => {
    const maxTurnImageBytes = 10 * 1024 * 1024;
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      const session = makeSession();
      session.eventsByTurn = {
        'turn-oversized': [
          {
            type: 'tool',
            toolName: 'capture_screen',
            detail: 'first image',
            stage: 'end',
            timestamp: 20,
            imageContent: [{ type: 'image', data: 'a'.repeat(maxTurnImageBytes - 5), mimeType: 'image/png' }],
          },
          {
            type: 'tool',
            toolName: 'chart_render',
            detail: 'second image',
            stage: 'end',
            timestamp: 21,
            imageContent: [{ type: 'image', data: 'b'.repeat(10), mimeType: 'image/png' }],
          },
        ],
      } as unknown as import('@shared/types').AgentSession['eventsByTurn'];

      const deps = makeDeps(session);
      const { res, statusCode, body } = createMockRes();

      await handleSessions(createMockReq('/api/sessions/session-1?lean=true&toolEvents=true'), res, ['api', 'sessions', 'session-1'], deps);

      expect(statusCode()).toBe(200);
      const data = body() as Record<string, unknown>;
      const eventsByTurn = data.eventsByTurn as Record<string, Array<Record<string, unknown>>>;

      expect(eventsByTurn['turn-oversized']).toHaveLength(2);
      expect(eventsByTurn['turn-oversized'][0].imageContent).toBeUndefined();
      expect(eventsByTurn['turn-oversized'][1].imageContent).toBeUndefined();

      expect(warnSpy).toHaveBeenCalledTimes(1);
      const warningMessage = String(warnSpy.mock.calls[0]?.[0] ?? '');
      expect(warningMessage).toContain('turn-oversized');
      expect(warningMessage).toContain('capture_screen');
      expect(warningMessage).toContain('chart_render');
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('keeps lean=true behavior unchanged when toolEvents is not requested', async () => {
    const session = makeSession();
    const deps = makeDeps(session);
    const { res, statusCode, body } = createMockRes();

    await handleSessions(createMockReq('/api/sessions/session-1?lean=true'), res, ['api', 'sessions', 'session-1'], deps);

    expect(statusCode()).toBe(200);
    const data = body() as Record<string, unknown>;
    expect(data.eventsByTurn).toBeUndefined();
  });

  it('returns empty tool events for legacy sessions without eventsByTurn', async () => {
    const session = {
      ...makeSession(),
      eventsByTurn: undefined,
    } as unknown as import('@shared/types').AgentSession;
    const deps = makeDeps(session);
    const { res, statusCode, body } = createMockRes();

    await handleSessions(createMockReq('/api/sessions/session-1?lean=true&toolEvents=true'), res, ['api', 'sessions', 'session-1'], deps);

    expect(statusCode()).toBe(200);
    const data = body() as Record<string, unknown>;
    expect(data.eventsByTurn).toEqual({});
  });

  it('returns full session unchanged when neither lean nor toolEvents is provided', async () => {
    const session = makeSession();
    const deps = makeDeps(session);
    const { res, statusCode, body } = createMockRes();

    await handleSessions(createMockReq('/api/sessions/session-1'), res, ['api', 'sessions', 'session-1'], deps);

    expect(statusCode()).toBe(200);
    expect(body()).toEqual(session);
  });

  it('returns full session unchanged when toolEvents=true but lean is not requested', async () => {
    const session = makeSession();
    const deps = makeDeps(session);
    const { res, statusCode, body } = createMockRes();

    await handleSessions(createMockReq('/api/sessions/session-1?toolEvents=true'), res, ['api', 'sessions', 'session-1'], deps);

    expect(statusCode()).toBe(200);
    expect(body()).toEqual(session);
  });

  it('passes user_question + user_question_answered events through the lean filter (Stage 7 rehydration)', async () => {
    // Cross-session rehydration: after a force-quit between answer and continuation,
    // mobile's /api/sessions/:id?lean=true&toolEvents=true call must return the
    // user_question events so `useUserQuestions` can show the card as answered.
    const session = makeSession();
    session.eventsByTurn = {
      'turn-1': [
        { type: 'tool', toolName: 'bash', detail: 'running', stage: 'start', timestamp: 1, toolUseId: 'tu-1' },
        {
          type: 'user_question',
          batchId: 'batch-1',
          toolUseId: 'tu-1',
          questions: [
            {
              id: 'q0',
              question: 'Which option fits best?',
              header: 'Choose',
              options: [{ id: 'q0-opt0', label: 'A' }, { id: 'q0-opt1', label: 'B' }],
              multiSelect: false,
            },
          ],
          timestamp: 2,
        },
        {
          type: 'user_question_answered',
          batchId: 'batch-1',
          answers: [{ questionId: 'q0', selectedOptionIds: ['q0-opt0'] }],
          timestamp: 3,
        },
        { type: 'status', status: 'Not included', timestamp: 4 },
      ],
    } as unknown as import('@shared/types').AgentSession['eventsByTurn'];

    const deps = makeDeps(session);
    const { res, statusCode, body } = createMockRes();

    await handleSessions(createMockReq('/api/sessions/session-1?lean=true&toolEvents=true'), res, ['api', 'sessions', 'session-1'], deps);

    expect(statusCode()).toBe(200);
    const data = body() as Record<string, unknown>;
    const eventsByTurn = data.eventsByTurn as Record<string, Array<Record<string, unknown>>>;

    // turn-1 should have the tool event + both user_question events; status is filtered out.
    expect(eventsByTurn['turn-1']).toHaveLength(3);
    const types = eventsByTurn['turn-1'].map((e) => e.type);
    expect(types).toEqual(['tool', 'user_question', 'user_question_answered']);

    const questionEvent = eventsByTurn['turn-1'].find((e) => e.type === 'user_question');
    expect(questionEvent).toMatchObject({
      batchId: 'batch-1',
      toolUseId: 'tu-1',
    });
    const answeredEvent = eventsByTurn['turn-1'].find((e) => e.type === 'user_question_answered');
    expect(answeredEvent).toMatchObject({
      batchId: 'batch-1',
      answers: [{ questionId: 'q0', selectedOptionIds: ['q0-opt0'] }],
    });
  });

  it('preserves the skipped flag on user_question_answered events through the lean filter', async () => {
    const session = makeSession();
    session.eventsByTurn = {
      'turn-1': [
        {
          type: 'user_question_answered',
          batchId: 'batch-1',
          answers: [],
          skipped: true,
          timestamp: 5,
        },
      ],
    } as unknown as import('@shared/types').AgentSession['eventsByTurn'];

    const deps = makeDeps(session);
    const { res, statusCode, body } = createMockRes();

    await handleSessions(createMockReq('/api/sessions/session-1?lean=true&toolEvents=true'), res, ['api', 'sessions', 'session-1'], deps);

    expect(statusCode()).toBe(200);
    const data = body() as Record<string, unknown>;
    const eventsByTurn = data.eventsByTurn as Record<string, Array<Record<string, unknown>>>;
    expect(eventsByTurn['turn-1'][0]).toMatchObject({
      type: 'user_question_answered',
      batchId: 'batch-1',
      skipped: true,
    });
  });

  it('preserves approval clarification purpose and answered receipts through the lean filter', async () => {
    const session = makeSession();
    session.eventsByTurn = {
      'turn-1': [
        {
          type: 'user_question',
          batchId: 'batch-1',
          toolUseId: 'tu-1',
          questions: [
            {
              id: 'q0',
              question: 'Which calendar should I use?',
              header: 'Calendar',
              context: 'I found two calendars that could fit.',
              options: [{ id: 'q0-opt0', label: 'Work' }, { id: 'q0-opt1', label: 'Personal' }],
              multiSelect: false,
              purpose: 'approval_clarification',
            },
          ],
          timestamp: 2,
        },
        {
          type: 'user_question_answered',
          batchId: 'batch-1',
          answers: [],
          skipped: true,
          timestamp: 3,
        },
      ],
    } as unknown as import('@shared/types').AgentSession['eventsByTurn'];

    const deps = makeDeps(session);
    const { res, statusCode, body } = createMockRes();

    await handleSessions(createMockReq('/api/sessions/session-1?lean=true&toolEvents=true'), res, ['api', 'sessions', 'session-1'], deps);

    expect(statusCode()).toBe(200);
    const data = body() as Record<string, unknown>;
    const eventsByTurn = data.eventsByTurn as Record<string, Array<Record<string, unknown>>>;
    expect(eventsByTurn['turn-1'][0]).toMatchObject({
      type: 'user_question',
      questions: [
        expect.objectContaining({
          purpose: 'approval_clarification',
          context: 'I found two calendars that could fit.',
        }),
      ],
    });
    expect(eventsByTurn['turn-1'][1]).toMatchObject({
      type: 'user_question_answered',
      batchId: 'batch-1',
      skipped: true,
    });
  });
});

describe('sessions route tombstones', () => {
  function createBodyReq(method: 'PUT' | 'DELETE', url: string, body?: unknown, headers?: Record<string, string>): http.IncomingMessage {
    const req = new EventEmitter() as http.IncomingMessage;
    req.method = method;
    req.url = url;
    req.headers = { host: 'localhost', ...headers };
    process.nextTick(() => {
      if (body !== undefined) {
        req.emit('data', Buffer.from(JSON.stringify(body)));
      }
      req.emit('end');
    });
    return req;
  }

  it('adds tombstones on delete, filters summaries, and blocks GET by id', async () => {
    const session = makeMergeSession({ id: 'session-delete' });
    let isDeleted = false;
    const deps = {
      listSessions: vi.fn(() => [{
        id: session.id,
        title: session.title,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        resolvedAt: session.resolvedAt,
        doneAt: null,
        starredAt: null,
        deletedAt: null,
        origin: 'manual',
        isCorrupted: false,
        privateMode: false,
        interruptedTurnId: null,
        preview: '',
        firstMessagePreview: '',
        lastMessagePreview: '',
        messageCount: 0,
        hasDraft: false,
        draftPreview: '',
        draftUpdatedAt: null,
        usage: { costUsd: 0, inputTokens: 0, outputTokens: 0, turnCount: 0 },
        activeTurnId: null,
        isBusy: false,
        lastError: null,
        meetingCompanion: null,
      }]),
      loadSessions: vi.fn(async () => [session]),
      getSession: vi.fn(async (id: string) => (id === 'session-delete' && !isDeleted ? session : null)),
      deleteSession: vi.fn(async () => { isDeleted = true; }),
    } as unknown as CloudServiceDeps;

    const deleteRes = createMockRes();
    await handleSessions(
      createBodyReq('DELETE', '/api/sessions/session-delete', undefined, { 'x-rebel-surface': 'mobile' }),
      deleteRes.res,
      ['api', 'sessions', 'session-delete'],
      deps,
    );
    expect(deleteRes.statusCode()).toBe(200);
    expect(deleteRes.body()).toMatchObject({
      success: true,
      tombstone: expect.objectContaining({
        sessionId: 'session-delete',
        deletedBy: 'mobile',
      }),
    });

    const listRes = createMockRes();
    await handleSessions(
      createMockReq('/api/sessions?summaries=true'),
      listRes.res,
      ['api', 'sessions'],
      deps,
    );
    expect(listRes.statusCode()).toBe(200);
    expect((listRes.body() as { sessions: unknown[] }).sessions).toEqual([]);

    const getRes = createMockRes();
    await handleSessions(
      createMockReq('/api/sessions/session-delete'),
      getRes.res,
      ['api', 'sessions', 'session-delete'],
      deps,
    );
    expect(getRes.statusCode()).toBe(404);
  });

  it('emits both breadcrumb and diagnostic event for tombstone-added deletes', async () => {
    const deps = {
      deleteSession: vi.fn(async () => {}),
    } as unknown as CloudServiceDeps;

    const deleteRes = createMockRes();
    await handleSessions(
      createBodyReq('DELETE', '/api/sessions/session-delete-diagnostic', undefined, { 'x-rebel-surface': 'mobile' }),
      deleteRes.res,
      ['api', 'sessions', 'session-delete-diagnostic'],
      deps,
    );

    expect(deleteRes.statusCode()).toBe(200);
    expectContinuityBreadcrumbAndDiagnostic({
      message: 'tombstone-added',
      reason: 'tombstone-added',
    });
  });

  it('returns a tombstone payload from the events catch-up endpoint for deleted sessions', async () => {
    const sessionId = 'session-events-delete';
    const session = makeMergeSession({ id: sessionId });
    let isDeleted = false;
    const deps = {
      getSession: vi.fn(async (id: string) => (id === sessionId && !isDeleted ? session : null)),
      deleteSession: vi.fn(async () => { isDeleted = true; }),
    } as unknown as CloudServiceDeps;

    const deleteRes = createMockRes();
    await handleSessions(
      createBodyReq('DELETE', `/api/sessions/${sessionId}`, undefined, { 'x-rebel-surface': 'mobile' }),
      deleteRes.res,
      ['api', 'sessions', sessionId],
      deps,
    );
    expect(deleteRes.statusCode()).toBe(200);

    const eventsRes = createMockRes();
    await handleSessions(
      createMockReq(`/api/sessions/${sessionId}/events?sinceSeq=5`),
      eventsRes.res,
      ['api', 'sessions', sessionId, 'events'],
      deps,
    );

    expect(eventsRes.statusCode()).toBe(410);
    expect(eventsRes.body()).toEqual({
      error: 'session-tombstoned',
      tombstone: expect.objectContaining({
        sessionId,
        deletedAt: expect.any(Number),
        deletedBy: 'mobile',
        reason: 'mobile',
        ttlExpiresAt: expect.any(Number),
      }),
    });
  });

  it('drops PUT upserts for tombstoned sessions', async () => {
    const sessionId = 'session-tombstoned';
    const incoming = makeMergeSession({ id: sessionId, title: 'Resurrect me' });
    let deleted = false;
    const upsertSession = vi.fn<(session: AgentSession) => Promise<void>>(async () => {});
    const deps = {
      getSession: vi.fn(async () => (deleted ? null : incoming)),
      deleteSession: vi.fn(async () => { deleted = true; }),
      upsertSession,
    } as unknown as CloudServiceDeps;

    const deleteRes = createMockRes();
    await handleSessions(
      createBodyReq('DELETE', `/api/sessions/${sessionId}`),
      deleteRes.res,
      ['api', 'sessions', sessionId],
      deps,
    );
    expect(deleteRes.statusCode()).toBe(200);

    const putRes = createMockRes();
    await handleSessions(
      createBodyReq('PUT', `/api/sessions/${sessionId}`, incoming, { 'x-rebel-surface': 'desktop' }),
      putRes.res,
      ['api', 'sessions', sessionId],
      deps,
    );

    expect(putRes.statusCode()).toBe(200);
    expect(putRes.body()).toMatchObject({ success: true, tombstoned: true });
    expect(upsertSession).not.toHaveBeenCalled();
  });

  it('filters summary incremental fetches using cloudUpdatedAt when available', async () => {
    const baseSummary = {
      title: 'Summary',
      createdAt: 1000,
      resolvedAt: null,
      doneAt: null,
      starredAt: null,
      deletedAt: null,
      origin: 'manual',
      isCorrupted: false,
      privateMode: false,
      interruptedTurnId: null,
      preview: '',
      firstMessagePreview: '',
      lastMessagePreview: '',
      messageCount: 0,
      hasDraft: false,
      draftPreview: '',
      draftUpdatedAt: null,
      usage: { costUsd: 0, inputTokens: 0, outputTokens: 0, turnCount: 0 },
      activeTurnId: null,
      isBusy: false,
      lastError: null,
      meetingCompanion: null,
    };
    const deps = {
      listSessions: vi.fn(() => [
        { ...baseSummary, id: 'legacy-updatedAt-only', updatedAt: 1200 },
        { ...baseSummary, id: 'server-ordered', updatedAt: 1100, cloudUpdatedAt: 2200 },
      ]),
    } as unknown as CloudServiceDeps;
    const { res, statusCode, body } = createMockRes();

    await handleSessions(
      createMockReq('/api/sessions?summaries=true&modifiedSince=2000'),
      res,
      ['api', 'sessions'],
      deps,
    );

    expect(statusCode()).toBe(200);
    const response = body() as { sessions: Array<{ id: string }>; totalCount: number };
    expect(response.totalCount).toBe(2);
    expect(response.sessions.map((session) => session.id)).toEqual(['server-ordered']);
  });

  it('returns tombstones with since filter and applies per-device rate limit', async () => {
    const deps = {
      deleteSession: vi.fn(async () => {}),
    } as unknown as CloudServiceDeps;

    const deleteRes = createMockRes();
    await handleSessions(
      createBodyReq('DELETE', '/api/sessions/session-a'),
      deleteRes.res,
      ['api', 'sessions', 'session-a'],
      deps,
    );
    expect(deleteRes.statusCode()).toBe(200);

    const firstRes = createMockRes();
    await handleSessions(
      createMockMethodReq('GET', '/api/sessions/tombstones?since=0', { authorization: 'Bearer token-a', 'x-rebel-surface': 'mobile' }),
      firstRes.res,
      ['api', 'sessions', 'tombstones'],
      deps,
    );
    expect(firstRes.statusCode()).toBe(200);
    const firstBody = firstRes.body() as { tombstones: unknown[]; serverNow: number };
    expect(firstBody.tombstones.length).toBe(1);
    expect(typeof firstBody.serverNow).toBe('number');

    const secondRes = createMockRes();
    await handleSessions(
      createMockMethodReq('GET', '/api/sessions/tombstones?since=0', { authorization: 'Bearer token-a', 'x-rebel-surface': 'mobile' }),
      secondRes.res,
      ['api', 'sessions', 'tombstones'],
      deps,
    );
    expect(secondRes.statusCode()).toBe(429);
  });

  it('returns serverNow even when tombstone list is empty', async () => {
    const deps = {} as unknown as CloudServiceDeps;
    const resObj = createMockRes();

    await handleSessions(
      createMockMethodReq('GET', '/api/sessions/tombstones', { authorization: 'Bearer token-b', 'x-rebel-surface': 'desktop' }),
      resObj.res,
      ['api', 'sessions', 'tombstones'],
      deps,
    );

    expect(resObj.statusCode()).toBe(200);
    const body = resObj.body() as { tombstones: unknown[]; serverNow: number };
    expect(body.tombstones).toEqual([]);
    expect(typeof body.serverNow).toBe('number');
  });
});

// ---------------------------------------------------------------------------
// Desktop → Cloud merge
// ---------------------------------------------------------------------------

function makeMergeSession(overrides: Partial<AgentSession> = {}): AgentSession {
  return {
    id: 'session-merge',
    title: 'Desktop title',
    createdAt: 1000,
    updatedAt: 2000,
    messages: [],
    eventsByTurn: {},
    activeTurnId: null,
    isBusy: false,
    lastError: null,
    resolvedAt: null,
    origin: 'manual',
    ...overrides,
  } as AgentSession;
}

function createSeededRandom(seed: number): () => number {
  let current = seed >>> 0;
  return () => {
    current = (current * 1664525 + 1013904223) >>> 0;
    return current / 0x1_0000_0000;
  };
}

function randomInt(rand: () => number, min: number, max: number): number {
  return Math.floor(rand() * (max - min + 1)) + min;
}

async function waitUntil(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error('Timed out waiting for condition');
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function randomMergeSession(seed: number): AgentSession {
  const rand = createSeededRandom(seed);
  const turnCount = randomInt(rand, 0, 3);
  const turnIds = Array.from({ length: turnCount }, (_, index) => `turn-${seed}-${index}`);
  const messages = turnIds.map((turnId, index) => ({
    id: `msg-${seed}-${index}`,
    turnId,
    role: index % 2 === 0 ? 'user' : 'assistant',
    text: `message-${seed}-${index}`,
    createdAt: randomInt(rand, 1_000, 9_000),
  })) as AgentSession['messages'];

  const eventsByTurn = Object.fromEntries(
    turnIds.map((turnId, index) => [
      turnId,
      [{ type: 'status', status: `status-${seed}-${index}`, timestamp: randomInt(rand, 1_000, 9_000) } as never],
    ]),
  );

  // deriveSessionUpdatedAt uses the last message's createdAt after sort-by-createdAt,
  // so use the max message timestamp (post-sort last = max) vs createdAt (1000).
  const maxMsgTs = messages.length > 0 ? Math.max(...messages.map((m) => m.createdAt)) : 0;
  const derivedUpdatedAt = Math.max(maxMsgTs, 1_000); // 1000 = makeMergeSession createdAt

  return makeMergeSession({
    id: 'session-merge',
    title: `Title ${seed}`,
    updatedAt: derivedUpdatedAt,
    cloudUpdatedAt: randomInt(rand, 1_000, 9_000),
    messages,
    eventsByTurn,
    doneAt: rand() > 0.5 ? randomInt(rand, 1_000, 9_000) : null,
    starredAt: rand() > 0.5 ? randomInt(rand, 1_000, 9_000) : null,
    isBusy: false,
    activeTurnId: null,
    // Include optional fields the merge function explicitly sets (even as undefined)
    // so idempotency checks pass with toEqual.
    memoryUpdateStatusByTurn: undefined,
    timeSavedStatusByTurn: undefined,
    compactionBoundaries: undefined,
  });
}

describe('mergeDesktopPushIntoCloud', () => {
  it('preserves cloud in-progress turn when cloud is genuinely busy', () => {
    const now = Date.now();
    const existing = makeMergeSession({
      isBusy: true,
      activeTurnId: 'turn-cloud',
      eventsByTurn: { 'turn-cloud': [{ type: 'status', status: 'Thinking', timestamp: now } as never] },
    });
    const incoming = makeMergeSession({ isBusy: false, activeTurnId: null });
    const merged = mergeDesktopPushIntoCloud(existing, incoming);
    expect(merged.isBusy).toBe(true);
    expect(merged.activeTurnId).toBe('turn-cloud');
    expect(merged.eventsByTurn['turn-cloud']).toEqual(existing.eventsByTurn['turn-cloud']);
  });

  it('clears stale cloud isBusy when isTurnActive returns false for turn with partial events', () => {
    const existing = makeMergeSession({
      isBusy: true,
      activeTurnId: 'turn-cloud',
      eventsByTurn: { 'turn-cloud': [{ type: 'status', status: 'Thinking', timestamp: 10 } as never] },
    });
    const incoming = makeMergeSession({ isBusy: false, activeTurnId: null });
    const isTurnActive = () => false;
    const merged = mergeDesktopPushIntoCloud(existing, incoming, isTurnActive);
    expect(merged.isBusy).toBe(false);
    expect(merged.activeTurnId).toBeNull();
  });

  it('clears stale cloud isBusy when active turn has terminal event', () => {
    const existing = makeMergeSession({
      isBusy: true,
      activeTurnId: 'turn-cloud',
      eventsByTurn: { 'turn-cloud': [{ type: 'result', result: 'done', timestamp: 11 } as never] },
    });
    const incoming = makeMergeSession({ isBusy: false, activeTurnId: null });
    const merged = mergeDesktopPushIntoCloud(existing, incoming);
    expect(merged.isBusy).toBe(false);
    expect(merged.activeTurnId).toBeNull();
  });

  it('clears stale isBusy when activeTurnId has no events in eventsByTurn', () => {
    const existing = makeMergeSession({
      isBusy: true,
      activeTurnId: 'turn-ghost',
      eventsByTurn: {},
    });
    const incoming = makeMergeSession({ isBusy: false, activeTurnId: null });
    const merged = mergeDesktopPushIntoCloud(existing, incoming);
    expect(merged.isBusy).toBe(false);
    expect(merged.activeTurnId).toBeNull();
  });

  it('preserves cloud-only turns that desktop does not have', () => {
    const existing = makeMergeSession({
      messages: [{ id: 'msg-cloud', turnId: 'turn-cloud', role: 'assistant', text: 'Cloud', createdAt: 100 } as never],
      eventsByTurn: { 'turn-cloud': [{ type: 'result', result: 'done', timestamp: 13 } as never] },
    });
    const incoming = makeMergeSession({
      messages: [{ id: 'msg-desktop', turnId: 'turn-desktop', role: 'user', text: 'Desktop', createdAt: 200 } as never],
      eventsByTurn: { 'turn-desktop': [{ type: 'result', result: 'ok', timestamp: 14 } as never] },
    });
    const merged = mergeDesktopPushIntoCloud(existing, incoming);
    expect(merged.messages.map((m) => m.id)).toEqual(['msg-cloud', 'msg-desktop']);
    expect(Object.keys(merged.eventsByTurn).sort()).toEqual(['turn-cloud', 'turn-desktop']);
  });

  it('appends incoming events for shared turns without dropping cloud events', () => {
    const existing = makeMergeSession({
      messages: [{ id: 'msg-1', turnId: 'turn-1', role: 'assistant', text: 'Cloud text', createdAt: 100 } as never],
      eventsByTurn: { 'turn-1': [{ type: 'result', result: 'cloud', timestamp: 15 } as never] },
    });
    const incoming = makeMergeSession({
      messages: [{ id: 'msg-1', turnId: 'turn-1', role: 'assistant', text: 'Desktop text', createdAt: 100 } as never],
      eventsByTurn: { 'turn-1': [{ type: 'result', result: 'desktop', timestamp: 16 } as never] },
    });
    const merged = mergeDesktopPushIntoCloud(existing, incoming);
    expect(merged.messages[0]?.text).toBe('Desktop text');
    expect(merged.eventsByTurn['turn-1']).toEqual([
      { type: 'result', result: 'cloud', timestamp: 15 },
      { type: 'result', result: 'desktop', timestamp: 16 },
    ]);
  });

  it('keeps cloud title when incoming is "New conversation"', () => {
    const existing = makeMergeSession({ title: 'Quarterly planning' });
    const incoming = makeMergeSession({ title: 'New conversation' });
    const merged = mergeDesktopPushIntoCloud(existing, incoming);
    expect(merged.title).toBe('Quarterly planning');
  });

  it('derives updatedAt from content timestamps, not raw field max', () => {
    const existing = makeMergeSession({
      updatedAt: 9000,
      messages: [{ id: 'msg-e', turnId: 'turn-1', role: 'user', text: 'hi', createdAt: 9000 }] as AgentSession['messages'],
      eventsByTurn: { 'turn-1': [] },
    });
    const incoming = makeMergeSession({ updatedAt: 4000 });
    const merged = mergeDesktopPushIntoCloud(existing, incoming);
    expect(merged.updatedAt).toBe(9000);
  });

  it('preserves cloud-only per-turn metadata', () => {
    const existing = makeMergeSession({
      memoryUpdateStatusByTurn: { 'turn-cloud': 'completed' as never },
    });
    const incoming = makeMergeSession({
      memoryUpdateStatusByTurn: { 'turn-desktop': 'completed' as never },
    });
    const merged = mergeDesktopPushIntoCloud(existing, incoming);
    expect(merged.memoryUpdateStatusByTurn).toEqual({
      'turn-desktop': 'completed',
      'turn-cloud': 'completed',
    });
  });

  it('merges activitySummaryByTurn (incoming wins shared, preserves cloud-only and desktop-only)', () => {
    // existing = cloud session, incoming = desktop push.
    const existing = makeMergeSession({
      activitySummaryByTurn: {
        'turn-shared': 'cloud sentence',
        'turn-cloud': 'cloud-only sentence',
      },
    });
    const incoming = makeMergeSession({
      activitySummaryByTurn: {
        'turn-shared': 'desktop sentence',
        'turn-desktop': 'desktop-only sentence',
      },
    });
    const merged = mergeDesktopPushIntoCloud(existing, incoming);
    expect(merged.activitySummaryByTurn).toEqual({
      // Shared turn: incoming (the pushing desktop) wins, matching the sibling maps.
      'turn-shared': 'desktop sentence',
      'turn-desktop': 'desktop-only sentence',
      // Cloud-only turn preserved (else summaries generated on cloud vanish — F2).
      'turn-cloud': 'cloud-only sentence',
    });
  });

  it('keeps cloud-only activitySummaryByTurn when the desktop push omits the map entirely', () => {
    const existing = makeMergeSession({
      activitySummaryByTurn: { 'turn-cloud': 'cloud-only sentence' },
    });
    const incoming = makeMergeSession({}); // no activitySummaryByTurn at all
    const merged = mergeDesktopPushIntoCloud(existing, incoming);
    expect(merged.activitySummaryByTurn).toEqual({ 'turn-cloud': 'cloud-only sentence' });
  });

  it('preserves a cloud summary on a SHARED turn whose key the incoming push lacks (F2 union merge)', () => {
    // The cloud (`existing`) generated the summary for turn-shared. The pushing
    // desktop knows that turn (it has the message + event) but its
    // activitySummaryByTurn lacks the key — the common renderer-snapshot shape.
    // The old mergePerTurnMap treats incoming as authoritative for known turns
    // and DROPS the cloud sentence.
    const sharedMessage = { id: 'msg-1', turnId: 'turn-shared', role: 'assistant', text: 'shared', createdAt: 100 } as never;
    const sharedEvents = { 'turn-shared': [{ type: 'result', result: 'r', timestamp: 10 } as never] };
    const existing = makeMergeSession({
      messages: [sharedMessage],
      eventsByTurn: sharedEvents,
      activitySummaryByTurn: { 'turn-shared': 'cloud summary for shared turn' },
    });
    const incoming = makeMergeSession({
      messages: [sharedMessage],
      eventsByTurn: sharedEvents,
      // Map present but missing turn-shared's key (summary not generated on desktop yet).
      activitySummaryByTurn: {},
    });
    const merged = mergeDesktopPushIntoCloud(existing, incoming);
    // FAILS under old mergePerTurnMap (turn-shared ∈ incomingTurnIds → cloud key skipped).
    expect(merged.activitySummaryByTurn).toEqual({ 'turn-shared': 'cloud summary for shared turn' });
  });

  // F1 (260618 fix-autotitle-cloud-livesync): a stale desktop push with an
  // auto-overwritable title (broader than the exact 'New conversation' default)
  // must NOT clobber a real cloud-generated title, and the cloud's auto-title
  // metadata must travel WITH the kept title.
  it.each([
    ['New Agent Run', []],
    ['Conversation 3', []],
    ['Plan the offsite agenda', [{ id: 'm1', turnId: 't1', role: 'user' as const, text: 'Plan the offsite agenda', createdAt: 1 }]],
  ])(
    'keeps the real cloud title + auto-title metadata when the desktop push title is auto-overwritable (%s)',
    (incomingTitle, messages) => {
      const existing = makeMergeSession({
        title: 'Project Budget Review',
        autoTitleGeneratedAt: 1_700_000_000_000,
        autoTitleTurnCount: 2,
      });
      const incoming = makeMergeSession({ title: incomingTitle, messages: messages as never });
      const merged = mergeDesktopPushIntoCloud(existing, incoming);
      expect(merged.title).toBe('Project Budget Review');
      expect(merged.autoTitleGeneratedAt).toBe(1_700_000_000_000);
      expect(merged.autoTitleTurnCount).toBe(2);
    },
  );

  it('lets a manual desktop rename win over the cloud title (real, non-fallback incoming title)', () => {
    const existing = makeMergeSession({
      title: 'Auto Title',
      autoTitleGeneratedAt: 1_700_000_000_000,
      autoTitleTurnCount: 2,
    });
    const incoming = makeMergeSession({
      title: 'My Custom Name',
      messages: [{ id: 'm1', turnId: 't1', role: 'user', text: 'unrelated', createdAt: 1 }] as never,
    });
    const merged = mergeDesktopPushIntoCloud(existing, incoming);
    expect(merged.title).toBe('My Custom Name');
  });

  it('is idempotent across randomized sessions', () => {
    for (let seed = 1; seed <= 100; seed += 1) {
      const session = randomMergeSession(seed);
      const merged = mergeDesktopPushIntoCloud(session, session, () => false);
      expect(merged).toEqual(session);
    }
  });

  it('is associative across randomized session merges', () => {
    for (let seed = 1; seed <= 60; seed += 1) {
      const a = randomMergeSession(seed * 3);
      const b = randomMergeSession(seed * 3 + 1);
      const c = randomMergeSession(seed * 3 + 2);

      const left = mergeDesktopPushIntoCloud(
        mergeDesktopPushIntoCloud(a, b, () => false),
        c,
        () => false,
      );
      const right = mergeDesktopPushIntoCloud(
        a,
        mergeDesktopPushIntoCloud(b, c, () => false),
        () => false,
      );

      expect(left).toEqual(right);
    }
  });

  it('preserves content-derived clock invariants across randomized merges', () => {
    for (let seed = 1; seed <= 100; seed += 1) {
      const existing = randomMergeSession(seed);
      const incoming = randomMergeSession(seed + 1000);
      const merged = mergeDesktopPushIntoCloud(existing, incoming, () => false);

      // updatedAt is now derived from content timestamps, not max(field values).
      // Invariant: updatedAt >= createdAt, and >= any merged message timestamp.
      expect(merged.updatedAt).toBeGreaterThanOrEqual(incoming.createdAt ?? 0);
      const maxMsgTs = merged.messages.length > 0
        ? Math.max(...merged.messages.map((m) => m.createdAt))
        : 0;
      expect(merged.updatedAt).toBeGreaterThanOrEqual(maxMsgTs);
      expect(merged.cloudUpdatedAt).toBe(existing.cloudUpdatedAt);
    }
  });

});

describe('sessions route PUT handler merge integration', () => {
  function createMockPutReq(url: string, body: unknown, headers?: Record<string, string>): http.IncomingMessage {
    const req = new EventEmitter() as http.IncomingMessage;
    req.method = 'PUT';
    req.url = url;
    req.headers = { host: 'localhost', ...headers };
    process.nextTick(() => {
      req.emit('data', Buffer.from(JSON.stringify(body)));
      req.emit('end');
    });
    return req;
  }

  it('merges when existing session has cloud-only turn', async () => {
    const existing = makeMergeSession({
      id: 'session-1',
      messages: [{ id: 'msg-c', turnId: 'turn-c', role: 'assistant', text: 'Cloud', createdAt: 100 } as never],
      eventsByTurn: { 'turn-c': [{ type: 'result', result: 'ok', timestamp: 1 } as never] },
    });
    const incoming = makeMergeSession({
      id: 'session-1',
      messages: [{ id: 'msg-d', turnId: 'turn-d', role: 'user', text: 'Desktop', createdAt: 200 } as never],
      eventsByTurn: { 'turn-d': [{ type: 'result', result: 'ok', timestamp: 2 } as never] },
    });
    const upsertSession = vi.fn<(session: AgentSession) => Promise<void>>(async () => {});
    const deps = {
      getSession: vi.fn(async () => existing),
      upsertSession,
    } as unknown as CloudServiceDeps;
    const { res, statusCode } = createMockRes();
    await handleSessions(createMockPutReq('/api/sessions/session-1', incoming), res, ['api', 'sessions', 'session-1'], deps);
    expect(statusCode()).toBe(200);
    const saved = upsertSession.mock.calls[0]?.[0] as AgentSession;
    expect(saved.messages).toHaveLength(2);
    expect(Object.keys(saved.eventsByTurn).sort()).toEqual(['turn-c', 'turn-d']);
  });

  it('upserts directly when no existing session', async () => {
    const incoming = makeMergeSession({ id: 'session-new', title: 'Fresh' });
    const upsertSession = vi.fn<(session: AgentSession) => Promise<void>>(async () => {});
    const deps = {
      getSession: vi.fn(async () => null),
      upsertSession,
    } as unknown as CloudServiceDeps;
    const { res, statusCode } = createMockRes();
    await handleSessions(createMockPutReq('/api/sessions/session-new', incoming), res, ['api', 'sessions', 'session-new'], deps);
    expect(statusCode()).toBe(200);
    const saved = upsertSession.mock.calls[0]?.[0] as AgentSession;
    expect(saved.id).toBe('session-new');
    expect(saved.title).toBe('Fresh');
  });

  it('preserves client-supplied updatedAt but overrides cloudUpdatedAt with server-stamped value', async () => {
    const incoming = makeMergeSession({
      id: 'session-stamped',
      title: 'Fresh',
      updatedAt: 9_999_999_999_999,
      cloudUpdatedAt: 9_999_999_999_999,
    });
    const upsertSession = vi.fn<(session: AgentSession) => Promise<void>>(async () => {});
    const deps = {
      getSession: vi.fn(async () => null),
      upsertSession,
    } as unknown as CloudServiceDeps;
    const { res, statusCode } = createMockRes();

    await handleSessions(createMockPutReq('/api/sessions/session-stamped', incoming), res, ['api', 'sessions', 'session-stamped'], deps);

    expect(statusCode()).toBe(200);
    const saved = upsertSession.mock.calls[0]?.[0] as AgentSession;
    // updatedAt is preserved from the client (not overwritten with server Date.now())
    expect(saved.updatedAt).toBe(9_999_999_999_999);
    // cloudUpdatedAt is always server-stamped (never trusts client value)
    expect((saved.cloudUpdatedAt ?? 0)).toBeLessThan(9_999_999_999_999);
  });

  it('returns cloudUpdatedAt in PUT response for non-tombstoned sessions', async () => {
    const incoming = makeMergeSession({ id: 'session-response-contract' });
    const upsertSession = vi.fn<(session: AgentSession) => Promise<void>>(async () => {});
    const deps = {
      getSession: vi.fn(async () => null),
      upsertSession,
    } as unknown as CloudServiceDeps;
    const { res, statusCode, body } = createMockRes();

    await handleSessions(
      createMockPutReq('/api/sessions/session-response-contract', incoming),
      res,
      ['api', 'sessions', 'session-response-contract'],
      deps,
    );

    expect(statusCode()).toBe(200);
    const responseBody = body<{ success: boolean; tombstoned: boolean; cloudUpdatedAt: number }>();
    expect(responseBody).toMatchObject({ success: true, tombstoned: false });
    expect(typeof responseBody.cloudUpdatedAt).toBe('number');
    expect(Number.isFinite(responseBody.cloudUpdatedAt)).toBe(true);
    expect(responseBody.cloudUpdatedAt).toBeGreaterThan(0);
  });

  it('preserves server metadata on stale incoming metadata updates', async () => {
    const existing = makeMergeSession({
      id: 'session-conflict',
      title: 'Server title',
      cloudUpdatedAt: 5_000,
    });
    const incoming = makeMergeSession({
      id: 'session-conflict',
      title: 'Stale client title',
      cloudUpdatedAt: 4_000,
    });

    const upsertSession = vi.fn<(session: AgentSession) => Promise<void>>(async () => {});
    const deps = {
      getSession: vi.fn(async () => existing),
      upsertSession,
    } as unknown as CloudServiceDeps;
    const { res, statusCode } = createMockRes();

    await handleSessions(
      createMockPutReq('/api/sessions/session-conflict', incoming, { 'x-rebel-surface': 'mobile' }),
      res,
      ['api', 'sessions', 'session-conflict'],
      deps,
    );

    expect(statusCode()).toBe(200);
    const saved = upsertSession.mock.calls[0]?.[0] as AgentSession;
    expect(saved.title).toBe('Server title');

    const staleConflictBreadcrumb = capturedBreadcrumbs.find((breadcrumb) => breadcrumb.message === 'stale-metadata');
    expect(staleConflictBreadcrumb).toBeDefined();
    expect(staleConflictBreadcrumb?.data).toMatchObject({
      conflictType: 'stale-metadata',
    });
    expect(broadcastSpy).toHaveBeenCalledWith(
      'cloud:session-conflict',
      expect.objectContaining({
        sessionId: 'session-conflict',
        conflictType: 'stale-metadata',
        fields: ['title'],
        source: 'mobile',
      }),
    );
  });

  it('emits concurrent-edit conflict breadcrumb for rapid cross-surface metadata changes', async () => {
    let currentSession = makeMergeSession({
      id: 'session-concurrent',
      title: 'Original title',
      cloudUpdatedAt: 1_000,
    });
    const upsertSession = vi.fn(async (session: AgentSession) => {
      currentSession = session;
    });
    const deps = {
      getSession: vi.fn(async () => currentSession),
      upsertSession,
    } as unknown as CloudServiceDeps;

    const firstIncoming = makeMergeSession({
      id: 'session-concurrent',
      title: 'Desktop title',
      cloudUpdatedAt: 1_100,
    });
    const firstRes = createMockRes();
    await handleSessions(
      createMockPutReq('/api/sessions/session-concurrent', firstIncoming, { 'x-rebel-surface': 'desktop' }),
      firstRes.res,
      ['api', 'sessions', 'session-concurrent'],
      deps,
    );
    expect(firstRes.statusCode()).toBe(200);

    const secondIncoming = makeMergeSession({
      id: 'session-concurrent',
      title: 'Mobile title',
      cloudUpdatedAt: (currentSession.cloudUpdatedAt ?? 0) + 1,
    });
    const secondRes = createMockRes();
    await handleSessions(
      createMockPutReq('/api/sessions/session-concurrent', secondIncoming, { 'x-rebel-surface': 'mobile' }),
      secondRes.res,
      ['api', 'sessions', 'session-concurrent'],
      deps,
    );
    expect(secondRes.statusCode()).toBe(200);

    const concurrentConflictBreadcrumb = capturedBreadcrumbs.find((breadcrumb) => breadcrumb.message === 'concurrent-edit');
    expect(concurrentConflictBreadcrumb).toBeDefined();
    expect(concurrentConflictBreadcrumb?.data).toMatchObject({
      conflictType: 'concurrent-edit',
    });
    expect(Array.isArray(concurrentConflictBreadcrumb?.data?.fields)).toBe(true);
    expect(broadcastSpy).toHaveBeenCalledWith(
      'cloud:session-conflict',
      expect.objectContaining({
        sessionId: 'session-concurrent',
        conflictType: 'concurrent-edit',
        fields: ['title'],
        source: 'mobile',
      }),
    );
  });

  it('broadcasts conflict before persisting stale metadata updates', async () => {
    const order: string[] = [];
    const existing = makeMergeSession({
      id: 'session-conflict-order',
      title: 'Server title',
      cloudUpdatedAt: 5_000,
    });
    const incoming = makeMergeSession({
      id: 'session-conflict-order',
      title: 'Stale client title',
      cloudUpdatedAt: 4_000,
    });
    const upsertSession = vi.fn<(session: AgentSession) => Promise<void>>(async () => { order.push('upsert'); });
    broadcastSpy.mockImplementation((channel) => {
      if (channel === 'cloud:session-conflict') order.push('conflict-broadcast');
    });
    const deps = {
      getSession: vi.fn(async () => existing),
      upsertSession,
    } as unknown as CloudServiceDeps;
    const { res, statusCode } = createMockRes();

    await handleSessions(
      createMockPutReq('/api/sessions/session-conflict-order', incoming, { 'x-rebel-surface': 'mobile' }),
      res,
      ['api', 'sessions', 'session-conflict-order'],
      deps,
    );

    expect(statusCode()).toBe(200);
    expect(order.indexOf('conflict-broadcast')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('conflict-broadcast')).toBeLessThan(order.indexOf('upsert'));
  });

  it('marks a successful PUT cloud-active before broadcasting session-changed', async () => {
    const order: string[] = [];
    const markSpy = vi.spyOn(continuityRoute, 'markSessionAsCloudActive').mockImplementation(async () => {
      order.push('mark-active');
    });
    broadcastSpy.mockImplementation((channel) => {
      if (channel === 'cloud:session-changed') order.push('session-changed');
    });
    const incoming = makeMergeSession({ id: 'session-mark-order' });
    const deps = {
      getSession: vi.fn(async () => null),
      upsertSession: vi.fn<(session: AgentSession) => Promise<void>>(async () => {}),
    } as unknown as CloudServiceDeps;
    const { res, statusCode } = createMockRes();

    try {
      await handleSessions(
        createMockPutReq('/api/sessions/session-mark-order', incoming),
        res,
        ['api', 'sessions', 'session-mark-order'],
        deps,
      );
    } finally {
      markSpy.mockRestore();
    }

    expect(statusCode()).toBe(200);
    expect(order).toEqual(['mark-active', 'session-changed']);
  });

  it('emits both breadcrumb and diagnostic events for every sink-routed merge breadcrumb path', async () => {
    const tombstonedSessionId = 'session-sink-tombstoned';
    const tombstonedIncoming = makeMergeSession({ id: tombstonedSessionId, title: 'Resurrect me' });
    let tombstonedDeleted = false;
    const tombstonedDeps = {
      getSession: vi.fn(async () => (tombstonedDeleted ? null : tombstonedIncoming)),
      deleteSession: vi.fn(async () => { tombstonedDeleted = true; }),
      upsertSession: vi.fn(async () => {}),
    } as unknown as CloudServiceDeps;

    const deleteRes = createMockRes();
    await handleSessions(
      createMockMethodReq('DELETE', `/api/sessions/${tombstonedSessionId}`),
      deleteRes.res,
      ['api', 'sessions', tombstonedSessionId],
      tombstonedDeps,
    );
    expect(deleteRes.statusCode()).toBe(200);

    capturedBreadcrumbs.length = 0;
    capturedDiagnosticEvents.length = 0;

    const tombstonedPutRes = createMockRes();
    await handleSessions(
      createMockPutReq('/api/sessions/session-sink-tombstoned', tombstonedIncoming, { 'x-rebel-surface': 'desktop' }),
      tombstonedPutRes.res,
      ['api', 'sessions', tombstonedSessionId],
      tombstonedDeps,
    );
    expect(tombstonedPutRes.statusCode()).toBe(200);
    expectContinuityBreadcrumbAndDiagnostic({
      message: 'tombstone-applied',
      reason: 'tombstone-applied',
    });
    expectContinuityBreadcrumbAndDiagnostic({
      message: 'tombstone-race-detected',
      reason: 'tombstone-race-detected',
    });

    const existingStale = makeMergeSession({
      id: 'session-sink-stale',
      title: 'Server title',
      cloudUpdatedAt: 5_000,
    });
    const incomingStale = makeMergeSession({
      id: 'session-sink-stale',
      title: 'Stale client title',
      cloudUpdatedAt: 4_000,
    });
    const staleDeps = {
      getSession: vi.fn(async () => existingStale),
      upsertSession: vi.fn(async () => {}),
    } as unknown as CloudServiceDeps;
    const staleRes = createMockRes();
    await handleSessions(
      createMockPutReq('/api/sessions/session-sink-stale', incomingStale, { 'x-rebel-surface': 'mobile' }),
      staleRes.res,
      ['api', 'sessions', 'session-sink-stale'],
      staleDeps,
    );
    expect(staleRes.statusCode()).toBe(200);
    expectContinuityBreadcrumbAndDiagnostic({
      message: 'stale-metadata',
      reason: 'stale-metadata',
    });

    let currentSession = makeMergeSession({
      id: 'session-sink-concurrent',
      title: 'Original title',
      cloudUpdatedAt: 1_000,
    });
    const concurrentDeps = {
      getSession: vi.fn(async () => currentSession),
      upsertSession: vi.fn(async (session: AgentSession) => {
        currentSession = session;
      }),
    } as unknown as CloudServiceDeps;

    const firstConcurrentRes = createMockRes();
    await handleSessions(
      createMockPutReq(
        '/api/sessions/session-sink-concurrent',
        makeMergeSession({ id: 'session-sink-concurrent', title: 'Desktop title', cloudUpdatedAt: 1_100 }),
        { 'x-rebel-surface': 'desktop' },
      ),
      firstConcurrentRes.res,
      ['api', 'sessions', 'session-sink-concurrent'],
      concurrentDeps,
    );
    expect(firstConcurrentRes.statusCode()).toBe(200);

    const secondConcurrentRes = createMockRes();
    await handleSessions(
      createMockPutReq(
        '/api/sessions/session-sink-concurrent',
        makeMergeSession({
          id: 'session-sink-concurrent',
          title: 'Mobile title',
          cloudUpdatedAt: (currentSession.cloudUpdatedAt ?? 0) + 1,
        }),
        { 'x-rebel-surface': 'mobile' },
      ),
      secondConcurrentRes.res,
      ['api', 'sessions', 'session-sink-concurrent'],
      concurrentDeps,
    );
    expect(secondConcurrentRes.statusCode()).toBe(200);
    expectContinuityBreadcrumbAndDiagnostic({
      message: 'concurrent-edit',
      reason: 'concurrent-edit',
    });
  });

  it('skips drain-completed accounting when a PUT deadlocks on the session mutex', async () => {
    const monitor = getOutboxStallMonitor();
    const drainStartedSpy = vi.spyOn(monitor, 'recordDrainStarted');
    const drainCompletedSpy = vi.spyOn(monitor, 'recordDrainCompleted');
    let releaseFirstUpsert!: () => void;
    const firstUpsertReleased = new Promise<void>((resolve) => { releaseFirstUpsert = resolve; });
    const upsertSession = vi.fn<(session: AgentSession) => Promise<void>>(async () => {
      if (upsertSession.mock.calls.length === 1) {
        await firstUpsertReleased;
      }
    });
    const deps = {
      getSession: vi.fn(async () => null),
      upsertSession,
    } as unknown as CloudServiceDeps;

    const firstRes = createMockRes();
    const firstRequest = handleSessions(
      createMockPutReq('/api/sessions/session-deadlock', makeMergeSession({ id: 'session-deadlock' })),
      firstRes.res,
      ['api', 'sessions', 'session-deadlock'],
      deps,
    );
    await waitUntil(() => upsertSession.mock.calls.length === 1);

    const secondRes = createMockRes();
    await handleSessions(
      createMockPutReq('/api/sessions/session-deadlock', makeMergeSession({ id: 'session-deadlock' })),
      secondRes.res,
      ['api', 'sessions', 'session-deadlock'],
      deps,
    );

    expect(secondRes.statusCode()).toBe(503);
    expect(drainStartedSpy).toHaveBeenCalledTimes(2);
    expect(drainCompletedSpy).not.toHaveBeenCalled();

    releaseFirstUpsert();
    await firstRequest;
    expect(firstRes.statusCode()).toBe(200);
    expect(drainCompletedSpy).toHaveBeenCalledTimes(1);
  });

});
