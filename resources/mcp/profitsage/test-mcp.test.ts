/**
 * ProfitSage MCP Mock Tests
 *
 * Verifies tool behavior with mocked HTTP responses — no real credentials needed.
 * Uses the shared mock API harness to intercept ProfitSage API calls.
 *
 * Test plan:
 *   - token exchange happens once and is cached for subsequent calls
 *   - token refreshes automatically on 401
 *   - list_sites / list_data_sets / get_daily_labor shape correctly
 *   - date conversion YYYY-MM-DD → MM/dd/yyyy
 *   - subdomain validation rejects malformed input
 *   - missing credentials surface a CONFIG_MISSING error
 *
 * Run: npx vitest run resources/mcp/profitsage/test-mcp.test.ts
 */

import { it, expect, beforeAll, afterAll } from 'vitest';
import {
  createMcpTestClientWithMockApi,
  describeBundledMcp,
  resolveServerScript,
  type McpTestClient,
  type MockApiServer,
} from '../../../scripts/mcp-test-harness';

const SUBDOMAIN = 'testtenant';
const TEST_DOMAIN = `${SUBDOMAIN}.profitsage.net`;

const mockSites = [
  { siteTag: '100', siteName: 'Test Hotel One', siteCity: 'Denver', siteState: 'CO' },
  { siteTag: '200', siteName: 'Test Hotel Two', siteCity: 'Austin', siteState: 'TX' },
];

const mockDataSets = [{ dataSetID: '1', description: 'Primary Forecast' }];

const mockDailyLabor = [
  {
    siteTag: '100',
    siteName: 'Test Hotel One',
    personID: 111,
    date: '2025-03-01',
    'employee ID': '111',
    hours: '2.25',
    amounts: '123.04',
    type: 'Regular',
    label: 'Rooms-Bell Person-Regular',
  },
];

const mockAccountClasses = [{ classID: 'GREV', description: 'Revenue' }];
const mockDailyExtended = [{ siteTag: '100', account: '4000', amount: 1000 }];
const mockMonthlyExtended = [{ siteTag: '100', account: '4000', month: 3, amount: 30000 }];
const mockLedgerBatches = [{ batchID: 'B-1', siteTag: '100', status: 'E', typeID: 'AR' }];
const mockSalesBookings = [{ bookingID: 'BK-1', siteTag: '100', marketSeg: 'GROUP' }];
const mockSalesPace = [{ siteTag: '100', pace: 42 }];

function makeRoutes(opts: { tokenCount?: { n: number }; alwaysExpireOnce?: { done: boolean } } = {}) {
  return [
    {
      method: 'POST' as const,
      path: '/PS-Handlers/token',
      handler: () => {
        if (opts.tokenCount) opts.tokenCount.n++;
        return {
          body: {
            access_token: `tok-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            token_type: 'bearer',
            expires_in: 3599,
          },
        };
      },
    },
    {
      method: 'GET' as const,
      path: '/PS-Handlers/api/DataPortalv3/Sites',
      handler: () => {
        // Simulate a single 401 to validate automatic token refresh, then succeed.
        if (opts.alwaysExpireOnce && !opts.alwaysExpireOnce.done) {
          opts.alwaysExpireOnce.done = true;
          return { status: 401, body: { error: 'unauthorized' } };
        }
        return { body: mockSites };
      },
    },
    {
      method: 'GET' as const,
      path: '/PS-Handlers/api/DataPortalv3/DataSets',
      handler: () => ({ body: mockDataSets }),
    },
    {
      method: 'GET' as const,
      path: '/PS-Handlers/api/DataPortalv3/DailyLabor',
      handler: () => ({ body: mockDailyLabor }),
    },
    {
      method: 'GET' as const,
      path: '/PS-Handlers/api/DataPortalv3/AccountClass',
      handler: () => ({ body: mockAccountClasses }),
    },
    {
      method: 'GET' as const,
      path: '/PS-Handlers/api/DataPortalv3/DailyExtended',
      handler: () => ({ body: mockDailyExtended }),
    },
    {
      method: 'GET' as const,
      path: '/PS-Handlers/api/DataPortalv3/MonthlyExtended',
      handler: () => ({ body: mockMonthlyExtended }),
    },
    {
      method: 'GET' as const,
      path: '/PS-Handlers/api/DataPortalv3/LedgerBatches',
      handler: () => ({ body: mockLedgerBatches }),
    },
    {
      method: 'GET' as const,
      path: '/PS-Handlers/api/DataPortalv3/SalesBookings',
      handler: () => ({ body: mockSalesBookings }),
    },
    {
      method: 'GET' as const,
      path: '/PS-Handlers/api/DataPortalv3/SalesPaceEvents',
      handler: () => ({ body: mockSalesPace }),
    },
    {
      method: 'GET' as const,
      path: '/PS-Handlers/api/DataPortalv3/SalesPaceRooms',
      handler: () => ({ body: mockSalesPace }),
    },
    {
      method: 'GET' as const,
      path: '/PS-Handlers/api/DataPortalv3/SalesPaceTransient',
      handler: () => ({ body: mockSalesPace }),
    },
  ];
}

describeBundledMcp('profitsage', 'profitsage - happy path + token caching', () => {
  let client: McpTestClient;
  let mockApi: MockApiServer;
  const tokenCount = { n: 0 };

  beforeAll(async () => {
    const result = await createMcpTestClientWithMockApi({
      name: 'profitsage',
      serverScript: resolveServerScript('profitsage'),
      interceptDomains: [TEST_DOMAIN],
      routes: makeRoutes({ tokenCount }),
      env: {
        PROFITSAGE_SUBDOMAIN: SUBDOMAIN,
        PROFITSAGE_USERNAME: 'test_user',
        PROFITSAGE_PASSWORD: 'test_pass',
      },
      connectTimeout: 15_000,
    });
    client = result.client;
    mockApi = result.mockApi;
  }, 30_000);

  afterAll(async () => {
    if (client) await client.close();
    if (mockApi) await mockApi.close();
  });

  it('list_sites returns shaped rows', async () => {
    const out = await client.callToolJson<{ ok: boolean; endpoint: string; count: number; rows: unknown[] }>(
      'list_sites',
      {},
    );
    expect(out.ok).toBe(true);
    expect(out.endpoint).toBe('Sites');
    expect(out.count).toBe(2);
    expect(Array.isArray(out.rows)).toBe(true);
  });

  it('caches the bearer token across subsequent calls', async () => {
    expect(tokenCount.n).toBe(1);
    await client.callToolJson('list_data_sets', {});
    await client.callToolJson('list_data_sets', {});
    expect(tokenCount.n).toBe(1);
  });

  it('get_daily_labor converts ISO dates to MM/dd/yyyy and includes SiteTag', async () => {
    await client.callToolJson('get_daily_labor', {
      site_tag: '100',
      begin_date: '2025-03-01',
      end_date: '2025-03-01',
    });

    const laborCall = mockApi.requestLog.find((r) => r.pathname.endsWith('/DailyLabor'));
    expect(laborCall).toBeDefined();
    expect(laborCall?.searchParams.get('BD')).toBe('3/1/2025');
    expect(laborCall?.searchParams.get('ED')).toBe('3/1/2025');
    expect(laborCall?.searchParams.get('SiteTag')).toBe('100');
    expect(laborCall?.searchParams.get('access_token')).toBeTruthy();
  });

  it('list_account_classes returns shaped rows', async () => {
    const out = await client.callToolJson<{ ok: boolean; endpoint: string; count: number }>(
      'list_account_classes',
      {},
    );
    expect(out.ok).toBe(true);
    expect(out.endpoint).toBe('AccountClass');
    expect(out.count).toBe(1);
  });

  it('get_daily_extended sends siteTag, dataSetID, and MM/dd/yyyy dates', async () => {
    const out = await client.callToolJson<{ ok: boolean; count: number }>('get_daily_extended', {
      site_tag: '100',
      data_set_id: '1',
      begin_date: '2025-03-01',
      end_date: '2025-03-07',
      include_zeroes: false,
      include_totals: true,
    });
    expect(out.ok).toBe(true);
    expect(out.count).toBe(1);

    const call = mockApi.requestLog.find((r) => r.pathname.endsWith('/DailyExtended'));
    expect(call).toBeDefined();
    expect(call?.searchParams.get('siteTag')).toBe('100');
    expect(call?.searchParams.get('dataSetID')).toBe('1');
    expect(call?.searchParams.get('bd')).toBe('3/1/2025');
    expect(call?.searchParams.get('ed')).toBe('3/7/2025');
    expect(call?.searchParams.get('includeTotals')).toBe('Y');
    expect(call?.searchParams.get('includeZeroes')).toBe('N');
    // site_group param has been removed; ensure it never leaks on the wire
    expect(call?.searchParams.get('siteGroup')).toBeNull();
  });

  it('get_monthly_extended sends year/month parameters', async () => {
    await client.callToolJson('get_monthly_extended', {
      site_tag: '100',
      data_set_id: '1',
      year: 2025,
      begin_month: 1,
      end_month: 3,
    });
    const call = mockApi.requestLog.find((r) => r.pathname.endsWith('/MonthlyExtended'));
    expect(call).toBeDefined();
    expect(call?.searchParams.get('year')).toBe('2025');
    expect(call?.searchParams.get('begmonth')).toBe('1');
    expect(call?.searchParams.get('endmonth')).toBe('3');
    expect(call?.searchParams.get('siteTag')).toBe('100');
  });

  it('get_ledger_batches sends status and typeID', async () => {
    await client.callToolJson('get_ledger_batches', {
      site_tag: '100',
      begin_date: '2025-03-01',
      end_date: '2025-03-31',
      status: 'E',
      type_id: 'ALL',
    });
    const call = mockApi.requestLog.find((r) => r.pathname.endsWith('/LedgerBatches'));
    expect(call).toBeDefined();
    expect(call?.searchParams.get('status')).toBe('E');
    expect(call?.searchParams.get('typeID')).toBe('ALL');
    expect(call?.searchParams.get('siteTag')).toBe('100');
  });

  it('get_sales_bookings omits SiteTag when site_tag not provided', async () => {
    await client.callToolJson('get_sales_bookings', {
      begin_date: '2025-03-01',
      end_date: '2025-03-31',
    });
    const call = mockApi.requestLog.find((r) => r.pathname.endsWith('/SalesBookings'));
    expect(call).toBeDefined();
    expect(call?.searchParams.get('BD')).toBe('3/1/2025');
    expect(call?.searchParams.get('ED')).toBe('3/31/2025');
    // Optional param: empty value is dropped, never sent as ""
    expect(call?.searchParams.get('SiteTag')).toBeNull();
  });

  it.each([
    ['get_sales_pace_events', '/SalesPaceEvents'],
    ['get_sales_pace_rooms', '/SalesPaceRooms'],
    ['get_sales_pace_transient', '/SalesPaceTransient'],
  ])('%s hits %s with AsOfDate + date range', async (toolName, pathSuffix) => {
    await client.callToolJson(toolName, {
      site_tag: '100',
      as_of_date: '2025-03-15',
      begin_date: '2025-03-01',
      end_date: '2025-03-31',
    });
    const call = mockApi.requestLog.find((r) => r.pathname.endsWith(pathSuffix));
    expect(call).toBeDefined();
    expect(call?.searchParams.get('AsOfDate')).toBe('3/15/2025');
    expect(call?.searchParams.get('BD')).toBe('3/1/2025');
    expect(call?.searchParams.get('ED')).toBe('3/31/2025');
    expect(call?.searchParams.get('siteTag')).toBe('100');
  });
});

describeBundledMcp('profitsage', 'profitsage - token refresh on 401', () => {
  let client: McpTestClient;
  let mockApi: MockApiServer;
  const tokenCount = { n: 0 };
  const expireOnce = { done: false };

  beforeAll(async () => {
    const result = await createMcpTestClientWithMockApi({
      name: 'profitsage',
      serverScript: resolveServerScript('profitsage'),
      interceptDomains: [TEST_DOMAIN],
      routes: makeRoutes({ tokenCount, alwaysExpireOnce: expireOnce }),
      env: {
        PROFITSAGE_SUBDOMAIN: SUBDOMAIN,
        PROFITSAGE_USERNAME: 'test_user',
        PROFITSAGE_PASSWORD: 'test_pass',
      },
      connectTimeout: 15_000,
    });
    client = result.client;
    mockApi = result.mockApi;
  }, 30_000);

  afterAll(async () => {
    if (client) await client.close();
    if (mockApi) await mockApi.close();
  });

  it('refreshes the token and retries after a 401', async () => {
    const out = await client.callToolJson<{ ok: boolean; count: number }>('list_sites', {});
    expect(out.ok).toBe(true);
    expect(out.count).toBe(2);
    // One initial token + one refresh after the 401
    expect(tokenCount.n).toBe(2);
    // The Sites endpoint was hit twice: once -> 401, then success after refresh
    const siteCalls = mockApi.requestLog.filter((r) => r.pathname.endsWith('/Sites'));
    expect(siteCalls.length).toBe(2);
  });
});

describeBundledMcp('profitsage', 'profitsage - credential / subdomain validation', () => {
  it('surfaces CONFIG_MISSING when credentials are absent', async () => {
    const { client, mockApi } = await createMcpTestClientWithMockApi({
      name: 'profitsage',
      serverScript: resolveServerScript('profitsage'),
      interceptDomains: [TEST_DOMAIN],
      routes: makeRoutes(),
      env: {
        PROFITSAGE_SUBDOMAIN: '',
        PROFITSAGE_USERNAME: '',
        PROFITSAGE_PASSWORD: '',
      },
      connectTimeout: 15_000,
    });
    try {
      const out = await client.callToolJson<{ ok: boolean; code?: string }>('list_sites', {});
      expect(out.ok).toBe(false);
      expect(out.code).toBe('CONFIG_MISSING');
    } finally {
      await client.close();
      await mockApi.close();
    }
  }, 30_000);

  it('rejects malformed subdomain with CONFIG_INVALID', async () => {
    const { client, mockApi } = await createMcpTestClientWithMockApi({
      name: 'profitsage',
      serverScript: resolveServerScript('profitsage'),
      interceptDomains: [TEST_DOMAIN],
      routes: makeRoutes(),
      env: {
        PROFITSAGE_SUBDOMAIN: 'bad subdomain with spaces',
        PROFITSAGE_USERNAME: 'test_user',
        PROFITSAGE_PASSWORD: 'test_pass',
      },
      connectTimeout: 15_000,
    });
    try {
      const out = await client.callToolJson<{ ok: boolean; code?: string }>('list_sites', {});
      expect(out.ok).toBe(false);
      expect(out.code).toBe('CONFIG_INVALID');
    } finally {
      await client.close();
      await mockApi.close();
    }
  }, 30_000);
});
