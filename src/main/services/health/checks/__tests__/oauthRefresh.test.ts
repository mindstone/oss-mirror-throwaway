import { describe, it, expect, vi, beforeEach } from 'vitest';

 
vi.mock('../../../oauthRefreshFailureStore', () => ({
  listNeedsReconnectProviders: vi.fn(),
}));

import { checkOauthRefreshHealth } from '../oauthRefresh';
import { listNeedsReconnectProviders } from '../../../oauthRefreshFailureStore';

const mockedListNeedsReconnect = vi.mocked(listNeedsReconnectProviders);

beforeEach(() => {
  mockedListNeedsReconnect.mockReset();
});

describe('checkOauthRefreshHealth', () => {
  it('returns skip when the accessor reports a read error', () => {
    mockedListNeedsReconnect.mockReturnValue({ ok: false, reason: 'read-error' });

    const result = checkOauthRefreshHealth();
    expect(result.status).toBe('skip');
    expect(result.id).toBe('oauthRefreshHealth');
    expect(result.message).toContain('Could not read');
    expect(result.details).toEqual({ reason: 'read-error' });
  });

  it('returns pass when no providers need reconnecting', () => {
    mockedListNeedsReconnect.mockReturnValue({ ok: true, providers: [] });

    const result = checkOauthRefreshHealth();
    expect(result.status).toBe('pass');
    expect(result.message).toContain('signed in');
    expect(result.details).toBeUndefined();
  });

  it('returns warn with a friendly single-provider message when one provider needs reconnecting', () => {
    mockedListNeedsReconnect.mockReturnValue({
      ok: true,
      providers: [{ providerBaseName: 'GoogleWorkspace' }],
    });

    const result = checkOauthRefreshHealth();
    expect(result.status).toBe('warn');
    expect(result.name).toBe('Google Workspace sign-in');
    expect(result.message).toBe('Google Workspace needs reconnecting');
    expect(result.remediation).toBe('Your sign-in expired. Reconnect it to get back in sync.');
    expect(result.details).toEqual({
      connectorServerNames: ['GoogleWorkspace'],
      providerCount: 1,
    });
  });

  it('returns warn with a multi-provider summary when several providers need reconnecting', () => {
    mockedListNeedsReconnect.mockReturnValue({
      ok: true,
      providers: [
        { providerBaseName: 'GoogleWorkspace' },
        { providerBaseName: 'Microsoft365Mail' },
      ],
    });

    const result = checkOauthRefreshHealth();
    expect(result.status).toBe('warn');
    expect(result.name).toBe('Sign-ins');
    expect(result.message).toBe(
      '2 accounts need reconnecting: Google Workspace, Microsoft 365 Mail',
    );
    expect(result.details).toEqual({
      connectorServerNames: ['GoogleWorkspace', 'Microsoft365Mail'],
      providerCount: 2,
    });
  });

  it('uses raw base name for entries outside the friendly display table', () => {
    mockedListNeedsReconnect.mockReturnValue({
      ok: true,
      providers: [{ providerBaseName: 'unknown' }],
    });

    const result = checkOauthRefreshHealth();
    expect(result.status).toBe('warn');
    expect(result.name).toBe('unknown sign-in');
    expect(result.details).toEqual({
      connectorServerNames: ['unknown'],
      providerCount: 1,
    });
  });

  it('never includes email-like substrings in the details payload', () => {
    mockedListNeedsReconnect.mockReturnValue({
      ok: true,
      providers: [
        { providerBaseName: 'GoogleWorkspace' },
        { providerBaseName: 'Microsoft365Mail' },
        { providerBaseName: 'unknown' },
      ],
    });

    const result = checkOauthRefreshHealth();
    const serialized = JSON.stringify(result.details);
    expect(serialized).not.toMatch(/@/);
    expect(serialized).not.toMatch(/mindstone-com/);
    expect(serialized).not.toMatch(/acme-com/);
  });
});
