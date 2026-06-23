import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

import type { CostEntryWithResolvedOutcome, CostLedgerEntry } from '@core/services/costLedgerService';
import { setLedgerPathOverride } from '@core/services/costLedgerService';
import {
  resetDiagnosticEventsLedgerForTests,
  setDiagnosticEventsLedgerReader,
  setDiagnosticEventsLedgerWriter,
} from '@core/services/diagnosticEventsLedger';
import type { DiagnosticEventEntry } from '@core/services/diagnostics/manifest';
import type { TurnOutcome } from '@shared/costOutcome';
import {
  aggregateCostWaterfall,
  getCostWaterfallByOutcome,
  getCostWaterfallByTurn,
} from '../costWaterfall';

describe('cost waterfall aggregation', () => {
  let tmpDir: string;
  let ledgerPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cost-waterfall-'));
    ledgerPath = path.join(tmpDir, 'cost-ledger.jsonl');
    setLedgerPathOverride(ledgerPath);
    resetDiagnosticEventsLedgerForTests();
  });

  afterEach(() => {
    setLedgerPathOverride(null);
    resetDiagnosticEventsLedgerForTests();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('E.2.T1 aggregates a mixed turn fixture by outcome', async () => {
    writeLedger([
      entry({ tid: 'turn-1', ts: 1000, cost: 0.01, outcome: { kind: 'success' } }),
      entry({ tid: 'turn-1', ts: 1100, cost: 0.02, outcome: { kind: 'success' } }),
      entry({ tid: 'turn-1', ts: 1200, cost: 0.03, outcome: { kind: 'aborted', reason: 'user_cancel' } }),
      entry({ tid: 'turn-1', ts: 1300, cost: 0.04, outcome: { kind: 'failed', reason: 'network' } }),
      entry({ tid: 'turn-1', ts: 1400, cost: 0.05, outcome: { kind: 'failed', reason: 'provider_error' } }),
      entry({ tid: 'turn-1', ts: 1500, cost: 0.06, outcome: { kind: 'quota' } }),
      entry({ tid: 'turn-1', ts: 1600, cost: 0.07, outcome: { kind: 'safety_eval_rejected', stage: 'pre' } }),
      entry({ tid: 'turn-1', ts: 1700, cost: 0.08, outcome: { kind: 'tool_budget' } }),
      entry({ tid: 'turn-1', ts: 1800, cost: 0.09, outcome: { kind: 'auxiliary_success' } }),
      entry({ tid: 'turn-1', ts: 1900, cost: 0.10, outcome: { kind: 'auxiliary_failed', reason: 'parse_error' } }),
      entry({ tid: 'turn-2', ts: 2000, cost: 99, outcome: { kind: 'success' } }),
    ]);

    const waterfall = await getCostWaterfallByTurn('turn-1');

    expect(waterfall.total.count).toBe(10);
    expect(waterfall.total.totalUsd).toBeCloseTo(0.55);
    expectBucket(waterfall.buckets.success, { totalUsd: 0.03, count: 2, lastTs: 1100 });
    expectBucket(waterfall.buckets.aborted, { totalUsd: 0.03, count: 1, lastTs: 1200 });
    expectBucket(waterfall.buckets.failed, { totalUsd: 0.09, count: 2, lastTs: 1400 });
    expectBucket(waterfall.buckets.quota, { totalUsd: 0.06, count: 1, lastTs: 1500 });
    expectBucket(waterfall.buckets.safety_eval_rejected, { totalUsd: 0.07, count: 1, lastTs: 1600 });
    expectBucket(waterfall.buckets.tool_budget, { totalUsd: 0.08, count: 1, lastTs: 1700 });
    expectBucket(waterfall.buckets.auxiliary_success, { totalUsd: 0.09, count: 1, lastTs: 1800 });
    expectBucket(waterfall.buckets.auxiliary_failed, { totalUsd: 0.1, count: 1, lastTs: 1900 });
  });

  it('E.2.T2 buckets legacy rows with no outcome and no costEntryId as legacy_unknown', async () => {
    writeLedger([
      { ts: 1000, cost: 0.01 },
      { ts: 1100, cost: 0.02 },
      { ts: 1200, cost: 0.03 },
    ]);

    const waterfall = await getCostWaterfallByOutcome({ since: 0 });

    expect(waterfall.total.count).toBe(3);
    expect(waterfall.total.totalUsd).toBeCloseTo(0.06);
    expectBucket(waterfall.buckets.legacy_unknown, { totalUsd: 0.06, count: 3, lastTs: 1200 });
  });

  it('E.2.T3a applies costEntryId outcome resolutions before bucketing', async () => {
    writeLedger([
      { ts: 1000, cost: 0.04, tid: 'turn-1', costEntryId: 'cost-entry-1' },
    ]);
    installDiagnosticEvents([
      resolutionEvent('cost-entry-1', 1500, { kind: 'success' }),
    ]);

    const waterfall = await getCostWaterfallByTurn('turn-1');

    expectBucket(waterfall.buckets.success, { totalUsd: 0.04, count: 1, lastTs: 1000 });
    expect(waterfall.buckets.legacy_unknown.count).toBe(0);
    expect(waterfall.orphans).toEqual({ resolutionLost: 0, resolutionUnmatched: 0 });
  });

  it('E.2.T3 counts orphan resolution events with no matching ledger row', async () => {
    writeLedger([]);
    installDiagnosticEvents([
      resolutionEvent('missing-cost-entry', 1500, { kind: 'failed', reason: 'timeout' }),
    ]);

    const waterfall = await getCostWaterfallByOutcome({ since: 0 });

    expect(waterfall.total).toEqual({ totalUsd: 0, count: 0 });
    expect(waterfall.orphans).toEqual({ resolutionLost: 0, resolutionUnmatched: 1 });
  });

  it('E.2.T4 counts resolution-lost rows emitted by the outcome reader', async () => {
    writeLedger([
      { ts: 1, cost: 0.11, tid: 'turn-1', costEntryId: 'rotated-past-entry' },
    ]);
    installDiagnosticEvents([]);

    const waterfall = await getCostWaterfallByTurn('turn-1');

    expectBucket(waterfall.buckets.legacy_unknown, { totalUsd: 0.11, count: 1, lastTs: 1 });
    expect(waterfall.orphans).toEqual({ resolutionLost: 1, resolutionUnmatched: 0 });
  });

  it('E.2.T5 respects ts >= since for getCostWaterfallByOutcome', async () => {
    writeLedger([
      entry({ ts: 1000, cost: 0.01, outcome: { kind: 'success' } }),
      entry({ ts: 2000, cost: 0.02, outcome: { kind: 'success' } }),
      entry({ ts: 3000, cost: 0.03, outcome: { kind: 'failed', reason: 'other' } }),
    ]);

    const waterfall = await getCostWaterfallByOutcome({ since: 2000 });

    expect(waterfall.total.count).toBe(2);
    expect(waterfall.total.totalUsd).toBeCloseTo(0.05);
    expectBucket(waterfall.buckets.success, { totalUsd: 0.02, count: 1, lastTs: 2000 });
    expectBucket(waterfall.buckets.failed, { totalUsd: 0.03, count: 1, lastTs: 3000 });
  });

  it('E.2.T6 keeps the pure aggregation invariant for repeated identical input', () => {
    const entries: CostEntryWithResolvedOutcome[] = [
      { ts: 1000, cost: 0.02, resolvedOutcome: { kind: 'success' } },
      { ts: 2000, cost: 0.03, resolvedOutcome: { kind: 'failed', reason: 'other' } },
    ];
    const before = JSON.stringify(entries);

    const first = aggregateCostWaterfall(entries, { resolutionLost: 1, resolutionUnmatched: 2 });
    const second = aggregateCostWaterfall(entries, { resolutionLost: 1, resolutionUnmatched: 2 });

    expect(second).toEqual(first);
    expect(JSON.stringify(entries)).toBe(before);
  });

  function writeLedger(entries: readonly CostLedgerEntry[]): void {
    const content = entries.map((record) => JSON.stringify(record)).join('\n');
    fs.writeFileSync(ledgerPath, content ? `${content}\n` : '', 'utf8');
  }

  function installDiagnosticEvents(events: DiagnosticEventEntry[]): DiagnosticEventEntry[] {
    setDiagnosticEventsLedgerReader({
      readRecent: vi.fn(async () => events),
    });
    setDiagnosticEventsLedgerWriter({
      append(event) {
        events.push(event);
      },
    });
    return events;
  }

  function expectBucket(
    bucket: { totalUsd: number; count: number; lastTs: number },
    expected: { totalUsd: number; count: number; lastTs: number },
  ): void {
    expect(bucket.count).toBe(expected.count);
    expect(bucket.lastTs).toBe(expected.lastTs);
    expect(bucket.totalUsd).toBeCloseTo(expected.totalUsd);
  }
});

function entry(overrides: Partial<CostLedgerEntry> & { outcome: TurnOutcome }): CostLedgerEntry {
  return {
    ts: 1000,
    cost: 0.01,
    ...overrides,
  };
}

function resolutionEvent(
  costEntryId: string,
  ts: number,
  outcome: TurnOutcome,
): DiagnosticEventEntry {
  return {
    v: 1,
    ts,
    surface: 'desktop',
    kind: 'cost_outcome_resolution',
    tid: 'turn-1',
    data: {
      costEntryId,
      ledgerRowTs: 1000,
      ledgerRowTid: 'turn-1',
      outcome,
    },
  };
}
