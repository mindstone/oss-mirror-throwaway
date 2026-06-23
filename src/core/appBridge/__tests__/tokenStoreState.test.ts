import { describe, expect, it } from 'vitest';
import { TokenStore } from '@core/appBridge/server/tokenStore';

describe('TokenStore stateful install helpers', () => {
  it('revokeAppTokensByAppId only removes matching app ids', () => {
    const store = new TokenStore();
    const officeToken = store.issueAppToken('office-addin', 'office-client');
    store.issueAppToken('browser-extension', 'browser-client-a');
    store.issueAppToken('browser-extension', 'browser-client-b');

    expect(store.revokeAppTokensByAppId('browser-extension')).toBe(2);
    expect(
      store.verifyAppToken(officeToken, {
        appId: 'office-addin',
        clientId: 'office-client',
      }),
    ).not.toBeNull();
  });

  it('caps the install-session denylist at the 100 most recent entries', () => {
    const store = new TokenStore();

    for (let index = 0; index < 101; index += 1) {
      store.restoreRevokedInstallSession({
        installSessionId: `install-session-${index}`,
        revokedAt: index,
      });
    }

    const entries = store.listRevokedInstallSessions();
    expect(entries).toHaveLength(100);
    expect(store.isInstallSessionRevoked('install-session-0')).toBe(false);
    expect(store.isInstallSessionRevoked('install-session-1')).toBe(true);
    expect(entries[0]?.installSessionId).toBe('install-session-1');
  });

  it('enforces bidirectional clientId ↔ extensionId bindings', () => {
    const store = new TokenStore();

    expect(store.upsertClientExtensionBinding('browser-client-a', 'extension-a')).toEqual({
      ok: true,
      kind: 'new',
    });
    expect(store.upsertClientExtensionBinding('browser-client-a', 'extension-a')).toEqual({
      ok: true,
      kind: 'unchanged',
    });
    expect(store.upsertClientExtensionBinding('browser-client-a', 'extension-b')).toEqual({
      ok: false,
      reason: 'forward-conflict',
      existingExtensionId: 'extension-a',
    });
    expect(store.upsertClientExtensionBinding('browser-client-b', 'extension-a')).toEqual({
      ok: false,
      reason: 'reverse-conflict',
      existingClientId: 'browser-client-a',
    });
    expect(store.lookupExtensionByClientId('browser-client-a')).toBe('extension-a');
    expect(store.lookupClientByExtensionId('extension-a')).toBe('browser-client-a');
  });

  it('removes bindings idempotently', () => {
    const store = new TokenStore();
    store.upsertClientExtensionBinding('browser-client-a', 'extension-a');

    expect(store.removeClientExtensionBinding('browser-client-a')).toMatchObject({
      clientId: 'browser-client-a',
      extensionId: 'extension-a',
    });
    expect(store.removeClientExtensionBinding('browser-client-a')).toBeNull();
    expect(store.lookupExtensionByClientId('browser-client-a')).toBeNull();
    expect(store.lookupClientByExtensionId('extension-a')).toBeNull();
  });
});
