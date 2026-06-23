import { describe, expect, it } from 'vitest';
import {
  classifySyncErrorCause,
  makeSyncIssue,
  SyncIssueSchema,
  SYNC_ISSUE_DETAIL_MAX_LENGTH,
} from '../calendar';

// ---------------------------------------------------------------------------
// Stage 2 (260611_calendar-followups): makeSyncIssue is the SOLE construction
// path for SyncIssue — email-shaped-substring scrub + connector-instance-slug
// scrub + length cap on free-text fields ([GPT-F1/DA/RS-F1] amendment,
// scrub-don't-reject).
// ---------------------------------------------------------------------------

describe('makeSyncIssue scrubbing factory', () => {
  it('scrubs email-shaped substrings out of detail, preserving the rest', () => {
    const issue = makeSyncIssue({
      kind: 'calendar_fetch_failed',
      provider: 'google',
      connector: 'GoogleWorkspace',
      detail: 'Google Calendar API error: 404 calendar [Mindstone-email] not found',
    });

    expect(issue.detail).not.toContain('[Mindstone-email]');
    expect(issue.detail).toContain('Google Calendar API error: 404');
    expect(issue.detail).toContain('[email]');
  });

  it('scrubs connector-instance slugs (slugified emails) out of detail', () => {
    const issue = makeSyncIssue({
      kind: 'account_sync_failed',
      provider: 'google',
      connector: 'GoogleWorkspace',
      detail: 'token dir GoogleWorkspace-teammember-mindstone-com missing credentials',
    });

    expect(issue.detail).not.toContain('GoogleWorkspace-teammember-mindstone-com');
    expect(issue.detail).toContain('[connector-instance]');
  });

  it('scrubs URL-encoded (%40) email-shaped substrings out of detail (DA-F5)', () => {
    // Google calendarIds in events-path URLs are URL-encoded emails — an API
    // error echoing the request URL carries `greg%40mindstone.com`.
    const issue = makeSyncIssue({
      kind: 'calendar_fetch_failed',
      provider: 'google',
      connector: 'GoogleWorkspace',
      detail: 'GET /calendars/greg%40mindstone.com/events returned 404',
    });

    expect(issue.detail).not.toContain('greg%40mindstone.com');
    expect(issue.detail).toContain('[email]');
    expect(issue.detail).toContain('returned 404');
  });

  it('scrubs both shapes from model-authored bridge strings', () => {
    const issue = makeSyncIssue({
      kind: 'bridge_reported',
      detail: 'Microsoft365Calendar-jane-acme-com: auth error for [external-email]',
    });

    expect(issue.detail).not.toContain('[external-email]');
    expect(issue.detail).not.toContain('Microsoft365Calendar-jane-acme-com');
  });

  it('caps detail length (scrub-don\'t-reject)', () => {
    const issue = makeSyncIssue({
      kind: 'bridge_reported',
      detail: 'x'.repeat(SYNC_ISSUE_DETAIL_MAX_LENGTH * 4),
    });

    expect(issue.detail?.length).toBeLessThanOrEqual(SYNC_ISSUE_DETAIL_MAX_LENGTH);
    // The capped output still parses against the persisted-shape schema.
    expect(SyncIssueSchema.safeParse(issue).success).toBe(true);
  });

  it('scrubs a full email passed as accountRef (defense-in-depth — writers pass the domain)', () => {
    const issue = makeSyncIssue({
      kind: 'auth_transient',
      provider: 'google',
      connector: 'GoogleWorkspace',
      accountRef: '[Mindstone-email]',
    });

    expect(issue.accountRef).not.toContain('[Mindstone-email]');
  });

  it('passes through fields with nothing to scrub unchanged', () => {
    expect(makeSyncIssue({ kind: 'validation_skipped', count: 3 }))
      .toEqual({ kind: 'validation_skipped', count: 3 });
    expect(makeSyncIssue({
      kind: 'auth_transient',
      provider: 'google',
      connector: 'GoogleWorkspace',
      accountRef: 'mindstone.com',
    }).accountRef).toBe('mindstone.com');
  });
});

describe('SyncIssueSchema', () => {
  it('rejects an out-of-closed-set connector (parse error by construction)', () => {
    const result = SyncIssueSchema.safeParse({
      kind: 'calendar_fetch_failed',
      provider: 'google',
      connector: 'GoogleWorkspace-teammember-mindstone-com', // slug, not base name
      detail: 'whatever',
    });
    expect(result.success).toBe(false);
  });

  it('rejects unknown kinds (fail-closed for the Stage-3 reader)', () => {
    expect(SyncIssueSchema.safeParse({ kind: 'mystery' }).success).toBe(false);
  });

  it('accepts every factory-constructed kind', () => {
    const issues = [
      makeSyncIssue({ kind: 'auth_transient' as const, provider: 'google' as const, connector: 'GoogleWorkspace' as const, accountRef: 'mindstone.com' }),
      makeSyncIssue({ kind: 'calendar_fetch_failed' as const, provider: 'microsoft' as const, connector: 'Microsoft365Calendar' as const, detail: 'Graph 500' }),
      makeSyncIssue({ kind: 'account_sync_failed' as const, provider: 'google' as const, connector: 'GoogleWorkspace' as const, detail: 'boom' }),
      makeSyncIssue({ kind: 'bridge_reported' as const, detail: 'No calendar sources connected' }),
      makeSyncIssue({ kind: 'validation_skipped' as const, count: 1 }),
    ];
    for (const issue of issues) {
      expect(SyncIssueSchema.safeParse(issue).success).toBe(true);
    }
  });

  it('accepts the additive optional cause field on fetch/sync-failure kinds', () => {
    expect(SyncIssueSchema.safeParse(
      makeSyncIssue({ kind: 'calendar_fetch_failed' as const, provider: 'google' as const, connector: 'GoogleWorkspace' as const, cause: 'network' as const }),
    ).success).toBe(true);
    expect(SyncIssueSchema.safeParse(
      makeSyncIssue({ kind: 'account_sync_failed' as const, provider: 'google' as const, connector: 'GoogleWorkspace' as const, cause: 'account' as const }),
    ).success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Stage 2 (260617_calendar-cache-transient-debounce): classifySyncErrorCause
// picks `network` (service unreachable, transient) vs `account` (connection
// problem the user may act on) so remediation copy can be honest. Defaults to
// `account` when unsure so a real problem is never softened into "a blip".
// ---------------------------------------------------------------------------

describe('classifySyncErrorCause', () => {
  it('classifies node network error codes as network', () => {
    for (const code of ['ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'ECONNREFUSED', 'ECONNRESET']) {
      expect(classifySyncErrorCause(Object.assign(new Error('boom'), { code }))).toBe('network');
    }
  });

  it('classifies undici "fetch failed" (with a nested network cause) as network', () => {
    const err = Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('getaddrinfo ENOTFOUND www.googleapis.com'), { code: 'ENOTFOUND' }),
    });
    expect(classifySyncErrorCause(err)).toBe('network');
  });

  it('classifies network-shaped messages as network even without a code', () => {
    expect(classifySyncErrorCause(new Error('socket hang up'))).toBe('network');
  });

  it('defaults to account for non-network errors (e.g. an API permission error)', () => {
    expect(classifySyncErrorCause(new Error('403 insufficient permissions for calendar'))).toBe('account');
    expect(classifySyncErrorCause('some string error')).toBe('account');
    expect(classifySyncErrorCause(undefined)).toBe('account');
  });

  it('does not loop on a self-referential cause chain', () => {
    const err = new Error('weird') as Error & { cause?: unknown };
    err.cause = err;
    expect(classifySyncErrorCause(err)).toBe('account');
  });
});
