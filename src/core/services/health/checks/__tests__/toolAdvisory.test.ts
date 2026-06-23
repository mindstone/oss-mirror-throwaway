import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DiagnosticEventEntry } from '@core/services/diagnostics/manifest';

const NOW_MS = 1_000_000_000_000;

const mocks = vi.hoisted(() => ({
  info: vi.fn(),
  readRecent: vi.fn(),
  flush: vi.fn(),
}));

 
vi.mock('@core/logger', () => ({
  createScopedLogger: () => ({
    info: mocks.info,
  }),
}));

 
vi.mock('@core/services/diagnosticEventsLedger', () => ({
  flushDiagnosticEventsLedger: mocks.flush,
  getDiagnosticEventsLedgerReader: () => ({ readRecent: mocks.readRecent }),
}));

import { checkToolAdvisoryHealth } from '../toolAdvisory';

function toolAdvisoryEvent(
  advisory: 'consecutive_error' | 'global_consecutive_error' | 'soft_budget' | 'hard_budget',
  ts = NOW_MS - 1_000,
): DiagnosticEventEntry {
  return {
    v: 1,
    ts,
    surface: 'desktop',
    kind: 'tool_advisory',
    data: { advisory, totalToolCalls: 3 },
  };
}

beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(NOW_MS);
  mocks.flush.mockResolvedValue(undefined);
  mocks.readRecent.mockResolvedValue([]);
  vi.clearAllMocks();
});

describe('checkToolAdvisoryHealth', () => {
  it('returns pass with empty counts when the ledger is empty', async () => {
    const result = await checkToolAdvisoryHealth();

    expect(result.status).toBe('pass');
    expect(result).toMatchObject({
      id: 'toolAdvisoryHealth',
      name: 'Tool Advisories',
      message: 'No tool advisories',
      details: { advisoryKindCounts: {} },
    });
  });

  it('returns pass with a count for three events of the same kind', async () => {
    mocks.readRecent.mockResolvedValue([
      toolAdvisoryEvent('hard_budget'),
      toolAdvisoryEvent('hard_budget'),
      toolAdvisoryEvent('hard_budget'),
    ]);

    const result = await checkToolAdvisoryHealth();

    expect(result.status).toBe('pass');
    expect(result.message).toContain('3 tool advisories');
    expect(result.details).toEqual({
      advisoryKindCounts: { hard_budget: 3 },
    });
  });

  it('returns pass with per-kind counts for mixed advisory kinds', async () => {
    mocks.readRecent.mockResolvedValue([
      toolAdvisoryEvent('soft_budget'),
      toolAdvisoryEvent('hard_budget'),
      toolAdvisoryEvent('global_consecutive_error'),
      toolAdvisoryEvent('soft_budget'),
    ]);

    const result = await checkToolAdvisoryHealth();

    expect(result.status).toBe('pass');
    expect(result.message).toContain('4 tool advisories');
    expect(result.details).toEqual({
      advisoryKindCounts: {
        soft_budget: 2,
        hard_budget: 1,
        global_consecutive_error: 1,
      },
    });
  });

  it('ignores events outside the ten-minute window', async () => {
    mocks.readRecent.mockResolvedValue([
      toolAdvisoryEvent('soft_budget', NOW_MS - 11 * 60_000),
      toolAdvisoryEvent('hard_budget', NOW_MS - 2_000),
    ]);

    const result = await checkToolAdvisoryHealth();

    expect(result.status).toBe('pass');
    expect(result.details).toEqual({
      advisoryKindCounts: { hard_budget: 1 },
    });
  });

  it('returns pass with empty counts when the ledger reader throws', async () => {
    mocks.readRecent.mockRejectedValue(new Error('ledger unavailable'));

    const result = await checkToolAdvisoryHealth();

    expect(result.status).toBe('pass');
    expect(result.message).toBe('No tool advisories');
    expect(result.details).toEqual({ advisoryKindCounts: {} });
    expect(mocks.info).toHaveBeenCalledWith(
      { err: expect.any(Error) },
      'tool advisory ledger read failed; returning empty advisoryKindCounts',
    );
  });
});
