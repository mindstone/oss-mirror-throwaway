import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let storeData: Record<string, unknown> = {};

vi.mock('@core/storeFactory', () => ({
  createStore: vi.fn(() => ({
    get(_key: string) { return undefined; },
    set(_keyOrObj: string | Record<string, unknown>, _value?: unknown) {},
    has(_key: string) { return false; },
    delete(_key: string) {},
    clear() { storeData = {}; },
    get store() { return storeData; },
    set store(val: Record<string, unknown>) { storeData = val; },
    path: '/mock/conversation-feedback.json',
  })),
}));

const log = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

vi.mock('@core/logger', () => ({
  createScopedLogger: () => log,
  logger: log,
}));

async function importStoreModule() {
  return import('../conversationFeedbackStore');
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DAY_MS = 24 * 60 * 60 * 1000;

describe('conversationFeedbackStore', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-12T10:00:00.000Z'));
    vi.clearAllMocks();
    storeData = {};
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('migrates v1 thumbs-up to a 5-star vote with synthetic comment', async () => {
    storeData = {
      version: 1,
      ratings: [{ sessionId: 'session-1', rating: 'positive', ratedAt: 1111 }],
      dismissals: [],
    };

    const { getConversationFeedback } = await importStoreModule();
    const result = getConversationFeedback('session-1');

    expect(result.dismissedAt).toBeNull();
    expect(result.votes).toHaveLength(1);
    expect(result.votes[0]).toMatchObject({
      voteId: 'legacy-session-1-1111',
      sessionId: 'session-1',
      rating: 5,
      comment: '(migrated from thumbs rating)',
      chips: [],
      ratedAt: 1111,
      includeDiagnostics: false,
    });
  });

  it('migrates v1 thumbs-down to a 1-star vote', async () => {
    storeData = {
      version: 1,
      ratings: [{ sessionId: 'session-1', rating: 'negative', ratedAt: 2222 }],
      dismissals: [],
    };

    const { getConversationFeedback } = await importStoreModule();
    const result = getConversationFeedback('session-1');

    expect(result.votes).toHaveLength(1);
    expect(result.votes[0]).toMatchObject({
      voteId: 'legacy-session-1-2222',
      rating: 1,
      comment: '(migrated from thumbs rating)',
    });
  });

  it('migration is idempotent across re-runs', async () => {
    storeData = {
      version: 1,
      ratings: [{ sessionId: 'session-1', rating: 'positive', ratedAt: 3333 }],
      dismissals: [],
    };

    const firstLoad = await importStoreModule();
    const firstVoteId = firstLoad.getConversationFeedback('session-1').votes[0]?.voteId;

    const secondLoad = await importStoreModule();
    const secondVoteId = secondLoad.getConversationFeedback('session-1').votes[0]?.voteId;

    expect(firstVoteId).toBe('legacy-session-1-3333');
    expect(secondVoteId).toBe('legacy-session-1-3333');
  });

  it('appendConversationVote stores rating, comment, chips, and anchor fields', async () => {
    const { appendConversationVote, getConversationFeedback } = await importStoreModule();
    const now = Date.now();

    const vote = appendConversationVote({
      sessionId: 'session-1',
      rating: 4,
      comment: 'Great structure and sources.',
      chips: ['Saved me time', 'Used the right sources'],
      anchorMessageId: 'message-1',
      anchorTurnId: 'turn-1',
      anchorMessageIndex: 7,
      includeDiagnostics: false,
    });

    expect(vote.voteId).toMatch(UUID_RE);
    expect(vote.ratedAt).toBe(now);
    expect(vote).toMatchObject({
      sessionId: 'session-1',
      rating: 4,
      comment: 'Great structure and sources.',
      chips: ['Saved me time', 'Used the right sources'],
      anchorMessageId: 'message-1',
      anchorTurnId: 'turn-1',
      anchorMessageIndex: 7,
      includeDiagnostics: false,
    });

    const persisted = getConversationFeedback('session-1');
    expect(persisted.votes).toHaveLength(1);
    expect(persisted.votes[0]).toEqual(vote);
  });

  it('appendConversationVote enforces per-session cap of 20', async () => {
    const { appendConversationVote, getConversationFeedback } = await importStoreModule();
    const baseTs = Date.now();

    for (let i = 1; i <= 21; i++) {
      appendConversationVote({
        sessionId: 'session-1',
        rating: 3,
        comment: `vote-${i}`,
        chips: [],
        includeDiagnostics: false,
        ratedAt: baseTs + i,
      });
    }

    const result = getConversationFeedback('session-1');
    expect(result.votes).toHaveLength(20);
    expect(result.votes[0]?.ratedAt).toBe(baseTs + 21);
    expect(result.votes[19]?.ratedAt).toBe(baseTs + 2);
  });

  it('appendConversationVote respects retention (90 days) and global cap (5000 votes)', async () => {
    const now = Date.now();
    const staleTs = now - (91 * DAY_MS);

    const recentVotes = Array.from({ length: 5000 }, (_, idx) => ({
      voteId: `existing-${idx}`,
      sessionId: `session-${idx}`,
      rating: 3 as const,
      comment: `existing-${idx}`,
      chips: [],
      ratedAt: now - idx,
      includeDiagnostics: false,
    }));

    storeData = {
      version: 2,
      votes: [
        {
          voteId: 'stale-vote',
          sessionId: 'stale-session',
          rating: 1,
          comment: 'stale',
          chips: [],
          ratedAt: staleTs,
          includeDiagnostics: false,
        },
        ...recentVotes,
      ],
      dismissals: [{ sessionId: 'stale-session', dismissedAt: staleTs }],
    };

    const { appendConversationVote } = await importStoreModule();
    const newVote = appendConversationVote({
      sessionId: 'new-session',
      rating: 5,
      comment: 'new',
      chips: [],
      includeDiagnostics: false,
    });

    const persisted = storeData as {
      votes: Array<{ voteId: string }>;
      dismissals: Array<{ sessionId: string }>;
    };

    expect(persisted.votes).toHaveLength(5000);
    expect(persisted.votes.some((vote) => vote.voteId === 'stale-vote')).toBe(false);
    expect(persisted.votes.some((vote) => vote.voteId === newVote.voteId)).toBe(true);
    expect(persisted.dismissals).toHaveLength(0);
  });

  it('getConversationFeedback returns votes newest-first', async () => {
    const { appendConversationVote, getConversationFeedback } = await importStoreModule();
    const baseTs = Date.now();

    appendConversationVote({
      sessionId: 'session-1',
      rating: 3,
      comment: 'oldest',
      chips: [],
      includeDiagnostics: false,
      ratedAt: baseTs + 100,
    });
    appendConversationVote({
      sessionId: 'session-1',
      rating: 3,
      comment: 'newest',
      chips: [],
      includeDiagnostics: false,
      ratedAt: baseTs + 300,
    });
    appendConversationVote({
      sessionId: 'session-1',
      rating: 3,
      comment: 'middle',
      chips: [],
      includeDiagnostics: false,
      ratedAt: baseTs + 200,
    });

    const result = getConversationFeedback('session-1');
    expect(result.votes.map((vote) => vote.ratedAt)).toEqual([baseTs + 300, baseTs + 200, baseTs + 100]);
  });

  it('dismissConversationFeedback no-ops when a vote exists for the session', async () => {
    const { appendConversationVote, dismissConversationFeedback, getConversationFeedback } = await importStoreModule();

    appendConversationVote({
      sessionId: 'session-1',
      rating: 4,
      comment: 'Already rated',
      chips: [],
      includeDiagnostics: false,
    });
    dismissConversationFeedback('session-1');

    const result = getConversationFeedback('session-1');
    expect(result.votes).toHaveLength(1);
    expect(result.dismissedAt).toBeNull();
  });

  it('writeBackSentryEventId attaches the eventId to the right vote', async () => {
    const { appendConversationVote, writeBackSentryEventId, getConversationFeedback } = await importStoreModule();

    const vote = appendConversationVote({
      sessionId: 'session-1',
      rating: 2,
      comment: 'Needs work',
      chips: [],
      includeDiagnostics: true,
    });

    writeBackSentryEventId(vote.voteId, 'event-123');

    const result = getConversationFeedback('session-1');
    expect(result.votes).toHaveLength(1);
    expect(result.votes[0]?.sentryEventId).toBe('event-123');
  });
});
