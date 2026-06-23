/**
 * Pin suite for checkCalendarCacheHealth.
 *
 * Stage 4, 260611_calendar-cache-attention: branch pins for the
 * persisted-vs-operational warning split.
 *
 * Stage 3, 260611_calendar-followups: reader rewrite pins —
 * - typed `syncIssues` are authoritative when the KEY IS PRESENT (not when
 *   non-empty); legacy strings are consulted only when the key is absent
 *   (pre-update cache);
 * - all display copy (message/remediation/details) derives from a projection
 *   that excludes `detail` — no email/slug/diagnostic text can reach any
 *   check output (red-pinned);
 * - the legacy-string fallback classifies/counts only and NEVER echoes raw
 *   string content (kills the extractConnectorName raw-fallback email leak,
 *   red-pinned);
 * - fresh-profile gate (B1): populatedAt-null warns only after a sync
 *   attempt OR once the time-bounded suppression window expires.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../meetingCacheStore', () => ({
  getMeetingCacheState: vi.fn(),
}));

import { checkCalendarCacheHealth } from '../calendar';
import { getMeetingCacheState } from '../../../meetingCacheStore';
import type { SyncIssue } from '@shared/ipc/channels/calendar';
import {
  FRESH_PROFILE_SUPPRESSION_WINDOW_MS,
  markCalendarSyncAttempted,
  resetCalendarSyncAttemptTrackerForTesting,
} from '@core/services/calendarSyncAttempt';

const mockedGetState = vi.mocked(getMeetingCacheState);

type CacheState = ReturnType<typeof getMeetingCacheState>;

const POPULATED_AT = new Date('2026-06-11T10:00:00.000Z').getTime();

function state(overrides: Partial<CacheState> = {}): CacheState {
  return {
    populatedAt: POPULATED_AT,
    lastSyncError: undefined,
    syncWarnings: [],
    syncIssues: [],
    isStale: false,
    ...overrides,
  };
}

/** Pre-update cache shape: typed key ABSENT, legacy strings only. */
function legacyState(syncWarnings: string[], overrides: Partial<CacheState> = {}): CacheState {
  return {
    populatedAt: POPULATED_AT,
    lastSyncError: undefined,
    syncWarnings,
    syncIssues: undefined,
    isStale: false,
    ...overrides,
  };
}

beforeEach(() => {
  mockedGetState.mockReset();
  // Default: attempted long ago — populatedAt-null tests opt out explicitly.
  resetCalendarSyncAttemptTrackerForTesting();
  markCalendarSyncAttempted();
});

describe('checkCalendarCacheHealth', () => {
  describe('fresh-profile gate (Stage 3, B1 + time bound)', () => {
    it('does NOT warn on a fresh profile before any sync attempt within the suppression window (RED pre-Stage-3)', () => {
      resetCalendarSyncAttemptTrackerForTesting(); // boot just happened, nothing attempted
      mockedGetState.mockReturnValue(state({ populatedAt: null }));

      const result = checkCalendarCacheHealth();
      expect(result.id).toBe('calendarCacheHealth');
      expect(result.status).toBe('pass');
    });

    it('warns when never attempted once the suppression window has expired (wedged scheduler surfaces)', () => {
      resetCalendarSyncAttemptTrackerForTesting(
        Date.now() - FRESH_PROFILE_SUPPRESSION_WINDOW_MS - 1_000,
      );
      mockedGetState.mockReturnValue(state({ populatedAt: null }));

      const result = checkCalendarCacheHealth();
      expect(result.status).toBe('warn');
      expect(result.message).toBe('Calendar sync has not run yet');
    });

    it('warns for attempted-but-null even within the window (true positive: thrown sync, no cache write)', () => {
      resetCalendarSyncAttemptTrackerForTesting();
      markCalendarSyncAttempted();
      mockedGetState.mockReturnValue(state({ populatedAt: null }));

      const result = checkCalendarCacheHealth();
      expect(result.status).toBe('warn');
      expect(result.message).toBe('Calendar sync has not run yet');
    });
  });

  describe('typed syncIssues (Stage 3 reader)', () => {
    it('no detail text (incl. emails) ever reaches message/remediation/details (RED pre-Stage-3)', () => {
      // Hostile fixture: detail carries an email; the legacy strings simulate
      // a skewed/old cache that ALSO carries raw content. With the typed key
      // present, the typed path is authoritative and nothing raw may leak.
      mockedGetState.mockReturnValue(state({
        syncIssues: [{
          kind: 'calendar_fetch_failed',
          provider: 'google',
          connector: 'GoogleWorkspace',
          detail: 'calendar for leak-target@example.com not reachable',
        }],
        syncWarnings: [
          'Google calendar sync warning (leak-target@example.com, primary): boom',
        ],
      }));

      const result = checkCalendarCacheHealth();
      expect(result.status).toBe('warn');
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain('leak-target@example.com');
      expect(serialized).not.toContain('@');
      expect(serialized).not.toContain('not reachable');
      expect(result.remediation).toBe(
        'Check your Google Workspace connection in Settings > Connectors.',
      );
      expect(result.details).toMatchObject({ connectorServerNames: ['GoogleWorkspace'] });
    });

    it('dedupes same-class issues into one count-aware line (Stage-2 flag)', () => {
      mockedGetState.mockReturnValue(state({
        syncIssues: [
          { kind: 'auth_transient', provider: 'google', connector: 'GoogleWorkspace', accountRef: 'mindstone.com' },
          { kind: 'auth_transient', provider: 'google', connector: 'GoogleWorkspace', accountRef: 'example.com' },
          { kind: 'calendar_fetch_failed', provider: 'microsoft', connector: 'Microsoft365Calendar', detail: 'x' },
        ],
      }));

      const result = checkCalendarCacheHealth();
      expect(result.status).toBe('warn');
      const lines = result.details?.syncWarnings as string[];
      expect(lines).toHaveLength(2);
      expect(lines[0]).toBe(
        'Google Workspace: token refresh is temporarily unavailable for 2 accounts; retrying with backoff',
      );
      expect(lines[1]).toBe('Microsoft 365 Calendar: a calendar could not be fetched during sync');
      // One transient-auth message with a count, not N near-identical lines.
      expect(result.message.match(/token refresh/g)).toHaveLength(1);
      expect(result.details).toMatchObject({
        connectorServerNames: ['GoogleWorkspace', 'Microsoft365Calendar'],
      });
      expect(result.remediation).toBe(
        'Check your Google Workspace and Microsoft 365 Calendar connection in Settings > Connectors.',
      );
    });

    it('derives copy per kind: bridge_reported and validation_skipped have no connector → generic remediation', () => {
      mockedGetState.mockReturnValue(state({
        syncIssues: [
          { kind: 'bridge_reported', detail: 'No calendar sources connected' },
          { kind: 'validation_skipped', count: 2 },
          { kind: 'validation_skipped', count: 3 },
        ],
      }));

      const result = checkCalendarCacheHealth();
      expect(result.status).toBe('warn');
      const lines = result.details?.syncWarnings as string[];
      expect(lines).toEqual([
        'A calendar source reported a sync problem',
        '5 meeting(s) skipped due to validation errors',
      ]);
      expect(result.remediation).toBe(
        'Check your calendar connections in Settings > Connectors.',
      );
      expect(result.details).toMatchObject({ connectorServerNames: [] });
      expect(JSON.stringify(result)).not.toContain('No calendar sources connected');
    });

    it('fail-closed: unknown-kind / invalid persisted elements degrade to a generic bucket and never leak', () => {
      mockedGetState.mockReturnValue(state({
        syncIssues: [
          { kind: 'future_mystery_kind', detail: 'corrupt [external-email] payload' } as unknown as SyncIssue,
        ],
      }));

      const result = checkCalendarCacheHealth();
      expect(result.status).toBe('warn');
      expect(result.details?.syncWarnings).toEqual(['A calendar sync issue could not be read']);
      expect(JSON.stringify(result)).not.toContain('[external-email]');
    });

    it('typed key present but EMPTY: legacy strings are NOT consulted (key-presence decides authority)', () => {
      mockedGetState.mockReturnValue(state({
        syncIssues: [],
        syncWarnings: ['GoogleWorkspace-stray-slug: stale derived string'],
      }));

      const result = checkCalendarCacheHealth();
      expect(result.status).toBe('pass');
      expect(JSON.stringify(result)).not.toContain('stray-slug');
    });

    it('typed issues take precedence over lastSyncError and staleness', () => {
      mockedGetState.mockReturnValue(state({
        syncIssues: [{ kind: 'account_sync_failed', provider: 'google', connector: 'GoogleWorkspace', detail: 'boom' }],
        lastSyncError: 'total failure',
        isStale: true,
      }));

      const result = checkCalendarCacheHealth();
      expect(result.status).toBe('warn');
      expect(result.message).toContain('Calendar sync issues');
    });
  });

  describe('legacy-string fallback (typed key absent — pre-update cache)', () => {
    it('genericized: an email-bearing legacy warning leaks into NO check output (RED pre-Stage-3)', () => {
      mockedGetState.mockReturnValue(legacyState([
        'Google calendar sync warning ([Mindstone-email], primary): Google Calendar API error: 500',
      ]));

      const result = checkCalendarCacheHealth();
      expect(result.status).toBe('warn');
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain('[Mindstone-email]');
      expect(serialized).not.toContain('@');
      // Junk prefix is NOT classifiable → generic remediation, no raw-prefix echo.
      expect(result.remediation).toBe(
        'Check your calendar connections in Settings > Connectors.',
      );
      expect(result.message).toBe('Calendar sync issues: 1 warning from the last sync');
    });

    it('classifies closed-set instance prefixes for remediation without echoing the string (W1 shape)', () => {
      mockedGetState.mockReturnValue(legacyState([
        'GoogleWorkspace-flaky-mindstone-com: Google account mindstone.com token refresh is temporarily unavailable; retrying with backoff',
      ]));

      const result = checkCalendarCacheHealth();
      expect(result.status).toBe('warn');
      expect(result.remediation).toBe(
        'Check your Google Workspace connection in Settings > Connectors.',
      );
      expect(result.details).toMatchObject({
        connectorServerNames: ['GoogleWorkspace'],
        isStale: false,
      });
      // Counts only — the raw string (slug included) never rides any output.
      expect(JSON.stringify(result)).not.toContain('flaky-mindstone-com');
      expect(result.message).toBe('Calendar sync issues: 1 warning from the last sync');
    });

    it('falls back to generic remediation when no warning has a recognisable closed-set prefix', () => {
      mockedGetState.mockReturnValue(legacyState(['something went sideways']));

      const result = checkCalendarCacheHealth();
      expect(result.status).toBe('warn');
      expect(result.remediation).toBe(
        'Check your calendar connections in Settings > Connectors.',
      );
      expect(result.details).toMatchObject({ connectorServerNames: [] });
    });

    it('legacy warnings take precedence over lastSyncError and staleness', () => {
      mockedGetState.mockReturnValue(legacyState(['GoogleWorkspace-x: boom'], {
        lastSyncError: 'total failure',
        isStale: true,
      }));

      const result = checkCalendarCacheHealth();
      expect(result.status).toBe('warn');
      expect(result.message).toContain('Calendar sync issues');
    });
  });

  it('fails on a hard lastSyncError when no warnings are present', () => {
    mockedGetState.mockReturnValue(state({ lastSyncError: 'disk on fire' }));

    const result = checkCalendarCacheHealth();
    expect(result.status).toBe('fail');
    expect(result.message).toBe('Calendar sync failed: disk on fire');
  });

  it('scrubs an unscrubbed legacy lastSyncError at read — belt for pre-fix persisted values (RED pre-Phase-7, DA-F4)', () => {
    // recordSyncError now scrubs at write, but a lastSyncError persisted by a
    // pre-fix build can still carry raw emails/slugs; the display path must
    // not echo them.
    mockedGetState.mockReturnValue(state({
      lastSyncError: 'save_meetings rejected attendee [Mindstone-email]: invalid value',
    }));

    const result = checkCalendarCacheHealth();
    expect(result.status).toBe('fail');
    expect(JSON.stringify(result)).not.toContain('[Mindstone-email]');
    expect(result.message).toContain('Calendar sync failed:');
    expect(result.message).toContain('[email]');
  });

  it('warns when the cache is stale', () => {
    mockedGetState.mockReturnValue(state({ isStale: true }));

    const result = checkCalendarCacheHealth();
    expect(result.status).toBe('warn');
    expect(result.message).toBe('Calendar cache is stale (last sync > 4 hours ago)');
    expect(result.details).toMatchObject({
      populatedAt: new Date(POPULATED_AT).toISOString(),
    });
  });

  it('passes when the cache is fresh with no warnings or errors', () => {
    mockedGetState.mockReturnValue(state());

    const result = checkCalendarCacheHealth();
    expect(result.status).toBe('pass');
    expect(result.message).toBe('Calendar cache is healthy');
  });

  it('passes when syncWarnings is an empty array after a recovered sync (recovery path)', () => {
    mockedGetState.mockReturnValue(legacyState([]));

    expect(checkCalendarCacheHealth().status).toBe('pass');
  });

  describe('honest network-vs-connection copy (Stage 2, 260617_calendar-cache-transient-debounce)', () => {
    it('network-caused failure → calm retry copy, NOT "check your connection" (RED pre-Stage-2)', () => {
      mockedGetState.mockReturnValue(state({
        syncIssues: [{ kind: 'account_sync_failed', provider: 'google', connector: 'GoogleWorkspace', detail: 'fetch failed', cause: 'network' }],
      }));

      const result = checkCalendarCacheHealth();
      expect(result.status).toBe('warn');
      expect(result.remediation).toBe(
        "Rebel couldn't reach your calendar just now. This is usually a brief network issue, and it'll keep retrying automatically.",
      );
      expect(result.remediation).not.toContain('Settings > Connectors');
      expect(result.details?.syncWarnings).toEqual(['Google Workspace: temporarily unreachable (network issue)']);
    });

    it('network-caused calendar_fetch_failed → network line copy, no connection blame', () => {
      mockedGetState.mockReturnValue(state({
        syncIssues: [{ kind: 'calendar_fetch_failed', provider: 'google', connector: 'GoogleWorkspace', detail: 'fetch failed', cause: 'network' }],
      }));

      const result = checkCalendarCacheHealth();
      expect(result.details?.syncWarnings).toEqual(["Google Workspace: couldn't reach the calendar service (network issue)"]);
      expect(result.remediation).not.toContain('Settings > Connectors');
    });

    it('account-caused failure → keeps the "check your connection" remediation', () => {
      mockedGetState.mockReturnValue(state({
        syncIssues: [{ kind: 'account_sync_failed', provider: 'google', connector: 'GoogleWorkspace', detail: '403', cause: 'account' }],
      }));

      const result = checkCalendarCacheHealth();
      expect(result.remediation).toBe('Check your Google Workspace connection in Settings > Connectors.');
    });

    it('a mixed set (network + account) → the connection problem wins the remediation', () => {
      mockedGetState.mockReturnValue(state({
        syncIssues: [
          { kind: 'account_sync_failed', provider: 'google', connector: 'GoogleWorkspace', detail: 'fetch failed', cause: 'network' },
          { kind: 'account_sync_failed', provider: 'microsoft', connector: 'Microsoft365Calendar', detail: '403', cause: 'account' },
        ],
      }));

      const result = checkCalendarCacheHealth();
      expect(result.remediation).toContain('Settings > Connectors');
    });

    it('missing cause (legacy/undefined) is treated as a connection problem — never a false "blip"', () => {
      mockedGetState.mockReturnValue(state({
        syncIssues: [{ kind: 'account_sync_failed', provider: 'google', connector: 'GoogleWorkspace', detail: 'boom' }],
      }));

      const result = checkCalendarCacheHealth();
      expect(result.remediation).toBe('Check your Google Workspace connection in Settings > Connectors.');
    });
  });
});
