import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  getErrorBlurb,
  getUpdateCheckErrorDisplay,
  shouldHideRawErrorDetail,
  relativeTime,
  formatUptime,
  formatBuildDate,
  detectNearestRegion,
  fetchHealthInfo,
  parseCloudUpdateHealth,
  getCloudRollbackNotice,
  validateConnectInputs,
  isTokenOnlyReconnect,
  formatMB,
  formatEta,
  formatDetailLine,
  STATUS_DOT,
  STATUS_LABEL,
  STATUS_BLURB,
  PHASE_COPY,
  PROVISION_PHASE_COPY,
  MANAGED_REGIONS,
} from '../cloudTabUtils';

// ---------------------------------------------------------------------------
// getErrorBlurb
// ---------------------------------------------------------------------------

describe('getErrorBlurb', () => {
  it('returns generic blurb when no error detail', () => {
    const result = getErrorBlurb();
    expect(result).toContain('Something went wrong');
    expect(result).toContain('Check status');
  });

  it('returns generic blurb for undefined', () => {
    expect(getErrorBlurb(undefined)).toContain('Something went wrong');
  });

  it('returns timeout blurb for network timeout errors', () => {
    expect(getErrorBlurb('Request timeout')).toContain("isn't responding");
    expect(getErrorBlurb('Signal was aborted')).toContain("isn't responding");
    expect(getErrorBlurb('Failed to fetch')).toContain("isn't responding");
    expect(getErrorBlurb('Server unreachable')).toContain("isn't responding");
  });

  it('returns retry-aware blurb for interrupted managed updates', () => {
    const staleReset = getErrorBlurb(
      'Reset from stale updating state — worker interrupted before completion (likely request timeout)',
    );
    expect(staleReset).toContain('retry automatically');
    expect(staleReset).toContain('"Update now"');

    const workerInterrupted = getErrorBlurb('Worker interrupted before completion during managed update');
    expect(workerInterrupted).toContain('retry automatically');
  });

  it('hides raw error detail when the blurb already provides curated managed-update guidance', () => {
    expect(
      shouldHideRawErrorDetail(
        'Reset from stale updating state — worker interrupted before completion (likely request timeout)',
      ),
    ).toBe(true);
    expect(shouldHideRawErrorDetail('HTTP 503')).toBe(false);
  });

  it('returns auth blurb for 401/unauthorized errors', () => {
    expect(getErrorBlurb('HTTP 401')).toContain('Authentication failed');
    expect(getErrorBlurb('Invalid token provided')).toContain('Authentication failed');
    expect(getErrorBlurb('Unauthorized access')).toContain('Authentication failed');
  });

  it('returns forbidden blurb for 403 errors', () => {
    expect(getErrorBlurb('HTTP 403')).toContain('Access denied');
    expect(getErrorBlurb('Forbidden resource')).toContain('Access denied');
  });

  it('returns server error blurb for 502/503/504 errors', () => {
    const result502 = getErrorBlurb('HTTP 502');
    expect(result502).toContain('server error');
    expect(result502).toContain('HTTP 502');

    const result503 = getErrorBlurb('HTTP 503');
    expect(result503).toContain('server error');

    const result504 = getErrorBlurb('HTTP 504');
    expect(result504).toContain('server error');
  });

  it('returns generic 5xx blurb for other server errors', () => {
    const result = getErrorBlurb('HTTP 500');
    expect(result).toContain('Cloud returned an error');
    expect(result).toContain('HTTP 500');
  });

  it('returns unhealthy blurb for unhealthy status', () => {
    expect(getErrorBlurb('Server unhealthy')).toContain('reported itself as unhealthy');
  });

  it('returns the raw error with guidance for unknown errors', () => {
    const result = getErrorBlurb('Something unusual happened');
    expect(result).toContain('Something unusual happened');
    expect(result).toContain('Check status');
  });

  it('is case-insensitive for error matching', () => {
    expect(getErrorBlurb('TIMEOUT')).toContain("isn't responding");
    expect(getErrorBlurb('http 401')).toContain('Authentication failed');
    expect(getErrorBlurb('FORBIDDEN')).toContain('Access denied');
  });
});

// ---------------------------------------------------------------------------
// relativeTime
// ---------------------------------------------------------------------------

describe('relativeTime', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-10T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns "Never" for undefined', () => {
    expect(relativeTime(undefined)).toBe('Never');
  });

  it('returns "Never" for 0', () => {
    expect(relativeTime(0)).toBe('Never');
  });

  it('returns "Just now" for < 1 min ago', () => {
    const thirtySecsAgo = Date.now() - 30_000;
    expect(relativeTime(thirtySecsAgo)).toBe('Just now');
  });

  it('returns relative minutes for < 1 hour ago', () => {
    const fiveMinAgo = Date.now() - 5 * 60_000;
    expect(relativeTime(fiveMinAgo)).toBe('5m ago');

    const thirtyMinAgo = Date.now() - 30 * 60_000;
    expect(relativeTime(thirtyMinAgo)).toBe('30m ago');
  });

  it('returns relative hours for < 24 hours ago', () => {
    const twoHoursAgo = Date.now() - 2 * 60 * 60_000;
    expect(relativeTime(twoHoursAgo)).toBe('2h ago');

    const twentyThreeHoursAgo = Date.now() - 23 * 60 * 60_000;
    expect(relativeTime(twentyThreeHoursAgo)).toBe('23h ago');
  });

  it('returns relative days for >= 24 hours ago', () => {
    const oneDayAgo = Date.now() - 24 * 60 * 60_000;
    expect(relativeTime(oneDayAgo)).toBe('1d ago');

    const threeDaysAgo = Date.now() - 3 * 24 * 60 * 60_000;
    expect(relativeTime(threeDaysAgo)).toBe('3d ago');
  });

  it('returns "Just now" for timestamps in the near future (clock skew)', () => {
    const slightlyInFuture = Date.now() + 100;
    expect(relativeTime(slightlyInFuture)).toBe('Just now');
  });
});

// ---------------------------------------------------------------------------
// formatUptime
// ---------------------------------------------------------------------------

describe('formatUptime', () => {
  it('formats seconds as minutes when < 1 hour', () => {
    expect(formatUptime(0)).toBe('0m');
    expect(formatUptime(59)).toBe('0m');
    expect(formatUptime(60)).toBe('1m');
    expect(formatUptime(300)).toBe('5m');
    expect(formatUptime(3599)).toBe('59m');
  });

  it('formats as hours+minutes when < 1 day', () => {
    expect(formatUptime(3600)).toBe('1h');
    expect(formatUptime(3660)).toBe('1h 1m');
    expect(formatUptime(7200)).toBe('2h');
    expect(formatUptime(7260)).toBe('2h 1m');
    expect(formatUptime(86399)).toBe('23h 59m');
  });

  it('formats as days+hours when >= 1 day', () => {
    expect(formatUptime(86400)).toBe('1d');
    expect(formatUptime(90000)).toBe('1d 1h');
    expect(formatUptime(172800)).toBe('2d');
    expect(formatUptime(180000)).toBe('2d 2h');
  });

  it('omits sub-unit when zero', () => {
    // Days with 0 hours
    expect(formatUptime(86400)).toBe('1d');
    // Hours with 0 minutes
    expect(formatUptime(3600)).toBe('1h');
  });
});

// ---------------------------------------------------------------------------
// formatBuildDate
// ---------------------------------------------------------------------------

describe('formatBuildDate', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-10T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns "Built today" for same-day date', () => {
    expect(formatBuildDate('2026-04-10T08:00:00Z')).toBe('Built today');
  });

  it('returns formatted date for past dates', () => {
    const result = formatBuildDate('2026-04-05T12:00:00Z');
    expect(result).toMatch(/^Built /);
    expect(result).toContain('Apr');
    expect(result).toContain('5');
  });

  it('returns empty string for empty input', () => {
    expect(formatBuildDate('')).toBe('');
  });

  it('returns empty string for "unknown"', () => {
    expect(formatBuildDate('unknown')).toBe('');
  });

  it('returns empty string for invalid date string', () => {
    expect(formatBuildDate('not-a-date')).toBe('');
  });
});

// ---------------------------------------------------------------------------
// detectNearestRegion
// ---------------------------------------------------------------------------

describe('detectNearestRegion', () => {
  const originalIntl = globalThis.Intl;

  afterEach(() => {
    globalThis.Intl = originalIntl;
  });

  function mockTimezone(tz: string) {
    globalThis.Intl = {
      ...originalIntl,
      DateTimeFormat: function (...args: ConstructorParameters<typeof Intl.DateTimeFormat>) {
        const real = new originalIntl.DateTimeFormat(...args);
        return {
          ...real,
          resolvedOptions: () => ({ ...real.resolvedOptions(), timeZone: tz }),
        };
      } as unknown as typeof Intl.DateTimeFormat,
    } as typeof Intl;
  }

  it('returns region matching known timezone', () => {
    mockTimezone('America/New_York');
    expect(detectNearestRegion()).toBe('ewr');
  });

  it('returns correct region for European timezone', () => {
    mockTimezone('Europe/London');
    expect(detectNearestRegion()).toBe('lhr');
  });

  it('returns correct region for Asian timezone', () => {
    mockTimezone('Asia/Tokyo');
    expect(detectNearestRegion()).toBe('nrt');
  });

  it('returns correct region for Australian timezone', () => {
    mockTimezone('Australia/Sydney');
    expect(detectNearestRegion()).toBe('syd');
  });

  it('falls back to continent prefix for unknown timezone', () => {
    mockTimezone('America/Phoenix');
    expect(detectNearestRegion()).toBe('iad');

    mockTimezone('Europe/Madrid');
    expect(detectNearestRegion()).toBe('fra');

    mockTimezone('Asia/Bangkok');
    expect(detectNearestRegion()).toBe('sin');
  });

  it('falls back to Pacific → syd for Pacific timezone', () => {
    mockTimezone('Pacific/Auckland');
    expect(detectNearestRegion()).toBe('syd');
  });

  it('falls back to jnb for African timezone', () => {
    mockTimezone('Africa/Cairo');
    expect(detectNearestRegion()).toBe('jnb');
  });

  it('returns iad when timezone detection fails', () => {
    globalThis.Intl = {
      ...originalIntl,
      DateTimeFormat: function () {
        throw new Error('Not available');
      } as unknown as typeof Intl.DateTimeFormat,
    } as typeof Intl;
    expect(detectNearestRegion()).toBe('iad');
  });
});

// ---------------------------------------------------------------------------
// fetchHealthInfo
// ---------------------------------------------------------------------------

describe('fetchHealthInfo', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('returns health info for a healthy endpoint', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        status: 'ok',
        version: '1.2.3',
        buildCommit: 'abc1234',
        buildDate: '2026-04-10',
        uptime: 3600,
      }),
    }) as unknown as typeof fetch;

    const result = await fetchHealthInfo('https://test.fly.dev');
    expect(result).toEqual({
      version: '1.2.3',
      buildCommit: 'abc1234',
      buildDate: '2026-04-10',
      uptimeSeconds: 3600,
    });
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://test.fly.dev/api/health',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('strips trailing slashes from URL', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ status: 'ok', version: '1.0', buildCommit: '', buildDate: '', uptime: 0 }),
    }) as unknown as typeof fetch;

    await fetchHealthInfo('https://test.fly.dev///');
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://test.fly.dev/api/health',
      expect.anything(),
    );
  });

  it('returns null for non-ok response', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false }) as unknown as typeof fetch;
    expect(await fetchHealthInfo('https://test.fly.dev')).toBeNull();
  });

  it('returns null when status is not ok', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ status: 'unhealthy' }),
    }) as unknown as typeof fetch;
    expect(await fetchHealthInfo('https://test.fly.dev')).toBeNull();
  });

  it('parses the cloudUpdate field when present (rolled-back cloud still reports status ok)', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        status: 'ok',
        version: '1.0', buildCommit: 'c', buildDate: 'd', uptime: 10,
        cloudUpdate: {
          status: 'recently-rolled-back',
          quarantinedTags: ['ghcr.io/mindstone/rebel-cloud:prod-bad'],
          lastKnownGoodImageTag: 'ghcr.io/mindstone/rebel-cloud:prod-good',
          currentImageTag: 'ghcr.io/mindstone/rebel-cloud:prod-good',
        },
      }),
    }) as unknown as typeof fetch;

    const result = await fetchHealthInfo('https://test.fly.dev');
    expect(result?.cloudUpdate).toEqual({
      status: 'recently-rolled-back',
      quarantinedTags: ['ghcr.io/mindstone/rebel-cloud:prod-bad'],
      lastKnownGoodImageTag: 'ghcr.io/mindstone/rebel-cloud:prod-good',
      currentImageTag: 'ghcr.io/mindstone/rebel-cloud:prod-good',
    });
  });

  it('leaves cloudUpdate undefined for an older cloud that omits the field', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ status: 'ok', version: '1.0', buildCommit: 'c', buildDate: 'd', uptime: 10 }),
    }) as unknown as typeof fetch;
    const result = await fetchHealthInfo('https://test.fly.dev');
    expect(result?.cloudUpdate).toBeUndefined();
  });

  it('returns null on network error', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('Network error')) as unknown as typeof fetch;
    expect(await fetchHealthInfo('https://test.fly.dev')).toBeNull();
  });

  it('uses custom signal when provided', async () => {
    const controller = new AbortController();
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ status: 'ok', version: '1.0', buildCommit: '', buildDate: '', uptime: 0 }),
    }) as unknown as typeof fetch;

    await fetchHealthInfo('https://test.fly.dev', controller.signal);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ signal: controller.signal }),
    );
  });

  it('handles missing fields gracefully', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ status: 'ok' }),
    }) as unknown as typeof fetch;

    const result = await fetchHealthInfo('https://test.fly.dev');
    expect(result).toEqual({
      version: '',
      buildCommit: '',
      buildDate: '',
      uptimeSeconds: 0,
    });
  });
});

// ---------------------------------------------------------------------------
// parseCloudUpdateHealth
// ---------------------------------------------------------------------------

describe('parseCloudUpdateHealth', () => {
  it('parses a well-formed recently-rolled-back payload', () => {
    expect(parseCloudUpdateHealth({ status: 'recently-rolled-back', quarantinedTags: ['t'] })).toEqual({
      status: 'recently-rolled-back',
      quarantinedTags: ['t'],
      lastKnownGoodImageTag: undefined,
      currentImageTag: undefined,
    });
  });

  it('parses status ok', () => {
    expect(parseCloudUpdateHealth({ status: 'ok' })?.status).toBe('ok');
  });

  it('returns undefined for non-object / missing or unknown status', () => {
    expect(parseCloudUpdateHealth(undefined)).toBeUndefined();
    expect(parseCloudUpdateHealth(null)).toBeUndefined();
    expect(parseCloudUpdateHealth('nope')).toBeUndefined();
    expect(parseCloudUpdateHealth({})).toBeUndefined();
    expect(parseCloudUpdateHealth({ status: 'bogus' })).toBeUndefined();
  });

  it('filters non-string quarantinedTags and defaults to []', () => {
    expect(parseCloudUpdateHealth({ status: 'ok', quarantinedTags: ['a', 3, null, 'b'] })?.quarantinedTags)
      .toEqual(['a', 'b']);
    expect(parseCloudUpdateHealth({ status: 'ok', quarantinedTags: 'not-array' })?.quarantinedTags).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// getCloudRollbackNotice
// ---------------------------------------------------------------------------

describe('getCloudRollbackNotice', () => {
  const rolledBack = { status: 'recently-rolled-back' as const, quarantinedTags: ['bad'] };

  it('returns null when there is nothing to surface', () => {
    expect(getCloudRollbackNotice(false, undefined)).toBeNull();
    expect(getCloudRollbackNotice(true, undefined)).toBeNull();
    expect(getCloudRollbackNotice(false, { status: 'ok', quarantinedTags: [] })).toBeNull();
  });

  it('managed: soft info-tone "we are handling it, no action needed"', () => {
    const notice = getCloudRollbackNotice(true, rolledBack);
    expect(notice?.tone).toBe('info');
    expect(notice?.body).toMatch(/Mindstone is handling it/);
    expect(notice?.body).toMatch(/No action needed/);
  });

  it('byok with update controls visible: warning-tone + nudge to check for updates', () => {
    const notice = getCloudRollbackNotice(false, rolledBack, { canCheckForUpdates: true });
    expect(notice?.tone).toBe('warning');
    expect(notice?.body).toMatch(/Check for updates/i);
    expect(notice?.body).not.toMatch(/Mindstone is handling it/);
  });

  it('byok without update controls (manual-connect): omits the dangling button reference', () => {
    const notice = getCloudRollbackNotice(false, rolledBack); // canCheckForUpdates defaults false
    expect(notice?.tone).toBe('warning');
    expect(notice?.body).not.toMatch(/Check for updates/i);
    expect(notice?.body).toMatch(/move forward automatically/i);
  });
});

// ---------------------------------------------------------------------------
// validateConnectInputs
// ---------------------------------------------------------------------------

describe('validateConnectInputs', () => {
  it('returns null for valid HTTP URL + non-empty token', () => {
    expect(validateConnectInputs('https://test.fly.dev', 'my-token')).toBeNull();
    expect(validateConnectInputs('http://localhost:3000', 'tok')).toBeNull();
  });

  it('returns error for empty URL', () => {
    expect(validateConnectInputs('', 'my-token')).toBe('Enter the server URL.');
    expect(validateConnectInputs('   ', 'my-token')).toBe('Enter the server URL.');
  });

  it('returns error for non-HTTP URL', () => {
    expect(validateConnectInputs('ftp://server.com', 'tok')).toBe('URL must start with https:// or http://');
    expect(validateConnectInputs('ws://server.com', 'tok')).toBe('URL must start with https:// or http://');
    expect(validateConnectInputs('server.com', 'tok')).toBe('URL must start with https:// or http://');
  });

  it('returns error for empty token', () => {
    expect(validateConnectInputs('https://test.fly.dev', '')).toBe('Enter the access token.');
    expect(validateConnectInputs('https://test.fly.dev', '   ')).toBe('Enter the access token.');
  });

  it('trims whitespace from URL before validation', () => {
    expect(validateConnectInputs('  https://test.fly.dev  ', 'tok')).toBeNull();
  });

  it('strips trailing slashes from URL', () => {
    expect(validateConnectInputs('https://test.fly.dev///', 'tok')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// isTokenOnlyReconnect
// ---------------------------------------------------------------------------

describe('isTokenOnlyReconnect', () => {
  it('returns true when URL matches existing cloud URL', () => {
    expect(isTokenOnlyReconnect('https://test.fly.dev', 'https://test.fly.dev')).toBe(true);
  });

  it('returns false when URL differs from existing', () => {
    expect(isTokenOnlyReconnect('https://new.fly.dev', 'https://old.fly.dev')).toBe(false);
  });

  it('returns false when no existing cloud URL', () => {
    expect(isTokenOnlyReconnect('https://test.fly.dev', undefined)).toBe(false);
    expect(isTokenOnlyReconnect('https://test.fly.dev')).toBe(false);
  });

  it('returns false for empty existing URL', () => {
    expect(isTokenOnlyReconnect('https://test.fly.dev', '')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Status Constants
// ---------------------------------------------------------------------------

describe('Status constants', () => {
  it('STATUS_DOT has entries for all expected statuses', () => {
    expect(Object.keys(STATUS_DOT)).toEqual(
      expect.arrayContaining(['running', 'warm', 'cold', 'provisioning', 'error']),
    );
  });

  it('STATUS_LABEL has entries for all expected statuses', () => {
    expect(Object.keys(STATUS_LABEL)).toEqual(
      expect.arrayContaining(['running', 'warm', 'cold', 'provisioning', 'error']),
    );
  });

  it('STATUS_BLURB has entries for all expected statuses', () => {
    expect(Object.keys(STATUS_BLURB)).toEqual(
      expect.arrayContaining(['running', 'warm', 'cold', 'provisioning', 'error']),
    );
  });

  it('STATUS_DOT, STATUS_LABEL, and STATUS_BLURB share the same keys', () => {
    const dotKeys = Object.keys(STATUS_DOT).sort();
    const labelKeys = Object.keys(STATUS_LABEL).sort();
    const blurbKeys = Object.keys(STATUS_BLURB).sort();
    expect(dotKeys).toEqual(labelKeys);
    expect(dotKeys).toEqual(blurbKeys);
  });

  it('STATUS_BLURB error entry is empty (handled by getErrorBlurb)', () => {
    expect(STATUS_BLURB.error).toBe('');
  });
});

describe('PHASE_COPY', () => {
  it('has entries for all migration phases, including the Stage 6 extract phase', () => {
    const expected = ['settings', 'mcp-config', 'workspace', 'extract', 'app-data', 'sessions', 'complete'];
    expect(Object.keys(PHASE_COPY)).toEqual(expect.arrayContaining(expected));
  });

  it('each phase has label and detail (estimate is optional by design)', () => {
    for (const [, phase] of Object.entries(PHASE_COPY)) {
      expect(phase).toHaveProperty('label');
      expect(phase).toHaveProperty('detail');
      expect(typeof phase.label).toBe('string');
      expect(typeof phase.detail).toBe('string');
    }
  });

  it('workspace and extract phases deliberately expose no static estimate', () => {
    // Stage 7 renderer derives a live ETA from real throughput samples. A
    // static estimate here would re-introduce the fabricated "1\u20135 minutes"
    // lie the plan was written to remove.
    expect(PHASE_COPY.workspace.estimate).toBeNull();
    expect(PHASE_COPY.extract.estimate).toBeNull();
  });

  it('other phases keep their short static estimate copy', () => {
    expect(PHASE_COPY.settings.estimate).toBeTruthy();
    expect(PHASE_COPY['mcp-config'].estimate).toBeTruthy();
    expect(PHASE_COPY['app-data'].estimate).toBeTruthy();
    expect(PHASE_COPY.sessions.estimate).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// formatMB / formatEta / formatDetailLine (Stage 7)
// ---------------------------------------------------------------------------

describe('formatMB', () => {
  it('returns an em-dash for missing or non-finite values (no fabrication)', () => {
    expect(formatMB(undefined)).toBe('\u2014');
    expect(formatMB(Number.NaN)).toBe('\u2014');
    expect(formatMB(Number.POSITIVE_INFINITY)).toBe('\u2014');
  });

  it('formats sub-MB values as KB', () => {
    expect(formatMB(0)).toBe('0 KB');
    expect(formatMB(1024)).toBe('1 KB');
    expect(formatMB(500 * 1024)).toBe('500 KB');
  });

  it('formats sub-GB values as MB (rounded to whole numbers)', () => {
    expect(formatMB(1 * 1024 * 1024)).toBe('1 MB');
    expect(formatMB(240 * 1024 * 1024)).toBe('240 MB');
    expect(formatMB(1023 * 1024 * 1024)).toBe('1023 MB');
  });

  it('formats large values as GB with one decimal', () => {
    expect(formatMB(1024 * 1024 * 1024)).toBe('1.0 GB');
    expect(formatMB(1.5 * 1024 * 1024 * 1024)).toBe('1.5 GB');
  });
});

describe('formatEta', () => {
  it('returns an em-dash for missing, negative, or non-finite values', () => {
    expect(formatEta(undefined)).toBe('\u2014');
    expect(formatEta(Number.NaN)).toBe('\u2014');
    expect(formatEta(Number.POSITIVE_INFINITY)).toBe('\u2014');
    expect(formatEta(-1)).toBe('\u2014');
  });

  it('formats sub-minute values in seconds (ceil so we never under-promise)', () => {
    expect(formatEta(0)).toBe('0s');
    expect(formatEta(1)).toBe('1s');
    expect(formatEta(44.2)).toBe('45s');
    expect(formatEta(59.9)).toBe('60s');
  });

  it('formats longer values in rounded minutes', () => {
    expect(formatEta(60)).toBe('1 min');
    expect(formatEta(180)).toBe('3 min');
    expect(formatEta(175)).toBe('3 min');
    expect(formatEta(630)).toBe('11 min');
  });
});

describe('formatDetailLine', () => {
  it('renders the canonical "3 min \u00b7 27% \u00b7 240/900 MB" shape', () => {
    const mb = 1024 * 1024;
    const line = formatDetailLine(180, 27, 240 * mb, 900 * mb);
    expect(line).toBe('3 min \u00b7 27% \u00b7 240 MB/900 MB');
  });

  it('renders em-dashes for missing ETA and missing byte totals without fabricating', () => {
    const line = formatDetailLine(undefined, 0, undefined, undefined);
    expect(line).toBe('\u2014 \u00b7 0% \u00b7 \u2014');
  });

  it('preserves the shape when only ETA is available', () => {
    const line = formatDetailLine(45, 14.6, undefined, undefined);
    expect(line).toBe('45s \u00b7 15% \u00b7 \u2014');
  });

  it('rounds the percentage to a whole number', () => {
    const mb = 1024 * 1024;
    const line = formatDetailLine(120, 26.7, 10 * mb, 100 * mb);
    expect(line).toBe('2 min \u00b7 27% \u00b7 10 MB/100 MB');
  });

  it('clamps a non-finite percentage to 0 rather than rendering "NaN%"', () => {
    const line = formatDetailLine(60, Number.NaN, undefined, undefined);
    expect(line).toBe('1 min \u00b7 0% \u00b7 \u2014');
  });
});

describe('PROVISION_PHASE_COPY', () => {
  it('has entries for all provisioning phases', () => {
    const expected = ['validating', 'creating-app', 'setting-secrets', 'creating-volume',
      'creating-machine', 'waiting', 'health-check', 'complete', 'failed'];
    expect(Object.keys(PROVISION_PHASE_COPY)).toEqual(expect.arrayContaining(expected));
  });

  it('each phase has label and detail', () => {
    for (const [, phase] of Object.entries(PROVISION_PHASE_COPY)) {
      expect(phase).toHaveProperty('label');
      expect(phase).toHaveProperty('detail');
    }
  });
});

describe('MANAGED_REGIONS', () => {
  it('is a non-empty array', () => {
    expect(MANAGED_REGIONS.length).toBeGreaterThan(0);
  });

  it('each region has value and label', () => {
    for (const region of MANAGED_REGIONS) {
      expect(region).toHaveProperty('value');
      expect(region).toHaveProperty('label');
      expect(region.value).toBeTruthy();
      expect(region.label).toBeTruthy();
    }
  });

  it('has unique region values', () => {
    const values = MANAGED_REGIONS.map(r => r.value);
    expect(new Set(values).size).toBe(values.length);
  });

  it('includes major regions (iad, lhr, nrt, syd)', () => {
    const values = MANAGED_REGIONS.map(r => r.value);
    expect(values).toContain('iad');
    expect(values).toContain('lhr');
    expect(values).toContain('nrt');
    expect(values).toContain('syd');
  });
});

// ---------------------------------------------------------------------------
// getUpdateCheckErrorDisplay
//
// Regression coverage for the "Cloud continuity" card contradictory-state bug:
// a cold-boot `AbortSignal.timeout` from the auto-fired update-check used to
// leak a raw DOMException ("The operation was aborted due to timeout") straight
// into red destructive text, next to a green "Up to date" pill. The update-check
// stream must now go through the same categorize/sanitizer treatment as every
// other cloud error stream, and a network abort/timeout must read as a calm
// "still starting up" signal, not a hard error.
// ---------------------------------------------------------------------------

describe('getUpdateCheckErrorDisplay', () => {
  // The literal message produced by Node/undici `AbortSignal.timeout(...)`.
  const COLD_BOOT_TIMEOUT_MESSAGE = 'The operation was aborted due to timeout';

  it('treats the exact cold-boot timeout DOMException string as a soft "still starting" signal (no raw leak)', () => {
    const display = getUpdateCheckErrorDisplay(COLD_BOOT_TIMEOUT_MESSAGE);
    expect(display.tone).toBe('muted');
    expect(display.text).toContain('still starting up');
    // The scary raw string must NOT reach the user.
    expect(display.text).not.toContain(COLD_BOOT_TIMEOUT_MESSAGE);
    expect(display.text.toLowerCase()).not.toContain('aborted');
  });

  it('treats an abort/timeout category (as the hook stores it) as soft', () => {
    // The hook stores `categorize(err)` from the real DOMException. categorize()
    // maps an AbortError instance (or a "timed out" message) to network/abort or
    // network/timeout — both of which must read as soft.
    const viaAbort = getUpdateCheckErrorDisplay('Aborted', { kind: 'network', subkind: 'abort' });
    expect(viaAbort.tone).toBe('muted');
    expect(viaAbort.text).toContain('still starting up');
  });

  it('honors a pre-computed network/timeout category as soft', () => {
    const display = getUpdateCheckErrorDisplay('whatever', { kind: 'network', subkind: 'timeout' });
    expect(display.tone).toBe('muted');
    expect(display.text).toContain('still starting up');
  });

  it('treats other network kinds (fetch_failed/dns/tcp) as soft only for abort/timeout — others are sanitized errors', () => {
    const fetchFailed = getUpdateCheckErrorDisplay('fetch failed', { kind: 'network', subkind: 'fetch_failed' });
    expect(fetchFailed.tone).toBe('error');
    expect(fetchFailed.text).toContain("isn't responding");
  });

  it('keeps genuine auth failures as a sanitized hard error (never the raw string)', () => {
    const display = getUpdateCheckErrorDisplay('HTTP 401 Unauthorized', { kind: 'auth', subkind: 'unauthorized' });
    expect(display.tone).toBe('error');
    expect(display.text).toContain('Authentication failed');
    expect(display.text).not.toContain('HTTP 401');
  });

  it('keeps server (5xx) failures as a sanitized hard error', () => {
    const display = getUpdateCheckErrorDisplay('HTTP 503', { kind: 'cloud_down', subkind: 'http_5xx' });
    expect(display.tone).toBe('error');
    expect(display.text).toContain('server error');
  });

  it('falls back to categorizing the raw string when no category is supplied', () => {
    // Timeout phrase in a bare string → soft.
    expect(getUpdateCheckErrorDisplay('Request timed out').tone).toBe('muted');
    expect(getUpdateCheckErrorDisplay('The operation timed out').tone).toBe('muted');
    // A bare string the categorizer can't classify falls to 'unknown' → sanitized
    // error with a recovery hint (still never a soft pass / never raw-only).
    const weird = getUpdateCheckErrorDisplay('Some unrecognized failure');
    expect(weird.tone).toBe('error');
    expect(weird.text).toContain('Check status');
  });

  it('handles a missing/empty error gracefully', () => {
    const display = getUpdateCheckErrorDisplay(null);
    expect(display.tone).toBe('error');
    expect(display.text).toContain('Something went wrong');
  });

  it('never echoes an unknown raw error verbatim without the recovery hint', () => {
    // An "unknown" category still routes through getErrorBlurb, which appends a
    // recovery hint rather than dumping the bare message.
    const display = getUpdateCheckErrorDisplay('Some weird internal failure', { kind: 'unknown', rawMessage: 'Some weird internal failure' });
    expect(display.tone).toBe('error');
    expect(display.text).toContain('Check status');
  });
});
