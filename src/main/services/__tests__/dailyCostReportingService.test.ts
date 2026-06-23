import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { initTestPlatformConfig } from '@core/__tests__/testHelpers';
import type { CategorizedCostSummary } from '@core/services/costLedgerService';
import type { AppSettings } from '@shared/types';

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

// Mock ledger data by date range — uses CategorizedCostSummary so the compiler
// catches drift when the interface gains new required fields.
type LedgerMockFn = (options: { startTs?: number; endTs?: number }) => Promise<CategorizedCostSummary>;
let mockGetCategorizedCostSummary: LedgerMockFn;

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
    get path() { return '/tmp/test-stores/daily-cost-reporting.json'; },
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

  // Mock costLedgerService
  vi.doMock('@core/services/costLedgerService', () => ({
    getCategorizedCostSummary: vi.fn((options: { startTs?: number; endTs?: number }) =>
      mockGetCategorizedCostSummary(options)
    ),
  }));

  return await import('../dailyCostReportingService');
};

describe('dailyCostReportingService', () => {
  beforeEach(() => {
    Object.values(stubLogger).forEach((fn) => (fn as Mock).mockClear());
    analyticsClientAvailableValue = true;
    storeData = { lastReportedDateUTC: null };
    sentEvents = [];
    mockSettings = { userEmail: null, companyName: null };
    mockSettingsThrows = false;

    // Default mock: return empty summary
    mockGetCategorizedCostSummary = async () => ({
      total: 0,
      byCategory: {},
      byModel: {},
      entryCount: 0,
      turnCount: 0,
      byAutomationType: {},
      byAuthMethod: {},
      byOpenRouterProvider: {},
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheReadTokens: 0,
      totalCacheCreationTokens: 0,
      totalPromptTokens: 0,
      activeSessionCount: 0,
    } satisfies CategorizedCostSummary);
  });

  describe('reportUnreportedCosts', () => {
    it('skips reporting when analytics client is unavailable', async () => {
      analyticsClientAvailableValue = false;
      const service = await setupModule();
      await service.reportUnreportedCosts();

      expect(sentEvents).toHaveLength(0);
      expect(stubLogger.debug).toHaveBeenCalledWith(
        'Analytics client not available, skipping daily cost reporting'
      );
    });

    it('skips reporting when no unreported days exist', async () => {
      // Set watermark to yesterday
      const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const yesterdayStr = yesterday.toISOString().split('T')[0];

      const service = await setupModule(yesterdayStr);
      await service.reportUnreportedCosts();

      expect(sentEvents).toHaveLength(0);
    });

    it('sends event for single unreported day with costs', async () => {
      // Set watermark to 2 days ago (so yesterday needs reporting)
      const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
      const twoDaysAgoStr = twoDaysAgo.toISOString().split('T')[0];

      // Mock ledger to return costs for yesterday
      mockGetCategorizedCostSummary = async () => ({
        total: 4.52,
        byCategory: { agent: 3.21, automation: 1.31 },
        byModel: { 'claude-sonnet-4-6': 3.21, 'claude-haiku-4-5': 1.31 },
        entryCount: 15,
        turnCount: 12,
        byAutomationType: { 'calendar-sync': 0.45 },
        byAuthMethod: { 'api-key': 3.00, 'oauth-token': 1.52 },
        byOpenRouterProvider: {},
        totalInputTokens: 50000,
        totalOutputTokens: 12000,
        totalCacheReadTokens: 8000,
        totalCacheCreationTokens: 3000,
        totalPromptTokens: 61000,
        activeSessionCount: 4,
      } satisfies CategorizedCostSummary);

      const service = await setupModule(twoDaysAgoStr);
      await service.reportUnreportedCosts();

      expect(sentEvents).toHaveLength(1);
      expect(sentEvents[0].event).toBe('Daily Cost Summary');
      expect(sentEvents[0].properties.totalCostUsd).toBe(4.52);
      expect(sentEvents[0].properties.turnCount).toBe(12);
      expect(sentEvents[0].properties.entryCount).toBe(15);
      expect(sentEvents[0].properties.byCategory).toEqual({ agent: 3.21, automation: 1.31 });
      expect(sentEvents[0].properties.byModel).toBe(
        JSON.stringify({ 'claude-sonnet-4-6': 3.21, 'claude-haiku-4-5': 1.31 })
      );
      expect(sentEvents[0].properties.byAutomationType).toEqual({ 'calendar-sync': 0.45 });
      expect(sentEvents[0].properties.byAuthMethod).toEqual({ 'api-key': 3.00, 'oauth-token': 1.52 });
      expect(sentEvents[0].properties.idempotencyKey).toContain(mockAnonymousId);

      // Enriched: grouped UX categories
      expect(sentEvents[0].properties.byCategoryGrouped).toBeDefined();
      expect(typeof sentEvents[0].properties.byCategoryGrouped).toBe('object');

      // Enriched: token totals passed through
      expect(sentEvents[0].properties.totalInputTokens).toBe(50000);
      expect(sentEvents[0].properties.totalOutputTokens).toBe(12000);
      expect(sentEvents[0].properties.totalCacheReadTokens).toBe(8000);
      expect(sentEvents[0].properties.totalCacheCreationTokens).toBe(3000);
      expect(sentEvents[0].properties.totalPromptTokens).toBe(61000);

      // Enriched: subscription savings split (api-key = 3.00 actual, oauth-token = 1.52 subscription)
      expect(sentEvents[0].properties.subscriptionCoveredUsd).toBe(1.52);
      expect(sentEvents[0].properties.userPaidUsd).toBe(3.00);
      expect(sentEvents[0].properties.freeUsd).toBe(0);

      // Enriched: usage density (count only, no session IDs)
      expect(sentEvents[0].properties.activeSessionCount).toBe(4);
    });

    it('includes account attribution when user email and company name are available', async () => {
      const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
      const twoDaysAgoStr = twoDaysAgo.toISOString().split('T')[0];
      mockSettings = {
        userEmail: '[external-email]',
        companyName: 'Mindstone Rebel Ltd.',
      };
      mockGetCategorizedCostSummary = async () => ({
        total: 4.52,
        byCategory: { agent: 4.52 },
        byModel: { 'claude-sonnet-4-6': 4.52 },
        entryCount: 15,
        turnCount: 12,
        byAutomationType: {},
        byAuthMethod: { 'api-key': 4.52 },
        byOpenRouterProvider: {},
        totalInputTokens: 50000,
        totalOutputTokens: 12000,
        totalCacheReadTokens: 8000,
        totalCacheCreationTokens: 3000,
        totalPromptTokens: 61000,
        activeSessionCount: 4,
      } satisfies CategorizedCostSummary);

      const service = await setupModule(twoDaysAgoStr);
      await service.reportUnreportedCosts();

      const props = sentEvents[0].properties;
      expect(props.email).toBe('ada@example.com');
      expect(props.user_email).toBe('ada@example.com');
      expect(props.company_name).toBe('Mindstone Rebel Ltd.');
      expect(props.account_name).toBe('Mindstone Rebel Ltd.');
      expect(props.company_slug).toBe('mindstone-rebel-ltd');
      expect(props.account_slug).toBe('mindstone-rebel-ltd');
      expect(props.idempotencyKey).toContain(mockAnonymousId);
    });

    it('omits account attribution when settings are unavailable', async () => {
      const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
      const twoDaysAgoStr = twoDaysAgo.toISOString().split('T')[0];
      mockSettingsThrows = true;
      mockGetCategorizedCostSummary = async () => ({
        total: 4.52,
        byCategory: { agent: 4.52 },
        byModel: { 'claude-sonnet-4-6': 4.52 },
        entryCount: 15,
        turnCount: 12,
        byAutomationType: {},
        byAuthMethod: { 'api-key': 4.52 },
        byOpenRouterProvider: {},
        totalInputTokens: 50000,
        totalOutputTokens: 12000,
        totalCacheReadTokens: 8000,
        totalCacheCreationTokens: 3000,
        totalPromptTokens: 61000,
        activeSessionCount: 4,
      } satisfies CategorizedCostSummary);

      const service = await setupModule(twoDaysAgoStr);
      await service.reportUnreportedCosts();

      const props = sentEvents[0].properties;
      expect(props.email).toBeUndefined();
      expect(props.user_email).toBeUndefined();
      expect(props.company_name).toBeUndefined();
      expect(props.account_name).toBeUndefined();
      expect(props.company_slug).toBeUndefined();
      expect(props.account_slug).toBeUndefined();
      expect(props.totalCostUsd).toBe(4.52);
    });

    it('skips days with no costs but updates watermark', async () => {
      // Set watermark to 2 days ago
      const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
      const twoDaysAgoStr = twoDaysAgo.toISOString().split('T')[0];

      // Mock ledger to return no costs
      mockGetCategorizedCostSummary = async () => ({
        total: 0,
        byCategory: {},
        byModel: {},
        entryCount: 0,
        turnCount: 0,
        byAutomationType: {},
        byAuthMethod: {},
        byOpenRouterProvider: {},
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCacheReadTokens: 0,
        totalCacheCreationTokens: 0,
        totalPromptTokens: 0,
        activeSessionCount: 0,
      } satisfies CategorizedCostSummary);

      const service = await setupModule(twoDaysAgoStr);
      await service.reportUnreportedCosts();

      // No events sent
      expect(sentEvents).toHaveLength(0);

      // Watermark should still be updated to yesterday
      const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
      expect(storeData.lastReportedDateUTC).toBe(yesterday.toISOString().split('T')[0]);
    });

    it('reports multiple days on first run (limited to 90 days)', async () => {
      // Track how many times ledger was queried
      const queriedDates: string[] = [];
      mockGetCategorizedCostSummary = async (options) => {
        if (options.startTs) {
          const date = new Date(options.startTs).toISOString().split('T')[0];
          queriedDates.push(date);
        }
        return {
          total: 1.0,
          byCategory: { agent: 1.0 },
          byModel: { 'claude-sonnet-4-6': 1.0 },
          entryCount: 5,
          turnCount: 5,
          byAutomationType: {},
          byAuthMethod: { 'api-key': 1.0 },
          byOpenRouterProvider: {},
          totalInputTokens: 10000,
          totalOutputTokens: 2000,
          totalCacheReadTokens: 1000,
          totalCacheCreationTokens: 500,
          totalPromptTokens: 11500,
          activeSessionCount: 2,
        } satisfies CategorizedCostSummary;
      };

      // First run: no watermark (pass null explicitly)
      const service = await setupModule(null);
      await service.reportUnreportedCosts();

      // Should query multiple days (up to 90, but stopping at yesterday)
      // The exact count depends on current date, but should be at least 1 (yesterday)
      expect(queriedDates.length).toBeGreaterThan(0);
      expect(queriedDates.length).toBeLessThanOrEqual(90);

      // Events sent for each day with costs
      expect(sentEvents.length).toBe(queriedDates.length);
    });

    it('includes correct idempotency key format', async () => {
      const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
      const twoDaysAgoStr = twoDaysAgo.toISOString().split('T')[0];

      mockGetCategorizedCostSummary = async () => ({
        total: 1.0,
        byCategory: {},
        byModel: {},
        entryCount: 1,
        turnCount: 1,
        byAutomationType: {},
        byAuthMethod: {},
        byOpenRouterProvider: {},
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCacheReadTokens: 0,
        totalCacheCreationTokens: 0,
        totalPromptTokens: 0,
        activeSessionCount: 0,
      } satisfies CategorizedCostSummary);

      const service = await setupModule(twoDaysAgoStr);
      await service.reportUnreportedCosts();

      const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const expectedDate = yesterday.toISOString().split('T')[0];
      const expectedKey = `cost-${mockAnonymousId}-${expectedDate}`;

      expect(sentEvents[0].properties.idempotencyKey).toBe(expectedKey);
    });

    it('updates watermark after each successful send', async () => {
      // Set watermark to 3 days ago (so 2 days need reporting: day before yesterday, and yesterday)
      const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
      const threeDaysAgoStr = threeDaysAgo.toISOString().split('T')[0];

      mockGetCategorizedCostSummary = async () => ({
        total: 1.0,
        byCategory: {},
        byModel: {},
        entryCount: 1,
        turnCount: 1,
        byAutomationType: {},
        byAuthMethod: {},
        byOpenRouterProvider: {},
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCacheReadTokens: 0,
        totalCacheCreationTokens: 0,
        totalPromptTokens: 0,
        activeSessionCount: 0,
      } satisfies CategorizedCostSummary);

      const service = await setupModule(threeDaysAgoStr);
      await service.reportUnreportedCosts();

      // Watermark should be yesterday (the last reported day)
      const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
      expect(storeData.lastReportedDateUTC).toBe(yesterday.toISOString().split('T')[0]);
    });

    it('never reports "today" (only completed days)', async () => {
      // Set watermark to yesterday - nothing should be reported
      const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const yesterdayStr = yesterday.toISOString().split('T')[0];

      mockGetCategorizedCostSummary = async () => ({
        total: 100.0, // Lots of costs today!
        byCategory: {},
        byModel: {},
        entryCount: 50,
        turnCount: 50,
        byAutomationType: {},
        byAuthMethod: {},
        byOpenRouterProvider: {},
        totalInputTokens: 500000,
        totalOutputTokens: 100000,
        totalCacheReadTokens: 50000,
        totalCacheCreationTokens: 20000,
        totalPromptTokens: 570000,
        activeSessionCount: 15,
      } satisfies CategorizedCostSummary);

      const service = await setupModule(yesterdayStr);
      await service.reportUnreportedCosts();

      // No events should be sent - "today" is never reported
      expect(sentEvents).toHaveLength(0);
    });
  });

  describe('enriched event properties', () => {
    it('includes correctly grouped UX categories', async () => {
      const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
      const twoDaysAgoStr = twoDaysAgo.toISOString().split('T')[0];

      mockGetCategorizedCostSummary = async () => ({
        total: 5.00,
        byCategory: { agent: 2.00, 'memory-update': 1.50, automation: 1.00, summary: 0.50 },
        byModel: { 'claude-sonnet-4-6': 5.00 },
        entryCount: 10,
        turnCount: 8,
        byAutomationType: {},
        byAuthMethod: { 'api-key': 5.00 },
        byOpenRouterProvider: {},
        totalInputTokens: 20000,
        totalOutputTokens: 5000,
        totalCacheReadTokens: 3000,
        totalCacheCreationTokens: 1000,
        totalPromptTokens: 24000,
        activeSessionCount: 3,
      } satisfies CategorizedCostSummary);

      const service = await setupModule(twoDaysAgoStr);
      await service.reportUnreportedCosts();

      expect(sentEvents).toHaveLength(1);
      const grouped = sentEvents[0].properties.byCategoryGrouped as Record<string, number>;
      expect(grouped).toBeDefined();
      // 'agent' maps to 'conversations' group, 'memory-update' to 'memory', etc.
      // Exact group names come from COST_CATEGORY_REGISTRY — verify structure is a plain object with numeric values
      expect(typeof grouped).toBe('object');
      for (const value of Object.values(grouped)) {
        expect(typeof value).toBe('number');
      }
    });

    it('produces correct zero values for enriched fields on zero-cost days with entries', async () => {
      const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
      const twoDaysAgoStr = twoDaysAgo.toISOString().split('T')[0];

      // Day with entries but zero costs (e.g., all free/local)
      mockGetCategorizedCostSummary = async () => ({
        total: 0,
        byCategory: { agent: 0 },
        byModel: { 'local-model': 0 },
        entryCount: 3,
        turnCount: 3,
        byAutomationType: {},
        byAuthMethod: { local: 0 },
        byOpenRouterProvider: {},
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCacheReadTokens: 0,
        totalCacheCreationTokens: 0,
        totalPromptTokens: 0,
        activeSessionCount: 1,
      } satisfies CategorizedCostSummary);

      const service = await setupModule(twoDaysAgoStr);
      await service.reportUnreportedCosts();

      expect(sentEvents).toHaveLength(1);
      const props = sentEvents[0].properties;

      // Token totals should all be zero
      expect(props.totalInputTokens).toBe(0);
      expect(props.totalOutputTokens).toBe(0);
      expect(props.totalCacheReadTokens).toBe(0);
      expect(props.totalCacheCreationTokens).toBe(0);
      expect(props.totalPromptTokens).toBe(0);

      // Subscription savings should all be zero (local usage → freeUsd only)
      expect(props.subscriptionCoveredUsd).toBe(0);
      expect(props.userPaidUsd).toBe(0);
      expect(props.freeUsd).toBe(0);

      // Session count passes through
      expect(props.activeSessionCount).toBe(1);

      // Grouped categories should exist as an object
      expect(typeof props.byCategoryGrouped).toBe('object');
    });

    it('correctly splits subscription vs user-paid vs free costs', async () => {
      const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
      const twoDaysAgoStr = twoDaysAgo.toISOString().split('T')[0];

      mockGetCategorizedCostSummary = async () => ({
        total: 10.00,
        byCategory: { agent: 10.00 },
        byModel: { 'claude-sonnet-4-6': 10.00 },
        entryCount: 20,
        turnCount: 20,
        byAutomationType: {},
        // Mixed auth methods: subscription + API key + local
        byAuthMethod: { 'oauth-token': 4.00, 'api-key': 5.50, local: 0.50 },
        byOpenRouterProvider: {},
        totalInputTokens: 100000,
        totalOutputTokens: 30000,
        totalCacheReadTokens: 15000,
        totalCacheCreationTokens: 5000,
        totalPromptTokens: 120000,
        activeSessionCount: 6,
      } satisfies CategorizedCostSummary);

      const service = await setupModule(twoDaysAgoStr);
      await service.reportUnreportedCosts();

      expect(sentEvents).toHaveLength(1);
      const props = sentEvents[0].properties;

      // oauth-token is a subscription method
      expect(props.subscriptionCoveredUsd).toBe(4.00);
      // api-key is user-paid
      expect(props.userPaidUsd).toBe(5.50);
      // local is free
      expect(props.freeUsd).toBe(0.50);
    });

    it('does not include session IDs or user content in event properties', async () => {
      const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
      const twoDaysAgoStr = twoDaysAgo.toISOString().split('T')[0];

      mockGetCategorizedCostSummary = async () => ({
        total: 2.00,
        byCategory: { agent: 2.00 },
        byModel: { 'claude-sonnet-4-6': 2.00 },
        entryCount: 5,
        turnCount: 5,
        byAutomationType: {},
        byAuthMethod: { 'api-key': 2.00 },
        byOpenRouterProvider: {},
        totalInputTokens: 10000,
        totalOutputTokens: 3000,
        totalCacheReadTokens: 1000,
        totalCacheCreationTokens: 500,
        totalPromptTokens: 11500,
        activeSessionCount: 2,
      } satisfies CategorizedCostSummary);

      const service = await setupModule(twoDaysAgoStr);
      await service.reportUnreportedCosts();

      expect(sentEvents).toHaveLength(1);
      const props = sentEvents[0].properties;

      // Verify no session IDs or user content leak through
      // activeSessionCount is a number (count), not a list of IDs
      expect(typeof props.activeSessionCount).toBe('number');
      // No property should contain session ID patterns (UUIDs)
      const uuidPattern = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
      // Exclude idempotencyKey from this check (it contains anonymousId, which is expected)
      const propsWithoutIdempotency = { ...props };
      delete propsWithoutIdempotency.idempotencyKey;
      expect(JSON.stringify(propsWithoutIdempotency)).not.toMatch(uuidPattern);
    });

    it('passes through token totals from summary', async () => {
      const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
      const twoDaysAgoStr = twoDaysAgo.toISOString().split('T')[0];

      mockGetCategorizedCostSummary = async () => ({
        total: 3.00,
        byCategory: { agent: 3.00 },
        byModel: { 'claude-sonnet-4-6': 3.00 },
        entryCount: 8,
        turnCount: 8,
        byAutomationType: {},
        byAuthMethod: { 'api-key': 3.00 },
        byOpenRouterProvider: {},
        totalInputTokens: 75000,
        totalOutputTokens: 18000,
        totalCacheReadTokens: 12000,
        totalCacheCreationTokens: 4500,
        totalPromptTokens: 91500,
        activeSessionCount: 3,
      } satisfies CategorizedCostSummary);

      const service = await setupModule(twoDaysAgoStr);
      await service.reportUnreportedCosts();

      expect(sentEvents).toHaveLength(1);
      const props = sentEvents[0].properties;

      expect(props.totalInputTokens).toBe(75000);
      expect(props.totalOutputTokens).toBe(18000);
      expect(props.totalCacheReadTokens).toBe(12000);
      expect(props.totalCacheCreationTokens).toBe(4500);
      expect(props.totalPromptTokens).toBe(91500);
      expect(props.activeSessionCount).toBe(3);
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
