import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentSession, MemoryUpdateStatus } from '@shared/types';
import type { AgentSessionSummary } from '@shared/ipc/schemas/sessions';
import { STALE_TURN_THRESHOLD_MS } from '@core/services/agentTurnReducer/runtime';
import { isBackgroundConversationSession } from '@shared/sessionKind';

const mockSessionMergeLog = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

 
vi.mock('@core/logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@core/logger')>();
  return {
    ...actual,
    createScopedLogger: () => mockSessionMergeLog,
  };
});

import {
  CATCH_UP_DEFAULT_LIMIT,
  CATCH_UP_MAX_LIMIT,
  DEFAULT_SESSION_TITLE,
  buildConflictBreadcrumb,
  commitMergedSession,
  filterActiveOnlySessions,
  filterLeanEventsByTurn,
  getCatchUpEvents,
  getSequencedEventsSince,
  getSessionOrderTimestamp,
  hashSessionId,
  listSessionSummaries,
  mergeDesktopPushIntoCloud,
  parseCatchUpLimit,
  parseClientSeq,
  parseFiniteTimestamp,
  parseSinceSeq,
  processSessionDelete,
  processSessionPut,
  projectSessionForRead,
  resetCloudSessionMergeServiceForTests,
  resolveWriteSourceFromBody,
  runUnderSessionMutexWithTombstoneGate,
  sanitizeIncomingSessionPayload,
  summarizeConflictValue,
  toCloudSummary,
  truncateToolDetail,
  type CloudSessionEffectSink,
  type CloudSessionMergeDeps,
} from '../cloudSessionMergeService';
import {
  getSessionTombstoneStore,
  resetSessionTombstoneStoreForTests,
} from '@core/services/continuity/sessionTombstoneStore';

function makeSession(overrides: Partial<AgentSession> = {}): AgentSession {
  return {
    id: 'session-1',
    title: 'Title',
    createdAt: 1_000,
    updatedAt: 2_000,
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

function makeSummary(overrides: Partial<AgentSessionSummary> = {}): AgentSessionSummary {
  return {
    id: 'session-1',
    title: 'Summary',
    createdAt: 1_000,
    updatedAt: 2_000,
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
    lastActivityAt: null,
    lastError: null,
    meetingCompanion: null,
    ...overrides,
  } as AgentSessionSummary;
}

function makeDeps(overrides: Partial<CloudSessionMergeDeps> = {}): CloudSessionMergeDeps {
  return {
    getSession: vi.fn(async () => null),
    upsertSession: vi.fn(async () => {}),
    deleteSession: vi.fn(async () => {}),
    getActiveTurnController: vi.fn(() => undefined),
    listSessions: vi.fn(() => []),
    readContinuityStateMap: vi.fn(async () => null),
    ...overrides,
  };
}

function makeSink(order: string[] = []): CloudSessionEffectSink {
  return {
    emit: (event) => {
      order.push(`emit:${event.channel}`);
    },
    breadcrumb: (breadcrumb) => {
      order.push(`breadcrumb:${breadcrumb.message}`);
    },
  };
}

const makeImageRef = (assetId: string, byteSize = 123) => ({
  assetId,
  mimeType: 'image/png',
  byteSize,
});

beforeEach(() => {
  vi.clearAllMocks();
  resetSessionTombstoneStoreForTests();
  resetCloudSessionMergeServiceForTests();
});

describe('cloudSessionMergeService validators and sanitizers', () => {
  it('parses sinceSeq with legacy default and invalid guards', () => {
    expect(parseSinceSeq(null)).toBe(0);
    expect(parseSinceSeq('12')).toBe(12);
    expect(parseSinceSeq('-1')).toBeNull();
    expect(parseSinceSeq('1.5')).toBeNull();
    expect(parseSinceSeq('nope')).toBeNull();
  });

  it('parses catch-up limits with default, max clamp, and invalid guards', () => {
    expect(parseCatchUpLimit(null)).toBe(CATCH_UP_DEFAULT_LIMIT);
    expect(parseCatchUpLimit('10')).toBe(10);
    expect(parseCatchUpLimit(String(CATCH_UP_MAX_LIMIT + 100))).toBe(CATCH_UP_MAX_LIMIT);
    expect(parseCatchUpLimit('0')).toBeNull();
    expect(parseCatchUpLimit('1.2')).toBeNull();
  });

  it('parses finite timestamps only', () => {
    expect(parseFiniteTimestamp(123)).toBe(123);
    expect(parseFiniteTimestamp(Number.POSITIVE_INFINITY)).toBeNull();
    expect(parseFiniteTimestamp('123')).toBeNull();
  });

  it('parses client seq as a non-negative integer only', () => {
    expect(parseClientSeq(0)).toBe(0);
    expect(parseClientSeq(42)).toBe(42);
    expect(parseClientSeq(-1)).toBeNull();
    expect(parseClientSeq(1.1)).toBeNull();
  });

  it('hashes session ids deterministically to eight hex characters', () => {
    expect(hashSessionId('session-1')).toMatch(/^[a-f0-9]{8}$/);
    expect(hashSessionId('session-1')).toBe(hashSessionId('session-1'));
  });

  it('summarizes conflict values without leaking raw strings', () => {
    expect(summarizeConflictValue('Secret title')).toBeTypeOf('string');
    expect(summarizeConflictValue('Secret title')).not.toBe('Secret title');
    expect(summarizeConflictValue(['a', 'b'])).toBe('array:2');
    expect(summarizeConflictValue({ a: 1, b: 2 })).toBe('object:2');
    expect(summarizeConflictValue(true)).toBe(true);
  });

  it('sanitizes incoming sessions by forcing id and stripping server-owned fields', () => {
    const sanitized = sanitizeIncomingSessionPayload({
      id: 'wrong',
      title: 'Client',
      cloudUpdatedAt: 5_000,
      upstreamSessionId: 'upstream',
    }, 'session-canonical') as unknown as Record<string, unknown>;

    expect(sanitized.id).toBe('session-canonical');
    expect(sanitized.cloudUpdatedAt).toBeUndefined();
    expect(sanitized.upstreamSessionId).toBeUndefined();
  });

  it('resolves write source from body fields', () => {
    expect(resolveWriteSourceFromBody({ updatedBy: ' Mobile ' })).toBe('mobile');
    expect(resolveWriteSourceFromBody({ deletedBy: ' Desktop ' })).toBe('desktop');
    expect(resolveWriteSourceFromBody({})).toBeNull();
  });
});

describe('cloudSessionMergeService projections', () => {
  it('uses cloudUpdatedAt before updatedAt for ordering', () => {
    expect(getSessionOrderTimestamp({ updatedAt: 1, cloudUpdatedAt: 5 })).toBe(5);
    expect(getSessionOrderTimestamp({ updatedAt: 3 })).toBe(3);
  });

  it('coerces invalid cloud summary origins to manual', () => {
    const summary = toCloudSummary(makeSummary({ origin: 'strange' as never }));
    expect(summary.origin).toBe('manual');
  });

  it('preserves valid cloud summary fields', () => {
    const summary = toCloudSummary(makeSummary({ id: 's2', origin: 'automation', cloudUpdatedAt: 9_000, maxSeq: 10 }));
    expect(summary).toMatchObject({ id: 's2', origin: 'automation', cloudUpdatedAt: 9_000, maxSeq: 10 });
  });

  it('preserves lastActivityAt when present', () => {
    const summary = toCloudSummary(makeSummary({ id: 's3', lastActivityAt: 123_456 }));
    expect(summary.lastActivityAt).toBe(123_456);
  });

  it('filters activeOnly sessions by active state (doneAt) and continuity state map', () => {
    // Active = doneAt null/absent.
    const sessions = [
      { id: 's1', doneAt: null, deletedAt: null },
      { id: 's2', doneAt: null, deletedAt: null },
      { id: 's3', doneAt: 9, deletedAt: null },
    ];
    const filtered = filterActiveOnlySessions(sessions, {
      s1: { state: 'cloud_active' },
      s2: { state: 'local_only' },
    });
    expect(filtered.map((session) => session.id)).toEqual(['s1']);
  });

  it('filters activeOnly sessions to active (doneAt null) non-deleted sessions when no state map exists', () => {
    const filtered = filterActiveOnlySessions([
      { id: 's1', doneAt: null, deletedAt: null }, // active, not deleted → kept
      { id: 's2', doneAt: 5, deletedAt: null },    // done → dropped
      { id: 's3', doneAt: null, deletedAt: 3 },    // active but deleted → dropped
    ], null);
    expect(filtered.map((session) => session.id)).toEqual(['s1']);
  });

  it('excludes background kinds from activeOnly while retaining conversations and automation insights', () => {
    const filtered = filterActiveOnlySessions([
      { id: 'automation-source-capture--abc123', doneAt: null, deletedAt: null },
      { id: 'conversation-abc123', doneAt: null, deletedAt: null },
      { id: 'automation-insight-abc123', doneAt: null, deletedAt: null },
    ], null);

    expect(filtered.map((session) => session.id)).toEqual([
      'conversation-abc123',
      'automation-insight-abc123',
    ]);
  });

  it('matches the desktop active predicate for background-kind exclusion', () => {
    const fixture = [
      { id: 'automation-source-capture--abc123', doneAt: null, deletedAt: null },
      { id: 'meeting-analysis-abc123', doneAt: null, deletedAt: null },
      { id: 'use-case-discovery-abc123', doneAt: null, deletedAt: null },
      { id: 'conversation-abc123', doneAt: null, deletedAt: null },
      { id: 'automation-insight-abc123', doneAt: null, deletedAt: null },
      { id: 'cli-chat-abc123', doneAt: null, deletedAt: null },
      { id: 'done-abc123', doneAt: 5, deletedAt: null },
      { id: 'deleted-abc123', doneAt: null, deletedAt: 7 },
    ];

    const desktopActiveIds = fixture
      .filter(
        (session) =>
          session.doneAt == null &&
          !session.deletedAt &&
          !isBackgroundConversationSession(session.id),
      )
      .map((session) => session.id);
    const cloudActiveIds = filterActiveOnlySessions(fixture, null)
      .map((session) => session.id);

    expect(cloudActiveIds).toEqual(desktopActiveIds);
    expect(cloudActiveIds).toEqual([
      'conversation-abc123',
      'automation-insight-abc123',
      'cli-chat-abc123',
    ]);
  });

  it('projects lean sessions with or without tool events', () => {
    const session = makeSession({
      eventsByTurn: {
        t1: [{ type: 'tool', toolName: 'bash', detail: 'x', stage: 'start', timestamp: 1 } as never],
      },
    });
    expect(projectSessionForRead(session, { lean: false, toolEvents: false })).toBe(session);
    expect(projectSessionForRead(session, { lean: true, toolEvents: false })).not.toHaveProperty('eventsByTurn');
    expect(projectSessionForRead(session, { lean: true, toolEvents: true })).toHaveProperty('eventsByTurn');
  });
});

describe('cloudSessionMergeService lean event filtering', () => {
  it('truncates non-structured tool detail at 500 characters', () => {
    expect(truncateToolDetail('x'.repeat(501))).toHaveLength(500);
  });

  it('keeps structured tool detail up to the structured cap', () => {
    const events = filterLeanEventsByTurn({
      t1: [{ type: 'tool', toolName: 'TodoWrite', detail: 'x'.repeat(900), stage: 'end', timestamp: 1 } as never],
    });
    expect(events.t1?.[0]).toMatchObject({ detail: 'x'.repeat(900) });
  });

  it('carries MCP App UI metadata and toolResult through lean projection', () => {
    const structuredFallback = {
      kind: 'email-draft' as const,
      payload: {
        to: ['person@example.com'],
        cc: [],
        bcc: [],
        subject: 'Hello',
        body: 'Draft body.',
      },
    };
    const toolResult = {
      content: [{ type: 'text', text: 'Draft ready' }],
      structuredContent: { subject: 'Hello' },
    };

    const events = filterLeanEventsByTurn({
      t1: [{
        type: 'tool',
        toolName: 'compose_workspace_email',
        detail: 'Draft ready',
        stage: 'end',
        timestamp: 1,
        toolUseId: 'tu-compose',
        mcpAppUiMeta: {
          resourceUri: 'ui://google-workspace/compose-email',
          presentation: 'primary',
          viewSummary: 'Email draft to person@example.com — subject "Hello".',
          viewRoleLabel: 'Editable email draft',
          structuredFallback,
        },
        toolResult,
      }],
    });

    expect(events.t1?.[0]).toMatchObject({
      type: 'tool',
      toolName: 'compose_workspace_email',
      mcpAppUiMeta: {
        presentation: 'primary',
        viewSummary: 'Email draft to person@example.com — subject "Hello".',
        viewRoleLabel: 'Editable email draft',
        structuredFallback,
      },
      toolResult,
    });
  });

  it('truncates oversized MCP App fallback bodies with a debug breadcrumb', () => {
    const oversizedBody = 'x'.repeat(10_050);
    const events = filterLeanEventsByTurn({
      t1: [{
        type: 'tool',
        toolName: 'compose_workspace_email',
        detail: 'Draft ready',
        stage: 'end',
        timestamp: 1,
        toolUseId: 'tu-compose',
        mcpAppUiMeta: {
          resourceUri: 'ui://google-workspace/compose-email',
          presentation: 'primary',
          viewSummary: 'Email draft to person@example.com — subject "Hello".',
          structuredFallback: {
            kind: 'email-draft',
            payload: {
              to: ['person@example.com'],
              subject: 'Hello',
              body: oversizedBody,
            },
          },
        },
      }],
    });

    const event = events.t1?.[0];
    expect(event?.type).toBe('tool');
    if (event?.type === 'tool' && event.mcpAppUiMeta?.structuredFallback?.kind === 'email-draft') {
      expect(event.mcpAppUiMeta.structuredFallback.payload.body).toHaveLength(10_000);
    }
    expect(mockSessionMergeLog.debug).toHaveBeenCalledWith(
      expect.objectContaining({
        turnId: 't1',
        toolName: 'compose_workspace_email',
        toolUseId: 'tu-compose',
        maxChars: 10_000,
        truncatedFields: ['structuredFallback.payload.body'],
        originalLength: 10_050,
        truncatedLength: 10_000,
        kind: 'email-draft',
      }),
      'Truncated MCP App UI metadata for lean cloud session DTO',
    );
  });

  it('truncates oversized MCP App viewSummary with a debug breadcrumb', () => {
    const oversizedSummary = 's'.repeat(10_050);
    const events = filterLeanEventsByTurn({
      t1: [{
        type: 'tool',
        toolName: 'compose_workspace_email',
        detail: 'Draft ready',
        stage: 'end',
        timestamp: 1,
        toolUseId: 'tu-compose',
        mcpAppUiMeta: {
          resourceUri: 'ui://google-workspace/compose-email',
          presentation: 'primary',
          viewSummary: oversizedSummary,
          structuredFallback: {
            kind: 'plain',
            payload: { markdown: 'Fallback details.' },
          },
        },
      }],
    });

    const event = events.t1?.[0];
    expect(event?.type).toBe('tool');
    if (event?.type === 'tool') {
      expect(event.mcpAppUiMeta?.viewSummary).toHaveLength(10_000);
    }
    expect(mockSessionMergeLog.debug).toHaveBeenCalledWith(
      expect.objectContaining({
        turnId: 't1',
        toolName: 'compose_workspace_email',
        toolUseId: 'tu-compose',
        maxChars: 10_000,
        truncatedFields: ['viewSummary'],
        originalLength: 10_050,
        truncatedLength: 10_000,
        kind: 'plain',
      }),
      'Truncated MCP App UI metadata for lean cloud session DTO',
    );
  });

  it('leaves non-MCP-App tool events unaffected in lean projection', () => {
    const events = filterLeanEventsByTurn({
      t1: [{
        type: 'tool',
        toolName: 'bash',
        detail: 'short output',
        stage: 'end',
        timestamp: 1,
      }],
    });

    expect(events.t1?.[0]).toEqual({
      type: 'tool',
      toolName: 'bash',
      detail: 'short output',
      stage: 'end',
      timestamp: 1,
    });
  });

  it('passes user question events through lean projection', () => {
    const question = { type: 'user_question', batchId: 'b', toolUseId: 'tu', questions: [], timestamp: 2 } as never;
    const answered = { type: 'user_question_answered', batchId: 'b', answers: [], timestamp: 3 } as never;
    const events = filterLeanEventsByTurn({ t1: [question, answered] });
    expect(events.t1?.map((event) => event.type)).toEqual(['user_question', 'user_question_answered']);
  });

  it('drops imageContent when a turn exceeds the image byte cap', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const events = filterLeanEventsByTurn({
        t1: [
          { type: 'tool', toolName: 'capture_screen', detail: 'x', stage: 'end', timestamp: 1, imageContent: [{ type: 'image', data: 'a'.repeat(10 * 1024 * 1024 + 1), mimeType: 'image/png' }] } as never,
        ],
      });
      expect(events.t1?.[0]).not.toHaveProperty('imageContent');
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('[sessions] Dropping imageContent'));
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('preserves imageRef through lean event projection', () => {
    const imageRef = { assetId: 'turn-1-1-0', mimeType: 'image/png', byteSize: 123 };

    const events = filterLeanEventsByTurn({
      t1: [
        {
          type: 'tool',
          toolName: 'capture_screen',
          detail: 'captured',
          stage: 'end',
          timestamp: 1,
          imageRef: [imageRef],
        } as never,
      ],
    });

    expect(events.t1?.[0]).toMatchObject({
      type: 'tool',
      imageRef: [imageRef],
    });
  });

  it('strips base64 from toolResult image blocks when imageRef is present in lean projection', () => {
    const imageRef = { assetId: 'turn-1-1-0', mimeType: 'image/png', byteSize: 123 };

    const events = filterLeanEventsByTurn({
      t1: [
        {
          type: 'tool',
          toolName: 'capture_screen',
          detail: 'captured',
          stage: 'end',
          timestamp: 1,
          imageRef: [imageRef],
          toolResult: {
            content: [
              { type: 'text', text: 'captured' },
              {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: 'image/png',
                  data: 'inline-base64',
                },
              },
            ],
          },
        } as never,
      ],
    });

    expect(events.t1?.[0]).toMatchObject({
      type: 'tool',
      imageRef: [imageRef],
      toolResult: {
        content: [
          { type: 'text', text: 'captured' },
          { type: 'image', imageRef },
        ],
      },
    });
    expect(JSON.stringify(events)).not.toContain('inline-base64');
  });

  it.each([
    {
      label: 'first-null',
      refs: [null, makeImageRef('turn-first-1'), makeImageRef('turn-first-2')],
    },
    {
      label: 'middle-null',
      refs: [makeImageRef('turn-middle-0'), null, makeImageRef('turn-middle-2')],
    },
    {
      label: 'last-null',
      refs: [makeImageRef('turn-last-0'), makeImageRef('turn-last-1'), null],
    },
    {
      label: 'multiple-null',
      refs: [null, makeImageRef('turn-multiple-1'), null, makeImageRef('turn-multiple-3')],
    },
  ])('preserves positional image fallbacks and surviving refs for $label lean projection', ({ refs }) => {
    const events = filterLeanEventsByTurn({
      t1: [
        {
          type: 'tool',
          toolName: 'capture_screen',
          detail: 'captured',
          stage: 'end',
          timestamp: 1,
          imageContent: refs.map((_, index) => ({
            type: 'image',
            data: `inline-${index}`,
            mimeType: 'image/png',
          })),
          imageRef: refs,
          toolResult: {
            content: [
              { type: 'text', text: 'captured' },
              ...refs.map((_, index) => ({
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: 'image/png',
                  data: `inline-${index}`,
                },
              })),
            ],
          },
        } as never,
      ],
    });

    const event = events.t1?.[0];
    expect(event).toMatchObject({
      type: 'tool',
      imageRef: refs,
    });
    if (event?.type === 'tool') {
      expect(event.imageContent).toEqual(refs.map((ref, index) => ({
        type: 'image',
        data: ref ? '' : `inline-${index}`,
        mimeType: 'image/png',
      })));
      expect(event.toolResult?.content).toEqual([
        { type: 'text', text: 'captured' },
        ...refs.map((ref, index) => (
          ref
            ? { type: 'image', imageRef: ref }
            : {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: 'image/png',
                  data: `inline-${index}`,
                },
              }
        )),
      ]);
    }
  });
});

describe('cloudSessionMergeService merge helpers', () => {
  it('preserves cloud-only turns during desktop push merge', () => {
    const existing = makeSession({ eventsByTurn: { cloud: [{ type: 'result', result: 'ok', timestamp: 1 } as never] } });
    const incoming = makeSession({ eventsByTurn: { desktop: [{ type: 'result', result: 'ok', timestamp: 2 } as never] } });
    const merged = mergeDesktopPushIntoCloud(existing, incoming);
    expect(Object.keys(merged.eventsByTurn).sort()).toEqual(['cloud', 'desktop']);
  });

  it('preserves in-progress cloud turn when controller is active', () => {
    const now = Date.now();
    const existing = makeSession({
      isBusy: true,
      activeTurnId: 'cloud',
      eventsByTurn: { cloud: [{ type: 'status', status: 'Thinking', timestamp: now } as never] },
    });
    const merged = mergeDesktopPushIntoCloud(
      existing,
      makeSession({ isBusy: false, activeTurnId: null }),
      () => true,
    );
    expect(merged.isBusy).toBe(true);
    expect(merged.activeTurnId).toBe('cloud');
  });

  it('keeps controller-active turns running even after stale-event silence', () => {
    const staleTimestamp = Date.now() - STALE_TURN_THRESHOLD_MS - 1;
    const existing = makeSession({
      isBusy: true,
      activeTurnId: 'cloud',
      eventsByTurn: { cloud: [{ type: 'status', status: 'Thinking', timestamp: staleTimestamp } as never] },
    });
    const merged = mergeDesktopPushIntoCloud(
      existing,
      makeSession({ isBusy: false, activeTurnId: null }),
      () => true,
    );
    expect(merged.isBusy).toBe(true);
    expect(merged.activeTurnId).toBe('cloud');
  });

  it('prefers terminal events over controller-active stale suppression', () => {
    const existing = makeSession({
      isBusy: true,
      activeTurnId: 'cloud',
      eventsByTurn: { cloud: [{ type: 'result', result: 'done', timestamp: Date.now() } as never] },
    });
    const merged = mergeDesktopPushIntoCloud(
      existing,
      makeSession({ isBusy: false, activeTurnId: null }),
      () => true,
    );
    expect(merged.isBusy).toBe(false);
    expect(merged.activeTurnId).toBeNull();
  });

  it('clears stale busy state when active turn is no longer active', () => {
    const existing = makeSession({ isBusy: true, activeTurnId: 'cloud', eventsByTurn: { cloud: [{ type: 'status', status: 'Thinking', timestamp: Date.now() } as never] } });
    const merged = mergeDesktopPushIntoCloud(existing, makeSession({ isBusy: false, activeTurnId: null }), () => false);
    expect(merged.isBusy).toBe(false);
  });

  it('preserves a non-default cloud title when incoming title is default', () => {
    const merged = mergeDesktopPushIntoCloud(
      makeSession({ title: 'Real title' }),
      makeSession({ title: DEFAULT_SESSION_TITLE }),
    );
    expect(merged.title).toBe('Real title');
  });

  // F1 (260618 fix-autotitle-cloud-livesync): a stale desktop push with a
  // BROADER auto-overwritable title (not just the exact 'New conversation'
  // default) must NOT clobber a real cloud-generated title, and the cloud's
  // paired auto-title metadata must travel WITH the kept title.
  it.each([
    ['New Agent Run', []],
    ['Conversation 3', []],
    // First-message fallback: incoming carries the first user message; its title
    // is the createSessionTitle fallback derived from it.
    ['Plan the offsite agenda', [{ id: 'm1', turnId: 't1', role: 'user' as const, text: 'Plan the offsite agenda', createdAt: 1 }]],
  ])(
    'F1: keeps the real cloud title + auto-title metadata when incoming desktop title is auto-overwritable (%s)',
    (incomingTitle, messages) => {
      const existing = makeSession({
        title: 'Project Budget Review',
        autoTitleGeneratedAt: 1_700_000_000_000,
        autoTitleTurnCount: 2,
      });
      const incoming = makeSession({
        title: incomingTitle,
        messages: messages as never,
      });
      const merged = mergeDesktopPushIntoCloud(existing, incoming);
      expect(merged.title).toBe('Project Budget Review');
      // Metadata must travel with the kept title (was dropped by ...incoming spread).
      expect(merged.autoTitleGeneratedAt).toBe(1_700_000_000_000);
      expect(merged.autoTitleTurnCount).toBe(2);
    },
  );

  it('F1: a manual local (incoming) rename still wins over the cloud title', () => {
    const existing = makeSession({
      title: 'Auto-generated Title',
      autoTitleGeneratedAt: 1_700_000_000_000,
      autoTitleTurnCount: 2,
    });
    // Incoming desktop carries a real, non-fallback title → user renamed locally.
    const incoming = makeSession({
      title: 'My Custom Name',
      messages: [{ id: 'm1', turnId: 't1', role: 'user', text: 'something else entirely', createdAt: 1 }] as never,
    });
    const merged = mergeDesktopPushIntoCloud(existing, incoming);
    expect(merged.title).toBe('My Custom Name');
    // A manual rename clears the auto-title metadata (renderer/metadata-patch
    // policy); the merge must adopt the incoming session's metadata, not strand
    // the cloud's. Since incoming was a fresh makeSession, it has no metadata.
    expect(merged.autoTitleGeneratedAt).toBeUndefined();
    expect(merged.autoTitleTurnCount).toBeUndefined();
  });

  it('F1: adopts the incoming desktop title + ITS metadata when incoming is a real auto-title', () => {
    // Both sides auto-overwritable would keep existing; here incoming is a REAL
    // title with its own fresh metadata, and existing is a default → incoming wins
    // and brings its own metadata.
    const existing = makeSession({ title: DEFAULT_SESSION_TITLE });
    const incoming = makeSession({
      title: 'Desktop-generated Title',
      autoTitleGeneratedAt: 1_700_000_111_111,
      autoTitleTurnCount: 3,
    });
    const merged = mergeDesktopPushIntoCloud(existing, incoming);
    expect(merged.title).toBe('Desktop-generated Title');
    expect(merged.autoTitleGeneratedAt).toBe(1_700_000_111_111);
    expect(merged.autoTitleTurnCount).toBe(3);
  });

  // F1 metadata-coherence (260618 refinement): "metadata travels with the
  // winning title" was implemented as "metadata travels with the side the
  // fallback-vs-real TITLE policy selected." That strands metadata when both
  // sides have the SAME title string but only one side carries the auto-title
  // metadata. The renderer live-title path (applyAutoGeneratedTitle) can produce
  // exactly this shape: a current-session snapshot with the cloud title string
  // but undefined metadata; a later desktop push would then erase the cloud
  // metadata and break future auto-retitle (RETITLE_TURN_THRESHOLD).
  it('F1: equal titles, incoming missing metadata — existing auto-title metadata survives (not stranded)', () => {
    const existing = makeSession({
      title: 'Quarterly Planning',
      autoTitleGeneratedAt: 1_700_000_333_333,
      autoTitleTurnCount: 2,
    });
    // Same real title string, but incoming (desktop) lacks the metadata — the
    // renderer applied the title to current-session state without it.
    const incoming = makeSession({
      title: 'Quarterly Planning',
      autoTitleGeneratedAt: undefined,
      autoTitleTurnCount: undefined,
    });
    const merged = mergeDesktopPushIntoCloud(existing, incoming);
    expect(merged.title).toBe('Quarterly Planning');
    // FAILS under the pre-refinement code: keepExistingTitle is false (incoming
    // title is a real title, so not auto-overwritable) → metadata = incoming's =
    // undefined → existing metadata stranded.
    expect(merged.autoTitleGeneratedAt).toBe(1_700_000_333_333);
    expect(merged.autoTitleTurnCount).toBe(2);
  });

  it('F1: equal titles, only incoming has metadata — incoming metadata is kept', () => {
    // Symmetric case: existing lacks metadata, incoming has it. The metadata that
    // some side has must survive regardless of which way the title policy leans.
    const existing = makeSession({
      title: 'Quarterly Planning',
      autoTitleGeneratedAt: undefined,
      autoTitleTurnCount: undefined,
    });
    const incoming = makeSession({
      title: 'Quarterly Planning',
      autoTitleGeneratedAt: 1_700_000_444_444,
      autoTitleTurnCount: 3,
    });
    const merged = mergeDesktopPushIntoCloud(existing, incoming);
    expect(merged.title).toBe('Quarterly Planning');
    expect(merged.autoTitleGeneratedAt).toBe(1_700_000_444_444);
    expect(merged.autoTitleTurnCount).toBe(3);
  });

  it('preserves cloud-side inbound-trigger origin when desktop push defaults to manual', () => {
    const existing = makeSession({ origin: 'inbound-trigger' });
    const incoming = makeSession({ origin: 'manual' });
    const merged = mergeDesktopPushIntoCloud(existing, incoming);
    expect(merged.origin).toBe('inbound-trigger');
  });

  it('lets desktop push override origin when it carries a meaningful (non-manual) value', () => {
    const existing = makeSession({ origin: 'manual' });
    const incoming = makeSession({ origin: 'automation' });
    const merged = mergeDesktopPushIntoCloud(existing, incoming);
    expect(merged.origin).toBe('automation');
  });

  // 260619: memoryUpdateStatusByTurn is now async/sparse + cloud-produced, so a
  // desktop push must not drop the cloud's status for a turn it merely lacks the
  // key for, and a terminal status must beat a stale running on conflict.
  it('memory status: preserves a cloud terminal status for a turn the incoming push knows but lacks the key (was dropped by authoritative-absence)', () => {
    const cloudSuccess: MemoryUpdateStatus = {
      originalTurnId: 'turn-x', originalSessionId: 'sess', status: 'success', timestamp: 2,
    };
    const existing = makeSession({ memoryUpdateStatusByTurn: { 'turn-x': cloudSuccess } });
    // Incoming KNOWS turn-x (carries its message) but has no status key for it.
    const incoming = makeSession({
      messages: [{ id: 'm1', turnId: 'turn-x', role: 'user', text: 'hi', createdAt: 1 }] as never,
      memoryUpdateStatusByTurn: {},
    });
    const merged = mergeDesktopPushIntoCloud(existing, incoming);
    // FAILS under old mergePerTurnMap(incoming, existing, incomingTurnIds): turn-x ∈
    // incomingTurnIds → existing's success skipped → dropped.
    expect(merged.memoryUpdateStatusByTurn?.['turn-x']).toEqual(cloudSuccess);
  });

  it('memory status: a terminal status beats a stale running on same-turn conflict', () => {
    const existing = makeSession({
      memoryUpdateStatusByTurn: {
        'turn-x': { originalTurnId: 'turn-x', originalSessionId: 'sess', status: 'success', timestamp: 2 },
      },
    });
    const incoming = makeSession({
      memoryUpdateStatusByTurn: {
        'turn-x': { originalTurnId: 'turn-x', originalSessionId: 'sess', status: 'running', timestamp: 1 },
      },
    });
    const merged = mergeDesktopPushIntoCloud(existing, incoming);
    expect(merged.memoryUpdateStatusByTurn?.['turn-x'].status).toBe('success');
  });

  it('returns sequenced events sorted by seq then timestamp', () => {
    const session = makeSession({
      eventsByTurn: {
        t1: [
          { type: 'status', status: 'b', seq: 3, timestamp: 5 } as never,
          { type: 'status', status: 'a', seq: 2, timestamp: 10 } as never,
          { type: 'status', status: 'old', seq: 1, timestamp: 1 } as never,
        ],
      },
    });
    const result = getSequencedEventsSince(session, 1);
    expect(result.events.map((event) => event.seq)).toEqual([2, 3]);
    expect(result.serverSeq).toBe(3);
  });
});

describe('cloudSessionMergeService orchestrators', () => {
  it('persists a new session and returns cloudUpdatedAt', async () => {
    const upsertSession = vi.fn(async () => {});
    const deps = makeDeps({ upsertSession });
    const outcome = await processSessionPut(deps, {
      sessionId: 'session-new',
      incomingRaw: makeSession({ id: 'session-new' }) as unknown as Record<string, unknown>,
      source: 'desktop',
      surface: 'desktop',
      sink: makeSink(),
    });

    expect(outcome.kind).toBe('persisted');
    expect(upsertSession).toHaveBeenCalledTimes(1);
    if (outcome.kind === 'persisted') expect(outcome.cloudUpdatedAt).toBeGreaterThan(0);
  });

  it('returns tombstoned PUT outcome with race metadata and no upsert', async () => {
    const deletedAt = Date.now();
    getSessionTombstoneStore().addTombstone('session-deleted', 'mobile', deletedAt);
    const upsertSession = vi.fn(async () => {});
    const order: string[] = [];
    const outcome = await processSessionPut(makeDeps({ upsertSession }), {
      sessionId: 'session-deleted',
      incomingRaw: makeSession({ id: 'session-deleted' }) as unknown as Record<string, unknown>,
      source: 'desktop',
      surface: 'desktop',
      sink: makeSink(order),
    });

    expect(outcome).toMatchObject({
      kind: 'tombstoned',
      raceDetected: true,
      tombstone: { sessionId: 'session-deleted', deletedAt, deletedBy: 'mobile' },
      direction: 'desktop-push-rejected',
    });
    expect(order).toEqual(['breadcrumb:tombstone-applied', 'breadcrumb:tombstone-race-detected']);
    expect(upsertSession).not.toHaveBeenCalled();
  });

  it('composes mutex gate and commit helper for the PUT happy path', async () => {
    const upsertSession = vi.fn<(session: AgentSession) => Promise<void>>(async () => {});
    const deps = makeDeps({ upsertSession });
    const session = makeSession({
      id: 'session-helper',
      updatedAt: 0,
      cloudUpdatedAt: 123,
      eventsByTurn: {
        'turn-1': [{ type: 'status', message: 'queued', timestamp: 10 } as never],
      },
    });

    const outcome = await runUnderSessionMutexWithTombstoneGate('session-helper', {
      surface: 'desktop',
      sink: makeSink(),
      label: 'test.helper-put',
    }, async () => {
      const stamped = await commitMergedSession(deps, { session });
      return { kind: 'persisted' as const, cloudUpdatedAt: stamped.cloudUpdatedAt, changedFields: [] };
    });

    expect(outcome.kind).toBe('persisted');
    expect(upsertSession).toHaveBeenCalledTimes(1);
    const persisted = upsertSession.mock.calls[0]?.[0];
    expect(persisted).toBeDefined();
    if (!persisted) throw new Error('Expected committed session');
    expect(persisted.cloudUpdatedAt).toBeGreaterThan(123);
    expect(persisted.updatedAt).toBeGreaterThan(0);
    expect(persisted.eventsByTurn['turn-1']?.[0]?.seq).toBe(1);
  });

  it('composes mutex gate and commit helper for the tombstone path', async () => {
    const deletedAt = Date.now();
    getSessionTombstoneStore().addTombstone('session-helper-deleted', 'cloud', deletedAt);
    const upsertSession = vi.fn(async () => {});
    const order: string[] = [];

    const outcome = await runUnderSessionMutexWithTombstoneGate('session-helper-deleted', {
      surface: 'mobile',
      sink: makeSink(order),
      label: 'test.helper-tombstone',
    }, async () => {
      const stamped = await commitMergedSession(makeDeps({ upsertSession }), {
        session: makeSession({ id: 'session-helper-deleted' }),
      });
      return { kind: 'persisted' as const, cloudUpdatedAt: stamped.cloudUpdatedAt, changedFields: [] };
    });

    expect(outcome).toMatchObject({
      kind: 'tombstoned',
      raceDetected: true,
      tombstone: { sessionId: 'session-helper-deleted', deletedAt, deletedBy: 'cloud' },
      direction: 'mobile-write-rejected',
    });
    expect(order).toEqual(['breadcrumb:tombstone-applied', 'breadcrumb:tombstone-race-detected']);
    expect(upsertSession).not.toHaveBeenCalled();
  });

  it('sinks stale conflict broadcast before upsert', async () => {
    const order: string[] = [];
    const upsertSession = vi.fn(async () => { order.push('upsert'); });
    const existing = makeSession({ id: 'session-conflict', title: 'Server title', cloudUpdatedAt: 5_000 });
    const incoming = makeSession({ id: 'session-conflict', title: 'Client title', cloudUpdatedAt: 4_000 });
    const outcome = await processSessionPut(makeDeps({ getSession: vi.fn(async () => existing), upsertSession }), {
      sessionId: 'session-conflict',
      incomingRaw: incoming as unknown as Record<string, unknown>,
      source: 'mobile',
      surface: 'mobile',
      sink: makeSink(order),
    });

    expect(outcome.kind).toBe('persisted');
    expect(order.indexOf('emit:cloud:session-conflict')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('emit:cloud:session-conflict')).toBeLessThan(order.indexOf('upsert'));
  });

  it('reports lifecycle-done-cleared-by-cloud-merge when a PUT clears a local Done (resurrection observability)', async () => {
    const order: string[] = [];
    // Existing is Done; a newer incoming PUT from mobile carries it as Active.
    const existing = makeSession({ id: 'session-1', doneAt: 5_000, cloudUpdatedAt: 4_000 });
    const incoming = makeSession({ id: 'session-1', doneAt: null, cloudUpdatedAt: 6_000 });
    const outcome = await processSessionPut(makeDeps({ getSession: vi.fn(async () => existing) }), {
      sessionId: 'session-1',
      incomingRaw: incoming as unknown as Record<string, unknown>,
      source: 'mobile',
      surface: 'mobile',
      sink: makeSink(order),
    });
    expect(outcome.kind).toBe('persisted');
    expect(order).toContain('breadcrumb:lifecycle-done-cleared-by-cloud-merge');
  });

  it('sinks concurrent conflict after rapid cross-source edits', async () => {
    let current = makeSession({ id: 'session-concurrent', title: 'Original', cloudUpdatedAt: 1_000 });
    const deps = makeDeps({
      getSession: vi.fn(async () => current),
      upsertSession: vi.fn(async (session) => { current = session; }),
    });
    await processSessionPut(deps, {
      sessionId: 'session-concurrent',
      incomingRaw: makeSession({ id: 'session-concurrent', title: 'Desktop', cloudUpdatedAt: 1_001 }) as unknown as Record<string, unknown>,
      source: 'desktop',
      surface: 'desktop',
      sink: makeSink(),
    });
    const order: string[] = [];
    await processSessionPut(deps, {
      sessionId: 'session-concurrent',
      incomingRaw: makeSession({ id: 'session-concurrent', title: 'Mobile', cloudUpdatedAt: (current.cloudUpdatedAt ?? 0) + 1 }) as unknown as Record<string, unknown>,
      source: 'mobile',
      surface: 'mobile',
      sink: makeSink(order),
    });
    expect(order).toContain('emit:cloud:session-conflict');
  });

  it('deletes sessions and returns a tombstone', async () => {
    const deleteSession = vi.fn(async () => {});
    const outcome = await processSessionDelete(makeDeps({ deleteSession }), { sessionId: 'session-delete', deletedBy: 'cloud' });
    expect(deleteSession).toHaveBeenCalledWith('session-delete', { intent: 'user-delete' });
    expect(outcome.tombstone).toMatchObject({ sessionId: 'session-delete', deletedBy: 'cloud' });
  });

  it('returns tombstone from catch-up events', async () => {
    getSessionTombstoneStore().addTombstone('session-catchup', 'desktop', Date.now());
    const outcome = await getCatchUpEvents(makeDeps(), { sessionId: 'session-catchup', sinceSeq: 0, limit: 10 });
    expect(outcome).toMatchObject({ kind: 'tombstoned', tombstone: { sessionId: 'session-catchup' } });
  });

  it('pages catch-up events and reports hasMore', async () => {
    const session = makeSession({
      eventsByTurn: {
        t1: [
          { type: 'status', status: '1', seq: 1, timestamp: 1 } as never,
          { type: 'status', status: '2', seq: 2, timestamp: 2 } as never,
        ],
      },
    });
    const outcome = await getCatchUpEvents(makeDeps({ getSession: vi.fn(async () => session) }), { sessionId: 'session-1', sinceSeq: 0, limit: 1 });
    expect(outcome).toMatchObject({ kind: 'events', hasMore: true, serverSeq: 2 });
    if (outcome.kind === 'events') expect(outcome.events).toHaveLength(1);
  });

  it('lists summaries with activeOnly state-map filtering and modifiedSince', async () => {
    const deps = makeDeps({
      listSessions: vi.fn(() => [
        makeSummary({ id: 's1', doneAt: null, updatedAt: 1_000, cloudUpdatedAt: 3_000 }),
        makeSummary({ id: 's2', doneAt: null, updatedAt: 1_000, cloudUpdatedAt: 1_500 }),
      ]),
      readContinuityStateMap: vi.fn(async () => ({ s1: { state: 'cloud_active' as const }, s2: { state: 'cloud_active' as const } })),
    });
    const outcome = await listSessionSummaries(deps, { activeOnly: true, modifiedSince: 2_000 });
    expect(outcome.totalCount).toBe(2);
    expect(outcome.sessions.map((session) => session.id)).toEqual(['s1']);
  });

  it('F4 (260617): DROPS summaries with a missing/non-string id (does not propagate no-id rows)', async () => {
    const deps = makeDeps({
      listSessions: vi.fn(() => [
        makeSummary({ id: 's1', doneAt: null, updatedAt: 1_000 }),
        // A malformed row with no id — must be dropped, not preserved.
        makeSummary({ id: undefined as unknown as string, doneAt: null, updatedAt: 1_000 }),
      ]),
    });
    const outcome = await listSessionSummaries(deps, { activeOnly: false, modifiedSince: null });
    expect(outcome.totalCount).toBe(1);
    expect(outcome.sessions.map((session) => session.id)).toEqual(['s1']);
    expect(outcome.sessions.every((s) => typeof s.id === 'string' && s.id.length > 0)).toBe(true);
  });

  it('serializes same-session PUT orchestration through the mutex', async () => {
    let active = false;
    let overlapped = false;
    const upsertSession = vi.fn(async () => {
      if (active) overlapped = true;
      active = true;
      await new Promise((resolve) => setTimeout(resolve, 5));
      active = false;
    });
    const deps = makeDeps({ upsertSession });
    await Promise.all([
      processSessionPut(deps, { sessionId: 'session-serial', incomingRaw: makeSession({ id: 'session-serial' }) as unknown as Record<string, unknown>, source: 'desktop', surface: 'desktop', sink: makeSink() }),
      processSessionPut(deps, { sessionId: 'session-serial', incomingRaw: makeSession({ id: 'session-serial' }) as unknown as Record<string, unknown>, source: 'mobile', surface: 'mobile', sink: makeSink() }),
    ]);
    expect(overlapped).toBe(false);
    expect(upsertSession).toHaveBeenCalledTimes(2);
  });

  it('builds conflict breadcrumbs and broadcast payloads as data-only effects', () => {
    const built = buildConflictBreadcrumb({
      conflictType: 'stale-metadata',
      sessionId: 'session-effect',
      fields: ['title'],
      source: 'mobile',
    });
    expect(built.breadcrumb.message).toBe('stale-metadata');
    expect(built.broadcast).toMatchObject({
      channel: 'cloud:session-conflict',
      payload: { sessionId: 'session-effect', conflictType: 'stale-metadata', fields: ['title'], source: 'mobile' },
    });
  });
});

describe('Stage 0.C tiebreaker on processSessionPut', () => {
  function makeRecordingSink(): {
    sink: CloudSessionEffectSink;
    breadcrumbs: Array<{ message: string; data?: Record<string, unknown> }>;
  } {
    const breadcrumbs: Array<{ message: string; data?: Record<string, unknown> }> = [];
    return {
      breadcrumbs,
      sink: {
        emit: vi.fn(),
        breadcrumb: (breadcrumb) => {
          breadcrumbs.push({ message: breadcrumb.message, data: breadcrumb.data });
        },
      },
    };
  }

  it('emits a surface-tiebreaker breadcrumb when desktop races mobile within 100ms on title', async () => {
    let current = makeSession({ id: 'session-pt', title: 'Original', cloudUpdatedAt: 1_000 });
    const deps = makeDeps({
      getSession: vi.fn(async () => current),
      upsertSession: vi.fn(async (session: AgentSession) => { current = session; }),
    });

    await processSessionPut(deps, {
      sessionId: 'session-pt',
      incomingRaw: makeSession({ id: 'session-pt', title: 'Desktop', cloudUpdatedAt: 1_001 }) as unknown as Record<string, unknown>,
      source: 'desktop',
      surface: 'desktop',
      sink: makeRecordingSink().sink,
    });

    const r = makeRecordingSink();
    await processSessionPut(deps, {
      sessionId: 'session-pt',
      incomingRaw: makeSession({
        id: 'session-pt',
        title: 'Mobile',
        cloudUpdatedAt: (current.cloudUpdatedAt ?? 0) + 1,
      }) as unknown as Record<string, unknown>,
      source: 'mobile',
      surface: 'mobile',
      sink: r.sink,
    });

    // Desktop value preserved
    expect(current.title).toBe('Desktop');
    // surface-tiebreaker breadcrumb fired
    const tb = r.breadcrumbs.filter((b) => b.message === 'surface-tiebreaker');
    expect(tb).toHaveLength(1);
    expect(tb[0]?.data).toMatchObject({
      conflictType: 'surface-tiebreaker',
      winnerSurface: 'desktop',
      loserSurface: 'mobile',
      fieldName: 'title',
      raceWindowMs: 100,
    });
  });

  it('does NOT emit a surface-tiebreaker breadcrumb when the prior write is outside the 100ms window', async () => {
    let current = makeSession({ id: 'session-po', title: 'Original', cloudUpdatedAt: 1_000 });
    const deps = makeDeps({
      getSession: vi.fn(async () => current),
      upsertSession: vi.fn(async (session: AgentSession) => { current = session; }),
    });

    await processSessionPut(deps, {
      sessionId: 'session-po',
      incomingRaw: makeSession({ id: 'session-po', title: 'Desktop', cloudUpdatedAt: 1_001 }) as unknown as Record<string, unknown>,
      source: 'desktop',
      surface: 'desktop',
      sink: makeRecordingSink().sink,
    });

    await new Promise((resolve) => setTimeout(resolve, 120));

    const r = makeRecordingSink();
    await processSessionPut(deps, {
      sessionId: 'session-po',
      incomingRaw: makeSession({
        id: 'session-po',
        title: 'Mobile',
        cloudUpdatedAt: (current.cloudUpdatedAt ?? 0) + 1,
      }) as unknown as Record<string, unknown>,
      source: 'mobile',
      surface: 'mobile',
      sink: r.sink,
    });

    // Outside the 100ms window: tiebreaker did not fire, mobile value won via normal flow.
    expect(current.title).toBe('Mobile');
    expect(r.breadcrumbs.filter((b) => b.message === 'surface-tiebreaker')).toHaveLength(0);
    // But the concurrent-edit breadcrumb still fires (within the 10s window).
    expect(r.breadcrumbs.some((b) => b.message === 'concurrent-edit')).toBe(true);
  });

  it('does NOT emit a surface-tiebreaker breadcrumb when both racing writers are desktop', async () => {
    let current = makeSession({ id: 'session-dd', title: 'Original', cloudUpdatedAt: 1_000 });
    const deps = makeDeps({
      getSession: vi.fn(async () => current),
      upsertSession: vi.fn(async (session: AgentSession) => { current = session; }),
    });

    await processSessionPut(deps, {
      sessionId: 'session-dd',
      incomingRaw: makeSession({ id: 'session-dd', title: 'Desktop A', cloudUpdatedAt: 1_001 }) as unknown as Record<string, unknown>,
      source: 'desktop',
      surface: 'desktop',
      sink: makeRecordingSink().sink,
    });

    const r = makeRecordingSink();
    await processSessionPut(deps, {
      sessionId: 'session-dd',
      incomingRaw: makeSession({
        id: 'session-dd',
        title: 'Desktop B',
        cloudUpdatedAt: (current.cloudUpdatedAt ?? 0) + 1,
      }) as unknown as Record<string, unknown>,
      source: 'desktop-other',
      surface: 'desktop',
      sink: r.sink,
    });

    // No surface-tiebreaker breadcrumb (both writers are desktop)
    expect(r.breadcrumbs.filter((b) => b.message === 'surface-tiebreaker')).toHaveLength(0);
  });
});
