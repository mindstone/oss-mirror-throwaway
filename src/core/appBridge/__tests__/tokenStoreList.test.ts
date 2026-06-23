/**
 * Tests for the Stage 6a TokenStore helpers:
 *   - `listAppTokens()` — snapshot of paired apps
 *   - `revokeAppTokensByClientId()` — targeted revoke
 *   - `revokeAllAppTokens()` — global revoke
 *
 * Covered here rather than in `tokenScope.test.ts` so the Stage 3 scope
 * suite stays focused on the security contract, not the settings-UI
 * accessors.
 *
 * @see docs/plans/260418_rebel_app_bridge_and_browser_extension.md (Stage 6a)
 */

import { describe, expect, it } from 'vitest';
import { TokenStore } from '@core/appBridge/server/tokenStore';

describe('TokenStore Stage 6a accessors', () => {
  it('listAppTokens returns an entry for each issued token with claims', () => {
    const store = new TokenStore();
    store.issueAppToken('browser-extension', 'client-a');
    store.issueAppToken('browser-extension', 'client-b');
    // A raw pairing token without claims should not appear in the list.
    store.issuePairingToken();
    const list = store.listAppTokens();
    expect(list).toHaveLength(2);
    expect(list.every((entry) => entry.hashedToken.length === 64)).toBe(true);
    const byClient = Object.fromEntries(list.map((e) => [e.clientId, e]));
    expect(byClient['client-a']?.appId).toBe('browser-extension');
    expect(byClient['client-b']?.appId).toBe('browser-extension');
    expect(byClient['client-a']?.issuedAt).toBeTypeOf('number');
  });

  it('revokeAppTokensByClientId drops only the matching clientId tokens', () => {
    const store = new TokenStore();
    store.issueAppToken('browser-extension', 'client-a');
    store.issueAppToken('browser-extension', 'client-a'); // two tokens, same clientId
    const tOther = store.issueAppToken('browser-extension', 'client-b');
    expect(store.getActiveTokenCount()).toBe(3);
    const revoked = store.revokeAppTokensByClientId('client-a');
    expect(revoked).toBe(2);
    expect(store.getActiveTokenCount()).toBe(1);
    // the unrelated token remains
    expect(store.classifyToken(tOther)).toBe('pair');
  });

  it('revokeAppTokensByClientId is idempotent and handles empty ids safely', () => {
    const store = new TokenStore();
    store.issueAppToken('browser-extension', 'client-a');
    expect(store.revokeAppTokensByClientId('does-not-exist')).toBe(0);
    expect(store.revokeAppTokensByClientId('')).toBe(0);
    expect(store.getActiveTokenCount()).toBe(1);
  });

  it('revokeAllAppTokens clears every token and leaves the router token intact', () => {
    const store = new TokenStore({ routerInternalToken: 'router-abc' });
    store.issueAppToken('browser-extension', 'client-a');
    store.issueAppToken('browser-extension', 'client-b');
    expect(store.revokeAllAppTokens()).toBe(2);
    expect(store.getActiveTokenCount()).toBe(0);
    // Router-internal token must still classify correctly after mass revoke.
    expect(store.classifyToken('router-abc')).toBe('router-internal');
  });
});
