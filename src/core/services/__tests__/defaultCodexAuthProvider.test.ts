/**
 * Tests for the DEFAULT_CODEX_AUTH_PROVIDER implementation. This is the
 * single provider wired on BOTH desktop and cloud (replacing the previous
 * null-on-cloud approach that disabled ChatGPT Pro outside desktop).
 */

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CODEX_AUTH_PROVIDER } from '../defaultCodexAuthProvider';
import {
  saveCodexTokens,
  clearCodexTokens,
  codexTokenEvents,
} from '../codexTokenStorage';

const TEST_CLEAR_CONTEXT = { cause: 'manual_logout', source: 'codex_auth_core' } as const;

describe('DEFAULT_CODEX_AUTH_PROVIDER', () => {
  beforeEach(() => {
    clearCodexTokens(TEST_CLEAR_CONTEXT);
  });

  afterEach(() => {
    clearCodexTokens(TEST_CLEAR_CONTEXT);
  });

  it('reports disconnected when no tokens stored', async () => {
    expect(DEFAULT_CODEX_AUTH_PROVIDER.isConnected()).toBe(false);
    expect(await DEFAULT_CODEX_AUTH_PROVIDER.getAccessToken()).toBeNull();
    expect(DEFAULT_CODEX_AUTH_PROVIDER.getAccountId()).toBeNull();
    expect(DEFAULT_CODEX_AUTH_PROVIDER.getStatus()).toEqual({ connected: false });
  });

  it('reports connected once tokens are saved via core storage', async () => {
    saveCodexTokens({
      accessToken: 'access-token-abc',
      refreshToken: 'refresh-token-xyz',
      expiresAt: Date.now() + 10 * 60_000,
      accountId: 'acct_1',
      accountEmail: 'user@example.com',
    });

    expect(DEFAULT_CODEX_AUTH_PROVIDER.isConnected()).toBe(true);
    expect(await DEFAULT_CODEX_AUTH_PROVIDER.getAccessToken()).toBe('access-token-abc');
    expect(DEFAULT_CODEX_AUTH_PROVIDER.getAccountId()).toBe('acct_1');
    expect(DEFAULT_CODEX_AUTH_PROVIDER.getStatus()).toEqual({
      connected: true,
      accountEmail: 'user@example.com',
    });
  });
});

describe('codexTokenEvents emits on save/clear', () => {
  beforeEach(() => {
    clearCodexTokens(TEST_CLEAR_CONTEXT);
    codexTokenEvents.removeAllListeners('changed');
  });

  afterEach(() => {
    codexTokenEvents.removeAllListeners('changed');
  });

  it('emits changed(tokens) after saveCodexTokens()', () => {
    const listener = vi.fn();
    codexTokenEvents.on('changed', listener);

    const tokens = {
      accessToken: 'a',
      refreshToken: 'r',
      expiresAt: Date.now() + 60_000,
      accountId: 'acct',
    };
    saveCodexTokens(tokens);

    expect(listener).toHaveBeenCalledWith(tokens);
  });

  it('emits changed(null) after clearCodexTokens()', () => {
    saveCodexTokens({
      accessToken: 'a',
      refreshToken: 'r',
      expiresAt: Date.now() + 60_000,
      accountId: 'acct',
    });

    const listener = vi.fn();
    codexTokenEvents.on('changed', listener);
    clearCodexTokens(TEST_CLEAR_CONTEXT);

    expect(listener).toHaveBeenCalledWith(null);
  });
});
