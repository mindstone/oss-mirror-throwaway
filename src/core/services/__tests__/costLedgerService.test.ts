import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getModelPricing } from '@shared/utils/pricingCalculator';

const mockTrack = vi.fn();
const mockIsAvailable = vi.fn().mockReturnValue(true);
vi.mock('@core/tracking', () => ({
  getTracker: () => ({
    track: mockTrack,
    isAvailable: mockIsAvailable,
    identify: vi.fn(),
    getAnonymousId: vi.fn().mockReturnValue('test-anon-id'),
  }),
}));

import {
  isValidEntry,
  appendCostEntry,
  getCategorizedCostSummary,
  getCostEntriesWithResolvedOutcomes,
  getDailyBreakdown,
  isInternalSession,
  resolveCostEntryOutcome,
  setLedgerPathOverride,
} from '../costLedgerService';
import {
  resetDiagnosticEventsLedgerForTests,
  setDiagnosticEventsLedgerReader,
  type DiagnosticEventsLedgerReader,
} from '../diagnosticEventsLedger';
import type { DiagnosticEventEntry } from '../diagnostics/manifest';

async function waitForFileContent(
  filePath: string,
  contains: string,
  timeoutMs = 500,
  intervalMs = 5,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      if (content.includes(contains)) return content;
    } catch {
      // File may not yet exist; keep polling.
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`Timed out waiting for "${contains}" in ${filePath} after ${timeoutMs}ms`);
}

describe('costLedgerService', () => {
  describe('isValidEntry', () => {
    it('accepts a minimal valid entry', () => {
      expect(isValidEntry({ ts: 1000, cost: 0.05 })).toBe(true);
    });

    it('accepts entry with valid auth string', () => {
      expect(isValidEntry({ ts: 1000, cost: 0.05, auth: 'api-key' })).toBe(true);
      expect(isValidEntry({ ts: 1000, cost: 0.05, auth: 'oauth-token' })).toBe(true);
      expect(isValidEntry({ ts: 1000, cost: 0.05, auth: 'some-future-value' })).toBe(true);
    });

    it('rejects entry with non-string auth', () => {
      expect(isValidEntry({ ts: 1000, cost: 0.05, auth: 42 })).toBe(false);
      expect(isValidEntry({ ts: 1000, cost: 0.05, auth: true })).toBe(false);
      expect(isValidEntry({ ts: 1000, cost: 0.05, auth: {} })).toBe(false);
      expect(isValidEntry({ ts: 1000, cost: 0.05, auth: ['api-key'] })).toBe(false);
    });

    it('accepts entry without auth field (backwards compat)', () => {
      const entry = { ts: 1000, cost: 0.05, cat: 'agent', m: 'claude-sonnet-4-20250514' };
      expect(isValidEntry(entry)).toBe(true);
    });

    it('accepts entry with all optional fields including auth', () => {
      const entry = {
        ts: 1000,
        cost: 0.05,
        sid: 'session-1',
        tid: 'turn-1',
        cat: 'agent',
        m: 'claude-sonnet-4-20250514',
        auth: 'api-key',
      };
      expect(isValidEntry(entry)).toBe(true);
    });

    it('rejects non-object values', () => {
      expect(isValidEntry(null)).toBe(false);
      expect(isValidEntry(undefined)).toBe(false);
      expect(isValidEntry('string')).toBe(false);
      expect(isValidEntry(42)).toBe(false);
    });

    it('rejects entries missing required fields', () => {
      expect(isValidEntry({ cost: 0.05 })).toBe(false);
      expect(isValidEntry({ ts: 1000 })).toBe(false);
    });

    it('accepts entry with all token fields (valid numbers)', () => {
      expect(isValidEntry({
        ts: 1000,
        cost: 0.05,
        inTok: 1500,
        outTok: 300,
        cacheReadTok: 1000,
        cacheCreateTok: 200,
      })).toBe(true);
    });

    it('accepts entry with valid per-model usage map', () => {
      expect(isValidEntry({
        ts: 1000,
        cost: 0.05,
        mu: {
          'claude-sonnet-4-6': { in: 1200, out: 300, cacheR: 50, cacheC: 25, cost: 0.04 },
          'claude-haiku-4-5': { in: 400, out: 100, cost: 0.01 },
        },
      })).toBe(true);
    });

    it('accepts entry without per-model usage map (backwards compat)', () => {
      expect(isValidEntry({
        ts: 1000,
        cost: 0.05,
        m: 'claude-sonnet-4-6',
      })).toBe(true);
    });

    it('rejects entry with invalid per-model usage map', () => {
      expect(isValidEntry({
        ts: 1000,
        cost: 0.05,
        mu: {
          'claude-sonnet-4-6': { in: '1200', out: 300 },
        },
      })).toBe(false);

      expect(isValidEntry({
        ts: 1000,
        cost: 0.05,
        mu: {
          'claude-sonnet-4-6': { in: 1200, out: Number.NaN },
        },
      })).toBe(false);

      expect(isValidEntry({
        ts: 1000,
        cost: 0.05,
        mu: 'bad-shape',
      })).toBe(false);
    });

    it('accepts entry with some token fields undefined', () => {
      expect(isValidEntry({ ts: 1000, cost: 0.05, inTok: 1500 })).toBe(true);
      expect(isValidEntry({ ts: 1000, cost: 0.05, outTok: 300 })).toBe(true);
      expect(isValidEntry({ ts: 1000, cost: 0.05, inTok: 1500, outTok: 300 })).toBe(true);
    });

    it('rejects entry with invalid token field (string instead of number)', () => {
      expect(isValidEntry({ ts: 1000, cost: 0.05, inTok: '1500' })).toBe(false);
      expect(isValidEntry({ ts: 1000, cost: 0.05, outTok: 'abc' })).toBe(false);
      expect(isValidEntry({ ts: 1000, cost: 0.05, cacheReadTok: '0' })).toBe(false);
      expect(isValidEntry({ ts: 1000, cost: 0.05, cacheCreateTok: true })).toBe(false);
    });

    it('rejects entry with NaN token field', () => {
      expect(isValidEntry({ ts: 1000, cost: 0.05, inTok: NaN })).toBe(false);
      expect(isValidEntry({ ts: 1000, cost: 0.05, outTok: NaN })).toBe(false);
      expect(isValidEntry({ ts: 1000, cost: 0.05, cacheReadTok: NaN })).toBe(false);
      expect(isValidEntry({ ts: 1000, cost: 0.05, cacheCreateTok: NaN })).toBe(false);
    });

    it('rejects entry with Infinity token field', () => {
      expect(isValidEntry({ ts: 1000, cost: 0.05, inTok: Infinity })).toBe(false);
      expect(isValidEntry({ ts: 1000, cost: 0.05, outTok: -Infinity })).toBe(false);
      expect(isValidEntry({ ts: 1000, cost: 0.05, cacheReadTok: Infinity })).toBe(false);
      expect(isValidEntry({ ts: 1000, cost: 0.05, cacheCreateTok: Infinity })).toBe(false);
    });

    it('accepts entry with zero token values', () => {
      expect(isValidEntry({ ts: 1000, cost: 0.05, inTok: 0, outTok: 0 })).toBe(true);
    });

    it('accepts zero-cost rows for ledger/analyzer flows', () => {
      expect(isValidEntry({
        ts: Date.now(),
        cost: 0,
        m: 'deepseek-v4-flash',
      })).toBe(true);
    });

    it('accepts entry with est: true (estimated cost)', () => {
      expect(isValidEntry({ ts: 1000, cost: 0.05, est: true })).toBe(true);
    });

    it('accepts entry with est: false', () => {
      expect(isValidEntry({ ts: 1000, cost: 0.05, est: false })).toBe(true);
    });

    it('accepts entry without est field (backwards compat)', () => {
      expect(isValidEntry({ ts: 1000, cost: 0.05, cat: 'agent', m: 'claude-sonnet-4' })).toBe(true);
    });

    it('rejects entry with non-boolean est', () => {
      expect(isValidEntry({ ts: 1000, cost: 0.05, est: 'string' })).toBe(false);
      expect(isValidEntry({ ts: 1000, cost: 0.05, est: 1 })).toBe(false);
      expect(isValidEntry({ ts: 1000, cost: 0.05, est: null })).toBe(false);
    });

    it('accepts valid outcome shapes and legacy rows with no outcome', () => {
      expect(isValidEntry({ ts: 1000, cost: 0.05 })).toBe(true);
      expect(isValidEntry({ ts: 1000, cost: 0.05, outcome: { kind: 'success' } })).toBe(true);
      expect(isValidEntry({
        ts: 1000,
        cost: 0.05,
        outcome: { kind: 'aborted', reason: 'user_cancel' },
      })).toBe(true);
      expect(isValidEntry({
        ts: 1000,
        cost: 0.05,
        outcome: { kind: 'safety_eval_rejected', stage: 'post' },
      })).toBe(true);
      expect(isValidEntry({
        ts: 1000,
        cost: 0.05,
        outcome: { kind: 'auxiliary_failed', reason: 'provider_error' },
      })).toBe(true);
    });

    it('rejects structurally invalid outcome shapes', () => {
      expect(isValidEntry({ ts: 1000, cost: 0.05, outcome: { kind: 'bogus' } })).toBe(false);
      expect(isValidEntry({ ts: 1000, cost: 0.05, outcome: { kind: 'failed' } })).toBe(false);
      expect(isValidEntry({
        ts: 1000,
        cost: 0.05,
        outcome: { kind: 'aborted', reason: 'not-real' },
      })).toBe(false);
      expect(isValidEntry({
        ts: 1000,
        cost: 0.05,
        outcome: { kind: 'safety_eval_rejected', stage: 'during' },
      })).toBe(false);
    });
  });

  describe('getCategorizedCostSummary', () => {
    let tmpDir: string;
    let ledgerPath: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'costledger-test-'));
      ledgerPath = path.join(tmpDir, 'cost-ledger.jsonl');
      setLedgerPathOverride(ledgerPath);
    });

    afterEach(() => {
      setLedgerPathOverride(null);
      try {
        fs.rmSync(tmpDir, { recursive: true });
      } catch {
        // Ignore cleanup errors
      }
    });

    const writeLedger = (entries: Array<Record<string, unknown>>) => {
      const lines = entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
      fs.writeFileSync(ledgerPath, lines, 'utf8');
    };

    it('aggregates byAuthMethod correctly', async () => {
      writeLedger([
        { ts: 1000, cost: 1.00, auth: 'api-key', cat: 'agent' },
        { ts: 2000, cost: 2.50, auth: 'oauth-token', cat: 'agent' },
        { ts: 3000, cost: 0.50, auth: 'api-key', cat: 'safety' },
        { ts: 4000, cost: 3.00, auth: 'oauth-token', cat: 'memory' },
      ]);

      const summary = await getCategorizedCostSummary();

      expect(summary.byAuthMethod).toEqual({
        'api-key': 1.50,
        'oauth-token': 5.50,
      });
      expect(summary.total).toBe(7.00);
      expect(summary.entryCount).toBe(4);
    });

    it('aggregates entries without auth under "unknown"', async () => {
      writeLedger([
        { ts: 1000, cost: 1.00, cat: 'agent' },
        { ts: 2000, cost: 2.00, auth: 'api-key', cat: 'agent' },
        { ts: 3000, cost: 0.75, cat: 'safety' },
      ]);

      const summary = await getCategorizedCostSummary();

      expect(summary.byAuthMethod).toEqual({
        unknown: 1.75,
        'api-key': 2.00,
      });
    });

    it('returns empty byAuthMethod for empty ledger', async () => {
      // Don't create the file — missing file should return empty summary
      const summary = await getCategorizedCostSummary();

      expect(summary.byAuthMethod).toEqual({});
      expect(summary.total).toBe(0);
      expect(summary.entryCount).toBe(0);
    });

    it('returns empty byAuthMethod when file exists but has no entries', async () => {
      writeLedger([]);
      const summary = await getCategorizedCostSummary();

      expect(summary.byAuthMethod).toEqual({});
    });

    it('respects time range filters for byAuthMethod', async () => {
      writeLedger([
        { ts: 1000, cost: 1.00, auth: 'api-key' },
        { ts: 5000, cost: 2.00, auth: 'oauth-token' },
        { ts: 9000, cost: 3.00, auth: 'api-key' },
      ]);

      const summary = await getCategorizedCostSummary({
        startTs: 4000,
        endTs: 6000,
      });

      expect(summary.byAuthMethod).toEqual({ 'oauth-token': 2.00 });
      expect(summary.total).toBe(2.00);
      expect(summary.entryCount).toBe(1);
    });

    it('sums token totals from ledger entries', async () => {
      writeLedger([
        { ts: 1000, cost: 0.05, cat: 'agent', inTok: 1500, outTok: 300, cacheReadTok: 1000, cacheCreateTok: 200 },
        { ts: 2000, cost: 0.03, cat: 'agent', inTok: 500, outTok: 100, cacheReadTok: 400, cacheCreateTok: 50 },
        { ts: 3000, cost: 0.02, cat: 'safety', inTok: 200, outTok: 80 },
      ]);

      const summary = await getCategorizedCostSummary();

      expect(summary.totalInputTokens).toBe(2200);
      expect(summary.totalOutputTokens).toBe(480);
      expect(summary.totalCacheReadTokens).toBe(1400);
      expect(summary.totalCacheCreationTokens).toBe(250);
      expect(summary.totalPromptTokens).toBe(2200 + 1400 + 250); // input + cacheRead + cacheCreation
    });

    it('handles entries with missing token fields using ?? 0 (no NaN poisoning)', async () => {
      writeLedger([
        { ts: 1000, cost: 0.05, cat: 'agent', inTok: 1000, outTok: 200 },
        { ts: 2000, cost: 0.03, cat: 'safety' }, // no token fields at all
        { ts: 3000, cost: 0.02, cat: 'agent', cacheReadTok: 500 }, // only cacheReadTok
      ]);

      const summary = await getCategorizedCostSummary();

      expect(summary.totalInputTokens).toBe(1000);
      expect(summary.totalOutputTokens).toBe(200);
      expect(summary.totalCacheReadTokens).toBe(500);
      expect(summary.totalCacheCreationTokens).toBe(0);
      expect(summary.totalPromptTokens).toBe(1000 + 500 + 0);
    });

    it('counts unique non-internal sessions for activeSessionCount', async () => {
      writeLedger([
        { ts: 1000, cost: 0.05, sid: 'session-a', cat: 'agent' },
        { ts: 2000, cost: 0.03, sid: 'session-a', cat: 'agent' }, // duplicate
        { ts: 3000, cost: 0.02, sid: 'session-b', cat: 'conversation' },
        { ts: 4000, cost: 0.01, sid: 'session-c', cat: 'agent' },
      ]);

      const summary = await getCategorizedCostSummary();

      expect(summary.activeSessionCount).toBe(3); // a, b, c
    });

    it('excludes internal sessions from activeSessionCount', async () => {
      writeLedger([
        { ts: 1000, cost: 0.05, sid: 'session-user-1', cat: 'agent' },
        { ts: 2000, cost: 0.03, sid: 'automation-calendar-sync--uuid-1', cat: 'automation' },
        { ts: 3000, cost: 0.02, sid: 'memory-update-abc123', cat: 'memory' },
        { ts: 4000, cost: 0.01, sid: 'use-case-discovery-xyz', cat: 'agent' },
        { ts: 5000, cost: 0.04, sid: 'cli-chat-abc', cat: 'agent' },
        { ts: 6000, cost: 0.01, sid: 'calendar-sync', cat: 'automation' },
        { ts: 7000, cost: 0.06, sid: 'session-user-2', cat: 'conversation' },
      ]);

      const summary = await getCategorizedCostSummary();

      expect(summary.activeSessionCount).toBe(2); // only session-user-1, session-user-2
    });

    it('does not count entries with no sid in activeSessionCount', async () => {
      writeLedger([
        { ts: 1000, cost: 0.05, cat: 'agent' }, // no sid
        { ts: 2000, cost: 0.03, sid: 'session-a', cat: 'agent' },
        { ts: 3000, cost: 0.02, cat: 'safety' }, // no sid
      ]);

      const summary = await getCategorizedCostSummary();

      expect(summary.activeSessionCount).toBe(1); // only session-a
    });

    it('returns all zeros for empty ledger (missing file)', async () => {
      // Don't create the file
      const summary = await getCategorizedCostSummary();

      expect(summary.totalInputTokens).toBe(0);
      expect(summary.totalOutputTokens).toBe(0);
      expect(summary.totalCacheReadTokens).toBe(0);
      expect(summary.totalCacheCreationTokens).toBe(0);
      expect(summary.totalPromptTokens).toBe(0);
      expect(summary.activeSessionCount).toBe(0);
    });

    it('returns all zeros for empty ledger (file exists, no entries)', async () => {
      writeLedger([]);
      const summary = await getCategorizedCostSummary();

      expect(summary.totalInputTokens).toBe(0);
      expect(summary.totalOutputTokens).toBe(0);
      expect(summary.totalCacheReadTokens).toBe(0);
      expect(summary.totalCacheCreationTokens).toBe(0);
      expect(summary.totalPromptTokens).toBe(0);
      expect(summary.activeSessionCount).toBe(0);
    });

    it('totalPromptTokens equals input + cacheRead + cacheCreation', async () => {
      writeLedger([
        { ts: 1000, cost: 0.05, inTok: 100, cacheReadTok: 200, cacheCreateTok: 50 },
        { ts: 2000, cost: 0.03, inTok: 300, cacheReadTok: 100, cacheCreateTok: 25 },
      ]);

      const summary = await getCategorizedCostSummary();

      expect(summary.totalPromptTokens).toBe(
        summary.totalInputTokens + summary.totalCacheReadTokens + summary.totalCacheCreationTokens
      );
      expect(summary.totalPromptTokens).toBe(400 + 300 + 75);
    });

    it('aggregates byModel from explicit per-model costs and legacy model strings', async () => {
      writeLedger([
        {
          ts: 1000,
          cost: 0.08,
          mu: {
            'claude-sonnet-4-6': { in: 1200, out: 300, cost: 0.06 },
            'claude-haiku-4-5': { in: 400, out: 100, cost: 0.02 },
          },
        },
        { ts: 2000, cost: 0.04, m: 'claude-opus-4-7 + claude-haiku-4-5' },
      ]);

      const summary = await getCategorizedCostSummary();

      expect(summary.byModel).toEqual({
        'claude-sonnet-4-6': 0.06,
        'claude-haiku-4-5': 0.02,
        'claude-opus-4-7 + claude-haiku-4-5': 0.04,
      });
    });

    it('attributes per-model cost using pricing-weighted token estimates when mu has no cost', async () => {
      writeLedger([
        {
          ts: 1000,
          cost: 0.30,
          mu: {
            'claude-sonnet-4-6': { in: 1000, out: 200 },
            'claude-haiku-4-5': { in: 500, out: 50 },
          },
        },
      ]);

      const sonnetPricing = getModelPricing('claude-sonnet-4-6');
      const haikuPricing = getModelPricing('claude-haiku-4-5');
      expect(sonnetPricing).not.toBeNull();
      expect(haikuPricing).not.toBeNull();

      const sonnetWeight = (sonnetPricing!.output * 200) + (sonnetPricing!.input * 1000);
      const haikuWeight = (haikuPricing!.output * 50) + (haikuPricing!.input * 500);
      const totalWeight = sonnetWeight + haikuWeight;

      const summary = await getCategorizedCostSummary();

      expect(summary.byModel['claude-sonnet-4-6']).toBeCloseTo(0.30 * (sonnetWeight / totalWeight), 10);
      expect(summary.byModel['claude-haiku-4-5']).toBeCloseTo(0.30 * (haikuWeight / totalWeight), 10);
    });

    it('attributes evenly when priced models have zero weighted tokens', async () => {
      writeLedger([
        {
          ts: 1000,
          cost: 0.24,
          mu: {
            'claude-sonnet-4-6': { in: 0, out: 0 },
            'claude-haiku-4-5': { in: 0, out: 0 },
          },
        },
      ]);

      const summary = await getCategorizedCostSummary();

      expect(summary.byModel['claude-sonnet-4-6']).toBeCloseTo(0.12, 10);
      expect(summary.byModel['claude-haiku-4-5']).toBeCloseTo(0.12, 10);
    });

    it('uses unattributed bucket when no model pricing is available', async () => {
      writeLedger([
        {
          ts: 1000,
          cost: 0.18,
          mu: {
            'custom-model-a': { in: 1000, out: 100 },
            'custom-model-b': { in: 500, out: 50 },
          },
        },
      ]);

      const summary = await getCategorizedCostSummary();

      expect(summary.byModel).toEqual({ unattributed: 0.18 });
    });
  });

  describe('isInternalSession', () => {
    it('identifies automation sessions as internal', () => {
      expect(isInternalSession('automation-calendar-sync--uuid-1')).toBe(true);
      expect(isInternalSession('automation-wins-learnings')).toBe(true);
    });

    it('identifies memory-update sessions as internal', () => {
      expect(isInternalSession('memory-update-abc123')).toBe(true);
    });

    it('identifies use-case-discovery sessions as internal', () => {
      expect(isInternalSession('use-case-discovery-xyz')).toBe(true);
    });

    it('identifies cli-chat sessions as internal', () => {
      expect(isInternalSession('cli-chat-session1')).toBe(true);
    });

    it('identifies legacy calendar-sync as internal', () => {
      expect(isInternalSession('calendar-sync')).toBe(true);
    });

    it('returns false for user-initiated sessions', () => {
      expect(isInternalSession('session-abc123')).toBe(false);
      expect(isInternalSession('some-user-session')).toBe(false);
    });
  });

  describe('getDailyBreakdown', () => {
    let tmpDir: string;
    let ledgerPath: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'costledger-daily-'));
      ledgerPath = path.join(tmpDir, 'cost-ledger.jsonl');
      setLedgerPathOverride(ledgerPath);
    });

    afterEach(() => {
      setLedgerPathOverride(null);
      try {
        fs.rmSync(tmpDir, { recursive: true });
      } catch {
        // Ignore cleanup errors
      }
    });

    const writeLedger = (entries: Array<Record<string, unknown>>) => {
      const lines = entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
      fs.writeFileSync(ledgerPath, lines, 'utf8');
    };

    it('returns empty array for missing file', async () => {
      const result = await getDailyBreakdown();
      expect(result).toEqual([]);
    });

    it('aggregates entries by date', async () => {
      // Two entries on 2026-01-20, one on 2026-01-21
      writeLedger([
        { ts: new Date('2026-01-20T10:00:00Z').getTime(), cost: 1.00, cat: 'agent', inTok: 100, outTok: 50 },
        { ts: new Date('2026-01-20T15:00:00Z').getTime(), cost: 0.50, cat: 'safety', inTok: 20, outTok: 10 },
        { ts: new Date('2026-01-21T10:00:00Z').getTime(), cost: 2.00, cat: 'conversation', inTok: 200, outTok: 100 },
      ]);

      const result = await getDailyBreakdown();

      expect(result).toHaveLength(2);
      // Sorted descending, so 2026-01-21 comes first
      expect(result[0].date).toBe('2026-01-21');
      expect(result[0].cost).toBe(2.00);
      expect(result[0].turns).toBe(1); // 'conversation' counts as a turn
      expect(result[0].totalEntries).toBe(1);
      expect(result[0].inTok).toBe(200);
      expect(result[0].outTok).toBe(100);

      expect(result[1].date).toBe('2026-01-20');
      expect(result[1].cost).toBe(1.50);
      expect(result[1].turns).toBe(1); // only 'agent' counts, not 'safety'
      expect(result[1].totalEntries).toBe(2);
      expect(result[1].inTok).toBe(120);
      expect(result[1].outTok).toBe(60);
    });

    it('sums token fields, defaulting absent tokens to 0', async () => {
      writeLedger([
        { ts: new Date('2026-01-20T10:00:00Z').getTime(), cost: 1.00, cat: 'agent', inTok: 100, outTok: 50, cacheReadTok: 80, cacheCreateTok: 20 },
        { ts: new Date('2026-01-20T15:00:00Z').getTime(), cost: 0.50, cat: 'safety' }, // no token fields
      ]);

      const result = await getDailyBreakdown();

      expect(result).toHaveLength(1);
      expect(result[0].inTok).toBe(100);
      expect(result[0].outTok).toBe(50);
      expect(result[0].cacheReadTok).toBe(80);
      expect(result[0].cacheCreateTok).toBe(20);
    });

    it('respects startTs filter', async () => {
      const ts1 = new Date('2026-01-20T10:00:00Z').getTime();
      const ts2 = new Date('2026-01-21T10:00:00Z').getTime();
      writeLedger([
        { ts: ts1, cost: 1.00, cat: 'agent' },
        { ts: ts2, cost: 2.00, cat: 'agent' },
      ]);

      const result = await getDailyBreakdown({ startTs: ts2 });

      expect(result).toHaveLength(1);
      expect(result[0].date).toBe('2026-01-21');
    });

    it('counts turns correctly for agent and conversation categories', async () => {
      writeLedger([
        { ts: new Date('2026-01-20T10:00:00Z').getTime(), cost: 1.00, cat: 'agent' },
        { ts: new Date('2026-01-20T11:00:00Z').getTime(), cost: 0.50, cat: 'conversation' },
        { ts: new Date('2026-01-20T12:00:00Z').getTime(), cost: 0.25, cat: 'safety' },
        { ts: new Date('2026-01-20T13:00:00Z').getTime(), cost: 0.10, cat: 'memory' },
        { ts: new Date('2026-01-20T14:00:00Z').getTime(), cost: 0.05 }, // absent cat defaults to 'agent'
      ]);

      const result = await getDailyBreakdown();

      expect(result).toHaveLength(1);
      expect(result[0].turns).toBe(3); // agent + conversation + absent (defaults to agent)
      expect(result[0].totalEntries).toBe(5);
    });
  });

  describe('appendCostEntry PostHog tracking', () => {
    let tmpDir: string;
    let ledgerPath: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'costledger-append-'));
      ledgerPath = path.join(tmpDir, 'cost-ledger.jsonl');
      setLedgerPathOverride(ledgerPath);
      mockTrack.mockClear();
      mockIsAvailable.mockClear();
      mockIsAvailable.mockReturnValue(true);
    });

    afterEach(() => {
      setLedgerPathOverride(null);
      try {
        fs.rmSync(tmpDir, { recursive: true });
      } catch {
        // Ignore cleanup errors
      }
    });

    it('emits Cost Incurred with correct properties', () => {
      const result = appendCostEntry({
        ts: 1000,
        cost: 0.05,
        cat: 'agent',
        m: 'claude-sonnet-4',
        auth: 'api-key',
        inTok: 100,
        outTok: 50,
        cacheReadTok: 10,
        cacheCreateTok: 5,
        outcome: { kind: 'success' },
      });

      expect(result.costEntryId).toMatch(/^[0-9a-f-]{36}$/u);
      expect(mockTrack).toHaveBeenCalledWith('Cost Incurred', expect.objectContaining({
        costEntryId: result.costEntryId,
        outcome: { kind: 'success' },
        costUsd: 0.05,
        category: 'agent',
        model: 'claude-sonnet-4',
        authMethod: 'api-key',
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 10,
        cacheCreationTokens: 5,
        pricingModelResolved: 'claude-sonnet-4',
      }));
    });

    it('emits multi-model analytics properties when per-model costs are present', () => {
      const modelUsage = {
        'claude-sonnet-4-6': { in: 1200, out: 300, cost: 0.06 },
        'claude-haiku-4-5': { in: 400, out: 100, cost: 0.02 },
      };

      appendCostEntry({
        ts: 1000,
        cost: 0.08,
        cat: 'conversation',
        m: 'claude-sonnet-4-6 + claude-haiku-4-5',
        mu: modelUsage,
      });

      expect(mockTrack).toHaveBeenCalledWith('Cost Incurred', expect.objectContaining({
        costUsd: 0.08,
        category: 'conversation',
        model: 'claude-sonnet-4-6 + claude-haiku-4-5',
        pricingModelResolved: null,
        primaryModel: 'claude-sonnet-4-6',
        modelCount: 2,
        modelBreakdownJson: JSON.stringify(modelUsage),
      }));
    });

    it('estimates primaryModel from pricing when mu does not include per-model costs', () => {
      const modelUsage = {
        'claude-sonnet-4-6': { in: 1200, out: 300 },
        'claude-haiku-4-5': { in: 400, out: 100 },
      };

      appendCostEntry({
        ts: 1000,
        cost: 0.08,
        m: 'claude-sonnet-4-6 + claude-haiku-4-5',
        mu: modelUsage,
      });

      expect(mockTrack).toHaveBeenCalledWith('Cost Incurred', expect.objectContaining({
        pricingModelResolved: null,
        primaryModel: 'claude-sonnet-4-6',
        modelCount: 2,
        modelBreakdownJson: JSON.stringify(modelUsage),
      }));
    });

    it('defaults category to "agent" when cat is absent', () => {
      appendCostEntry({ ts: 1000, cost: 0.05 });

      expect(mockTrack).toHaveBeenCalledWith('Cost Incurred', expect.objectContaining({
        category: 'agent',
      }));
    });

    it('does NOT emit when entry is invalid', () => {
      appendCostEntry({ ts: -1, cost: 0.05 } as any);

      expect(mockTrack).not.toHaveBeenCalled();
    });

    it('does NOT emit when tracker is unavailable', () => {
      mockIsAvailable.mockReturnValue(false);

      appendCostEntry({ ts: 1000, cost: 0.05 });

      expect(mockTrack).not.toHaveBeenCalled();
    });

    it('still writes to ledger even if tracker throws', async () => {
      mockTrack.mockImplementation(() => { throw new Error('PostHog down'); });

      expect(() => appendCostEntry({ ts: 1000, cost: 0.05 })).not.toThrow();

      // Poll for both file existence AND expected content to avoid the
      // partial-write race where existsSync returns true while the writer
      // is mid-flush. Failure modes (file never written, content missing)
      // now surface as a deterministic timeout error rather than a silently
      // resolved promise hiding a thrown assertion.
      const content = await waitForFileContent(ledgerPath, '"cost":0.05');
      expect(content).toContain('"cost":0.05');
    });
  });

  describe('outcome resolution reader', () => {
    let tmpDir: string;
    let ledgerPath: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'costledger-outcome-'));
      ledgerPath = path.join(tmpDir, 'cost-ledger.jsonl');
      setLedgerPathOverride(ledgerPath);
      resetDiagnosticEventsLedgerForTests();
    });

    afterEach(() => {
      setLedgerPathOverride(null);
      resetDiagnosticEventsLedgerForTests();
      try {
        fs.rmSync(tmpDir, { recursive: true });
      } catch {
        // Ignore cleanup errors
      }
    });

    const resolutionEvent = (costEntryId: string, ts: number): DiagnosticEventEntry => ({
      v: 1,
      ts,
      surface: 'desktop',
      kind: 'cost_outcome_resolution',
      data: {
        costEntryId,
        ledgerRowTs: 1000,
        ledgerRowTid: 'turn-1',
        outcome: { kind: 'success' },
      },
    });

    it('returns legacy_unknown for historical rows with no costEntryId or outcome', () => {
      expect(resolveCostEntryOutcome({ ts: 1000, cost: 0.05 }, [])).toEqual({
        kind: 'legacy_unknown',
      });
    });

    it('joins late outcome resolution by costEntryId within the lag window', () => {
      expect(resolveCostEntryOutcome(
        { ts: 1000, cost: 0.05, costEntryId: 'test-cost-entry-id-1' },
        [resolutionEvent('test-cost-entry-id-1', 1500)],
        1500,
      )).toEqual({ kind: 'success' });
    });

    it('reads cost rows and applies rotation-aware diagnostic-event reader results', async () => {
      fs.writeFileSync(
        ledgerPath,
        `${JSON.stringify({ ts: 1000, cost: 0.05, costEntryId: 'test-cost-entry-id-2' })}\n`,
        'utf8',
      );
      const reader: DiagnosticEventsLedgerReader = {
        async readRecent() {
          return [resolutionEvent('test-cost-entry-id-2', 50_000)];
        },
      };
      setDiagnosticEventsLedgerReader(reader);

      const entries = await getCostEntriesWithResolvedOutcomes({ nowMs: 50_000 });

      expect(entries).toHaveLength(1);
      expect(entries[0].resolvedOutcome).toEqual({ kind: 'success' });
    });
  });
});
