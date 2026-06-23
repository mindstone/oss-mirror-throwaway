/**
 * Tests for the time-saved backfill service: candidate selection and the
 * bounded run loop.
 *
 * Uses an in-memory `BackfillSessionSource` to keep the test self-contained.
 * The estimator is stubbed via the `recoverFn` injection so we can assert the
 * service's behaviour around dedup, cutoff filtering, kind filtering, bounded
 * runs, and outcome aggregation without touching the BTS client or the LLM.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentSession, AgentSessionSummary, TimeSavedEstimate } from '@shared/types';
import { initTestPlatformConfig } from '../../__tests__/testHelpers';

const isoToMs = (iso: string) => new Date(iso).getTime();
const TIME_SAVED_CUTOFF = isoToMs('2026-04-14T22:51:48.000Z');

function summaryFor(id: string, opts: { deletedAt?: number; updatedAt?: number } = {}): AgentSessionSummary {
  return {
    id,
    title: `session-${id}`,
    createdAt: isoToMs('2026-04-01T10:00:00.000Z'),
    updatedAt: opts.updatedAt ?? isoToMs('2026-05-01T10:00:00.000Z'),
    resolvedAt: null,
    doneAt: null,
    starredAt: null,
    deletedAt: opts.deletedAt ?? null,
    origin: 'manual',
    isCorrupted: false,
    preview: '',
    messageCount: 2,
    hasDraft: false,
    draftPreview: null,
    draftUpdatedAt: null,
    usage: {
      totalToolCalls: 0,
      failedToolCalls: 0,
      filesCreated: 0,
      filesEdited: 0,
      totalToolOutputChars: 0,
      mcpToolOutputChars: 0,
      builtinToolOutputChars: 0,
      mcpServerUsage: {},
      toolUsageByCategory: {},
      totalCostUsd: null,
    } as unknown as AgentSessionSummary['usage'],
    activeTurnId: null,
    isBusy: false,
    lastError: null,
  } satisfies AgentSessionSummary;
}

interface SimpleTurnSpec {
  turnId: string;
  userText?: string;
  resultText?: string;
  userAt: number;
  durationSec?: number;
  toolEvents?: number;
}

function sessionFor(id: string, turns: SimpleTurnSpec[], opts: { deletedAt?: number } = {}): AgentSession {
  const messages = turns.flatMap((turn) => {
    const userAt = turn.userAt;
    const durationMs = (turn.durationSec ?? 60) * 1000;
    return [
      {
        id: `${turn.turnId}-u`,
        turnId: turn.turnId,
        role: 'user' as const,
        text: turn.userText ?? 'do the thing please',
        createdAt: userAt,
      },
      {
        id: `${turn.turnId}-r`,
        turnId: turn.turnId,
        role: 'result' as const,
        text: turn.resultText ?? 'done. here is the deliverable.',
        createdAt: userAt + durationMs,
      },
    ];
  });
  const eventsByTurn: AgentSession['eventsByTurn'] = {};
  for (const turn of turns) {
    const events = [] as AgentSession['eventsByTurn'][string];
    const userAt = turn.userAt;
    for (let i = 0; i < (turn.toolEvents ?? 0); i += 1) {
      events.push({
        type: 'tool',
        toolName: 'tool',
        detail: '',
        stage: 'start',
        timestamp: userAt + i * 1000,
      } as unknown as AgentSession['eventsByTurn'][string][number]);
    }
    eventsByTurn[turn.turnId] = events;
  }
  return {
    id,
    title: `session-${id}`,
    createdAt: messages[0]?.createdAt ?? Date.now(),
    updatedAt: messages.at(-1)?.createdAt ?? Date.now(),
    messages,
    eventsByTurn,
    activeTurnId: null,
    isBusy: false,
    lastError: null,
    resolvedAt: null,
    deletedAt: opts.deletedAt ?? null,
  } as AgentSession;
}

const estimate = (overrides: Partial<TimeSavedEstimate> = {}): TimeSavedEstimate => ({
  lowMinutes: 12,
  highMinutes: 18,
  confidence: 'medium',
  taskType: 'writing',
  reasoning: 'Drafted a customer update.',
  reasoningDetail: 'Manual drafting + edits.',
  impact: 'medium',
  ...overrides,
});

describe('timeSavedBackfillService — scan', () => {
  beforeEach(async () => {
    vi.resetModules();
    await initTestPlatformConfig();
  });

  it('selects post-cutoff conversation turns and excludes deleted / skipped-kind / short / pre-cutoff turns', async () => {
    const summaries = [
      summaryFor('conv-include'),
      summaryFor('conv-deleted', { deletedAt: isoToMs('2026-04-30T10:00:00.000Z') }),
      summaryFor('automation-foo'), // shouldSkipTimeSaved kind
      summaryFor('memory-update-bar'), // shouldSkipTimeSaved kind
      summaryFor('conv-mix'),
    ];
    const sessions: Record<string, AgentSession> = {
      'conv-include': sessionFor('conv-include', [
        // Post-cutoff, long-enough — included.
        { turnId: 'turn-A', userAt: isoToMs('2026-04-18T10:00:00.000Z'), durationSec: 120 },
      ]),
      'conv-deleted': sessionFor('conv-deleted', [
        { turnId: 'turn-deleted', userAt: isoToMs('2026-04-25T10:00:00.000Z'), durationSec: 120 },
      ], { deletedAt: isoToMs('2026-04-30T10:00:00.000Z') }),
      'automation-foo': sessionFor('automation-foo', [
        { turnId: 'turn-automation', userAt: isoToMs('2026-04-25T10:00:00.000Z'), durationSec: 120 },
      ]),
      'memory-update-bar': sessionFor('memory-update-bar', [
        { turnId: 'turn-memory', userAt: isoToMs('2026-04-25T10:00:00.000Z'), durationSec: 120 },
      ]),
      'conv-mix': sessionFor('conv-mix', [
        // Short turn — excluded.
        { turnId: 'turn-short', userAt: isoToMs('2026-04-20T10:00:00.000Z'), durationSec: 10 },
        // Pre-cutoff — excluded.
        { turnId: 'turn-precutoff', userAt: isoToMs('2026-04-10T10:00:00.000Z'), durationSec: 120 },
        // No result text — excluded by no-context.
        { turnId: 'turn-empty', userAt: isoToMs('2026-04-21T10:00:00.000Z'), durationSec: 120, resultText: '' },
        // Good candidate — included.
        { turnId: 'turn-B', userAt: isoToMs('2026-04-22T10:00:00.000Z'), durationSec: 90 },
      ]),
    };

    const sessionSource = {
      listSessionSummaries: () => summaries,
      getSession: async (id: string) => sessions[id] ?? null,
    };

    const backfill = await import('../timeSavedBackfillService');
    const result = await backfill.scanTimeSavedBackfillCandidates({
      cutoffMs: TIME_SAVED_CUTOFF,
      sessionSource,
    });

    expect(result.candidates.map((c) => c.turnId).sort()).toEqual(['turn-A', 'turn-B']);
    expect(result.counts.sessionsScanned).toBe(5);
    expect(result.counts.sessionsSkippedDeleted).toBe(1);
    expect(result.counts.sessionsSkippedKind).toBe(2);
    expect(result.counts.turnsSkippedShort).toBe(1);
    expect(result.counts.turnsSkippedBeforeCutoff).toBe(1);
    expect(result.counts.turnsSkippedNoContext).toBe(1);
    expect(result.counts.candidates).toBe(2);
  });

  it('prefilters sessions whose summary updatedAt is older than the cutoff margin without loading them', async () => {
    const oldUpdatedAt = TIME_SAVED_CUTOFF - 7 * 24 * 60 * 60 * 1000;
    const summaries = [
      summaryFor('conv-old-summary', { updatedAt: oldUpdatedAt }),
    ];
    const getSession = vi.fn(async () => sessionFor('conv-old-summary', [
      { turnId: 'turn-would-have-qualified', userAt: isoToMs('2026-04-22T10:00:00.000Z'), durationSec: 120 },
    ]));
    const sessionSource = {
      listSessionSummaries: () => summaries,
      getSession,
    };

    const backfill = await import('../timeSavedBackfillService');
    const result = await backfill.scanTimeSavedBackfillCandidates({
      cutoffMs: TIME_SAVED_CUTOFF,
      sessionSource,
    });

    expect(result.candidates).toEqual([]);
    expect(result.counts.sessionsSkippedPrefiltered).toBe(1);
    expect(getSession).not.toHaveBeenCalled();
  });

  it('keeps sessions inside the cutoff margin on the existing hydration path', async () => {
    const insideMarginUpdatedAt = TIME_SAVED_CUTOFF - 6 * 24 * 60 * 60 * 1000;
    const sessions: Record<string, AgentSession> = {
      conv: sessionFor('conv', [
        { turnId: 'turn-inside-margin', userAt: isoToMs('2026-04-22T10:00:00.000Z'), durationSec: 120 },
      ]),
    };
    const getSession = vi.fn(async (id: string) => sessions[id] ?? null);
    const sessionSource = {
      listSessionSummaries: () => [summaryFor('conv', { updatedAt: insideMarginUpdatedAt })],
      getSession,
    };

    const backfill = await import('../timeSavedBackfillService');
    const result = await backfill.scanTimeSavedBackfillCandidates({
      cutoffMs: TIME_SAVED_CUTOFF,
      sessionSource,
    });

    expect(getSession).toHaveBeenCalledTimes(1);
    expect(result.candidates.map((c) => c.turnId)).toEqual(['turn-inside-margin']);
    expect(result.counts.sessionsSkippedPrefiltered).toBe(0);
  });

  it('documents the normal persisted-session invariant that result.createdAt is at or before session.updatedAt', async () => {
    const session = sessionFor('conv', [
      { turnId: 'turn-normal', userAt: isoToMs('2026-04-22T10:00:00.000Z'), durationSec: 120 },
    ]);
    const latestResultCreatedAt = Math.max(
      ...session.messages
        .filter((message) => message.role === 'result')
        .map((message) => message.createdAt),
    );
    expect(latestResultCreatedAt).toBeLessThanOrEqual(session.updatedAt);

    const sessionSource = {
      listSessionSummaries: () => [summaryFor('conv', { updatedAt: session.updatedAt })],
      getSession: async () => session,
    };

    const backfill = await import('../timeSavedBackfillService');
    const result = await backfill.scanTimeSavedBackfillCandidates({
      cutoffMs: TIME_SAVED_CUTOFF,
      sessionSource,
    });

    expect(result.candidates.map((c) => c.turnId)).toEqual(['turn-normal']);
  });

  it('skips candidates whose turnId is already represented in the time-saved store (re-run idempotency)', async () => {
    const sessions: Record<string, AgentSession> = {
      conv: sessionFor('conv', [
        { turnId: 'turn-already', userAt: isoToMs('2026-04-22T10:00:00.000Z'), durationSec: 120 },
        { turnId: 'turn-new', userAt: isoToMs('2026-04-23T10:00:00.000Z'), durationSec: 120 },
      ]),
    };
    const sessionSource = {
      listSessionSummaries: () => [summaryFor('conv')],
      getSession: async (id: string) => sessions[id] ?? null,
    };

    const store = await import('../timeSavedStore');
    store.addTimeSavedEntryAt('turn-already', 'conv', estimate(), isoToMs('2026-04-22T10:02:00.000Z'));

    const backfill = await import('../timeSavedBackfillService');
    const result = await backfill.scanTimeSavedBackfillCandidates({
      cutoffMs: isoToMs('2026-04-14T22:51:48.000Z'),
      sessionSource,
    });

    expect(result.candidates.map((c) => c.turnId)).toEqual(['turn-new']);
    expect(result.counts.turnsSkippedDuplicate).toBe(1);
  });

  it('groups candidates by week and respects the limit cap', async () => {
    const sessions: Record<string, AgentSession> = {
      conv: sessionFor('conv', [
        { turnId: 't1', userAt: isoToMs('2026-04-15T10:00:00.000Z'), durationSec: 90 },
        { turnId: 't2', userAt: isoToMs('2026-04-20T10:00:00.000Z'), durationSec: 90 },
        { turnId: 't3', userAt: isoToMs('2026-04-22T10:00:00.000Z'), durationSec: 90 },
        { turnId: 't4', userAt: isoToMs('2026-05-12T10:00:00.000Z'), durationSec: 90 },
      ]),
    };
    const sessionSource = {
      listSessionSummaries: () => [summaryFor('conv')],
      getSession: async (id: string) => sessions[id] ?? null,
    };

    const backfill = await import('../timeSavedBackfillService');
    const full = await backfill.scanTimeSavedBackfillCandidates({
      cutoffMs: isoToMs('2026-04-14T22:51:48.000Z'),
      sessionSource,
    });
    expect(Object.keys(full.candidatesByWeek).sort()).toEqual(['2026-04-13', '2026-04-20', '2026-05-11']);

    const capped = await backfill.scanTimeSavedBackfillCandidates({
      cutoffMs: isoToMs('2026-04-14T22:51:48.000Z'),
      sessionSource,
      limit: 2,
    });
    expect(capped.candidates).toHaveLength(2);
    // Oldest first (chronological order is the documented invariant).
    expect(capped.candidates.map((c) => c.turnId)).toEqual(['t1', 't2']);
  });
});

describe('timeSavedBackfillService — run (bounded estimator loop)', () => {
  beforeEach(async () => {
    vi.resetModules();
    await initTestPlatformConfig();
  });

  it('caps at maxTurns, aggregates outcomes, and reports persistedMinutesByWeek', async () => {
    const sessions: Record<string, AgentSession> = {
      conv: sessionFor('conv', [
        { turnId: 't1', userAt: isoToMs('2026-04-22T10:00:00.000Z'), durationSec: 90 },
        { turnId: 't2', userAt: isoToMs('2026-04-29T10:00:00.000Z'), durationSec: 90 },
        { turnId: 't3', userAt: isoToMs('2026-05-06T10:00:00.000Z'), durationSec: 90 },
      ]),
    };
    const sessionSource = {
      listSessionSummaries: () => [summaryFor('conv')],
      getSession: async (id: string) => sessions[id] ?? null,
    };

    // Stub recover function returns success on the first two attempts and
    // parse_failure on the third. Cap to 2 turns so only the first two are
    // attempted in this run.
    const recoverFn = vi.fn(async (context: { turnId: string }, ts: number) => {
      if (context.turnId === 't1') {
        return { status: 'persisted' as const, estimate: estimate({ lowMinutes: 10, highMinutes: 20 }), timestamp: ts };
      }
      if (context.turnId === 't2') {
        return { status: 'persisted' as const, estimate: estimate({ lowMinutes: 40, highMinutes: 60 }), timestamp: ts };
      }
      return { status: 'parse_failure' as const };
    });

    const backfill = await import('../timeSavedBackfillService');
    const summary = await backfill.runTimeSavedBackfill({
      cutoffMs: TIME_SAVED_CUTOFF,
      maxTurns: 2,
      sessionSource,
      recoverFn,
    });

    expect(summary.candidatesFound).toBe(3);
    expect(summary.attempted).toBe(2);
    expect(summary.persistedCount).toBe(2);
    expect(summary.persistedMinutesTotal).toBe(15 + 50); // midpoints
    expect(Object.keys(summary.persistedMinutesByWeek).sort()).toEqual(['2026-04-20', '2026-04-27']);
    expect(summary.outcomeCounts.persisted).toBe(2);
    expect(recoverFn).toHaveBeenCalledTimes(2);

    // Recover function received the candidate timestamp (result.createdAt),
    // not the user.createdAt or now(). This is the timestamp-preserving
    // contract end-to-end.
    const args = recoverFn.mock.calls[0];
    const candidateTs = isoToMs('2026-04-22T10:01:30.000Z'); // userAt + 90s
    expect(args[1]).toBe(candidateTs);
  });

  it('records error outcomes when the session vanishes between scan and run', async () => {
    let secondSession: AgentSession | null = sessionFor('conv', [
      { turnId: 't1', userAt: isoToMs('2026-04-22T10:00:00.000Z'), durationSec: 90 },
    ]);
    const sessionSource = {
      listSessionSummaries: () => [summaryFor('conv')],
      getSession: async (_id: string) => {
        // First call (during scan) returns the session, second call (during run) returns null.
        const out = secondSession;
        secondSession = null;
        return out;
      },
    };

    const recoverFn = vi.fn();
    const backfill = await import('../timeSavedBackfillService');
    const summary = await backfill.runTimeSavedBackfill({
      cutoffMs: TIME_SAVED_CUTOFF,
      sessionSource,
      recoverFn,
    });

    expect(summary.outcomeCounts.error).toBe(1);
    expect(recoverFn).not.toHaveBeenCalled();
    expect(summary.outcomes[0].outcome.status).toBe('error');
  });

  it('can reuse one pre-scanned candidate list across bounded batches', async () => {
    const sessions: Record<string, AgentSession> = {
      conv: sessionFor('conv', [
        { turnId: 't1', userAt: isoToMs('2026-04-22T10:00:00.000Z'), durationSec: 90 },
        { turnId: 't2', userAt: isoToMs('2026-04-23T10:00:00.000Z'), durationSec: 90 },
        { turnId: 't3', userAt: isoToMs('2026-04-24T10:00:00.000Z'), durationSec: 90 },
      ]),
    };
    const listSessionSummaries = vi.fn(() => [summaryFor('conv')]);
    const getSession = vi.fn(async (id: string) => sessions[id] ?? null);
    const sessionSource = {
      listSessionSummaries,
      getSession,
    };
    const recoverFn = vi.fn(async (context: { turnId: string }, ts: number) => ({
      status: 'persisted' as const,
      estimate: estimate({ lowMinutes: context.turnId === 't3' ? 20 : 10, highMinutes: context.turnId === 't3' ? 30 : 20 }),
      timestamp: ts,
    }));

    const backfill = await import('../timeSavedBackfillService');
    const scan = await backfill.scanTimeSavedBackfillCandidates({
      cutoffMs: TIME_SAVED_CUTOFF,
      sessionSource,
    });
    let candidateOffset = 0;

    const firstBatch = await backfill.runTimeSavedBackfill({
      cutoffMs: TIME_SAVED_CUTOFF,
      maxTurns: 2,
      sessionSource,
      preScannedCandidates: scan.candidates.slice(candidateOffset),
      recoverFn,
    });
    candidateOffset += firstBatch.attempted;

    const secondBatch = await backfill.runTimeSavedBackfill({
      cutoffMs: TIME_SAVED_CUTOFF,
      maxTurns: 2,
      sessionSource,
      preScannedCandidates: scan.candidates.slice(candidateOffset),
      recoverFn,
    });

    expect(listSessionSummaries).toHaveBeenCalledTimes(1);
    expect(firstBatch.attempted).toBe(2);
    expect(secondBatch.attempted).toBe(1);
    expect(recoverFn.mock.calls.map(([context]) => context.turnId)).toEqual(['t1', 't2', 't3']);
  });

  it('re-checks duplicate turns before loading sessions from a pre-scanned candidate list', async () => {
    const sessions: Record<string, AgentSession> = {
      conv: sessionFor('conv', [
        { turnId: 't1', userAt: isoToMs('2026-04-22T10:00:00.000Z'), durationSec: 90 },
      ]),
    };
    const getSession = vi.fn(async (id: string) => sessions[id] ?? null);
    const sessionSource = {
      listSessionSummaries: () => [summaryFor('conv')],
      getSession,
    };

    const store = await import('../timeSavedStore');
    const backfill = await import('../timeSavedBackfillService');
    const scan = await backfill.scanTimeSavedBackfillCandidates({
      cutoffMs: TIME_SAVED_CUTOFF,
      sessionSource,
    });
    store.addTimeSavedEntryAt('t1', 'conv', estimate(), isoToMs('2026-04-22T10:01:30.000Z'));
    getSession.mockClear();

    const recoverFn = vi.fn();
    const summary = await backfill.runTimeSavedBackfill({
      cutoffMs: TIME_SAVED_CUTOFF,
      maxTurns: 1,
      sessionSource,
      preScannedCandidates: scan.candidates,
      recoverFn,
    });

    expect(summary.outcomeCounts.skipped_duplicate).toBe(1);
    expect(recoverFn).not.toHaveBeenCalled();
    expect(getSession).not.toHaveBeenCalled();
  });
});
