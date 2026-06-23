import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { initTestPlatformConfig } from '@core/__tests__/testHelpers';
import type { AppSettings } from '@shared/types';
import type { TimeSavedEntry, TimeSavedStoreState } from '../timeSavedStore';

// Stub logger
const stubLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn(),
};

// Track sent analytics events
let sentEvents: Array<{ event: string; properties: Record<string, unknown> }> = [];
let analyticsClientAvailableValue = true;
const mockAnonymousId = 'test-anonymous-id-123';
let mockSettings: { userEmail: string | null; companyName?: string | null } = {
  userEmail: null,
  companyName: null,
};
let mockSettingsThrows = false;

// In-memory store data
let storeData: { lastReportedDateUTC: string | null } = { lastReportedDateUTC: null };

// Mock time-saved entries
let mockTimeSavedEntries: TimeSavedEntry[] = [];

const createMockEntry = (
  timestamp: number,
  sessionId: string,
  lowMinutes: number,
  highMinutes: number,
  taskType: 'research' | 'writing' | 'coordination' | 'analysis' | 'automation' | 'mixed' = 'research',
  confidence: 'low' | 'medium' | 'high' = 'medium',
  impact?: 'trivial' | 'low' | 'medium' | 'high' | 'critical'
): TimeSavedEntry => ({
  turnId: `turn-${Date.now()}-${Math.random()}`,
  sessionId,
  timestamp,
  estimate: {
    lowMinutes,
    highMinutes,
    taskType,
    confidence,
    reasoning: 'Test reasoning',
    ...(impact !== undefined ? { impact } : {}),
  },
});

const setupModule = async (initialWatermark: string | null = null) => {
  vi.resetModules();
  await initTestPlatformConfig();
  const { setSettingsStoreAdapter } = await import('@core/services/settingsStore');
  setSettingsStoreAdapter({
    getSettings: () => {
      if (mockSettingsThrows) throw new Error('settings unavailable');
      return mockSettings as AppSettings;
    },
    updateSettings: (partial: Partial<AppSettings>) => {
      mockSettings = {
        ...mockSettings,
        userEmail: partial.userEmail ?? mockSettings.userEmail,
        companyName: partial.companyName ?? mockSettings.companyName,
      };
    },
    updateSettingsAtomic: (updater: (current: AppSettings) => Partial<AppSettings>) => {
      const partial = updater(mockSettings as AppSettings);
      mockSettings = {
        ...mockSettings,
        userEmail: partial.userEmail ?? mockSettings.userEmail,
        companyName: partial.companyName ?? mockSettings.companyName,
      };
    },
    onSettingsChange: () => () => undefined,
  });
  sentEvents = [];
  storeData = { lastReportedDateUTC: initialWatermark };

  // Override StoreFactory to use test-controlled storeData
  const { setStoreFactory } = await import('@core/storeFactory');
  setStoreFactory(() => ({
    get: (key: string) => storeData[key as keyof typeof storeData],
    set: (key: string, value: unknown) => {
      storeData[key as keyof typeof storeData] = value as (typeof storeData)[keyof typeof storeData];
    },
    has: (key: string) => key in storeData,
    delete: (key: string) => {
      storeData[key as keyof typeof storeData] = null as (typeof storeData)[keyof typeof storeData];
    },
    clear: () => { storeData = { lastReportedDateUTC: null }; },
    get store() { return storeData; },
    set store(v: Record<string, unknown>) { Object.assign(storeData, v); },
    get path() { return '/tmp/test-stores/daily-time-saved-reporting.json'; },
  }) as any);

  // Mock logger
  vi.doMock('@core/logger', () => ({ createScopedLogger: () => stubLogger }));

  // Mock tracking
  vi.doMock('@core/tracking', async (importOriginal) => ({
    ...(await importOriginal()),
    getTracker: () => ({
      track: vi.fn((event: string, properties: Record<string, unknown>) => {
        sentEvents.push({ event, properties });
      }),
      identify: vi.fn(),
      getAnonymousId: () => mockAnonymousId,
      isAvailable: () => analyticsClientAvailableValue,
    }),
  }));

  // Mock timeSavedStore
  vi.doMock('@core/services/timeSavedStore', () => ({
    getTimeSavedState: (): TimeSavedStoreState => ({
      version: 3,
      entries: mockTimeSavedEntries,
      aggregates: {
        currentWeek: { weekStartDate: '', totalMinutes: 0, sessionCount: 0 },
        lastWeek: { weekStartDate: '', totalMinutes: 0, sessionCount: 0 },
        currentMonth: { totalMinutes: 0, sessionCount: 0 },
        allTime: { totalMinutes: 0, sessionCount: 0 },
      },
      acknowledgedMilestones: [],
      hasSeenFirstEstimate: false,
      dailyTotals: {},
      firstBigWinShown: false,
      firstWeekShown: false,
    }),
    getWeightedMidpoint: (estimate: { lowMinutes: number; highMinutes: number; impact?: string }) => {
      const raw = (estimate.lowMinutes + estimate.highMinutes) / 2;
      // For tests, entries without impact are treated as 'unknown' → 1.0x
      const multipliers: Record<string, number> = { trivial: 0, low: 0.5, medium: 1.0, high: 1.25, critical: 1.5, unknown: 1.0 };
      return raw * (multipliers[estimate.impact ?? 'unknown'] ?? 1.0);
    },
    getRawMidpoint: (estimate: { lowMinutes: number; highMinutes: number }) => {
      return (estimate.lowMinutes + estimate.highMinutes) / 2;
    },
  }));

  return await import('../dailyTimeSavedReportingService');
};

describe('dailyTimeSavedReportingService', () => {
  beforeEach(() => {
    Object.values(stubLogger).forEach((fn) => (fn as Mock).mockClear());
    analyticsClientAvailableValue = true;
    storeData = { lastReportedDateUTC: null };
    sentEvents = [];
    mockTimeSavedEntries = [];
    mockSettings = { userEmail: null, companyName: null };
    mockSettingsThrows = false;
  });

  describe('reportUnreportedTimeSaved', () => {
    it('skips reporting when analytics client is unavailable', async () => {
      analyticsClientAvailableValue = false;
      const service = await setupModule();
      await service.reportUnreportedTimeSaved();

      expect(sentEvents).toHaveLength(0);
      expect(stubLogger.debug).toHaveBeenCalledWith(
        'Analytics client not available, skipping daily time-saved reporting'
      );
    });

    it('skips reporting when no time-saved entries exist', async () => {
      mockTimeSavedEntries = [];
      const service = await setupModule();
      await service.reportUnreportedTimeSaved();

      expect(sentEvents).toHaveLength(0);
      expect(stubLogger.debug).toHaveBeenCalledWith('No time-saved entries, skipping reporting');
    });

    it('skips reporting when no unreported days exist', async () => {
      // Set watermark to yesterday
      const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const yesterdayStr = yesterday.toISOString().split('T')[0];

      // Add entry for today (which should never be reported)
      mockTimeSavedEntries = [createMockEntry(Date.now(), 'session-1', 10, 20)];

      const service = await setupModule(yesterdayStr);
      await service.reportUnreportedTimeSaved();

      expect(sentEvents).toHaveLength(0);
    });

    it('sends event for single unreported day with entries', async () => {
      // Set watermark to 2 days ago (so yesterday needs reporting)
      const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
      const twoDaysAgoStr = twoDaysAgo.toISOString().split('T')[0];

      // Add entries for yesterday
      const yesterday = Date.now() - 24 * 60 * 60 * 1000;
      mockTimeSavedEntries = [
        createMockEntry(yesterday, 'session-1', 10, 20, 'research', 'medium'),
        createMockEntry(yesterday, 'session-2', 30, 50, 'writing', 'high'),
      ];

      const service = await setupModule(twoDaysAgoStr);
      await service.reportUnreportedTimeSaved();

      expect(sentEvents).toHaveLength(1);
      expect(sentEvents[0].event).toBe('Daily Time Saved Summary');

      const props = sentEvents[0].properties;
      // Midpoints: (10+20)/2=15, (30+50)/2=40 => total 55
      expect(props.totalMinutes).toBe(55);
      expect(props.lowMinutes).toBe(40); // 10 + 30
      expect(props.highMinutes).toBe(70); // 20 + 50
      expect(props.entryCount).toBe(2);
      expect(props.sessionCount).toBe(2);

      // Task type breakdown (midpoint minutes)
      expect((props.byTaskType as Record<string, number>).research).toBe(15);
      expect((props.byTaskType as Record<string, number>).writing).toBe(40);

      // Confidence breakdown (midpoint minutes)
      expect((props.byConfidence as Record<string, number>).medium).toBe(15);
      expect((props.byConfidence as Record<string, number>).high).toBe(40);

      expect(props.idempotencyKey).toContain(mockAnonymousId);
    });

    it('includes account attribution when user email and company name are available', async () => {
      const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
      const twoDaysAgoStr = twoDaysAgo.toISOString().split('T')[0];
      const yesterday = Date.now() - 24 * 60 * 60 * 1000;
      mockSettings = {
        userEmail: '[external-email]',
        companyName: 'Mindstone Rebel Ltd.',
      };
      mockTimeSavedEntries = [createMockEntry(yesterday, 'session-1', 10, 20)];

      const service = await setupModule(twoDaysAgoStr);
      await service.reportUnreportedTimeSaved();

      const props = sentEvents[0].properties;
      expect(props.email).toBe('ada@example.com');
      expect(props.user_email).toBe('ada@example.com');
      expect(props.company_name).toBe('Mindstone Rebel Ltd.');
      expect(props.account_name).toBe('Mindstone Rebel Ltd.');
      expect(props.company_slug).toBe('mindstone-rebel-ltd');
      expect(props.account_slug).toBe('mindstone-rebel-ltd');
    });

    it('omits account attribution when settings are unavailable', async () => {
      const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
      const twoDaysAgoStr = twoDaysAgo.toISOString().split('T')[0];
      const yesterday = Date.now() - 24 * 60 * 60 * 1000;
      mockSettingsThrows = true;
      mockTimeSavedEntries = [createMockEntry(yesterday, 'session-1', 10, 20)];

      const service = await setupModule(twoDaysAgoStr);
      await service.reportUnreportedTimeSaved();

      const props = sentEvents[0].properties;
      expect(props.email).toBeUndefined();
      expect(props.user_email).toBeUndefined();
      expect(props.company_name).toBeUndefined();
      expect(props.account_name).toBeUndefined();
      expect(props.company_slug).toBeUndefined();
      expect(props.account_slug).toBeUndefined();
      expect(props.totalMinutes).toBeGreaterThan(0);
    });

    it('counts unique sessions correctly', async () => {
      const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
      const twoDaysAgoStr = twoDaysAgo.toISOString().split('T')[0];

      // Add multiple entries from the same session
      const yesterday = Date.now() - 24 * 60 * 60 * 1000;
      mockTimeSavedEntries = [
        createMockEntry(yesterday, 'session-1', 10, 20),
        createMockEntry(yesterday, 'session-1', 15, 25), // Same session
        createMockEntry(yesterday, 'session-2', 20, 30),
      ];

      const service = await setupModule(twoDaysAgoStr);
      await service.reportUnreportedTimeSaved();

      const props = sentEvents[0].properties;
      expect(props.entryCount).toBe(3);
      expect(props.sessionCount).toBe(2); // Only 2 unique sessions
    });

    it('skips days with no entries but updates watermark', async () => {
      const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
      const twoDaysAgoStr = twoDaysAgo.toISOString().split('T')[0];

      // Add entry only for today (not yesterday)
      mockTimeSavedEntries = [createMockEntry(Date.now(), 'session-1', 10, 20)];

      const service = await setupModule(twoDaysAgoStr);
      await service.reportUnreportedTimeSaved();

      // No events sent
      expect(sentEvents).toHaveLength(0);

      // Watermark should still be updated to yesterday
      const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
      expect(storeData.lastReportedDateUTC).toBe(yesterday.toISOString().split('T')[0]);
    });

    it('includes correct idempotency key format', async () => {
      const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
      const twoDaysAgoStr = twoDaysAgo.toISOString().split('T')[0];

      const yesterday = Date.now() - 24 * 60 * 60 * 1000;
      mockTimeSavedEntries = [createMockEntry(yesterday, 'session-1', 10, 20)];

      const service = await setupModule(twoDaysAgoStr);
      await service.reportUnreportedTimeSaved();

      const yesterdayDate = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const expectedDate = yesterdayDate.toISOString().split('T')[0];
      const expectedKey = `time-saved-${mockAnonymousId}-${expectedDate}`;

      expect(sentEvents[0].properties.idempotencyKey).toBe(expectedKey);
    });

    it('updates watermark after each successful send', async () => {
      // Set watermark to 3 days ago
      const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
      const threeDaysAgoStr = threeDaysAgo.toISOString().split('T')[0];

      // Add entries for both days that need reporting
      const twoDaysAgo = Date.now() - 2 * 24 * 60 * 60 * 1000;
      const yesterday = Date.now() - 24 * 60 * 60 * 1000;
      mockTimeSavedEntries = [
        createMockEntry(twoDaysAgo, 'session-1', 10, 20),
        createMockEntry(yesterday, 'session-2', 10, 20),
      ];

      const service = await setupModule(threeDaysAgoStr);
      await service.reportUnreportedTimeSaved();

      // Watermark should be yesterday (the last reported day)
      const yesterdayDate = new Date(Date.now() - 24 * 60 * 60 * 1000);
      expect(storeData.lastReportedDateUTC).toBe(yesterdayDate.toISOString().split('T')[0]);
    });

    it('never reports "today" (only completed days)', async () => {
      // Set watermark to yesterday - nothing should be reported
      const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const yesterdayStr = yesterday.toISOString().split('T')[0];

      // Add entries for today
      mockTimeSavedEntries = [createMockEntry(Date.now(), 'session-1', 100, 200)];

      const service = await setupModule(yesterdayStr);
      await service.reportUnreportedTimeSaved();

      // No events should be sent - "today" is never reported
      expect(sentEvents).toHaveLength(0);
    });

    it('includes impact calibration signals in event', async () => {
      const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
      const twoDaysAgoStr = twoDaysAgo.toISOString().split('T')[0];

      const yesterday = Date.now() - 24 * 60 * 60 * 1000;
      // critical impact (1.5x): midpoint = 30, weighted = 45
      // medium impact (1.0x): midpoint = 15, weighted = 15
      // total raw = 45, total weighted = 60, ratio = 60/45 = 1.33
      mockTimeSavedEntries = [
        createMockEntry(yesterday, 'session-1', 20, 40, 'research', 'high', 'critical'),
        createMockEntry(yesterday, 'session-2', 10, 20, 'writing', 'medium', 'medium'),
      ];

      const service = await setupModule(twoDaysAgoStr);
      await service.reportUnreportedTimeSaved();

      const props = sentEvents[0].properties;
      expect(props.rawMinutes).toBe(45); // 30 + 15
      expect(props.totalMinutes).toBe(60); // 45 + 15
      expect(props.impactWeightingRatio).toBe(1.33); // 60/45 rounded
      expect(props.lowConfidenceShare).toBe(0); // no low-confidence entries
      expect(props.highImpactSessionCount).toBe(1); // session-1 has critical
    });

    it('tracks lowConfidenceShare correctly', async () => {
      const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
      const twoDaysAgoStr = twoDaysAgo.toISOString().split('T')[0];

      const yesterday = Date.now() - 24 * 60 * 60 * 1000;
      // low confidence: midpoint = 20
      // high confidence: midpoint = 30
      // total raw = 50, low confidence share = 20/50 = 0.4
      mockTimeSavedEntries = [
        createMockEntry(yesterday, 'session-1', 10, 30, 'research', 'low'),
        createMockEntry(yesterday, 'session-2', 20, 40, 'writing', 'high'),
      ];

      const service = await setupModule(twoDaysAgoStr);
      await service.reportUnreportedTimeSaved();

      const props = sentEvents[0].properties;
      expect(props.lowConfidenceShare).toBe(0.4);
    });

    it('includes byImpact breakdown in event', async () => {
      const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
      const twoDaysAgoStr = twoDaysAgo.toISOString().split('T')[0];

      const yesterday = Date.now() - 24 * 60 * 60 * 1000;
      mockTimeSavedEntries = [
        createMockEntry(yesterday, 'session-1', 20, 40, 'research', 'high', 'critical'),
        createMockEntry(yesterday, 'session-2', 10, 20, 'writing', 'medium', 'low'),
      ];

      const service = await setupModule(twoDaysAgoStr);
      await service.reportUnreportedTimeSaved();

      const props = sentEvents[0].properties;
      const byImpact = props.byImpact as Record<string, number>;
      expect(byImpact.critical).toBe(30); // raw midpoint of critical entry
      expect(byImpact.low).toBe(15); // raw midpoint of low entry
      expect(byImpact.medium).toBe(0);
    });

    it('does not include reasoning field in event (privacy)', async () => {
      const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
      const twoDaysAgoStr = twoDaysAgo.toISOString().split('T')[0];

      const yesterday = Date.now() - 24 * 60 * 60 * 1000;
      mockTimeSavedEntries = [createMockEntry(yesterday, 'session-1', 10, 20)];

      const service = await setupModule(twoDaysAgoStr);
      await service.reportUnreportedTimeSaved();

      // Reasoning should NOT be in the event properties
      expect(sentEvents[0].properties).not.toHaveProperty('reasoning');
      // And not nested anywhere in byTaskType or byConfidence either
    });
  });

  describe('testing helpers', () => {
    it('can reset watermark for testing', async () => {
      const service = await setupModule('2026-01-15');

      service._resetWatermarkForTesting();
      expect(service._getWatermarkForTesting()).toBeNull();
    });

    it('can set watermark for testing', async () => {
      const service = await setupModule(null);

      service._setWatermarkForTesting('2026-01-20');
      expect(service._getWatermarkForTesting()).toBe('2026-01-20');
    });
  });
});
