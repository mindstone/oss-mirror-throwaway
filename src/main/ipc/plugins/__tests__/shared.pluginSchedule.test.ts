/**
 * BLOCKER 5 #4 (R6 Stage 2 refinement): plugin schedule converter
 * `pluginScheduleToAutomationSchedule()` must return `null` (not throw)
 * when fromUntrusted rejects the candidate, and must emit a structured warn
 * log without leaking secrets.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Hoisted mocks: vi.mock is hoisted to the top, so any captured reference
// inside the factory must be created via vi.hoisted().
const { mockWarn } = vi.hoisted(() => ({ mockWarn: vi.fn() }));
 
vi.mock('@core/logger', () => ({
  createScopedLogger: () => ({
    info: vi.fn(),
    warn: mockWarn,
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
  }),
  logger: {
    info: vi.fn(),
    warn: mockWarn,
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
  },
}));

import { pluginScheduleToAutomationSchedule } from '../shared';

describe('pluginScheduleToAutomationSchedule — failure path', () => {
  beforeEach(() => {
    mockWarn.mockReset();
  });

  it('returns null on cron type (unsupported)', () => {
    const result = pluginScheduleToAutomationSchedule({
      type: 'cron',
      value: '*/5 * * * *',
    });
    expect(result).toBeNull();
  });

  it('returns null on bogus interval syntax', () => {
    const result = pluginScheduleToAutomationSchedule({
      type: 'interval',
      value: 'totally invalid',
    });
    expect(result).toBeNull();
  });

  it('returns null on zero interval', () => {
    const result = pluginScheduleToAutomationSchedule({
      type: 'interval',
      value: '0h',
    });
    expect(result).toBeNull();
  });

  it('returns null on negative interval', () => {
    // The pre-regex captures only digits, so "-1h" doesn't match → null
    const result = pluginScheduleToAutomationSchedule({
      type: 'interval',
      value: '-1h',
    });
    expect(result).toBeNull();
  });

  it('happy path: interval "1h" produces hourly schedule', () => {
    const result = pluginScheduleToAutomationSchedule({
      type: 'interval',
      value: '1h',
    });
    expect(result).not.toBeNull();
    expect(result?.type).toBe('hourly');
  });

  it('happy path: interval "1d" produces daily schedule', () => {
    const result = pluginScheduleToAutomationSchedule({
      type: 'interval',
      value: '1d',
    });
    expect(result).not.toBeNull();
    expect(result?.type).toBe('daily');
  });

  it('happy path: interval "3d" produces every_n_days with anchorDate', () => {
    const result = pluginScheduleToAutomationSchedule({
      type: 'interval',
      value: '3d',
    });
    expect(result).not.toBeNull();
    expect(result?.type).toBe('every_n_days');
    if (result?.type === 'every_n_days') {
      expect(result.intervalDays).toBe(3);
      expect(result.time).toBe('09:00');
      expect(result.anchorDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });
});
