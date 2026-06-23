import { describe, expect, it } from 'vitest';
import { PairingStore } from '@core/appBridge/server/pairingStore';
import { TokenStore } from '@core/appBridge/server/tokenStore';
import { ErrorCode, type AppBridgeError } from '@core/appBridge/shared/errors';

function makeStore(options: ConstructorParameters<typeof PairingStore>[0] = {}) {
  const tokenStore = new TokenStore();
  const store = new PairingStore({ tokenStore, ...options });
  return { tokenStore, store };
}

function isBridgeError(err: unknown): err is AppBridgeError {
  return (
    typeof err === 'object' &&
    err !== null &&
    typeof (err as AppBridgeError).code === 'string'
  );
}

describe('appBridge/server/pairingStore', () => {
  it('createPendingSession returns a 6-digit code with expiresAt ~10min ahead', () => {
    const now = () => 1_700_000_000_000;
    const { store } = makeStore({ now });
    const session = store.createPendingSession('browser-extension');

    expect(session.code).toMatch(/^\d{6}$/);
    expect(session.expiresAt).toBe(now() + 10 * 60_000);
  });

  it('default TTL is 10 minutes', () => {
    const { store } = makeStore();
    expect(store.getTtlMs()).toBe(10 * 60_000);
  });

  it('honors explicit ttlMs override', () => {
    const { store } = makeStore({ ttlMs: 5 * 60_000 });
    expect(store.getTtlMs()).toBe(5 * 60_000);
  });

  it('createPendingSession preserves pairSessionId when provided', () => {
    const { store } = makeStore();
    const session = store.createPendingSession('browser-extension', {
      pairSessionId: 'pair-session-a',
    });

    expect(session.pairSessionId).toBe('pair-session-a');
  });

  it('3-session cap is enforced', () => {
    const { store } = makeStore({ maxConcurrentSessions: 3 });
    store.createPendingSession('browser-extension');
    store.createPendingSession('browser-extension');
    store.createPendingSession('browser-extension');

    let thrown: unknown;
    try {
      store.createPendingSession('browser-extension');
    } catch (err) {
      thrown = err;
    }
    expect(isBridgeError(thrown)).toBe(true);
    expect((thrown as AppBridgeError).code).toBe(ErrorCode.RATE_LIMITED);
    expect((thrown as AppBridgeError).status).toBe(429);
  });

  it('claim with the right code consumes it and returns a token', () => {
    const { store, tokenStore } = makeStore();
    const { code } = store.createPendingSession('browser-extension');

    const result = store.claim(code, { clientId: 'client-a' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(typeof result.token).toBe('string');
      expect(result.token.length).toBeGreaterThan(0);
      expect(tokenStore.validatePairingToken(result.token)).toBe(true);
    }

    // Second claim with the same code should now fail (consumed).
    const reclaim = store.claim(code, { clientId: 'client-a' });
    expect(reclaim.ok).toBe(false);
    if (!reclaim.ok) {
      expect(reclaim.error).toBe(ErrorCode.PAIRING_EXPIRED);
    }
  });

  it('claim with a wrong code returns PAIRING_EXPIRED and charges the live record', () => {
    const { store } = makeStore();
    const { code } = store.createPendingSession('browser-extension');

    const wrong = store.claim('000000', { clientId: 'client-a' });
    expect(wrong.ok).toBe(false);
    if (!wrong.ok) {
      expect(wrong.error).toBe(ErrorCode.PAIRING_EXPIRED);
    }

    // The right code still works — only one wrong attempt charged so far.
    const right = store.claim(code, { clientId: 'client-a' });
    expect(right.ok).toBe(true);
  });

  it('10th wrong claim burns the code', () => {
    const { store } = makeStore({ maxAttemptsPerCode: 10 });
    const { code } = store.createPendingSession('browser-extension');

    // 9 wrong attempts — code should still be claimable.
    for (let i = 0; i < 9; i += 1) {
      const r = store.claim('111111', { clientId: 'c' });
      expect(r.ok).toBe(false);
    }
    // 10th wrong attempt burns the code.
    const tenth = store.claim('111111', { clientId: 'c' });
    expect(tenth.ok).toBe(false);

    // Now the correct code no longer works — PAIRING_EXPIRED.
    const right = store.claim(code, { clientId: 'c' });
    expect(right.ok).toBe(false);
    if (!right.ok) {
      expect(right.error).toBe(ErrorCode.PAIRING_EXPIRED);
    }
  });

  it('11th claim after burn returns PAIRING_EXPIRED', () => {
    const { store } = makeStore({ maxAttemptsPerCode: 10 });
    store.createPendingSession('browser-extension');

    for (let i = 0; i < 10; i += 1) {
      store.claim('111111', { clientId: 'c' });
    }

    // Code is burned; an 11th call returns PAIRING_EXPIRED as well.
    const eleventh = store.claim('111111', { clientId: 'c' });
    expect(eleventh.ok).toBe(false);
    if (!eleventh.ok) {
      expect(eleventh.error).toBe(ErrorCode.PAIRING_EXPIRED);
    }
  });

  it('expired code (past expiresAt) returns PAIRING_EXPIRED', () => {
    let t = 1_000_000;
    const { store } = makeStore({ ttlMs: 1_000, now: () => t });
    const { code } = store.createPendingSession('browser-extension');

    // Advance past expiresAt.
    t += 2_000;

    const result = store.claim(code, { clientId: 'c' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe(ErrorCode.PAIRING_EXPIRED);
    }
  });

  it('revokePairing removes the underlying token', () => {
    const { store, tokenStore } = makeStore();
    const { code } = store.createPendingSession('browser-extension');
    const claim = store.claim(code, { clientId: 'c' });
    expect(claim.ok).toBe(true);

    if (claim.ok) {
      expect(tokenStore.validatePairingToken(claim.token)).toBe(true);
      store.revoke(claim.token);
      expect(tokenStore.validatePairingToken(claim.token)).toBe(false);
    }
  });

  it('listActive returns a snapshot of current pending sessions', () => {
    const { store } = makeStore();
    const s1 = store.createPendingSession('browser-extension');
    const s2 = store.createPendingSession('browser-extension');

    const active = store.listActive();
    expect(active.length).toBe(2);
    expect(active.map((s) => s.code).sort()).toEqual([s1.code, s2.code].sort());
  });

  it('empty-string code yields BAD_REQUEST', () => {
    const { store } = makeStore();
    const result = store.claim('', { clientId: 'c' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe(ErrorCode.BAD_REQUEST);
    }
  });

  it('stores the configured TTL and attempt caps for introspection', () => {
    const { store } = makeStore({
      ttlMs: 99_999,
      maxAttemptsPerCode: 5,
      maxConcurrentSessions: 2,
    });
    expect(store.getTtlMs()).toBe(99_999);
    expect(store.getMaxAttemptsPerCode()).toBe(5);
    expect(store.getMaxConcurrentSessions()).toBe(2);
  });

  // --- B4 fingerprint binding --------------------------------------------

  it('claim persists fingerprint into the token claims (B4)', () => {
    const { store, tokenStore } = makeStore();
    const { code } = store.createPendingSession('browser-extension', {
      pairSessionId: 'pair-session-a',
    });
    const result = store.claim(code, {
      clientId: 'client-a',
      fingerprint: 'fp-xyz',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const tokens = tokenStore.listAppTokens();
    expect(tokens).toHaveLength(1);
    expect(tokens[0]?.fingerprint).toBe('fp-xyz');
    expect(tokens[0]?.pairSessionId).toBe('pair-session-a');
  });

  it('claim with no fingerprint stores null (legacy compat path) (B4)', () => {
    const { store, tokenStore } = makeStore();
    const { code } = store.createPendingSession('browser-extension');
    const result = store.claim(code, { clientId: 'client-a' });
    expect(result.ok).toBe(true);
    const tokens = tokenStore.listAppTokens();
    expect(tokens[0]?.fingerprint).toBeNull();
  });

  it('claim with empty-string fingerprint normalises to null (B4)', () => {
    const { store, tokenStore } = makeStore();
    const { code } = store.createPendingSession('browser-extension');
    const result = store.claim(code, {
      clientId: 'client-a',
      fingerprint: '',
    });
    expect(result.ok).toBe(true);
    const tokens = tokenStore.listAppTokens();
    expect(tokens[0]?.fingerprint).toBeNull();
  });
});
