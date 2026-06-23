import { describe, expect, it } from 'vitest';
import {
  attachCloudState,
  buildRolloutReport,
  parseOutbox,
  renderRolloutTable,
} from '../verify-delta-sync-rollout';

const mixedOutbox = {
  '_cloudUrl': 'https://cloud.example.test',
  '_lastPushedSeqTracker': {
    'manual-413': 10,
    'pending-stuck': 20,
    'pending-ok': 30,
  },
  'manual-413': {
    sessionId: 'manual-413',
    status: 'permanent_failure',
    attempts: 1,
    enqueuedAt: 100,
    lastError: 'HTTP 413: BODY_TOO_LARGE',
  },
  'pending-stuck': {
    sessionId: 'pending-stuck',
    status: 'pending',
    attempts: 6,
    enqueuedAt: 200,
    lastError: 'HTTP 502: Bad Gateway',
  },
  'pending-ok': {
    sessionId: 'pending-ok',
    status: 'pending',
    attempts: 3,
    enqueuedAt: 300,
  },
};

describe('verify-delta-sync-rollout', () => {
  it('parses outbox JSON and classifies stuck and manual re-enqueue candidates', () => {
    const report = buildRolloutReport(parseOutbox(mixedOutbox));

    expect(report.ok).toBe(false);
    expect(report.stuckCandidates).toEqual(['pending-stuck']);
    expect(report.manualReenqueueCandidates).toEqual(['manual-413']);
    expect(report.sessions.map((entry) => entry.sessionId)).toEqual(['manual-413', 'pending-ok', 'pending-stuck']);
  });

  it('does not classify pending entries at three attempts as stuck', () => {
    const report = buildRolloutReport(parseOutbox({
      'pending-three': { sessionId: 'pending-three', status: 'pending', attempts: 3 },
    }));

    expect(report.ok).toBe(true);
    expect(report.stuckCandidates).toEqual([]);
  });

  it('attaches cloud cursor state and renders deterministic table plus JSON shape', async () => {
    const parsed = parseOutbox(mixedOutbox);
    await attachCloudState(parsed, {
      cloudUrl: 'https://cloud.example.test',
      token: 'token',
      fetchFn: async () => new Response(JSON.stringify({ serverSeq: 55 })),
    });
    const report = buildRolloutReport(parsed);
    const json = JSON.parse(JSON.stringify(report)) as typeof report;

    expect(json).toMatchObject({
      summary: { total: 3, stuckCandidates: 1, manualReenqueueCandidates: 1 },
      sessions: expect.arrayContaining([expect.objectContaining({ cloudServerSeq: 55 })]),
    });
    expect(renderRolloutTable(report)).toContain('pending-stuck | pending | 6 | 20 | 200 | 502 | 55 | watch-auto-recovery');
  });
});
