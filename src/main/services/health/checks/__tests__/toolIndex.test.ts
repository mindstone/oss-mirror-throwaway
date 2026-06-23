import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../toolIndexService', () => ({
  getToolIndexStatus: vi.fn(),
}));

import { getToolIndexStatus } from '../../../toolIndexService';
import { checkToolIndexHealth } from '../toolIndex';

const mockGetToolIndexStatus = vi.mocked(getToolIndexStatus);
const NOW_MS = 1_800_000_000_000;
const RECENT_REFRESH_MS = NOW_MS - 1_000;

describe('checkToolIndexHealth', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(Date, 'now').mockReturnValue(NOW_MS);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('preserves stale-gate warn details byte-identically', () => {
    mockGetToolIndexStatus.mockReturnValue({
      isInitialized: true,
      toolCount: 42,
      lastRefreshAt: RECENT_REFRESH_MS,
      etag: 'etag',
      byServer: { Slack: 10 },
      isStale: true,
      staleReason: 'super-mcp-reconfigure:oauth',
      staleSince: 1_700_000_000_000,
      staleGeneration: 9,
      lastRefreshError: 'refresh failed',
    });

    const result = checkToolIndexHealth();

    expect(result.status).toBe('warn');
    expect(result.message).toContain('refresh is pending');
    expect(result.details).toEqual({
      isInitialized: true,
      toolCount: 42,
      byServer: { Slack: 10 },
      staleReason: 'super-mcp-reconfigure:oauth',
      staleSince: '2023-11-14T22:13:20.000Z',
      staleGeneration: 9,
      lastRefreshError: 'refresh failed',
    });
  });

  it('preserves uninitialized warn branch without details', () => {
    mockGetToolIndexStatus.mockReturnValue({
      isInitialized: false,
      toolCount: 0,
      lastRefreshAt: null,
      etag: null,
      byServer: undefined,
      isStale: false,
      staleReason: null,
      staleSince: null,
      staleGeneration: null,
      lastRefreshError: null,
    });

    const result = checkToolIndexHealth();

    expect(result).toEqual({
      id: 'toolIndexHealth',
      name: 'Tool Index',
      status: 'warn',
      message: 'Tool index not yet initialized',
      remediation: 'Tool index initializes after Super-MCP starts. Try restarting the app.',
    });
    expect(result).not.toHaveProperty('details');
  });

  it('preserves empty-index warn details byte-identically', () => {
    mockGetToolIndexStatus.mockReturnValue({
      isInitialized: true,
      toolCount: 0,
      lastRefreshAt: RECENT_REFRESH_MS,
      etag: 'etag',
      byServer: {},
      isStale: false,
      staleReason: null,
      staleSince: null,
      staleGeneration: null,
      lastRefreshError: null,
    });

    const result = checkToolIndexHealth();

    expect(result.status).toBe('warn');
    expect(result.message).toBe('Tool index is empty (no tools indexed)');
    expect(result.details).toEqual({
      isInitialized: true,
      lastRefreshAt: RECENT_REFRESH_MS,
      byServer: {},
    });
  });

  it('preserves stale-24h warn details byte-identically', () => {
    const oldRefreshMs = NOW_MS - 25 * 60 * 60 * 1_000;
    mockGetToolIndexStatus.mockReturnValue({
      isInitialized: true,
      toolCount: 5,
      lastRefreshAt: oldRefreshMs,
      etag: 'etag',
      byServer: { Gmail: 5 },
      isStale: false,
      staleReason: null,
      staleSince: null,
      staleGeneration: null,
      lastRefreshError: null,
    });

    const result = checkToolIndexHealth();

    expect(result.status).toBe('warn');
    expect(result.message).toBe('Tool index is stale (5 tools, last refresh > 24h ago)');
    expect(result.details).toEqual({
      toolCount: 5,
      lastRefreshAt: new Date(oldRefreshMs).toISOString(),
      byServer: { Gmail: 5 },
    });
  });

  it('preserves pass branch details byte-identically, including byServer', () => {
    mockGetToolIndexStatus.mockReturnValue({
      isInitialized: true,
      toolCount: 5,
      lastRefreshAt: RECENT_REFRESH_MS,
      etag: 'etag',
      byServer: { Gmail: 5 },
      isStale: false,
      staleReason: null,
      staleSince: null,
      staleGeneration: null,
      lastRefreshError: null,
    });

    const result = checkToolIndexHealth();

    expect(result.status).toBe('pass');
    expect(result.message).toBe('5 tools indexed');
    expect(result.details).toEqual({
      toolCount: 5,
      lastRefreshAt: new Date(RECENT_REFRESH_MS).toISOString(),
      byServer: { Gmail: 5 },
    });
  });
});
